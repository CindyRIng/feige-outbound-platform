# Changelog

本项目遵循语义化版本（SemVer）。日期均为 Asia/Shanghai。

## v0.3.0 — 2026-11-14

面向公开交付的版本：可运行平台 + 完整 CLI/MCP/SKILL + OpenAPI 运行时文档 + 安装部署手册 + MIT License。

### Added
- **`feige` CLI 安装**：`npm run install:cli` 安装到 `~/.local/bin/feige`（符号链接到 `dist/src/main.js`）。
- **完整 CLI 帮助**：`feige --help-all` 递归输出全部命令/子命令/参数/选项；`feige help <command>` 分级帮助；新增 `serve`/`mcp` 帮助桩。
- **REST 运行时文档（OpenAPI）**：
  - `GET /api/v1/openapi.json` / `GET /api/v1/openapi.yaml`（OpenAPI 3.1，35 操作）；
  - `GET /api/v1/docs` Swagger UI（离线静态资源来自 `swagger-ui-dist`，支持 `?token=` 自动注入与 Authorize）；
  - `GET /api/v1` API 发现页；文档端点公开、仅监听 127.0.0.1。
- **文档体系**：重写 README（含架构/流水线 Mermaid 图与生成式 Banner）；新增 `docs/15-安装与部署手册.md`（环境/安装/配置/systemd/Xvfb/备份/升级/排障）；新增自动生成的 `docs/16-CLI参考手册.md`；Swagger UI 截图。
- **工程化**：`npm run docs:cli` 自动生成 CLI 参考；`npm run install:cli`；package 元数据（license/repository/keywords/engines/files）；MIT LICENSE；CHANGELOG。
- **验收**：端到端验收脚本扩展至 25 项（新增 API 发现、OpenAPI、Swagger UI 检查），全部通过；单测 93/93。

### Changed
- 版本升级 0.2.0 → 0.3.0（`src/version.ts` 单一版本源，CLI/MCP/REST/DB 同步）。
- `spec/openapi.yaml` info.version 同步更新。

### Fixed
- M3 真实拨测相关：`2516 当前时间段无法调用` 归一为 `CALL_OUTSIDE_DIAL_WINDOW`；派发失败使用无条件状态写入避免重复派发；录音延迟生成支持 `missing → pending` 回补。
- API 容忍空 JSON body（无 body 的 POST `/cancel`、`/logout`）。
- 登录 JWT 校验（login 后 `getUserDetail` 验证 + 失败清 profile 重登）；health 401 不再清空 token。

## v0.2.0 — 2026-11-14

- M1–M5 平台实现：REST v1、SQLite 15 表、飞鸽上游客户端与自动登录、话单同步、录音归档、100% MiniMax ASR（双声道拆分/分块/角色/词表）、DeepSeek 后处理、呼出编排与状态机、全量回补。
- CLI/MCP/SKILL、systemd 部署、93/93 单测、docs/14 验收报告。
- 真实拨测验收（用户确认口径：验证到接通/录音即可）。

## v0.1.0 — 2026-11-13

- 上游可行性侦察 + 完整设计与契约文档（docs/00–13、spec/openapi.yaml）。
