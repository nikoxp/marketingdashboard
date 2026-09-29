// 资金流四接口多源回退 + 旧数据降级单测 — node:test(server CJS 不经过 vitest, 与仓库既有 *.test.cjs 一致)
// 运行: node --test server/moneyflow.test.cjs
// 说明: 本文件全部用 mock 上游(不依赖网络), 保证 CI 稳定; "真实上游可达性"证据见交付报告里的 curl 实测。
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { createCache } = require("./lib/cache.cjs");
const createLastGood = require("./lib/last-good.cjs");
const { num, toMarketCode6 } = require("./lib/format.cjs");
const createMoneyFlow = require("./sources/moneyflow.cjs");

const SCRATCH = path.join(os.tmpdir(), `mrd-lastgood-test-${process.pid}`);

/* ---------------- 上游桩件 ---------------- */

// 东财 push2* 现场: 全部 TLS 断连(本机实测 curl 56)
const EM_DOWN = () => ({
  handleBoardFlow: async () => { throw new Error("curl(56) push2delay unreachable"); },
  handleBoardMoneyFlow: async () => { throw new Error("curl(56) push2delay unreachable"); },
  handleStockFlows: async () => { throw new Error("curl(56) push2delay unreachable"); },
  handleStockBoards: async () => { throw new Error("curl(56) push2delay unreachable"); },
});

// 新浪板块资金表(真实响应字段裁剪)
const sinaBk = (category, name, net, asc) => ({
  cate_type: "0", category, name, avg_price: "14.2676", avg_changeratio: asc === "1" ? "-0.02" : "0.0417",
  turnover: "155.848", inamount: "17219590428.91", outamount: "15780506642.19", netamount: net,
  ratioamount: "0.0417", ts_symbol: "sh600418", ts_name: "江淮汽车",
});
// 新浪个股资金流(真实响应字段裁剪)
const sinaStock = (symbol, name, net, ratio, trade, chg) => ({
  symbol, name, trade, changeratio: chg, turnover: "796.241", amount: "4392576724.00",
  inamount: "2853288025.35", outamount: "1342913632.69", netamount: net, ratioamount: ratio,
  r0_in: "2513407258.92", r0_out: "1242008234.49", r0_net: "1271399024.43", r0_ratio: "0.2894",
});

/** 按 URL 分发的新浪桩件(模拟 4 个真实端点) */
function sinaStub({ boards = {}, members = [], node = [], day = {}, rank = null } = {}) {
  return async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("MoneyFlow.ssl_bkzj_bk")) {
      const key = `${u.searchParams.get("fenlei")}:${u.searchParams.get("asc")}`;
      return boards[key] ?? [];
    }
    if (u.pathname.endsWith("MoneyFlow.ssl_bkzj_ssggzj")) {
      const bk = u.searchParams.get("bankuai");
      if (bk) return members;
      const asc = u.searchParams.get("asc");
      return rank ? (asc === "1" ? rank.down : rank.up) : [];
    }
    if (u.pathname.endsWith("Market_Center.getHQNodeData")) return node;
    if (u.pathname.endsWith("MoneyFlow.ssl_qsfx_zjlrqs")) {
      const code = u.searchParams.get("daima");
      return day[code] ? [day[code]] : [];
    }
    throw new Error(`unexpected sina url ${url}`);
  };
}

/** 腾讯板块榜/成分股桩件(getRank 返回 zljlr 万元口径) */
const qqStub = (list) => ({
  getBoardRankList: async () => { throw new Error("qq members unused"); },
  __list: list,
});
const qqRankJson = (list) => JSON.stringify({ code: 0, msg: "ok", data: { rank_list: list } });

let lgSeq = 0;
function makeFlow({ em = EM_DOWN(), sinaJson, fallback, qqRank = { getBoardRankList: async () => [] } } = {}) {
  const c = createCache();
  // 每个用例独立 lastGood 目录: 用例之间不互相污染(隔离快照)
  const lastGood = createLastGood({ fs, path, dir: path.join(SCRATCH, `lg-${++lgSeq}`) });
  const mf = createMoneyFlow({
    num, toMarketCode6,
    fetchSinaJson: sinaJson || (async () => { throw new Error("sina unreachable"); }),
    fetchWithFallback: fallback || (async () => { throw new Error("upstream unreachable"); }),
    qqRank,
    cache: c.cache, cacheSet: c.set, entry: c.entry, TTLS: c.TTLS, cachedMeta: c.cachedMeta,
    lastGood, em,
  });
  return { mf, cache: c, lastGood };
}

/* ---------------- /api/board-flow ---------------- */

test("board-flow: 东财不可达 → 新浪行业板块表(净流入/流出各半, points 空数组)", async () => {
  const boards = {
    "0:0": [sinaBk("new_qczz", "汽车制造", "1439083786.72", "0"), sinaBk("new_dz", "电子行业", "900000000", "0"), sinaBk("new_yy", "医药行业", "800000000", "0")],
    "0:1": [sinaBk("new_mt", "煤炭行业", "-2000000000", "1"), sinaBk("new_gf", "钢铁行业", "-1900000000", "1")],
  };
  const { mf } = makeFlow({ sinaJson: sinaStub({ boards }) });
  const r = await mf.boardFlow("20");
  assert.equal(r.stale, false);
  assert.equal(r.source, "sina-hy");
  assert.equal(typeof r.asof, "number");
  assert.equal(r.data.length, 5); // half=10 → 3 流入 + 2 流出(上游只有 2 条)
  for (const row of r.data) {
    assert.deepEqual(Object.keys(row).sort(), ["code", "name", "netIn", "points"]);
    assert.equal(typeof row.netIn, "number");
    assert.deepEqual(row.points, []); // 替代源无分钟曲线: 空数组, 不伪造
  }
  assert.equal(r.data[0].netIn, 1439083786.72); // 元, 与新浪 netamount 同值
});

test("board-flow: 新浪也不可达 → 腾讯申万一级榜(zljlr 万元 → 元)", async () => {
  const list = [
    { code: "pt01801120", name: "食品饮料", zljlr: "-16835.63", zdf: "-0.17" },
    { code: "pt01801080", name: "电子", zljlr: "-3155663.35", zdf: "-4.93" },
    { code: "pt01801960", name: "石油石化", zljlr: "800000.5", zdf: "0.89" },
  ];
  const { mf } = makeFlow({ fallback: async () => qqRankJson(list) });
  const r = await mf.boardFlow("4"); // half=3
  assert.equal(r.source, "tencent-hy");
  assert.equal(r.data[0].code, "pt01801960"); // 净流入最高者在前
  assert.equal(r.data[0].netIn, 8000005000); // 万元 × 1e4
  assert.equal(r.data.at(-1).name, "电子");
});

test("board-flow: 所有源都挂但有历史快照 → stale=true + asof, 不抛错", async () => {
  const { mf, lastGood } = makeFlow();
  const snapshot = [{ code: "BK0438", name: "食品饮料", netIn: 123, points: [{ t: "09:31", v: 1 }] }];
  lastGood.write("board-flow:20", snapshot);
  const r = await mf.boardFlow("20");
  assert.equal(r.stale, true);
  assert.equal(r.source, "last-good");
  assert.equal(typeof r.asof, "number");
  assert.deepEqual(r.data, snapshot);
  assert.equal(r.__ttl, 15000); // 降级载荷短 TTL: 15s 后重试上游
});

test("board-flow: 所有源都挂且无历史快照 → 如实抛错(路由层 502)", async () => {
  const { mf } = makeFlow();
  await assert.rejects(() => mf.boardFlow("20"), /no upstream data available/);
});

/* ---------------- /api/board-moneyflow ---------------- */

test("board-moneyflow: 新浪板块码 → bankuai= 完整成分榜(字段与东财口径逐一对齐)", async () => {
  const members = [
    sinaStock("sh600418", "江淮汽车", "1510374392.66", "0.343847", "25.2200", "0.0998692"),
    sinaStock("sz002347", "泰尔股份", "100000", "0.01", "8.0000", "-0.02"),
  ];
  const { mf } = makeFlow({ sinaJson: sinaStub({ members }) });
  const r = await mf.boardMoneyFlow("new_qczz", "15");
  assert.equal(r.source, "sina-bankuai");
  assert.equal(r.stale, false);
  assert.equal(r.data.length, 2);
  assert.deepEqual(Object.keys(r.data[0]).sort(), ["amount", "name", "netIn", "netRatio", "pct", "price", "r0Net", "symbol", "turnover"]);
  assert.equal(r.data[0].netRatio, 34.38); // ratioamount 小数 → %
  assert.equal(r.data[0].pct, 9.99);
  assert.equal(r.data[0].netIn, 1510374392.66);
});

test("board-moneyflow: BK 码 + 东财不可达 → F10 成分 × 全市场净额映射(部分覆盖置 partial)", async () => {
  const f10Members = { result: { data: [
    { SECURITY_CODE: "600519", SECURITY_NAME_ABBR: "贵州茅台", NEW_BOARD_CODE: "BK0438" },
    { SECURITY_CODE: "000858", SECURITY_NAME_ABBR: "五粮液", NEW_BOARD_CODE: "BK0438" },
    { SECURITY_CODE: "600809", SECURITY_NAME_ABBR: "山西汾酒", NEW_BOARD_CODE: "BK0438" },
  ] } };
  const rank = {
    up: [sinaStock("sh600519", "贵州茅台", "334270735.53", "0.0958", "1243.88", "0.00556")],
    down: [sinaStock("sz000858", "五粮液", "-672895782.09", "-0.1755", "123.00", "-0.0106")],
  };
  const { mf } = makeFlow({
    sinaJson: sinaStub({ rank }),
    fallback: async (url) => { assert.match(url, /RPT_F10_CORETHEME_BOARDTYPE/); return JSON.stringify(f10Members); },
  });
  const r = await mf.boardMoneyFlow("BK0438", "15");
  assert.equal(r.source, "sina-map+em-f10-members");
  assert.equal(r.partial, true); // 3 只成分只有 2 只进了全市场净额榜 → 覆盖不全, 如实标记
  assert.deepEqual(r.data.map((x) => x.code), ["600519", "000858"]); // 净流入降序(600519 在前)
  assert.equal(r.data[0].netIn, 334270735.53);
  assert.equal(r.data[0].netRatio, 9.58);
});

test("board-moneyflow: 所有源都挂但有历史快照 → stale; 无快照 → 抛错", async () => {
  const { mf, lastGood } = makeFlow();
  lastGood.write("board-moneyflow:new_qczz", [sinaStock("sh600418", "江淮汽车", "1", "0.1", "25", "0.01")]);
  const r = await mf.boardMoneyFlow("new_qczz", "15");
  assert.equal(r.stale, true);
  assert.equal(r.data.length, 1);
  await assert.rejects(() => mf.boardMoneyFlow("BK0447", "15"), /no upstream data available/);
  // 未知板块码: 维持改造前的 200 + [] (不带 stale)
  const unknown = await mf.boardMoneyFlow("XX9999", "15");
  assert.deepEqual(unknown, { data: [], stale: false, asof: unknown.asof, source: "none" });
});

/* ---------------- /api/stock-flow(s) ---------------- */

test("stock-flow: 东财不可达 → 新浪全市场净流入榜(盘中口径)", async () => {
  const rank = { up: [sinaStock("sh600519", "贵州茅台", "334270735.53", "0.0958", "1243.88", "0.00556")], down: [] };
  const { mf } = makeFlow({ sinaJson: sinaStub({ rank }) });
  const r = await mf.stockFlow("sh600519", new Map());
  assert.equal(r.stale, false);
  assert.equal(r.source, "sina-rank");
  assert.equal(r.data.code, "sh600519");
  assert.equal(r.data.netIn, 334270735.53);
  assert.equal(r.data.netRatio, 9.58);
  assert.equal(r.data.r0Net, 1271399024.43);
  // 必留字段(前端 StockFlow 契约)齐全
  for (const k of ["code", "netIn", "netRatio"]) assert.ok(k in r.data, k);
});

test("stock-flow: 未进榜 → 新浪个股资金流趋势(日频, 带 date 标明口径)", async () => {
  const day = { sh600519: { opendate: "2026-09-28", trade: "1243.8800", changeratio: "0.00556184", turnover: "22.5732", netamount: "334270735.5300", ratioamount: "0.0958147", r0_net: "244011544.4300" } };
  const { mf } = makeFlow({ sinaJson: sinaStub({ rank: { up: [], down: [] }, day }) });
  const r = await mf.stockFlow("sh600519", new Map());
  assert.equal(r.source, "sina-day");
  assert.equal(r.data.date, "2026-09-28");
  assert.equal(r.data.netIn, 334270735.53);
  assert.equal(r.data.netRatio, 9.58);
  assert.equal(r.data.close, 1243.88);
});

test("stock-flows(批量): 单只全挂但有历史快照 → 该行 stale=true; 全无 → [](不 502)", async () => {
  const { mf, lastGood } = makeFlow();
  lastGood.write("stockflow:sh600519", { code: "sh600519", netIn: 999, netRatio: 1.5 });
  const r = await mf.stockFlows("sh600519,sz000001", new Map());
  assert.equal(r.stale, true);
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].stale, true);
  assert.equal(typeof r.data[0].asof, "number");
  // sz000001 无历史 → 该只缺席, 整体不抛错(维持批量端点既有 200 + [] 契约)
  const empty = await mf.stockFlows("sz000001", new Map());
  assert.deepEqual(empty.data, []);
});

test("stock-flow(单只): 全挂且无历史 → 抛错(与改造前 empty stock-flow 502 契约一致)", async () => {
  const { mf } = makeFlow();
  await assert.rejects(() => mf.stockFlow("sh600519", new Map()), /empty stock-flow/);
});

/* ---------------- /api/stock-boards ---------------- */

const f10Rows = { result: { data: [
  { SECUCODE: "600519.SH", SECURITY_CODE: "600519", BOARD_CODE: "999", BOARD_NAME: "茅指数", BOARD_RANK: 11, BOARD_TYPE: null, BOARD_LEVEL: null, NEW_BOARD_CODE: "BK0999" },
  { SECUCODE: "600519.SH", SECURITY_CODE: "600519", BOARD_CODE: "438", BOARD_NAME: "食品饮料", BOARD_RANK: 1, BOARD_TYPE: "行业", BOARD_LEVEL: "1", NEW_BOARD_CODE: "BK0438" },
  { SECUCODE: "600519.SH", SECURITY_CODE: "600519", BOARD_CODE: "173", BOARD_NAME: "贵州板块", BOARD_RANK: 4, BOARD_TYPE: "板块", BOARD_LEVEL: null, NEW_BOARD_CODE: "BK0173" },
  { SECUCODE: "600519.SH", SECURITY_CODE: "600519", BOARD_CODE: "896", BOARD_NAME: "白酒", BOARD_RANK: 23, BOARD_TYPE: null, BOARD_LEVEL: null, NEW_BOARD_CODE: "BK0896" },
] } };

test("stock-boards: 东财 push2 不可达 → datacenter-web F10 核心题材(行业/地域/概念三分)", async () => {
  const { mf } = makeFlow({ fallback: async (url) => {
    assert.match(url, /datacenter-web\.eastmoney\.com/);
    assert.match(decodeURIComponent(url), /\(SECUCODE="600519\.SH"\)/);
    return JSON.stringify(f10Rows);
  } });
  const r = await mf.stockBoards("sh600519");
  assert.equal(r.stale, false);
  assert.equal(r.source, "eastmoney-f10");
  assert.equal(r.data.code, "sh600519");
  assert.equal(r.data.industry, "食品饮料");
  assert.equal(r.data.area, "贵州"); // "贵州板块" 去掉后缀, 对齐 f128 口径
  assert.deepEqual([...r.data.concepts].sort(), ["白酒", "茅指数"]);
  assert.deepEqual(Object.keys(r.data).filter((k) => !["stale", "asof", "source"].includes(k)).sort(), ["area", "code", "concepts", "industry"]);
});

test("stock-boards: 全挂有快照 → stale; 全挂无快照 → 抛错; 非法码 → 400", async () => {
  const { mf, lastGood } = makeFlow();
  lastGood.write("stock-boards:sh600519", { code: "sh600519", industry: "食品饮料", area: "贵州", concepts: ["白酒"] });
  const r = await mf.stockBoards("sh600519");
  assert.equal(r.stale, true);
  assert.equal(r.data.industry, "食品饮料");
  await assert.rejects(() => mf.stockBoards("sh600000"), /no upstream data available/);
  await assert.rejects(() => mf.stockBoards("600519"), (e) => e.status === 400);
});

/* ---------------- 东财主源未被回退层遮蔽(上游恢复即回到东财口径) ---------------- */

test("回退层不遮蔽东财: 东财可用时直接用东财结果(含分时 points), 不碰替代源", async () => {
  let sinaCalls = 0;
  const emUp = {
    ...EM_DOWN(),
    handleBoardFlow: async () => [{ code: "BK0438", name: "食品饮料", netIn: 12345, points: [{ t: "09:31", v: 1 }] }],
    handleBoardMoneyFlow: async () => [{ symbol: "sh600519", name: "贵州茅台", price: 1, pct: 1, amount: 1, netIn: 1, netRatio: 1, r0Net: 1, turnover: 1 }],
    handleStockFlows: async () => [{ code: "sh600519", netIn: 7, netRatio: 0.7 }],
    handleStockBoards: async () => ({ code: "sh600519", industry: "食品饮料", area: "贵州", concepts: ["白酒"] }),
  };
  const { mf } = makeFlow({
    em: emUp,
    sinaJson: async () => { sinaCalls++; throw new Error("sina 不应被调用"); },
    fallback: async () => { throw new Error("fallback 不应被调用"); },
  });
  const bf = await mf.boardFlow("20");
  assert.equal(bf.source, "eastmoney");
  assert.equal(bf.stale, false);
  assert.equal(bf.data[0].points.length, 1); // 东财独有的分钟级曲线仍在

  const bm = await mf.boardMoneyFlow("BK0438", "15");
  assert.equal(bm.source, "eastmoney");
  assert.equal(bm.data[0].netIn, 1);

  const fl = await mf.stockFlow("sh600519", new Map());
  assert.equal(fl.source, "eastmoney");
  assert.equal(fl.data.netIn, 7);

  const sb = await mf.stockBoards("sh600519");
  assert.equal(sb.source, "eastmoney");
  assert.equal(sb.data.concepts.length, 1);
  assert.equal(sinaCalls, 0);
});

/* ---------------- cachedMeta 新鲜度(路由层) ---------------- */

test("cachedMeta: 新鲜命中 stale=false; 上游失败回旧值 stale=true; 退避窗口内返回旧值 stale=true", async () => {
  const c = createCache();
  const ok = async () => [1, 2];
  const fail = async () => { throw new Error("upstream down"); };

  // TTL=0: 每次都要打上游 → 首次成功 stale=false
  const a = await c.cachedMeta("k1", 0, ok);
  assert.deepEqual([a.data, a.stale], [[1, 2], false]);

  // 上游失败但缓存里有旧值 → 旧值 + stale=true(这正是"上游全挂不 502"的服务端机制)
  const b = await c.cachedMeta("k1", 0, fail);
  assert.deepEqual([b.data, b.stale], [[1, 2], true]);

  // 失败退避窗口内: 不再打上游, 依旧 stale=true
  const d = await c.cachedMeta("k1", 0, fail);
  assert.deepEqual([d.data, d.stale], [[1, 2], true]);

  // 新鲜期内命中(ttl 5000): 不打上游, stale=false
  const e = await c.cachedMeta("k2", 5000, ok);
  assert.equal(e.stale, false);
  const f = await c.cachedMeta("k2", 5000, fail);
  assert.deepEqual([f.data, f.stale], [[1, 2], false]);

  // 无旧值 + 上游失败 → 如实抛错(不吞)
  await assert.rejects(() => c.cachedMeta("k3", 0, fail), /upstream down/);
});

test("cachedMeta: 并发在途合并(同 key 只打一次上游)", async () => {
  const c = createCache();
  let calls = 0;
  const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { v: 1 }; };
  const [x, y] = await Promise.all([c.cachedMeta("k", 5000, fn), c.cachedMeta("k", 5000, fn)]);
  assert.equal(calls, 1);
  assert.equal(x.data.v, 1);
  assert.equal(y.data.v, 1);
  assert.equal(x.stale, false);
});

test("last-good: 落盘后新进程仍可读到快照(重启后降级成立)", () => {
  const dir = path.join(SCRATCH, "lg2");
  const a = createLastGood({ fs, path, dir, writeThrottleMs: 0 });
  a.write("board-flow:20", [{ code: "BK0438", name: "食品饮料", netIn: 1, points: [] }]);
  const b = createLastGood({ fs, path, dir }); // 新实例 = 模拟重启后内存为空
  const hit = b.read("board-flow:20");
  assert.equal(hit.data[0].code, "BK0438");
  assert.equal(typeof hit.at, "number");
  assert.equal(b.read("missing:key"), null);
});
