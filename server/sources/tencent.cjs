// 腾讯行情源 — 报价/分钟线/板块榜/板块成分股
"use strict";

const { quoteUrl, tencentMinuteUrl, usMinuteUrl, tencentRankUrl } = require("../lib/tencent-urls.cjs");

module.exports = function createTencent(ctx) {
  const { fetchText, fetchTextAny, curlText, cache, cacheSet, parseCsvParam, chunked, safeRecord, num, changeOf, pctOf } = ctx;
  const { entry, failEntry, quoteBackoff, TTLS, qqRank } = ctx;

  /* ---------------- 腾讯行情 qt.gtimg.cn ---------------- */
  function parseTencentLine(line) {
    const m = line.match(/v_([a-zA-Z0-9_]+)="([^"]*)"/);
    if (!m) return null;
    const symbol = m[1];
    const f = m[2].split("~");
    if (f.length < 40) {
      // 外汇 wh 系列
      if (symbol.startsWith("wh") && f.length > 13) {
        return {
          symbol,
          name: f[1],
          price: num(f[3]),
          change: num(f[12]),
          pct: num(f[13]),
          open: num(f[6]),
          high: num(f[8]),
          low: num(f[9]),
          prev: num(f[3]) - num(f[12]),
          time: f[5],
        };
      }
      return null;
    }
    return {
      symbol,
      name: f[1],
      price: num(f[3]),
      prev: num(f[4]),
      open: num(f[5]),
      vol: num(f[6]),
      time: f[30],
      change: num(f[31]),
      pct: num(f[32]),
      high: num(f[33]),
      low: num(f[34]),
      amount: num(f[37]), // 万元(A股) / 其他市场口径各异
      turnover: num(f[38]),
      pe: num(f[39]),
      amplitude: num(f[43]),
    };
  }

  // 报价缓存 TTL(与前端报价中心轮询周期 5s 对齐, 见 lib/cache.cjs TTLS.QUOTE)与
  // 报价退避(5s → 15s → 45s → 2min, 负缓存)均由 lib/cache.cjs 统一提供, 经 ctx 注入

  // 块级上游 inflight 去重(缓存过期瞬间的并发 miss 共享同一次上游拉取)
  const chunkInflight = new Map();
  let vixInflight = null; // usVIX 新浪拉取的 inflight 去重

  async function handleQuotes(codes) {
    // 按代码独立缓存(报价中心请求集随面板订阅动态变化, 整串做 key 会每次 miss 直冲上游)
    const now = Date.now();
    const out = safeRecord(); // 无原型对象: 上游 symbol 作为 key, 杜绝 __proto__ 污染
    const missing = [];
    for (const c of parseCsvParam(codes)) {
      const hit = cache.get(`q:${c}`);
      if (hit && hit.data !== undefined && now - hit.ts < TTLS.QUOTE) {
        out[c] = hit.data;
      } else if (hit && hit.data !== undefined && hit.failAt != null && now - hit.failAt < quoteBackoff(hit.failCount)) {
        out[c] = hit.data; // 失败退避窗口内降级返回旧数据, 不再打上游
      } else if (hit && hit.failAt != null && now - hit.failAt < quoteBackoff(hit.failCount)) {
        // 退避窗口内且无旧数据: 直接跳过, 不再打上游(负缓存)
      } else {
        missing.push(c);
      }
    }
    if (missing.length) {
      // 按 60 个/块分块并发(报价中心全集可达数百, 单 URL 过长会被上游拒绝)
      const chunks = chunked(missing, 60);
      // 块级 inflight 去重: 缓存过期瞬间的并发 miss 共享同一次上游拉取。
      // 否则多用户同频轮询时, 每个过期窗口会爆发几十次重复请求(单用户场景不暴露)
      await Promise.all(
        chunks.map(async (chunk) => {
          const ckey = `qc:${chunk.join(",")}`;
          const shared = chunkInflight.get(ckey);
          if (shared) {
            const rs = await shared;
            for (const [code, q] of Object.entries(rs)) out[code] = q; // 等待者把结果并入自己的 out
            return;
          }
          const p = (async () => {
            const rs = safeRecord(); // 无原型对象, 防 __proto__ 污染
            try {
              const text = await fetchText(quoteUrl(encodeURIComponent(chunk.join(","))), { gbk: true });
              for (const line of text.split(";")) {
                const q = parseTencentLine(line.trim());
                if (q) {
                  rs[q.symbol] = q;
                  if (q.symbol !== "usVIX") cacheSet(`q:${q.symbol}`, entry(q, TTLS.QUOTE)); // usVIX 由新浪覆盖值接管
                }
              }
            } catch {
              for (const c of chunk) {
                const hit = cache.get(`q:${c}`);
                cacheSet(`q:${c}`, failEntry(hit, TTLS.QUOTE));
              }
            }
            return rs;
          })();
          chunkInflight.set(ckey, p);
          try {
            const rs = await p;
            for (const [code, q] of Object.entries(rs)) out[code] = q;
          } finally {
            chunkInflight.delete(ckey);
          }
        })
      );
    }
    // usVIX 腾讯数据已停更，从新浪期货获取实时值覆盖(仅缓存过期时重取;
    // 带 inflight 去重 + 失败负缓存, 与主循环同理, 防并发 miss 打爆新浪)
    if (codes.includes("usVIX")) {
      const hit = cache.get("q:usVIX");
      if (hit && hit.data !== undefined && now - hit.ts < TTLS.QUOTE) {
        out.usVIX = hit.data;
      } else if (hit && hit.data !== undefined && hit.failAt != null && now - hit.failAt < quoteBackoff(hit.failCount)) {
        out.usVIX = hit.data; // 退避窗口内降级返回旧数据
      } else if (vixInflight) {
        try { out.usVIX = await vixInflight; } catch { /* 等待者随发起者一并失败 */ }
      } else {
        const p = (async () => {
          const vixText = await curlText("https://hq.sinajs.cn/list=hf_VX", { referer: "https://finance.sina.com.cn/futures/", timeout: 4000, encoding: "utf-8" });
          const m = vixText.match(/hf_VX="([^"]*)"/);
          if (!m) throw new Error("vix empty");
          const f = m[1].split(",");
          const price = parseFloat(f[0]);
          const prev = parseFloat(f[7]);
          if (isNaN(price)) throw new Error("vix bad");
          const rec = {
            symbol: "usVIX",
            name: "VIX恐慌指数期货",
            price,
            prev,
            change: changeOf(price, prev),
            pct: pctOf(price, prev),
            time: `${f[12]} ${f[6]}`,
          };
          cacheSet("q:usVIX", entry(rec, TTLS.QUOTE));
          return rec;
        })();
        vixInflight = p;
        try {
          out.usVIX = await p;
        } catch {
          // 失败: 标记退避, 保留旧数据降级(无旧数据时保持腾讯兜底值)
          cacheSet("q:usVIX", failEntry(hit, TTLS.QUOTE));
        } finally {
          vixInflight = null;
        }
      }
    }
    return out;
  }

  /* ---------------- 腾讯分钟线(指数/个股 日内走势) ---------------- */
  // 外汇(wh*)分钟线: 腾讯 minute 接口对 wh 代码只回 1 个点 → 硬编码东财 USDCNH 盘中分时
  // (在岸 120.USDCNYC 是每日中间价、分时恒平; 离岸 133.USDCNH 有盘中分时, 走势与在岸一致, 用作迷你图)
  // 东财 WAF 限流(SSL unexpected eof / curl 56)持续时: 绝不抛错 — 降级返回腾讯 spot 报价
  // (最新价+日涨跌, 读报价缓存不新增上游调用), 迷你图置空由前端显示占位提示。
  // 降级带 __ttl 短缓存(2min, 缓存层剥字段) + 本地指数退避(1s→5min): 上游恢复后尽快重试,
  // 不锁死旧数据、不伪造曲线、不整卡报错。
  const EM_KLINE_URL =
    "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=133.USDCNH&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=1&fqt=1&beg=0&end=20500101&lmt=240";
  const whMinuteFail = new Map(); // code -> { failAt, failCount }: 东财失败退避(与 quoteBackoff 同构)
  const minuteBackoffOf = (n) => Math.min(300000, 1000 * 2 ** (n || 0));
  const whDegraded = (code, q, extra) => {
    const deg = { code, prec: q?.price ? 4 : 0, points: [], source: q ? "tencent-spot" : "unavailable", degraded: true, __ttl: 120000, ...extra };
    if (q) { deg.price = q.price; deg.change = q.change; deg.pct = q.pct; deg.time = q.time; }
    return deg;
  };

  async function handleMinute(code) {
    if (code.startsWith("wh")) {
      const now = Date.now();
      const f = whMinuteFail.get(code);
      const inBackoff = f && now - f.failAt < minuteBackoffOf(f.failCount);
      if (!inBackoff) {
        try {
          const json = JSON.parse(await fetchTextAny(EM_KLINE_URL, { referer: "https://quote.eastmoney.com/", timeout: 5000 }));
          const pts = (json?.data?.klines || [])
            .map((s) => {
              const x = s.split(","); // "2026-08-05 05:01,open,close,high,low,vol" → 0501 / 收盘
              return { t: x[0].slice(11, 16).replace(":", ""), p: num(x[2]) };
            })
            .filter((p) => p.t && p.p > 0);
          if (!pts.length) throw new Error("empty kline");
          whMinuteFail.delete(code); // 成功复位退避
          return { code, prec: num(json?.data?.preKPrice), points: pts, source: "eastmoney" };
        } catch (e) {
          whMinuteFail.set(code, { failAt: Date.now(), failCount: (f?.failCount || 0) + 1 });
          // 落败计入退避, 继续走降级返回(不抛错 → 不刷 error 日志)
        }
      }
      // 降级: 引用报价缓存(腾讯 spot, 与报价中心同源) → 最新价+日涨跌; 无缓存时仅标 source=unavailable
      return whDegraded(code, cache.get(`q:${code}`)?.data);
    }
    // 美股指数(us*)只有 usMinute 接口返回全日序列, minute/query 只给最后一个点
    const url = code.startsWith("us")
      ? usMinuteUrl(code)
      : tencentMinuteUrl(code);
    const text = await fetchText(url);
    const json = JSON.parse(text);
    const d = json?.data?.[code];
    const arr = d?.data?.data || [];
    const prec = num(d?.data?.prec || d?.qt?.[code]?.[4] || 0);
    // 返回 "HHMM price vol" -> [分钟索引, 价格]
    const pts = arr.map((s) => {
      const p = s.split(" ");
      return { t: p[0], p: num(p[1]) };
    });
    return { code, prec, points: pts };
  }

  /* ---------------- 腾讯板块榜(行业 t=01 / 概念 t=02) ---------------- */
  async function handleBoards(type, dir, n) {
    const url = tencentRankUrl(n, type, dir);
    const text = await fetchText(url);
    const json = JSON.parse(text);
    return (json?.data || []).map((b) => ({
      code: b.bd_code,
      name: b.bd_name,
      price: num(b.bd_zxj),
      change: num(b.bd_zd),
      pct: num(b.bd_zdf),
      pct5: num(b.bd_zdf5),
      pct20: num(b.bd_zdf20),
      leadCode: b.nzg_code,
      leadName: b.nzg_name,
      leadPrice: num(b.nzg_zxj),
      leadPct: num(b.nzg_zdf),
    }));
  }

  /* ---------------- 板块成分股(上游单页上限100, 自动翻页) ---------------- */
  async function handleBoardStocks(code, dir, n) {
    const want = Math.min(parseInt(n) || 12, 400);
    const map = (s) => ({
      code: s.code,
      name: s.name,
      price: num(s.zxj),
      pct: num(s.zdf),
      turnover: num(s.hsl),
      pe: num(s.pe_ttm),
      speed: num(s.speed),
      circ_mv: num(s.ltsz), // 流通市值(亿)
      total_mv: num(s.zsz),
      amount: qqRank.estAmount(s), // 成交量(手)估算成交额(元), 公式见 lib/qq-rank.cjs
    });
    const out = [];
    for (let offset = 0; out.length < want; offset += 100) {
      const list = await qqRank.getBoardRankList({ boardCode: code, sortType: "PriceRatio", direct: dir, offset, count: 100 });
      if (!list.length) break;
      out.push(...list.map(map));
      if (list.length < 100) break;
    }
    return out.slice(0, want);
  }

  return { handleQuotes, handleMinute, handleBoards, handleBoardStocks };
};
