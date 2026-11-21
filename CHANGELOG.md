# Changelog

本项目遵循语义化版本（SemVer）。日期均为 Asia/Shanghai。

## v0.3.4 — 2026-11-21

### Fixed
- **已登录页面但 JWT 过期导致登录失败**：profile 仍处于飞鸽登录态、但本地提取不到有效 JWT 时，login-worker 现在会自动清理浏览器会话（cookie/localStorage/sessionStorage）并强制走一次完整登录（滑块），避免 `LOGIN_FAILED`。
- 实测：JWT 过期后 `feige account login main --force --yes` 强制重登成功，账号恢复 online（JWT 7 天，至 2026-11-28 10:50）。

### Changed
- 版本 0.3.3 → 0.3.4。

## v0.3.3 — 2026-11-20

### Fixed
- **外呼卡在 dialing / 误标 failed**：上游话单存在延迟可见（实测可达数分钟），本地 tracking 120s 超时后置 failed 且旧逻辑不允许再纠正。现修复：
  - 同步对账允许 `failed → ended/no_answer/connected` 纠正（以上游为准），清除失败原因并记录 `call reconciled from upstream`；
  - 追踪器增加多页/无日期兜底查询与异常告警（warn），超时提示更明确；
  - 失败/取消话单的流水线状态自动收口为 `missing/skipped`（历史 34 条遗留 pending 已清理；同主叫录音延迟出现仍会 `missing→pending` 回补）。
- 测试时间炸弹修复（24h 统计断言使用相对时间）；验收脚本对账号忙/短 JWT 更健壮。

### Changed
- 版本 0.3.2 → 0.3.3。

## v0.3.2 — 2026-11-14

### Fixed
- **词表归一覆盖不足**：内置 `孚盟` 规则仅含 3 个变体（复萌/福梦/复盟），实际 ASR 输出集中在「福盟/富盟/福蒙」，导致全库 0 命中、516 条转写残留变体。已按 docs/13 的 9 个同音变体补全（迁移种子 + 当前库），并全量重归一历史数据：516 条转写 / 516 条分析，残留 **0**，`full_text_raw` 原文保留。
- 新增维护脚本 `scripts/retro-normalize.mjs`（`npm run terms:renormalize`，dry-run/--apply），改词表后不重跑 ASR/LLM 即可刷新历史文本。
- 验收升级：`M4-TERMS` 检查覆盖 9 个同音变体必须 100% 归一（验收 27 项）。

### Changed
- 版本 0.3.1 → 0.3.2；文档 docs/04/13/14/15、README 同步。

## v0.3.1 — 2026-11-14

### Changed
- **PII 展示策略（业务决策）**：API/CLI 默认返回**完整手机号**（`security.maskPhones=false`，默认）；新增配置开关 `security.maskPhones` 与 `FOP_MASK_PHONES`，设为 `true` 时恢复现有脱敏行为。
- 账号 DTO 新增 `upstreamUsername`（完整），保留 `upstreamUsernameMasked`（兼容）；话单 `to.phone`/`from.phone`/`lineNumber`、详情 `upstream.telA/telB` 默认完整。
- **不改变**：日志始终脱敏；发送给 DeepSeek 的分析元数据仍按 `pipeline.analysis.redactPhones` 脱敏；公开文档示例继续使用占位号码。
- 文档同步：docs/01/05/11/14/15、README、OpenAPI spec。

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
