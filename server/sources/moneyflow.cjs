// 资金流四接口的多源回退 + 旧数据降级(2026-09-29 东财 push2* 整族对本站出口 IP 不可达)
//
// 背景: push2 / push2delay / 82.push2 / push2his(含 1~90 各数字子域)全族 TLS 断连
// (curl 56 SSL_read unexpected eof), /api/board-flow · /api/board-moneyflow · /api/stock-flow
// · /api/stock-boards 四端点原先只挂东财, 上游一断即 502。本模块在**保留东财主源**的前提下
// 加替代源链, 并统一实现"所有源都失败 → 返回上次成功数据 + stale/asof 标记; 无历史才如实报错"。
//
// 源链(每步只接受真实上游返回的非空结果, 拿不到就继续下一源, 绝不编造):
//   board-flow      : 东财 clist+fflow(含分钟曲线) → 新浪"新浪行业"板块表 → 腾讯申万一级 → 新浪概念板块
//   board-moneyflow : 东财 clist(fs=b:BK####) → 新浪板块成分(bankuai=) → 成分股清单+全市场净流入映射(部分覆盖)
//   stock-flow(s)   : 东财 ulist(批量) → 新浪全市场净流入榜(盘中口径) → 新浪个股资金流趋势(日频, 带 date)
//   stock-boards    : 东财 push2 stock/get(f127/f128/f129) → 东财 datacenter-web F10 核心题材(行业/地域/概念)
//
// 口径实测(2026-09-29 03:48 站上验证):
//   · 腾讯板块榜 zljlr=主力净流入(万元) → ×1e4 = 元; zdf=涨跌幅%; 板块码 pt########
//   · 新浪 ssl_bkzj_bk 板块表 netamount=元, avg_changeratio=小数; category=(新)新浪行业 new_* / 概念 gn_*
//     (ssl_bkzj_bk 的行业类 fenlei=2 实测与自身成分股口径不符 → 只用 fenlei=0/1)
//   · 新浪 ssl_bkzj_ssggzj 个股榜 netamount=元, ratioamount=小数(×100=%), turnover/r0_net 同表;
//     bankuai=<新浪板块码> 可过滤板块成分(实测: 板块表净额 == 成分股净额求和, 逐分一致)
//   · 新浪 Market_Center.getHQNodeData?node=<板块码> 给板块成分股报价清单(无净额)
//   · 东财 datacenter-web F10 RPT_F10_CORETHEME_BOARDTYPE 可达: BOARD_TYPE=行业/板块(地域) 可还原 f127/f128/f129
"use strict";

// 东财单次尝试上限: 上游未必快失败(挂起时)也不能让用户等满超时, 超时即切替代源
const EM_TIMEOUT = 4500;
// 新浪全市场净流入榜复用窗口(2 次上游 → 进程内共享, 供 board-moneyflow 与 stock-flow 补净额)
const FLOW_MAP_TTL = 45000;
const FLOW_MAP_NUM = 500; // 单方向条数(实测 num 上限 ≥1000, 500 已覆盖两市净流入/流出两端各 ~10%)
// 逐只日频回退的每轮上限(防上游放大)
const DAY_FLOW_MAX = 20;

const withTimeout = (p, ms) =>
  Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => {
      const t = setTimeout(() => rej(new Error(`source timeout ${ms}ms`)), ms);
      if (t.unref) t.unref();
    }),
  ]);

const brief = (e) => String(e?.message || e).slice(0, 140);

module.exports = function createMoneyFlow(ctx) {
  const { fetchWithFallback, fetchSinaJson, num, toMarketCode6, qqRank, cache, cacheSet, entry, TTLS, lastGood, em } = ctx;

  const SINA_MF = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/";
  const EM_REFERER = "https://quote.eastmoney.com/";
  const QQ_PT_URL = (type, want) =>
    `https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=${type}&sort_type=price&direct=down&offset=0&count=${want}`;

  /* ============================== 新浪源 ============================== */

  /** 新浪个股资金流榜(全市场, 按主力净额排序): asc=0 净流入榜 / asc=1 净流出榜 */
  async function sinaStockRank(asc, want) {
    const arr = await fetchSinaJson(`${SINA_MF}MoneyFlow.ssl_bkzj_ssggzj?page=1&num=${want}&sort=netamount&asc=${asc}`);
    return Array.isArray(arr) ? arr : [];
  }

  /** 新浪个股榜行 → 前端 FlowStock/StockFlow 口径(与 eastmoney.cjs handleMoneyFlow 同映射) */
  const sinaFlowRow = (s) => ({
    symbol: s.symbol,
    name: s.name,
    price: num(s.trade),
    pct: +(num(s.changeratio) * 100).toFixed(2),
    amount: num(s.amount),
    netIn: num(s.netamount), // 元
    netRatio: +(num(s.ratioamount) * 100).toFixed(2), // %
    r0Net: num(s.r0_net), // 超大单净流入(元)
    turnover: num(s.turnover),
  });

  /** 全市场净流入映射 symbol → 行(净流入/净流出各取一份); 供"有成分清单、缺净额"的场景补数 */
  async function sinaFlowMap() {
    const key = "mfmap";
    const hit = cache.get(key);
    if (hit && hit.data instanceof Map && Date.now() - hit.ts < FLOW_MAP_TTL) return hit.data;
    const [up, down] = await Promise.all([sinaStockRank(0, FLOW_MAP_NUM), sinaStockRank(1, FLOW_MAP_NUM)]);
    const map = new Map();
    for (const s of [...up, ...down]) {
      if (!s?.symbol || map.has(s.symbol)) continue;
      map.set(s.symbol, sinaFlowRow(s));
    }
    if (!map.size) throw new Error("empty sina flow map");
    cacheSet(key, entry(map, FLOW_MAP_TTL));
    return map;
  }

  /** 新浪板块资金表(板块码+名称+主力净额, 元): fenlei 0=(新)新浪行业 / 1=概念 */
  async function sinaBoardList(fenlei, asc, want) {
    const arr = await fetchSinaJson(`${SINA_MF}MoneyFlow.ssl_bkzj_bk?page=1&num=${want}&sort=netamount&asc=${asc}&fenlei=${fenlei}`);
    if (!Array.isArray(arr)) return [];
    return arr.filter((b) => b?.category).map((b) => ({ code: b.category, name: b.name, netIn: num(b.netamount), points: [] }));
  }

  /** 新浪板块成分股净流入排行(bankuai=<板块码>): 完整榜单, 同板块表口径 */
  async function sinaBoardMembersFlow(category, want) {
    const arr = await fetchSinaJson(`${SINA_MF}MoneyFlow.ssl_bkzj_ssggzj?page=1&num=${want}&sort=netamount&asc=0&bankuai=${encodeURIComponent(category)}`);
    if (!Array.isArray(arr)) return [];
    return arr.filter((s) => s?.symbol && s?.name).map(sinaFlowRow);
  }

  /** 新浪板块成分股清单(报价口径, 无净额): 净额由 sinaFlowMap 补 */
  async function sinaNodeMembers(category, want = 100) {
    const arr = await fetchSinaJson(`${SINA_MF}Market_Center.getHQNodeData?page=1&num=${want}&sort=amount&asc=0&node=${encodeURIComponent(category)}`);
    if (!Array.isArray(arr)) return [];
    return arr.filter((s) => s?.symbol).map((s) => ({ symbol: s.symbol, name: s.name || "" }));
  }

  /** 新浪个股资金流趋势(日频, 最新一根=最近已收盘交易日) → StockFlow + date 标明口径 */
  async function sinaStockDayFlow(code) {
    const arr = await fetchSinaJson(`${SINA_MF}MoneyFlow.ssl_qsfx_zjlrqs?daima=${encodeURIComponent(code)}&num=1`);
    const s = Array.isArray(arr) ? arr[0] : null;
    if (!s?.opendate) return null;
    return {
      code,
      netIn: num(s.netamount),
      netRatio: +(num(s.ratioamount) * 100).toFixed(2),
      r0Net: num(s.r0_net),
      date: s.opendate,
      close: num(s.trade),
      pct: +(num(s.changeratio) * 100).toFixed(2),
      source: "sina-day",
    };
  }

  /* ============================== 腾讯源 ============================== */

  /** 腾讯板块榜(hy=申万一级行业 / gn=概念): 含主力净流入 zljlr(万元) */
  async function qqBoardList(type, want = 100) {
    const txt = await fetchWithFallback(QQ_PT_URL(type, want), { timeout: 8000 });
    const list = JSON.parse(txt)?.data?.rank_list;
    if (!Array.isArray(list)) return [];
    return list
      .filter((b) => b?.code)
      .map((b) => ({ code: b.code, name: b.name, netIn: num(b.zljlr) * 1e4, points: [] })); // 万元 → 元
  }

  /** 腾讯板块成分股清单(无净额字段): board_code 支持板块指数码 pt######## */
  async function qqBoardMembers(code, want = 100) {
    const list = await qqRank.getBoardRankList({ boardCode: code, sortType: "turnover", direct: "down", offset: 0, count: want });
    return (Array.isArray(list) ? list : []).filter((s) => s?.code).map((s) => ({ symbol: s.code, name: s.name || "" }));
  }

  /* ================= 东财可达通道(datacenter-web, push2* 之外) ================= */

  const f10Url = (filter, columns = "ALL", pageSize = 100) =>
    `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_CORETHEME_BOARDTYPE`
    + `&columns=${columns}&filter=${encodeURIComponent(filter)}&pageNumber=1&pageSize=${pageSize}&source=HSF10&client=PC`;

  /** F10 核心题材板块(个股维度): push2 f127/f128/f129 的替代, 可还原行业/地域/概念三分 */
  async function emF10Boards(code6) {
    const rows = JSON.parse(await fetchWithFallback(f10Url(`(SECUCODE="${code6}")`), { referer: EM_REFERER }))?.result?.data;
    return Array.isArray(rows) ? rows : [];
  }

  /** F10 板块成分股(板块维度, 按 NEW_BOARD_CODE 过滤): 任意 BK#### 可用 */
  async function emF10Members(bkCode, want = 100) {
    const rows = JSON.parse(await fetchWithFallback(f10Url(`(NEW_BOARD_CODE="${bkCode}")`, "ALL", 200), { referer: EM_REFERER }))?.result?.data;
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r) => r?.SECURITY_CODE)
      .slice(0, want)
      .map((r) => ({ symbol: toMarketCode6(String(r.SECURITY_CODE).padStart(6, "0")), name: r.SECURITY_NAME_ABBR || "" }));
  }

  /* ============================== 降级/落地 ============================== */

  /** 成功结果: 落上次成功快照(供上游全挂时降级), 返回带来源与时间戳的载荷 */
  function fresh(data, source, key, extra = {}) {
    lastGood.write(key, data);
    return { data, stale: false, asof: Date.now(), source, ...extra };
  }

  /** 全源失败: 有历史成功数据 → 旧值 + stale(短 TTL 让缓存尽快重试上游); 无 → 如实抛错(路由层 502) */
  function degrade(key, tried) {
    const lg = lastGood.read(key);
    if (lg) return { data: lg.data, stale: true, asof: lg.at, source: "last-good", __ttl: 15000 };
    throw new Error(`no upstream data available (${tried.join("; ") || "all sources failed"})`);
  }

  const isSinaBoardCode = (c) => /^(new_|gn_|hangye_|hs300$|zhishu_|diyu_)/i.test(c);
  const isKnownBoardCode = (c) => /^BK\d{4}$/i.test(c) || /^pt\d+/i.test(c) || isSinaBoardCode(c);

  /* ============================== /api/board-flow ============================== */

  /** 板块资金流向图: 流入/流出各取前 n/2(与东财原语义一致); 替代源无分钟曲线 → points: [] */
  async function boardFlow(nRaw) {
    const n = parseInt(nRaw, 10) || 20;
    const half = Math.max(3, Math.min(15, Math.floor(n / 2)));
    const key = `board-flow:${n}`;
    const tried = [];

    // ① 东财: 唯一含分钟级累计主力净流入曲线(points)的源
    try {
      const rows = await withTimeout(em.handleBoardFlow(String(n)), EM_TIMEOUT);
      if (rows?.length) return fresh(rows, "eastmoney", key);
      tried.push("eastmoney(empty)");
    } catch (e) { tried.push(`eastmoney(${brief(e)})`); }

    // ② 新浪"(新)新浪行业"板块表(fenlei=0): 与自身成分股净额逐分一致, 且板块码可直接取成分股榜
    try {
      const rows = await sinaBoardFlow(0, half);
      if (rows.length) return fresh(rows, "sina-hy", key);
      tried.push("sina-hy(empty)");
    } catch (e) { tried.push(`sina-hy(${brief(e)})`); }

    // ③ 腾讯申万一级行业榜(hy): 主力净流入口径(zljlr), 板块码 pt########
    try {
      const rows = await qqBoardFlow(half);
      if (rows.length) return fresh(rows, "tencent-hy", key);
      tried.push("tencent-hy(empty)");
    } catch (e) { tried.push(`tencent-hy(${brief(e)})`); }

    // ④ 新浪概念板块表(fenlei=1)
    try {
      const rows = await sinaBoardFlow(1, half);
      if (rows.length) return fresh(rows, "sina-gn", key);
      tried.push("sina-gn(empty)");
    } catch (e) { tried.push(`sina-gn(${brief(e)})`); }

    return degrade(key, tried);
  }

  /** 新浪板块表: 净流入前 half + 净流出前 half(去重) */
  async function sinaBoardFlow(fenlei, half) {
    const want = Math.max(half * 2, 20);
    const [ups, downs] = await Promise.all([sinaBoardList(fenlei, 0, want), sinaBoardList(fenlei, 1, want)]);
    const top = ups.slice(0, half);
    return [...top, ...downs.slice(0, half).filter((d) => !top.some((u) => u.code === d.code))];
  }

  /** 腾讯板块榜: 取全表(申万一级 31 个)本地按主力净流入排序, 取流入/流出各 half */
  async function qqBoardFlow(half) {
    const all = await qqBoardList("hy", 100);
    if (!all.length) return [];
    const sorted = [...all].sort((a, b) => b.netIn - a.netIn);
    const top = sorted.slice(0, half);
    const bottom = sorted.slice(-half).reverse();
    return [...top, ...bottom.filter((d) => !top.some((u) => u.code === d.code))];
  }

  /* ============================== /api/board-moneyflow ============================== */

  /** 板块成分股主力净流入排行: 东财 fs=b: 优先; 否则新浪 bankuai= 完整榜; 再否则成分清单+全市场净额映射 */
  async function boardMoneyFlow(codeRaw, nRaw) {
    const code = String(codeRaw || "").trim();
    const cnt = Math.min(Math.max(parseInt(nRaw, 10) || 15, 1), 100);
    const key = `board-moneyflow:${code}`;
    const tried = [];
    if (!isKnownBoardCode(code)) return { data: [], stale: false, asof: Date.now(), source: "none" }; // 未知板块码: 维持既有 200 + []

    // ① 东财 push2 clist(主力源, 上游恢复即自动回到东财口径)
    if (/^BK\d{4}$/i.test(code)) {
      try {
        const rows = await withTimeout(em.handleBoardMoneyFlow(code, cnt), EM_TIMEOUT);
        if (rows?.length) return fresh(rows, "eastmoney", key);
        tried.push("eastmoney(empty)");
      } catch (e) { tried.push(`eastmoney(${brief(e)})`); }
    }

    // ② 新浪板块成分完整榜(bankuai=; 指数类/概念类/新浪行业码可用, 行业细分码实测不支持)
    if (isSinaBoardCode(code) && !/^hangye_/i.test(code)) {
      try {
        const rows = await sinaBoardMembersFlow(code, cnt);
        if (rows.length) return fresh(rows, "sina-bankuai", key);
        tried.push("sina-bankuai(empty)");
      } catch (e) { tried.push(`sina-bankuai(${brief(e)})`); }
    }

    // ③ 成分股清单(腾讯 pt / 新浪 node / 东财 F10 BK) × 全市场净流入映射 → 净额排行(部分覆盖, partial 标记)
    try {
      const members = await boardMembers(code);
      if (members?.list?.length) {
        const map = await sinaFlowMap();
        const rows = members.list
          .map((m) => { const hit = map.get(m.symbol); return hit ? { ...hit, code: m.symbol.replace(/^(sh|sz|bj|nq)/, ""), symbol: m.symbol } : null; })
          .filter(Boolean)
          .sort((a, b) => b.netIn - a.netIn)
          .slice(0, cnt);
        if (rows.length) return fresh(rows, `sina-map+${members.src}`, key, { partial: rows.length < members.list.length });
        tried.push(`sina-map(${members.src} 无净额交集)`);
      } else tried.push(`members(${members?.src || "none"})`);
    } catch (e) { tried.push(`sina-map(${brief(e)})`); }

    return degrade(key, tried);
  }

  /** 板块成分股清单(按板块码形态选源): 只给代码+名称, 净额另补 */
  async function boardMembers(code) {
    if (/^pt\d+/i.test(code)) return { list: await qqBoardMembers(code), src: "tencent-members" };
    if (isSinaBoardCode(code)) return { list: await sinaNodeMembers(code), src: "sina-node" };
    if (/^BK\d{4}$/i.test(code)) return { list: await emF10Members(code.toUpperCase()), src: "em-f10-members" };
    return null;
  }

  /* ============================== /api/stock-flow(s) ============================== */

  /** 批量个股主力净流入: 东财 ulist 优先 → 新浪全市场榜(盘中口径) → 新浪个股日频趋势 → 逐只旧数据降级 */
  async function stockFlows(codesParam, flowInflight) {
    const list = String(codesParam || "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^(sh|sz|bj|nq)\d{6}$/.test(s))
      .slice(0, 150);
    if (!list.length) return { data: [], stale: false, asof: Date.now(), source: null };

    const out = new Map();
    const tried = [];

    // ① 东财 ulist(批量, 内部已带 sf:<code> 30s 缓存与列表级 inflight 合并)
    try {
      for (const r of await em.handleStockFlows(list.join(","), flowInflight)) out.set(r.code, r);
    } catch (e) { tried.push(`eastmoney(${brief(e)})`); }

    // ② 单只 30s 缓存命中(可能来自上一轮新浪回退写入), 命中即不再打上游
    const cachedRow = (c) => {
      const h = cache.get(`sf:${c}`);
      return h && h.data !== undefined && Date.now() - h.ts < TTLS.STOCK_FLOW ? h.data : null;
    };
    for (const c of list) {
      if (out.has(c)) continue;
      const r = cachedRow(c);
      if (r) out.set(c, r);
    }

    // ③ 新浪全市场净流入榜(盘中口径, 进程内 45s 复用)
    let missing = list.filter((c) => !out.has(c));
    if (missing.length) {
      try {
        const map = await sinaFlowMap();
        for (const c of missing) {
          const hit = map.get(c);
          if (!hit) continue;
          const rec = { code: c, netIn: hit.netIn, netRatio: hit.netRatio, r0Net: hit.r0Net, price: hit.price, pct: hit.pct, source: "sina-rank" };
          remember(c, rec);
          out.set(c, rec);
        }
      } catch (e) { tried.push(`sina-rank(${brief(e)})`); }
      missing = list.filter((c) => !out.has(c));
    }

    // ④ 新浪个股资金流趋势(日频; 带 date 标明口径) — 逐只取, 每轮上限 DAY_FLOW_MAX
    for (const c of missing.slice(0, DAY_FLOW_MAX)) {
      try {
        const rec = await sinaStockDayFlow(c);
        if (rec) { remember(c, rec); out.set(c, rec); }
      } catch (e) { tried.push(`sina-day:${c}(${brief(e)})`); }
    }

    // ⑤ 逐只上次成功数据降级(带 stale/asof, 前端可标明为旧值)
    for (const c of list) {
      if (out.has(c)) continue;
      const lg = lastGood.read(`stockflow:${c}`);
      if (lg) out.set(c, { ...lg.data, stale: true, asof: lg.at });
    }

    // 取到真实值即落快照(供下次全部上游挂掉时降级)
    for (const [c, r] of out) {
      if (r && r.netIn !== undefined && !r.stale) lastGood.write(`stockflow:${c}`, r);
    }

    const rows = list.map((c) => out.get(c)).filter(Boolean);
    const stale = rows.some((r) => r.stale);
    const srcs = [...new Set(rows.map((r) => r.source || (r.date ? "sina-day" : "eastmoney")))];
    return { data: rows, stale, asof: stale ? Math.min(...rows.filter((r) => r.asof).map((r) => r.asof)) : Date.now(), source: srcs.join("+") || null, tried };
  }

  /** 单只个股资金流(/api/stock-flow): 与批量同源, 取不到且无历史时如实抛错(维持改造前 502 契约) */
  async function stockFlow(codeRaw, flowInflight) {
    const code = String(codeRaw || "").toLowerCase().trim();
    const r = await stockFlows(code, flowInflight);
    const row = r.data[0];
    if (!row) throw new Error("empty stock-flow");
    return { data: row, stale: !!row.stale, asof: row.asof ?? r.asof, source: row.source || r.source };
  }

  /** 回写 30s 单只缓存(与 eastmoney.cjs handleStockFlows 共用 sf:<code> 键与 TTL) */
  function remember(code, rec) {
    cacheSet(`sf:${code}`, entry(rec, TTLS.STOCK_FLOW));
  }

  /* ============================== /api/stock-boards ============================== */

  /** 个股所属板块: 东财 push2(f127/f128/f129) → 东财 datacenter-web F10 核心题材(可达通道) */
  async function stockBoards(codeRaw) {
    const m = String(codeRaw || "").toLowerCase().match(/^(sh|sz|bj|nq)(\d{6})$/);
    if (!m) throw Object.assign(new Error(`bad code: ${codeRaw}`), { status: 400 }); // 与东财源一致
    const code = `${m[1]}${m[2]}`;
    const key = `stock-boards:${code}`;
    const tried = [];

    try {
      const d = await withTimeout(em.handleStockBoards(code), EM_TIMEOUT);
      if (d && (d.industry || d.concepts?.length)) return fresh(d, "eastmoney", key);
      tried.push("eastmoney(empty)");
    } catch (e) { tried.push(`eastmoney(${brief(e)})`); }

    // 东财 F10 核心题材(datacenter-web 可达): BOARD_TYPE=行业 → industry; =板块(地域) → area; 其余 → concepts
    try {
      const rows = await emF10Boards(`${m[2]}.${m[1].toUpperCase()}`);
      if (rows.length) {
        const sorted = [...rows].sort((a, b) => (a.BOARD_RANK || 0) - (b.BOARD_RANK || 0));
        const ind = sorted.find((r) => r.BOARD_TYPE === "行业" && String(r.BOARD_LEVEL || "1") === "1")
          || sorted.find((r) => r.BOARD_TYPE === "行业");
        const areaRow = sorted.find((r) => r.BOARD_TYPE === "板块" && /板块$/.test(r.BOARD_NAME || ""));
        const concepts = sorted
          .filter((r) => r !== ind && r !== areaRow)
          .map((r) => r.BOARD_NAME)
          .filter(Boolean);
        return fresh({
          code,
          industry: ind?.BOARD_NAME || "",
          area: areaRow ? String(areaRow.BOARD_NAME).replace(/板块$/, "") : "",
          concepts,
        }, "eastmoney-f10", key);
      }
      tried.push("eastmoney-f10(empty)");
    } catch (e) { tried.push(`eastmoney-f10(${brief(e)})`); }

    return degrade(key, tried);
  }

  // _ 前缀: 供 node 层测试直接驱动各替代源(生产路由只用上面 5 个入口)
  return {
    boardFlow, boardMoneyFlow, stockFlow, stockFlows, stockBoards,
    _sources: { sinaStockRank, sinaFlowMap, sinaBoardList, sinaBoardMembersFlow, sinaNodeMembers, sinaStockDayFlow, qqBoardList, qqBoardMembers, emF10Boards, emF10Members },
  };
};
