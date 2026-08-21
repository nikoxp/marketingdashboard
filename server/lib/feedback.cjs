"use strict";
/**
 * 官网独立反馈（26，0820 Gavin 拍板）: 落盘 feedback-messages.jsonl
 * 悬浮反馈按钮用独立反馈表单，不复用 AI 助理弹窗/问答链路（不调 LLM、无意向判定、无 lead_id），
 * 不并入 assistant-leads.jsonl；question/contact 校验复用 lib/assistant.cjs 的 validateAssistant
 * （规则同源单点维护），source 沿用 SOURCE_ALLOW 白名单（blog_feedback 已允许）。
 * 落盘: data/feedback-messages.jsonl 追加模式，一行一条 JSON，字段 {ts, ip, page?, question, contact, source}
 */
const fs = require("fs");
const path = require("path");

// 页面白名单（与前端页面标识一致；未知忽略防 jsonl 注入，与 SOURCE_ALLOW 同思路）
// blog/opc/company 本卡(26)立项时定义；home 为 0820-fb-3 首页悬浮反馈预留（同白名单扩展）
const PAGE_ALLOW = new Set(["blog", "opc", "company", "home"]);

/**
 * 归一化 page: 白名单命中返回原值, 未知/空返回 null(不落盘防注入)
 * @param {any} p body.page
 * @returns {string|null}
 */
function normalizePage(p) {
  const s = String(p || "").trim();
  return s && PAGE_ALLOW.has(s) ? s : null;
}

/**
 * 追加落盘 feedback-messages.jsonl（仿 appendAssistantLead/appendContact 模式）
 * @param {string} dataDir server/data 目录
 * @param {object} rec 完整记录（含 ts/ip/question/contact，page/source 可选）
 * @returns {object} 落盘记录
 */
function appendFeedback(dataDir, rec) {
  const file = path.join(dataDir, "feedback-messages.jsonl");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + "\n");
  return rec;
}

module.exports = { appendFeedback, normalizePage, PAGE_ALLOW };
