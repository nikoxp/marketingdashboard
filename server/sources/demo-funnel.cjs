/**
 * demo-funnel 数据源镜像（0825-retro-3）
 *
 * 背景: demo_funnel.py（庄子侧 cron，只读统计）硬编码读本仓 server/data/ 下的
 *   visits.json、demo/status.json 与 assistant-leads.jsonl。08-22 架构拆分后这些文件的真实产出方已外迁:
 *   - visits.json      → company-site-backend(:3034) 官网访问统计, 实际路径 server/data/visits.json
 *   - demo/status.json → OPC demo 调度状态, 实际路径 ~/.hermes/opc/demo/status.json
 *   - assistant-leads.jsonl → company-site-backend(:3034) /api/assistant 落盘, 实际路径
 *                             server/data/assistant-leads.jsonl（demo 报告页 CTA source=demo_report 记录所在，
 *                             0830-gov-b 修复：此前 mrd 下无此文件 → demo_leads 恒 0 是漏斗统计断链非无留资）
 * mrd 侧 index.cjs 已无写入逻辑 → server/data/ 下文件缺失 → demo-funnel-daily cron 失败
 * （2026-08-25 晨 08:05 cron failed×1；2026-08-30 demo_leads 恒 0 亦为此因）。
 *
 * 本模块把真实产出方文件定时镜像到本仓 server/data/ 下（mtime 守卫 + tmp+rename 原子写），
 * 脚本路径契约不变；镜像内容 = 真实产出方实时数据，非硬编码。
 *
 * 源路径可用环境变量覆盖（默认本机真实路径）:
 *   DEMO_FUNNEL_VISITS_SRC, DEMO_FUNNEL_STATUS_SRC
 */
"use strict";
module.exports = ({ fs, path }, opts = {}) => {
  const DATA_DIR = opts.dataDir || path.join(__dirname, "..", "data");
  const SOURCES = {
    "visits.json": process.env.DEMO_FUNNEL_VISITS_SRC
      || "/home/gavin/hermes_space/company-site-backend/server/data/visits.json",
    "demo/status.json": process.env.DEMO_FUNNEL_STATUS_SRC
      || "/home/gavin/.hermes/opc/demo/status.json",
    "assistant-leads.jsonl": process.env.DEMO_FUNNEL_LEADS_SRC
      || "/home/gavin/hermes_space/company-site-backend/server/data/assistant-leads.jsonl",
  };

  // 单文件镜像: 源缺失/读失败 → false(不抛, 供定时器静默跳过); 目标已最新 → 跳过; 否则 tmp+rename 原子写
  function mirrorOne(rel, srcPath) {
    let buf, mtime;
    try {
      const st = fs.statSync(srcPath);
      if (!st.isFile()) return false;
      mtime = st.mtimeMs;
      buf = fs.readFileSync(srcPath);
    } catch (e) {
      console.error(`[demo-funnel] 读源失败 ${srcPath}: ${e.message}`);
      return false;
    }
    const dest = path.join(DATA_DIR, rel);
    try {
      // 目标 mtime 不早于源 = 已是最新, 跳过(多进程/多实例共享目录时只有真正落后的一方写)
      if (fs.statSync(dest).mtimeMs >= mtime) return true;
    } catch { /* 目标不存在 → 继续写 */ }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
      console.log(`[demo-funnel] 镜像更新 ${rel} ← ${srcPath} (${buf.length} bytes)`);
      return true;
    } catch (e) {
      console.error(`[demo-funnel] 写目标失败 ${dest}: ${e.message}`);
      return false;
    }
  }

  function mirrorAll() {
    const out = {};
    for (const [rel, src] of Object.entries(SOURCES)) out[rel] = mirrorOne(rel, src);
    return out;
  }

  return { mirrorAll, mirrorOne, DATA_DIR, SOURCES };
};
