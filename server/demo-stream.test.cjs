// demo 事件流纯函数单测 — demoStreamDiff 迁移检测 + 18d created 帧补发修复
// (node --test server/demo-stream.test.cjs)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFrame, demoStreamDiff } = require("./lib/demo-stream.cjs");

const frame = makeFrame({
  tasks: {
    v2ex_hot: { name: "V2EX 热帖" },
    gz_weather: { name: "广州天气" },
  },
  member: "潘明",
});
const NOW = "2026-08-18T08:00:00.000Z";

// 造一个任务对象
function task(over = {}) {
  return {
    task_id: "v2ex_hot",
    ip: "1.2.3.4",
    status: "queued",
    created_at: "2026-08-18T07:59:00.000Z",
    started_at: null,
    finished_at: null,
    kanban_task_id: null,
    ...over,
  };
}

const acts = (frames) => frames.map((f) => `${f.action}:${f.status}`);

test("18d 修复: prev 无此任务、cur 直接 dispatched(有卡) → 补发 created 帧", () => {
  const prev = {};
  const cur = { dm1: task({ status: "dispatched", kanban_task_id: "t_x" }) };
  const out = demoStreamDiff(prev, cur, NOW, frame);
  assert.deepEqual(acts(out), ["created:todo"]);
  assert.equal(out[0].demo_id, "dm1");
  assert.equal(out[0].title, "V2EX 热帖");
  assert.equal(out[0].member, "潘明");
  assert.equal(out[0].ts, cur.dm1.created_at); // ts 用任务自身时间戳
});

test("18d 修复: prev 无此任务、cur 已 running → 补发 created+claimed 链", () => {
  const prev = {};
  const cur = {
    dm1: task({ status: "running", started_at: "2026-08-18T08:00:01.000Z", kanban_task_id: "t_x" }),
  };
  const out = demoStreamDiff(prev, cur, NOW, frame);
  assert.deepEqual(acts(out), ["created:todo", "claimed:running"]);
  assert.equal(out[1].ts, cur.dm1.started_at);
});

test("18d 修复: prev 无此任务、cur 已 completed → 补发 created+claimed+completed 链", () => {
  const prev = {};
  const cur = {
    dm1: task({
      status: "completed",
      started_at: "2026-08-18T08:00:01.000Z",
      finished_at: "2026-08-18T08:01:00.000Z",
      kanban_task_id: "t_x",
    }),
  };
  const out = demoStreamDiff(prev, cur, NOW, frame);
  assert.deepEqual(acts(out), ["created:todo", "claimed:running", "completed:done"]);
});

test("18d 修复: prev 无此任务、cur 已 failed(有卡) → 补发 created+failed", () => {
  const prev = {};
  const cur = {
    dm1: task({
      status: "failed",
      started_at: "2026-08-18T08:00:01.000Z",
      finished_at: "2026-08-18T08:00:30.000Z",
      kanban_task_id: "t_x",
    }),
  };
  const out = demoStreamDiff(prev, cur, NOW, frame);
  assert.deepEqual(acts(out), ["created:todo", "failed:failed"]);
});

test("18d 修复: prev 无此任务、cur 无卡(queued/建卡前 failed) → 不发任何帧", () => {
  assert.deepEqual(acts(demoStreamDiff({}, { dm1: task({ status: "queued" }) }, NOW, frame)), []);
  assert.deepEqual(acts(demoStreamDiff({}, { dm1: task({ status: "failed", finished_at: NOW }) }, NOW, frame)), []);
  // 有卡 failed(建卡后失败) → 补发 created+failed
  const cur = { dm1: task({ status: "failed", finished_at: NOW, kanban_task_id: "t_x" }) };
  assert.deepEqual(acts(demoStreamDiff({}, cur, NOW, frame)), ["created:todo", "failed:failed"]);
});

test("回归: queued→dispatched(有卡) 发 created, 无卡不发", () => {
  const prev = { dm1: task({ status: "queued" }) };
  const cur = { dm1: task({ status: "dispatched", kanban_task_id: "t_x" }) };
  assert.deepEqual(acts(demoStreamDiff(prev, cur, NOW, frame)), ["created:todo"]);
  const cur2 = { dm1: task({ status: "dispatched" }) };
  assert.deepEqual(acts(demoStreamDiff(prev, cur2, NOW, frame)), []);
});

test("回归: dispatched→running 发 claimed", () => {
  const prev = { dm1: task({ status: "dispatched", kanban_task_id: "t_x" }) };
  const cur = { dm1: task({ status: "running", kanban_task_id: "t_x", started_at: NOW }) };
  assert.deepEqual(acts(demoStreamDiff(prev, cur, NOW, frame)), ["claimed:running"]);
});

test("回归: 任意非终态→completed/failed 发终态帧", () => {
  const prev = { dm1: task({ status: "running", kanban_task_id: "t_x" }) };
  const cur = { dm1: task({ status: "completed", kanban_task_id: "t_x", started_at: NOW, finished_at: NOW }) };
  assert.deepEqual(acts(demoStreamDiff(prev, cur, NOW, frame)), ["completed:done"]);
  const prev2 = { dm1: task({ status: "dispatched", kanban_task_id: "t_x" }) };
  const cur2 = { dm1: task({ status: "failed", kanban_task_id: "t_x", finished_at: NOW }) };
  assert.deepEqual(acts(demoStreamDiff(prev2, cur2, NOW, frame)), ["failed:failed"]);
});

test("回归: 状态无变化不发帧; 任务消失不发帧; 多任务互不影响", () => {
  const prev = { dm1: task({ status: "running", kanban_task_id: "t_x" }) };
  const cur = { dm1: task({ status: "running", kanban_task_id: "t_x" }) };
  assert.deepEqual(acts(demoStreamDiff(prev, cur, NOW, frame)), []);
  assert.deepEqual(acts(demoStreamDiff(prev, {}, NOW, frame)), []);

  const prev2 = { dm1: task({ status: "queued" }) };
  const cur2 = {
    dm1: task({ status: "dispatched", kanban_task_id: "t_x" }),
    dm2: task({ status: "running", kanban_task_id: "t_y", started_at: NOW }),
  };
  // dm1: queued→dispatched 发 created; dm2: prev 缺失(running) 补发 created+claimed
  assert.deepEqual(acts(demoStreamDiff(prev2, cur2, NOW, frame)), ["created:todo", "created:todo", "claimed:running"]);
});

test("帧契约不变: 字段齐全且 action/status 语义正确", () => {
  const out = demoStreamDiff({}, { dm1: task({ status: "dispatched", kanban_task_id: "t_x" }) }, NOW, frame);
  assert.deepEqual(Object.keys(out[0]).sort(), ["action", "demo_id", "member", "status", "task_id", "title", "ts", "type"]);
  assert.equal(out[0].type, "demo");
  assert.equal(out[0].action, "created");
  assert.equal(out[0].status, "todo");
  assert.equal(out[0].demo_id, "dm1");
  assert.equal(out[0].task_id, "v2ex_hot");
});
