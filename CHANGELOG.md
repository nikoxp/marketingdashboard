# Changelog

本仓版本制度（资产版本制度 v1.0，2026-08-23 落地）：版本号 = git tag `vX.Y.Z` + 本文件条目；**版本载体 = package.json version**。语义 semver（主.次.补丁）。

> 注：历史 git tag 已存在 v1.3.0 ~ v1.3.4（v1.3.2 与 package.json 对齐）；commit message 中出现过的 v1.3.5/v1.3.6 等为功能代号未同步 package.json，以 package.json 为准（故本次恢复发布节奏从 v1.4.0 起，避开代号混淆）。

## [v1.4.0] - 2026-08-30
### Added
- **MCP Server Phase 1.5（02b294b）**：MCP server 嵌入同一 Node.js 进程，零新增依赖，复用共享 cached() 内存缓存
  - Streamable HTTP（POST /mcp）+ SSE（/mcp/stream）+ GET /mcp 元数据
  - JSON-RPC 2.0：initialize / tools/list / tools/call / ping
  - 5 个公开工具：get_quotes / get_boards / get_futures / get_money_flow / get_news
  - mrd://health 与 mrd://stats 资源；红线：aa-models 原始接口与批量 K 线导出不暴露
  - README 新增 MCP 章节（端点/工具清单/curl 示例/Claude Desktop 配置）

### Fixed
- **demo 漏斗留资统计断链（0830-gov-b）**：demo_funnel.py 读 `server/data/assistant-leads.jsonl`，但 08-22 架构拆分后 /api/assistant 已迁 company-site-backend(:3034)，真实落盘在 `company-site-backend/server/data/assistant-leads.jsonl`，mrd 下无此文件 → demo_leads 恒 0 是统计断链而非无留资
  - demo-funnel 数据源镜像扩展第三源：assistant-leads.jsonl ← company-site-backend 真源（启动即同步 + 5min 周期，mtime 守卫 + tmp+rename 原子写，HOSTING=1 跳过）
  - 修复后实测：demo_leads 0 → 1（真实 1 条 source=demo_report 记录归位），total 0 → 15
  - 单测 demo-funnel.test.cjs 7 例全绿（新增 leads 镜像用例）
- demo/status.json 静态服务红线描述更新（P0-1 已停更，真源机制接管，5982240）

## [v1.3.4] - 2026-08-21
### Fixed
- [27d-fix] opc 流 fs.watch 目录级化：原子写（tmp+os.replace 换 inode）不再杀死 watcher——watch status.json 所在目录，rename 事件按文件名过滤；广播加内容去重（防 opc-bus 1s 写 + collect 10min 写重复推送）；30s mtime 轮询仅作兜底
- 全链路实测：直连 p95=246ms / 反代 p95=281ms / 真实建卡迁移 p95=1183ms（均 ≤3s，10+6 次采样）
- 单测 124 过 + 冒烟 32 过/3 上游失败（基线）

## [v1.3.3] - 2026-08-20
### Added
- bare domain hermes.cc.cd 的 /go/* 短链保留路径 302 到 www（防 404 丢路径）：
  - /go、/go/、/go/xxx → 302 https://www.hermes.cc.cd<原路径> + Cache-Control: no-store，由 www 侧 _worker.js 统一小写匹配 + 302 + 点击计数
  - 目标拼接写死前缀防 open redirect；不影响 /api/v1/knock/* 三路由与原 404 行为

## [v1.3.2] - 2026-08-23
### Changed
- 版本制度落地（0823-ver-1）：根目录新增本 CHANGELOG.md；确认 package.json version=1.3.2 与既有 tag v1.3.2 对齐

### 基线现状（2026-08-23 快照，主要功能）
- 一屏式实时行情大屏：A股/港股/美股指数、大宗商品、美债收益率、板块热点、主力资金流、7×24 快讯、产业链自选股、AI Token 追踪
- /gold 黄金观察仪表盘（8 面板，实时金价/走势 SVG/美债收益率曲线/实际利率/央行购金/储备 TOP10/通胀 Fed 指标/新闻）
- POST /api/feedback 官网独立反馈端点（page 白名单 + 同 IP 限流）
- /api/acquisition 引流聚合 API（UTM/短链/V2EX/feedback 四源漏斗）
- UTM 引流埋点（mrd demo 站）
- knock 手速排行榜服务已迁出至 mylauncher 仓（保留 /api/v1/knock/* 302/307 过渡重定向）
- OPC backend reverse-proxy 至 opc-server(:3033)
