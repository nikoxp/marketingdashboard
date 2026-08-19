// mrd 托管版 · 前端托管层
// 运行时探测 /api/hosting/config 区分「托管模式」vs「开源模式」:
// - 托管模式(HOSTING=1 后端启用): 未登录显示登录页, 登录后进看板; watchlist 走服务端(按租户隔离)
// - 开源模式(未启用): 该端点 404 → 直接看板, 行为与以往完全一致(零回归)
import { loadJson, saveJson } from "./storage";

const TOKEN_KEY = "mrd.hosting.token";

export function hostingToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setHostingToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

const timeoutSignal = (ms: number) => {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
};

async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, signal: timeoutSignal(10000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j.data as T;
}

function authed(path: string, init?: RequestInit): RequestInit {
  void path; // 参数仅为调用语义占位(与 jfetch 对齐), 实际无需拼接
  const token = hostingToken();
  return {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  };
}

/** 探测托管模式: /api/hosting/config 返回 enabled=true 即为托管实例(开源版 404 → false) */
export async function hostingEnabled(): Promise<boolean> {
  try {
    const r = await fetch("/api/hosting/config", { signal: timeoutSignal(5000) });
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    return j?.data?.enabled === true;
  } catch {
    return false;
  }
}

export interface HostingTenant {
  tenant_id: string;
  email: string;
  created_at?: string;
}

export function hostingRegister(email: string, password: string, inviteCode: string): Promise<{ token: string; tenant: HostingTenant }> {
  // 邀请码只进 register 请求体, 前端不落 localStorage、不进 bundle 产物之外任何持久化
  return jfetch("/api/hosting/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, invite_code: inviteCode }),
  });
}

export function hostingLogin(email: string, password: string): Promise<{ token: string; tenant: HostingTenant }> {
  return jfetch("/api/hosting/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
}

export function hostingLogout(): Promise<{ ok: boolean }> {
  // POST 需带 JSON body(分发层空 body 会 400), 发空对象即可
  return jfetch("/api/hosting/logout", authed("/api/hosting/logout", {
    method: "POST",
    body: JSON.stringify({}),
  }));
}

export function hostingMe(): Promise<{ tenant: HostingTenant }> {
  return jfetch("/api/hosting/me", authed("/api/hosting/me"));
}

/** 服务端自选股(按租户隔离): GET 读取 */
export function hostingWatchlist(): Promise<string[]> {
  return jfetch<{ codes: string[] }>("/api/hosting/watchlist", authed("/api/hosting/watchlist")).then((d) => d.codes);
}

/** 服务端自选股(按租户隔离): POST 覆盖写入 */
export function hostingWatchlistSave(codes: string[]): Promise<string[]> {
  return jfetch<{ codes: string[] }>("/api/hosting/watchlist", authed("/api/hosting/watchlist", {
    method: "POST",
    body: JSON.stringify({ codes }),
  })).then((d) => d.codes);
}

export interface HostingAiQuota {
  limit: number;
  used: number;
  remaining: number;
}

/** 本租户当日 AI 额度(0819-c P1-1): GET /api/hosting/ai-quota, 未登录 401 */
export function hostingAiQuota(): Promise<HostingAiQuota> {
  return jfetch<{ quota: HostingAiQuota }>("/api/hosting/ai-quota", authed("/api/hosting/ai-quota")).then((d) => d.quota);
}

/** 服务端面板布局(按租户隔离): GET 读取 — 整个对象 {页面key: zoomedId|null} 或 null */
export function hostingLayout(): Promise<Record<string, string | null> | null> {
  return jfetch<{ layout: Record<string, string | null> | null }>("/api/hosting/layout", authed("/api/hosting/layout"))
    .then((d) => d.layout);
}

/**
 * 服务端面板布局(按租户隔离): POST 写入 — 服务端按页面 key merge(只覆盖传入的 key,
 * 其他页面 key 保留), 返回写入后的完整对象。前端每页只管自己的 key, 多页互不覆盖。
 */
export function hostingLayoutSave(layout: Record<string, string | null>): Promise<Record<string, string | null>> {
  return jfetch<{ layout: Record<string, string | null> }>("/api/hosting/layout", authed("/api/hosting/layout", {
    method: "POST",
    body: JSON.stringify({ layout }),
  })).then((d) => d.layout);
}

/** 托管模式下的本地降级缓存(离线/服务端故障时兜底, 不跨租户泄漏: 随 token 隔离) */
const LS_CACHE_KEY = "mrd.hosting.watchlist.cache";

export function loadWatchlistCache(): string[] | null {
  const v = loadJson<string[] | null>(LS_CACHE_KEY, null);
  return Array.isArray(v) ? v : null;
}

export function saveWatchlistCache(codes: string[]): void {
  saveJson(LS_CACHE_KEY, codes);
}
