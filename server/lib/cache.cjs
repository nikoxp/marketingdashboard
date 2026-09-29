// 内存缓存 — 有界 LRU 风格 Map + 定时清扫 + 失败退避 + 负缓存
// 统一实现: cached()/backoffOf(路由层) 与 tencent.cjs 第二、三套退避/负缓存(quoteBackoff/条目工厂)同源
"use strict";

const CACHE_MAX = 2000;

// 通用失败退避: 连续失败次数 → 退避毫秒(指数增长, 上限 5 分钟)
const backoffOf = (n) => Math.min(300000, 1000 * 2 ** (n || 0));

// 报价通道退避(腾讯行情历史语义): 5s → 15s → 45s → 2min, 成功即复位。
// 退避窗口内同 key 不再打上游(负缓存), 多用户场景下上游宕机时全站重复轮询折叠为每窗口 1 次
const FAIL_BACKOFF = [5000, 15000, 45000, 120000];
const quoteBackoff = (n) => FAIL_BACKOFF[Math.min(n || 0, FAIL_BACKOFF.length - 1)];

// 命名 TTL(ms): 各数据源缓存键的统一刷新周期, 集中管理避免散落魔法数字
const TTLS = {
  QUOTE: 5000,        // 报价: 与前端报价中心 5s 轮询对齐, 每个 code 每 5s 最多 1 次上游
  STOCK_FLOW: 30000,  // 个股资金流(按 code)
};

// 缓存条目工厂: 统一 { ts, data, inflight, ttl, failAt, failCount } 形状
const entry = (data, ttl) => ({ ts: Date.now(), data, inflight: null, ttl, failAt: null, failCount: 0 });

// 失败条目: 记录 failAt/failCount, 保留旧数据供退避窗口内降级返回
const failEntry = (prev, ttl) => ({ ts: prev?.ts || 0, data: prev?.data, inflight: null, ttl, failAt: Date.now(), failCount: (prev?.failCount || 0) + 1 });

function createCache() {
  const cache = new Map(); // key -> { ts, data, inflight, ttl, failAt, failCount }

  function sweep() {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (v.inflight) continue;
      const inBackoff = v.failAt != null && now - v.failAt < backoffOf(v.failCount);
      if (v.data === undefined || (now - v.ts > (v.ttl || 60000) && !inBackoff)) cache.delete(k);
    }
  }

  // 写缓存: 超限先清过期项, 仍超则按 Map 插入序淘汰最旧条目
  function set(key, e) {
    if (cache.has(key)) cache.delete(key); // 重插以刷新插入序
    cache.set(key, e);
    if (cache.size <= CACHE_MAX) return;
    sweep();
    while (cache.size > CACHE_MAX) {
      let oldest;
      for (const [k, v] of cache) {
        if (!v.inflight) { oldest = k; break; }
      }
      if (oldest === undefined) break; // 全部在途, 不再淘汰
      cache.delete(oldest);
    }
  }

  /** 读+写合一(路由层缓存, 带新鲜度): 新鲜命中 / inflight 合并 / 退避降级或负缓存;
      失败写回 failAt/failCount, 有旧数据降级返回(stale=true + ts=旧数据时间), 无旧数据抛错。
      stale 只描述"本次返回值是否来自旧数据"(上游失败降级), 与数据源自身口径无关 */
  async function cachedMeta(key, ttl, fn) {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit) {
      if (hit.data !== undefined && now - hit.ts < (hit.ttl ?? ttl)) return { data: hit.data, ts: hit.ts, stale: false };
      if (hit.inflight) return hit.inflight; // 在途请求: 直接复用其结果(inflight 已解析为 { data, ts, stale })
      // 失败退避窗口内: 有旧数据降级返回, 无旧数据直接抛错 — 都不再打上游(负缓存)
      if (hit.failAt != null && now - hit.failAt < backoffOf(hit.failCount)) {
        if (hit.data !== undefined) return { data: hit.data, ts: hit.ts, stale: true };
        throw new Error("upstream degraded");
      }
    }
    const inflight = fn()
      .then((data) => {
        // fn 可返回 {__ttl, ...data} 覆盖缓存 TTL(降级/快照数据用短 TTL, 过期后重试上游)
        const effTtl = data && typeof data === "object" && data.__ttl ? data.__ttl : ttl;
        const store = data && typeof data === "object" && data.__ttl ? { ...data } : data;
        if (store && typeof store === "object" && "__ttl" in store) delete store.__ttl;
        set(key, entry(store, effTtl));
        return { data: store, ts: Date.now(), stale: false };
      })
      .catch((e) => {
        const c = cache.get(key);
        set(key, failEntry(c, ttl));
        if (c?.data !== undefined) return { data: c.data, ts: c.ts, stale: true }; // 出错回退到旧数据
        throw e;
      });
    set(key, { ts: hit?.ts || 0, data: hit?.data, inflight, ttl, failAt: hit?.failAt ?? null, failCount: hit?.failCount ?? 0 });
    return inflight;
  }

  /** 旧签名(仅取值): 绝大多数路由不需要新鲜度, 行为与改造前逐字节一致 */
  async function cached(key, ttl, fn) {
    return (await cachedMeta(key, ttl, fn)).data;
  }

  const sweeper = setInterval(sweep, 60000);
  sweeper.unref();

  return { cache, set, sweep, backoffOf, cached, cachedMeta, quoteBackoff, entry, failEntry, TTLS };
}

module.exports = { createCache, backoffOf, quoteBackoff, entry, failEntry, TTLS, CACHE_MAX };
