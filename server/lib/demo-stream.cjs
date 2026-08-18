// demo 事件流纯函数（提取自 index.cjs，便于单测；index.cjs 绑定实际任务表/成员名后使用）
// 帧契约(与前端 opc/index.html 完全一致):
//   {type:"demo", demo_id, task_id, title, member, action, status, ts}
//   action: created(dispatched 建卡成功) | claimed(running) | completed | failed
//   status: todo | running | done | failed（帧内用 kanban 语义, 与 status.json 的 queued/dispatched 区分）
"use strict";

// 工厂: 绑定任务表(task_id -> {name})与成员名, 产出 demoStreamFrame
function makeFrame({ tasks = {}, member = "潘明" } = {}) {
  return function demoStreamFrame(id, t, action, status, ts) {
    return {
      type: "demo",
      demo_id: id,
      task_id: t.task_id,
      title: (tasks[t.task_id] && tasks[t.task_id].name) || t.task_id,
      member,
      action, status, ts,
    };
  };
}

// 状态迁移 → 事件帧。只发迁移(状态无变化不重复推 = demo_id+status sig 去重);
// dispatched→created 需 kanban_task_id 存在(卡真实建了才发)。
// prev 缺失(!p && c): watcher 防抖合并/首事件丢失使基线从「无此任务」直接跳到 dispatched 时,
// created 帧会被旧 !p continue 吞掉 → 前端「待办出现+闪烁」缺失(18d bug, 1/6 偶发实测)。
// 修复: 按当前状态补发 created → 当前状态的完整帧链, ts 用任务自身时间戳(与 catch-up 同策略);
// 无卡(queued/建卡前 failed)不发 created, 后续迁移由下一轮 diff 正常检测。
// frame: (id, task, action, status, ts) => frameObj（由 makeFrame 产出）
function demoStreamDiff(prev, cur, nowIso, frame) {
  const frames = [];
  const ids = new Set([...Object.keys(prev || {}), ...Object.keys(cur || {})]);
  for (const id of ids) {
    const p = prev[id];
    const c = cur[id];
    if (!c) continue; // 任务从快照消失: 不发
    if (!p) {
      // prev 缺失(18d bug): 补发 created → 当前状态的完整帧链
      if (c.kanban_task_id) frames.push(frame(id, c, "created", "todo", c.created_at || nowIso));
      if (c.status === "running" && c.started_at) {
        frames.push(frame(id, c, "claimed", "running", c.started_at));
      } else if (c.status === "completed") {
        if (c.started_at) frames.push(frame(id, c, "claimed", "running", c.started_at));
        frames.push(frame(id, c, "completed", "done", c.finished_at || nowIso));
      } else if (c.status === "failed" && c.kanban_task_id) {
        // 无卡(建卡前失败)前端无卡片可更新, 不发(避免无意义广播)
        frames.push(frame(id, c, "failed", "failed", c.finished_at || nowIso));
      }
      continue;
    }
    if (p.status === c.status) continue;
    const ps = p.status, cs = c.status;
    if (ps === "queued" && cs === "dispatched") {
      if (c.kanban_task_id) frames.push(frame(id, c, "created", "todo", nowIso));
    } else if (ps === "dispatched" && cs === "running") {
      frames.push(frame(id, c, "claimed", "running", nowIso));
    } else if (cs === "completed") { // 任意非终态 → completed
      frames.push(frame(id, c, "completed", "done", nowIso));
    } else if (cs === "failed") {    // 任意状态 → failed
      frames.push(frame(id, c, "failed", "failed", nowIso));
    }
  }
  return frames;
}

module.exports = { makeFrame, demoStreamDiff };
