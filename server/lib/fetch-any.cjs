// 统一上游数据通道 — fetch/curl 双通道 + 重试 + 节流 + 状态码校验 + 可选代理
// 收敛 index.cjs / eastmoney.cjs / futures.cjs 中 5 份重复的 fetch→curl 兜底模板
"use strict";

const iconv = require("iconv-lite");
const { execFile } = require("child_process");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 代理解析优先级: 显式 proxy 参数 > MRD_PROXY > HTTPS_PROXY > https_proxy。
// 未配置任何代理时返回 ""(直连)。当前 mrd 环境无代理变量 → 现有直连调用方行为零变化;
// 将来托管部署可设 MRD_PROXY/HTTPS_PROXY 统一走代理(方案B 通用性)。
const resolveProxy = (opt) => {
  if (typeof opt === "string" && opt) return opt;
  return process.env.MRD_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || "";
};

// curl 参数拼装(纯函数, 可单测): 代理时加 -x <proxy>(HTTPS 走 CONNECT 隧道), 放 url 之前
function buildCurlArgs({ url, referer, headers, proxy, timeoutSec }) {
  const args = ["-sS", "-f", "--max-time", String(timeoutSec), "-H", `User-Agent: ${UA}`];
  if (referer) args.push("-H", `Referer: ${referer}`);
  for (const [k, v] of Object.entries(headers || {})) args.push("-H", `${k}: ${v}`);
  if (proxy) args.push("-x", proxy);
  args.push(url);
  return args;
}

module.exports = function createFetchAny({ onUpstream } = {}) {
  const count = () => { if (onUpstream) onUpstream(); };

  /** curl 通道: TLS 指纹敏感 / 被 node fetch 拦截的上游兜底。
      -f: 4xx/5xx 以非零码退出并携带 stderr 详情(使 5xx 也落入上层退避/负缓存路径)
      proxy: 配置后加 -x(直连被墙的上游如 Binance/OKX 走本机 sing-box 代理) */
  function curlText(url, { referer, timeout = 8000, encoding = "gbk", headers, proxy } = {}) {
    count(); // 上游调用计数(fetchText/curlText 是所有上游 fetch 的唯一出口)
    return new Promise((resolve, reject) => {
      // -sS: 静默进度但保留错误信息到 stderr, 失败原因可诊断(28=超时, 35=TLS握手, 6=DNS...)
      const args = buildCurlArgs({ url, referer, headers, proxy: resolveProxy(proxy), timeoutSec: Math.ceil(timeout / 1000) });
      execFile("curl", args, { maxBuffer: 4 * 1024 * 1024, encoding: "buffer" }, (err, stdout, stderr) => {
        if (err) {
          const detail = stderr && stderr.length ? String(stderr).trim().slice(0, 200) : err.message;
          return reject(new Error(`curl(${err.code ?? "?"}) ${url} -> ${detail}`));
        }
        resolve(iconv.decode(stdout, encoding));
      });
    });
  }

  /** fetch 通道: 带 UA / 超时 / 编码解码。
      resp.ok 校验 — 非 2xx 一律抛错, 使文本端点 5xx 也落入上层退避/负缓存路径。
      proxy: node 内置 fetch 不支持代理 → 配置代理时直接改走 curl -x */
  async function fetchText(url, { referer, gbk = false, timeout = 8000, headers, proxy } = {}) {
    count();
    const px = resolveProxy(proxy);
    if (px) return curlText(url, { referer, timeout, encoding: gbk ? "gbk" : "utf-8", headers, proxy: px });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const h = { "User-Agent": UA, Accept: "*/*", ...headers };
      if (referer) h["Referer"] = referer;
      const resp = await fetch(url, { headers: h, signal: ctrl.signal });
      if (!resp.ok) throw new Error(`upstream http ${resp.status} ${url}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      return gbk ? iconv.decode(buf, "gbk") : buf.toString("utf-8");
    } finally {
      clearTimeout(timer);
    }
  }

  /** 参数化双通道: 每轮按 hosts 换主机 × fetch→curl, retries 为额外轮数。
      decode: "utf-8" | "gbk"(覆盖 gbk 标志); throttle: 成功节流 { ok } / 失败间隔 { err };
      accept(text): 仅通过校验的响应才算成功(处理"HTTP 成功但内容为空"的翻页校验);
      proxy: 配置后跳过 fetch 通道仅走 curl -x(node fetch 无法代理, 直连被墙的上游只能走 curl) */
  async function fetchWithFallback(url, {
    referer, gbk = false, timeout = 8000, headers,
    retries = 0, hosts = [], decode, throttle = 0, accept, proxy,
  } = {}) {
    const enc = decode || (gbk ? "gbk" : "utf-8");
    const th = typeof throttle === "number" ? { ok: throttle, err: throttle } : throttle || {};
    const px = resolveProxy(proxy);
    const vias = px ? ["curl"] : ["fetch", "curl"]; // 代理场景跳过 fetch 通道
    const roundUrls = [
      url,
      ...hosts.map((h) => { const u = new URL(url); u.host = h; return u.href; }),
    ];
    let lastErr = new Error("upstream unreachable");
    for (let round = 0; round <= Math.max(0, retries); round++) {
      for (const u of roundUrls) {
        for (const via of vias) {
          try {
            const text = via === "fetch"
              ? await fetchText(u, { referer, gbk: enc === "gbk", timeout, headers })
              : await curlText(u, { referer, timeout, encoding: enc, headers, proxy: px });
            if (accept && !accept(text)) throw new Error("empty upstream response");
            if (th.ok) await sleep(th.ok); // 成功节流(东财 WAF)
            return text;
          } catch (e) {
            lastErr = e;
            if (th.err) await sleep(th.err); // 失败间隔
          }
        }
      }
    }
    throw lastErr;
  }

  // 单通道语义的 fetch → curl 兜底(fetchTextAny 历史命名, 无 hosts/重试/节流)
  const fetchTextAny = (url, opts) => fetchWithFallback(url, opts);

  return { fetchText, curlText, fetchTextAny, fetchWithFallback, UA, buildCurlArgs };
};

// 纯函数挂工厂上: 单测可直接 require 后解构 { buildCurlArgs }
module.exports.buildCurlArgs = buildCurlArgs;
