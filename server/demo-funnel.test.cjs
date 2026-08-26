// demo-funnel 数据源镜像单测 — node:test(server CJS 不经过 vitest)
// 运行: node --test server/demo-funnel.test.cjs
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createDemoFunnel = require("./sources/demo-funnel.cjs");

// 每个用例独立临时目录(factory 内 DATA_DIR 注入, 不碰真实 server/data)
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-funnel-test-"));
  const srcDir = path.join(root, "src");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const mod = createDemoFunnel({ fs, path }, { dataDir });
  return { root, srcDir, dataDir, mod };
}

// 把 mtime 调早, 使「目标已最新」判断成立(写文件后 mtime 是 now, 需显式改)
function backdate(p, ms) {
  const st = fs.statSync(p);
  fs.utimesSync(p, new Date(st.mtimeMs - ms), new Date(st.mtimeMs - ms));
}

test("源存在 → 镜像落盘且内容一致(含 demo/ 子目录自动创建)", () => {
  const { srcDir, dataDir, mod } = makeFixture();
  const src = path.join(srcDir, "visits.json");
  fs.writeFileSync(src, JSON.stringify({ pv: 100, uv: 10, seen: {} }));
  const r = mod.mirrorOne("visits.json", src);
  assert.equal(r, true);
  const out = JSON.parse(fs.readFileSync(path.join(dataDir, "visits.json"), "utf-8"));
  assert.equal(out.pv, 100);

  const src2 = path.join(srcDir, "status.json");
  fs.writeFileSync(src2, JSON.stringify({ tasks: {} }));
  assert.equal(mod.mirrorOne("demo/status.json", src2), true);
  assert.equal(fs.existsSync(path.join(dataDir, "demo", "status.json")), true);
});

test("目标已最新(mtime >= 源) → 跳过, 目标 mtime 不变", () => {
  const { srcDir, dataDir, mod } = makeFixture();
  const src = path.join(srcDir, "visits.json");
  const dest = path.join(dataDir, "visits.json");
  fs.writeFileSync(src, "AAAA");
  fs.writeFileSync(dest, "AAAA");
  // 源比目标新: 目标 mtime 早于源 → 应写
  backdate(dest, 5000);
  assert.equal(mod.mirrorOne("visits.json", src), true);
  assert.equal(fs.readFileSync(dest, "utf-8"), "AAAA");
  // 目标已最新(改目标 mtime 到未来) → 跳过, mtime 保持不变
  fs.utimesSync(dest, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
  const before = fs.statSync(dest).mtimeMs;
  assert.equal(mod.mirrorOne("visits.json", src), true);
  assert.equal(fs.statSync(dest).mtimeMs, before);
});

test("源更新 → 镜像更新目标内容", () => {
  const { srcDir, dataDir, mod } = makeFixture();
  const src = path.join(srcDir, "visits.json");
  const dest = path.join(dataDir, "visits.json");
  fs.writeFileSync(src, "OLD");
  assert.equal(mod.mirrorOne("visits.json", src), true);
  fs.writeFileSync(src, "NEW");
  fs.utimesSync(src, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
  assert.equal(mod.mirrorOne("visits.json", src), true);
  assert.equal(fs.readFileSync(dest, "utf-8"), "NEW");
});

test("源缺失 → 返回 false 不抛错(定时器静默跳过)", () => {
  const { dataDir, mod } = makeFixture();
  const r = mod.mirrorOne("visits.json", path.join(dataDir, "no-such-file.json"));
  assert.equal(r, false);
  assert.equal(fs.existsSync(path.join(dataDir, "visits.json")), false);
});

test("源非文件(目录) → 返回 false 不写", () => {
  const { srcDir, dataDir, mod } = makeFixture();
  const r = mod.mirrorOne("visits.json", srcDir);
  assert.equal(r, false);
  assert.equal(fs.existsSync(path.join(dataDir, "visits.json")), false);
});

test("mirrorAll 遍历全部 SOURCES 且目标目录不残留 tmp 文件", () => {
  const { srcDir, dataDir, mod } = makeFixture();
  fs.writeFileSync(path.join(srcDir, "visits.json"), "V");
  fs.writeFileSync(path.join(srcDir, "status.json"), "S");
  // 用环境变量覆盖源路径(模块加载时读取), 重新构造实例
  const oldV = process.env.DEMO_FUNNEL_VISITS_SRC;
  const oldS = process.env.DEMO_FUNNEL_STATUS_SRC;
  process.env.DEMO_FUNNEL_VISITS_SRC = path.join(srcDir, "visits.json");
  process.env.DEMO_FUNNEL_STATUS_SRC = path.join(srcDir, "status.json");
  try {
    const mod2 = createDemoFunnel({ fs, path }, { dataDir });
    const out = mod2.mirrorAll();
    assert.equal(out["visits.json"], true);
    assert.equal(out["demo/status.json"], true);
    assert.equal(fs.readFileSync(path.join(dataDir, "visits.json"), "utf-8"), "V");
    assert.equal(fs.readFileSync(path.join(dataDir, "demo", "status.json"), "utf-8"), "S");
    const leftovers = [];
    (function walk(d) {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (f.endsWith(".tmp")) leftovers.push(p);
      }
    })(dataDir);
    assert.deepEqual(leftovers, []);
  } finally {
    if (oldV === undefined) delete process.env.DEMO_FUNNEL_VISITS_SRC; else process.env.DEMO_FUNNEL_VISITS_SRC = oldV;
    if (oldS === undefined) delete process.env.DEMO_FUNNEL_STATUS_SRC; else process.env.DEMO_FUNNEL_STATUS_SRC = oldS;
  }
});
