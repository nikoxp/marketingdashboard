// 博客阅读量(0818) — 幂等计数/365 天过期/批量查询/vid 哈希 单测 (node --test server/blog-views.test.cjs)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  loadViews, saveViews, recordView, viewsFor, vidKey, VIEWS_KEEP_MS,
} = require("./lib/blog.cjs");

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blog-views-test-"));
  return path.join(dir, "blog-views.json");
}

test("无文件时 loadViews 返回空对象", () => {
  assert.deepEqual(loadViews(path.join(os.tmpdir(), "nonexist-" + Date.now() + ".json")), {});
});

test("recordView: 同 vid 幂等 — 只计 1 次, 重复访问 added=false", () => {
  const views = {};
  const r1 = recordView(views, "post-1", "vidhash-a");
  assert.deepEqual(r1, { count: 1, added: true });
  const r2 = recordView(views, "post-1", "vidhash-a");
  assert.deepEqual(r2, { count: 1, added: false }); // 同 vid 再刷不虚增
  assert.equal(views["post-1"].count, 1);
});

test("recordView: 不同 vid 累计, 不同 post 独立计数", () => {
  const views = {};
  recordView(views, "post-1", "vidhash-a");
  recordView(views, "post-1", "vidhash-b");
  recordView(views, "post-2", "vidhash-a");
  assert.equal(views["post-1"].count, 2);
  assert.equal(views["post-2"].count, 1);
});

test("recordView: seen 过期清理(365 天)后同 vid 重新计数", () => {
  const views = {
    "post-1": { count: 1, seen: { "old": Date.now() - VIEWS_KEEP_MS - 1000 } },
  };
  const r = recordView(views, "post-1", "old");
  assert.equal(r.count, 2); // 过期 key 被清掉, 重新计数
  assert.equal(r.added, true);
  assert.equal(Object.keys(views["post-1"].seen).length, 1);
});

test("viewsFor: 批量查询, 无记录返回 0", () => {
  const views = { "a": { count: 5, seen: {} }, "b": { count: 2, seen: {} } };
  assert.deepEqual(viewsFor(views, ["a", "b", "c"]), { a: 5, b: 2, c: 0 });
  assert.deepEqual(viewsFor(views, []), {});
});

test("vidKey: 合法 vid 哈希稳定(仅存哈希不存原始值, Gavin 红线)", () => {
  const k1 = vidKey("gavinlab-visit-abc123");
  const k2 = vidKey("gavinlab-visit-abc123");
  assert.equal(k1, k2);
  assert.equal(k1.length, 32); // sha256 截断 32 hex
  assert.ok(!k1.includes("gavinlab"), "不得包含原始 vid");
});

test("vidKey: 非法/缺失 vid 返回 null(调用方按 IP 兜底)", () => {
  assert.equal(vidKey(""), null);
  assert.equal(vidKey(undefined), null);
  assert.equal(vidKey(null), null);
  assert.equal(vidKey("short"), null); // <8
  assert.equal(vidKey("x".repeat(65)), null); // >64
  assert.equal(vidKey("has space 12345678"), null); // 非法字符
});

test("saveViews 原子落盘 + 重载一致", () => {
  const file = tmpFile();
  const views = { "p": { count: 3, seen: { k: Date.now() } } };
  saveViews(file, views);
  assert.equal(fs.existsSync(file + ".tmp"), false);
  assert.deepEqual(loadViews(file), views);
});
