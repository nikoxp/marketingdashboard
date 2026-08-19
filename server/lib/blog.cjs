// 博客评论 + 阅读量存储 (0818: blog 评论/回复 + 阅读量统计)
// 设计: 纯函数 + 显式传 file/state, 便于单测; 持久化走 tmp+rename 原子写(与 /api/visits 同款)。
"use strict";
const crypto = require("crypto");

const POST_ID_MAX_LEN = 64;
const AUTHOR_MAX_LEN = 30;
const CONTENT_MAX_LEN = 800;
// 阅读量 seen 保留窗口 — 与 index.cjs 的 VISITS_KEEP_MS(365 天) 同口径
const VIEWS_KEEP_MS = 365 * 24 * 3600 * 1000;

/* ---------------- 评论 ---------------- */

function loadComments(file) {
  try {
    const raw = JSON.parse(require("fs").readFileSync(file, "utf-8"));
    if (raw && Array.isArray(raw.comments)) return raw.comments;
  } catch (e) { /* 首启无文件 */ }
  return [];
}

// tmp+rename 原子写, 防并发写坏(与 saveVisits 同款)
function saveComments(file, comments) {
  const tmp = file + ".tmp";
  require("fs").writeFileSync(tmp, JSON.stringify({ comments }));
  require("fs").renameSync(tmp, file);
}

// 校验评论 body; 返回 {ok:true, value:{post_id,parent_id,author,content}} 或 {ok:false, error}
// parent_id: 可选, 非空则校验存在且属于同一 post(防跨文章挂回复)
function validateComment(body, comments) {
  const post_id = String((body && body.post_id) || "").trim();
  const author = String((body && body.author) || "").trim();
  const content = String((body && body.content) || "").trim();
  const parentRaw = body && body.parent_id != null ? String(body.parent_id).trim() : "";
  if (!post_id || post_id.length > POST_ID_MAX_LEN) return { ok: false, error: "invalid post_id" };
  if (!author || author.length > AUTHOR_MAX_LEN) return { ok: false, error: "invalid author" };
  if (!content || content.length > CONTENT_MAX_LEN) return { ok: false, error: "invalid content" };
  let parent_id = null;
  if (parentRaw) {
    const parent = comments.find((c) => String(c.id) === parentRaw);
    if (!parent) return { ok: false, error: "invalid parent_id" };
    if (parent.post_id !== post_id) return { ok: false, error: "invalid parent_id" };
    parent_id = parent.id;
  }
  return { ok: true, value: { post_id, parent_id, author, content } };
}

// admin 判定: body.admin_key === 环境变量 BLOG_ADMIN_KEY; 未配置则恒 false
function isAdmin(body) {
  const key = process.env.BLOG_ADMIN_KEY;
  if (!key) return false;
  return String((body && body.admin_key) || "") === key;
}

// id 自增 + created_at ISO 本地时间(带时区偏移), 返回新评论对象
function addComment(comments, value, admin) {
  const id = comments.reduce((m, c) => Math.max(m, c.id || 0), 0) + 1;
  const rec = {
    id,
    post_id: value.post_id,
    parent_id: value.parent_id,
    author: value.author,
    content: value.content,
    created_at: localISO(new Date()),
    admin: !!admin,
  };
  comments.push(rec);
  return rec;
}

function localISO(d) {
  const p = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = p(Math.abs(off) / 60 | 0);
  const om = p(Math.abs(off) % 60);
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) +
    "." + String(d.getMilliseconds()).padStart(3, "0") + sign + oh + ":" + om;
}

// 评论频控: 同 key(vid, 空则 IP) windowMs 内限 1 条; 内存 Map + 定时清理
function makeCommentRateLimiter(windowMs) {
  const hits = new Map(); // key -> lastTs
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, t] of hits) if (t < cutoff) hits.delete(k);
  }, Math.min(windowMs, 30000));
  sweeper.unref();
  return (key) => {
    const now = Date.now();
    const last = hits.get(key);
    if (last != null && now - last < windowMs) return false;
    hits.set(key, now);
    return true;
  };
}

/* ---------------- 阅读量 ---------------- */

// {views: {post_id: {count, seen: {vidHash: ts}}}}
function loadViews(file) {
  try {
    const raw = JSON.parse(require("fs").readFileSync(file, "utf-8"));
    if (raw && raw.views) return raw.views;
  } catch (e) { /* 首启无文件 */ }
  return {};
}

function saveViews(file, views) {
  const tmp = file + ".tmp";
  require("fs").writeFileSync(tmp, JSON.stringify({ views }));
  require("fs").renameSync(tmp, file);
}

// 幂等计数: 同 key 每篇 365 天内只计 1 次(与 /api/visits 的 seen 语义同款),
// 返回 {count: 该篇累计, added: 本次是否新增(未变则调用方不必写盘)}
function recordView(views, post_id, key) {
  const v = views[post_id] || (views[post_id] = { count: 0, seen: {} });
  const now = Date.now();
  // 过期清理(365 天前), 防文件无限膨胀
  for (const k of Object.keys(v.seen)) {
    if (v.seen[k] < now - VIEWS_KEEP_MS) delete v.seen[k];
  }
  let added = false;
  if (!v.seen[key]) {
    v.seen[key] = now;
    v.count += 1;
    added = true;
  }
  return { count: v.count, added };
}

// 批量查询: ids -> {id: count}, 无记录返回 0
function viewsFor(views, ids) {
  const out = {};
  for (const id of ids) {
    out[id] = views[id] ? views[id].count : 0;
  }
  return out;
}

// vid 哈希(只存哈希不存原始值, Gavin 红线: 不采集个人信息); 无合法 vid 返回 null(由调用方按 IP 兜底)
function vidKey(vid) {
  if (typeof vid === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(vid)) {
    return crypto.createHash("sha256").update("vid:" + vid).digest("hex").slice(0, 32);
  }
  return null;
}

module.exports = {
  POST_ID_MAX_LEN, AUTHOR_MAX_LEN, CONTENT_MAX_LEN, VIEWS_KEEP_MS,
  loadComments, saveComments, validateComment, isAdmin, addComment, localISO,
  makeCommentRateLimiter, loadViews, saveViews, recordView, viewsFor, vidKey,
};
