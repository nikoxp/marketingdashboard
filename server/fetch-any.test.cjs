// fetch-any 代理通道单测 — node:test(server CJS 不经过 vitest)
// 运行: node --test server/fetch-any.test.cjs
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const createFetchAny = require("./lib/fetch-any.cjs");
const { buildCurlArgs } = createFetchAny; // 纯函数挂在工厂上(module.exports.buildCurlArgs)

// 本地 http 服务器, 返回固定文本; 用于验证"无代理时 fetch 通道成功" vs "配代理时跳过 fetch"
function listenSrv(body = "hello") {
  const srv = http.createServer((req, res) => { res.setHeader("content-type", "text/plain"); res.end(body); });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}
const srvUrl = (srv) => `http://127.0.0.1:${srv.address().port}/t`;
const closeSrv = (srv) => new Promise((r) => srv.close(r));

test("buildCurlArgs: 配置 proxy 时带 -x <proxy> 且在 url 之前", () => {
  const args = buildCurlArgs({
    url: "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT",
    referer: "https://www.binance.com/",
    proxy: "http://127.0.0.1:7890",
    timeoutSec: 8,
  });
  const ix = args.indexOf("-x");
  assert.ok(ix >= 0, "应包含 -x");
  assert.equal(args[ix + 1], "http://127.0.0.1:7890");
  assert.equal(args[args.length - 1], "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT"); // url 恒为末参
});

test("buildCurlArgs: 无 proxy 时不带 -x", () => {
  const args = buildCurlArgs({ url: "https://hq.sinajs.cn/list=x", timeoutSec: 8 });
  assert.ok(!args.includes("-x"));
});

test("fetchWithFallback: 无代理时走 fetch 通道成功", async () => {
  const srv = await listenSrv();
  try {
    const fa = createFetchAny({});
    const text = await fa.fetchWithFallback(srvUrl(srv), {});
    assert.equal(text, "hello");
  } finally { await closeSrv(srv); }
});

test("fetchWithFallback: 配置 proxy 时跳过 fetch 只走 curl -x(死代理必然失败, 证明 fetch 未被执行)", async () => {
  const srv = await listenSrv(); // 目标可达 — 若误走 fetch 会成功
  try {
    const fa = createFetchAny({});
    // 127.0.0.1:1 无服务 → curl exit 7; 若 fetch 通道被误用则此处会 resolve, 测试即失败
    await assert.rejects(
      fa.fetchWithFallback(srvUrl(srv), { proxy: "http://127.0.0.1:1", timeout: 3000 }),
      /curl/
    );
  } finally { await closeSrv(srv); }
});

test("fetchWithFallback: MRD_PROXY 环境变量透传(不显式传 proxy 也走代理)", async () => {
  const srv = await listenSrv(); // 目标可达
  const old = process.env.MRD_PROXY;
  process.env.MRD_PROXY = "http://127.0.0.1:1"; // 死代理: 透传生效则失败, 未透传则 fetch 直连成功
  try {
    const fa = createFetchAny({});
    await assert.rejects(fa.fetchWithFallback(srvUrl(srv), { timeout: 3000 }), /curl/);
  } finally {
    if (old === undefined) delete process.env.MRD_PROXY; else process.env.MRD_PROXY = old;
    await closeSrv(srv);
  }
});

test("fetchText: 配置 proxy 时改走 curl 通道(死代理失败, 证明未走 fetch)", async () => {
  const srv = await listenSrv();
  try {
    const fa = createFetchAny({});
    await assert.rejects(fa.fetchText(srvUrl(srv), { proxy: "http://127.0.0.1:1", timeout: 3000 }), /curl/);
  } finally { await closeSrv(srv); }
});
