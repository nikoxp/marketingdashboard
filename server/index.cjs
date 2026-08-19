/**
 * 市场研究驾驶舱 — 数据代理与静态服务器
 * 聚合: 腾讯行情(A股/港股/美股/汇率) · 腾讯板块榜 · 新浪期货(金银铜油)
 *       新浪个股榜单 · 新浪资金流 · 新浪7x24快讯 · CNBC美债收益率
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { num, changeOf, pctOf, fmtHHMM, toMarketCode6 } = require("./lib/format.cjs");
const { parseCsvParam, chunked, safeRecord } = require("./lib/netutil.cjs");
const { bjToday, readHistory, writeHistory } = require("./lib/persist.cjs");
const { createCache } = require("./lib/cache.cjs");
const createFetchAny = require("./lib/fetch-any.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 运行观测(压测/运维): 仅聚合计数, 无敏感信息; /api/stats 读取
const stats = { reqs: 0, upstream: 0, blocked: 0, started: Date.now() };

// 统一上游数据通道(fetch/curl 双通道 + 状态码校验)与统一内存缓存(命名 TTL + 失败退避 + 负缓存)
const { fetchText, curlText, fetchTextAny, fetchWithFallback, UA } = createFetchAny({ onUpstream: () => stats.upstream++ });
const { cache, set: cacheSet, sweep: sweepCache, backoffOf, cached, quoteBackoff, entry, failEntry, TTLS } = createCache();
const qqRank = require("./lib/qq-rank.cjs")({ fetchText, num });

// 加载 .env(须先于数据源模块 require, 模块内读取 process.env 密钥)
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.trim().match(/^export\s+(.+?)=(.*)$/) || line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    console.log("[env] loaded", envPath);
  }
} catch (e) { console.error("[env] load error:", e.message); }

// 数据源适配器(依赖注入共享工具: 统一 fetch 通道 / 统一缓存)
const srcTencent = require("./sources/tencent.cjs")({
  fetchText, fetchTextAny, curlText, cache, cacheSet, parseCsvParam, chunked, safeRecord, num, changeOf, pctOf,
  entry, failEntry, quoteBackoff, TTLS, qqRank,
});
const { handleQuotes, handleMinute, handleBoards, handleBoardStocks } = srcTencent;

const srcFutures = require("./sources/futures.cjs")({
  fetchText, curlText, fetchWithFallback, num, changeOf, pctOf, fmtHHMM, safeRecord,
  cache, cacheSet, cached, entry, failEntry, quoteBackoff, TTLS,
});
const { handleFutures, handleFutureMinute, handleFutureDaily } = srcFutures;

const srcAi = require("./sources/ai.cjs")({
  cache, cacheSet, cached, entry, failEntry, quoteBackoff, TTLS,
});
const { handleMysterySelect } = srcAi;

const srcEastmoney = require("./sources/eastmoney.cjs")({
  fetchText, fetchWithFallback, cache, cacheSet, num, toMarketCode6,
  entry, failEntry, quoteBackoff, TTLS, qqRank,
});
const { handleRank, handleMoneyFlow, handleStockBoards, handleMoneyFlowEM, handleBoardMoneyFlow, handleStockFlows, handleBoardFlow, fetchSinaJson } = srcEastmoney;

const srcSina = require("./sources/sina.cjs")({
  fetchTextAny, fetchSinaJson, num, toMarketCode6,
  cache, cacheSet, cached, entry, failEntry, quoteBackoff, TTLS,
});
const { handleNews, handleStockSearch } = srcSina;

const srcEastmoneyFin = require("./sources/eastmoney-fin.cjs")({
  fetchTextAny, num, toMarketCode6,
  cache, cacheSet, cached, entry, failEntry, quoteBackoff, TTLS,
});
const { handleFinanceMain, handleFinanceBoard, handleFinanceForecast, validPeriod } = srcEastmoneyFin;

const srcTreasuries = require("./sources/treasuries.cjs")({ fetchTextAny, num, fs, path });
const { handleTreasuries, handleTreasuryHistory } = srcTreasuries;

const srcOpenRouter = require("./sources/openrouter.cjs")({ safeRecord, fs, path });
const { handleOpenRouterUsage } = srcOpenRouter;

const srcAiInfra = require("./sources/ai-infra.cjs")({ fetchText, fetchWithFallback, readHistory, writeHistory, bjToday, num, fs, path });
const { handleAiInfra } = srcAiInfra;

const srcSunsirs = require("./sources/sunsirs.cjs")({ fetchText, num, UA, readHistory, writeHistory, bjToday, path, fs });
const { handleSpotTable, handleChemSpot } = srcSunsirs;

const srcAiModels = require("./sources/ai-models.cjs")({ fetchText, num, readHistory, writeHistory, bjToday, path, fs });
const { handleAaModels, handleSpendIndex } = srcAiModels;

// 官网合作咨询（改版5）: 校验 + 落盘 contact.jsonl（不写 state.json）
const { validateContact, appendContact } = require("./lib/contact.cjs");

// 官网 AI 助理（0818-a P0）: 校验 + 意向判定 + LLM 回复 + 落盘 assistant-leads.jsonl
const {
  validateAssistant, detectIntent, summarizeNeed, callAssistantLLM, fallbackReply,
  appendAssistantLead, QUESTION_MAX,
} = require("./lib/assistant.cjs");

// 博客评论 + 阅读量（0818: Gavin 指令 blog 支持回复评论 + 统计阅读量, 方案: mrd 后端代理）
const {
  loadComments, saveComments, validateComment, isAdmin, addComment,
  makeCommentRateLimiter, loadViews, saveViews, recordView, viewsFor, vidKey,
} = require("./lib/blog.cjs");
const BLOG_COMMENTS_FILE = path.join(__dirname, "data", "blog-comments.json");
const BLOG_VIEWS_FILE = path.join(__dirname, "data", "blog-views.json");
// 评论频控: 同 vid(无 vid 则按 IP) 60 秒内限 1 条, 超限 429
const blogCommentLimiter = makeCommentRateLimiter(60 * 1000);

// 个股资金流上游 inflight 去重表(handleStockFlows 使用)
const flowInflight = new Map();

// 活跃访客窗口: ip -> 最近请求时间戳; /api/stats 暴露 activeIps5m / visitors24h
const activeIps = new Map(); // ip -> lastSeen(ms), 24h 内访问过的 IP 保留(个人站点量级, 内存有界)
const activeSweeper = setInterval(() => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [ip, last] of activeIps) if (last < cutoff) activeIps.delete(ip);
}, 5 * 60 * 1000);
activeSweeper.unref();
function trackActiveIp(ip) { activeIps.set(ip, Date.now()); }

/* ---------------- 官网访问统计（改版4）: 只计数不采集, UV 匿名去重 ----------------
 * 红线(Gavin): 不采集个人信息 —— 不做指纹、不存 cookie 值。
 * - PV = 页面请求次数(每次 GET /api/visits +1)
 * - UV = 去重访客数: 客户端生成随机匿名 id 存 localStorage 随 ?vid= 上报,
 *   服务端只存其 sha256 哈希用于去重; 无 vid(curl/无 JS 环境)时用 IP 哈希兜底。
 * - 持久化 server/data/visits.json, tmp+rename 原子写, 重启不丢。
 * - seen 保留 365 天内的哈希(老访客重访计为新访客, UV 累计不降), 防文件无限膨胀。
 */
const VISITS_FILE = path.join(__dirname, "data", "visits.json");
const VISITS_KEEP_MS = 365 * 24 * 3600 * 1000;
let visits = { pv: 0, uv: 0, seen: {} };
try {
  const raw = JSON.parse(fs.readFileSync(VISITS_FILE, "utf-8"));
  visits = { pv: raw.pv || 0, uv: raw.uv || 0, seen: raw.seen || {} };
} catch (e) { /* 首启无文件 */ }
function saveVisits() {
  const tmp = VISITS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(visits));
  fs.renameSync(tmp, VISITS_FILE); // 同目录 rename 原子替换, 防并发写坏
}
function visitKey(req, vid) {
  if (vid && /^[A-Za-z0-9_-]{8,64}$/.test(vid)) {
    return "v:" + crypto.createHash("sha256").update("vid:" + vid).digest("hex").slice(0, 32);
  }
  return "i:" + crypto.createHash("sha256").update("ip:" + clientIp(req)).digest("hex").slice(0, 32);
}
function handleVisits(req, vid) {
  const now = Date.now();
  visits.pv += 1;
  const key = visitKey(req, vid);
  if (!visits.seen[key]) {
    visits.seen[key] = now;
    visits.uv += 1;
    // 清理 365 天前的哈希, 防文件无限膨胀(UV 为累计值, 删除不影响已计数)
    for (const k of Object.keys(visits.seen)) {
      if (visits.seen[k] < now - VISITS_KEEP_MS) delete visits.seen[k];
    }
  } else {
    visits.seen[key] = now;
  }
  try { saveVisits(); } catch (e) { console.error("[visits] save error:", e.message); }
  return { pv: visits.pv, uv: visits.uv };
}

const PORT = process.env.PORT || 3000;
const DIST = path.join(__dirname, "..", "dist");

function send(res, code, obj, extra = {}) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  };
  // extra 中值为 null 的头表示显式移除; ACAO 不默认下发, 仅同源请求由 corsHeadersFor 反射
  for (const k of Object.keys(headers)) if (headers[k] == null) delete headers[k];
  res.writeHead(code, headers);
  res.end(body);
}

/* ---------------- TTL 缓存 + 并发合并(防上游限流) — cached() 在 lib/cache.cjs 统一实现 ---------------- */

const { handleChainParse } = require("./lib/chain-parse.cjs");

/* ---------------- GitHub stars 汇总配置（公司产品仓库白名单）----------------
   加产品仓库：只改 GITHUB_STARS_WHITELIST 数组，无需改代码 */
const GITHUB_STARS_OWNER = "theBigGavin";
const GITHUB_STARS_WHITELIST = ["marketingdashboard", "mylauncher"];

// OPC token 监控(Gavin 指令 2/4): 读上游 cron(每小时)产出的 token-stats.json, 供公司落地页 fetch
const TOKEN_STATS_PATH = "/home/gavin/.hermes/opc/token-stats.json";

/* ---------------- 主机路由表 ---------------- */
const routes = {
  "/api/quotes": async (q) => handleQuotes(q.get("codes") || ""), // 内部按代码独立缓存(TTL 5s)
  "/api/aa-models": async () => cached("aa-models", 24 * 3600 * 1000, () => handleAaModels()), // AA 全模型定价, 24h 缓存 + 每日快照落盘
  "/api/spend-index": async () => cached("spend-index", 6 * 3600 * 1000, () => handleSpendIndex()), // traktoken 支出指数(60天 + 事件)
  "/api/stats": async () => {
    const now = Date.now();
    const cutoff5m = now - 5 * 60 * 1000;
    const cutoff24h = now - 24 * 3600 * 1000;
    let active5m = 0, visitors24h = 0;
    for (const last of activeIps.values()) {
      if (last >= cutoff5m) active5m++;
      if (last >= cutoff24h) visitors24h++;
    }
    return {
      reqs: stats.reqs, upstream: stats.upstream, blocked: stats.blocked,
      uptimeSec: Math.round((now - stats.started) / 1000),
      activeIps5m: active5m, visitors24h,
    };
  },
  "/api/leads": async (_q, body) => {
    // Pro landing 预注册: 收集付费意向线索, 落盘到 data/leads.json
    const email = String(body?.email || "").trim().slice(0, 200);
    const need = String(body?.need || "").trim().slice(0, 500);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const e = new Error("invalid email"); e.status = 400; throw e;
    }
    const rec = { email, need, plan: String(body?.plan || "").slice(0, 50), ts: new Date().toISOString() };
    const file = path.join(__dirname, "data", "leads.json");
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(file, "utf-8")); } catch {}
    arr.push(rec);
    fs.writeFileSync(file, JSON.stringify(arr, null, 2));
    return { received: true, count: arr.length };
  },
  // ---- 官网访问统计（改版4）: 只计数不采集, 每次 GET 即记一次访问(PV+1), UV 按匿名 vid/IP 哈希去重 ----
  "/api/visits": async (q, _body, req) => handleVisits(req, q.get("vid") || ""),
  // ---- 博客评论（0818）: GET 拉取(post_id 过滤, 时间升序) / POST 发表(校验 + admin 判定 + 频控 + 原子落盘) ----
  "/api/blog/comments": async (q, body, req) => {
    if (req.method === "GET") {
      const post_id = String(q.get("post_id") || "").trim();
      if (!post_id || post_id.length > 64) {
        const e = new Error("invalid post_id"); e.status = 400; throw e;
      }
      const list = loadComments(BLOG_COMMENTS_FILE)
        .filter((c) => c.post_id === post_id)
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      return { comments: list };
    }
    const comments = loadComments(BLOG_COMMENTS_FILE);
    const v = validateComment(body, comments);
    if (!v.ok) { const e = new Error(v.error); e.status = 400; throw e; }
    const vid = vidKey(body && body.vid);
    const rateKey = vid || clientIp(req);
    if (!blogCommentLimiter(rateKey)) {
      const e = new Error("too many requests"); e.status = 429; throw e;
    }
    const rec = addComment(comments, v.value, isAdmin(body));
    try { saveComments(BLOG_COMMENTS_FILE, comments); }
    catch (e) { console.error("[blog-comments] save error:", e.message); }
    return { comment: rec };
  },
  // ---- 博客阅读量（0818）: POST 幂等计数(同 vid 每篇 365 天内 1 次) / GET 批量查询(列表页一次拉全) ----
  "/api/blog/views": async (q, body, req) => {
    if (req.method === "POST") {
      const post_id = String((body && body.post_id) || "").trim();
      if (!post_id || post_id.length > 64) {
        const e = new Error("invalid post_id"); e.status = 400; throw e;
      }
      const views = loadViews(BLOG_VIEWS_FILE);
      const vid = vidKey(body && body.vid);
      const key = vid || "ip:" + crypto.createHash("sha256").update("ip:" + clientIp(req)).digest("hex").slice(0, 32);
      const { count, added } = recordView(views, post_id, key);
      if (added) { try { saveViews(BLOG_VIEWS_FILE, views); } catch (e) { console.error("[blog-views] save error:", e.message); } }
      return { count };
    }
    const ids = String(q.get("post_ids") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
    return { views: viewsFor(loadViews(BLOG_VIEWS_FILE), ids) };
  },
  "/api/minute": async (q) =>
    cached(`minute:${q.get("code")}`, 5000, () => handleMinute(q.get("code") || "sh000001")),
  // 批量分钟线: 将 N 次单独请求合并为 1 次, 大幅降低冷启动爆发请求数
  "/api/batch-minute": async (q) => {
    const codes = parseCsvParam(q.get("codes") || "");
    if (codes.length === 0) return {};
    if (codes.length > 30) codes.length = 30; // 上限防滥用
    const map = {};
    // 逐个走缓存(每个 code 各自 5s TTL), 但共享一次 HTTP 往返
    await Promise.all(codes.map(async (c) => {
      try { map[c] = await cached(`minute:${c}`, 5000, () => handleMinute(c)); } catch (e) { map[c] = null; console.error("[batch-minute]", c, e?.message || e); }
    }));
    return map;
  },
  "/api/boards": async (q) =>
    cached(`boards:${q.get("type")}:${q.get("dir")}:${q.get("n")}`, 5000, () =>
      handleBoards(q.get("type") || "01", q.get("dir") || "0", q.get("n") || "30")
    ),
  "/api/board-stocks": async (q) =>
    cached(`bstocks:${q.get("code")}:${q.get("dir")}:${q.get("n")}`, 8000, () =>
      handleBoardStocks(q.get("code") || "", q.get("dir") || "down", q.get("n") || "10")
    ),
  "/api/futures": async (q) =>
    cached(`futures:${q.get("list")}`, 15000, () => handleFutures(q.get("list") || "hf_GC,hf_XAU,hf_SI,hf_CAD,hf_CL,hf_VX,nf_AU0,BTCUSDT")),
  "/api/future-daily": async (q) =>
    cached(`fdaily:${q.get("code")}:${q.get("n") || ""}`, 3600000, () =>
      handleFutureDaily(q.get("code") || "", Math.min(parseInt(q.get("n")) || 400, 5000))
    ), // 日线K线(默认近400根), 1h缓存
  "/api/spot-table": async () => cached("spot:table", 8 * 3600000, () => handleSpotTable()), // 生意社现期表, 8h缓存(每日16:30更新)
  "/api/chem-spot": async (q) =>
    cached(`chem:${q.get("id")}:${q.get("name") || ""}`, 8 * 3600000, () =>
      handleChemSpot(q.get("id") || "", q.get("name") || q.get("id") || "")), // 生意社化工现货, 8h缓存
  "/api/future-minute": async (q) =>
    cached(`fmin:${q.get("code")}`, 60000, () => handleFutureMinute(q.get("code") || "")),
  // 批量期货分钟线
  "/api/batch-fmin": async (q) => {
    const codes = parseCsvParam(q.get("codes") || "");
    if (codes.length === 0) return {};
    if (codes.length > 20) codes.length = 20;
    const map = {};
    await Promise.all(codes.map(async (c) => {
      try { map[c] = await cached(`fmin:${c}`, 60000, () => handleFutureMinute(c)); } catch (e) { map[c] = null; console.error("[batch-fmin]", c, e?.message || e); }
    }));
    return map;
  },
  "/api/rank": async (q) =>
    cached(`rank:${q.get("sort")}:${q.get("asc")}:${q.get("n")}`, 5000, () =>
      handleRank(q.get("sort") || "changepercent", q.get("asc") || "0", q.get("n") || "30")
    ),
  "/api/moneyflow": async (q) =>
    cached(`mf:${q.get("n")}`, 8000, () =>
      // 东财主源, 失败回退新浪
      handleMoneyFlowEM(q.get("n") || "20").then((rows) => {
        if (rows.length) return rows;
        return handleMoneyFlow(q.get("n") || "20");
      }).catch(() => handleMoneyFlow(q.get("n") || "20"))
    ),
  // 板块成分股主力净流入排行(东财 clist, fs=b:板块代码, f62 降序) — 板块资金流向→主力排行联动
  "/api/board-moneyflow": async (q) =>
    cached(`bmf:${q.get("code")}:${q.get("n")}`, 8000, () =>
      handleBoardMoneyFlow(q.get("code") || "", q.get("n") || "15")
    ),
  "/api/stock-flow": async (q) =>
    handleStockFlows(q.get("code") || "", flowInflight).then((rows) => rows[0] || Promise.reject(new Error("empty stock-flow"))),
  "/api/stock-flows": async (q) => handleStockFlows(q.get("codes") || "", flowInflight),
  "/api/board-flow": async (q) => cached(`bf:${q.get("n")}`, 120000, () => handleBoardFlow(q.get("n") || "20")),
  "/api/stock-boards": async (q) =>
    cached(`sb:${q.get("code")}`, 24 * 3600 * 1000, () => handleStockBoards(q.get("code") || "")),
  "/api/news": async (q) =>
    cached(`news:${q.get("page")}:${q.get("size")}`, 8000, () =>
      handleNews(q.get("page") || "1", q.get("size") || "40")
    ),
  "/api/treasuries": async () => cached("treasuries", 30000, () => handleTreasuries()),
  "/api/finance-main": async (q) =>
    cached(`fin-main:${q.get("code")}`, 3600000, () => handleFinanceMain(q.get("code") || "")), // 单公司近12期主指标, 1h缓存
  "/api/finance-board": async (q) => {
    const p = validPeriod(q.get("period"));
    return cached(`fin-board:${p}`, 3600000, () => handleFinanceBoard(p)); // 盈利榜+行业聚合+披露日历, 1h缓存
  },
  "/api/finance-forecast": async (q) => {
    const p = validPeriod(q.get("period"));
    return cached(`fin-forecast:${p}`, 3600000, () => handleFinanceForecast(p)); // 业绩预告, 1h缓存
  },
  "/api/treasury-history": async () => cached("treasury-history", 6 * 3600 * 1000, () => handleTreasuryHistory()),
  "/api/health": async () => ({ status: "up", ts: Date.now(), cache: cache.size }),
  "/api/repo-stats": async () =>
    cached("repo-stats", 3600000, async () => {
      // GitHub repo 元数据(star/forks), 1h 缓存防限流; 失败返回 0 不阻断页面
      try {
        const txt = await fetchText("https://api.github.com/repos/theBigGavin/marketingdashboard", {
          headers: { Accept: "application/vnd.github+json", "User-Agent": UA },
        });
        const d = JSON.parse(txt);
        return { stars: d.stargazers_count ?? 0, forks: d.forks_count ?? 0, ts: Date.now() };
      } catch (e) {
        return { stars: 0, forks: 0, ts: Date.now() };
      }
    }),
  "/api/github/stars": async () =>
    cached("github-stars", 3600000, async () => {
      // 公司产品仓库 star 汇总: users/{owner}/repos 一次拉全, 过滤 fork + 白名单后求和。
      // 1h 缓存防 GitHub 匿名限流(60/h/IP), 限流由服务端单点吸收; 失败时 cached() 降级返回上次成功值
      const txt = await fetchText(
        `https://api.github.com/users/${GITHUB_STARS_OWNER}/repos?per_page=100&type=owner`,
        { headers: { Accept: "application/vnd.github+json", "User-Agent": UA } }
      );
      const repos = JSON.parse(txt);
      const picked = (Array.isArray(repos) ? repos : [])
        .filter((r) => !r.fork && GITHUB_STARS_WHITELIST.includes(r.name))
        .map((r) => ({ name: r.name, stars: r.stargazers_count ?? 0 }));
      return { total: picked.reduce((s, r) => s + r.stars, 0), repos: picked, ts: Date.now() };
    }),
  "/api/openrouter-usage": async () => cached("or-usage", 3600000, () => handleOpenRouterUsage()), // 1h cache
  // OPC token 监控: 透传 token-stats.json(上游小时级刷新, 60s 缓存足够); 文件缺失/坏 JSON 抛可预期错误(外层回显 ok:false), 绝不伪造数字
  "/api/token-stats": async () =>
    cached("token-stats", 60000, async () => {
      let raw;
      try {
        raw = fs.readFileSync(TOKEN_STATS_PATH, "utf8");
      } catch {
        const e = new Error("token-stats 数据未就绪");
        e.status = 503;
        throw e;
      }
      try {
        return JSON.parse(raw);
      } catch {
        const e = new Error("token-stats 数据未就绪");
        e.status = 503;
        throw e;
      }
    }),
  "/api/ai-infra": async () => cached("ai-infra", 24 * 3600 * 1000, () => handleAiInfra()), // 财报/定价日更, 24h 缓存
  "/api/mystery-select": async (q) =>
    cached(`ms:${q.get("query")}:${q.get("limit")}:${q.get("page")}`, 60000, () =>
      handleMysterySelect(q.get("query") || "", q.get("limit") || "30", q.get("page") || "1")
    ),
  "/api/stock-search": async (q) =>
    cached(`ssearch:${q.get("q")}`, 5000, () => handleStockSearch(q.get("q") || "")), // 前端击键触发, 短缓存防新浪WAF
  "/api/chain-parse": async (_q, body) => handleChainParse(body || {}),
  // ---- 官网合作咨询（改版5）: 校验 + 同 IP 限频 + 落盘 contact.jsonl（不写 state.json）----
  "/api/contact": async (_q, body, req) => {
    const v = validateContact(body);
    if (!v.ok) { const e = new Error(v.error); e.status = 400; throw e; }
    const ip = clientIp(req);
    // 防 spam: 同 IP 1 小时 ≤3 条（先于落盘判断, 超限直接 429）
    if (!contactLimiter(ip)) { const e = new Error("contact rate limited"); e.status = 429; throw e; }
    const rec = { ts: new Date().toISOString(), ip, ...v.value };
    appendContact(CONTACT_DATA_DIR, rec);
    return { received: true, ts: rec.ts };
  },
  // ---- 官网 AI 助理（0818-a P0）: 校验 + 同 IP 限频 + LLM 回复 + 意向命中落盘 ----
  // 访客提交问题/意向 → AI 基于公司知识库回复（话术红线: 托管版只讲「筹备中」不报价不承诺）
  // → INTENT_KEYWORDS 命中 → 落盘 assistant-leads.jsonl → cron 登记 state.json leads[] → 转温雯。
  // 红线: 邮箱以外的个人信息不落盘（只存 email，不存姓名/电话）。
  "/api/assistant": async (_q, body, req) => {
    const v = validateAssistant(body);
    if (!v.ok) { const e = new Error(v.error); e.status = 400; throw e; }
    const ip = clientIp(req);
    // 0819-c P1-1 托管模式分支: 请求带有效 Bearer token → 解析 tenant → 按租户独立额度扣减
    // (consume 在 LLM 调用前扣, 防烧钱; LLM 失败不退还, 从简)。额度耗尽 → 429 中性文案。
    // 无 token 或非托管模式 → 现有 IP 限流照旧(开源行为零回归)。
    let tenantId = null;
    if (hostingQuotaApi) {
      const token = hostingQuotaApi.bearerToken(req);
      if (token) {
        tenantId = hostingQuotaApi.resolveToken(hostingDb, token);
        // 托管模式带 token 但无效/过期 → 401(不回落 IP 限流, 防伪造 token 刷额度)
        if (!tenantId) { const e = new Error("请先登录"); e.status = 401; throw e; }
        const quota = hostingQuotaApi.consumeAiQuota(hostingDb, tenantId);
        if (quota.remaining <= 0) { const e = new Error("今日 AI 额度已用完，明天再来"); e.status = 429; throw e; }
      }
    }
    // 防烧 token/防刷: 同 IP 3 条/5 分钟(先于 LLM 调用, 超限直接 429); 托管扣减分支跳过(租户额度即限流)
    if (!tenantId && !assistantLimiter(ip)) { const e = new Error("assistant rate limited"); e.status = 429; throw e; }
    const { question, contact, source } = v.value;
    const reply = (await callAssistantLLM(question)) || fallbackReply();
    const hits = detectIntent(question);
    let lead_id = null;
    if (hits.length > 0) {
      // 意向命中 → 落盘（供 cron 登记 leads[] + 转温雯; 不写 state.json, 与 contact 同策略）
      // 0819-z 决议第 7 项: 结构化字段随线索落盘 —— intent_hits(意向关键词数组) + need_detail(需求详情摘要)
      const rec = {
        ts: new Date().toISOString(),
        ip,
        question,
        contact, // 仅邮箱（红线: 邮箱以外不落盘）
        intent_hits: hits,
        need_detail: summarizeNeed(question),
        reply,
        registered: false,
      };
      if (source) rec.source = source; // 0818-aa: demo 报告页 CTA 来源（如 demo_report），官网提交不带 source 行为不变
      const saved = appendAssistantLead(ASSISTANT_DATA_DIR, rec);
      lead_id = `${saved.ts}_${String(ip).replace(/[^0-9a-f.]/gi, "_").slice(0, 40)}`;
    }
    return { reply, intent_hit: hits.length > 0, intent_keywords: hits, lead_id };
  },
  // ---- OPC 透明办公室 demo 体验（12a）----
  "/api/opc/demo": async (_q, body, req) => {
    // a) 白名单校验: 只认 4 个预设 id, 其他字段一律忽略（防 prompt 注入/防外人驱动 agent）
    const taskId = String(body?.task_id || "").trim();
    if (!DEMO_TASKS[taskId]) { const e = new Error("unknown demo task"); e.status = 400; throw e; }
    const ip = clientIp(req);
    // b) 限流: 同 IP 1 次/60s（先于去重, 快速连点直接 429; 防刷/防烧钱）
    if (!demoLimiter(ip)) { const e = new Error("demo rate limited"); e.status = 429; throw e; }
    const s = demoReadStatus();
    // c) 去重: 同 IP 同任务有缓存(completed)/在飞 → 直接返回现有状态; failed 允许重试
    //    注意: tasks 的 value 不含 demo_id, 必须从 key 取(旧版用 existing.demo_id 恒为 undefined,
    //    JSON 序列化丢弃 → 前端拿不到 demo_id → 误报「体验服务暂不可用」, 12c 实测发现并修复)
    const existing = Object.entries(s.tasks).find(([, t]) => t.ip === ip && t.task_id === taskId);
    if (existing && existing[1].status !== "failed") {
      return { demo_id: existing[0], status: existing[1].status, task_id: existing[1].task_id, cached: true };
    }
    // d) 全局并发上限: 在飞(queued/dispatched/running) ≤ DEMO_MAX_INFLIGHT
    const inflight = Object.values(s.tasks)
      .filter((t) => ["queued", "dispatched", "running"].includes(t.status)).length;
    if (inflight >= DEMO_MAX_INFLIGHT) { const e = new Error("demo busy"); e.status = 429; throw e; }
    // e) 写请求文件(派活 cron 扫描) + 更新 status.json → 返回 demo_id
    const demoId = "d" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
    const now = new Date().toISOString();
    fs.mkdirSync(DEMO_REQ_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEMO_REQ_DIR, `${demoId}.json`),
      JSON.stringify({ demo_id: demoId, task_id: taskId, ip, ts: now }, null, 2));
    s.tasks[demoId] = {
      task_id: taskId, ip, status: "queued",
      created_at: now, started_at: null, finished_at: null, kanban_task_id: null,
    };
    demoWriteStatus(s);
    spawnDispatchScript(); // 派活提速: 写请求文件成功后立即 spawn dispatch, 不等 1 分钟 cron(失败静默, cron 兜底)
    return { demo_id: demoId, status: "queued", task_id: taskId };
  },
  "/api/opc/demo/status": async (q) => {
    const id = String(q.get("demo_id") || "").trim();
    if (!id) { const e = new Error("demo_id required"); e.status = 400; throw e; }
    const v = demoTaskView(demoReadStatus(), id);
    if (!v) { const e = new Error("demo not found"); e.status = 404; throw e; }
    return v;
  },
  "/api/opc/demo/history": async () => {
    const s = demoReadStatus();
    // history 由状态迁移写入; 空则从 tasks 派生终态条目兜底
    let items = (s.history || []).slice(0, DEMO_HISTORY_MAX);
    if (!items.length) {
      items = Object.entries(s.tasks)
        .filter(([, t]) => ["completed", "failed"].includes(t.status))
        .map(([id, t]) => ({
          demo_id: id, task_id: t.task_id, status: t.status,
          // created_at 兜底（缺省回退 started_at/finished_at），保证每条可排序
          created_at: demoTaskCreatedAt(t), finished_at: t.finished_at || null,
        }))
        // 排序健壮性: 先归一化再比较, 杜绝 undefined 参与 localeCompare 异常(曾致无时间记录恒置顶)
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
        .slice(0, DEMO_HISTORY_MAX);
    }
    return { items, count: items.length };
  },
  // gz_weather 国内天气数据代理（12d）: 服务端持上游(中国天气网/中国气象局), agent 只经此端点取数
  "/api/opc/demo/weather/gz": async () =>
    cached("gz-weather", GZ_WEATHER_TTL_MS, () => handleGzWeather()),
};

// ---- 托管版托管层（HOSTING=1 启用）: 单实例多租户账号系统, 只增不改核心路由 ----
// 复用本文件数据管道/共享缓存(公开行情只读共享); 新增 /api/hosting/* 账号路由
// (SQLite users 表, 邮箱+密码, Bearer token; watchlist 等个性化数据按租户隔离)。
// 开源版(HOSTING 未设置)完全不加载, 行为与以往逐字节一致。
// 0819-c P1-1: hostingDb/hostingQuotaApi 供 /api/assistant 托管化扣减复用同一连接(见下方路由)。
let hostingDb = null;      // HOSTING=1 时的托管 SQLite 连接(assistant 配额扣减用)
let hostingQuotaApi = null; // { bearerToken, resolveToken, consumeAiQuota } — 开源模式保持 null
if (process.env.HOSTING === "1") {
  try {
    const { initHosting } = require("./hosting/index.cjs");
    const hosting = initHosting();
    Object.assign(routes, hosting.routes);
    hostingDb = hosting.db;
    // 配额扣减只依赖托管层导出的纯函数(与路由表解耦); 拆库后文件由 start_hosting.sh 注入
    hostingQuotaApi = {
      bearerToken: require("./hosting/routes.cjs").bearerToken,
      resolveToken: require("./hosting/db.cjs").resolveToken,
      consumeAiQuota: require("./hosting/db.cjs").consumeAiQuota,
    };
  } catch (e) {
    // 拆库后(2026-08-18): 托管层由私有仓库 mrd-pro 经 start_hosting.sh 注入部署。
    // 托管模式(HOSTING=1)下加载失败 = 账号墙缺失 → 裸开源实例暴露在托管域名(host.hermes.cc.cd)
    // 是安全隐患(任何访客绕过登录墙直达看板) → 拒绝启动。
    console.error("[hosting] 托管层加载失败(HOSTING=1, 拒绝启动防裸奔):", e?.stack || e?.message || e);
    process.exit(1);
  }
}

// ---- 手速排行榜迁移(0819-i): 已迁独立进程 server/knock-standalone.cjs(:3032, 公网入口
// https://hermes.cc.cd/api/v1/knock, cloudflared ingress)。此处不再挂载 initKnock,
// 避免双进程写同一 SQLite(server/data/knock.db); 旧路径改由下方请求处理器 302 重定向到新域。

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
};

// 静态资源安全头; CSP 仅随 HTML 下发(脚本均为构建产物, 内联 style 属性需 unsafe-inline)
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https:", // 浏览器直连兜底源(qt.gtimg.cn / wscn / binance 等)
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join("; ");

// 公司落地页专用 CSP: 独立静态页, 允许内联脚本(主题切换)与外部图(shields.io star badge)
const COMPANY_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "base-uri 'self'",
].join("; ");

const STATIC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
};

/* ---------------- 同源校验与 CORS(经 CF Tunnel 公网可达, 默认不授权任何跨源浏览器读取) ---------------- */
const PROTECTED_ROUTES = new Set(["/api/mystery-select", "/api/openrouter-usage"]);

// 环回地址互认: 开发期 vite 代理(:3000→:3001)跨端口转发, Origin/Host 端口必然不同, 视为同源
const isLoopbackHost = (h) => /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(:\d+)?$/.test(h);

// 带 Origin/Referer 时其 host 必须与请求 Host 一致(或同为环回); 都不带(curl/同源导航)则放行
function isSameOrigin(req) {
  const host = req.headers.host;
  if (!host) return true;
  for (const h of [req.headers.origin, req.headers.referer]) {
    if (!h) continue;
    try {
      const oh = new URL(h).host;
      if (oh !== host && !(isLoopbackHost(oh) && isLoopbackHost(host))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// 全端点统一: 仅同源(或环回开发)浏览器请求反射 Origin, 跨源一律不下发 ACAO
function corsHeadersFor(req) {
  const origin = req.headers.origin;
  return { "Access-Control-Allow-Origin": origin && isSameOrigin(req) ? origin : null };
}

// OPC 透明办公室/demo API 跨源白名单(12c): 仅 www.hermes.cc.cd(CF Pages 静态站, 无后端)允许跨源
// 读写 demo 链路; 其余跨源 origin 一律不下发 ACAO(维持"默认不授权任何跨源浏览器读取"基线)
const OPC_CORS_ORIGINS = new Set(["https://www.hermes.cc.cd"]);

// /api/opc/* 专用: 同源(或环回开发)反射 Origin; 跨源仅白名单放行; 其余不下发
function opcCorsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return { "Access-Control-Allow-Origin": null };
  if (isSameOrigin(req) || OPC_CORS_ORIGINS.has(origin)) {
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  return { "Access-Control-Allow-Origin": null };
}

/* ---------------- 按客户端 IP 限流(CF Tunnel 后真实 IP 取 CF-Connecting-IP 头) ---------------- */
// 仅当连接来自可信代理(Cloudflare 边缘网段或本机环回)时采信代理头, 否则用 socket 地址,
// 防止绕过 Tunnel 直连时伪造 cf-connecting-ip/x-forwarded-for 刷穿限流
const CF_EDGE_RANGES = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];
function ipInRanges(ip, ranges) {
  if (!ip || ip.includes(":")) return false; // 仅支持 IPv4 网段匹配
  const n = (s) => s.split(".").reduce((a, b) => (a << 8) + +b, 0) >>> 0;
  const addr = n(ip);
  return ranges.some((r) => {
    const [base, bits] = r.split("/");
    const mask = bits === "0" ? 0 : (~0 << (32 - +bits)) >>> 0;
    return (addr & mask) === (n(base) & mask);
  });
}
function clientIp(req) {
  const peer = req.socket.remoteAddress || "unknown";
  const trusted = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1" || ipInRanges(peer, CF_EDGE_RANGES);
  if (trusted) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.trim()) return cf.trim();
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  }
  return peer;
}

// 滑动窗口计数器: 记录最近 windowMs 内的请求时间戳, 超 max 返回 false。
// 相比固定窗口(首请求起计), 滑动窗口在连续轮询场景下更公平, 不会因窗口边界触发误限。
function makeLimiter(windowMs, max) {
  const hits = new Map(); // ip -> number[] (请求时间戳)
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, ts] of hits) {
      const idx = ts.findIndex((t) => t >= cutoff);
      if (idx > 0) hits.set(ip, ts.slice(idx));
      else if (idx === -1) hits.delete(ip);
    }
  }, Math.min(windowMs, 30000));
  sweeper.unref();
  return (ip) => {
    const now = Date.now();
    const cutoff = now - windowMs;
    let ts = hits.get(ip);
    if (!ts) { hits.set(ip, [now]); return true; }
    // 剔除过期时间戳
    const idx = ts.findIndex((t) => t >= cutoff);
    if (idx > 0) ts = ts.slice(idx);
    else if (idx === -1) { hits.set(ip, [now]); return true; }
    ts.push(now);
    hits.set(ip, ts);
    return ts.length <= max;
  };
}

// 公开 /api: 每 IP 每分钟 2400 次(40/s)。单个客户端轮询 ~0.5 req/s, 40/s 覆盖 ~80 个用户共享的
// 办公室 NAT 出口 IP; 上游安全由 TTL 缓存 + 失败退避保证, 限流只兜恶意突发
const apiLimiter = makeLimiter(60 * 1000, 2400);
const protectedLimiter = makeLimiter(60 * 1000, 30); // 私有 key 端点: 每 IP 每分钟 30 次, 防脚本刷配额

/* ---------------- SSE 公共设施（12a demo 流 + 15a 全局状态流共用） ----------------
 * Gavin 明确要求: 避免两套 SSE 端点/两套订阅逻辑。所有 SSE 端点统一走以下三件套:
 *   setSSEHeaders(res, extra) — 统一响应头(禁缓存 + 防 Nginx/Cloudflare 缓冲)
 *   sendEvent(res, event, data) — 写 event:/data: 帧(帧格式逐字节一致; 两流统一 event: status)
 *   sseHeartbeat(res, ms)      — 保活注释帧定时器(: ping, 浏览器忽略), 返回 timer 供断连清理
 */
function setSSEHeaders(res, extra = {}) {
  const headers = {
    "Content-Type": "text/event-stream; charset=utf-8",
    // no-cache + no-transform: 禁止任何缓存层缓存, 并禁止代理改写(压缩/转码会破坏流)
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // 防 Nginx/Cloudflare 边缘缓冲
    ...extra,
  };
  res.writeHead(200, headers);
}
function sendEvent(res, event, data) {
  // SSE 帧: `event: <name>\ndata: <json>\n\n` —— demo 流与全局流共用, 契约逐字节一致
  try { res.write(`event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`); } catch {}
}
function sseHeartbeat(res, ms) {
  // 保活: 注释帧防 Cloudflare/反向代理空闲超时断连(CF ~100s), 25~30s 一帧
  return setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, ms);
}

/* ---------------- OPC 全局状态流（15a: 办公室实时状态推送, 持续不关闭） ----------------
 * GET /api/opc/stream — 语义与 demo 流(任务生命周期, 终态后关闭)不同: 办公室状态没有终态,
 * 连接建立推当前全量快照 → 生产 status.json 变更秒级推送 → 心跳保活, 客户端主动断才结束。
 * 事件事实源: dist/company/opc/status.json —— 生产静态目录(mrd 静态服务实际读的就是这份;
 * opc_collect.py 双写 public/ 种子 + dist/ 实时, public/ 仅 npm run build 时被拷贝, 运行时不读)。
 */
const OPC_STATUS_FILE = path.join(DIST, "company", "opc", "status.json");
const OPC_STREAM_MAX_CLIENTS = 50;            // 并发上限: 超限新连接直接 503(防滥用), 可调
const OPC_STREAM_DEBOUNCE_MS = 200;           // fs.watch 防抖: 写是整文件覆盖(open 'w' 截断+写), 立即读可能读到半截
const OPC_STREAM_FALLBACK_POLL_MS = 30 * 1000; // 兜底轮询周期(非主路径, 见 opcStreamStartWatcher)
const OPC_STREAM_HEARTBEAT_MS = 27 * 1000;    // 保活心跳(25~30s 区间取 27s, 防 CF ~100s 空闲超时)

const opcStreamClients = new Set();  // 全局流客户端集合: {res, hb} — hb 心跳定时器随断连清理
let opcStreamWatcher = null;         // fs.watch 句柄(无客户端时关闭, 首连懒启动)
let opcStreamFallbackTimer = null;   // 兜底轮询定时器(同上)
let opcStreamDebounceTimer = null;   // fs.watch 事件防抖定时器
let opcStreamLastMtime = 0;          // 兜底轮询 mtime 对比基准

// 读当前 status.json 全量快照; 失败(半截/不存在)返回 null, 调用方跳过, 绝不 crash
function opcStreamReadSnapshot() {
  try { return JSON.parse(fs.readFileSync(OPC_STATUS_FILE, "utf-8")); } catch { return null; }
}
// 广播当前全量快照给所有全局流客户端
function opcStreamBroadcast() {
  const snap = opcStreamReadSnapshot();
  if (snap == null) return; // 写窗口半截/暂缺: 跳过, 等下一次 change
  for (const c of opcStreamClients) sendEvent(c.res, "status", snap);
}
// 懒启动 watcher(首个客户端连接时): fs.watch 主路径 + 30s mtime 轮询兜底。
// 兜底说明: fs.watch 在部分平台/文件系统(网络盘/容器/编辑器原子替换)不可靠可能丢事件,
// 轮询每 30s 对比 mtimeMs, 变了才推——这是保险, 非主路径。
function opcStreamStartWatcher() {
  if (opcStreamWatcher || opcStreamFallbackTimer) return;
  try { opcStreamLastMtime = fs.statSync(OPC_STATUS_FILE).mtimeMs; } catch { opcStreamLastMtime = 0; }
  try {
    opcStreamWatcher = fs.watch(OPC_STATUS_FILE, { persistent: false }, () => {
      if (opcStreamDebounceTimer) clearTimeout(opcStreamDebounceTimer);
      opcStreamDebounceTimer = setTimeout(() => { opcStreamDebounceTimer = null; opcStreamBroadcast(); }, OPC_STREAM_DEBOUNCE_MS);
    });
  } catch (e) {
    console.error("[opc-stream] fs.watch unavailable, falling back to 30s poll:", e.message);
    opcStreamWatcher = null;
  }
  opcStreamFallbackTimer = setInterval(() => {
    let mtime = 0;
    try { mtime = fs.statSync(OPC_STATUS_FILE).mtimeMs; } catch { return; }
    if (mtime !== opcStreamLastMtime) { opcStreamLastMtime = mtime; opcStreamBroadcast(); }
  }, OPC_STREAM_FALLBACK_POLL_MS);
  opcStreamFallbackTimer.unref();
  demoStreamStartWatcher(); // demo/status.json 同生命周期: 有客户端才盯, 无客户端即关
}
function opcStreamStopWatcher() {
  if (opcStreamWatcher) { try { opcStreamWatcher.close(); } catch {} opcStreamWatcher = null; }
  if (opcStreamFallbackTimer) { clearInterval(opcStreamFallbackTimer); opcStreamFallbackTimer = null; }
  if (opcStreamDebounceTimer) { clearTimeout(opcStreamDebounceTimer); opcStreamDebounceTimer = null; }
  demoStreamStopWatcher();
}

/* ---------------- OPC 透明办公室 demo 体验（12a: 后端引擎） ----------------
 * 访客在 /company/opc/ 点预设按钮 → 服务端白名单校验 → 写请求文件 → 庄子派活 cron
 * (opc_demo_dispatch.py) 在 demo board 建卡 → 潘明执行 → 报告回传 results/<demo_id>.md。
 * 安全设计（Gavin 拍板，硬约束）:
 *   1. 只允许 4 个预设按钮, 服务端白名单校验, 访客文本一律忽略(防 prompt 注入/防外人驱动 agent 干任意事)
 *   2. 防刷/限流: 同 IP 频控 + 全局并发上限(在飞 ≤2) + 同 IP 同任务去重(有缓存/在飞直接返回现有状态)
 *   3. 任务隔离: demo 用独立 board(boards/demo/kanban.db) + priority=0, 排在正式任务后
 *   4. 报告缓存 + 回看(history)
 *   5. 数据隔离: demo 任务只查外部公开信息, 禁止读内部文件/凭据(约束写进任务 body)
 *   6. 进展实时性: SSE 端点 /api/opc/demo/{id}/stream 推送状态变化(唯一秒级实时性场景, 不走轮询;
 *      普通看板前端轮询 10s 即可——status.json 分钟级变化, 10s 已追平)
 */
const DEMO_TASKS = {
  v2ex_hot:         { name: "V2EX 热帖",   prompt: "帮我收集一下 v2ex 十个热帖（标题+链接+热度）" },
  gz_weather:       { name: "广州天气",     prompt: "帮我查一下广州未来 15 天的天气。请使用国内天气数据源（中国天气网/中国气象局数据）：通过服务端天气代理接口获取数据（GET http://localhost:3000/api/opc/demo/weather/gz，本机服务；如不可用可尝试公网 https://mrd.hermes.cc.cd/api/opc/demo/weather/gz），该接口返回广州未来 15 天预报 JSON（含 data_source/fetched_at/days）。报告中必须标注「数据来源：中国天气网（中国气象局）」和抓取时间。" },
  gz_trip:          { name: "广州周边旅行", prompt: "给我一个广州周边旅行的计划（2-3 天行程）。行程涉及天气，请使用国内天气数据源（中国天气网/中国气象局数据）：通过服务端天气代理接口获取数据（GET http://localhost:3000/api/opc/demo/weather/gz，本机服务；如不可用可尝试公网 https://mrd.hermes.cc.cd/api/opc/demo/weather/gz），报告中必须标注「数据来源：中国天气网（中国气象局）」和抓取时间。" },
  niulai_boxoffice: { name: "牛来票房",     prompt: "帮我看看《牛来》这个电影的实时票房" },
};
const DEMO_DIR = path.join(__dirname, "data", "demo");
const DEMO_REQ_DIR = path.join(DEMO_DIR, "requests");
const DEMO_RES_DIR = path.join(DEMO_DIR, "results");
const DEMO_STATUS_FILE = path.join(DEMO_DIR, "status.json");
const DEMO_RATE_WINDOW_MS = 60 * 1000;   // 同 IP 频控窗口: 1 次/60s（防烧钱/防刷，可调）
const DEMO_RATE_MAX = 1;                 // 同 IP 频控上限
const DEMO_MAX_INFLIGHT = 2;             // 全局并发上限: 在飞(queued/dispatched/running) ≤2
const DEMO_HISTORY_MAX = 30;             // 回看入口最多 30 条（23 修复: 20→30, 让时间正确的历史遗留条目如 dflocktest 不被截断在列表外）
const DEMO_SSE_POLL_MS = 2000;           // SSE 内部状态轮询间隔（状态分钟级变化，2s 追平足够）
const DEMO_SSE_MAX_MS = 15 * 60 * 1000;  // SSE 连接硬上限 15 分钟，防资源泄漏
const demoLimiter = makeLimiter(DEMO_RATE_WINDOW_MS, DEMO_RATE_MAX);

// 官网合作咨询（改版5）: 落盘目录 + 同 IP 1 小时 ≤3 条限频
const CONTACT_DATA_DIR = path.join(__dirname, "data");
const CONTACT_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 小时窗口
const CONTACT_RATE_MAX = 3;                    // 同 IP 最多 3 条/小时
const contactLimiter = makeLimiter(CONTACT_RATE_WINDOW_MS, CONTACT_RATE_MAX);

// 官网 AI 助理（0818-a P0）: 落盘目录 + 同 IP 3 条/5 分钟限频（防烧 token/防刷）
const ASSISTANT_DATA_DIR = path.join(__dirname, "data");
const ASSISTANT_RATE_WINDOW_MS = 5 * 60 * 1000; // 5 分钟窗口
const ASSISTANT_RATE_MAX = 3;                   // 同 IP 最多 3 条/5 分钟
const assistantLimiter = makeLimiter(ASSISTANT_RATE_WINDOW_MS, ASSISTANT_RATE_MAX);

// 启动时把预设表同步成 presets.json（供 opc_demo_dispatch.py 读取，单一事实源；服务端仍是硬编码白名单）
try {
  fs.mkdirSync(DEMO_DIR, { recursive: true });
  fs.writeFileSync(path.join(DEMO_DIR, "presets.json"), JSON.stringify(DEMO_TASKS, null, 2));
} catch (e) { console.error("[demo] presets.json sync error:", e.message); }

/* ---------------- gz_weather 数据源整改（12d）: 国内 API 天气代理 ----------------
 * Gavin 拍板: demo「广州天气」弃用国际 API(Open-Meteo 对中国城市数据不准), 改国内数据源。
 * 首选和风天气 QWeather(devapi.qweather.com, 中国气象局数据源), 但本机 IP 被和风 API/
 * 控制台 403 拦截(Invalid Host, 直连+本地代理均被拒) → 按任务预案降级到
 * 中国天气网/中国气象局 公开接口(免 key, 国内官方数据源)。
 * 安全架构(Gavin 硬约束): 上游调用只在服务端, agent 仅经本代理端点取数;
 * 凭据绝不进任务 body/访客报告/前端(本实现免 key, 无密钥可泄漏)。
 */
const GZ_WEATHER_CITY = "101280101"; // 广州(中国天气网城市码)
const GZ_WEATHER_STATION = "59287";  // 广州(中国气象局站号)
const GZ_WEATHER_7D_URL = `https://www.weather.com.cn/weather/${GZ_WEATHER_CITY}.shtml`;     // 第 1-7 天
const GZ_WEATHER_15D_URL = `https://www.weather.com.cn/weather15d/${GZ_WEATHER_CITY}.shtml`; // 第 8-15 天
const GZ_WEATHER_CMA_URL = `https://weather.cma.cn/api/weather/${GZ_WEATHER_STATION}`;       // 气象局 JSON 兜底(第 1-7 天)
const GZ_WEATHER_REFERER = "https://www.weather.com.cn/";
const GZ_WEATHER_TTL_MS = 30 * 60 * 1000;        // 预报 4 次/天更新, 30 分钟缓存足够
const GZ_WEATHER_DEGRADE_TTL_MS = 5 * 60 * 1000; // 降级(仅 1-7 天)短缓存, 尽快重试上游

function gzWeatherDate(offsetDays) { // 北京时 今天 + N 天 → "YYYY-MM-DD"
  return new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
}
function gzWeatherNow() { // 北京时 → "YYYY-MM-DD HH:mm (UTC+8)"
  return `${new Date(Date.now() + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 16)} (UTC+8)`;
}

// 中国天气网 7 天页: <li class="sky ..."><h1>17日（今天）</h1>...<p title="中雨" class="wea">..</p>
//   <p class="tem"><span>35</span>/<i>26℃</i></p><p class="win">...<span title="无持续风向" class="NNW"></span><i><3级</i></p>
function parseWeather7dHtml(html, start) {
  const rows = [];
  const liRe = /<li\s+class="sky[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(html))) {
    const b = m[1];
    if (!/<h1>\s*\d{1,2}日（(?:今天|明天|后天|周.)）\s*<\/h1>/.test(b)) continue;
    const tem = b.match(/<p\s+class="tem">\s*<span>([^<]+)<\/span>\s*\/\s*<i>([^<]+)<\/i>/);
    const win = b.match(/<p\s+class="win">([\s\S]*?)<\/p>/);
    const winDir = win && (win[1].match(/<span\s+title="([^"]*)"\s+class="[^"]*"><\/span>/) || [])[1];
    const winScale = win && (win[1].match(/<i>([\s\S]*?)<\/i>/) || [])[1];
    rows.push({
      date: gzWeatherDate(start + rows.length),
      dayText: ((b.match(/<p\s+title="([^"]*)"\s+class="wea">/) || [])[1] || "").trim(),
      high: tem ? parseInt(tem[1], 10) : null,
      low: tem ? parseInt(tem[2].replace("℃", ""), 10) : null,
      windDir: winDir ? winDir.trim() : "",
      windScale: winScale ? winScale.trim() : "",
    });
  }
  return rows;
}

// 中国天气网 15 天页第 8-15 天: <li ...><span class="time">周一（24日）</span>...
//   <span class="wea">雨</span><span class="tem"><em>30℃</em>/25℃</span><span class="wind">东风</span><span class="wind1"><3级</span>
function parseWeather15dHtml(html, start) {
  const rows = [];
  const ulM = html.match(/<ul\s+class="t clearfix">([\s\S]*?)<\/ul>/);
  if (!ulM) return rows;
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(ulM[1]))) {
    const b = m[1];
    if (!/<span\s+class="time">周.（(\d{1,2})日）<\/span>/.test(b)) continue;
    const tem = b.match(/<span\s+class="tem"><em>(\d+)℃<\/em>\s*\/\s*(\d+)℃<\/span>/);
    rows.push({
      date: gzWeatherDate(start + rows.length),
      dayText: ((b.match(/<span\s+class="wea">([\s\S]*?)<\/span>/) || [])[1] || "").trim(),
      high: tem ? parseInt(tem[1], 10) : null,
      low: tem ? parseInt(tem[2], 10) : null,
      windDir: ((b.match(/<span\s+class="wind">([\s\S]*?)<\/span>/) || [])[1] || "").trim(),
      windScale: ((b.match(/<span\s+class="wind1">([\s\S]*?)<\/span>/) || [])[1] || "").trim(),
    });
  }
  return rows;
}

// 中国气象局(weather.cma.cn) JSON 兜底: daily[{date,high,low,dayText,nightText,dayWindDirection,dayWindScale}]
function parseWeatherCmaDaily(txt) {
  const d = JSON.parse(txt);
  const daily = d?.data?.daily;
  if (!Array.isArray(daily)) return [];
  return daily.map((x, i) => ({
    date: String(x.date || "").replace(/\//g, "-") || gzWeatherDate(i),
    dayText: x.dayText || x.nightText || "",
    high: x.high != null ? Math.round(x.high) : null,
    low: x.low != null ? Math.round(x.low) : null,
    windDir: x.dayWindDirection || "",
    windScale: x.dayWindScale || "",
  }));
}

// 上游: 1-7 天(中国天气网 7 天页 → 兜底中国气象局 JSON) + 8-15 天(中国天气网 15 天页)
async function handleGzWeather() {
  let days = [];
  let updateTime = null;
  let note = null;
  try {
    const h7 = await fetchWithFallback(GZ_WEATHER_7D_URL, { referer: GZ_WEATHER_REFERER, retries: 1 });
    days = parseWeather7dHtml(h7, 0);
    const um = h7.match(/id="hidden_title"[^>]*value="([^"]*)"/);
    if (um) updateTime = um[1].trim();
  } catch {}
  if (!days.length) {
    // 7 天页失败 → 中国气象局 JSON 兜底
    try {
      const cma = await fetchWithFallback(GZ_WEATHER_CMA_URL, { retries: 1 });
      days = parseWeatherCmaDaily(cma);
      try { const du = JSON.parse(cma)?.data?.lastUpdate; if (du) updateTime = du; } catch {}
    } catch {}
  }
  if (!days.length) { const e = new Error("weather upstream unavailable"); e.status = 502; throw e; }
  try {
    const h15 = await fetchWithFallback(GZ_WEATHER_15D_URL, { referer: GZ_WEATHER_REFERER, retries: 1 });
    const tail = parseWeather15dHtml(h15, days.length);
    if (tail.length) days = days.concat(tail);
    else note = "15 天预报页未取到第 8-15 天数据，仅含第 1-7 天";
  } catch { note = "15 天预报上游暂不可用，仅含第 1-7 天"; }
  const out = {
    city: "广州",
    data_source: "中国天气网（中国气象局）",
    fetched_at: gzWeatherNow(),
    update_time: updateTime,
    day_count: days.length,
    days,
  };
  if (note) out.note = note;
  // 降级(不满 15 天)用短 TTL 尽快重试上游; 完整 15 天用常规 TTL
  return days.length >= 15 ? out : { ...out, __ttl: GZ_WEATHER_DEGRADE_TTL_MS };
}

function demoReadStatus() {
  try { return JSON.parse(fs.readFileSync(DEMO_STATUS_FILE, "utf-8")); } catch { return { tasks: {}, history: [] }; }
}
function demoWriteStatus(s) {
  fs.mkdirSync(DEMO_DIR, { recursive: true });
  fs.writeFileSync(DEMO_STATUS_FILE, JSON.stringify(s, null, 2));
}
// 统一创建时间兜底: 历史遗留写入可能缺 created_at（如 8/17 flock 并发测试直写 status.json 的条目），
// 依次回退 started_at → finished_at, 保证派生 history 每条都有可排序时间
function demoTaskCreatedAt(t) {
  return t.created_at || t.started_at || t.finished_at || null;
}
// 对外视图: 不含 ip（隐私），completed 时附带报告 markdown（读结果文件）
function demoTaskView(s, id) {
  const t = s.tasks[id];
  if (!t) return null;
  const v = {
    demo_id: id, task_id: t.task_id, status: t.status,
    kanban_task_id: t.kanban_task_id || null,
    created_at: t.created_at, started_at: t.started_at || null, finished_at: t.finished_at || null,
  };
  if (t.status === "completed") {
    v.report_md = "";
    try { v.report_md = fs.readFileSync(path.join(DEMO_RES_DIR, `${id}.md`), "utf-8"); } catch {}
  }
  return v;
}

/* ---------------- OPC demo 事件管道（16b: demo 卡流转/认领/完成 秒级广播） ----------------
 * demo 状态事实源: server/data/demo/status.json（opc_demo_dispatch.py cron/服务器 spawn + 潘明 worker 写入）。
 * 与正式状态流同一条 SSE(/api/opc/stream, event: demo), 复用 opcStreamClients 集合/心跳/断连清理,
 * 客户端集合共享, demo 事件与 status 事件同流, 事件类型区分。
 * 事件帧契约(与前端卡 t_efc6a93d 完全一致):
 *   {type:"demo", demo_id, task_id, title, member:"潘明", action, status, ts}
 *   action: created(dispatched 建卡成功) | claimed(running) | completed | failed
 *   status: todo | running | done | failed（帧内用 kanban 语义, 与 status.json 的 queued/dispatched/... 区分）
 */
const DEMO_MEMBER = "潘明";
const DEMO_DISPATCH_SCRIPT = "/home/gavin/.hermes/scripts/opc_demo_dispatch.py";

// demo 事件流纯函数（提取至 lib/demo-stream.cjs，单测覆盖）
const { makeFrame, demoStreamDiff: demoStreamDiffRaw } = require("./lib/demo-stream.cjs");
const demoStreamFrame = makeFrame({ tasks: DEMO_TASKS, member: DEMO_MEMBER });
// 绑定帧构造器(4 参签名: prev, cur, nowIso, frame) — lib 纯函数不持有 DEMO_TASKS/DEMO_MEMBER
function demoStreamDiff(prev, cur, nowIso) {
  return demoStreamDiffRaw(prev, cur, nowIso, demoStreamFrame);
}

let demoStreamWatcher = null;          // fs.watch 句柄: demo/status.json
let demoStreamDebounceTimer = null;    // demo 事件防抖定时器(200ms, 复用 OPC_STREAM_DEBOUNCE_MS)
let demoStreamFallbackTimer = null;    // 兜底轮询(5s): fs.watch 对原子替换(rename)可能丢事件, mtime 对比兜底
let demoStreamLastMtime = 0;           // 兜底轮询 mtime 基准
let demoStreamPrevTasks = null;        // 上一帧 tasks 快照(迁移检测基准; 启动时建基线)
const demoStreamSentSigs = new Set();  // 全局已发 sig(demo_id|status): 同一迁移只广播一次,
                                       // catch-up 与 watcher 迁移检测互不重复(上限清理防无界增长)

function demoStreamReadStatus() {
  try { return JSON.parse(fs.readFileSync(DEMO_STATUS_FILE, "utf-8")); } catch { return null; }
}

function demoStreamSig(id, status) { return `${id}|${status}`; }

// 登记 sig 并返回是否首次: 首次(true)才广播; 已发过则跳过(同一迁移不重复推)
function demoStreamMarkSent(id, status) {
  const sig = demoStreamSig(id, status);
  if (demoStreamSentSigs.has(sig)) return false;
  demoStreamSentSigs.add(sig);
  if (demoStreamSentSigs.size > 1000) demoStreamSentSigs.clear(); // 防无界增长(旧任务早已终态)
  return true;
}

// 组装事件帧: status.json 的 demo 状态 → 帧内 kanban 语义 status（见 lib/demo-stream.cjs demoStreamFrame）
// 状态迁移 → 事件帧（实现见 lib/demo-stream.cjs demoStreamDiff，18d 起含 prev 缺失任务补发 created 链）

// 广播 demo 事件帧给所有全局流客户端(event: demo, 与 event: status 同流)。
// sig 去重: 同一 demo_id+status 迁移只广播一次(catch-up 先发的, watcher 不再补发)。
function demoStreamBroadcast() {
  const snap = demoStreamReadStatus();
  if (!snap || !snap.tasks) return; // 半写/暂缺: 跳过本轮, 下轮 change 再读(基线不动)
  const nowIso = new Date().toISOString();
  if (demoStreamPrevTasks == null) { demoStreamPrevTasks = snap.tasks; return; } // 基线缺失兜底
  const frames = demoStreamDiff(demoStreamPrevTasks, snap.tasks, nowIso);
  demoStreamPrevTasks = snap.tasks;
  if (!frames.length) return;
  const fresh = frames.filter((f) => demoStreamMarkSent(f.demo_id, f.status));
  if (!fresh.length) return;
  for (const c of opcStreamClients) for (const f of fresh) sendEvent(c.res, "demo", f);
}

function demoStreamStartWatcher() {
  if (demoStreamWatcher || demoStreamFallbackTimer) return;
  try { demoStreamLastMtime = fs.statSync(DEMO_STATUS_FILE).mtimeMs; } catch { demoStreamLastMtime = 0; }
  try {
    demoStreamWatcher = fs.watch(DEMO_STATUS_FILE, { persistent: false }, () => {
      if (demoStreamDebounceTimer) clearTimeout(demoStreamDebounceTimer);
      demoStreamDebounceTimer = setTimeout(() => { demoStreamDebounceTimer = null; demoStreamBroadcast(); }, OPC_STREAM_DEBOUNCE_MS);
    });
  } catch (e) {
    console.error("[demo-stream] fs.watch unavailable for demo status:", e.message);
    demoStreamWatcher = null;
  }
  // 兜底轮询(5s): fs.watch 对部分写入方式(如 agent 的原子替换)可能丢事件, mtime 对比兜底。
  // 实测(16b 验收): dispatch 脚本/POST 的写入 fs.watch 能捕获, 潘明 worker 的写入 fs.watch 捕获不到,
  // 必须靠轮询 —— 与 opcStream 的 30s 兜底同款设计, demo 秒级体验用 5s 更紧。
  demoStreamFallbackTimer = setInterval(() => {
    let mtime = 0;
    try { mtime = fs.statSync(DEMO_STATUS_FILE).mtimeMs; } catch { return; }
    if (mtime !== demoStreamLastMtime) { demoStreamLastMtime = mtime; demoStreamBroadcast(); }
  }, 5000);
  demoStreamFallbackTimer.unref();
}

function demoStreamStopWatcher() {
  if (demoStreamWatcher) { try { demoStreamWatcher.close(); } catch {} demoStreamWatcher = null; }
  if (demoStreamFallbackTimer) { clearInterval(demoStreamFallbackTimer); demoStreamFallbackTimer = null; }
  if (demoStreamDebounceTimer) { clearTimeout(demoStreamDebounceTimer); demoStreamDebounceTimer = null; }
}

// 派活提速(16b): POST /api/opc/demo 写请求文件成功后 spawn 一次 dispatch, 不等 1 分钟 cron。
// 失败静默(不阻塞响应, cron 兜底); 脚本内 flock 与 cron 互斥, 不重复建卡。
// 子进程 stderr/退出码捕获到服务日志: 静默失败可定位(脚本自身 err() 走 stderr)。
// env 清理: pm2 守护进程继承自 delegate 上下文, 会带 HERMES_DELEGATED_CHILD_CONTEXT=1,
// 使 hermes CLI 拒改 kanban —— 传给子进程前剥掉(脚本内亦有兜底 pop)。
function spawnDispatchScript() {
  try {
    const env = { ...process.env };
    delete env.HERMES_DELEGATED_CHILD_CONTEXT;
    const child = spawn("python3", [DEMO_DISPATCH_SCRIPT], { stdio: ["ignore", "ignore", "pipe"], env });
    let cerr = "";
    child.stderr.on("data", (d) => { cerr += d.toString(); });
    child.on("error", (e) => console.error("[demo] dispatch spawn error:", e.message));
    child.on("close", (code) => {
      if (code !== 0 || cerr.trim()) console.error(`[demo] dispatch exit=${code} stderr: ${cerr.trim().slice(0, 400)}`);
    });
    child.unref();
  } catch (e) {
    console.error("[demo] dispatch spawn failed:", e?.message || e);
  }
}

// 连接 catch up: 在飞(dispatched/running)任务补推当前状态帧(服务器重启后访客刷新能接上)。
// queued 尚无卡不发; 帧内 ts 用任务自身时间戳(created_at/started_at), 比检测时间真实。
// 同时登记 sig: 后续 watcher 不会对该迁移再广播(同一连接不重复)。
function demoStreamCatchUp(res) {
  const snap = demoStreamReadStatus();
  if (!snap || !snap.tasks) return;
  const nowIso = new Date().toISOString();
  for (const [id, t] of Object.entries(snap.tasks)) {
    if (t.status === "dispatched" && t.kanban_task_id) {
      sendEvent(res, "demo", demoStreamFrame(id, t, "created", "todo", t.created_at || nowIso));
      demoStreamMarkSent(id, "todo");
    } else if (t.status === "running") {
      sendEvent(res, "demo", demoStreamFrame(id, t, "claimed", "running", t.started_at || nowIso));
      demoStreamMarkSent(id, "running");
    }
  }
}

// 启动即建基线: 之后所有迁移都能被检测到(避免重启后首个事件被基线吞掉)
try { demoStreamPrevTasks = (demoStreamReadStatus() || { tasks: {} }).tasks || {}; } catch { demoStreamPrevTasks = {}; }

// 读取 POST body, 超过 limit 字节即停止累积({ tooBig: true }), 防止无限读入
function readBodyWithLimit(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners("data");
        req.resume(); // 排空剩余数据, 避免背压卡死连接
        done({ tooBig: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => done({ buf: Buffer.concat(chunks) }));
    req.on("error", () => done({ buf: Buffer.concat(chunks) }));
    req.on("close", () => done({ buf: Buffer.concat(chunks) })); // 客户端中途断连兜底, 防止悬挂
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    // ---- 手速排行榜旧路径重定向(0819-i): knock 已迁独立进程(hermes.cc.cd/api/v1/knock, :3032)。
    // mrd 旧路径 /api/v1/knock/* 一律 302 到新域, 保留剩余路径与 query 参数; 旧版 mylauncher
    // 升级前排行榜不中断(客户端默认跟随重定向)。GET/HEAD 用 302; POST 用 307(保留方法与 body,
    // 旧版 submit 不被 302 转 GET 丢体)。放在请求处理最前, 先于一切路由/预检分支。
    if (u.pathname.startsWith("/api/v1/knock/")) {
      const rest = u.pathname.slice("/api/v1/knock".length) || "/";
      const loc = "https://hermes.cc.cd/api/v1/knock" + rest + (u.search || "");
      res.writeHead(req.method === "POST" ? 307 : 302, {
        Location: loc,
        "Cache-Control": "no-store",
        ...STATIC_HEADERS,
      });
      return res.end();
    }
    // ---- OPC 全局状态流 SSE: GET /api/opc/stream（15a, 持续推送不关闭）----
    if (u.pathname === "/api/opc/stream" && req.method === "GET") {
      stats.reqs++;
      const ip = clientIp(req);
      trackActiveIp(ip);
      const cors = opcCorsHeaders(req);
      if (!apiLimiter(ip)) { stats.blocked++; send(res, 429, { ok: false, error: "too many requests" }, cors); return; }
      // 并发上限: 超出直接 503, 客户端应退避重连(EventSource 原生支持断线自动重连)
      if (opcStreamClients.size >= OPC_STREAM_MAX_CLIENTS) {
        send(res, 503, { ok: false, error: "too many concurrent stream clients" }, cors);
        return;
      }
      const headers = { ...cors };
      if (headers["Access-Control-Allow-Origin"] == null) delete headers["Access-Control-Allow-Origin"];
      setSSEHeaders(res, headers);
      const client = { res, hb: sseHeartbeat(res, OPC_STREAM_HEARTBEAT_MS) };
      res.on("error", () => {}); // 断连竞态下迟到 write 会 emit error, 吞掉防进程 crash
      opcStreamClients.add(client);
      // 1) 连接建立: 立即推当前 status.json 全量快照(前端首帧无需再 fetch)
      const snap = opcStreamReadSnapshot();
      if (snap) sendEvent(res, "status", snap);
      // 2) demo 事件 catch up: 在飞(dispatched/running)任务补推当前状态帧, 服务器重启后访客刷新能接上
      demoStreamCatchUp(res);
      opcStreamStartWatcher();
      // 6) 断连清理: 移出集合 + 清心跳定时器(防内存泄漏); 无客户端时停 watcher
      req.on("close", () => {
        opcStreamClients.delete(client);
        clearInterval(client.hb);
        if (opcStreamClients.size === 0) opcStreamStopWatcher();
      });
      return;
    }
    // ---- OPC demo 进展 SSE: GET /api/opc/demo/{id}/stream（Gavin 拍板: 秒级实时性唯一场景走 SSE, 不用 WebSocket）----
    // 状态变更推送; status.json 即事件事实源。终态推送后服务端关闭, 客户端据此断开 EventSource。
    const demoStream = u.pathname.match(/^\/api\/opc\/demo\/([^/]{1,64})\/stream$/);
    if (demoStream && req.method === "GET") {
      stats.reqs++;
      const ip = clientIp(req);
      trackActiveIp(ip);
      const cors = opcCorsHeaders(req);
      if (!apiLimiter(ip)) { stats.blocked++; send(res, 429, { ok: false, error: "too many requests" }, cors); return; }
      const demoId = demoStream[1];
      const s0 = demoReadStatus();
      if (!s0.tasks[demoId]) { send(res, 404, { ok: false, error: "demo not found" }, cors); return; }
      const headers = { ...cors };
      if (headers["Access-Control-Allow-Origin"] == null) delete headers["Access-Control-Allow-Origin"];
      setSSEHeaders(res, headers); // 15a: 与全局流共用公共设施; 帧格式/行为逐字节不变
      let lastSig = "";
      const push = (v) => {
        if (!v) return;
        const sig = `${v.status}|${v.kanban_task_id || ""}|${v.finished_at || ""}`;
        if (sig === lastSig) return; // 去重: 状态无变化不重复推
        lastSig = sig;
        sendEvent(res, "status", v);
      };
      push(demoTaskView(s0, demoId));
      const timer = setInterval(() => {
        const v = demoTaskView(demoReadStatus(), demoId);
        push(v);
        if (v && (v.status === "completed" || v.status === "failed")) {
          clearInterval(timer);
          setTimeout(() => { try { res.end(); } catch {} }, 500); // 终态事件送达后 500ms 关闭
        }
      }, DEMO_SSE_POLL_MS);
      const maxTimer = setTimeout(() => { clearInterval(timer); try { res.end(); } catch {} }, DEMO_SSE_MAX_MS);
      req.on("close", () => { clearInterval(timer); clearTimeout(maxTimer); });
      return;
    }
    // ---- OPC demo/透明办公室 API 跨域预检(12c): www Pages 站跨源 POST(content-type: application/json)
    // 触发 preflight, 现返回 400 导致浏览器拦截; 这里放行白名单来源并返回完整 CORS 头。
    // status/history/SSE 流为简单 GET(无自定义头)不触发 preflight, 由响应 ACAO 放行。
    // 官网合作咨询(改版5): /api/contact 同走 www.hermes.cc.cd 白名单(落地页表单跨源提交)。
    // 官网 AI 助理(0818-a P0): /api/assistant 同走白名单(落地页 AI 问答表单跨源提交)。
    // 博客评论+阅读量(0818): /api/blog/ 同走白名单(www Pages 站 blog 评论区跨源读写)。
    if (req.method === "OPTIONS" && (u.pathname.startsWith("/api/opc/") || u.pathname.startsWith("/api/blog/") || u.pathname === "/api/contact" || u.pathname === "/api/visits" || u.pathname === "/api/token-stats" || u.pathname === "/api/assistant")) {
      const cors = opcCorsHeaders(req);
      if (cors["Access-Control-Allow-Origin"] == null) {
        send(res, 403, { ok: false, error: "forbidden" }, cors);
      } else {
        send(res, 200, { ok: true }, {
          ...cors,
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        });
      }
      return;
    }
    if (routes[u.pathname]) {
      stats.reqs++;
      const ip = clientIp(req);
      trackActiveIp(ip);
      const cors = u.pathname.startsWith("/api/opc/") || u.pathname.startsWith("/api/blog/") || u.pathname === "/api/contact" || u.pathname === "/api/visits" || u.pathname === "/api/token-stats" || u.pathname === "/api/assistant"
        ? opcCorsHeaders(req)
        : corsHeadersFor(req);
      // 按 IP 限流(先于缓存命中判断, 防唯一 key 旋转造成的上游请求放大)
      const allowed = (PROTECTED_ROUTES.has(u.pathname) ? protectedLimiter : apiLimiter)(clientIp(req));
      if (!allowed) {
        stats.blocked++;
        send(res, 429, { ok: false, error: "too many requests" }, cors);
        return;
      }
      // 私有 API key 端点: 跨源请求直接拒绝, 防止被刷配额
      if (PROTECTED_ROUTES.has(u.pathname) && !isSameOrigin(req)) {
        send(res, 403, { ok: false, error: "forbidden" }, cors);
        return;
      }
      // 用户输入参数长度上限(缓存 key 由参数拼接, 防止无界增长)
      for (const v of u.searchParams.values()) {
        if (v.length > 2000) {
          send(res, 400, { ok: false, error: "param too long" }, cors);
          return;
        }
      }
      try {
        let body;
        if (req.method === "POST") {
          const r = await readBodyWithLimit(req, 256 * 1024);
          if (r.tooBig) {
            res.on("finish", () => req.destroy()); // 响应送达后再回收连接
            send(res, 413, { ok: false, error: "payload too large" }, cors);
            return;
          }
          try { body = JSON.parse(r.buf.toString()); } catch { send(res, 400, { ok: false, error: "invalid json body" }, cors); return; }
        }
        const data = await routes[u.pathname](u.searchParams, body, req);
        // __rawResponse 约定(排行榜 0818): 契约要求裸 JSON 响应体(如 /api/v1/knock 的
        // {"leaderboard":...}), handler 返回 {__rawResponse: <payload>} 时原样输出, 不套 ok/data 包装。
        if (data && data.__rawResponse !== undefined) {
          send(res, 200, data.__rawResponse, cors);
        } else {
          send(res, 200, { ok: true, data, ts: Date.now() }, cors);
        }
      } catch (e) {
        // 错误回显契约: 内部细节只记日志; err.status 由可预期的业务错误(队列满/问财配额等)携带,
        // 其 message 必须为白名单文案(不含 URL/网络细节); 无 status 一律回显静态 "upstream error"
        console.error("[api]", u.pathname, e?.stack || e?.message || e);
        send(res, e?.status || 502, { ok: false, error: e?.status ? e.message : "upstream error" }, cors);
      }
      return;
    }
    // /api/ 下未命中的路由返回 404 JSON, 不走 SPA fallback
    if (u.pathname.startsWith("/api/")) {
      send(res, 404, { ok: false, error: "not found" });
      return;
    }
    // ---- /company/* 公司站 HTML 副本清理(单一事实源 = www.hermes.cc.cd)----
    // Gavin 拍板: mrd 域 /company/ 不再 serve 公司站 HTML, 一律 301 到官网对应路径(保 SEO/书签跳转)。
    // 映射: /company/ → https://www.hermes.cc.cd/ 、 /company/opc/ → https://www.hermes.cc.cd/opc/ 、
    //       /company/blog/ → https://www.hermes.cc.cd/blog/ (去掉 /company 前缀, index.html 归一为目录)。
    // 红线: /company/opc/status.json 绝对保留 —— 官网成员数 fetch 数据源, 继续走下方静态服务(CORS + CF 短缓存)。
    if (req.method === "GET" || req.method === "HEAD") {
      if (u.pathname === "/company" || u.pathname.startsWith("/company/")) {
        if (u.pathname !== "/company/opc/status.json") {
          let rest = u.pathname === "/company" ? "" : u.pathname.slice("/company".length);
          if (!rest.startsWith("/")) rest = "/" + rest;
          if (rest.endsWith("/index.html")) rest = rest.slice(0, -"index.html".length);
          if (rest === "/") rest = ""; // 根路径不带尾斜杠, www Pages 能处理
          const loc = "https://www.hermes.cc.cd" + rest + (u.search || "");
          res.writeHead(301, {
            Location: loc,
            "Cache-Control": "public, max-age=3600",
            ...STATIC_HEADERS,
          });
          return res.end();
        }
      }
    }
    // 静态资源 + SPA fallback
    let p = decodeURIComponent(u.pathname);
    if (p === "/" || p.endsWith("/")) p += "index.html";
    const file = path.join(DIST, path.normalize(p));
    if (file !== DIST && !file.startsWith(DIST + path.sep)) {
      send(res, 403, { ok: false });
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        // 带扩展名的资源未命中: 直接 404, 不回退 index.html(避免 200+HTML 伪装成 JS/CSS)
        if (path.extname(file)) return send(res, 404, { ok: false, error: "not found" });
        // 目录路径(如 /company 不带尾斜杠): 先试目录内 index.html, 再 SPA fallback
        fs.readFile(path.join(file, "index.html"), (e3, dirHtml) => {
          if (!e3) {
            const h = {
              "Content-Type": "text/html; charset=utf-8",
              ...STATIC_HEADERS,
            };
            h["Content-Security-Policy"] = u.pathname.startsWith("/company") ? COMPANY_CSP : CSP;
            res.writeHead(200, h);
            return res.end(dirHtml);
          }
          fs.readFile(path.join(DIST, "index.html"), (e2, html) => {
            if (e2) return send(res, 404, { ok: false });
            res.writeHead(200, {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Security-Policy": CSP,
              ...STATIC_HEADERS,
            });
            res.end(html);
          });
        });
        return;
      }
      const headers = {
        "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": file.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        ...STATIC_HEADERS,
      };
      if (file.endsWith(".html")) headers["Content-Security-Policy"] = u.pathname.startsWith("/company") ? COMPANY_CSP : CSP;
      // OPC 透明办公室数据跨域读: 仅 www.hermes.cc.cd(Pages 独立站)可读
      if (u.pathname === "/company/opc/status.json") {
        headers["Access-Control-Allow-Origin"] = "https://www.hermes.cc.cd";
        headers["Vary"] = "Origin";
        // 13a 安全加固: CF 边缘短缓存 10s 吸收前端 10s 轮询刷新量(回源率降 ~90%);
        // 浏览器侧同样 10s(2 分钟级数据, 10s 旧无感); s-maxage 对共享缓存生效
        headers["Cache-Control"] = "public, max-age=10, s-maxage=10";
      }
      res.writeHead(200, headers);
      res.end(buf);
    });
  } catch (e) {
    console.error("[server] error:", e?.message || e);
    send(res, 500, { ok: false, error: "internal error" });
  }
});

server.listen(PORT, () => console.log(`[market-cockpit] listening on :${PORT}`));
