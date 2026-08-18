// 官网合作咨询(改版5) — 字段校验 + 落盘单测 (node --test server/contact.test.cjs)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { validateContact, appendContact, INTENTS } = require("./lib/contact.cjs");

test("合法提交通过: 邮箱联系方式", () => {
  const v = validateContact({ name: "张三", contact: "zhang@example.com", intent: "cooperation" });
  assert.equal(v.ok, true);
  assert.deepEqual(v.value, { name: "张三", contact: "zhang@example.com", intent: "cooperation" });
});

test("合法提交通过: 手机联系方式(含 +86 与 1xx 国内)", () => {
  assert.equal(validateContact({ name: "李四", contact: "13800138000", intent: "consult" }).ok, true);
  assert.equal(validateContact({ name: "李四", contact: "+8613800138000", intent: "feedback" }).ok, true);
});

test("空姓名被拒", () => {
  const v = validateContact({ name: "   ", contact: "a@b.com", intent: "other" });
  assert.equal(v.ok, false);
  assert.equal(v.error, "name required");
});

test("姓名超长被拒(>50 字符)", () => {
  const v = validateContact({ name: "名".repeat(51), contact: "a@b.com", intent: "other" });
  assert.equal(v.ok, false);
  assert.equal(v.error, "name too long");
});

test("坏邮箱/坏手机被拒", () => {
  // 3位/17位/含字母/无@的串 都不是合法邮箱或手机(国际 7-14 位数字, 可带 + 前缀)
  for (const bad of ["not-an-email", "a@b", "abc", "123", "138001380001234567", "+8613800x"]) {
    const v = validateContact({ name: "张三", contact: bad, intent: "other" });
    assert.equal(v.ok, false, `应拒绝 contact=${bad}`);
    assert.equal(v.error, "invalid contact");
  }
  // 边界: 7 位非法(总长需 8-15), 8 位与 14 位(+前缀后 15 总长)合法
  assert.equal(validateContact({ name: "张三", contact: "1234567", intent: "other" }).ok, false);
  assert.equal(validateContact({ name: "张三", contact: "12345678", intent: "other" }).ok, true);
  assert.equal(validateContact({ name: "张三", contact: "+12345678901234", intent: "other" }).ok, true);
});

test("意向类型必须白名单枚举", () => {
  assert.equal(validateContact({ name: "张三", contact: "a@b.com", intent: "hack" }).ok, false);
  assert.equal(validateContact({ name: "张三", contact: "a@b.com", intent: "" }).ok, false);
  assert.equal(validateContact({ name: "张三", contact: "a@b.com" }).ok, false);
  for (const it of INTENTS) {
    assert.equal(validateContact({ name: "张三", contact: "a@b.com", intent: it }).ok, true, `intent=${it} 应在白名单`);
  }
});

test("appendContact 追加落盘 contact.jsonl(含时间戳/IP)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "contact-test-"));
  const rec = { ts: "2026-08-17T12:00:00.000Z", ip: "1.2.3.4", name: "王五", contact: "w@example.com", intent: "cooperation" };
  appendContact(dir, rec);
  appendContact(dir, { ...rec, ts: "2026-08-17T12:05:00.000Z", name: "赵六" });
  const lines = fs.readFileSync(path.join(dir, "contact.jsonl"), "utf-8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.ts, "2026-08-17T12:00:00.000Z");
  assert.equal(first.ip, "1.2.3.4");
  assert.equal(first.name, "王五");
  assert.equal(first.intent, "cooperation");
  fs.rmSync(dir, { recursive: true, force: true });
});
