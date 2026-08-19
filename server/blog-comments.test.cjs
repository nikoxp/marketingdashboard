// 博客评论(0818) — 校验/admin 判定/频控/原子落盘/树形回复 单测 (node --test server/blog-comments.test.cjs)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  loadComments, saveComments, validateComment, isAdmin, addComment,
  makeCommentRateLimiter, POST_ID_MAX_LEN, AUTHOR_MAX_LEN, CONTENT_MAX_LEN,
} = require("./lib/blog.cjs");

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blog-comments-test-"));
  return path.join(dir, "blog-comments.json");
}

test("无文件时 loadComments 返回空数组", () => {
  assert.deepEqual(loadComments(path.join(os.tmpdir(), "nonexist-" + Date.now() + ".json")), []);
});

test("saveComments 原子落盘 + 重新 load 一致 (tmp+rename)", () => {
  const file = tmpFile();
  saveComments(file, [
    { id: 1, post_id: "p1", parent_id: null, author: "a", content: "hello", created_at: "2026-08-18T10:00:00.000+08:00", admin: false },
  ]);
  // tmp 文件不应残留
  assert.equal(fs.existsSync(file + ".tmp"), false);
  const loaded = loadComments(file);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].content, "hello");
});

test("validateComment: 合法提交通过", () => {
  const v = validateComment({ post_id: "p1", author: "张三", content: "好文章！" }, []);
  assert.equal(v.ok, true);
  assert.deepEqual(v.value, { post_id: "p1", parent_id: null, author: "张三", content: "好文章！" });
});

test("validateComment: post_id 必填/超长被拒", () => {
  assert.equal(validateComment({ author: "a", content: "x" }, []).ok, false);
  assert.equal(validateComment({ post_id: "  ", author: "a", content: "x" }, []).ok, false);
  assert.equal(validateComment({ post_id: "p".repeat(POST_ID_MAX_LEN + 1), author: "a", content: "x" }, []).ok, false);
  assert.equal(validateComment({ post_id: "p".repeat(POST_ID_MAX_LEN), author: "a", content: "x" }, []).ok, true);
});

test("validateComment: author 必填/超长被拒(中文按字符)", () => {
  assert.equal(validateComment({ post_id: "p", content: "x" }, []).ok, false);
  assert.equal(validateComment({ post_id: "p", author: "   ", content: "x" }, []).ok, false);
  assert.equal(validateComment({ post_id: "p", author: "张".repeat(AUTHOR_MAX_LEN + 1), content: "x" }, []).ok, false);
  assert.equal(validateComment({ post_id: "p", author: "张".repeat(AUTHOR_MAX_LEN), content: "x" }, []).ok, true);
});

test("validateComment: content 必填/超长被拒(边界恰好 max 允许)", () => {
  assert.equal(validateComment({ post_id: "p", author: "a" }, []).ok, false);
  assert.equal(validateComment({ post_id: "p", author: "a", content: "  " }, []).ok, false);
  assert.equal(validateComment({ post_id: "p", author: "a", content: "x".repeat(CONTENT_MAX_LEN + 1) }, []).ok, false);
  assert.equal(validateComment({ post_id: "p", author: "a", content: "x".repeat(CONTENT_MAX_LEN) }, []).ok, true);
});

test("validateComment: parent_id 可选 — 不存在/跨文章被拒, 存在同文章通过", () => {
  const existing = [
    { id: 7, post_id: "p1", parent_id: null, author: "a", content: "root", created_at: "2026-08-18T10:00:00.000+08:00", admin: false },
  ];
  // 不存在
  const bad = validateComment({ post_id: "p1", author: "b", content: "hi", parent_id: "999" }, existing);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "invalid parent_id");
  // 跨文章
  const cross = validateComment({ post_id: "p2", author: "b", content: "hi", parent_id: "7" }, existing);
  assert.equal(cross.ok, false);
  // 合法
  const good = validateComment({ post_id: "p1", author: "b", content: "hi", parent_id: "7" }, existing);
  assert.equal(good.ok, true);
  assert.equal(good.value.parent_id, 7);
});

test("addComment: id 自增 + created_at ISO 本地时间(带时区偏移) + admin 透传", () => {
  const comments = [{ id: 3, post_id: "p", parent_id: null, author: "a", content: "x", created_at: "2026-08-18T10:00:00.000+08:00", admin: false }];
  const rec = addComment(comments, { post_id: "p", parent_id: null, author: "b", content: "回复" }, true);
  assert.equal(rec.id, 4);
  assert.equal(rec.post_id, "p");
  assert.equal(rec.admin, true);
  assert.match(rec.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  assert.equal(comments.length, 2);
});

test("isAdmin: 未配置 BLOG_ADMIN_KEY 恒 false", () => {
  delete process.env.BLOG_ADMIN_KEY;
  assert.equal(isAdmin({ admin_key: "anything" }), false);
  assert.equal(isAdmin({}), false);
});

test("isAdmin: 配置后仅完全匹配为 true", () => {
  process.env.BLOG_ADMIN_KEY = "secret-key-123";
  try {
    assert.equal(isAdmin({ admin_key: "secret-key-123" }), true);
    assert.equal(isAdmin({ admin_key: "secret-key-124" }), false);
    assert.equal(isAdmin({}), false);
    assert.equal(isAdmin({ admin_key: "SECRET-KEY-123" }), false); // 大小写敏感
  } finally {
    delete process.env.BLOG_ADMIN_KEY;
  }
});

test("makeCommentRateLimiter: 同 key 窗口内限 1 条, 超时窗口后放行", () => {
  const limiter = makeCommentRateLimiter(200);
  assert.equal(limiter("vid-abc"), true);
  assert.equal(limiter("vid-abc"), false); // 60s 窗口内第二次 → 拒
  assert.equal(limiter("vid-other"), true); // 不同 key 不受影响
  return new Promise((resolve) => setTimeout(() => {
    assert.equal(limiter("vid-abc"), true); // 窗口过期后放行
    resolve();
  }, 250));
});

test("saveComments 落盘后内容与内存一致(持久化冒烟)", () => {
  const file = tmpFile();
  const comments = [];
  addComment(comments, { post_id: "p1", parent_id: null, author: "A", content: "first" }, false);
  saveComments(file, comments);
  const reloaded = loadComments(file);
  assert.equal(reloaded[0].author, "A");
  assert.equal(reloaded[0].content, "first");
});
