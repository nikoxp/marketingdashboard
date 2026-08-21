// mrd 黄金观察 /gold · 数据源 = 读 gold-monitor 产物文件（零网络依赖）
// 数据资产盘点（庄子已定，勿改）：
//   - 实时价/宏观: /home/gavin/hermes_space/gold-monitor/data/gold_data_*.json（60min cron 落盘, 按 mtime 取最新）
//   - 历史序列:   同目录全部 gold_data_*.json（1200+ 份, 24h=24 点 / 7d=168 点 / 30d 降采样）
//   - 央行购金:   /home/gavin/hermes_space/central-bank-gold/db/gold_reserves.db（SQLite, cb_transactions / gold_reserves）
// 铁律: 不改 gold-monitor 任何文件; JSON 缺失/解析失败 → 空态 + __ttl: 60s 短缓存(恢复即重试);
//       SQLite 读不到 → 央行面板空态提示, 绝不硬编码死值。
"use strict";

const { DatabaseSync } = require("node:sqlite");

const GOLD_DATA_DIR = "/home/gavin/hermes_space/gold-monitor/data";
const CB_DB_PATH = "/home/gavin/hermes_space/central-bank-gold/db/gold_reserves.db";
// 盎司 → 克: 1 金衡盎司 = 31.1034768 克
const OZ_TO_G = 31.1034768;

module.exports = (ctx) => {
  const { fs, path } = ctx;

  /* ---------------- 文件层 ---------------- */

  /** 最新一份 gold_data_*.json 的绝对路径（按 mtime, 目录缺失/空返回 null） */
  function latestGoldFile() {
    let names;
    try { names = fs.readdirSync(GOLD_DATA_DIR); } catch { return null; }
    const golds = names
      .filter((n) => /^gold_data_\d{8}_\d{6}\.json$/.test(n))
      .map((n) => ({ n, p: path.join(GOLD_DATA_DIR, n) }))
      .sort((a, b) => {
        try { return fs.statSync(b.p).mtimeMs - fs.statSync(a.p).mtimeMs; } catch { return 0; }
      });
    return golds.length ? golds[0].p : null;
  }

  /** 读 JSON, 解析失败返回 null（三层 fallback 第一层: 空态 + 短缓存） */
  function readGoldJson(file) {
    if (!file) return null;
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }

  /** 文件名 gold_data_20260820_174713.json → Date（本地时区, 与 mrd 服务器同区; 失败回退 mtime） */
  function fileTime(file) {
    const m = path.basename(file).match(/^gold_data_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.json$/);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      if (!Number.isNaN(d.getTime())) return d;
    }
    try { return new Date(fs.statSync(file).mtimeMs); } catch { return new Date(0); }
  }

  /* ---------------- SQLite 层（node:sqlite 内置, 只读） ---------------- */

  /** 打开央行库（只读; 缺失/损坏返回 null, 绝不抛给路由层） */
  function openCbDb() {
    try {
      if (!fs.existsSync(CB_DB_PATH)) return null;
      return new DatabaseSync(CB_DB_PATH, { readOnly: true });
    } catch { return null; }
  }

  /** 央行购金动态: 近 3 个月, ABS(change_tonnes)<20 过滤脏数据(进口/汇总), 去重同月同国, 排除"全球"汇总行 */
  function cbTransactions() {
    const db = openCbDb();
    if (!db) return { transactions: [] };
    try {
      const rows = db.prepare(`
        SELECT country, transaction_date AS ym, change_tonnes AS tonnes, notes
        FROM cb_transactions
        WHERE ABS(change_tonnes) < 20
          AND country NOT LIKE '%全球%'
        ORDER BY transaction_date DESC, change_tonnes DESC
      `).all();
      // 去重: 同月同国只保留一条（优先保留最先出现的, ORDER BY 已让大额在前）
      const seen = new Set();
      const out = [];
      for (const r of rows) {
        if (!r.ym) continue;
        const key = `${r.ym.slice(0, 7)}|${r.country}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ country: r.country, ym: r.ym.slice(0, 7), tonnes: r.tonnes, notes: r.notes || "" });
        if (out.length >= 15) break;
      }
      return { transactions: out };
    } catch { return { transactions: [] }; }
    finally { try { db.close(); } catch {} }
  }

  /** 央行储备 TOP10: 每个国家取最新日期快照, 按 reserves_tonnes 降序 */
  function cbReservesTop() {
    const db = openCbDb();
    if (!db) return { top10: [] };
    try {
      // 子查询: 每国家最新 date（快照表一个国家多期, 取最新一期）
      const rows = db.prepare(`
        SELECT r.country, r.date, r.reserves_tonnes AS tonnes
        FROM gold_reserves r
        JOIN (SELECT country, MAX(date) AS md FROM gold_reserves GROUP BY country) t
          ON r.country = t.country AND r.date = t.md
        ORDER BY r.reserves_tonnes DESC
        LIMIT 10
      `).all();
      return { top10: rows.map((r) => ({ country: r.country, date: r.date, tonnes: r.tonnes })) };
    } catch { return { top10: [] }; }
    finally { try { db.close(); } catch {} }
  }

  /* ---------------- 换算 ---------------- */

  /**
   * 金价换算: USD/oz 与 CNY/oz 双价（gold-api 已直接给 CNY/oz, 无需汇率反推）。
   * 返回 { usd, cny, cnyPerG, note } — cnyPerG = CNY/oz ÷ 31.1035（克价）;
   * CNY 缺失时用 USD × 汇率(无汇率则标注不可换算)兜底, 不伪造。
   */
  function convertPrices(prices) {
    const usdEntry = prices && prices.USD && typeof prices.USD.price === "number" ? prices.USD : null;
    const cnyEntry = prices && prices.CNY && typeof prices.CNY.price === "number" ? prices.CNY : null;
    if (!usdEntry && !cnyEntry) return null;
    const usd = usdEntry ? usdEntry.price : null;
    const cny = cnyEntry ? cnyEntry.price : null;
    let cnyPerG = null;
    let note = "";
    if (cny != null) {
      cnyPerG = cny / OZ_TO_G;
    } else if (usd != null) {
      note = "CNY 报价缺失，克价暂不可换算";
    }
    return {
      usd,
      cny,
      cnyPerG,
      ts: (usdEntry && usdEntry.timestamp) || (cnyEntry && cnyEntry.timestamp) || null,
      note,
    };
  }

  /** 收益率字典 → 数值对象（live_treasury_yields.yields 值是字符串, 转 number; 非法丢弃） */
  function yieldsToNum(yields) {
    const out = {};
    for (const [k, v] of Object.entries(yields || {})) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0 && n < 30) out[k] = n;
    }
    return out;
  }

  /** real_rates 脏值过滤: |x|<50 才有效（坑#15: real_rates["3"] 曾 -126 荒谬值, PCE 指数泄漏） */
  function cleanRealRates(rates) {
    const out = {};
    for (const [k, v] of Object.entries(rates || {})) {
      if (v == null) continue;
      const n = Number(v);
      if (Number.isFinite(n) && Math.abs(n) < 50) out[k] = n;
    }
    return out;
  }

  /* ---------------- 聚合 /api/gold ---------------- */

  // 注意: cached() 内部执行 fn().then(...), handler 必须是 async(同步 fn 会抛 fn(...).then is not a function)
  async function handleGold() {
    const file = latestGoldFile();
    const d = readGoldJson(file);
    // 三层 fallback 第一层: 文件缺失/坏 → 空态 + 短缓存(60s, 恢复即重试)
    if (!d) {
      return {
        __ttl: 60 * 1000,
        fetched_at: null,
        gold: null,
        treasury: null,
        real_curve: null,
        inflation: null,
        fed: null,
        news: [],
        central_bank: { transactions: [], top10: [] },
        source: "gold-monitor",
      };
    }

    const price = convertPrices(d.gold_price && d.gold_price.prices);
    const intraday = (d.gold_price && d.gold_price.intraday) || {};
    const yields = yieldsToNum(d.live_treasury_yields && d.live_treasury_yields.yields);
    const ryc = d.real_yield_curve || {};
    const cpi = d.cpi_inflation || {};
    const fed = d.live_fed_rate || {};
    const newsRaw = (d.recent_news && d.recent_news.news) || [];

    return {
      fetched_at: d.fetched_at || null,
      gold: {
        usd: price ? price.usd : null,
        cny: price ? price.cny : null,
        cnyPerG: price ? price.cnyPerG : null,
        ts: price ? price.ts : null,
        note: price ? price.note : "",
        changePct: typeof intraday.change_pct === "number" ? intraday.change_pct : null,
        intradayNote: intraday.note || "",
      },
      treasury: {
        date: (d.live_treasury_yields && d.live_treasury_yields.date) || null,
        fetchedAt: (d.live_treasury_yields && d.live_treasury_yields.fetched_at) || null,
        yields,
      },
      real_curve: {
        date: ryc.date || null,
        nominal_rates: ryc.nominal_rates || null,
        breakeven_rates: ryc.breakeven_rates || null,
        // 脏值过滤后再给前端（坑#15: real_rates["3"] -126.64 曾毒化报告）
        real_rates: cleanRealRates(ryc.real_rates),
      },
      inflation: {
        headlines: cpi.headlines || null,
        breakeven_inflation: cpi.breakeven_inflation || null,
      },
      fed: {
        date: fed.date || null,
        effectiveRate: typeof fed.effective_rate === "number" ? fed.effective_rate : null,
        fetchedAt: fed.fetched_at || null,
      },
      news: newsRaw.slice(0, 8).map((n) => ({
        title: String(n.title || ""),
        url: String(n.url || ""),
        source: String(n.source || ""),
      })),
      central_bank: { ...cbTransactions(), ...cbReservesTop() },
      source: "gold-monitor",
    };
  }

  /* ---------------- 历史序列 /api/gold/history?days=1|7|30 ---------------- */

  async function handleGoldHistory(daysRaw) {
    const days = daysRaw === "7" ? 7 : daysRaw === "30" ? 30 : 1;
    const windowMs = days * 24 * 3600 * 1000;
    const now = Date.now();

    let names;
    try { names = fs.readdirSync(GOLD_DATA_DIR); } catch { names = []; }
    const files = names
      .filter((n) => /^gold_data_\d{8}_\d{6}\.json$/.test(n))
      .map((n) => path.join(GOLD_DATA_DIR, n));

    const points = [];
    for (const f of files) {
      let p = null;
      try {
        const d = JSON.parse(fs.readFileSync(f, "utf8"));
        p = d && d.gold_price && d.gold_price.prices && d.gold_price.prices.USD &&
          typeof d.gold_price.prices.USD.price === "number" ? d.gold_price.prices.USD.price : null;
      } catch { p = null; }
      if (p == null) continue;
      const t = fileTime(f).getTime();
      if (t < now - windowMs || t > now + 5 * 60 * 1000) continue; // 只留窗口内, 容忍时钟偏移
      points.push({ t: new Date(t).toISOString(), p });
    }
    points.sort((a, b) => a.t.localeCompare(b.t));

    // 降采样: 30d ≈720 点, 曲线渲染上限 ~200 点(保持形状, 前端 polyline 不糊)
    const MAX_POINTS = 200;
    let series = points;
    if (points.length > MAX_POINTS) {
      const step = points.length / MAX_POINTS;
      series = [];
      for (let i = 0; i < MAX_POINTS; i++) {
        series.push(points[Math.min(points.length - 1, Math.floor(i * step))]);
      }
      // 尾点必须是最新价(索引取整可能落到倒数第二点, 曲线结尾会"提前截止")
      series[series.length - 1] = points[points.length - 1];
    }

    return {
      __ttl: 60 * 1000,
      days,
      points: series.map(({ t, p }) => ({ t, p: Math.round(p * 100) / 100 })),
      count: points.length,
      source: "gold-monitor",
    };
  }

  return { handleGold, handleGoldHistory };
};
