// 引流聚合 API（0820-k t_de577480）— 4 源聚合:
//   1. utm_visits     knock.db（node:sqlite 只读, 与 gold.cjs 同模式; 零新依赖）
//   2. feedback_events knock.db 同库同法
//   3. 短链 hits       www.hermes.cc.cd/api/go/hits × 4（/go/{opc,blog,github,rank}）
//   4. V2EX 曝光       潘明固定路径 ~/.hermes/mrd-promo/v2ex_tracking.json
//   5. metrics         opc/status.json 的 metrics（mrd_stars/juejin_reads/devto_reactions/demo_24h_visitors…）
// 三层 fallback 铁律（marketingdashboard-backend skill）: 任一源失败 → 该源最近落盘值（内存
//   last-good）→ 空态; 绝不整卡报错。任何降级 → 响应带 __ttl: 5*60*1000 短缓存, 上游恢复后尽快重试。
// 口径（写进卡评论的交付说明）:
//   曝光 = V2EX 三帖 views 合计（samples 最新一条 v2ex_views_total）
//   点击 = knock.db utm_visits 全量 total（含全部 campaign/source）
//   落地行为 = feedback open 事件数 + demo_24h_visitors（访客在落地页/demo 的行为）
//   意向 = feedback submit 事件数 + mrd_stars（留下反馈/点星 = 强意向）
//   渠道对比条 = 各渠道代表性引流数字: v2ex=utm 点击 / juejin=阅读量 / devto=reactions /
//               shortlink=短链点击 / github=star（不混口径, 各取该渠道最接近 UV 的运营指标）
"use strict";
const { DatabaseSync } = require("node:sqlite");

module.exports = function createAcquisition(ctx) {
  const { fetchText, fs, bjToday } = ctx;

  const KNOCK_DB = ctx.KNOCK_DB || "/home/gavin/hermes_space/marketingdashboard/server/data/knock.db";
  const V2EX_TRACKING = ctx.V2EX_TRACKING || "/home/gavin/.hermes/mrd-promo/v2ex_tracking.json";
  const STATUS_JSON = ctx.STATUS_JSON || "/home/gavin/hermes_space/company-site/opc/status.json";
  const SHORTLINK_PATHS = ["/go/opc", "/go/blog", "/go/github", "/go/rank"];
  const SHORTLINK_BASE = "https://www.hermes.cc.cd/api/go/hits?path=";
  const DEGRADED_TTL = 5 * 60 * 1000; // 任何降级必须配短 TTL（否则上游恢复后 24h 锁死旧数据）

  // 三层 fallback 第二层: 内存 last-good（本进程最近一次成功值; pm2 restart 后自然清空, 首请求失败即回空态）
  const lastGood = { utm: null, feedback: null, shortlink: null, v2ex: null, metrics: null };

  const emptyUtm = () => ({ by_date: {}, by_source: {}, by_medium: {}, by_campaign: {}, total: 0, today: 0, week: 0 });
  const emptyFb = () => ({ by_date: {}, by_page: {}, by_action: {}, total: 0, today: 0 });
  const emptySl = () => ({ total: 0, days: {}, by_path: {} });
  const emptyV2ex = () => ({ views_total: 0, replies_total: 0, replies: 0, topics_count: 0, baseline_views_total: 0, updated_at: "" });
  const emptyMetrics = () => ({ mrd_stars: 0, mrd_forks: 0, mrd_14d_uniques: 0, demo_24h_visitors: 0, juejin_reads: 0, devto_reactions: 0, mylauncher_stars: 0, mylauncher_forks: 0, updated_at: "" });

  /** SQLite 只读查询（node:sqlite, 防锁）: 缺失/损坏/查询失败一律 null, 绝不抛给上层 */
  function readSqlite(sql) {
    let db = null;
    try {
      if (!fs.existsSync(KNOCK_DB)) return null;
      db = new DatabaseSync(KNOCK_DB, { readOnly: true });
      return db.prepare(sql).all();
    } catch { return null; }
    finally { try { if (db) db.close(); } catch {} }
  }

  /** 最近 N 个 UTC+8 自然日（与 knock.db date 分桶一致; 与 bjToday 同偏移技巧, 勿用 toISOString 裸切） */
  function lastNDates(n) {
    const now = Date.now();
    const out = [];
    for (let i = 0; i < n; i++) out.push(new Date(now + 8 * 3600e3 - i * 86400e3).toISOString().slice(0, 10));
    return out;
  }

  /* ---------------- 源 1+2: knock.db（utm_visits / feedback_events） ---------------- */

  function loadUtmVisits() {
    const rows = readSqlite("SELECT date, source, medium, campaign, count FROM utm_visits");
    if (!rows) throw new Error("knock.db utm_visits unavailable");
    const byDate = {}, bySource = {}, byMedium = {}, byCampaign = {};
    let total = 0;
    for (const r of rows) {
      byDate[r.date] = (byDate[r.date] || 0) + r.count;
      if (r.source) bySource[r.source] = (bySource[r.source] || 0) + r.count;
      if (r.medium) byMedium[r.medium] = (byMedium[r.medium] || 0) + r.count;
      if (r.campaign) byCampaign[r.campaign] = (byCampaign[r.campaign] || 0) + r.count;
      total += r.count;
    }
    const today = bjToday();
    const weekDates = lastNDates(7);
    let week = 0;
    for (const d of weekDates) week += byDate[d] || 0;
    return { by_date: byDate, by_source: bySource, by_medium: byMedium, by_campaign: byCampaign, total, today: byDate[today] || 0, week };
  }

  function loadFeedbackEvents() {
    const rows = readSqlite("SELECT date, page, action, count FROM feedback_events");
    if (!rows) throw new Error("knock.db feedback_events unavailable");
    const byDate = {}, byPage = {}, byAction = {};
    let total = 0;
    for (const r of rows) {
      byDate[r.date] = (byDate[r.date] || 0) + r.count;
      if (r.page) byPage[r.page] = (byPage[r.page] || 0) + r.count;
      if (r.action) byAction[r.action] = (byAction[r.action] || 0) + r.count;
      total += r.count;
    }
    const today = bjToday();
    return { by_date: byDate, by_page: byPage, by_action: byAction, total, today: byDate[today] || 0 };
  }

  /* ---------------- 源 3: 短链 hits（www /api/go/hits ×4, 逐 path 独立成败） ---------------- */

  async function fetchShortlinkPath(p, pathGood) {
    const txt = await fetchText(SHORTLINK_BASE + encodeURIComponent(p));
    const j = JSON.parse(txt);
    if (!j || !j.ok || !j.data) throw new Error("bad hits response for " + p);
    const d = j.data;
    const days = d.days || {};
    let total = 0;
    for (const k in days) total += days[k];
    pathGood[p] = { days, total: d.total != null ? d.total : total };
    return { days, total: d.total != null ? d.total : total };
  }

  async function loadShortlink() {
    const last = lastGood.shortlink;
    const pathGood = {};
    let degraded = false;
    const settled = await Promise.allSettled(SHORTLINK_PATHS.map((p) => fetchShortlinkPath(p, pathGood)));
    settled.forEach((r, i) => {
      const p = SHORTLINK_PATHS[i];
      if (r.status === "fulfilled") return;
      degraded = true;
      const prev = last && last.by_path && last.by_path[p.replace("/go/", "")];
      pathGood[p] = prev ? { days: prev.days || {}, total: prev.total || 0 } : { days: {}, total: 0 };
    });
    // 聚合 days（跨 path 同日求和）
    const days = {};
    let total = 0;
    const byPath = {};
    for (const p of SHORTLINK_PATHS) {
      const e = pathGood[p];
      byPath[p.replace("/go/", "")] = e;
      total += e.total || 0;
      for (const d in e.days) days[d] = (days[d] || 0) + (e.days[d] || 0);
    }
    return { total, days, by_path: byPath, degraded };
  }

  /* ---------------- 源 4: V2EX 曝光（潘明固定路径 json） ---------------- */

  function loadV2ex() {
    const raw = fs.readFileSync(V2EX_TRACKING, "utf8");
    const j = JSON.parse(raw);
    const samples = j.samples || [];
    const last = samples[samples.length - 1];
    const topics = (j.baseline && j.baseline.topics) || [];
    let baselineViews = 0;
    for (const t of topics) baselineViews += t.baseline_views || 0;
    return {
      views_total: last ? (last.v2ex_views_total || 0) : 0,
      replies: last ? (last.v2ex_replies_total || 0) : 0,
      topics_count: topics.length,
      baseline_views_total: baselineViews,
      updated_at: (last && last.ts_iso) || j.updated_at || "",
    };
  }

  /* ---------------- 源 5: metrics（opc/status.json） ---------------- */

  function loadMetrics() {
    const raw = fs.readFileSync(STATUS_JSON, "utf8");
    const m = (JSON.parse(raw).metrics) || {};
    return {
      mrd_stars: m.mrd_stars ?? 0,
      mrd_forks: m.mrd_forks ?? 0,
      mrd_14d_uniques: m.mrd_14d_uniques ?? 0,
      demo_24h_visitors: m.demo_24h_visitors ?? 0,
      juejin_reads: m.juejin_reads ?? 0,
      devto_reactions: m.devto_reactions ?? 0,
      mylauncher_stars: m.mylauncher_stars ?? 0,
      mylauncher_forks: m.mylauncher_forks ?? 0,
      updated_at: m.updated_at || "",
    };
  }

  /* ---------------- 聚合: 四源 → 漏斗/数字卡/渠道条（绝不整卡抛错） ---------------- */

  async function handleAcquisition() {
    const degraded = [];

    // 1. utm_visits
    let utm;
    try { utm = loadUtmVisits(); lastGood.utm = utm; }
    catch { utm = lastGood.utm || emptyUtm(); degraded.push("utm_visits"); }

    // 2. feedback_events
    let fb;
    try { fb = loadFeedbackEvents(); lastGood.feedback = fb; }
    catch { fb = lastGood.feedback || emptyFb(); degraded.push("feedback_events"); }

    // 3. 短链 hits（async, 逐 path fallback）
    let sl;
    try {
      sl = await loadShortlink();
      if (sl.degraded) degraded.push("shortlink");
      lastGood.shortlink = { total: sl.total, days: sl.days, by_path: sl.by_path };
    } catch {
      sl = lastGood.shortlink ? { total: lastGood.shortlink.total, days: lastGood.shortlink.days, by_path: lastGood.shortlink.by_path } : emptySl();
      degraded.push("shortlink");
    }

    // 4. V2EX 曝光
    let v2ex;
    try { v2ex = loadV2ex(); lastGood.v2ex = v2ex; }
    catch { v2ex = lastGood.v2ex || emptyV2ex(); degraded.push("v2ex"); }

    // 5. metrics
    let metrics;
    try { metrics = loadMetrics(); lastGood.metrics = metrics; }
    catch { metrics = lastGood.metrics || emptyMetrics(); degraded.push("metrics"); }

    // 漏斗 4 层口径: 曝光(V2EX views) → 点击(utm total) → 落地(feedback open + demo 24h) → 意向(feedback submit + stars)
    const fbOpen = (fb.by_action && fb.by_action.open) || 0;
    const fbSubmit = (fb.by_action && fb.by_action.submit) || 0;
    const funnel = {
      exposure: v2ex.views_total,
      click: utm.total,
      landing: fbOpen + metrics.demo_24h_visitors,
      intent: fbSubmit + metrics.mrd_stars,
    };

    // 数字卡: 今日 UV / 7 日 UV / 短链总点击 / 反馈计数
    const kpis = {
      today_uv: utm.today,
      week_uv: utm.week,
      shortlink_total: sl.total,
      feedback_total: fb.total,
    };

    // 渠道对比条: 各渠道代表性引流数字（口径见文件头注释）
    const channels = [
      { name: "v2ex", v: (utm.by_source && utm.by_source.v2ex) || 0 },
      { name: "juejin", v: metrics.juejin_reads },
      { name: "devto", v: metrics.devto_reactions },
      { name: "shortlink", v: sl.total },
      { name: "github", v: metrics.mrd_stars },
    ];

    const data = {
      generated_at: new Date().toISOString(),
      funnel,
      kpis,
      channels,
      utm_visits: utm,
      feedback_events: fb,
      shortlink: { total: sl.total, days: sl.days, by_path: sl.by_path },
      v2ex,
      metrics,
    };
    if (degraded.length) {
      data.degraded_sources = degraded;
      data.__ttl = DEGRADED_TTL; // cached() 识别 __ttl 覆盖缓存周期 → 上游恢复后 5 分钟内自动重试
    }
    return data;
  }

  return { handleAcquisition, loadUtmVisits, loadFeedbackEvents, loadV2ex, loadMetrics };
};
