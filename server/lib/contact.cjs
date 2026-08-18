"use strict";
/**
 * 合作咨询提交（官网改版5）：字段校验 + 落盘 contact.jsonl
 * 与 demo/leads 同风格：校验逻辑抽成纯函数便于单测（node --test server/*.test.cjs）
 * 落盘: data/contact.jsonl 追加模式，一行一条 JSON，含时间戳 + IP
 */
const fs = require("fs");
const path = require("path");

// 意向类型白名单（与前端下拉一致；新增类型两处同步）
const INTENTS = ["cooperation", "consult", "feedback", "other"];
const NAME_MAX = 50; // 姓名限长（字符）

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 手机号: 国际格式(可带 + 前缀, 8-15 位数字) —— 兼容 +86 中国手机与海外号码
const PHONE_RE = /^\+?[1-9]\d{7,14}$/;

/**
 * 校验合作咨询提交
 * @param {any} body POST JSON body
 * @returns {{ok:true, value:{name:string, contact:string, intent:string}} | {ok:false, error:string}}
 */
function validateContact(body) {
  const name = String(body && body.name || "").trim();
  const contact = String(body && body.contact || "").trim();
  const intent = String(body && body.intent || "").trim();
  if (!name) return { ok: false, error: "name required" };
  if (name.length > NAME_MAX) return { ok: false, error: "name too long" };
  if (!EMAIL_RE.test(contact) && !PHONE_RE.test(contact)) return { ok: false, error: "invalid contact" };
  if (!INTENTS.includes(intent)) return { ok: false, error: "invalid intent" };
  return { ok: true, value: { name, contact, intent } };
}

/**
 * 追加写入 contact.jsonl（不写 state.json，避免污染透明办公室状态）
 * @param {string} dataDir server/data 目录
 * @param {object} rec 完整记录（含 ts/ip）
 * @returns {object} 落盘记录
 */
function appendContact(dataDir, rec) {
  const file = path.join(dataDir, "contact.jsonl");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + "\n");
  return rec;
}

module.exports = { validateContact, appendContact, INTENTS, NAME_MAX };
