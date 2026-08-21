// 引流聚合（0820-k t_de577480）— 四源聚合 + 三层 fallback 单测 (node --test server/acquisition.test.cjs)
// 前置: 本机真实数据文件存在（knock.db / v2ex_tracking.json / opc/status.json）
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const KNOCK_DB = "/home/gavin/hermes_space/marketingdashboard/server/data/knock.db";
const V2EX_TRACKING = "/home/gavin/.hermes/mrd-promo/v2ex_tracking.json";
const STATUS_JSON = "/home/gavin/hermes_space/company-site/opc/status.json";

const bjToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

function makeCtx(over) {
  return {
    fs,
    bjToday,
    fetchText: async (url) => {
      if (over && over.fetchThrow) throw new Error("network down");
      // 按 path 返回确定性假数据（URL 是 encodeURIComponent 编码的 /go/xxx）
      const m = url.match(/path=(%2Fgo%2F[a-z]+)$/);
      const p = m ? decodeURIComponent(m[1]) : "/go/unknown";
      const hits = { "/go/opc": 1, "/go/blog": 3, "/go/github": 3, "/go/rank": 7 };
      return JSON.stringify({ ok: true, data: { path: p, days: { "2026-08-20": hits[p] || 0 }, total: hits[p] || 0 } });
    },
    KNOCK_DB,
    V2EX_TRACKING,
    STATUS_JSON,
    ...over,
  };
}

test("loadUtmVisits: by_date/by_source 聚合与实时 DB 一致, today=UTC+8 当日", () => {
  const src = require("./sources/acquisition.cjs")(makeCtx());
  const u = src.loadUtmVisits();
  assert.ok(u.total > 0, "utm total 应为正");
  assert.ok(u.by_source.v2ex >= 77, "v2ex source 应为当前主要来源");
  assert.equal(u.today, u.by_date[bjToday()] || 0);
  assert.equal(typeof u.week, "number");
  assert.ok(Object.keys(u.by_date).length >= 1);
});

test("loadFeedbackEvents: by_page/by_action 聚合与实时 DB 一致", () => {
  const src = require("./sources/acquisition.cjs")(makeCtx());
  const f = src.loadFeedbackEvents();
  assert.ok(f.total >= 9, "feedback total 应 ≥ 当前 9 事件");
  assert.ok((f.by_action.open || 0) >= 5, "open 事件应存在");
  assert.ok((f.by_action.submit || 0) >= 2, "submit 事件应存在");
  assert.ok(f.by_page.blog >= 2);
});

test("loadV2ex: 曝光 = 三帖 views 合计（潘明固定路径 samples 最新一条）", () => {
  const src = require("./sources/acquisition.cjs")(makeCtx());
  const v = src.loadV2ex();
  assert.ok(v.views_total >= 2759, "v2ex views_total 应 ≥ 2759");
  assert.equal(v.topics_count, 3);
  assert.ok(v.baseline_views_total >= 2500);
  assert.ok(v.updated_at.length > 0);
});

test("loadMetrics: status.json metrics 聚合", () => {
  const src = require("./sources/acquisition.cjs")(makeCtx());
  const m = src.loadMetrics();
  assert.ok(m.mrd_stars >= 100, "mrd_stars 应 ≥ 100");
  assert.ok(m.demo_24h_visitors > 0);
  assert.equal(typeof m.juejin_reads, "number");
});

test("handleAcquisition: 漏斗 4 层/数字卡/渠道条与各源一致, 无 NaN", async () => {
  const src = require("./sources/acquisition.cjs")(makeCtx());
  const d = await src.handleAcquisition();
  assert.equal(d.funnel.exposure, d.v2ex.views_total, "L1 曝光 = V2EX views");
  assert.equal(d.funnel.click, d.utm_visits.total, "L2 点击 = utm total");
  assert.equal(d.funnel.landing, d.feedback_events.by_action.open + d.metrics.demo_24h_visitors, "L3 落地 = feedback open + demo 24h");
  assert.equal(d.funnel.intent, d.feedback_events.by_action.submit + d.metrics.mrd_stars, "L4 意向 = feedback submit + stars");
  assert.equal(d.kpis.today_uv, d.utm_visits.today);
  assert.equal(d.kpis.week_uv, d.utm_visits.week);
  assert.equal(d.kpis.shortlink_total, d.shortlink.total);
  assert.equal(d.kpis.feedback_total, d.feedback_events.total);
  assert.equal(d.channels.length, 5);
  assert.deepEqual(d.channels.map((c) => c.name), ["v2ex", "juejin", "devto", "shortlink", "github"]);
  assert.equal(d.channels[0].v, d.utm_visits.by_source.v2ex);
  assert.equal(d.channels[3].v, d.shortlink.total);
  assert.equal(d.channels[4].v, d.metrics.mrd_stars);
  // 无 NaN/全 0（当前真实数据下）
  const flat = JSON.stringify(d);
  assert.ok(!flat.includes("NaN"), "响应不得含 NaN");
  assert.ok(d.kpis.today_uv > 0 && d.kpis.shortlink_total > 0 && d.kpis.feedback_total > 0);
  assert.ok(!d.degraded_sources, "全源健康时不得标记降级");
  assert.equal(d.__ttl, undefined, "健康数据不带 __ttl（走常规 60s 缓存）");
});

test("降级: 短链上游全挂 → 该源回空态, 响应带 __ttl:5min 短缓存, 不整卡报错", async () => {
  const src = require("./sources/acquisition.cjs")(makeCtx({ fetchThrow: true }));
  const d = await src.handleAcquisition(); // 必须不抛
  assert.ok(d.degraded_sources.includes("shortlink"));
  assert.equal(d.__ttl, 5 * 60 * 1000, "降级必须配 5 分钟短 TTL");
  assert.equal(d.shortlink.total, 0);
  assert.deepEqual(d.shortlink.by_path["opc"], { days: {}, total: 0 });
  // 其余源不受牵连
  assert.equal(d.funnel.exposure, d.v2ex.views_total);
  assert.ok(d.funnel.exposure > 0);
});

test("全源失败 → 空态三层兜底, 绝不抛错（断网/文件缺失场景）", async () => {
  const src = require("./sources/acquisition.cjs")(makeCtx({
    fetchThrow: true,
    KNOCK_DB: "/nonexistent/knock.db",
    V2EX_TRACKING: "/nonexistent/v2ex_tracking.json",
    STATUS_JSON: "/nonexistent/status.json",
  }));
  const d = await src.handleAcquisition(); // 必须不抛
  assert.equal(d.degraded_sources.length, 5);
  assert.equal(d.__ttl, 5 * 60 * 1000);
  assert.equal(d.utm_visits.total, 0);
  assert.equal(d.feedback_events.total, 0);
  assert.equal(d.shortlink.total, 0);
  assert.equal(d.v2ex.views_total, 0);
  assert.equal(d.metrics.mrd_stars, 0);
  assert.equal(d.kpis.today_uv, 0);
  assert.equal(d.funnel.exposure, 0);
  assert.equal(d.channels.length, 5);
  assert.ok(d.channels.every((c) => c.v === 0));
});
