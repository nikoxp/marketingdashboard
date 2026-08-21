// 官网独立反馈(26) — 落盘 + page 白名单 + 校验复用单测 (node --test server/feedback.test.cjs)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { appendFeedback, normalizePage, PAGE_ALLOW } = require("./lib/feedback.cjs");
const { validateAssistant } = require("./lib/assistant.cjs");

test("page 白名单: blog/opc/company/home 通过, 未知忽略置 null（防 jsonl 注入）", () => {
  assert.equal(normalizePage("blog"), "blog");
  assert.equal(normalizePage("opc"), "opc");
  assert.equal(normalizePage("company"), "company");
  assert.equal(normalizePage("home"), "home"); // 0820-fb-3 首页悬浮反馈
  assert.equal(normalizePage("javascript:alert(1)"), null);
  assert.equal(normalizePage("blog\" ; rm -rf"), null);
  assert.equal(normalizePage("blog "), "blog"); // 首尾空白归一化
  assert.equal(normalizePage(""), null);
  assert.equal(normalizePage("   "), null);
  assert.equal(normalizePage(undefined), null);
  assert.equal(normalizePage(null), null);
  for (const p of PAGE_ALLOW) assert.equal(normalizePage(p), p);
});

test("校验复用 validateAssistant: question 必填 2-500 字符、contact 选填邮箱（同源单点规则）", () => {
  assert.equal(validateAssistant({ question: "测试反馈" }).ok, true);
  assert.equal(validateAssistant({ question: "测试反馈", contact: "test@example.com" }).ok, true);
  assert.equal(validateAssistant({}).ok, false); // question 必填
  assert.equal(validateAssistant({ question: "问" }).ok, false); // <2 字符
  assert.equal(validateAssistant({ question: "q".repeat(501) }).ok, false); // >500 字符
  assert.equal(validateAssistant({ question: "测试反馈", contact: "not-an-email" }).ok, false); // 坏邮箱
});

test("source 白名单: blog_feedback 通过（blog 悬浮反馈独立表单来源）", () => {
  assert.equal(validateAssistant({ question: "测试", source: "blog_feedback" }).value.source, "blog_feedback");
  // 0820-fb-3: 首页/opc 悬浮反馈来源（同一 SOURCE_ALLOW 扩展）
  assert.equal(validateAssistant({ question: "测试", source: "home_feedback" }).value.source, "home_feedback");
  assert.equal(validateAssistant({ question: "测试", source: "opc_feedback" }).value.source, "opc_feedback");
  assert.equal(validateAssistant({ question: "测试", source: "hacker\" ; rm -rf" }).value.source, null);
});

test("appendFeedback 追加落盘 feedback-messages.jsonl(ts/ip/page/question/contact/source)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-test-"));
  const rec = {
    ts: "2026-08-20T12:00:00.000Z", ip: "1.2.3.4", page: "blog",
    question: "测试反馈", contact: "test@example.com", source: "blog_feedback",
  };
  appendFeedback(dir, rec);
  // 第二条: 无 page 字段(未知页被忽略) —— page 不应出现
  appendFeedback(dir, { ts: "2026-08-20T12:05:00.000Z", ip: "1.2.3.4", question: "第二条" });
  const lines = fs.readFileSync(path.join(dir, "feedback-messages.jsonl"), "utf-8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.ts, "2026-08-20T12:00:00.000Z");
  assert.equal(first.ip, "1.2.3.4");
  assert.equal(first.page, "blog");
  assert.equal(first.question, "测试反馈");
  assert.equal(first.contact, "test@example.com");
  assert.equal(first.source, "blog_feedback");
  const second = JSON.parse(lines[1]);
  assert.equal(second.page, undefined); // 无 page 字段不落盘
  assert.equal(second.question, "第二条");
});
