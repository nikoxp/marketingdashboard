"use strict";
/**
 * 官网 AI 助理（P0，0818-a）：校验 + 意向判定 + LLM 回复 + 落盘 assistant-leads.jsonl
 *
 * 链路：访客在官网提交问题/意向 → AI 基于公司知识库回复 → INTENT_KEYWORDS 命中
 *      → 落盘（含邮箱以外的个人信息不落盘红线：只存 email，不存姓名/电话）
 *      → assistant_lead_register.py cron 登记 state.json leads[] → kanban 建卡派温雯。
 *
 * 话术红线（硬约束，违反即违规）：
 *   - 托管版/付费版/SaaS 一律「筹备中，以官网公布为准」，绝不报价/不承诺上线时间/不接受预定
 *   - 不主动推销付费；可告知开源版免费公开、可自行部署
 *   - 回答简短、口语化、用「我们」
 *   - 不知道的不编造，引导看官网或留联系方式
 */
const fs = require("fs");
const path = require("path");

const QUESTION_MAX = 500; // 问题限长（字符，防注入/防烧 token）
const QUESTION_MIN = 2;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 来源白名单（0818-aa: demo 报告页 CTA 提问带 source=demo_report 落盘区分漏斗来源；
// 未知来源字段一律忽略，防 jsonl 被注入任意字符串）
const SOURCE_ALLOW = new Set(["demo_report"]);

// 意向关键词（与 linjing_monitor.py INTENT_KEYWORDS 同源，four-platform-monitor 判定口径）
// 0819-z: 补充「试用/trial」（决议第 7 项点名命中词），两处词表保持同步
const INTENT_KEYWORDS = [
  "托管", "付费", "多少钱", "价格", "部署", "能部署", "自托管", "收费", "购买", "订阅", "试用",
  "host", "hosting", "hosted", "paid", "price", "pricing", "pay", "deploy", "self-host",
  "selfhost", "how much", "subscribe", "license", "cost", "trial",
];

/** OpenRouter 模型（复用 server/.env 的 OPENROUTER_API_KEY，低成本模型） */
const OR_MODEL = "deepseek/deepseek-chat-v3-0324";
const OR_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const LLM_TIMEOUT_MS = 25000;

/**
 * 校验 AI 助理提交
 * @param {any} body POST JSON body
 * @returns {{ok:true, value:{question:string, contact:string|null, source:string|null}} | {ok:false, error:string}}
 */
function validateAssistant(body) {
  const question = String((body && body.question) || "").trim();
  const contact = String((body && body.contact) || "").trim();
  let source = String((body && body.source) || "").trim();
  if (source && !SOURCE_ALLOW.has(source)) source = ""; // 未知来源忽略（防注入）
  if (!question) return { ok: false, error: "question required" };
  if (question.length > QUESTION_MAX) return { ok: false, error: "question too long" };
  if (question.length < QUESTION_MIN) return { ok: false, error: "question too short" };
  if (contact && !EMAIL_RE.test(contact)) return { ok: false, error: "invalid contact" };
  return { ok: true, value: { question, contact: contact || null, source: source || null } };
}

/**
 * 意向判定：文本命中 INTENT_KEYWORDS 返回命中词数组（全小写匹配，中英文同表）
 * @param {string} text
 * @returns {string[]}
 */
function detectIntent(text) {
  const t = String(text || "").toLowerCase();
  return INTENT_KEYWORDS.filter((k) => t.includes(k.toLowerCase()));
}

// 需求详情摘要上限（字符）。question 最长 500，摘要保留信息量同时控制登记字段体积。
const NEED_DETAIL_MAX = 120;

/**
 * 需求详情结构化提取（0819-z 决议第 7 项）：原始 question 摘要
 * 规则法（不引额外 LLM 调用）：压缩空白 + 超长截断。question 通常 ≤60 字，摘要≈原文。
 * @param {string} question
 * @returns {string}
 */
function summarizeNeed(question) {
  const q = String(question || "").replace(/\s+/g, " ").trim();
  return q.length > NEED_DETAIL_MAX ? q.slice(0, NEED_DETAIL_MAX) + "…" : q;
}

/**
 * 公司知识库 + 话术红线系统提示词（单一事实源，改动只在此处）
 */
function assistantSystemPrompt() {
  return `你是 Gavin's Lab（一家真实运转的一人公司：1 位创始人 + 8 个独立 AI profile 通过 kanban 协作，把公司本身做成产品）官网的 AI 助理，代表公司团队回答访客问题。

关于公司产品，可以介绍的事实：
- 核心产品 mrd / marketingdashboard：市场研究驾驶舱（行情面板），开源（MIT），零 API key，GitHub 免费公开。
- 公司产品还有 mylauncher（安卓桌面启动器）、gold-monitor（黄金监控）、脚本宝脚本等。
- 公司官网 https://www.hermes.cc.cd 有透明办公室页面，实时展示 8 个 AI 成员如何协作运转一家公司。

话术红线（绝对遵守，违反即违规）：
1. 托管版/付费版/SaaS 版还在筹备中，一律回答「筹备中，具体上线时间和安排以官网公布为准」，绝不给出任何价格、任何上线日期、任何承诺（不接受预定、不承诺功能、不承诺时间表）。
2. 不主动推销付费；访客问到价格/付费/托管/部署到自家服务器等意向问题时，除「筹备中」口径外，可告知开源版可以自己部署（开源版是免费公开的，可自行部署使用）。
3. 回答简短（中文 ≤80 字，其他语言 ≤50 词），口语化、友好，用「我们」而非「我」。
4. 回复不使用表情符号/颜文字（如 (◕‿◕)、😊 等一律不用），纯文字回复。
5. 不知道的事不编造，引导访客看官网或留言留下联系方式。
6. 当访客表达了意向兴趣（询问托管/部署/购买/试用/价格等）时，回答末尾可自然邀请补充使用场景或具体需求（例如：「如果方便，可以补充一下你的使用场景，我们会更好地评估」）——礼貌引导、不重复追问、不强求；不是推销，不借此引导付费意向。`;
}

/**
 * 调用 OpenRouter LLM 生成回复（带超时；失败返回 null 由调用方降级）
 * @param {string} question
 * @returns {Promise<string|null>}
 */
async function callAssistantLLM(question) {
  const key = process.env.OPENROUTER_API_KEY || "";
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    const r = await fetch(OR_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OR_MODEL,
        messages: [
          { role: "system", content: assistantSystemPrompt() },
          { role: "user", content: question },
        ],
        max_tokens: 200,
        temperature: 0.4,
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    const text = j && j.choices && j.choices[0] && j.choices[0].message
      ? String(j.choices[0].message.content || "").trim()
      : "";
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * LLM 失败时的降级回复（守红线：不报价不承诺；告知开源版可自行部署；引导补充使用场景）
 */
function fallbackReply() {
  return "收到你的问题！关于托管版，我们还在筹备中，具体上线安排以官网公布为准；开源版目前完全免费公开，可以自行部署使用。如果方便，可以补充一下你的使用场景，我们会更好地评估。欢迎留下联系方式，我们会认真对待每一条反馈。";
}

/**
 * 追加落盘 assistant-leads.jsonl（意向命中才落盘；只存 email 不存姓名/电话）
 * @param {string} dataDir server/data 目录
 * @param {object} rec 完整记录（含 ts/ip/question/contact/intent_hits/reply）
 * @returns {object} 落盘记录
 */
function appendAssistantLead(dataDir, rec) {
  const file = path.join(dataDir, "assistant-leads.jsonl");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + "\n");
  return rec;
}

module.exports = {
  validateAssistant, detectIntent, summarizeNeed, assistantSystemPrompt, callAssistantLLM,
  fallbackReply, appendAssistantLead, INTENT_KEYWORDS, QUESTION_MAX, NEED_DETAIL_MAX,
};
