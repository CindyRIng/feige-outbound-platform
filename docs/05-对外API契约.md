# 05 对外 API 契约（REST v1）

> 本文是北向 REST 接口的**人类可读权威契约**；机器可读副本见 [../spec/openapi.yaml](../spec/openapi.yaml)（两者必须一致，冲突时以本文 + [01-决策与约定.md](./01-决策与约定.md) 为准）。
>
> 状态：v0.3.1（2026-11-14；v0.3.0 增补运行时文档端点；v0.3.1 调整 PII 展示策略）｜Base URL：`http://127.0.0.1:8710/api/v1`
>
> **PII 展示策略（v0.3.1）**：默认 `security.maskPhones=false` → API/CLI 返回**完整手机号**（本机单用户运营；日志始终脱敏，AI 分析输入仍脱敏）；设为 `true` 时恢复打码。本文示例为脱敏占位。
> 通用约定（认证/封套/错误码/分页/时间/幂等/限流）见 [01-决策与约定.md](./01-决策与约定.md) §5；本文只定义**字段与行为**。

---

## 0. 运行时文档端点（v0.3.0）

除业务接口外，服务运行时提供以下只读文档端点（**公开，无需 token**；服务默认仅监听 127.0.0.1）：

| 端点 | 内容 |
| --- | --- |
| `GET /api/v1` | API 发现页（名称/版本/文档链接/健康检查链接） |
| `GET /api/v1/openapi.json` | OpenAPI 3.1 契约 JSON（与 `spec/openapi.yaml` 同源；35 操作 / 26 路径 / 40 错误码） |
| `GET /api/v1/openapi.yaml` | OpenAPI 契约 YAML 原文 |
| `GET /api/v1/docs` | Swagger UI（离线静态资源；支持 `?token=<localApiToken>` 自动注入、Authorize 按钮） |

> 业务接口仍需 `Authorization: Bearer <localApiToken>`；未带 token 的业务请求返回 `401 UNAUTHORIZED`。

---

## 1. 总则

### 1.1 传输

- HTTP/1.1；JSON 请求/响应 `Content-Type: application/json; charset=utf-8`；文件下载 `audio/wav`。
- 所有接口需要认证：`Authorization: Bearer <localApiToken>`。
- 请求头：

| 头 | 必需 | 说明 |
| --- | --- | --- |
| `Authorization` | 是 | `Bearer <token>`（token 文件 `~/.config/feige-outbound/api-token`） |
| `Content-Type` | 写接口 | `application/json` |
| `X-Request-Id` | 否 | 客户端可传，响应原样回传；否则服务端生成 `req_<ULID>` |
| `Idempotency-Key` | 否 | 幂等键（UUID/ULID），适用于 §7 列出的写接口 |
| `Accept` | 否 | 默认 `application/json`；录音下载可 `audio/wav` |
| `Last-Event-ID` | 否 | 仅 SSE 续传 |

- 响应统一带 `X-Request-Id` 与 `X-Api-Version: 1`。
- 时间：ISO 8601 带时区（`+08:00`）；日期过滤 `YYYY-MM-DD`（Asia/Shanghai）。
- 上游原始值（毫秒时间戳、雪花 ID、原始状态码）放在 `upstream` 对象中，不参与本地业务判断。

### 1.2 成功/失败封套

```jsonc
// 成功
{ "ok": true, "data": { }, "meta": { "requestId": "req_01J8Z3K5T9QW2M4R7X1C6V0B8N", "ts": "2026-11-14T10:00:00+08:00" } }

// 列表成功（meta 追加分页）
{ "ok": true, "data": [ ], "meta": { "requestId": "req_...", "ts": "...", "pagination": { "page": 1, "size": 20, "total": 1073, "totalPages": 54 } } }

// 失败
{ "ok": false, "error": { "code": "CALL_OUTSIDE_DIAL_WINDOW", "message": "当前不在可拨号时段（07:50–22:00，Asia/Shanghai）", "retryable": true, "retryAfter": "2026-11-15T07:50:00+08:00", "details": {} }, "meta": { "requestId": "req_...", "ts": "..." } }
```

- 错误码全集与语义：[01-决策与约定.md](./01-决策与约定.md) §5.4（**唯一来源，本文不重复定义**）。
- 幂等重放：成功响应 `meta.idempotencyReplayed: true`（仅写接口）。
- 异步受理（HTTP 202）：作业型操作（`/sync`、`reprocess`、`login` 异步）的 `data` 至少包含 `jobId`、`status`、`pollUrl`；`POST /calls` 的 202 返回 `CallAccepted`（=CallSummary，**无 jobId**，用 `GET /calls/{callId}` 跟踪）。

---

## 2. 公共数据结构（DTO）

> 所有 DTO 字段命名 camelCase；`?` 表示可能缺失/为 null；枚举取值见 01 §6.1。

### 2.1 PaginationMeta

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `page` | int | 当前页（1 起） |
| `size` | int | 每页条数 |
| `total` | int | 总条数 |
| `totalPages` | int | 总页数 |

### 2.2 AccountSummary

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `accountId` | string | 账号 slug |
| `displayName` | string | 展示名 |
| `upstreamUsername` | string | **完整上游登录手机号**（默认；`security.maskPhones=true` 时为脱敏值） |
| `upstreamUsernameMasked` | string | 脱敏上游登录手机号（`156****0075`；兼容字段，两种模式都返回） |
| `upstreamUserId` | string? | 上游 userId |
| `tenantCode` | string? | 上游租户编码 |
| `enterpriseName` | string? | 上游企业名 |
| `realName` | string? | 上游坐席姓名 |
| `dialMode` | string | 固定 `callback`（回拨） |
| `line` | object? | `{ lineId: string, lineName: string, mode: number }` 当前线路（来自上游 `callLineList`） |
| `enabled` | boolean | 本地是否启用 |
| `state` | enum | `online` / `expired` / `logging_in` / `error` / `disabled` / `unknown` |
| `jwtExpiresAt` | string? | JWT 到期时间 |
| `lastLoginAt` | string? | 最近成功登录时间 |
| `lastCheckedAt` | string? | 最近健康检查时间 |
| `lastError` | ErrorBrief? | 最近错误 `{ code, message, at }` |
| `deletedAt` | string? | 账号已移除时间；软删除后历史话单仍保留时出现（列表/详情可见，登录等写操作返回 `ACCOUNT_NOT_FOUND`） |
| `stats` | object | `{ totalCalls: int, calls24h: int, lastCallAt?: string }`（本地库统计，非上游） |
| `createdAt` / `updatedAt` | string | |

### 2.3 AccountDetail（= AccountSummary + 以下）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `config` | object | `{ concurrency: int, browser: { headless: boolean, profileDirMasked: string } }` |
| `session` | object | `{ state, jwtExpiresAt?, wsConnected: boolean, cookieState: "valid"|"expired"|"unknown", lastPongAt? }` |
| `sync` | object | `{ lastSyncAt?, cursorStartTime?, lagSeconds?, lastError? }` |
| `recentJobs` | JobSummary[] | 最近 5 个作业 |

### 2.4 AccountHealth

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `accountId` | string | |
| `state` | enum | 同 AccountSummary.state |
| `jwt` | object | `{ valid: boolean, expiresAt?, expiresInSec? }` |
| `ws` | object | `{ connected: boolean, lastPongAt?, latencyMs? }` |
| `upstream` | object | `{ reachable: boolean, latencyMs?: number, checkedAt: string }` |
| `line` | object? | 同 AccountSummary.line |
| `dialWindow` | DialWindow | 见 2.9 |
| `busy` | object | `{ inCall: boolean, busyCallId?: string }` |
| `lastError` | ErrorBrief? | |

### 2.5 CallSummary（列表项 / 呼出受理响应）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `callId` | string | 本地 ULID（`call_...`） |
| `accountId` | string | 归属账号 |
| `upstreamCallId` | string? | 上游通话 ID（呼出受理后可能短暂为空） |
| `direction` | string | 固定 `outbound` |
| `to` | object | `{ phone: string, location?: string }` 客户号（上游 `telB`/`phone`，`calleeAttr`） |
| `from` | object | `{ phone: string, location?: string }` 坐席号（上游 `telA`，`callerAttr`） |
| `lineNumber` | string? | 中间号（上游 `telX`） |
| `customerName` | string? | 客户名（本地录入或上游 CRM） |
| `lineId` / `lineName` | string? | 线路（上游 `interfaceId`/`lineName`） |
| `status` | enum | Call status（01 §6.1） |
| `statusReason` | string? | 人可读原因（如"拨打时段外""上游拒绝"） |
| `dialedAt` | string? | 上游 `startTime` |
| `answeredAt` | string? | 接通时间（由状态推断/上游更新） |
| `endedAt` | string? | 结束时间（上游 `endTime`） |
| `durationSec` | int? | 通话时长（上游 `duration`） |
| `cost` | number? | 话费（上游 `postage`） |
| `upstreamStatus` | object? | `{ callStatus?: int, callStatusName?: string, finishStatus?: int, finishStatusName?: string }` |
| `pipeline` | PipelineSummary | 见 2.6 |
| `transcriptPreview` | string? | 归一化后转写前 80 字（无转写则 null） |
| `audioAvailable` | boolean | 是否已归档录音 |
| `createdAt` / `updatedAt` | string | 本地受理/更新时间 |

### 2.6 PipelineSummary

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `audio` | enum | `pending` / `in_progress` / `ready` / `missing` / `failed` / `skipped` |
| `transcript` | enum | 同上 |
| `analysis` | enum | 同上 |
| `lastError` | ErrorBrief? | 任一阶段最近错误 |

### 2.7 JobSummary / JobDetail

JobSummary：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `jobId` | string | `job_...` |
| `type` | enum | `login`/`sync`/`audio_fetch`/`asr`/`analysis`/`reprocess`/`backfill` |
| `status` | enum | `queued`/`running`/`succeeded`/`failed`/`canceled` |
| `accountId` | string? | |
| `callId` | string? | |
| `attempts` / `maxAttempts` | int | 重试计数 |
| `progress` | object? | `{ current: int, total?: int, unit?: string, message?: string }` |
| `scheduledAt` / `startedAt` / `finishedAt` | string? | |
| `lastError` | ErrorBrief? | `{ code, message, at }` |
| `createdAt` / `updatedAt` | string | |

JobDetail = JobSummary +：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `payload` | object? | 作业输入（脱敏：不含密码/JWT） |
| `result` | object? | 作业结果摘要（如 `{ fetched: 120, upserted: 118 }`） |
| `logs` | string[] | 最近 50 行作业日志（已脱敏） |

### 2.8 ErrorBrief / DialWindow

ErrorBrief：`{ code: string, message: string, at: string, details?: object }`

DialWindow：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `open` | boolean | 当前是否可呼出（按服务端时钟与配置时段） |
| `windowStart` / `windowEnd` | string | `"07:50"` / `"22:00"` |
| `timezone` | string | `"Asia/Shanghai"` |
| `nextOpenAt` | string? | 窗口关闭时给出下次开启时间 |

### 2.9 话单详情 DTO

**CallDetail**（`GET /calls/{callId}/detail`）= CallSummary 全部字段，另加：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `upstream` | object | `{ callStatusName?, finishStatus?, finishStatusName?, callType?, handle?, interfaceId?, interfaceName?, telA?, telB?, telX?, postage?, agentCode?, sipCodeResult?, callerAttr?, calleeAttr?, tenantCode?, enterpriseName?, raw?: object }`；`raw` 仅当 `?includeRaw=true` 返回 |
| `timeline` | object | `{ createdAt, submittedAt?, dialingAt?, connectedAt?, endedAt? }`（`submittedAt`=本地提交上游时间；上游 `startTime` 未回填时 `dialedAt` 回退为该值） |
| `pipelineDetail` | object | 见下 |
| `recording` | object | `{ available: boolean, downloadUrl?: string, format?: "wav", durationMs?, sizeBytes?, sha256?, sampleRate?, channels? }` |
| `transcript` | object | `{ available: boolean, source?: "asr", segmentCount?: number, needsReview?: boolean, url?: string }` |
| `analysis` | object | `{ available: boolean, analysisId?: string, summary?: string, intent?: string, url?: string }` |
| `eventsCount` | int | 事件数量 |
| `metadata` | object? | 呼出时传入的自定义键值 |
| `events` | EventRecord[]? | 最近 50 条事件（`?includeEvents=true` 时返回） |
| `analysisPayload` | AnalysisPayload? | 完整 AI 后处理产出（含 `promptVersion`/`usage`/`speakerMapping`；`?includeAnalysis=true` 时返回）。这是完整 AnalysisPayload 的对外承载位置 |

`pipelineDetail`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `audio` | object | `{ status, audioId?, downloadedAt?, lastError? }` |
| `transcript` | object | `{ status, transcriptId?, source?, provider?, chunkCount?, needsReview?, generatedAt?, lastError? }` |
| `analysis` | object | `{ status, analysisId?, generatedAt?, lastError? }` |

**TranscriptPayload**（`GET /calls/{callId}/transcript`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `callId` | string | |
| `transcriptId` | string | |
| `source` | enum | 固定 `asr`（本地自建 ASR，v1=MiniMax；不再有 upstream/hybrid） |
| `provider` | string? | ASR provider 标识，如 `minimax:asr-1.0` |
| `language` | string | 默认 `zh-CN` |
| `status` | enum | pipeline transcript status |
| `isCurrent` | boolean | 是否当前版本 |
| `durationMs` | int? | |
| `fullText` | string | 归一化后的全文（坐席+客户按时间顺序拼接） |
| `segments` | TranscriptSegment[] | 见下 |
| `analysis` | object? | `{ analysisId: string, summary: string, intent?: string }`（`?includeAnalysis=true` 时返回；完整结构通过 `CallDetail.pipelineDetail.analysis` 或事件获取） |
| `createdAt` / `updatedAt` | string | |

**TranscriptSegment**：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `segmentId` | string | |
| `index` | int | 从 0 开始 |
| `beginMs` / `endMs` | int | 相对录音起点毫秒 |
| `channel` | int? | 声道号（双声道 A/B 拆分路径有值 0/1；单声道路径为 null） |
| `speakerLabel` | string? | ASR 匿名说话人标签（`S1`/`S2`…，块内有效；长通话跨块见 `speakerMapping`） |
| `chunkIndex` | int? | 长通话 ASR 分块序号（≤480s 整段时为 0/null） |
| `role` | enum | `agent` / `customer` / `unknown` |
| `rawText` | string | ASR 原文（MiniMax）；`normalizedText` 为词表归一后文本 |
| `normalizedText` | string | 词表归一后文本 |
| `confidence` | number? | 0–1（本地 ASR；无则 null） |
| `emotionValue` | number? | 预留（v1 ASR 不返回，恒 null） |
| `speechRate` | number? | 预留（v1 恒 null） |
| `silenceBeforeMs` | int? | 预留（v1 恒 null） |

**AnalysisPayload**（含于 detail/transcript 或独立事件；v1 不单独开接口）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `analysisId` | string | |
| `callId` | string | |
| `status` | enum | pipeline analysis status |
| `model` | string? | 使用的 LLM/处理管线（不含密钥） |
| `summary` | object | `{ short: string, bullets: string[] }` |
| `intent` | object? | `{ label: string, score?: number }` |
| `keywords` | string[] | 关键词 |
| `termsApplied` | array | `[{ from: string, to: string, count: int }]` |
| `speakerMapping` | object | `{ method: "channel"|"asr_diarization"|"llm_reconciled"|"heuristic", agentChannels?: int[], confidence?: number, needsReview?: boolean, evidence?: string }` |
| `promptVersion` | string? | 后处理 prompt 版本，如 `analysis-v1` |
| `usage` | object? | `{ promptTokens, completionTokens, totalTokens, latencyMs }`（观测用） |
| `generatedAt` | string | |

### 2.10 词表 DTO

**TermRule**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `termId` | string | 响应 | `term_...` |
| `from` | string[] | 是 | 变体列表（如 `["复萌","福梦","复盟"]`），非空、去重、每项 1–32 字符 |
| `to` | string | 是 | 标准词（如 `"孚盟"`），1–32 字符 |
| `category` | string? | 否 | `company`/`product`/`person`/`custom` |
| `priority` | int | 否 | 默认 100，越大越优先（冲突时高优先级先应用） |
| `enabled` | boolean | 否 | 默认 true |
| `caseSensitive` | boolean | 否 | 默认 false（中文无意义，保留供英文术语） |
| `note` | string? | 否 | 备注 |
| `createdAt` / `updatedAt` | string | 响应 | |

### 2.11 StatusPayload（`GET /status`，对应图中 `Status`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `version` | string | 平台版本（语义化版本） |
| `startedAt` | string | 进程启动时间 |
| `uptimeSec` | int | |
| `now` | string | 服务端当前时间（判断拨打时段用） |
| `db` | object | `{ ok: boolean, schemaVersion: number, sizeBytes: number, walSizeBytes: number, latencyMs: number }` |
| `accounts` | object | `{ total, online, expired, loggingIn, error, disabled }` |
| `accountsDetail` | AccountSummary[] | 全量账号摘要（数量 ≤200 时返回；超出用 `?detail=false` 省略） |
| `upstream` | object | `{ reachable: boolean, lastCheckedAt?: string, latencyMs?: number }`（任一在线账号探测结果聚合） |
| `dialWindow` | DialWindow | |
| `queues` | object | `{ jobsQueued, jobsRunning, jobsFailed24h, audioPending, transcriptPending, analysisPending }` |
| `sync` | object | `{ lastSyncAt?: string, laggingAccounts: string[], lastError?: ErrorBrief }` |
| `events` | object | `{ sseClients: number }` |
| `limits` | object | `{ apiQps, perAccountConcurrency, globalConcurrency, dialCooldownMs }` |

### 2.12 EventRecord

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `eventId` | string | `evt_...` |
| `type` | string | 见 01 §7.3 |
| `occurredAt` | string | |
| `accountId` | string? | |
| `callId` | string? | |
| `data` | object | 事件类型相关字段（01 §7.3） |

### 2.13 Config DTO

`GET /config` 返回与 [01-决策与约定.md](./01-决策与约定.md) §9 对应结构，**密钥字段一律脱敏**：

```jsonc
{
  "server": { "host": "127.0.0.1", "port": 8710, "allowRemote": false },
  "storage": { "dataDir": "/home/<user>/.local/share/feige-outbound", "dbFile": "fop.db", "audioDir": "audio" },
  "browser": { "headless": false, "profileRoot": "/home/<user>/.local/share/feige-outbound/profiles", "executablePathMasked": null },
  "dial": { "windowStart": "07:50", "windowEnd": "22:00", "timezone": "Asia/Shanghai", "scheduleOutsideWindow": true },
  "limits": { "perAccountConcurrency": 1, "globalConcurrency": 8, "upstreamReadQps": 5, "dialCooldownMs": 60000, "apiQps": 100 },
  "sync": { "intervalMs": 60000, "pageSize": 100, "lookbackDays": 7 },
  "pipeline": {
    "asr": { "provider": "minimax", "baseUrl": "https://api.minimax.cn", "model": "asr-1.0", "language": "zh", "chunkSeconds": 420, "concurrency": 1 },  // 区域需与 key 匹配
    "analysis": { "provider": "deepseek", "baseUrl": "https://api.deepseek.com", "model": "deepseek-chat", "escalateModel": "deepseek-v4-pro", "promptVersion": "analysis-v1", "temperature": 0.2, "maxTokens": 2000, "concurrency": 8 },
    "roleMapping": { "method": "auto", "llmVerify": true }
  },
  "events": { "sseHeartbeatMs": 15000, "webhooks": [] }
}
```

- `PATCH /config`：JSON Merge Patch 语义，只接受上表字段；涉及密钥的配置不接受本接口修改（走 secrets 文件/环境变量），尝试修改返回 400 `CONFIG_INVALID`（`details.readonlyFields`）。
- `events.webhooks[]` 元素结构：`{ url: string(必须 https), eventTypes: string[], secret?: string, enabled: boolean, timeoutMs?: number }`；`secret` 只存 secrets 文件，本接口返回脱敏。
- 修改 `server.host/port` 需要重启生效：响应 `data.restartRequired: true`。

### 2.14 操作结果 DTO（写接口 data）

| DTO | 字段 | 用于 |
| --- | --- | --- |
| `CallAccepted` | = `CallSummary`（呼出受理响应） | `POST /calls` 201/202 |
| `DryRunResult` | `{ dryRun: true, willDial: boolean, accountId, to, dialWindow: DialWindow, warnings: string[], estimatedCost?: number }` | `POST /calls?dryRun` |
| `AccountCreateResult` | `{ accountId, displayName, upstreamUsername, upstreamUsernameMasked, enabled, state, dialMode, createdAt }` | `POST /accounts` 201 |
| `AccountLoginResult` | `{ accountId, state, loggedIn: boolean, jwtExpiresAt?: string, loginJobId }` | `POST /accounts/{id}/login` wait=true 200 |
| `AccountLoginAccepted` | `{ loginJobId, status: "queued", pollUrl: string }` | `POST /accounts/{id}/login` wait=false 202 |
| `SyncAccepted` | `{ jobId, type: "sync", mode: "incremental"|"full"|"backfill", accountId: string|null, status: "queued", pollUrl: string }` | `POST /sync` 202 |
| `ReprocessAccepted` | `{ jobId, callId, stages: string[], status: "queued", pollUrl: string }` | `POST /calls/{id}/reprocess` 202 |
| `TermReplaceResult` | `{ count: number, version: string }` | `PUT /terms` 200 |
| `NormalizeResult` | `{ original: string, normalized: string, applied: Array<{from,to,count}>, rulesVersion: string }` | `POST /text/normalize` 200 |
| `WebhookTestResult` | `{ delivered: boolean, statusCode?: number, latencyMs?: number, deliveryError?: string }` | `POST /webhooks/test` 200 |
| `JobDetail` | 见 2.7 | `GET /jobs/{id}`、`GET /sync/{id}`、wait=true 的同步调用 |

---

## 3. 接口清单总表

> 35 个操作，与 [01-决策与约定.md](./01-决策与约定.md) §4.1 一一对应。认证全部为 Bearer。

| # | 方法与路径 | 名称 | 幂等 | 副作用 |
| --- | --- | --- | --- | --- |
| 1 | `GET /health` | 存活探针 | 是 | 无 |
| 2 | `GET /status` | 平台状态 | 是 | 无 |
| 3 | `GET /config` | 读取配置 | 是 | 无 |
| 4 | `PATCH /config` | 更新配置 | 是 | 重启（部分字段） |
| 5 | `GET /accounts` | 账号列表 | 是 | 无 |
| 6 | `POST /accounts` | 注册账号 | 否（建议幂等键） | 写配置/密钥 |
| 7 | `GET /accounts/{accountId}` | 账号详情 | 是 | 无 |
| 8 | `PATCH /accounts/{accountId}` | 更新账号 | 否 | 可能触发重登 |
| 9 | `DELETE /accounts/{accountId}` | 移除账号 | 否 | 删配置/凭证/profile；默认保留历史数据 |
| 10 | `POST /accounts/{accountId}/login` | 登录 | 是（幂等键） | 启动浏览器、写登录态 |
| 11 | `POST /accounts/{accountId}/logout` | 退出 | 是 | 清登录态 |
| 12 | `GET /accounts/{accountId}/health` | 账号健康 | 是 | 无（会触发上游探测） |
| 13 | `POST /calls` | 发起呼出 | 是（幂等键，推荐） | **真实外呼**（振铃坐席手机） |
| 14 | `GET /calls` | 话单列表 | 是 | 无 |
| 15 | `GET /calls/{callId}` | 话单摘要 | 是 | 无 |
| 16 | `GET /calls/{callId}/detail` | 话单详情 | 是 | 无 |
| 17 | `GET /calls/{callId}/transcript` | 转写 | 是 | 无 |
| 18 | `GET /calls/{callId}/audio` | 录音文件 | 是 | 无 |
| 19 | `POST /calls/{callId}/reprocess` | 重跑流水线 | 是（幂等键） | 重新处理数据 |
| 20 | `POST /calls/{callId}/cancel` | 取消呼出 | 是 | 取消 pending 任务 |
| 21 | `GET /calls/{callId}/events` | 话单事件 | 是 | 无 |
| 22 | `POST /sync` | 触发同步 | 是（幂等键） | 拉取上游数据 |
| 23 | `GET /sync` | 同步作业列表 | 是 | 无 |
| 24 | `GET /sync/{jobId}` | 同步作业详情 | 是 | 无 |
| 25 | `GET /jobs` | 作业列表 | 是 | 无 |
| 26 | `GET /jobs/{jobId}` | 作业详情 | 是 | 无 |
| 27 | `GET /events` | 事件查询 | 是 | 无 |
| 28 | `GET /events/stream` | SSE 事件流 | 是 | 长连接 |
| 29 | `POST /webhooks/test` | 测试 webhook | 否 | 发出测试请求 |
| 30 | `GET /terms` | 词表列表 | 是 | 无 |
| 31 | `PUT /terms` | 全量替换词表 | 是（天然幂等） | 覆盖词表 |
| 32 | `POST /terms` | 新增词条 | 是（幂等键） | 写词表 |
| 33 | `PATCH /terms/{termId}` | 修改词条 | 是 | 写词表 |
| 34 | `DELETE /terms/{termId}` | 删除词条 | 是 | 写词表 |
| 35 | `POST /text/normalize` | 文本归一化 | 是 | 无 |

---

## 4. 平台接口

### 4.1 `GET /health`

存活探针（不做上游检查，快速返回）。

**响应 200**

```json
{ "ok": true, "data": { "ok": true, "uptimeSec": 3610, "version": "0.1.0", "startedAt": "2026-11-14T09:00:00+08:00" }, "meta": { "requestId": "req_...", "ts": "..." } }
```

**错误**：`UNAUTHORIZED`、`INTERNAL_ERROR`

---

### 4.2 `GET /status`

平台自身健康（对应图中 `getStatus → Status`）。含账号池、上游可达、DB、拨打时段、队列积压、同步延迟。

**Query**

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `detail` | boolean | true | 是否返回 `accountsDetail` 全量账号摘要 |

**响应 200**：`data: StatusPayload`（见 2.11）

```jsonc
{
  "ok": true,
  "data": {
    "version": "0.1.0",
    "startedAt": "2026-11-14T09:00:00+08:00",
    "uptimeSec": 3610,
    "now": "2026-11-14T10:00:00+08:00",
    "db": { "ok": true, "schemaVersion": 1, "sizeBytes": 25165824, "walSizeBytes": 1048576, "latencyMs": 1 },
    "accounts": { "total": 2, "online": 1, "expired": 1, "loggingIn": 0, "error": 0, "disabled": 0 },
    "accountsDetail": [ { "accountId": "main", "state": "online", "jwtExpiresAt": "2026-11-21T09:00:00+08:00", "dialMode": "callback" } ],
    "upstream": { "reachable": true, "lastCheckedAt": "2026-11-14T09:59:50+08:00", "latencyMs": 180 },
    "dialWindow": { "open": true, "windowStart": "07:50", "windowEnd": "22:00", "timezone": "Asia/Shanghai", "nextOpenAt": null },
    "queues": { "jobsQueued": 3, "jobsRunning": 1, "jobsFailed24h": 0, "audioPending": 2, "transcriptPending": 1, "analysisPending": 0 },
    "sync": { "lastSyncAt": "2026-11-14T09:59:30+08:00", "laggingAccounts": [], "lastError": null },
    "events": { "sseClients": 1 },
    "limits": { "apiQps": 100, "perAccountConcurrency": 1, "globalConcurrency": 8, "dialCooldownMs": 60000 }
  },
  "meta": { "requestId": "req_...", "ts": "..." }
}
```

**错误**：`UNAUTHORIZED`、`DB_UNAVAILABLE`、`INTERNAL_ERROR`

---

### 4.3 `GET /config`

**响应 200**：`data: Config`（2.13，敏感值脱敏）。

**错误**：`UNAUTHORIZED`、`CONFIG_INVALID`、`INTERNAL_ERROR`

---

### 4.4 `PATCH /config`

JSON Merge Patch（RFC 7386 语义：对象递归合并；显式 `null` 删除该配置项并回落默认值；数组整体替换）。仅允许修改 2.13 中非密钥字段。

**请求体示例**

```jsonc
{ "dial": { "scheduleOutsideWindow": false }, "sync": { "intervalMs": 120000 } }
```

**响应 200**

```jsonc
{ "ok": true, "data": { "...": "完整 Config", "restartRequired": true }, "meta": { "requestId": "req_...", "ts": "..." } }
```

**错误**：`INVALID_REQUEST`（非对象/未知字段）、`VALIDATION_FAILED`（取值范围）、`CONFIG_INVALID`（只读字段）、`UNAUTHORIZED`

> 校验要点：`windowStart < windowEnd`；`pageSize ∈ [10,100]`；`intervalMs ≥ 10000`；`perAccountConcurrency=1`（v1 回拨模式固定，其他值 → `VALIDATION_FAILED`）。

---

## 5. 账号接口

### 5.1 `GET /accounts`

**Query**

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean? | — | 过滤启用状态 |
| `state` | string? | — | 过滤账号状态（逗号分隔） |
| `page` / `size` | int | 1 / 20 | 分页（≤200 账号时可 `size=200`） |

**响应 200**：`data: AccountSummary[]`，`meta.pagination` 存在。

**错误**：`UNAUTHORIZED`、`INTERNAL_ERROR`

---

### 5.2 `POST /accounts`

注册本地账号（凭证写入加密存储，不落明文；响应不回传密码）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `accountId` | string | 是 | slug：`^[a-z0-9][a-z0-9_-]{1,31}$`，唯一 |
| `displayName` | string | 是 | 展示名（1–64 字符） |
| `username` | string | 是 | 上游登录手机号（11 位） |
| `password` | string | 是 | 上游登录密码（**write-only**，8–64 字符；不会出现在任何响应/日志） |
| `concurrency` | int | 否 | 默认 1（v1 回拨模式仅允许 1） |
| `browser` | object | 否 | `{ headless?: boolean, profileDirName?: string }` |
| `metadata` | object | 否 | 自定义键值（≤10 个，值 ≤256 字符） |

**响应 201**

```jsonc
{ "ok": true, "data": { "accountId": "main", "displayName": "主账号", "upstreamUsername": "138****0000", "upstreamUsernameMasked": "156****0075", "enabled": true, "state": "unknown", "dialMode": "callback", "createdAt": "2026-11-14T10:00:00+08:00" }, "meta": { "requestId": "req_...", "ts": "..." } }
```

**错误**：`VALIDATION_FAILED`（字段非法或 `accountId` 已存在，`details.fields[]` 指明重复字段）、`CONFIG_INVALID`（配置层拒绝，如 profile 目录不可用）、`UNAUTHORIZED`、`INTERNAL_ERROR`

> 注：注册后不会自动登录；需调用 `POST /accounts/{accountId}/login`。

---

### 5.3 `GET /accounts/{accountId}`

**响应 200**：`data: AccountDetail`。

**错误**：`ACCOUNT_NOT_FOUND`、`UNAUTHORIZED`

---

### 5.4 `PATCH /accounts/{accountId}`

**请求体**（均可选）：`{ displayName?, enabled?, password? (write-only, 轮换凭证), browser?: { headless? }, metadata? }`

**响应 200**：`data: AccountDetail`

**行为**：
- `enabled=false`：停止调度与同步，保留数据；正在进行的呼出不受影响（会先在事件中提示）。
- 修改 `password`：清除现有会话，下次调用需重新登录（可选 `?relogin=true` 立即触发）。

**错误**：`ACCOUNT_NOT_FOUND`、`VALIDATION_FAILED`、`UNAUTHORIZED`

---

### 5.5 `DELETE /accounts/{accountId}`

**Query**

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `purgeData` | boolean | false | true=删除该账号全部话单/录音/转写（不可恢复） |
| `confirm` | string | — | `purgeData=true` 时必填，值必须为 `PURGE:<accountId>` |

**行为**：
- 默认：删除账号配置/凭证/浏览器 profile，`Call` 等历史数据保留（账号行标记 `deletedAt`，话单列表/详情仍可查，`accountId` 保留）。
- `purgeData=true`：级联删除该账号所有 `Call`、`AudioAsset`（含磁盘文件）、`Transcript`、`AnalysisResult`、`CallEvent`、`Job`；操作完成后写审计日志。

**响应 204**

**错误**：`ACCOUNT_NOT_FOUND`、`VALIDATION_FAILED`（confirm 不匹配）、`UNAUTHORIZED`

---

### 5.6 `POST /accounts/{accountId}/login`

触发自动登录（浏览器 + 阿里云滑块）。默认同步等待登录结束（v1 简化）；可异步。

**请求体**

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `wait` | boolean | true | 是否等待登录结果（最多 `timeoutMs`） |
| `timeoutMs` | int | 120000 | 等待上限（10000–300000） |
| `force` | boolean | false | 已有有效会话时是否强制重新登录 |

**响应（wait=true，成功）200**

```jsonc
{
  "ok": true,
  "data": { "accountId": "main", "state": "online", "loggedIn": true, "jwtExpiresAt": "2026-11-21T10:00:00+08:00", "loginJobId": "job_01J8Z..." },
  "meta": { "requestId": "req_...", "ts": "...", "idempotencyReplayed": false }
}
```

**响应（wait=false）202**

```jsonc
{ "ok": true, "data": { "loginJobId": "job_01J8Z...", "status": "queued", "pollUrl": "/api/v1/jobs/job_01J8Z..." }, "meta": { "requestId": "req_...", "ts": "..." } }
```

**错误**：

| HTTP | code | 场景 |
| --- | --- | --- |
| 404 | `ACCOUNT_NOT_FOUND` | 账号不存在 |
| 409 | `ACCOUNT_LOGIN_IN_PROGRESS` | 已有登录作业在跑（`details.loginJobId`） |
| 422 | `ACCOUNT_LOGIN_FAILED` | 滑块失败/密码错误/二次验证（`details.reason`：`captcha_failed`/`bad_credentials`/`need_human`） |
| 502 | `UPSTREAM_UNREACHABLE` | 登录页不可达 |
| 500 | `INTERNAL_ERROR` | 浏览器启动失败等 |

> 说明：登录需要浏览器环境；若服务以 headless 启动且无可用显示，将返回 500 `INTERNAL_ERROR`（`details.needDisplay=true`），运维文档（10）给出 Xvfb 方案。

---

### 5.7 `POST /accounts/{accountId}/logout`

清除本地会话（JWT/cookie/WS），不注销上游账号。**幂等**。

**响应 204**

**错误**：`ACCOUNT_NOT_FOUND`、`INTERNAL_ERROR`

---

### 5.8 `GET /accounts/{accountId}/health`

主动健康检查（会触发上游探测：userDetail + 线路 + WS 状态；结果缓存 30s）。

**响应 200**：`data: AccountHealth`（2.4）

```jsonc
{
  "ok": true,
  "data": {
    "accountId": "main",
    "state": "online",
    "jwt": { "valid": true, "expiresAt": "2026-11-21T10:00:00+08:00", "expiresInSec": 583200 },
    "ws": { "connected": true, "lastPongAt": "2026-11-14T10:00:00+08:00", "latencyMs": 47 },
    "upstream": { "reachable": true, "latencyMs": 180, "checkedAt": "2026-11-14T10:00:00+08:00" },
    "line": { "lineId": "9", "lineName": "电信回拨", "mode": 1 },
    "dialWindow": { "open": true, "windowStart": "07:50", "windowEnd": "22:00", "timezone": "Asia/Shanghai", "nextOpenAt": null },
    "busy": { "inCall": false },
    "lastError": null
  },
  "meta": { "requestId": "req_...", "ts": "..." }
}
```

**错误**：`ACCOUNT_NOT_FOUND`、`UPSTREAM_UNREACHABLE`（探测失败时仍返回 200，`data.upstream.reachable=false`，不报错）、`UNAUTHORIZED`

---

## 6. 呼出与话单接口

### 6.1 `POST /calls` — 发起呼出（图中 `Dail`）

**语义**：异步受理。通过校验后进入 `pending`，由调度器在拨打时段内提交上游（回拨模式：先振铃坐席手机，坐席接听后桥接客户）。**有真实副作用与计费**。

**请求头**：`Idempotency-Key`（推荐）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `to` | string | 是 | 被叫号码：大陆手机 `^1[3-9]\d{9}$` 或固话 `^0\d{2,3}-?\d{7,8}$`（允许空格/横线，服务端规范化） |
| `accountId` | string | 否 | 指定账号；仅 1 个启用账号时可省略，多账号省略 → 400 `VALIDATION_FAILED`（`details.reason=account_required`） |
| `customerName` | string | 否 | 客户名（≤64 字符，落库） |
| `metadata` | object | 否 | 自定义键值（≤10 个），随话单保存并出现在详情 `metadata` |
| `scheduledAt` | string | 否 | 期望呼出时间（ISO）；仅允许未来时间且须在窗口内；省略=立即 |
| `dryRun` | boolean | 否 | true=只做校验不真正呼出，返回将执行的计划（不产生 Call） |

**校验顺序（重要）**：
1. 参数/号码格式；
2. 幂等键；
3. 账号存在且 enabled、会话健康；
4. 拨打时段（`dialWindow.open`；`scheduleOutsideWindow=true` 时允许入队等待，否则 422 `CALL_OUTSIDE_DIAL_WINDOW`）；
5. 防重：同 `accountId+to` 在 `dialCooldownMs` 内仍有未终态呼出 → 409 `ACCOUNT_BUSY`/`IDEMPOTENCY_CONFLICT`；
6. 账号级并发（回拨串行）→ 409 `ACCOUNT_BUSY`（`details.busyCallId`）；
7. 上游号码查重 `getExistOther`（若返回"已存在其它客户记录"，v1 **不阻断**，仅在 `details.warnings` 返回 `number_exists_in_crm`，避免影响业务）。

**响应 201（受理）**

```jsonc
{
  "ok": true,
  "data": {
    "callId": "call_01J8Z3K5T9QW2M4R7X1C6V0B8N",
    "accountId": "main",
    "upstreamCallId": null,
    "direction": "outbound",
    "to": { "phone": "138****0000" },
    "from": { "phone": "156****0075" },
    "status": "pending",
    "statusReason": "等待调度",
    "pipeline": { "audio": "pending", "transcript": "pending", "analysis": "pending" },
    "audioAvailable": false,
    "createdAt": "2026-11-14T10:05:00+08:00",
    "updatedAt": "2026-11-14T10:05:00+08:00"
  },
  "meta": { "requestId": "req_...", "ts": "...", "idempotencyReplayed": false }
}
```

**响应 202（dryRun=false 且服务端选择异步提交）** — v1 默认同步受理返回 201，保留 202 能力（`data` 为 `CallAccepted`=CallSummary，下面为节选，完整字段见 §2.5）：

```jsonc
{ "ok": true, "data": { "callId": "call_...", "status": "pending" }, "meta": { "requestId": "req_...", "ts": "..." } }
```

**响应 200（dryRun=true）**

```jsonc
{
  "ok": true,
  "data": {
    "dryRun": true,
    "willDial": true,
    "accountId": "main",
    "to": "138****0000",
    "dialWindow": { "open": true, "windowStart": "07:50", "windowEnd": "22:00", "timezone": "Asia/Shanghai" },
    "warnings": ["number_exists_in_crm"],
    "estimatedCost": null
  },
  "meta": { "requestId": "req_...", "ts": "..." }
}
```

**错误**：

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` / `VALIDATION_FAILED` | 号码非法、缺 accountId、metadata 超限、scheduledAt 非法 |
| 404 | `ACCOUNT_NOT_FOUND` | accountId 不存在 |
| 403 | `ACCOUNT_DISABLED` | 账号已停用 |
| 409 | `ACCOUNT_BUSY` | 账号正在通话 | 
| 409 | `IDEMPOTENCY_CONFLICT` | 幂等键冲突/重复呼出 |
| 422 | `CALL_OUTSIDE_DIAL_WINDOW` | 时段外且未允许排队（`retryAfter` 给出下次窗口） |
| 422 | `CALL_NOT_DIALABLE` | 上游判定号码不可拨（黑名单/空号/上游业务判定）；CRM 查重命中默认不阻断（见下方说明） |
| 502 | `UPSTREAM_BUSINESS_ERROR` | 上游拒绝（`details.upstreamCode/Message`） |
| 503 | `UPSTREAM_AUTH_EXPIRED` | 账号登录失效（可先调用 login） |
| 502 | `UPSTREAM_UNREACHABLE` | 网络/上游不可用 |

**示例：时段外**

```jsonc
{
  "ok": false,
  "error": {
    "code": "CALL_OUTSIDE_DIAL_WINDOW",
    "message": "当前不在可拨号时段（07:50–22:00，Asia/Shanghai）",
    "retryable": true,
    "retryAfter": "2026-11-15T07:50:00+08:00",
    "details": { "upstreamCode": 10056, "upstreamMessage": "拨打时间段在7:50-22:00之间" }
  },
  "meta": { "requestId": "req_...", "ts": "2026-11-14T22:42:19+08:00" }
}
```

---

### 6.2 `GET /calls` — 话单列表（图中 `getOutboundList → outboundList`）

**Query**

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `accountId` | string? | — | 账号过滤（多账号聚合时可用逗号分隔） |
| `status` | string? | — | 单个状态或逗号分隔（如 `connected,ended`） |
| `pipeline.audio` | string? | — | 按阶段状态过滤（`audio`/`transcript`/`analysis` + 值） |
| `hasAudio` | boolean? | — | 是否有归档录音 |
| `hasTranscript` | boolean? | — | 是否有转写 |
| `to` | string? | — | 被叫号码（支持后 4 位模糊：`*1234`） |
| `q` | string? | — | 全文搜索：客户名/号码/转写全文（≤64 字符；检索方案见 04，v1 为归一化全文 LIKE） |
| `dateFrom` / `dateTo` | date? | — | `startedAt` 日期区间（`YYYY-MM-DD`，含端点，Asia/Shanghai）；注意 `to` 已被占用于被叫号码 |
| `sort` | string | `-createdAt` | 允许：`createdAt`/`dialedAt`/`endedAt`/`durationSec`，前缀 `-` 降序 |
| `page` / `size` | int | 1 / 20 | size ≤ 100 |
| `includePipeline` | boolean | true | 是否返回 pipeline 状态（false 时 pipeline 全为 null 减少体积） |

**响应 200**：`data: CallSummary[]` + `meta.pagination`

```jsonc
{
  "ok": true,
  "data": [
    {
      "callId": "call_01J8Z...",
      "accountId": "main",
      "upstreamCallId": "2121158093386702849",
      "direction": "outbound",
      "to": { "phone": "186****3330", "location": "河北 衡水" },
      "from": { "phone": "156****0075", "location": "北京 北京" },
      "lineNumber": "180****0053",
      "customerName": null,
      "lineId": "9",
      "lineName": "回拨专线",
      "status": "ended",
      "dialedAt": "2026-11-13T16:27:58+08:00",
      "answeredAt": "2026-11-13T16:27:58+08:00",
      "endedAt": "2026-11-13T16:28:13+08:00",
      "durationSec": 15,
      "cost": 0.14,
      "upstreamStatus": { "callStatus": 1, "callStatusName": "已接通", "finishStatus": 4, "finishStatusName": "其他" },
      "pipeline": { "audio": "ready", "transcript": "ready", "analysis": "ready", "lastError": null },
      "transcriptPreview": "喂。喂，李总，你好。嗯。我是看你们阿里做了很多年了…",
      "audioAvailable": true,
      "createdAt": "2026-11-13T16:27:53+08:00",
      "updatedAt": "2026-11-13T16:30:00+08:00"
    }
  ],
  "meta": { "requestId": "req_...", "ts": "...", "pagination": { "page": 1, "size": 20, "total": 1073, "totalPages": 54 } }
}
```

**错误**：`VALIDATION_FAILED`（日期/size/sort 非法）、`UNAUTHORIZED`、`DB_UNAVAILABLE`

---

### 6.3 `GET /calls/{callId}` — 话单摘要（图中 `Dial Status`）

**响应 200**：`data: CallSummary`

**错误**：`CALL_NOT_FOUND`、`UNAUTHORIZED`

---

### 6.4 `GET /calls/{callId}/detail` — 话单详情（图中 `getOutboundDetail → outboundDetail`）

**Query**

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `includeRaw` | boolean | false | 是否返回上游原始 `upstream.raw`（体积大，调试用） |
| `includeEvents` | boolean | false | 是否内联最近 50 条事件（`data.events`） |
| `includeAnalysis` | boolean | false | 是否返回完整 AI 后处理产出（`data.analysisPayload`，含 promptVersion/usage） |

**响应 200**：`data: CallDetail`（2.9）

```jsonc
{
  "ok": true,
  "data": {
    "callId": "call_01J8Z...",
    "accountId": "main",
    "upstreamCallId": "2121158093386702849",
    "direction": "outbound",
    "to": { "phone": "186****3330", "location": "河北 衡水" },
    "from": { "phone": "156****0075", "location": "北京 北京" },
    "lineNumber": "180****0053",
    "customerName": null,
    "lineId": "9",
    "lineName": "回拨专线",
    "status": "ended",
    "statusReason": null,
    "dialedAt": "2026-11-13T16:27:58+08:00",
    "answeredAt": "2026-11-13T16:27:58+08:00",
    "endedAt": "2026-11-13T16:28:13+08:00",
    "durationSec": 15,
    "cost": 0.14,
    "pipeline": { "audio": "ready", "transcript": "ready", "analysis": "ready", "lastError": null },
    "audioAvailable": true,
    "upstream": {
      "callStatusName": "已接通", "finishStatus": 4, "finishStatusName": "其他",
      "callType": 1, "handle": 1, "interfaceId": "9", "interfaceName": "电信回拨",
      "telA": "156****0075", "telB": "186****3330", "telX": "180****0053",
      "postage": 0.14, "agentCode": 1058, "sipCodeResult": null,
      "callerAttr": "北京 北京", "calleeAttr": "河北 衡水",
      "tenantCode": "24421", "enterpriseName": "某网络科技有限公司（脱敏）"
    },
    "timeline": { "createdAt": "2026-11-13T16:27:53+08:00", "submittedAt": "2026-11-13T16:27:56+08:00", "dialingAt": "2026-11-13T16:27:56+08:00", "connectedAt": "2026-11-13T16:27:58+08:00", "endedAt": "2026-11-13T16:28:13+08:00" },
    "pipelineDetail": {
      "audio": { "status": "ready", "audioId": "aud_01J8Z...", "downloadedAt": "2026-11-13T16:29:10+08:00" },
      "transcript": { "status": "ready", "transcriptId": "tr_01J8Z...", "source": "asr", "provider": "minimax:asr-1.0", "chunkCount": 1, "needsReview": false, "generatedAt": "2026-11-13T16:28:40+08:00" },
      "analysis": { "status": "ready", "analysisId": "ana_01J8Z...", "generatedAt": "2026-11-13T16:30:00+08:00" }
    },
    "recording": { "available": true, "downloadUrl": "/api/v1/calls/call_01J8Z.../audio", "format": "wav", "durationMs": 15060, "sizeBytes": 481964, "sha256": "ab12…", "sampleRate": 16000, "channels": 1 },
    "transcript": { "available": true, "source": "asr", "segmentCount": 7, "needsReview": false, "url": "/api/v1/calls/call_01J8Z.../transcript" },
    "analysis": { "available": true, "analysisId": "ana_01J8Z...", "summary": "客户为外贸公司负责人，对客户管理系统有初步兴趣。", "intent": "medium", "url": "/api/v1/calls/call_01J8Z.../transcript?includeAnalysis=true" },
    "eventsCount": 6,
    "metadata": {},
    "createdAt": "2026-11-13T16:27:53+08:00",
    "updatedAt": "2026-11-13T16:30:00+08:00"
  },
  "meta": { "requestId": "req_...", "ts": "..." }
}
```

**错误**：`CALL_NOT_FOUND`、`UNAUTHORIZED`、`DB_UNAVAILABLE`

---

### 6.5 `GET /calls/{callId}/transcript` — 转写

**Query**

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `includeAnalysis` | boolean | false | 附带 AI 后处理结果 |
| `format` | string | `json` | v1 固定 `json`（预留 `text`/`srt`） |
| `version` | string | `current` | `current` 或 transcriptId（历史版本，v1 预留） |

**响应 200**：`data: TranscriptPayload`（2.9）

**错误**：

| HTTP | code | 场景 |
| --- | --- | --- |
| 404 | `CALL_NOT_FOUND` | |
| 422 | `TRANSCRIPT_NOT_AVAILABLE` | 未接通/无录音且无法转写 |
| 409 | `TRANSCRIPT_PENDING` | 本地 ASR 处理中（`details.stage`：`asr_queued`/`asr_running`/`role_mapping`/`analysis`） |
| 404 | `NOT_FOUND` | 转写版本不存在（version 指定） |
| 503 | `DB_UNAVAILABLE` | |

> 建议客户端：先查 `detail` 的 `pipeline.transcript` 状态；`ready` 后再取转写，避免 409。

---

### 6.6 `GET /calls/{callId}/audio` — 原始录音

**Query**

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `download` | boolean | false | true 时附加 `Content-Disposition: attachment; filename="<callId>.wav"` |

**响应 200**（二进制）

| 响应头 | 值 |
| --- | --- |
| `Content-Type` | `audio/wav` |
| `Content-Length` | 文件字节数 |
| `Accept-Ranges` | `bytes` |
| `ETag` | `"<sha256>"` |
| `Cache-Control` | `private, max-age=86400` |

支持 `Range: bytes=0-1023` → `206 Partial Content` + `Content-Range`。

**错误**：

| HTTP | code | 场景 |
| --- | --- | --- |
| 404 | `CALL_NOT_FOUND` | |
| 422 | `AUDIO_NOT_AVAILABLE` | 未接通无录音/上游录音缺失 |
| 409 | `AUDIO_NOT_READY` | 录音下载中（`Retry-After: 10`） |
| 404 | `NOT_FOUND` | 文件丢失（DB 有记录但磁盘缺失 → 同时推 `call.audio.failed` 事件并触发重下） |

---

### 6.7 `POST /calls/{callId}/reprocess`

重跑流水线阶段（不改变 Call.status；幂等；同一 call 同时只允许一个 reprocess 作业）。

**请求头**：`Idempotency-Key`（推荐）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `stages` | string[] | 是 | 子集：`["audio","transcript","analysis"]`（`analysis` 隐含需要 transcript） |
| `force` | boolean | 否 | true=忽略已 ready 状态强制重跑（默认 false，只处理未完成阶段） |
| `options` | object | 否 | `{ asrModel?: string, analysisModel?: string, promptVersion?: string, termRulesVersion?: string }` |

**响应 202**

```jsonc
{ "ok": true, "data": { "jobId": "job_01J8Z...", "callId": "call_01J8Z...", "stages": ["transcript","analysis"], "status": "queued", "pollUrl": "/api/v1/jobs/job_01J8Z..." }, "meta": { "requestId": "req_...", "ts": "..." } }
```

**错误**：`CALL_NOT_FOUND`、`VALIDATION_FAILED`（stages 为空/非法）、`RATE_LIMITED`（该话单已有 reprocess 作业在跑 → 429，`details.reason=reprocess_in_progress`）、`CALL_ALREADY_TERMINAL`（已取消/不存在的话单）、`UNAUTHORIZED`

---

### 6.8 `POST /calls/{callId}/cancel`

仅取消本地尚未提交上游的呼出（`pending`）。已提交（`dialing`+）不可取消（上游无取消接口），返回 409 `CALL_NOT_CANCELABLE`。

**响应 200**：`data: CallSummary`（status=`canceled`）

**错误**：`CALL_NOT_FOUND`、`CALL_NOT_CANCELABLE`、`CALL_ALREADY_TERMINAL`、`UNAUTHORIZED`

---

### 6.9 `GET /calls/{callId}/events`

**Query**：`types`（逗号分隔）、`page`/`size`（默认 1/50，≤200）、`sort` 固定 `occurredAt asc`。

**响应 200**：`data: EventRecord[]` + `meta.pagination`

**错误**：`CALL_NOT_FOUND`、`UNAUTHORIZED`

---

## 7. 同步 / 作业 / 事件 / 词表接口

### 7.1 `POST /sync`

触发同步作业。**幂等**（相同 `mode+accountId` 在 10s 内重复触发会合并/返回同一作业）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `mode` | enum | 是 | `incremental` / `full` / `backfill` |
| `accountId` | string | 否 | 省略=全部启用账号 |
| `from` / `to` | date | 否 | 仅 `backfill` 用，日期区间（含端点） |
| `wait` | boolean | 否 | 默认 false；true 时同步等待作业结束（上限 `timeoutMs`） |
| `timeoutMs` | int | 否 | 默认 30000，≤600000 |

**响应 202**

```jsonc
{ "ok": true, "data": { "jobId": "job_01J8Z...", "type": "sync", "mode": "incremental", "accountId": null, "status": "queued", "pollUrl": "/api/v1/jobs/job_01J8Z..." }, "meta": { "requestId": "req_...", "ts": "..." } }
```

> `mode=full`：同步完成后，平台会为历史话单自动入队 `asr`/`analysis` 作业（全量回补，不设预算上限但记录用量；进度可通过 `/jobs` 观测；可暂停/恢复见 docs/13 §3.4）。

`wait=true` 且完成 → 200，`data` 为 JobDetail（含 `result: { fetched, upserted, skipped, failed }`）。

**错误**：`VALIDATION_FAILED`（mode/日期区间非法）、`ACCOUNT_NOT_FOUND`、`ACCOUNT_LOGIN_REQUIRED`（该账号无有效会话，`details.accounts[]`）、`UNAUTHORIZED`、`UPSTREAM_UNREACHABLE`（全量账号都不可达时）

---

### 7.2 `GET /sync`

**Query**：`accountId?`、`status?`、`page/size`（默认 1/20）。

**响应 200**：`data: JobSummary[]`（`type=sync` 的作业）+ pagination。

---

### 7.3 `GET /sync/{jobId}`

**响应 200**：`data: JobDetail`

**错误**：`JOB_NOT_FOUND`、`UNAUTHORIZED`

---

### 7.4 `GET /jobs`

**Query**：`type?`（逗号分隔）、`status?`、`accountId?`、`callId?`、`page/size`（默认 1/20，≤100）、`sort`（默认 `-createdAt`）。

**响应 200**：`data: JobSummary[]` + pagination。

---

### 7.5 `GET /jobs/{jobId}`

**响应 200**：`data: JobDetail`

**错误**：`JOB_NOT_FOUND`

---

### 7.6 `GET /events`

**Query**

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `types` | string? | — | 逗号分隔，支持前缀通配 `call.*` |
| `callId` / `accountId` | string? | — | 过滤 |
| `since` / `until` | string? | — | `occurredAt` 区间（ISO） |
| `page` / `size` | int | 1 / 50 | size ≤ 200 |
| `sort` | string | `-occurredAt` | 仅支持时间排序 |

**响应 200**：`data: EventRecord[]` + pagination。

---

### 7.7 `GET /events/stream` — SSE

**Query**：`types?`（逗号分隔，通配）、`accountId?`、`callId?`。

**SSE 事件格式**

```
event: call.connected
id: evt_01J8Z3K5T9QW2M4R7X1C6V0B8N
data: {"eventId":"evt_01J8Z3K5T9QW2M4R7X1C6V0B8N","type":"call.connected","occurredAt":"2026-11-14T10:03:12+08:00","accountId":"main","callId":"call_01J8Z3K5T9QW2M4R7X1C6V0B8N","data":{"answeredAt":"2026-11-14T10:03:12+08:00"}}

: ping
```

- 每 15s 发送 `: ping` 保活；连接建立后先回放？**不回放**：客户端可用 `GET /events?since=` 补齐后，再带 `Last-Event-ID` 续传。
- `Last-Event-ID`：服务端从该事件之后推送（若已不可得，发送一条 `event: stream.reset` 提示客户端重新拉历史）。
- HTTP 头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`。
- 断线：客户端指数退避重连（1s 起，上限 30s）。

**错误**：`UNAUTHORIZED`（SSE 建连前校验）。

---

### 7.8 `POST /webhooks/test`

测试 webhook 出站配置（v1 可选；若未配置 webhook，返回 400 `VALIDATION_FAILED`，`details.reason=no_webhook_configured`）。

**请求体**：`{ "url": "https://example.com/hook", "eventType": "call.ended" }`（url 必须 https）
**响应 200**：`data: WebhookTestResult`，示例 `{ "delivered": true, "statusCode": 200, "latencyMs": 120 }`；投递失败时 `delivered:false` 且 `deliveryError` 给出原因（HTTP 502 `UPSTREAM_UNREACHABLE`）。
**错误**：`VALIDATION_FAILED`（非 https/非法 URL；未配置 webhook 时同码，`details.reason=no_webhook_configured`）、`UPSTREAM_UNREACHABLE`（投递失败用 `details.deliveryError`）。

---

### 7.9 词表接口

#### `GET /terms`

**Query**：`q?`（匹配 from/to）、`category?`、`enabled?`、`page/size`（默认 1/50，≤500）。

**响应 200**：`data: TermRule[]` + pagination。

#### `PUT /terms` — 全量替换（导入）

**请求体**：`{ "rules": TermRuleInput[], "mode": "replace" }`；`TermRuleInput` 同 2.10（无 `termId/createdAt/updatedAt`）。
**行为**：校验全部规则（`from` 非空、`to` 非空、`to` 不得出现在自身 `from` 中、全局冲突按 priority 高者生效）；原子替换（事务）。
**响应 200**：`{ "count": 42, "version": "2026-11-14T10:00:00+08:00" }`
**错误**：`VALIDATION_FAILED`（`details.fields[]` 指出第几条规则哪项非法）、`UNAUTHORIZED`

#### `POST /terms`

**请求体**：`TermRuleInput`（2.10）
**响应 201**：`data: TermRule`
**错误**：`VALIDATION_FAILED`（冲突/格式）、`UNAUTHORIZED`

#### `PATCH /terms/{termId}`

**请求体**：`TermRuleInput` 的部分字段。
**响应 200**：`data: TermRule`
**错误**：`TERM_NOT_FOUND`、`VALIDATION_FAILED`

#### `DELETE /terms/{termId}`

**响应 204**
**错误**：`TERM_NOT_FOUND`（termId 不存在 → 404；**不采用幂等 204**，以便及时发现拼写/悬空引用错误）。

#### `POST /text/normalize`

文本归一化（同步、无副作用；可用于 agent 预处理）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `text` | string | 是 | 1–20000 字符 |
| `options` | object | 否 | `{ includeUnchanged?: boolean, categoryFilter?: string[] }` |

**响应 200**

```jsonc
{
  "ok": true,
  "data": {
    "original": "复萌那边说福梦的系统不错",
    "normalized": "孚盟那边说孚盟的系统不错",
    "applied": [ { "from": "复萌", "to": "孚盟", "count": 1 }, { "from": "福梦", "to": "孚盟", "count": 1 } ],
    "rulesVersion": "2026-11-14T10:00:00+08:00"
  },
  "meta": { "requestId": "req_...", "ts": "..." }
}
```

**错误**：`VALIDATION_FAILED`（超长/空文本）、`UNAUTHORIZED`

---

## 8. 错误码使用矩阵（按接口类型）

> 通用错误（`UNAUTHORIZED`/`INTERNAL_ERROR`/`DB_UNAVAILABLE`）所有接口都可能出现，下表省略。

| 接口组 | 可出现的业务错误码 |
| --- | --- |
| `/status` `/config` `/health` | `CONFIG_INVALID`（config） |
| `/accounts*` | `ACCOUNT_NOT_FOUND` `ACCOUNT_DISABLED` `ACCOUNT_LOGIN_IN_PROGRESS` `ACCOUNT_LOGIN_FAILED` `VALIDATION_FAILED` `CONFIG_INVALID` `UPSTREAM_UNREACHABLE` |
| `/calls`（写） | `INVALID_REQUEST` `VALIDATION_FAILED` `ACCOUNT_NOT_FOUND` `ACCOUNT_DISABLED` `ACCOUNT_BUSY` `ACCOUNT_LOGIN_REQUIRED` `CALL_OUTSIDE_DIAL_WINDOW` `CALL_NOT_DIALABLE` `IDEMPOTENCY_CONFLICT` `CALL_REJECTED_BY_UPSTREAM` `UPSTREAM_AUTH_EXPIRED` `UPSTREAM_UNREACHABLE` `UPSTREAM_BUSINESS_ERROR` `UPSTREAM_RESPONSE_INVALID` |
| `/calls`（读） | `CALL_NOT_FOUND` `VALIDATION_FAILED` |
| `/calls/{id}/transcript` | `CALL_NOT_FOUND` `TRANSCRIPT_NOT_AVAILABLE` `TRANSCRIPT_PENDING` |
| `/calls/{id}/audio` | `CALL_NOT_FOUND` `AUDIO_NOT_AVAILABLE` `AUDIO_NOT_READY` `NOT_FOUND` |
| `/calls/{id}/reprocess` | `CALL_NOT_FOUND` `CALL_ALREADY_TERMINAL` `VALIDATION_FAILED` `RATE_LIMITED` |
| `/calls/{id}/cancel` | `CALL_NOT_FOUND` `CALL_NOT_CANCELABLE` `CALL_ALREADY_TERMINAL` |
| `/sync` `/jobs` | `VALIDATION_FAILED` `ACCOUNT_NOT_FOUND` `ACCOUNT_LOGIN_REQUIRED` `JOB_NOT_FOUND` |
| `/events*` | `VALIDATION_FAILED` |
| `/terms*` `/text/normalize` | `VALIDATION_FAILED` `TERM_NOT_FOUND` `IDEMPOTENCY_CONFLICT` |
| `/webhooks/test` | `VALIDATION_FAILED` `UPSTREAM_UNREACHABLE` |

- 所有接口都可能返回 `429 RATE_LIMITED`（本地限流），上表不再逐项列出；响应头 `Retry-After` 给出建议重试秒数。
- 所有接口都可能返回 `503 SERVICE_UNAVAILABLE`（本地服务启动中/优雅关闭/传输中断）；`UPSTREAM_UNREACHABLE` 为 **502**，两者不要混淆。

---

## 9. 幂等、重试与并发语义（摘要）

| 操作 | 幂等键 | 重复请求行为 | 客户端重试建议 |
| --- | --- | --- | --- |
| `POST /calls` | 推荐 | 24h 内同键同体返回首次结果（`meta.idempotencyReplayed=true`）；同键异体 409 | **禁止**无幂等键重试；失败后先 `GET /calls?to=` 核对是否已产生话单 |
| `POST /sync` | 推荐 | 10s 内同参数合并返回同 jobId | 可安全重试（幂等键） |
| `POST /calls/{id}/reprocess` | 推荐 | 已存在相同阶段作业 → 返回已有 jobId（`idempotencyReplayed=true`） | 可安全重试 |
| `POST /accounts/{id}/login` | 推荐 | 已有进行中作业 → 409 `ACCOUNT_LOGIN_IN_PROGRESS`（带 jobId） | 轮询 job 而非重复触发 |
| `POST /accounts/{id}/logout` | 天然幂等 | 重复 → 204 | 可重试 |
| `GET *` | 不适用 | 只读 | 可重试，遵循 `Retry-After` |
| `PATCH /config` `PATCH /accounts/{id}` `PUT /terms` | 天然幂等（全量/合并语义） | 重复写入等价 | 可重试 |

**并发写冲突**：`POST /calls` 对同一账号串行化（账号锁），先到先得；并发第二单返回 409 `ACCOUNT_BUSY`。
**重试-退避**：客户端对 `retryable=true` 的错误按 `Retry-After`（秒）或指数退避（1s→2s→4s，上限 30s，最多 5 次）。

---

## 10. 上游对接注意事项（对调用方的可见影响）

1. **时段**：`dialWindow.open=false` 时 `POST /calls` 依配置排队或拒绝（422 `CALL_OUTSIDE_DIAL_WINDOW`），客户端必须处理该业务拒绝，不要按 5xx 无限重试。
2. **回拨模式**：`POST /calls` 成功 ≠ 客户已接通；坐席手机需先响铃接听。客户端应轮询 `GET /calls/{callId}` 或订阅 SSE，等待 `connected`/`no_answer`。
3. **流水线延迟**：话单/录音由上游生成（录音通常通话结束后数分钟内可下载）；转写由本平台自建 ASR 生成（MiniMax），其后还有说话人角色映射与 DeepSeek 分析。客户端以 `pipeline` 状态为准，不要以"呼出后立即有转写/分析"为前提。
4. **上游改版风险**：`UPSTREAM_RESPONSE_INVALID` 表示契约可能变化；客户端可提示升级平台，而非重试。
5. **计费**：每通呼出都会产生上游话费（实测示例 0.14 元/通），批量调用前请确认业务授权。

---

## 11. 变更管理

- 契约变更流程：先改 [01-决策与约定.md](./01-决策与约定.md)（如涉及全局约定）→ 改本文 → 同步 `spec/openapi.yaml` → 更新 `docs/12-里程碑与验收.md` 验收项。
- 非破坏性变更（新增可选字段/枚举值/接口）：`/api/v1` 内进行，客户端须容错未知字段。
- 破坏性变更（字段删除/类型变更/语义变更）：新增 `/api/v2`，v1 至少保留到 M5 后一个版本周期。
- 兼容性测试：`spec/` 下提供契约用例（M1 起由测试实现）。

---

## 附录 A：接口与图中节点对照

| 图中节点 | 契约落点 |
| --- | --- |
| `SKILL` | docs/08（agent 技能包） |
| `MCP / CLI / Rest / WebUI` | docs/07 / docs/06 / 本文 / WebUI 非 v1 范围 |
| `Dail → Dail Status` | `POST /calls` → `GET /calls/{callId}` |
| `getoutboundlist → outboundlist` | `GET /calls` |
| `getoutboundDetail → outboundDetail` | `GET /calls/{callId}/detail` |
| `getStatus → Status` | `GET /status` |
| `feige client 1..n`（账号池） | `/accounts*` + AccountPool 内部（docs/09） |
| `localdatabase: Record/Audio` | `Call`/`Transcript`/`AnalysisResult`、`AudioAsset`（docs/04） |
| `Dial Process` | 呼出调度器 + 状态机（docs/03/09） |
| `feige outbound platform`（上游） | 上游适配层（docs/09） |

## 附录 B：cURL 速查

```bash
TOKEN=$(cat ~/.config/feige-outbound/api-token)
BASE=http://127.0.0.1:8710/api/v1

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/status" | jq
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/calls?size=5&status=ended" | jq '.data[0]'
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/calls/call_xxx/detail" | jq
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/calls/call_xxx/transcript?includeAnalysis=true" | jq
curl -s -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: 5f0c…' -X POST "$BASE/calls" \
  -d '{"to":"138****0000","accountId":"main"}' | jq   # 示例号码已脱敏
```
