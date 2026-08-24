# Changelog

本仓版本制度（资产版本制度 v1.0，2026-08-23 落地）：版本号 = git tag `vX.Y.Z` + 本文件条目；**版本载体 = package.json version**（当前 1.3.2）。语义 semver（主.次.补丁）。

> 注：历史 git tag 已存在 v1.3.0 ~ v1.3.4（v1.3.2 与 package.json 对齐）；commit message 中出现过的 v1.3.5/v1.3.6 等为功能代号未同步 package.json，以 package.json 为准。

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
