# feige-outbound-platform 文档索引

> 本地飞鸽外呼平台（FOP）：把飞鸽外呼封装成本地可编程平台（多账号会话池 + 自动登录保活 + 呼出编排 + 话单/录音沉淀 + **100% 自建 ASR 转写** + **内置 AI 后处理**），北向提供 REST / CLI / MCP / SKILL。
>
> 文档状态：**v0.2（2026-11-14 设计）+ v0.3.2 已实现并公开交付（MIT）**。M1–M5 验收完成，含 CLI `feige`（`--help-all`）、OpenAPI 3.1 + Swagger UI 运行时文档、安装部署手册、验收报告（自动验收 27/27）。
> 2026-11-14 已完成一轮重大设计变更（D1–D8，见下文"关键决策"）：转写全部本地自建、AI 后处理改用 DeepSeek 内置 pipeline，全部文档与 `spec/openapi.yaml` 已同步。

## 阅读顺序

1. **[00-上游可行性侦察.md](./00-上游可行性侦察.md)** —— 先看事实：上游能做什么、不能做什么（实测）。
2. **[01-决策与约定.md](./01-决策与约定.md)** —— 再看基准：术语、枚举、40 个错误码、状态机、接口清单（**单一事实源，冲突以它为准**）。
3. **[13-后处理规格（ASR与LLM）.md](./13-后处理规格（ASR与LLM）.md)** —— 转写与 AI 后处理的权威实现规格（MiniMax ASR + DeepSeek，含实测数据、切分、角色映射、prompt/JSON schema、全量回补）。
4. **[02-需求文档.md](./02-需求文档.md)** —— 要做什么、验收什么（61 FR / 48 NFR）。
5. **[03-架构设计.md](./03-架构设计.md)** —— 怎么搭：模块/时序/技术选型/故障恢复。
6. **[04-数据模型与状态机.md](./04-数据模型与状态机.md)** —— 数据怎么存、状态怎么流转（15 张表 DDL 已实测）。
7. **[05-对外API契约.md](./05-对外API契约.md)** —— REST 契约（人类权威版）；机器可读见 [spec/openapi.yaml](../spec/openapi.yaml)。
8. **[06-CLI契约.md](./06-CLI契约.md)** / **[07-MCP工具契约.md](./07-MCP工具契约.md)** / **[08-SKILL契约.md](./08-SKILL契约.md)** —— 三种接入方式。
9. **[09-上游适配层契约.md](./09-上游适配层契约.md)** —— 南向：飞鸽上游接入 + 第三方 AI 客户端内部契约。
10. **[10-部署与运维.md](./10-部署与运维.md)** / **[11-安全与合规.md](./11-安全与合规.md)** —— 上线与安全（含第三方委托处理合规）。
11. **[12-里程碑与验收.md](./12-里程碑与验收.md)** —— 实施计划与验收标准（79 条 Given/When/Then）。
12. **[15-安装与部署手册.md](./15-安装与部署手册.md)** —— 安装/配置/systemd/Xvfb/备份/升级/排障（**部署必读**）。
13. **[16-CLI参考手册.md](./16-CLI参考手册.md)** —— CLI 全部命令/子命令/选项（自动生成）。
14. **[14-实现验收报告.md](./14-实现验收报告.md)** —— 真实环境验收证据（自动验收 27/27、真实拨测、全量回补）。

## 文档清单

| 文件 | 内容 | 版本 |
| --- | --- | --- |
| [00-上游可行性侦察.md](./00-上游可行性侦察.md) | 上游实测：登录/鉴权/话单/录音/转写/呼出/WS/多账号/风险（转写部分仅侦察，v1 不使用） | v0.1 + 决策注记 |
| [01-决策与约定.md](./01-决策与约定.md) | 全局基准：术语、约定、40 错误码、状态机、接口清单、配置、决策记录 | v0.1（2026-11-14 修订） |
| [02-需求文档.md](./02-需求文档.md) | PRD：D1–D8 决策、61 FR、48 NFR、实测基线、风险、开放问题 | v0.2 |
| [03-架构设计.md](./03-架构设计.md) | 系统架构、4 张关键时序、ASR/LLM 流水线、全量回补、选型、故障、容量 | v0.2 |
| [04-数据模型与状态机.md](./04-数据模型与状态机.md) | 15 张表 ER/DDL/索引、TranscriptChunk 分块支撑表、状态机、保留期、迁移 | v0.2 |
| [05-对外API契约.md](./05-对外API契约.md) | REST v1 完整契约（35 操作、DTO、错误、示例、`includeAnalysis`） | v0.1（2026-11-14 修订） |
| [06-CLI契约.md](./06-CLI契约.md) | `feige` 命令树、40 码映射、provider 自检、全量回补命令 | v0.3 |
| [07-MCP工具契约.md](./07-MCP工具契约.md) | MCP server/tools/resources/JSON Schema/安全注解 | v0.3 |
| [08-SKILL契约.md](./08-SKILL契约.md) | agent 侧 SKILL：40 行错误码动作表、决策树、4 个剧本 | v0.2 |
| [09-上游适配层契约.md](./09-上游适配层契约.md) | 上游接口映射 + ASR 客户端/LLM 客户端内部契约、登录、错误归一 | v0.2 |
| [10-部署与运维.md](./10-部署与运维.md) | 环境、安装、systemd、密钥/白名单、备份、排障（含第三方 AI） | v0.2 |
| [11-安全与合规.md](./11-安全与合规.md) | 威胁模型、密钥、PII、第三方云委托处理、审计、留存删除 | v0.2 |
| [12-里程碑与验收.md](./12-里程碑与验收.md) | M0–M5、79 条验收用例、测试矩阵 16 类、金标集回归 | v0.2 |
| [13-后处理规格（ASR与LLM）.md](./13-后处理规格（ASR与LLM）.md) | ASR/LLM 接入契约、切分、说话人、词表、prompt/输出 schema、全量回补、评测 | v0.1（2026-11-14 新增） |
| [14-实现验收报告.md](./14-实现验收报告.md) | M1–M5 实现验收：证据、测试、部署、真实拨测、全量回补、待完成项 | v0.3.2（2026-11-14） |
| [15-安装与部署手册.md](./15-安装与部署手册.md) | 环境要求、安装、配置、systemd/Xvfb、备份、升级、监控、安全、排障 | v0.3.2（2026-11-14） |
| [16-CLI参考手册.md](./16-CLI参考手册.md) | `feige` 全部命令/子命令/参数/选项（`npm run docs:cli` 自动生成） | v0.3.2（2026-11-14） |
| [14-实现验收报告.md](./14-实现验收报告.md) | M1–M5 实现验收：证据、测试、部署、回填进度、待完成项 | v0.2.0（2026-11-14） |
| [../spec/openapi.yaml](../spec/openapi.yaml) | REST v1 机器可读契约（OpenAPI 3.1，35 操作 / 103 schemas / 40 错误码） | ✅ |
| [../spec/README.md](../spec/README.md) | spec 用途、校验方式、变更流程、同步记录、已知限制 | ✅ |

---

## 2026-11-14 关键决策（D1–D8，业务方确认）

| # | 决策 | 结论 |
| --- | --- | --- |
| D1 | 是否使用上游转写 | **不使用**。100% 本地自建 ASR（上游 `call-detail-content` 仅侦察/对账，产品流水线不调用） |
| D2 | ASR 供应商 | **MiniMax 云 API**：`POST {base}/v1/speech_to_text`，模型 `asr-1.0`，multipart 上传，`verbose_json` 返回 `n_speakers` + `segments[].speaker`（S1/S2）+ 秒级时间戳；单请求 ≤500s / ≤50MB |
| D3 | LLM 供应商 | **DeepSeek 云 API**（OpenAI 兼容）：`POST https://api.deepseek.com/chat/completions`，默认 `deepseek-chat`（= deepseek-flash），升级 `deepseek-v4-pro`；`response_format=json_object` |
| D4 | AI 后处理架构 | **平台内置 pipeline**（不是外挂 agent）；外部 agent 仍可通过 MCP/SKILL 读取结果 |
| D5 | 批量策略 | **全量回补**：历史话单全量跑，不设预算上限；独立队列、并发/限流、可暂停恢复、token/耗时可观测 |
| D6 | 说话人分离 | 录音双声道 A/B 拆分优先；单声道用 ASR 自带 diarization + 规则/LLM 角色映射；低置信 `needsReview` |
| D7 | 词汇归一 | **确定性词表**（TermRule，如 复萌/福盟/富盟/福梦 → 孚盟），ASR 后与 LLM 输出各执行一次；LLM 不改词表 |
| D8 | 语义后处理 | 默认 `deepseek-chat`（实测 2.3s/265 tokens）；JSON/zod 校验失败或低置信 → 升级 `deepseek-v4-pro`（`max_tokens≥4096`） |

> 进程流水线：`audio_fetch → chunk plan → ASR(分块) → merge timestamps → role mapping → term normalize → analysis → 入库`；未接通 → `audio/transcript=missing、analysis=skipped`。

## 已验证的第三方接口（2026-11-14，真实密钥实测）

| 项 | 实测结果 |
| --- | --- |
| MiniMax ASR 说话人分离 | `verbose_json` 返回 `n_speakers=2` 与 `segments[].speaker=S1/S2`（双人对话样本正确） |
| MiniMax ASR 性能 | 10.36s 音频 → 1.62s（RTF 0.16）；62.1s → 4.67s（RTF 0.075）；8 分钟录音预计 20–40s |
| MiniMax ASR 边界 | 单请求上限 500s / 50MB；长录音需分块（420s 静音切点） |
| ASR 文本质量 | 同音错误稳定出现（孚盟→福盟/富盟/复萌）→ 依赖确定性词表归一 |
| DeepSeek 结构化输出 | `deepseek-chat` + `response_format=json_object` 合法 JSON，实测 2.3s/265 tokens |
| DeepSeek v4-pro | 默认 reasoning 会占满 `max_tokens`（1200 tokens 正文为空）→ 升级时须 `max_tokens≥4096` |
| 密钥存放 | `~/.config/feige-outbound/secrets.json`（0600，**不在仓库**）；支持 `FOP_MINIMAX_API_KEY` / `FOP_DEEPSEEK_API_KEY` 覆盖 |

## 关键约束（来自实测，勿忘）

1. 上游强制**拨打时段 07:50–22:00**（Asia/Shanghai），时段外呼出会被拒（`CALL_OUTSIDE_DIAL_WINDOW`）。
2. 当前账号只有**电信回拨**线路：呼出先振铃坐席手机，需人工接听；**没有 SIP 专线**，v1 不做 AI 语音直呼。
3. 登录态 JWT **7 天**，且登录必须过**阿里云滑块**（浏览器自动化）；其余全部纯 HTTP/WS。
4. 上游话单**按坐席隔离**；多账号 = 分别拉取，本地按 `accountId + upstreamCallId` 去重。
5. 录音为 **8kHz/16bit/双声道 A/B WAV（实测确认，约 115MB/小时）**，上游 URL 不可构造、需尽快归档；**默认按声道拆分做说话人分离**（docs/13 §4.1 路径 A），单声道才走 diarization。
6. **不使用上游转写**：转写 100% 由本地 MiniMax ASR 生成；上游转写仅用于侦察/抽样对账。
7. 第三方云（MiniMax/DeepSeek）数据委托处理：发送前默认手机号脱敏，录音不可脱敏的部分作为残余风险接受并记录（详见 docs/11）。

## 本阶段（Step 2 + 决策变更）交付规模

| 项 | 数量 / 结果 |
| --- | --- |
| 文档 | 15 份（00–13 + README），约 **1.73 万行** |
| 机器可读契约 | `spec/openapi.yaml`（OpenAPI 3.1）：26 path item / **35 操作** / **103 schemas** / **40 稳定错误码** / 575 处 `$ref`（128 唯一目标，unresolved=0） |
| 需求 | **61 条 FR**（P0 36）、**48 条 NFR**、12 项成功度量、18 条风险、17 个开放问题 |
| 验收 | **79 条 Given/When/Then**、67 个里程碑 Gate、测试矩阵 16 类、故障注入 17 项、DoD 26 条、评审清单 31 项 |
| 架构 | 12 张 Mermaid（4 张关键时序：登录/呼出/同步/媒体 AI 流水线）+ 全量回补编排 + 14 条 ADR |
| 数据 | 15 张 SQLite 表（含 `transcript_chunks` 分块支撑表）DDL 已在 SQLite 3.53.3 实测执行通过 |
| 接入 | CLI：17 根命令 + 28 子命令 + 40 码→退出码映射；MCP：32 tools + 8 resources + 3 prompts；SKILL：40 行错误码动作表 + 4 个剧本 |

## 一致性自检结果（2026-11-14 定稿）

- 契约 ↔ 文档：spec 的 **35/35 操作**与 docs/05 §3 逐字一致、**40/40 错误码**与 docs/01 §5.4 一致；`TranscriptSource=[asr]`、`JobType` 7 类、`SpeakerMapping` 4 值、`PipelineConfig` 三嵌套、`submittedAt`/`promptVersion`/`usage` 均已核验。
- 旧路径清理：全文档 `UPSTREAM_TRANSCRIPT_PENDING` / `transcript_fetch` / `transcript_pending_wait` / `asrProvider` / `upstreamTranscriptWaitMs` 仅存在于"已删除/不使用/变更记录"说明中；错误码由 41 降为 **40**。
- 链接/结构：**0 断链**；Mermaid 围栏成对；无 TODO/FIXME 占位。
- 敏感信息：全仓库文档/spec **0** 真实密钥、JWT、完整手机号；实测样例均已脱敏；API Key 仅存 0600 secrets 文件（不在仓库）。
- 已知限制/待确认：见 [spec/README.md](../spec/README.md) §9.2 与 [01-决策与约定.md](./01-决策与约定.md) §12（SIP 专线、供应商留存/训练条款、真实电话 ASR 质量、录音声道布局等）。

## 实现交付状态（2026-11-14，v0.2.0）

**M1–M5 已全部实现并完成可执行验收**，代码位于仓库 `src/`，验收证据见 [14-实现验收报告](./14-实现验收报告.md)。要点：

- ✅ M1：SQLite 15 表迁移/Repo、账号管理、**真实自动登录（阿里云滑块）**、JWT 保活、`/status`、`feige doctor`；
- ✅ M2：话单全量同步（4105 条真实入库）、录音归档（实测 **8kHz/2bit/2ch A/B**）、**双声道拆分 ASR**（MiniMax，真实调用）、事件/SSE；
- ✅ M4：DeepSeek 内置后处理（`analysis-v1` prompt + JSON schema + 降级链）、词表归一、全量回填；
- ✅ M5：CLI（40 命令节点）、MCP（18 只读/32 写工具）、SKILL 包、**systemd user service 已安装运行**、93/93 测试、验收脚本；
- ✅ M3 真实拨测（2026-11-14 08:00–08:07）：真实呼出受理→接通→录音归档→ASR 流水线通过（用户确认口径：验证到接通/录音即可）；线路级时段 2516 已归一并记录（见 docs/00 §8.1）。

**运行**：`systemctl --user status feige-outbound`（active）；REST `http://127.0.0.1:8710/api/v1`；验收 `node scripts/acceptance.mjs`。
