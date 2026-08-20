// 期货 + 加密货币行情源 — 腾讯/新浪/Binance/OKX
"use strict";

const { quoteUrl } = require("../lib/tencent-urls.cjs");

module.exports = function createFutures(ctx) {
  const { fetchText, curlText, fetchWithFallback, num, changeOf, pctOf, fmtHHMM, safeRecord } = ctx;
  const { cache, cacheSet, cached, entry, failEntry, quoteBackoff, TTLS } = ctx;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- 外盘期货(金银铜油):腾讯主源 + 新浪兜底 ---------------- */
  function parseFutures(text) {
    const out = safeRecord(); // 无原型对象: 上游 symbol 作为 key, 杜绝 __proto__ 污染
    const re = /(?:hq_str_|v_)(\w+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(text))) {
      const f = m[2].split(",");
      if (f.length < 14 || !f[0]) continue;
      const price = num(f[0]);
      const prevSettle = num(f[7]);
      out[m[1]] = {
        symbol: m[1],
        name: f[13],
        price,
        high: num(f[4]),
        low: num(f[5]),
        open: num(f[8]),
        prev: prevSettle,
        change: changeOf(price, prevSettle),
        pct: pctOf(price, prevSettle),
        time: `${f[12]} ${f[6]}`,
      };
    }
    return out;
  }

  /* ---------------- 内盘期货(沪金等):新浪 nf_ ---------------- */
  // 新浪 nf_ 字段依据(2026-08-19 实锤抓包):
  //   f[0]=名称 f[1]=时间戳 f[2]=开盘 f[3]=最高 f[4]=最低 f[5]=昨收(夜盘常为0,不可靠)
  //   f[6]/f[7]=买价/卖价 f[8]=最新价 f[9]=涨跌额 f[10]=昨结算(期货标准涨跌基准)
  //   f[13]=成交量 f[14]=持仓量 f[16]=时间 f[17]=日期
  function parseSinaDomestic(text) {
    const out = safeRecord(); // 无原型对象: 上游 symbol 作为 key, 杜绝 __proto__ 污染
    const re = /hq_str_(nf_\w+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(text))) {
      const f = m[2].split(",");
      if (f.length < 17 || !f[0]) continue;
      const prevSettle = num(f[10]) || num(f[5]); // 昨结算优先(标准涨跌基准), 昨收兜底
      let price = num(f[8]); // 最新价(夜盘休市可能为0)
      if (!price) {
        const bid = num(f[6]), ask = num(f[7]);
        price = bid && ask ? +((bid + ask) / 2).toFixed(2) : (bid || ask || prevSettle || 0);
      }
      const prev = prevSettle || price; // 双无效时 prev=price 防除零
      out[m[1]] = {
        symbol: m[1],
        name: f[0],
        price,
        high: num(f[3]),
        low: num(f[4]),
        open: num(f[2]),
        prev,
        change: changeOf(price, prev),
        pct: pctOf(price, prev),
        time: f[16],
      };
    }
    return out;
  }

  /* ---------------- 加密货币(Binance 主源 + OKX 兜底, fetch/curl 双通道) ---------------- */
  async function fetchJsonAny(urls) {
    // 上游 URL 列表恒为单元素, 双通道统一走 fetchWithFallback(见 lib/fetch-any.cjs)
    const text = await fetchWithFallback(urls[0], { referer: "https://www.binance.com/" });
    return JSON.parse(text);
  }

  async function fetchBtc() {
    try {
      const j = await fetchJsonAny(["https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT"]);
      return {
        symbol: "BTCUSDT", name: "BTC/USDT", price: num(j.lastPrice), prev: num(j.prevClosePrice),
        open: num(j.openPrice), high: num(j.highPrice), low: num(j.lowPrice),
        change: num(j.priceChange), pct: num(j.priceChangePercent), time: "",
      };
    } catch { /* Binance 不可达时走 OKX */ }
    const j = await fetchJsonAny(["https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT"]);
    const d = j?.data?.[0];
    if (!d) throw new Error("btc blocked");
    const price = num(d.last);
    const prev = num(d.open24h);
    return {
      symbol: "BTCUSDT", name: "BTC/USDT", price, prev,
      open: prev, high: num(d.high24h), low: num(d.low24h),
      change: +(price - prev).toFixed(2),
      pct: pctOf(price, prev),
      time: "",
    };
  }

  // 空结果重试一次(上游偶发返回空 JSONP 时, 等待后重拉)
  async function retryOnEmpty(fn, delay = 1200) {
    let r = await fn();
    if (Object.keys(r).length === 0) {
      await sleep(delay);
      r = await fn();
    }
    return r;
  }

  async function handleFutures(list) {
    // 代码白名单 + 数量上限: 防止畸形代码注入上游 URL 或制造超长请求
    const codes = String(list || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^(hf|nf)_[A-Za-z0-9]{1,12}$/.test(s) || s === "BTCUSDT")
      .slice(0, 60);
    const hf = codes.filter((c) => c.startsWith("hf_"));
    const nf = codes.filter((c) => c.startsWith("nf_"));
    const out = {};
    const jobs = [];
    if (hf.length) {
      jobs.push((async () => {
        // 主源:腾讯(稳定,无WAF)
        try {
          const r = parseFutures(await fetchText(quoteUrl(hf.map(encodeURIComponent).join(",")), { gbk: true }));
          if (Object.keys(r).length >= Math.min(2, hf.length)) return Object.assign(out, r);
        } catch { /* fallthrough */ }
        // 兜底:新浪
        const url = `https://hq.sinajs.cn/list=${hf.map(encodeURIComponent).join(",")}`; // 新浪要求逗号不转码
        const opts = { referer: "https://finance.sina.com.cn/futures/quotes/CL.shtml" };
        let r = await retryOnEmpty(async () => parseFutures(await curlText(url, opts)));
        Object.assign(out, r);
      })());
    }
    if (nf.length) {
      jobs.push((async () => {
        const url = `https://hq.sinajs.cn/list=${nf.map(encodeURIComponent).join(",")}`;
        const opts = { referer: "https://finance.sina.com.cn/futures/quotes/AU0.shtml" };
        let r;
        try {
          r = await retryOnEmpty(async () => parseSinaDomestic(await curlText(url, opts)));
        } catch (e) { console.error("[futures-nf]", url, e?.message || e); throw e; }
        // 夜盘期间 hq.sinajs.cn 最新价可能为0,从分钟线接口补实时价格
        for (const code of nf) {
          const item = r[code];
          if (!item || item.price > 0) continue;
          const symbol = code.slice(3);
          try {
            const text = await curlText(
              `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/InnerFuturesNewService.getMinLine?symbol=${symbol}`,
              { referer: `https://finance.sina.com.cn/futures/quotes/${symbol}.shtml`, encoding: "utf-8" }
            );
            const arr = parseJsonp(text);
            if (arr && arr.length && arr[0][1]) {
              const livePrice = num(arr[0][1]);
              if (livePrice > 0) {
                item.price = livePrice;
                item.change = changeOf(livePrice, item.prev);
                item.pct = pctOf(livePrice, item.prev);
              }
            }
          } catch { /* minLine 失败就保留现有值 */ }
        }
        Object.assign(out, r);
      })());
    }
    if (codes.includes("BTCUSDT")) {
      jobs.push((async () => {
        try {
          out.BTCUSDT = await fetchBtc();
        } catch { /* BTC 源全挂时不拖垮其他品种 */ }
      })());
    }
    await Promise.all(jobs);
    if (Object.keys(out).length === 0) throw new Error("futures blocked");
    return out;
  }

  /* ---------------- 大宗商品分钟线 ---------------- */
  function parseJsonp(text) {
    const a = text.indexOf("(");
    const b = text.lastIndexOf(")");
    if (a < 0 || b <= a) throw new Error("bad jsonp");
    return JSON.parse(text.slice(a + 1, b));
  }

  async function handleFutureMinute(code) {
    if (code === "BTCUSDT") {
      try {
        const [klines, ticker] = await Promise.all([
          fetchJsonAny(["https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=240"]),
          fetchJsonAny(["https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT"]),
        ]);
        const pts = klines.map((k) => ({ t: fmtHHMM(new Date(k[0])), p: num(k[4]) }));
        return { code, prec: num(ticker.prevClosePrice), points: pts };
      } catch (e) {
        // 上游故障抛错(走 cached 负缓存退避), 不返回空数据冒充成功;
        // 回显文案白名单化, 不携带上游 URL/网络细节
        throw Object.assign(new Error("binance btc minute unavailable"), { status: 502 });
      }
    }
    if (code.startsWith("hf_")) {
      const symbol = code.slice(3);
      const text = await curlText(
        `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/GlobalFuturesService.getGlobalFuturesMinLine?symbol=${symbol}`,
        { referer: `https://finance.sina.com.cn/futures/quotes/${symbol}.shtml`, encoding: "utf-8" }
      );
      const arr = parseJsonp(text)?.minLine_1d || [];
      const pts = arr.filter((f) => String(f[0]).includes(":")).map((f) => ({ t: f[0], p: num(f[1]) }));
      const q = parseFutures(await fetchText(quoteUrl(code), { gbk: true }));
      return { code, prec: q[code]?.prev || 0, points: pts };
    }
    if (code.startsWith("nf_")) {
      const symbol = code.slice(3);
      const referer = `https://finance.sina.com.cn/futures/quotes/${symbol}.shtml`;
      const text = await curlText(
        `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/InnerFuturesNewService.getMinLine?symbol=${symbol}`,
        { referer, encoding: "utf-8" }
      );
      const arr = parseJsonp(text) || [];
      const pts = arr.map((f) => ({ t: f[0], p: num(f[1]) }));
      const q = parseSinaDomestic(await curlText(`https://hq.sinajs.cn/list=${code}`, { referer }));
      return { code, prec: q[code]?.prev || 0, points: pts };
    }
    throw Object.assign(new Error(`bad code: ${code}`), { status: 400 });
  }

  /* ---------------- 期货日线K线(新浪 内盘nf_/外盘hf_, 全历史免费) ---------------- */
  async function handleFutureDaily(code, n = 400) {
    const isGlobal = code.startsWith("hf_");
    const symbol = code.replace(/^(nf_|hf_)/, "");
    if (!symbol || (!code.startsWith("nf_") && !isGlobal)) throw Object.assign(new Error(`bad code: ${code}`), { status: 400 });
    const api = isGlobal
      ? `GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=${encodeURIComponent(symbol)}`
      : `InnerFuturesNewService.getDailyKLine?symbol=${encodeURIComponent(symbol)}`;
    const text = await curlText(
      `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/${api}`,
      { referer: `https://finance.sina.com.cn/futures/quotes/${symbol}.shtml`, encoding: "utf-8" }
    );
    const arr = parseJsonp(text) || [];
    // 内盘字段 d/o/h/l/c/v; 外盘 date/open/high/low/close/volume, 归一化
    const pts = arr
      .map((k) => ({
        t: k.d || k.date,
        o: num(k.o ?? k.open),
        h: num(k.h ?? k.high),
        l: num(k.l ?? k.low),
        c: num(k.c ?? k.close),
        v: num(k.v ?? k.volume),
      }))
      .filter((p) => p.t && p.c);
    // 只回最近 n 根(页面最大区间 365d): 全历史传输量 10 倍于所需, 是大 payload 超时的根因
    return { code, points: pts.slice(-n) };
  }

  return { handleFutures, handleFutureMinute, handleFutureDaily };
};
