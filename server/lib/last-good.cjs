// 上次成功数据快照(内存 + 磁盘) — 上游全挂时降级返回旧值并带新鲜度标记
// 为什么需要磁盘: 内存缓存在进程重启后为空, 上游断链时冷启动会直接 502;
// 落盘后 "有历史成功数据就用历史" 才在重启后依然成立。目录 server/data/ 已在 .gitignore。
"use strict";

module.exports = function createLastGood({ fs, path, dir, maxAgeMs = 7 * 24 * 3600e3, writeThrottleMs = 60e3 } = {}) {
  const mem = new Map(); // key -> { data, at }
  const lastWrite = new Map(); // key -> 上次落盘时间(同 key 高频写盘节流)

  const fileOf = (key) => path.join(dir, `${String(key).replace(/[^\w.-]+/g, "_")}.json`);

  /** 读上次成功数据; 无快照/损坏/超龄(maxAgeMs)返回 null → 调用方如实报错, 不伪造 */
  function read(key) {
    const now = Date.now();
    const m = mem.get(key);
    if (m) return now - m.at < maxAgeMs ? m : null;
    try {
      const j = JSON.parse(fs.readFileSync(fileOf(key), "utf-8"));
      if (j && j.data !== undefined && now - (j.at || 0) < maxAgeMs) {
        mem.set(key, j);
        return j;
      }
    } catch { /* 无快照或损坏: 交给调用方按"无历史数据"处理 */ }
    return null;
  }

  /** 写快照: 内存立即更新(降级时立即可用), 磁盘原子写(tmp+rename)且同 key 节流 */
  function write(key, data) {
    if (data === undefined) return;
    const at = Date.now();
    mem.set(key, { data, at });
    if (at - (lastWrite.get(key) || 0) < writeThrottleMs) return;
    lastWrite.set(key, at);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = fileOf(key);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ data, at }));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error("[last-good] write error:", e?.message || e);
    }
  }

  return { read, write };
};
