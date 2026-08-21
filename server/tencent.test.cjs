// 汇率(wh*)分钟线降频+兜底降级单测 — node:test(server CJS 不经过 vitest)
// 运行: node --test server/tencent.test.cjs
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { num, changeOf, pctOf } = require("./lib/format.cjs");
const { parseCsvParam, chunked, safeRecord } = require("./lib/netutil.cjs");
const { createCache, entry, failEntry, quoteBackoff, TTLS } = require("./lib/cache.cjs");
const createTencent = require("./sources/tencent.cjs");

// 东财成功响应(字段2: f51时间,f52开,f53收,f54高,f55低,f56量)
const OK_KLINE = {
  data: {
    klines: [
      "2026-08-20 13:01,6.7305,6.7306,6.7308,6.7302,10",
      "2026-08-20 13:02,6.7306,6.7307,6.7309,6.7303,12",
    ],
    preKPrice: 6.7311,
  },
};

// 每个用例独立 factory(闭包内 whMinuteFail 退避状态互不污染)
function makeTencent({ fetchTextAny } = {}) {
  const ret = createCache();
  return {
    tencent: createTencent({
      fetchText: async () => { throw new Error("fetchText unexpected"); },
      fetchTextAny: fetchTextAny || (async () => { throw new Error("eastmoney down"); }),
      curlText: async () => { throw new Error("curlText unexpected"); },
      cache: ret.cache,
      cacheSet: ret.set,
      parseCsvParam, chunked, safeRecord, num, changeOf, pctOf,
      entry, failEntry, quoteBackoff, TTLS,
      qqRank: { getBoardRankList: async () => [] },
    }),
    cache: ret.cache,
    cacheSet: ret.set,
    cached: ret.cached,
  };
}

test("wh 东财正常: 返回分时 points + source=eastmoney, 无降级标志", async () => {
  const { tencent } = makeTencent({ fetchTextAny: async () => JSON.stringify(OK_KLINE) });
  const r = await tencent.handleMinute("whUSDCNY");
  assert.equal(r.code, "whUSDCNY");
  assert.equal(r.source, "eastmoney");
  assert.equal(r.degraded, undefined);
  assert.equal(r.points.length, 2);
  assert.equal(r.points[0].t, "1301");
  assert.equal(r.points[0].p, 6.7306);
  assert.equal(r.prec, 6.7311);
});

test("wh 东财失败(SSL unexpected eof)且报价缓存有值: 降级 tencent-spot, 不抛错, 带 spot 快照与短 TTL", async () => {
  const { tencent, cacheSet } = makeTencent(); // fetchTextAny 默认 reject
  cacheSet("q:whUSDCNY", entry({ price: 6.7248, change: -0.0032, pct: -0.05, time: "13:27:45" }, TTLS.QUOTE));
  const r = await tencent.handleMinute("whUSDCNY"); // 必须 resolve, 不得抛错
  assert.equal(r.code, "whUSDCNY");
  assert.equal(r.degraded, true);
  assert.equal(r.source, "tencent-spot");
  assert.equal(r.points.length, 0); // 迷你图置空 → 前端占位, 不伪造曲线
  assert.equal(r.price, 6.7248);    // 最新价
  assert.equal(r.change, -0.0032);  // 日涨跌
  assert.equal(r.pct, -0.05);
  assert.equal(r.__ttl, 120000);    // 短 TTL: 上游恢复后 2min 内重试, 不锁死 24h
});

test("wh 东财失败且报价缓存无值: 降级 source=unavailable, 仍不抛错", async () => {
  const { tencent } = makeTencent();
  const r = await tencent.handleMinute("whUSDCNY");
  assert.equal(r.degraded, true);
  assert.equal(r.source, "unavailable");
  assert.equal(r.points.length, 0);
  assert.equal(r.price, undefined);
  assert.equal(r.__ttl, 120000);
});

test("wh 东财失败后退避窗口内不重打上游(负缓存, 防刷屏)", async () => {
  let calls = 0;
  const { tencent } = makeTencent({ fetchTextAny: async () => { calls++; throw new Error("eastmoney down"); } });
  const r1 = await tencent.handleMinute("whUSDCNY");
  assert.equal(r1.degraded, true);
  assert.equal(calls, 1);
  // 同一实例紧接着再调: 退避(2s)未过 → 不再打东财, 直接降级
  const r2 = await tencent.handleMinute("whUSDCNY");
  assert.equal(r2.degraded, true);
  assert.equal(calls, 1, "退避窗口内不得重打上游");
});

test("降级经 cached() 包装: 短 TTL 生效且窗口内不重复执行 fn(与路由层集成)", async () => {
  let calls = 0;
  const { tencent, cached, cache } = makeTencent({ fetchTextAny: async () => { calls++; throw new Error("eastmoney down"); } });
  const r1 = await cached("minute:whUSDCNY", 5000, () => tencent.handleMinute("whUSDCNY"));
  assert.equal(r1.degraded, true);
  assert.equal(r1.__ttl, undefined); // __ttl 为缓存层内部字段, 对外剥除
  assert.equal(cache.get("minute:whUSDCNY").ttl, 120000, "降级返回的 __ttl 应覆盖路由 5s 默认 TTL");
  const r2 = await cached("minute:whUSDCNY", 5000, () => tencent.handleMinute("whUSDCNY"));
  assert.equal(r2.degraded, true);
  assert.equal(calls, 1, "缓存窗口内不再打上游(含 fn 内的东财调用)");
});

test("wh 东财恢复正常: 退避窗口过后复位, 重新返回正常分时", async () => {
  let fail = true;
  const { tencent } = makeTencent({
    fetchTextAny: async () => { if (fail) throw new Error("eastmoney down"); return JSON.stringify(OK_KLINE); },
  });
  const r1 = await tencent.handleMinute("whUSDCNY");
  assert.equal(r1.degraded, true);
  fail = false;
  // 失败退避窗口(1 次失败 → 2s)内不重打上游; 窗口过后重试成功 → 退避复位
  await new Promise((res) => setTimeout(res, 2100));
  const r2 = await tencent.handleMinute("whUSDCNY");
  assert.equal(r2.degraded, undefined);
  assert.equal(r2.source, "eastmoney");
  assert.equal(r2.points.length, 2);
});
