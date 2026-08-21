// 官网 AI 助理(0818-a P0) — 校验 + 意向判定 + 落盘单测 (node --test server/assistant.test.cjs)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  validateAssistant, detectIntent, summarizeNeed, readMemberCount, assistantSystemPrompt,
  fallbackReply, appendAssistantLead, INTENT_KEYWORDS, QUESTION_MAX, NEED_DETAIL_MAX,
} = require("./lib/assistant.cjs");

test("合法提交通过: 问题必填 + 邮箱可选", () => {
  const v = validateAssistant({ question: "你们这个行情面板能部署到自己服务器吗？", contact: "visitor@example.com" });
  assert.equal(v.ok, true);
  assert.deepEqual(v.value, { question: "你们这个行情面板能部署到自己服务器吗？", contact: "visitor@example.com", source: null });
});

test("合法提交通过: 不带联系方式（contact 置 null）", () => {
  const v = validateAssistant({ question: "项目开源吗" });
  assert.equal(v.ok, true);
  assert.deepEqual(v.value, { question: "项目开源吗", contact: null, source: null });
});

test("source 白名单: demo_report 通过并回传, 未知来源忽略置 null（防 jsonl 注入）", () => {
  assert.equal(validateAssistant({ question: "托管版什么时候上线", source: "demo_report" }).value.source, "demo_report");
  // 0820-fb-2b/26: blog 悬浮反馈独立表单来源（26 已并入 SOURCE_ALLOW）
  assert.equal(validateAssistant({ question: "托管版什么时候上线", source: "blog_feedback" }).value.source, "blog_feedback");
  // 0820-fb-3: 首页/opc 悬浮反馈来源（同一 SOURCE_ALLOW 扩展）
  assert.equal(validateAssistant({ question: "托管版什么时候上线", source: "home_feedback" }).value.source, "home_feedback");
  assert.equal(validateAssistant({ question: "托管版什么时候上线", source: "opc_feedback" }).value.source, "opc_feedback");
  assert.equal(validateAssistant({ question: "托管版什么时候上线", source: "hacker\" ; rm -rf" }).value.source, null);
  assert.equal(validateAssistant({ question: "托管版什么时候上线", source: "   " }).value.source, null);
  assert.equal(validateAssistant({ question: "托管版什么时候上线" }).value.source, null);
});

test("问题必填/超短被拒", () => {
  assert.equal(validateAssistant({}).ok, false);
  assert.equal(validateAssistant({ question: "   " }).ok, false);
  assert.equal(validateAssistant({ question: "问" }).ok, false); // <2 字符
});

test(`问题超长被拒(>${QUESTION_MAX} 字符, 防注入/防烧 token)`, () => {
  const v = validateAssistant({ question: "q".repeat(QUESTION_MAX + 1) });
  assert.equal(v.ok, false);
  assert.equal(v.error, "question too long");
  // 边界: 恰好 max 允许
  assert.equal(validateAssistant({ question: "q".repeat(QUESTION_MAX) }).ok, true);
});

test("坏邮箱被拒, 合法邮箱通过", () => {
  for (const bad of ["not-an-email", "a@b", "abc", "123", "@x.com", "a@.com"]) {
    const v = validateAssistant({ question: "测试", contact: bad });
    assert.equal(v.ok, false, `应拒绝 contact=${bad}`);
    assert.equal(v.error, "invalid contact");
  }
  assert.equal(validateAssistant({ question: "测试", contact: "a@b.co" }).ok, true);
  assert.equal(validateAssistant({ question: "测试", contact: "a+b@sub.example.com" }).ok, true);
});

test("意向判定: 中文关键词命中（按词表序）", () => {
  assert.deepEqual(detectIntent("托管版多少钱一个月？"), ["托管", "多少钱"]);
  assert.deepEqual(detectIntent("能部署到我们自己服务器吗"), ["部署", "能部署"]);
  assert.deepEqual(detectIntent("想购买一个付费版"), ["付费", "购买"]);
  assert.deepEqual(detectIntent("怎么收费"), ["收费"]);
  assert.deepEqual(detectIntent("可以自托管吗"), ["托管", "自托管"]); // 子串: 自托管 含 托管
  assert.deepEqual(detectIntent("如何订阅"), ["订阅"]);
});

test("意向判定: 试用词命中（0819-z 决议第 7 项补充词）", () => {
  assert.deepEqual(detectIntent("能试用一下吗"), ["试用"]);
  assert.deepEqual(detectIntent("有没有试用版可以体验"), ["试用"]);
  assert.deepEqual(detectIntent("Can I try a trial version?"), ["trial"]);
  assert.deepEqual(detectIntent("试用"), ["试用"]); // 独立词也命中（子串匹配语义）
});

test("意向判定: 英文关键词命中（大小写不敏感, 子串匹配+词表序, 与 four-platform-monitor 同语义）", () => {
  // 纯子串语义: paid 不含 pay; subscription 不含 subscribe; self-host 同时命中 host
  assert.deepEqual(detectIntent("How much for hosting?"), ["host", "hosting", "how much"]);
  assert.deepEqual(detectIntent("Can I deploy it myself? paid plan"), ["paid", "deploy"]);
  assert.deepEqual(detectIntent("SELF-HOST license price"), ["host", "price", "self-host", "license"]);
  assert.deepEqual(detectIntent("Is there a paid subscription?"), ["paid"]);
  assert.deepEqual(detectIntent("How much does the hosted plan cost?"), ["host", "hosted", "how much", "cost"]);
});

test("意向判定: 普通技术问题不命中", () => {
  assert.deepEqual(detectIntent("这个项目的技术栈是什么？"), []);
  assert.deepEqual(detectIntent("数据源是哪里来的"), []);
  assert.deepEqual(detectIntent("有没有 API 文档"), []);
});

test("INTENT_KEYWORDS 与 four-platform-monitor 词表同源", () => {
  // 核心词必须存在（渠道判定口径一致，四步链路判定共用）
  for (const k of ["托管", "付费", "多少钱", "能部署", "试用", "host", "paid", "deploy", "trial"]) {
    assert.ok(INTENT_KEYWORDS.some((x) => x.toLowerCase() === k.toLowerCase()), `缺词: ${k}`);
  }
});

test("summarizeNeed: 需求详情摘要（0819-z 决议第 7 项）", () => {
  assert.equal(summarizeNeed("  托管版什么时间上线，可以直接部署吗？  "), "托管版什么时间上线，可以直接部署吗？");
  assert.equal(summarizeNeed(""), "");
  const long = "问".repeat(NEED_DETAIL_MAX + 10);
  const s = summarizeNeed(long);
  assert.equal(s.length, NEED_DETAIL_MAX + 1); // 截断 + 省略号
  assert.ok(s.endsWith("…"));
  assert.equal(summarizeNeed("q".repeat(NEED_DETAIL_MAX)).length, NEED_DETAIL_MAX); // 恰好上限不截断
});

test("fallbackReply 守红线: 不含价格/日期/承诺", () => {
  const r = fallbackReply();
  assert.ok(!/\d+\.?\d*\s*(元|美元|美元|USD|CNY|¥|\$|月)/.test(r), "不应报价");
  assert.ok(!/202[6-9]|月底|下周|下月/.test(r), "不应承诺时间");
  assert.ok(r.includes("筹备中"), "应含「筹备中」口径");
});

/* ---- 0820: 成员数动态化（8→9 漏改实锤根治） ---- */

// 生产 status.json 路径（与 index.cjs OPC_STATUS_FILE 同源; dist 静态目录为运行时事实源）
const OPC_STATUS_FILE = path.join(__dirname, "..", "dist", "company", "opc", "status.json");

test("readMemberCount: 真实 status.json 读成员数(members.length=9)", () => {
  assert.ok(fs.existsSync(OPC_STATUS_FILE), "status.json 应存在（opc_collect.py 实时双写）");
  assert.equal(readMemberCount(OPC_STATUS_FILE), 9);
});

test("readMemberCount: 缺文件/坏 JSON/不传 → fallback 9（零回归）", () => {
  assert.equal(readMemberCount(null), 9);
  assert.equal(readMemberCount("/tmp/definitely-not-exists-status.json"), 9);
  const bad = path.join(os.tmpdir(), "bad-status.json");
  fs.writeFileSync(bad, "{not json!!");
  assert.equal(readMemberCount(bad), 9);
});

test("readMemberCount: members 为空数组 → fallback 9（不答 0 个成员）", () => {
  const empty = path.join(os.tmpdir(), "empty-status.json");
  fs.writeFileSync(empty, JSON.stringify({ members: [] }));
  assert.equal(readMemberCount(empty), 9);
});

test("readMemberCount: 成员数变化时动态跟随（10 人 mock → 10, 机制根治验证）", () => {
  const ten = path.join(os.tmpdir(), "ten-status.json");
  fs.writeFileSync(ten, JSON.stringify({ members: Array.from({ length: 10 }, (_, i) => ({ name: "m" + i })) }));
  assert.equal(readMemberCount(ten), 10);
});

test("assistantSystemPrompt: 成员数无硬编码「8」残留, 真实文件 → 9 人口径", () => {
  const p = assistantSystemPrompt(OPC_STATUS_FILE);
  assert.ok(!p.includes("8 个"), "不应残留硬编码「8 个」");
  assert.ok(p.includes("1 位创始人 + 9 个独立 AI profile"), "模板占位应注入 9");
  assert.ok(p.includes("9 个 AI 成员"), "透明办公室描述应注入 9");
});

test("assistantSystemPrompt: 文件缺失/不传 → fallback 9（与验收卡 25a 一致）", () => {
  const p = assistantSystemPrompt(null);
  assert.ok(p.includes("1 位创始人 + 9 个独立 AI profile"));
  assert.ok(p.includes("9 个 AI 成员"));
  assert.ok(!p.includes("8 个"));
});

test("assistantSystemPrompt: 动态跟随成员数（10 人 mock → 10 人口径）", () => {
  const ten = path.join(os.tmpdir(), "ten-status.json");
  fs.writeFileSync(ten, JSON.stringify({ members: Array.from({ length: 10 }, (_, i) => ({ name: "m" + i })) }));
  const p = assistantSystemPrompt(ten);
  assert.ok(p.includes("1 位创始人 + 10 个独立 AI profile"));
  assert.ok(p.includes("10 个 AI 成员"));
});

test("assistantSystemPrompt: 话术红线 1-6 条/产品事实/域名不变（不动红线核查）", () => {
  const p = assistantSystemPrompt(OPC_STATUS_FILE);
  // 红线 1: 托管版筹备中
  assert.ok(p.includes("筹备中") && p.includes("不接受预定"), "红线 1 筹备中口径");
  // 红线 2: 开源版可自行部署
  assert.ok(p.includes("开源版是免费公开的，可自行部署使用"), "红线 2 开源版");
  // 红线 3-6: 简短/不用表情/不编造/引导补充场景
  assert.ok(p.includes("回答简短") && p.includes("表情符号") && p.includes("不编造") && p.includes("补充一下你的使用场景"));
  // 产品事实/域名仍准（0820 核查结论）
  assert.ok(p.includes("开源（MIT）") && p.includes("零 API key") && p.includes("GitHub 免费公开"));
  assert.ok(p.includes("mylauncher") && p.includes("gold-monitor") && p.includes("脚本宝"));
  assert.ok(p.includes("https://www.hermes.cc.cd"), "官网域名仍为准");
});

test("appendAssistantLead 追加落盘 jsonl(意向命中记录, 含 need_detail 结构化字段)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-test-"));
  const rec = {
    ts: "2026-08-18T02:00:00.000Z", ip: "1.2.3.4", question: "托管版多少钱？",
    contact: "v@example.com", intent_hits: ["托管", "多少钱"], need_detail: "托管版多少钱？",
    reply: "筹备中…", registered: false,
  };
  appendAssistantLead(dir, rec);
  appendAssistantLead(dir, { ...rec, ts: "2026-08-18T02:05:00.000Z", contact: null, source: "demo_report" });
  const lines = fs.readFileSync(path.join(dir, "assistant-leads.jsonl"), "utf-8").trim().split("\n");
  assert.equal(lines.length, 2);
  const p1 = JSON.parse(lines[0]);
  assert.equal(p1.intent_hits.join(","), "托管,多少钱");
  assert.equal(p1.need_detail, "托管版多少钱？"); // 0819-z: 需求详情随线索落盘
  assert.equal(p1.registered, false);
  assert.equal(p1.contact, "v@example.com");
  assert.equal("source" in p1, false, "无 source 的记录不带该字段（官网链路行为不变）");
  const p2 = JSON.parse(lines[1]);
  assert.equal(p2.contact, null);
  assert.equal(p2.source, "demo_report", "带 source 的记录原样落盘");
  assert.equal(p2.need_detail, "托管版多少钱？");
  // 红线: 记录不含姓名/电话字段
  for (const p of [p1, p2]) {
    assert.ok(!("name" in p), "不应存姓名");
    assert.ok(!("phone" in p), "不应存电话");
  }
});
