# 07 MCP 工具契约（`feige-outbound`）

> 状态：v0.3（Step 2 设计稿，2026-11-14；按 v1 决策修订：转写=本地自建 ASR（MiniMax `asr-1.0`）、LLM 后处理=DeepSeek、稳定错误码 40 个，已对齐 [01](./01-决策与约定.md)/[05](./05-对外API契约.md)/[13](./13-后处理规格（ASR与LLM）.md)）
> 全局基准：[01-决策与约定.md](./01-决策与约定.md)（冲突以 01 为准）；字段级权威：[05-对外API契约.md](./05-对外API契约.md)；后处理规格：[13-后处理规格（ASR与LLM）.md](./13-后处理规格（ASR与LLM）.md)。
> CLI 契约：[06-CLI契约.md](./06-CLI契约.md)；agent 侧技能：[08-SKILL契约.md](./08-SKILL契约.md)。
> 本文只描述**契约**（MCP server、tools、resources、prompts、错误语义、安全边界），不含实现代码。

---

## 1. 定位

MCP（Model Context Protocol）是 agent 的原生接入方式：以 **stdio** 启动，向 agent 暴露 `feige_*` 工具与 `feige://` 资源；底层语义与 REST 完全一致（[01 §3](./01-决策与约定.md)：「CLI 与 MCP 是 REST 的薄封装」）。

| 项 | 取值 |
| --- | --- |
| server 名称 | `feige-outbound` |
| transport | `stdio`（v1 唯一；其它值不支持） |
| 启动方式 | `feige mcp`（写工具需 `feige mcp --allow-write`） |
| 协议 | MCP JSON-RPC 2.0 over stdio；兼容 `2024-11-05` / `2025-03-26` / `2025-06-18` 版本协商 |
| 服务端实现 | 优先直连平台内核（语义与 REST 一致）；实现路径不改变本文契约 |
| 响应封套 | 与 REST 相同（[01 §5.3](./01-决策与约定.md)）：成功 `{ok:true,data,meta}`，失败 `{ok:false,error,meta}` |
| 输出通道 | stdout 仅 JSON-RPC 帧；日志/诊断一律 stderr |
| 与 REST 差异 | 工具名 snake_case、参数为 JSON Schema；**字段、枚举、错误码、状态机零差异** |

---

## 2. 启动、能力与协议

### 2.1 启动命令

```bash
feige mcp                       # 只读模式：不注册写操作工具
feige mcp --allow-write         # 允许写操作（仍需每次调用 confirm:true）
feige mcp --print-config        # 打印客户端注册配置后退出
```

| 长 | 默认 | 说明 |
| --- | --- | --- |
| `--transport stdio` | `stdio` | v1 仅 stdio |
| `--allow-write` | false | 注册 14 个写操作工具；缺省时这些工具不出现在 `tools/list` |
| `--print-config` | false | 输出 JSON 配置片段便于注册（§10） |
| `--log-level <l>` | `warn` | stderr 日志级别 |

### 2.2 客户端注册示例

```jsonc
{
  "mcpServers": {
    "feige-outbound": {
      "command": "feige",
      "args": ["mcp", "--allow-write"],
      "env": { "FOP_API_URL": "http://127.0.0.1:8710/api/v1" }
    }
  }
}
```

### 2.3 初始化握手

```jsonc
// → initialize（客户端）
{ "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": { "protocolVersion": "2025-06-18", "capabilities": {},
              "clientInfo": { "name": "agent", "version": "1.0.0" } } }

// ← initialize（server）
{ "jsonrpc": "2.0", "id": 1, "result": {
    "protocolVersion": "2025-06-18",
    "serverInfo": { "name": "feige-outbound", "version": "0.1.0", "title": "飞鸽外呼本地平台" },
    "capabilities": {
      "tools":     { "listChanged": false },
      "resources": { "subscribe": true, "listChanged": false },
      "prompts":   { "listChanged": false }
    },
    "instructions": "本地飞鸽外呼平台。读操作直接调用；写操作（dial/login/reprocess/remove 等）需服务端以 --allow-write 启动且调用时传 confirm:true。呼出有真实副作用与计费。"
} }
```

### 2.4 能力声明

| capability | 支持 | 说明 |
| --- | --- | --- |
| `tools` | ✅ | 32 个工具 = 31 个对应 [01 §4.1](./01-决策与约定.md)「MCP」列 + 1 个补充只读探活 `feige_health`（映射 `GET /health`） |
| `tools.listChanged` | ❌ | 工具集在进程生命周期内固定（由 `--allow-write` 决定） |
| `resources` | ✅ | 静态资源 + URI 模板（§7） |
| `resources.subscribe` | ✅ | `feige://status`、账号/话单/转写类资源可订阅（§7.2） |
| `prompts` | ✅ | 3 个只读提示模板（§8） |
| `logging` / `sampling` / `roots` | ❌ | v1 不使用；日志走 stderr |

### 2.5 两类错误的处理边界

| 层级 | 场景 | 表达方式 |
| --- | --- | --- |
| JSON-RPC 协议错误 | 未知方法、未知工具名、inputSchema 校验失败（`confirm:true` 缺失、枚举非法、类型错误） | JSON-RPC `error`：`-32600`/`-32601`/`-32602`/`-32603`；**不进入业务错误码体系** |
| 业务错误 | 平台/上游返回的失败（如 `CALL_OUTSIDE_DIAL_WINDOW`） | 工具结果 `isError:true` + `content[0].text` 为错误封套 JSON，`structuredContent.error` 同构；`error.code` 严格取自 [01 §5.4](./01-决策与约定.md) 的 **40 个**稳定码（v1 已删除原上游转写等待码），**不新增** |
| 传输错误 | 本地平台不可达 / 超时 | 工具结果 `isError:true`，`error.code` 归一为 `SERVICE_UNAVAILABLE`（retryable=true；出自 01 §5.4 HTTP 503 行）；`details.transport` 取 `connect` 或 `timeout` |

---

## 3. 通用约定

### 3.1 工具命名与集合

- 命名：`feige_` + snake_case；与 [01 §4.1](./01-决策与约定.md)「MCP」列一一对应（仅 `feige_health` 为补充只读工具）。
- 写工具 **14 个**：`feige_config_set`、`feige_account_add/update/remove/login/logout`、`feige_dial`、`feige_call_reprocess/cancel`、`feige_sync_start`、`feige_terms_replace/term_add/term_update/term_remove`。
- 只读工具 **18 个**：`feige_health`、`feige_status`、`feige_config_get`、`feige_account_list/get/health`、`feige_call_list/get/detail/transcript/audio/events`、`feige_sync_status`、`feige_job_get/list`、`feige_events_list`、`feige_terms_list`、`feige_text_normalize`。
- 合计 **32 个工具**；其中 `destructiveHint:true` 的 **5 个**：`feige_dial`、`feige_call_cancel`、`feige_account_remove`、`feige_terms_replace`、`feige_term_remove`。

### 3.2 工具注解（annotations）

| 注解 | 含义 | 本 server 约定 |
| --- | --- | --- |
| `readOnlyHint` | 不修改任何状态 | 18 个只读工具 `true`；14 个写工具 `false` |
| `destructiveHint` | 可能造成不可逆/有成本副作用 | `feige_dial`（真实外呼/计费）、`feige_call_cancel`（终止呼出）、`feige_account_remove`（删账号，`purgeData` 连数据）、`feige_terms_replace`（全量替换删旧规则）、`feige_term_remove`（删规则）为 `true`；其余写工具 `false` |
| `idempotentHint` | 相同参数重复调用不产生额外副作用 | 读工具全 `true`；写工具中 `feige_dial`、`feige_account_add`、`feige_term_add` 为 `false`（可传 `idempotencyKey` 复用首次结果），其余写工具 `true` |
| `openWorldHint` | 会访问本地之外的系统 | `feige_status`、`feige_account_login/logout/health`、`feige_dial`、`feige_call_audio`、`feige_call_reprocess`、`feige_sync_start` 为 `true` |

### 3.3 公共字段与枚举（与 01/05 一致）

| 概念 | schema 片段 | 来源 |
| --- | --- | --- |
| `accountId` | `{"type":"string","pattern":"^[a-z0-9][a-z0-9_-]{1,31}$"}` | 01 §5.6 slug |
| `callId` | `{"type":"string","pattern":"^call_[0-9A-HJKMNP-TV-Z]{26}$"}` | 01 §5.6（`call_` + ULID） |
| `jobId` | `{"type":"string","description":"job_ 前缀 + ULID"}` | 05 §2.7 |
| `eventId` | `{"type":"string","pattern":"^evt_[0-9A-HJKMNP-TV-Z]{26}$"}` | 01 §7.3 / 05 §2.12 |
| `termId` | `{"type":"string","pattern":"^term_[0-9A-HJKMNP-TV-Z]{26}$"}` | 05 §2.10（`term_...`） |
| CallStatus | `pending,dialing,connected,ended,no_answer,failed,canceled` | 01 §6.1 |
| PipelineStage | `audio,transcript,analysis` | 01 §6.1 |
| StageStatus | `pending,in_progress,ready,missing,failed,skipped` | 01 §6.1 |
| AccountState | `online,expired,logging_in,error,disabled,unknown` | 05 §2.2 |
| JobType | `login,sync,audio_fetch,asr,analysis,reprocess,backfill` | 01 §6.1（v1 删除旧的上游转写作业类型） |
| JobStatus | `queued,running,succeeded,failed,canceled` | 01 §6.1 |
| TranscriptSource | 固定 `asr`（本地自建 ASR，v1=MiniMax；不再有上游/混合来源） | 01 §6.1 / 05 §2.9 |
| TranscriptStage（`TRANSCRIPT_PENDING.details.stage`） | `asr_queued,asr_running,role_mapping,analysis` | 05 §6.5 |
| SpeakerMappingMethod | `channel,asr_diarization,llm_reconciled,heuristic` | 05 §2.9 / 13 §4.2 |
| SpeakerRole | `agent,customer,unknown` | 01 §6.1 |
| TermCategory | `company,product,person,custom` | 05 §2.10 |
| AnalysisPayload 关键字段 | `model,promptVersion,usage{promptTokens,completionTokens,totalTokens,latencyMs},speakerMapping{method,confidence,needsReview,evidence},termsApplied` | 05 §2.9 / 13 §6.4 |
| 时间 | ISO 8601 含时区（`+08:00`） | 01 §5.6 |
| 分页 | `page`（默认 1）、`size`（默认 20，最大 100；events 默认 50/最大 200；terms 默认 50/最大 500）；`meta.pagination{page,size,total,totalPages}` | 01 §5.5 / 05 各接口 |
| 写操作确认 | `confirm: {"const": true}`（所有写工具必填） | 本文 §6.1 |
| 幂等键 | `idempotencyKey: {"type":"string","maxLength":128}`（可选） | 01 §5.6 |

### 3.4 输出结构（统一）

**成功**（工具结果）：

```jsonc
{
  "content": [ { "type": "text", "text": "<结构化 JSON 字符串，内容同 structuredContent>" } ],
  "structuredContent": {
    "ok": true,
    "data": { /* 与 REST 响应 data 完全同构（数组或对象），字段见 docs/05 */ },
    "meta": { "requestId": "req_01J8Z3K5T9QW2M4R7X1C6V0B8N", "ts": "2026-11-14T10:05:00+08:00",
              "pagination": { "page": 1, "size": 20, "total": 1073, "totalPages": 54 } }
  },
  "isError": false
}
```

**失败**：

```jsonc
{
  "content": [ { "type": "text", "text": "{\"ok\":false,\"error\":{\"code\":\"CALL_OUTSIDE_DIAL_WINDOW\",...},\"meta\":{...}}" } ],
  "structuredContent": {
    "ok": false,
    "error": {
      "code": "CALL_OUTSIDE_DIAL_WINDOW",
      "message": "当前不在可拨号时段（07:50–22:00，Asia/Shanghai）",
      "retryable": true,
      "retryAfter": "2026-11-15T07:50:00+08:00",
      "details": { "upstreamCode": 10056, "upstreamMessage": "拨打时间段在7:50-22:00之间" }
    },
    "meta": { "requestId": "req_...", "ts": "2026-11-14T22:42:19+08:00" }
  },
  "isError": true
}
```

- 兼容旧版 MCP 客户端（无 `structuredContent`）：只读取 `content[0].text`，其为同一封套的 JSON 字符串。
- 列表工具 `data` 为数组（`CallSummary[]` 等），`meta.pagination` 见 [01 §5.5](./01-决策与约定.md)。
- 写接口幂等重放时 `meta.idempotencyReplayed:true`（[05 §1.2](./05-对外API契约.md)）；异步受理 `data` 至少含 `jobId/status/pollUrl`。

### 3.5 结果规模限制

| 项 | 限制 | 超限行为 |
| --- | --- | --- |
| 列表 `size` | ≤ 100（events/call events ≤200，terms ≤500） | `-32602`（schema `maximum`）或 `VALIDATION_FAILED` |
| 转写分段 | `maxSegments` ≤ 2000（工具级截断，`truncated:true`） | `VALIDATION_FAILED` |
| 录音二进制 | 默认**不内联**；`inline:true` 时 ≤ 2 MB | 超限 → `VALIDATION_FAILED`（`details.reason="AUDIO_TOO_LARGE"`） |
| 文本归一化输入 | 1–20,000 字符 | `VALIDATION_FAILED` |
| 词表全量替换 | ≤ 5,000 条 | `VALIDATION_FAILED` |

---

## 4. 工具总览

> `W` = 写工具（需 `--allow-write` + `confirm:true`）；`D` = destructiveHint。

| # | tool | 类型 | 说明 | REST 映射（01 §4.1） |
| --- | --- | --- | --- | --- |
| 1 | `feige_health` | 读 | 存活探针（补充只读工具） | `GET /health` #1 |
| 2 | `feige_status` | 读 | 平台健康总览（getStatus） | `GET /status` #2 |
| 3 | `feige_config_get` | 读 | 读取生效配置（脱敏） | `GET /config` #3 |
| 4 | `feige_config_set` | W | 局部更新配置（Merge Patch） | `PATCH /config` #4 |
| 5 | `feige_account_list` | 读 | 账号列表+健康摘要 | `GET /accounts` #5 |
| 6 | `feige_account_add` | W | 注册账号（凭证经 env/secret 引用） | `POST /accounts` #6 |
| 7 | `feige_account_get` | 读 | 账号详情 | `GET /accounts/{accountId}` #7 |
| 8 | `feige_account_update` | W | 更新启用/展示名/密码/浏览器 | `PATCH /accounts/{accountId}` #8 |
| 9 | `feige_account_remove` | W D | 移除本地账号（默认保留历史数据） | `DELETE /accounts/{accountId}` #9 |
| 10 | `feige_account_login` | W | 触发登录（默认等待结果） | `POST /accounts/{accountId}/login` #10 |
| 11 | `feige_account_logout` | W | 退出本地会话（204） | `POST /accounts/{accountId}/logout` #11 |
| 12 | `feige_account_health` | 读 | 单账号健康（JWT/WS/线路/时段） | `GET /accounts/{accountId}/health` #12 |
| 13 | `feige_dial` | W D | 发起呼出（有副作用/计费） | `POST /calls` #13 |
| 14 | `feige_call_list` | 读 | 话单列表（getOutboundList） | `GET /calls` #14 |
| 15 | `feige_call_get` | 读 | 话单摘要（Dial Status） | `GET /calls/{callId}` #15 |
| 16 | `feige_call_detail` | 读 | 话单详情+流水线（getOutboundDetail） | `GET /calls/{callId}/detail` #16 |
| 17 | `feige_call_transcript` | 读 | 转写全文+分段 | `GET /calls/{callId}/transcript` #17 |
| 18 | `feige_call_audio` | 读 | 录音元数据/下载 URL | `GET /calls/{callId}/audio` #18 |
| 19 | `feige_call_reprocess` | W | 重跑流水线阶段（幂等） | `POST /calls/{callId}/reprocess` #19 |
| 20 | `feige_call_cancel` | W D | 取消 pending 呼出 | `POST /calls/{callId}/cancel` #20 |
| 21 | `feige_call_events` | 读 | 单通话单事件时间线 | `GET /calls/{callId}/events` #21 |
| 22 | `feige_sync_start` | W | 触发同步（异步作业） | `POST /sync` #22 |
| 23 | `feige_sync_status` | 读 | 最近同步作业 | `GET /sync` #23 |
| 24 | `feige_job_get` | 读 | 作业详情（含同步作业 #24/#26） | `GET /jobs/{jobId}` #26 |
| 25 | `feige_job_list` | 读 | 全部后台作业 | `GET /jobs` #25 |
| 26 | `feige_events_list` | 读 | 事件历史查询 | `GET /events` #27 |
| 27 | `feige_terms_list` | 读 | 词表规则列表 | `GET /terms` #30 |
| 28 | `feige_terms_replace` | W D | 全量替换词表 | `PUT /terms` #31 |
| 29 | `feige_term_add` | W | 新增单条规则 | `POST /terms` #32 |
| 30 | `feige_term_update` | W | 修改规则 | `PATCH /terms/{termId}` #33 |
| 31 | `feige_term_remove` | W D | 删除规则 | `DELETE /terms/{termId}` #34 |
| 32 | `feige_text_normalize` | 读 | 文本归一化（同步、无副作用） | `POST /text/normalize` #35 |

---

## 5. 工具详细契约

> 每个工具：description、inputSchema（完整 JSON Schema）、output 摘要、错误语义、注解、REST 映射。
> `data` 字段的权威定义见 [05 §2](./05-对外API契约.md)；§3.4 的公共输出行为对全部工具生效。

### 5.1 平台

#### `feige_health` — 存活探针

- **description**：返回本地平台进程存活、版本与 uptime；不检查账号/上游等业务状态，适合快速探活。
- **REST**：`GET /health`（#1；该行 MCP 列原为 `—`，此为补充只读工具）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{ "type": "object", "properties": {}, "additionalProperties": false }
```

- **output**：`data = { "ok": true, "uptimeSec": 3610, "version": "0.1.0", "startedAt": "2026-11-14T09:00:00+08:00" }`
- **errors**：`UNAUTHORIZED`、`INTERNAL_ERROR`；本地不可达 → `SERVICE_UNAVAILABLE` + `details.transport`。

#### `feige_status` — 平台健康总览

- **description**：返回平台整体健康（DB、账号池、上游可达、拨打时段、作业队列、流水线积压（`transcriptPending` = 本地 ASR 队列）、同步延迟、SSE 客户端数）。对应图中的 `getStatus → Status`。**单通话单状态用 `feige_call_get`/`feige_call_detail`；ASR/LLM 供应商健康由 CLI `feige doctor --probe-providers` 检查。**
- **REST**：`GET /status`（#2）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:true`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "detail": { "type": "boolean", "default": true,
      "description": "是否返回 accountsDetail 全量账号摘要（对应 REST query detail）" }
  },
  "additionalProperties": false
}
```

- **output**（`StatusPayload`，[05 §2.11](./05-对外API契约.md)）：

```jsonc
{
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
}
```

- **errors**：`UNAUTHORIZED`、`DB_UNAVAILABLE`、`INTERNAL_ERROR`。

#### `feige_config_get` — 读取生效配置

- **description**：读取生效配置（密钥/内部路径脱敏），可按点路径取子集；`pipeline` 为嵌套 `asr` / `analysis` / `roleMapping` 结构。
- **REST**：`GET /config`（#3）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "key": { "type": "string", "maxLength": 64,
      "description": "点路径，如 dial / limits.dialCooldownMs / pipeline.asr / pipeline.analysis；缺省返回全部（工具层过滤，不改变 REST）" }
  },
  "additionalProperties": false
}
```

- **output**：`data = Config`（结构见 [05 §2.13](./05-对外API契约.md)：`server/storage/browser/dial/limits/sync/pipeline/events`；`pipeline.asr={provider:"minimax",baseUrl,model:"asr-1.0",language,chunkSeconds,concurrency}`、`pipeline.analysis={provider:"deepseek",baseUrl,model:"deepseek-chat",escalateModel:"deepseek-v4-pro",promptVersion:"analysis-v1",temperature,maxTokens,concurrency}`、`pipeline.roleMapping={method,llmVerify}`），密钥字段（`minimaxApiKey`/`deepseekApiKey`）不返回。
- **errors**：`VALIDATION_FAILED`（非法路径）、`UNAUTHORIZED`。

#### `feige_config_set` — 局部更新配置（W）

- **description**：按 JSON Merge Patch 语义局部更新配置；影响调度（`dial.*`）、限流（`limits.*`）与后处理（`pipeline.*`）时需谨慎。密钥字段只读（secrets/环境变量）。
- **REST**：`PATCH /config`（#4）
- **annotations**：`readOnlyHint:false`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "patch": { "type": "object",
      "description": "JSON Merge Patch，直接作为 PATCH /config 请求体，如 {\"pipeline\":{\"analysis\":{\"model\":\"deepseek-v4-pro\"}}}" },
    "dryRun": { "type": "boolean", "default": false,
      "description": "工具层预检：读取 GET /config 并返回 diff，不发 PATCH" },
    "confirm": { "const": true, "description": "写操作确认；必须显式传 true" }
  },
  "required": ["patch", "confirm"],
  "additionalProperties": false
}
```

- **output**：`data = { ...Config, "restartRequired": false }`（与 REST 200 一致）；`dryRun:true` 时 `data = { "applied": false, "diff": [{"path":"pipeline.analysis.model","from":"deepseek-chat","to":"deepseek-v4-pro"}] }`
- **errors**：`INVALID_REQUEST`（非对象/未知字段）、`VALIDATION_FAILED`（取值范围）、`CONFIG_INVALID`（只读字段/依赖缺失）、`UNAUTHORIZED`。
- **校验**（05 §4.4 / 01 §9）：`windowStart < windowEnd`；`pageSize ∈ [10,100]`；`intervalMs ≥ 10000`；`perAccountConcurrency=1`（v1 固定）；`pipeline.asr.provider=minimax`、`pipeline.analysis.provider=deepseek`（v1 固定，改动 → `VALIDATION_FAILED`/`CONFIG_INVALID`）；`pipeline.*` 变更对新入队作业生效，进行中作业沿用原参数（可用 `feige_call_reprocess` 显式重跑）。

### 5.2 账号

#### `feige_account_list` — 账号列表

- **description**：分页列出账号并附健康摘要（`AccountSummary`：状态、JWT、线路、统计）。
- **REST**：`GET /accounts`（#5）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "enabled": { "type": "boolean", "description": "过滤启用状态" },
    "state": { "oneOf": [
      { "type": "string", "enum": ["online","expired","logging_in","error","disabled","unknown"] },
      { "type": "array", "items": { "type": "string", "enum": ["online","expired","logging_in","error","disabled","unknown"] } }
    ] },
    "page": { "type": "integer", "minimum": 1, "default": 1 },
    "size": { "type": "integer", "minimum": 1, "maximum": 200, "default": 20 }
  },
  "additionalProperties": false
}
```

- **output**：`data = AccountSummary[]`（字段见 [05 §2.2](./05-对外API契约.md)：`accountId/displayName/upstreamUsernameMasked/upstreamUserId/tenantCode/enterpriseName/realName/dialMode/line/enabled/state/jwtExpiresAt/lastLoginAt/lastCheckedAt/lastError/stats{totalCalls,calls24h,lastCallAt}/createdAt/updatedAt`）+ `meta.pagination`
- **errors**：`UNAUTHORIZED`、`INTERNAL_ERROR`。

#### `feige_account_add` — 注册账号（W）

- **description**：注册一个上游坐席账号。**安全约束：不接受明文密码字段**；凭证通过 `passwordEnv`（服务进程可见的环境变量名）或 `secretRef`（已存在的 secrets 条目）引用，服务端解析后等价于 REST 请求体的 write-only `password`。推荐由人工用 CLI `feige account add --password-stdin` 完成首次注册。
- **REST**：`POST /accounts`（#6，201）
- **annotations**：`readOnlyHint:false`、`destructiveHint:false`、`idempotentHint:false`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "accountId": { "type": "string", "pattern": "^[a-z0-9][a-z0-9_-]{1,31}$" },
    "displayName": { "type": "string", "minLength": 1, "maxLength": 64, "description": "展示名（REST 必填）" },
    "username": { "type": "string", "pattern": "^1[3-9]\\d{9}$", "description": "上游登录手机号" },
    "concurrency": { "type": "integer", "minimum": 1, "maximum": 1, "default": 1, "description": "v1 回拨模式固定为 1" },
    "passwordEnv": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]{2,63}$",
      "description": "持有密码的环境变量名；与 secretRef 二选一。禁止传明文密码" },
    "secretRef": { "type": "string", "description": "secrets 文件中的账号条目引用；与 passwordEnv 二选一" },
    "browser": { "type": "object", "properties": {
      "headless": { "type": "boolean" },
      "profileDirName": { "type": "string", "maxLength": 64 }
    }, "additionalProperties": false },
    "metadata": { "type": "object", "maxProperties": 10,
      "additionalProperties": { "type": "string", "maxLength": 256 } },
    "confirm": { "const": true }
  },
  "required": ["accountId", "displayName", "username", "confirm"],
  "anyOf": [ { "required": ["passwordEnv"] }, { "required": ["secretRef"] } ],
  "additionalProperties": false
}
```

- **output**：`data = { accountId, displayName, upstreamUsernameMasked, enabled, state, dialMode, createdAt }`（与 REST 201 一致）
- **errors**：`VALIDATION_FAILED`（slug/手机号/密码规则/重复 accountId）、`CONFIG_INVALID`、`UNAUTHORIZED`、`INTERNAL_ERROR`。
- **约束**：明文密码、JWT 不得出现在任何工具参数或对话上下文中；注册后不自动登录。

#### `feige_account_get` — 账号详情

- **description**：返回单个账号配置、会话、同步状态与最近作业（`AccountDetail`）。
- **REST**：`GET /accounts/{accountId}`（#7）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": { "accountId": { "type": "string", "pattern": "^[a-z0-9][a-z0-9_-]{1,31}$" } },
  "required": ["accountId"],
  "additionalProperties": false
}
```

- **output**：`data = AccountDetail`（[05 §2.3](./05-对外API契约.md)）：AccountSummary + `config{concurrency,browser{headless,profileDirMasked}}`、`session{state,jwtExpiresAt,wsConnected,cookieState,lastPongAt}`、`sync{lastSyncAt,cursorStartTime,lagSeconds,lastError}`、`recentJobs[]`。
- **errors**：`ACCOUNT_NOT_FOUND`、`UNAUTHORIZED`。

#### `feige_account_update` — 更新账号（W）

- **description**：更新展示名、启用状态、上游密码（轮换）、浏览器设置或 metadata（不改变 accountId）。
- **REST**：`PATCH /accounts/{accountId}`（#8）
- **annotations**：`readOnlyHint:false`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "accountId": { "type": "string", "pattern": "^[a-z0-9][a-z0-9_-]{1,31}$" },
    "displayName": { "type": "string", "minLength": 1, "maxLength": 64 },
    "enabled": { "type": "boolean", "description": "false=停用（停止调度与同步，保留数据）" },
    "passwordEnv": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]{2,63}$",
      "description": "密码轮换：持有新密码的环境变量名（不接受明文密码）" },
    "secretRef": { "type": "string", "description": "密码轮换：secrets 条目引用" },
    "browser": { "type": "object", "properties": { "headless": { "type": "boolean" } }, "additionalProperties": false },
    "metadata": { "type": "object", "maxProperties": 10, "additionalProperties": { "type": "string", "maxLength": 256 } },
    "relogin": { "type": "boolean", "default": false, "description": "密码变更后立即触发重登（query relogin=true）" },
    "confirm": { "const": true }
  },
  "required": ["accountId", "confirm"],
  "additionalProperties": false
}
```

- **output**：`data = AccountDetail`（更新后）
- **errors**：`ACCOUNT_NOT_FOUND`、`VALIDATION_FAILED`、`UNAUTHORIZED`。

#### `feige_account_remove` — 移除账号（W，destructive）

- **description**：移除**本地**账号（默认保留历史话单/录音/转写，仅标记 `deletedAt`）。`purgeData:true` 级联删除关联数据且不可恢复，需按 REST 要求以 `purgeConfirm` 传 `PURGE:<accountId>`。
- **REST**：`DELETE /accounts/{accountId}`（#9，204；`purgeData=true` 时 `confirm=PURGE:<accountId>`）
- **annotations**：`readOnlyHint:false`、`destructiveHint:true`、`idempotentHint:true`（重复调用返回 `ACCOUNT_NOT_FOUND`，视为已达成）、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "accountId": { "type": "string", "pattern": "^[a-z0-9][a-z0-9_-]{1,31}$" },
    "purgeData": { "type": "boolean", "default": false,
      "description": "同时删除本地历史数据（不可恢复）；需用户明确授权" },
    "purgeConfirm": { "type": "string",
      "description": "purgeData=true 时必填，值必须为 PURGE:<accountId>" },
    "confirm": { "const": true }
  },
  "required": ["accountId", "confirm"],
  "additionalProperties": false
}
```

- **output**：`data = { "accountId": "main", "removed": true, "purged": false }`（204 无响应体，由 server 归一）
- **errors**：`ACCOUNT_NOT_FOUND`、`VALIDATION_FAILED`（`purgeConfirm` 不匹配）、`UNAUTHORIZED`。

#### `feige_account_login` — 触发登录（W）

- **description**：触发该账号上游登录（浏览器自动化 + 阿里云滑块，JWT 7 天）。REST 默认 **wait=true 同步等待**；`wait:false` 返回 202 作业。登录中重复提交返回 `ACCOUNT_LOGIN_IN_PROGRESS`（409）；滑块可能需人工介入。
- **REST**：`POST /accounts/{accountId}/login`（#10；200 或 202）
- **annotations**：`readOnlyHint:false`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:true`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "accountId": { "type": "string", "pattern": "^[a-z0-9][a-z0-9_-]{1,31}$" },
    "wait": { "type": "boolean", "default": true, "description": "是否等待登录结果（REST 默认 true）" },
    "timeoutMs": { "type": "integer", "minimum": 10000, "maximum": 300000, "default": 120000 },
    "force": { "type": "boolean", "default": false, "description": "已有有效会话时是否强制重新登录" },
    "idempotencyKey": { "type": "string", "maxLength": 128 },
    "confirm": { "const": true }
  },
  "required": ["accountId", "confirm"],
  "additionalProperties": false
}
```

- **output**：`wait:true`（200）`data = { accountId, state:"online", loggedIn:true, jwtExpiresAt, loginJobId }`；`wait:false`（202）`data = { loginJobId, status:"queued", pollUrl }`
- **errors**：`ACCOUNT_NOT_FOUND`(404)、`ACCOUNT_LOGIN_IN_PROGRESS`(409，`details.loginJobId`)、`ACCOUNT_LOGIN_FAILED`(422，`details.reason=captcha_failed|bad_credentials|need_human`)、`UPSTREAM_UNREACHABLE`(502)、`INTERNAL_ERROR`(500，`details.needDisplay=true` 需显示环境)、`UNAUTHORIZED`。

#### `feige_account_logout` — 退出登录（W）

- **description**：清除该账号的本地会话（JWT/cookie/WS），不注销上游账号；幂等，REST 返回 204。
- **REST**：`POST /accounts/{accountId}/logout`（#11，204）
- **annotations**：`readOnlyHint:false`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:true`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "accountId": { "type": "string", "pattern": "^[a-z0-9][a-z0-9_-]{1,31}$" },
    "confirm": { "const": true }
  },
  "required": ["accountId", "confirm"],
  "additionalProperties": false
}
```

- **output**：`data = null`（204）
- **errors**：`ACCOUNT_NOT_FOUND`、`INTERNAL_ERROR`、`UNAUTHORIZED`。

#### `feige_account_health` — 单账号健康（读）

- **description**：返回单账号健康（JWT/WS/上游/线路/时段/当前通话）。会触发上游探测（缓存 30s）；**探测失败不报错**，返回 `data.upstream.reachable=false`。
- **REST**：`GET /accounts/{accountId}/health`（#12）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:true`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": { "accountId": { "type": "string", "pattern": "^[a-z0-9][a-z0-9_-]{1,31}$" } },
  "required": ["accountId"],
  "additionalProperties": false
}
```

- **output**（`AccountHealth`，[05 §2.4](./05-对外API契约.md)）：

```jsonc
{
  "accountId": "main",
  "state": "online",
  "jwt": { "valid": true, "expiresAt": "2026-11-21T10:00:00+08:00", "expiresInSec": 583200 },
  "ws": { "connected": true, "lastPongAt": "2026-11-14T10:00:00+08:00", "latencyMs": 47 },
  "upstream": { "reachable": true, "latencyMs": 180, "checkedAt": "2026-11-14T10:00:00+08:00" },
  "line": { "lineId": "9", "lineName": "电信回拨", "mode": 1 },
  "dialWindow": { "open": true, "windowStart": "07:50", "windowEnd": "22:00", "timezone": "Asia/Shanghai", "nextOpenAt": null },
  "busy": { "inCall": false },
  "lastError": null
}
```

- **errors**：`ACCOUNT_NOT_FOUND`、`UNAUTHORIZED`。

### 5.3 呼出与话单

#### `feige_dial` — 发起呼出（W，destructive，有计费）

- **description**：发起一通真实外呼（异步受理）。上游为**回拨模式**：先振铃坐席绑定手机，坐席接听后桥接客户——需要有人接听，**不是 AI 语音直呼**。受拨打时段（07:50–22:00 Asia/Shanghai）、账号串行、同号冷却、防重约束。呼出有真实副作用与计费，禁止批量/循环调用。
- **REST**：`POST /calls`（#13，201；`dryRun:true` 返回 200 计划）
- **annotations**：`readOnlyHint:false`、`destructiveHint:true`、`idempotentHint:false`（上游无幂等键；传入相同 `idempotencyKey` 时平台 24h 内重放首次结果）、`openWorldHint:true`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "to": { "type": "string",
      "pattern": "^(1[3-9]\\d{9}|0\\d{2,3}-?\\d{7,8})$",
      "description": "被叫号码（手机或固话；单个号码，禁止数组/批量）" },
    "accountId": { "type": "string", "pattern": "^[a-z0-9][a-z0-9_-]{1,31}$",
      "description": "指定账号；仅 1 个启用账号时可省略，多账号省略会 VALIDATION_FAILED" },
    "customerName": { "type": "string", "maxLength": 64, "description": "客户名（落库）" },
    "metadata": { "type": "object", "maxProperties": 10,
      "additionalProperties": { "type": "string", "maxLength": 256 } },
    "scheduledAt": { "type": "string", "format": "date-time",
      "description": "期望呼出时间（未来且在窗口内）；省略=立即" },
    "idempotencyKey": { "type": "string", "maxLength": 128,
      "description": "强烈建议生成并复用；重试/重放必须使用同一键" },
    "dryRun": { "type": "boolean", "default": false,
      "description": "只做校验并返回将执行的计划，不产生 Call" },
    "confirm": { "const": true }
  },
  "required": ["to", "confirm"],
  "additionalProperties": false
}
```

- **output**：201 `data = CallSummary`（[05 §2.5](./05-对外API契约.md)）：

```jsonc
{
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
}
```

`dryRun:true`（200）`data = { dryRun:true, willDial:true, accountId, to, dialWindow, warnings, estimatedCost }`。

- **errors**：`INVALID_REQUEST`、`VALIDATION_FAILED`、`ACCOUNT_NOT_FOUND`、`ACCOUNT_DISABLED`、`ACCOUNT_BUSY`、`ACCOUNT_LOGIN_REQUIRED`、`IDEMPOTENCY_CONFLICT`、`CALL_OUTSIDE_DIAL_WINDOW`、`CALL_NOT_DIALABLE`、`UPSTREAM_BUSINESS_ERROR`、`UPSTREAM_AUTH_EXPIRED`、`UPSTREAM_UNREACHABLE`。
- **安全**：单次调用仅一个号码；**不存在批量呼出工具**；不得对号码列表循环调用；重复调用必须复用 `idempotencyKey`；`CALL_TRACKING_TIMEOUT` 时禁止直接重拨（需人工核对）。

#### `feige_call_list` — 话单列表

- **description**：分页查询话单（默认 `sort=-createdAt`），支持账号/状态/时间/号码/文本/流水线状态过滤。
- **REST**：`GET /calls`（#14）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "accountId": { "type": "string", "description": "账号过滤（可逗号分隔）" },
    "status": { "oneOf": [
      { "type": "string", "enum": ["pending","dialing","connected","ended","no_answer","failed","canceled"] },
      { "type": "array", "maxItems": 7, "items": { "type": "string", "enum": ["pending","dialing","connected","ended","no_answer","failed","canceled"] } }
    ] },
    "pipeline": { "type": "object",
      "description": "按流水线阶段过滤，映射 REST query pipeline.<stage>",
      "properties": {
        "audio": { "type": "string", "enum": ["pending","in_progress","ready","missing","failed","skipped"] },
        "transcript": { "type": "string", "enum": ["pending","in_progress","ready","missing","failed","skipped"] },
        "analysis": { "type": "string", "enum": ["pending","in_progress","ready","missing","failed","skipped"] }
      }, "additionalProperties": false },
    "hasAudio": { "type": "boolean", "description": "是否有归档录音" },
    "hasTranscript": { "type": "boolean", "description": "是否有转写" },
    "to": { "type": "string", "maxLength": 20,
      "description": "被叫号码（支持后 4 位模糊，如 *1234）" },
    "q": { "type": "string", "maxLength": 64, "description": "客户名/号码/转写全文搜索" },
    "dateFrom": { "type": "string", "format": "date", "description": "startedAt 起始日期（含）" },
    "dateTo": { "type": "string", "format": "date", "description": "startedAt 结束日期（含）" },
    "sort": { "type": "string", "default": "-createdAt",
      "description": "createdAt/dialedAt/endedAt/durationSec，前缀 - 降序" },
    "page": { "type": "integer", "minimum": 1, "default": 1 },
    "size": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 },
    "includePipeline": { "type": "boolean", "default": true }
  },
  "additionalProperties": false
}
```

- **output**：`data = CallSummary[]` + `meta.pagination`；关键字段：`callId/accountId/upstreamCallId/direction/to{phone,location?}/from{phone,location?}/status/statusReason/dialedAt/answeredAt/endedAt/durationSec/cost/upstreamStatus/pipeline{audio,transcript,analysis,lastError}/transcriptPreview/audioAvailable/createdAt/updatedAt`。
- **errors**：`VALIDATION_FAILED`、`UNAUTHORIZED`、`DB_UNAVAILABLE`。

#### `feige_call_get` — 话单摘要

- **description**：返回单通话单摘要（状态、号码、时长、话费、流水线状态）。对应 `Dial Status`。
- **REST**：`GET /calls/{callId}`（#15）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": { "callId": { "type": "string", "pattern": "^call_[0-9A-HJKMNP-TV-Z]{26}$" } },
  "required": ["callId"],
  "additionalProperties": false
}
```

- **output**：`data = CallSummary`（[05 §2.5](./05-对外API契约.md)）
- **errors**：`CALL_NOT_FOUND`、`UNAUTHORIZED`。

#### `feige_call_detail` — 话单详情+流水线

- **description**：返回话单详情（上游字段、时间线、录音/本地 ASR 转写/DeepSeek 分析三阶段明细、分析摘要与低置信标记）；可选内联上游原始对象与最近事件。对应 `getOutboundDetail`。
- **REST**：`GET /calls/{callId}/detail`（#16）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "callId": { "type": "string", "pattern": "^call_[0-9A-HJKMNP-TV-Z]{26}$" },
    "includeRaw": { "type": "boolean", "default": false, "description": "返回上游原始对象（体积大）" },
    "includeEvents": { "type": "boolean", "default": false, "description": "内联最近 50 条事件" }
  },
  "required": ["callId"],
  "additionalProperties": false
}
```

- **output**：`data = CallDetail`（[05 §2.9/§6.4](./05-对外API契约.md)）：CallSummary + `upstream{}`、`timeline{createdAt,submittedAt?,dialingAt,connectedAt,endedAt}`、`pipelineDetail{audio{status,audioId,downloadedAt,lastError},transcript{status,transcriptId,source:"asr",provider,chunkCount,needsReview,generatedAt,lastError},analysis{status,analysisId,generatedAt,lastError}}`、`recording{available,downloadUrl,format,durationMs,sizeBytes,sha256,sampleRate,channels}`、`transcript{available,source:"asr",segmentCount,needsReview,url}`、`analysis{available,analysisId,summary,intent,url}`、`eventsCount`、`metadata`（`includeEvents=true` 时另有 `events[]`）。
- 完整 `AnalysisPayload`（含 `promptVersion`/`usage`/`speakerMapping{method,confidence,needsReview,evidence}`）字段定义见 [05 §2.9](./05-对外API契约.md)，工具 `--json` 语义下原样透传（字段承载位置以 05 为准）。
- **errors**：`CALL_NOT_FOUND`、`UNAUTHORIZED`、`DB_UNAVAILABLE`。

#### `feige_call_transcript` — 转写全文+分段

- **description**：返回**本地 ASR（MiniMax `asr-1.0`）**生成的转写全文与句级分段（起止时间、声道、说话人角色、ASR 说话人标签、分块序号、原始/归一化文本）。`source` 固定 `asr`；短通话/无有效语音可能无转写。
- **REST**：`GET /calls/{callId}/transcript`（#17；`includeAnalysis` query）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "callId": { "type": "string", "pattern": "^call_[0-9A-HJKMNP-TV-Z]{26}$" },
    "includeAnalysis": { "type": "boolean", "default": false, "description": "附带 AI 后处理结果（AnalysisBrief）" },
    "format": { "type": "string", "enum": ["json","text","markdown"], "default": "json",
      "description": "json=原始 TranscriptPayload；text/markdown 由 server 渲染（tool 层）" },
    "role": { "type": "string", "enum": ["agent","customer","unknown"],
      "description": "仅返回某说话人（tool 层过滤）" },
    "maxSegments": { "type": "integer", "minimum": 1, "maximum": 2000, "default": 2000 }
  },
  "required": ["callId"],
  "additionalProperties": false
}
```

- **output**（`TranscriptPayload`，[05 §2.9](./05-对外API契约.md)）：

```jsonc
{
  "callId": "call_01J8Z3K5T9QW2M4R7X1C6V0B8N",
  "transcriptId": "tr_01J8Z3K5T9QW2M4R7X1C6V0B8S",
  "source": "asr",
  "provider": "minimax:asr-1.0",
  "language": "zh-CN",
  "status": "ready",
  "isCurrent": true,
  "durationMs": 15060,
  "fullText": "喂。喂，李总，你好。嗯。我是看你们阿里做了很多年了…",
  "segments": [
    { "segmentId": "seg_01J8Z3K5T9QW2M4R7X1C6V0B8V", "index": 0,
      "beginMs": 830, "endMs": 2230, "channel": 1, "speakerLabel": "S2", "chunkIndex": 0,
      "role": "customer", "rawText": "喂。", "normalizedText": "喂。", "confidence": 0.93 }
  ],
  "createdAt": "2026-11-13T16:28:40+08:00",
  "updatedAt": "2026-11-13T16:28:40+08:00"
}
```

`format=text|markdown` 时 `data = { callId, format, text, segmentCount }`（渲染结果）；`maxSegments` 截断时附 `truncated:true`。`includeAnalysis=true` 时附 `analysis={analysisId,summary,intent?}`（05 §2.9 AnalysisBrief）。

- **errors**：`CALL_NOT_FOUND`、`TRANSCRIPT_NOT_AVAILABLE`（未接通/无有效语音或本地 ASR 无法产出）、`TRANSCRIPT_PENDING`（`details.stage=asr_queued|asr_running|role_mapping|analysis`）、`NOT_FOUND`（version 不存在）、`DB_UNAVAILABLE`。
- **说明**：ASR 作业失败记录在同话单 `feige_job_list{callId}` 的 `lastError.code=ASR_FAILED`（可 `feige_call_reprocess` 重跑）。

#### `feige_call_audio` — 录音元数据/下载

- **description**：返回原始录音元数据与本地下载 URL（`CallDetail.recording`）；可选触发下载归档、可选内联音频（≤2MB）。**默认不内联二进制**。
- **REST**：`GET /calls/{callId}/audio`（#18，二进制，支持 Range）+ `GET /calls/{callId}/detail`（取 `recording` 元数据）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:true`（首次归档可能访问上游）
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "callId": { "type": "string", "pattern": "^call_[0-9A-HJKMNP-TV-Z]{26}$" },
    "download": { "type": "boolean", "default": true,
      "description": "确保录音已归档（未归档时触发下载；对应 REST query download=true）" },
    "inline": { "type": "boolean", "default": false,
      "description": "是否内联 base64 音频（仅 ≤2MB 且客户端明确需要）" }
  },
  "required": ["callId"],
  "additionalProperties": false
}
```

- **output**：

```jsonc
{
  "callId": "call_01J8Z3K5T9QW2M4R7X1C6V0B8N",
  "available": true,
  "downloadUrl": "/api/v1/calls/call_01J8Z3K5T9QW2M4R7X1C6V0B8N/audio",
  "format": "wav", "durationMs": 15060, "sizeBytes": 481964, "sha256": "ab12…",
  "sampleRate": 16000, "channels": 1
}
```

`inline:true` 时追加 `contentBase64` 与 `mimeType="audio/wav"`。

- **errors**：`CALL_NOT_FOUND`、`AUDIO_NOT_AVAILABLE`、`AUDIO_NOT_READY`（`details.retryAfterSec=10`）、`NOT_FOUND`（DB 有记录但文件丢失）、`VALIDATION_FAILED`（超内联上限）。
- **隐私**：录音含个人信息；`downloadUrl` 仅限本机使用，禁止外传（[11-安全与合规.md](./11-安全与合规.md)）。

#### `feige_call_reprocess` — 重跑流水线阶段（W）

- **description**：重跑 `audio`/`transcript`/`analysis` 阶段（幂等，不改变 `Call.status`；同一 call 同时只允许一个 reprocess 作业）。`transcript` = 重跑本地 ASR（MiniMax）→ 角色映射 → 词表归一；`analysis` = 重跑 DeepSeek 语义后处理（默认当前 `promptVersion`）。有成本（ASR 按音频时长、analysis 按 token，[13 §3.4/§6.4](./13-后处理规格（ASR与LLM）.md)）。常用来补 ASR 失败/低置信复核（`needsReview`）或升级分析模型。
- **REST**：`POST /calls/{callId}/reprocess`（#19，202）
- **annotations**：`readOnlyHint:false`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:true`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "callId": { "type": "string", "pattern": "^call_[0-9A-HJKMNP-TV-Z]{26}$" },
    "stages": {
      "type": "array", "minItems": 1, "maxItems": 3, "uniqueItems": true,
      "items": { "type": "string", "enum": ["audio","transcript","analysis"] },
      "description": "要重跑的阶段（REST 必填；analysis 隐含需要 transcript）"
    },
    "force": { "type": "boolean", "default": false, "description": "忽略已 ready 状态强制重跑" },
    "options": { "type": "object",
      "properties": {
        "asrModel": { "type": "string", "description": "ASR 模型（默认当前配置，如 asr-1.0）" },
        "analysisModel": { "type": "string", "description": "分析模型（默认当前配置，如 deepseek-chat / deepseek-v4-pro）" },
        "promptVersion": { "type": "string", "description": "分析 prompt 版本（如 analysis-v1；配合 analysis 重跑）" },
        "termRulesVersion": { "type": "string", "description": "词表版本/快照" }
      }, "additionalProperties": false },
    "wait": { "type": "boolean", "default": false, "description": "工具层轮询作业至结束（≤300s）" },
    "waitTimeoutSec": { "type": "integer", "minimum": 10, "maximum": 300, "default": 300 },
    "idempotencyKey": { "type": "string", "maxLength": 128 },
    "confirm": { "const": true }
  },
  "required": ["callId", "stages", "confirm"],
  "additionalProperties": false
}
```

- **output**：202 `data = { jobId, callId, stages, status:"queued", pollUrl }`；`wait:true` 完成后为 `JobDetail`（含 `lastError`；ASR/LLM 阶段失败分别归一为 `ASR_FAILED`/`ANALYSIS_FAILED`，retryable=true）。
- **errors**：`CALL_NOT_FOUND`、`VALIDATION_FAILED`（stages 为空/非法）、`CALL_ALREADY_TERMINAL`（取消态的 call 不允许）、`RATE_LIMITED`（`details.reason=reprocess_in_progress`）、`UNAUTHORIZED`；作业内阶段失败以 `job.lastError.code` 暴露（`ASR_FAILED`/`ANALYSIS_FAILED`），可再次重跑。

#### `feige_call_cancel` — 取消呼出（W，destructive）

- **description**：取消**尚未提交上游**的呼出（仅 `pending`）。已提交/已接通不可取消（上游无取消接口）。
- **REST**：`POST /calls/{callId}/cancel`（#20，200，返回 `CallSummary` status=canceled）
- **annotations**：`readOnlyHint:false`、`destructiveHint:true`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "callId": { "type": "string", "pattern": "^call_[0-9A-HJKMNP-TV-Z]{26}$" },
    "confirm": { "const": true }
  },
  "required": ["callId", "confirm"],
  "additionalProperties": false
}
```

- **output**：`data = CallSummary`（`status="canceled"`）
- **errors**：`CALL_NOT_FOUND`、`CALL_NOT_CANCELABLE`、`CALL_ALREADY_TERMINAL`、`UNAUTHORIZED`。

#### `feige_call_events` — 单通话单事件时间线

- **description**：返回单通话单的事件时间线（状态/流水线/错误事件），按 `occurredAt asc` 排序，支持类型过滤与分页。
- **REST**：`GET /calls/{callId}/events`（#21）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "callId": { "type": "string", "pattern": "^call_[0-9A-HJKMNP-TV-Z]{26}$" },
    "types": { "type": "array", "maxItems": 30, "items": { "type": "string" },
      "description": "事件类型过滤（逗号序列化后作为 REST query types）" },
    "page": { "type": "integer", "minimum": 1, "default": 1 },
    "size": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
  },
  "required": ["callId"],
  "additionalProperties": false
}
```

- **output**：`data = EventRecord[]`（[05 §2.12](./05-对外API契约.md)）+ `meta.pagination`
- **errors**：`CALL_NOT_FOUND`、`UNAUTHORIZED`。

### 5.4 同步 / 作业 / 事件

#### `feige_sync_start` — 触发同步（W）

- **description**：触发话单同步（异步作业）。`incremental` 按游标增量；`full` 全量（完成后平台对历史话单排队执行 ASR→DeepSeek 后处理，**不设预算上限**但记录 token/耗时，[13 §3.4/§7](./13-后处理规格（ASR与LLM）.md)）；`backfill` 按日期区间回补。同步对上游为只读操作。
- **REST**：`POST /sync`（#22，202）
- **annotations**：`readOnlyHint:false`（产生本地写入与作业）、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:true`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "mode": { "type": "string", "enum": ["incremental","full","backfill"] },
    "accountId": { "type": "string", "pattern": "^[a-z0-9][a-z0-9_-]{1,31}$",
      "description": "缺省同步全部启用账号" },
    "from": { "type": "string", "format": "date", "description": "backfill 专用起始日期" },
    "to": { "type": "string", "format": "date", "description": "backfill 专用结束日期" },
    "wait": { "type": "boolean", "default": false, "description": "是否等待作业结束（≤600s）" },
    "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 600000, "default": 30000 },
    "idempotencyKey": { "type": "string", "maxLength": 128 },
    "confirm": { "const": true }
  },
  "required": ["mode", "confirm"],
  "additionalProperties": false
}
```

- **output**：202 `data = { jobId, type:"sync", mode, accountId, status:"queued", pollUrl }`；`wait:true` 完成 → `JobDetail`（含 `result{fetched,upserted,skipped,failed}`）。`full` 后的回补进度用 `feige_job_list {type:["asr","analysis"]}` 观测。
- **errors**：`VALIDATION_FAILED`（mode/日期区间）、`ACCOUNT_NOT_FOUND`、`ACCOUNT_LOGIN_REQUIRED`（`details.accounts[]`）、`UPSTREAM_UNREACHABLE`、`UNAUTHORIZED`。

#### `feige_sync_status` — 最近同步作业

- **description**：分页返回最近同步作业（`type=sync`）。
- **REST**：`GET /sync`（#23）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "accountId": { "type": "string", "description": "账号过滤" },
    "status": { "type": "string", "enum": ["queued","running","succeeded","failed","canceled"] },
    "page": { "type": "integer", "minimum": 1, "default": 1 },
    "size": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 }
  },
  "additionalProperties": false
}
```

- **output**：`data = JobSummary[]`（[05 §2.7](./05-对外API契约.md)）+ `meta.pagination`
- **errors**：`UNAUTHORIZED`。

#### `feige_job_get` — 作业详情

- **description**：按 jobId 返回作业详情（含同步作业；对应 REST #24/#26）。
- **REST**：`GET /jobs/{jobId}`（#26；同步作业等价 `GET /sync/{jobId}` #24）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "jobId": { "type": "string", "description": "job_ 前缀 + ULID" }
  },
  "required": ["jobId"],
  "additionalProperties": false
}
```

- **output**：`data = JobDetail`（[05 §2.7](./05-对外API契约.md)）：

```jsonc
{
  "jobId": "job_01J8Z3K5T9QW2M4R7X1C6V0B8N",
  "type": "asr",
  "status": "running",
  "accountId": "main",
  "callId": "call_01J8Z3K5T9QW2M4R7X1C6V0B8N",
  "attempts": 1, "maxAttempts": 5,
  "progress": { "current": 42, "total": 600, "unit": "s", "message": "ASR 分块处理中" },
  "scheduledAt": "2026-11-14T10:04:00+08:00",
  "startedAt": "2026-11-14T10:04:01+08:00",
  "finishedAt": null,
  "lastError": null,
  "createdAt": "2026-11-14T10:04:00+08:00",
  "updatedAt": "2026-11-14T10:04:43+08:00",
  "payload": {}, "result": null, "logs": []
}
```

- **errors**：`JOB_NOT_FOUND`、`UNAUTHORIZED`。

#### `feige_job_list` — 作业列表

- **description**：分页列出后台作业，可按类型/状态/账号/话单过滤（默认 `sort=-createdAt`）。
- **REST**：`GET /jobs`（#25）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "type": { "oneOf": [
      { "type": "string", "enum": ["login","sync","audio_fetch","asr","analysis","reprocess","backfill"] },
      { "type": "array", "maxItems": 7, "items": { "type": "string", "enum": ["login","sync","audio_fetch","asr","analysis","reprocess","backfill"] } }
    ] },
    "status": { "type": "string", "enum": ["queued","running","succeeded","failed","canceled"] },
    "accountId": { "type": "string" },
    "callId": { "type": "string", "pattern": "^call_[0-9A-HJKMNP-TV-Z]{26}$" },
    "page": { "type": "integer", "minimum": 1, "default": 1 },
    "size": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 },
    "sort": { "type": "string", "default": "-createdAt" }
  },
  "additionalProperties": false
}
```

- **output**：`data = JobSummary[]` + `meta.pagination`
- **errors**：`VALIDATION_FAILED`、`UNAUTHORIZED`。

#### `feige_events_list` — 事件历史

- **description**：按时间/类型/关联对象查询事件历史（只读；实时流请用资源订阅，见 §7.2）。
- **REST**：`GET /events`（#27）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "types": { "type": "array", "maxItems": 30, "items": { "type": "string" },
      "description": "事件类型过滤，支持通配，如 call.* / account.*" },
    "callId": { "type": "string", "pattern": "^call_[0-9A-HJKMNP-TV-Z]{26}$" },
    "accountId": { "type": "string" },
    "since": { "type": "string", "format": "date-time", "description": "occurredAt 起始（含）" },
    "until": { "type": "string", "format": "date-time", "description": "occurredAt 结束（含）" },
    "page": { "type": "integer", "minimum": 1, "default": 1 },
    "size": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 },
    "sort": { "type": "string", "default": "-occurredAt", "description": "仅时间排序" }
  },
  "additionalProperties": false
}
```

- **output**：`data = EventRecord[]` + `meta.pagination`
- **errors**：`VALIDATION_FAILED`、`UNAUTHORIZED`。

### 5.5 词表与文本

#### `feige_terms_list` — 词表列表

- **description**：分页查询词表归一规则（`TermRule`，`from` 为变体数组）。
- **REST**：`GET /terms`（#30）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "q": { "type": "string", "maxLength": 100, "description": "按 from/to 搜索" },
    "category": { "type": "string", "enum": ["company","product","person","custom"] },
    "enabled": { "type": "boolean" },
    "page": { "type": "integer", "minimum": 1, "default": 1 },
    "size": { "type": "integer", "minimum": 1, "maximum": 500, "default": 50 }
  },
  "additionalProperties": false
}
```

- **output**：`data = TermRule[]` + `meta.pagination`（[05 §2.10](./05-对外API契约.md)：`termId/from[]/to/category/priority/enabled/caseSensitive/note/createdAt/updatedAt`）
- **errors**：`VALIDATION_FAILED`、`UNAUTHORIZED`。

#### `feige_terms_replace` — 全量替换词表（W，destructive）

- **description**：以给定规则集**全量替换**词表（原子事务；未出现的旧规则被删除）。建议先 `dryRun:true` 查看 diff。
- **REST**：`PUT /terms`（#31；请求体 `{ "rules": TermRuleInput[], "mode": "replace" }`）
- **annotations**：`readOnlyHint:false`、`destructiveHint:true`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "rules": {
      "type": "array", "minItems": 0, "maxItems": 5000,
      "items": {
        "type": "object",
        "properties": {
          "from": { "type": "array", "minItems": 1, "maxItems": 32, "uniqueItems": true,
            "items": { "type": "string", "minLength": 1, "maxLength": 32 },
            "description": "变体列表，如 [\"复萌\",\"福梦\",\"复盟\"]" },
          "to": { "type": "string", "minLength": 1, "maxLength": 32 },
          "category": { "type": "string", "enum": ["company","product","person","custom"] },
          "priority": { "type": "integer", "minimum": 0, "maximum": 1000, "default": 100 },
          "enabled": { "type": "boolean", "default": true },
          "caseSensitive": { "type": "boolean", "default": false },
          "note": { "type": "string", "maxLength": 256 }
        },
        "required": ["from", "to"],
        "additionalProperties": false
      }
    },
    "dryRun": { "type": "boolean", "default": false,
      "description": "工具层预检：读取 GET /terms 并返回 diff，不发 PUT" },
    "confirm": { "const": true }
  },
  "required": ["rules", "confirm"],
  "additionalProperties": false
}
```

- **output**：`data = { "count": 42, "version": "2026-11-14T10:00:00+08:00" }`；`dryRun:true` 时 `data = { applied:false, diff:{added,updated,removed} }`
- **errors**：`VALIDATION_FAILED`（`details.fields[]` 指向第几条规则哪项非法）、`UNAUTHORIZED`。

#### `feige_term_add` — 新增规则（W）

- **description**：新增单条词表归一规则（如 `["复萌","福梦","复盟"] → 孚盟`）。
- **REST**：`POST /terms`（#32，201）
- **annotations**：`readOnlyHint:false`、`destructiveHint:false`、`idempotentHint:false`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "from": { "type": "array", "minItems": 1, "maxItems": 32, "uniqueItems": true,
      "items": { "type": "string", "minLength": 1, "maxLength": 32 } },
    "to": { "type": "string", "minLength": 1, "maxLength": 32 },
    "category": { "type": "string", "enum": ["company","product","person","custom"] },
    "priority": { "type": "integer", "minimum": 0, "maximum": 1000, "default": 100 },
    "enabled": { "type": "boolean", "default": true },
    "caseSensitive": { "type": "boolean", "default": false },
    "note": { "type": "string", "maxLength": 256 },
    "confirm": { "const": true }
  },
  "required": ["from", "to", "confirm"],
  "additionalProperties": false
}
```

- **output**：`data = TermRule`
- **errors**：`VALIDATION_FAILED`（空词/冲突/`to` 出现在自身 `from` 中）、`UNAUTHORIZED`。

#### `feige_term_update` — 修改规则（W）

- **description**：修改词表规则的变体列表/归一目标/分类/优先级/开关/备注。
- **REST**：`PATCH /terms/{termId}`（#33）
- **annotations**：`readOnlyHint:false`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "termId": { "type": "string", "pattern": "^term_[0-9A-HJKMNP-TV-Z]{26}$" },
    "from": { "type": "array", "minItems": 1, "maxItems": 32, "uniqueItems": true,
      "items": { "type": "string", "minLength": 1, "maxLength": 32 } },
    "to": { "type": "string", "minLength": 1, "maxLength": 32 },
    "category": { "type": "string", "enum": ["company","product","person","custom"] },
    "priority": { "type": "integer", "minimum": 0, "maximum": 1000 },
    "enabled": { "type": "boolean" },
    "caseSensitive": { "type": "boolean" },
    "note": { "type": "string", "maxLength": 256 },
    "confirm": { "const": true }
  },
  "required": ["termId", "confirm"],
  "additionalProperties": false
}
```

- **output**：`data = TermRule`（更新后）
- **errors**：`TERM_NOT_FOUND`、`VALIDATION_FAILED`。

#### `feige_term_remove` — 删除规则（W，destructive）

- **description**：删除单条词表规则（REST 204；重复删除返回 `TERM_NOT_FOUND`）。
- **REST**：`DELETE /terms/{termId}`（#34，204）
- **annotations**：`readOnlyHint:false`、`destructiveHint:true`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "termId": { "type": "string", "pattern": "^term_[0-9A-HJKMNP-TV-Z]{26}$" },
    "confirm": { "const": true }
  },
  "required": ["termId", "confirm"],
  "additionalProperties": false
}
```

- **output**：`data = null`（204）
- **errors**：`TERM_NOT_FOUND`、`UNAUTHORIZED`。

#### `feige_text_normalize` — 文本归一化（读）

- **description**：按当前词表对文本做归一化（同步、无副作用），返回归一结果与命中规则；可用于 agent 预处理。
- **REST**：`POST /text/normalize`（#35）
- **annotations**：`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`
- **inputSchema**：

```jsonc
{
  "type": "object",
  "properties": {
    "text": { "type": "string", "minLength": 1, "maxLength": 20000 },
    "options": { "type": "object",
      "properties": {
        "includeUnchanged": { "type": "boolean", "default": false },
        "categoryFilter": { "type": "array", "maxItems": 4,
          "items": { "type": "string", "enum": ["company","product","person","custom"] } }
      }, "additionalProperties": false }
  },
  "required": ["text"],
  "additionalProperties": false
}
```

- **output**（[05 §7.9](./05-对外API契约.md)）：

```jsonc
{
  "original": "复萌那边说福梦的系统不错",
  "normalized": "孚盟那边说孚盟的系统不错",
  "applied": [
    { "from": "复萌", "to": "孚盟", "count": 1 },
    { "from": "福梦", "to": "孚盟", "count": 1 }
  ],
  "rulesVersion": "2026-11-14T10:00:00+08:00"
}
```

- **errors**：`VALIDATION_FAILED`（超长/空文本）、`UNAUTHORIZED`。

---

## 6. 写操作安全边界

### 6.1 双闸模型

| 闸门 | 机制 | 说明 |
| --- | --- | --- |
| 启动闸 | `feige mcp --allow-write` | 默认只读：14 个写工具不出现在 `tools/list`，调用返回 `-32601` |
| 调用闸 | 参数 `confirm: {"const":true}` | 每个写工具必填；缺失/非 true → `-32602`。不可由 agent 默认填充，需在明确用户意图下调用 |

叠加约束：服务端仍强制校验时段、账号串行、冷却、幂等、防重、审计（[01 §5.6/§5.7/§8.5](./01-决策与约定.md)），MCP 只做入口管控，不改变业务规则。

### 6.2 各写工具的额外约束

| 工具 | 额外约束 |
| --- | --- |
| `feige_dial` | ① 仅接受**单个**号码（schema 无数组）；② 禁止循环/批量调用，单次任务多号码必须逐个人工确认；③ 建议先 `dryRun:true`；④ 必须生成并复用 `idempotencyKey`；⑤ `CALL_OUTSIDE_DIAL_WINDOW` 时不得自动排到次日或重试轰炸；⑥ `CALL_TRACKING_TIMEOUT` 时禁止直接重拨，转人工核对 |
| `feige_account_login` | ① 可能触发滑块/风控，需人工在场；② 单账号同一时间只允许一个登录作业；③ `ACCOUNT_LOGIN_FAILED` 后最多再试 1 次，之后转人工；④ 不得对多账号并发登录（错峰限速） |
| `feige_account_add` / `feige_account_update` | ① 不接受明文密码；仅 `passwordEnv`/`secretRef`；② 密码轮换会清除现有会话，需重新登录 |
| `feige_account_remove` | ① 默认保留历史数据；② `purgeData:true` 需 `purgeConfirm="PURGE:<accountId>"` 且用户明确要求；③ 不得为"重置登录"而删除账号 |
| `feige_call_reprocess` | ① 有 ASR/LLM token 成本：ASR 按音频时长、analysis 按 token（不设预算上限但记录 usage），同一 call+stage 5 分钟内不得重复提交（复用幂等键）；② ASR 失败（`ASR_FAILED`）或低置信角色映射（`needsReview=true`）时才重跑，勿对已 ready 结果无谓重跑；`analysis` 可用 `analysisModel` 升级到 `deepseek-v4-pro` |
| `feige_sync_start` | `full` 会触发历史话单 ASR/analysis 全量回补（不设预算上限，需用户明确同意并观测 token/耗时）；日常用 `incremental`；`backfill` 代价高 |
| `feige_terms_replace` | 全量替换会删除未出现的旧规则；先 `dryRun:true` 并展示 diff |
| `feige_config_set` | 修改 `dial.*`/`limits.*`/`pipeline.*` 影响调度、并发与后处理；先 diff 后应用；密钥字段只读 |
| `feige_call_cancel` | 仅 `pending` 可取消；已提交/接通返回 `CALL_NOT_CANCELABLE`，不得反复尝试 |

### 6.3 审计与可观测

- 所有写调用写 `AuditLog`（[01 §6](./01-决策与约定.md)）：`who`（MCP clientInfo）、`what`（tool + 参数摘要，号码掩码）、`when`、`requestId`、结果。
- 工具结果 `meta.requestId` 可跨 CLI/MCP/REST/日志对齐；事件流推送对应 `call.*`/`account.*`/`sync.*` 事件（[01 §7.3](./01-决策与约定.md)）。

### 6.4 明确禁止

1. 不提供、也不得组合出：批量呼出、批量删除、批量登录。
2. 不得从资源内容（转写/话单）中批量提取号码后循环 `feige_dial`。
3. 不得尝试绕过拨打时段、上游风控或质检限制（[01 §1.2](./01-决策与约定.md) 非目标）。
4. 不得把 JWT、密码、完整录音二进制写入对话上下文/日志；展示号码需掩码。
5. 不得在平台内置 pipeline 之外把录音/转写发送到外部服务（平台自身按 [13 §10](./13-后处理规格（ASR与LLM）.md) 的脱敏/告知要求调用 MiniMax ASR 与 DeepSeek；agent 不得额外外发）。
6. 不得绕过平台直连 MiniMax/DeepSeek 或索取其密钥（密钥只在平台 secrets/环境变量）。

---

## 7. 资源（resources）

### 7.1 资源与 URI 模板

> 资源内容为 REST `data` 的原样 JSON（不含封套）；字段以 [05 §2](./05-对外API契约.md) 为准。

| URI / 模板 | mimeType | 内容 | 对应 REST |
| --- | --- | --- | --- |
| `feige://status` | `application/json` | 平台健康快照（StatusPayload） | `GET /status` |
| `feige://accounts` | `application/json` | 账号列表（AccountSummary[]） | `GET /accounts` |
| `feige://accounts/{accountId}` | `application/json` | 账号详情（AccountDetail） | `GET /accounts/{accountId}` |
| `feige://calls/{callId}` | `application/json` | 话单摘要（CallSummary） | `GET /calls/{callId}` |
| `feige://calls/{callId}/detail` | `application/json` | 话单详情（CallDetail） | `GET /calls/{callId}/detail` |
| `feige://calls/{callId}/transcript` | `application/json` | 本地 ASR 转写全文+分段（TranscriptPayload，`source=asr`、`provider=minimax:asr-1.0`，segments 含 `speakerLabel`/`chunkIndex`/`confidence`） | `GET /calls/{callId}/transcript` |
| `feige://calls/{callId}/audio` | `application/json` | 录音元数据 + **本地下载 URL**：`{available,downloadUrl,format,durationMs,sizeBytes,sha256,sampleRate,channels}`（**不内联二进制**） | `GET /calls/{callId}/detail` 的 `recording` + `/audio` |
| `feige://calls/{callId}/events` | `application/json` | 该话单事件时间线（EventRecord[]） | `GET /calls/{callId}/events` |

`resources/read` 返回：

```jsonc
{
  "contents": [
    { "uri": "feige://calls/call_01J8Z3K5T9QW2M4R7X1C6V0B8N/transcript",
      "mimeType": "application/json",
      "text": "{\"callId\":\"call_...\",\"source\":\"asr\",\"provider\":\"minimax:asr-1.0\",\"fullText\":\"...\",\"segments\":[...]}" }
  ]
}
```

- 错误时 `resources/read` 返回 JSON-RPC error `-32002`（resource not found）或 `-32603`，`data` 中可带 `{code,message}`（code 取自 01 §5.4）。
- 音频资源只给**下载 URL + 校验信息**；需要字节时用 `feige_call_audio`（`inline:true`）或 CLI `feige calls audio --out`。本地文件路径不通过 REST/MCP 暴露（仅 CLI 输出路径）。

### 7.2 订阅（subscriptions）

| 资源 | 可订阅 | 触发通知的底层事件 |
| --- | --- | --- |
| `feige://status` | ✅ | `account.health.changed`、`account.session.expired`、`sync.failed`、`job.updated` |
| `feige://accounts` / `feige://accounts/{accountId}` | ✅ | `account.login.*`、`account.health.changed`、`account.session.expired` |
| `feige://calls/{callId}` | ✅ | 该话单 `call.*`（created/dialing/connected/ended/no_answer/failed/canceled） |
| `feige://calls/{callId}/detail` | ✅ | 同上 + 流水线事件（`call.audio.ready`、`call.transcript.ready`、`call.analysis.ready` 等） |
| `feige://calls/{callId}/transcript` | ✅ | `call.transcript.ready` / `call.transcript.failed` |
| `feige://calls/{callId}/audio` | ❌ | 元数据变化随 `feige://calls/{callId}` 的 `audio.ready` 通知 |
| `feige://calls/{callId}/events` | ✅ | 该话单任意事件（增量） |

机制：

1. 客户端 `resources/subscribe {uri}` → server 建立订阅并返回 `{}`。
2. 变更时 server 发送 `notifications/resources/updated {uri}`（不带内容，客户端再 `resources/read`）。
3. 底层复用 `GET /events/stream`（SSE，[01 §7.3](./01-决策与约定.md) / [05 §7.7](./05-对外API契约.md)）；`Last-Event-ID` 断点续传由 server 维护。
4. 限制：单会话最多 20 个活跃订阅；订阅不存在的 callId 返回 `-32602`；`resources/unsubscribe {uri}` 取消。
5. 不支持 `resources/list_changed`（模板固定）。

---

## 8. 提示模板（prompts）

| 名称 | 参数 | 用途 |
| --- | --- | --- |
| `today_call_summary` | `date?`（默认今天，Asia/Shanghai）、`accountId?` | 汇总当日通话：接通/未接/失败、时长、意向客户清单（脱敏）；转写为平台本地 ASR（`source=asr`），分析为 DeepSeek；引导 agent 依次调用 `feige_status` → `feige_call_list` → `feige_call_transcript`（`includeAnalysis=true`） |
| `follow_up_unanswered` | `date?`、`accountId?` | 基于未接通话单生成回访建议与名单（含冷却/时段提示） |
| `review_call` | `callId`（必填） | 单通电话复盘：详情→转写→分析（含 `AnalysisPayload.promptVersion`/`usage`/`speakerMapping.needsReview`），输出摘要/意向/待跟进点，并标注需人工复核项 |

示例（`prompts/get`）：

```jsonc
// → prompts/get
{ "jsonrpc": "2.0", "id": 9, "method": "prompts/get",
  "params": { "name": "today_call_summary", "arguments": { "date": "2026-11-14" } } }

// ← result
{ "jsonrpc": "2.0", "id": 9, "result": {
    "description": "汇总 2026-11-14 通话并列出意向客户",
    "messages": [ { "role": "user", "content": { "type": "text",
      "text": "请汇总 2026-11-14（Asia/Shanghai）的通话：1) 调用 feige_status 确认账号/dialWindow 与本地 ASR/analysis 队列；2) 调用 feige_call_list（dateFrom=2026-11-14,dateTo=2026-11-14, size=100, 必要时翻页）统计各状态数量；3) 对 ended 且 pipeline.transcript=ready 的通话调用 feige_call_transcript（includeAnalysis=true）提取客户意向（转写来自平台本地 ASR，分析来自 DeepSeek）；4) 对 detail.transcript.needsReview=true 的通话标注\"需人工复核\"；5) 输出脱敏表格（callId、号码掩码、时长、意向、下一步）。禁止发起任何外呼。" } } ],
    "arguments": { "date": "2026-11-14" }
} }
```

> prompts 仅是**提示词模板**，不含副作用；实际调用仍受工具闸门与安全边界约束。

---

## 9. 与 REST 的映射总表

| tool | 方法 | 路径 | 01 §4.1 # | 读/写 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `feige_health` | GET | `/health` | 1（MCP 列原 `—`，补充只读） | 读 | — |
| `feige_status` | GET | `/status` | 2 | 读 | query `detail` |
| `feige_config_get` | GET | `/config` | 3 | 读 | `key` 为工具层过滤 |
| `feige_config_set` | PATCH | `/config` | 4 | 写 | Merge Patch body |
| `feige_account_list` | GET | `/accounts` | 5 | 读 | enabled/state/page/size |
| `feige_account_add` | POST | `/accounts` | 6 | 写 | 201；密码经 env/secret 解析 |
| `feige_account_get` | GET | `/accounts/{accountId}` | 7 | 读 | — |
| `feige_account_update` | PATCH | `/accounts/{accountId}` | 8 | 写 | 支持密码轮换 |
| `feige_account_remove` | DELETE | `/accounts/{accountId}` | 9 | 写 | 204；purge 需 `confirm=PURGE:<id>` |
| `feige_account_login` | POST | `/accounts/{accountId}/login` | 10 | 写 | 200（wait）/202（async） |
| `feige_account_logout` | POST | `/accounts/{accountId}/logout` | 11 | 写 | 204 |
| `feige_account_health` | GET | `/accounts/{accountId}/health` | 12 | 读 | 上游探测缓存 30s |
| `feige_dial` | POST | `/calls` | 13 | 写 | 201；dryRun → 200 |
| `feige_call_list` | GET | `/calls` | 14 | 读 | — |
| `feige_call_get` | GET | `/calls/{callId}` | 15 | 读 | — |
| `feige_call_detail` | GET | `/calls/{callId}/detail` | 16 | 读 | includeRaw/includeEvents |
| `feige_call_transcript` | GET | `/calls/{callId}/transcript` | 17 | 读 | includeAnalysis |
| `feige_call_audio` | GET | `/calls/{callId}/audio` | 18 | 读 | 元数据取自 detail.recording |
| `feige_call_reprocess` | POST | `/calls/{callId}/reprocess` | 19 | 写 | 202 |
| `feige_call_cancel` | POST | `/calls/{callId}/cancel` | 20 | 写 | 200 |
| `feige_call_events` | GET | `/calls/{callId}/events` | 21 | 读 | — |
| `feige_sync_start` | POST | `/sync` | 22 | 写 | 202；wait 可同步 |
| `feige_sync_status` | GET | `/sync` | 23 | 读 | — |
| `feige_job_get` | GET | `/jobs/{jobId}`（同步作业亦可 `/sync/{jobId}`） | 24 / 26 | 读 | — |
| `feige_job_list` | GET | `/jobs` | 25 | 读 | — |
| `feige_events_list` | GET | `/events` | 27 | 读 | — |
| `feige_terms_list` | GET | `/terms` | 30 | 读 | — |
| `feige_terms_replace` | PUT | `/terms` | 31 | 写 | body `{rules,mode:"replace"}` |
| `feige_term_add` | POST | `/terms` | 32 | 写 | 201 |
| `feige_term_update` | PATCH | `/terms/{termId}` | 33 | 写 | — |
| `feige_term_remove` | DELETE | `/terms/{termId}` | 34 | 写 | 204 |
| `feige_text_normalize` | POST | `/text/normalize` | 35 | 读（无副作用） | — |

未映射为工具（按 01 §4.1 约定）：`GET /events/stream`（由 resources/subscribe 承担）、`POST /webhooks/test`（v1.1 可选，仅 CLI）。

---

## 10. 客户端接入与验证

### 10.1 注册步骤（概念）

1. 确认平台运行：`feige health`。
2. 生成配置：`feige mcp --print-config`，写入 agent 的 MCP 配置。
3. 只读验证：`tools/list` 应返回 18 个只读工具；调用 `feige_status` 确认 `ok:true`。
4. 写能力（可选）：启动参数加 `--allow-write`；`tools/list` 增加 14 个写工具。
5. 资源验证：`resources/read {uri:"feige://status"}`；`resources/templates/list` 应有 §7.1 全部模板。

### 10.2 `tools/list` 片段示例

```jsonc
{ "jsonrpc": "2.0", "id": 2, "result": { "tools": [
  { "name": "feige_status",
    "title": "平台健康",
    "description": "返回平台整体健康（DB/账号池/上游/时段/队列/流水线）",
    "inputSchema": { "type": "object", "properties": { "detail": { "type": "boolean", "default": true } }, "additionalProperties": false },
    "annotations": { "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true } },
  { "name": "feige_dial",
    "title": "发起呼出（有副作用/计费）",
    "description": "发起真实外呼；回拨模式先振铃坐席手机，需要人工接听",
    "inputSchema": { "type": "object", "properties": {
        "to": { "type": "string", "pattern": "^(1[3-9]\\d{9}|0\\d{2,3}-?\\d{7,8})$" },
        "accountId": { "type": "string" },
        "customerName": { "type": "string" },
        "idempotencyKey": { "type": "string" },
        "dryRun": { "type": "boolean", "default": false },
        "confirm": { "const": true } },
      "required": ["to", "confirm"], "additionalProperties": false },
    "annotations": { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": true } }
] } }
```

### 10.3 客户端侧典型调用序列（只读）

```jsonc
// 1) 探活 + 平台状态
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"feige_status","arguments":{}}}
// 2) 今日已接通话单
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"feige_call_list","arguments":{"dateFrom":"2026-11-14","dateTo":"2026-11-14","status":"ended","size":20}}}
// 3) 拉某通话转写（含分析）
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"feige_call_transcript","arguments":{"callId":"call_01J8Z3K5T9QW2M4R7X1C6V0B8N","includeAnalysis":true}}}
```

---

## 11. 一致性声明与对齐清单

**基准优先级**：[01-决策与约定.md](./01-决策与约定.md) > [05-对外API契约.md](./05-对外API契约.md) > 本文。

| 核对项 | 结论（对齐依据：docs/01 v1 ASR/LLM 决策、docs/05、docs/13，2026-11-14） |
| --- | --- |
| server 名/transport | `feige-outbound` / `stdio`，启动方式 `feige mcp`（与 00 架构图一致） |
| 工具命名/数量 | 31 个工具与 [01 §4.1](./01-决策与约定.md)「MCP」列逐一对应；`feige_health` 为补充只读工具（映射 #1，01 中 MCP 列原为 `—`）；合计 32（18 读 / 14 写） |
| 注解 | 18 只读 / 14 写；5 个 destructive；`openWorldHint` 覆盖上游/第三方访问工具，与 §3.2 一致 |
| DTO 字段 | `data` 形态与 05 一致：列表为数组；`CallSummary.to/from` 为 `{phone,location?}`；`pipeline{audio,transcript,analysis}`；`transcript{source:"asr",provider:"minimax:asr-1.0",chunkCount,needsReview}`；`segments{speakerLabel,chunkIndex,channel,confidence,rawText,normalizedText}`；`AnalysisPayload{promptVersion,usage,speakerMapping{method,confidence,needsReview,evidence}}`；`termId=term_...`、`from: string[]`；`dialWindow{open,windowStart,windowEnd,timezone,nextOpenAt}`；`dateFrom`/`dateTo`（`to` 已被占用于被叫号码） |
| 关键行为 | dial 201/dryRun 200、login 默认 wait=true 与 async 202、logout 204、reprocess stages 必填 + `options{asrModel,analysisModel,promptVersion,termRulesVersion}`、sync mode 含 `full`（历史话单 ASR/analysis 回补，不设预算但记录用量）与 `backfill`、`TRANSCRIPT_PENDING.details.stage=asr_queued\|asr_running\|role_mapping\|analysis`、DELETE /terms/{termId} 204/重复 404、PUT /terms `{rules,mode:"replace"}`、text normalize 1–20000 字符 |
| 后处理链路 | 转写=本地 ASR（MiniMax `asr-1.0`，不使用上游转写）；分析=平台内置 DeepSeek（`deepseek-chat` → `deepseek-v4-pro`，`promptVersion=analysis-v1`）；`config pipeline` 为嵌套 `asr`/`analysis`/`roleMapping`；`feige_sync_start{mode:"full"}` 触发全量回补 |
| 错误码 | 仅使用 01 §5.4 的 **40 个**稳定码（已删除原上游转写等待码，含 `SERVICE_UNAVAILABLE`）；JSON-RPC 协议错误用标准 -32600/-32601/-32602/-32603；传输错误归一 `SERVICE_UNAVAILABLE`，未新增其它业务码 |
| 封套 | `{ok,data,meta}` / `{ok:false,error,meta}` / `meta.pagination` / `meta.idempotencyReplayed` 与 01 §5.3、05 §1.2 一致 |
| 写操作 | `Idempotency-Key`（01 §5.6）、时段（07:50–22:00）、账号串行、同号冷却、防重（01 §5.7）在工具层显式声明且不绕过 |
| 安全 | 双闸（`--allow-write` + `confirm`）、无批量工具、审计、脱敏；密码/JWT/第三方密钥不进入对话 |
| 脱敏 | 全文无真实密码/JWT/完整手机号；第三方密钥仅 `sk-...` 占位 |
| 实现代码 | 无 |

> 已知 docs/05 待澄清项（不影响本文契约，将在本轮汇报中提交 Lead 确认）：§2.9 定义了 `AnalysisPayload`（含 `promptVersion`/`usage`）但具体响应（`TranscriptPayload.analysis` 为 brief、`pipelineDetail.analysis` 无 usage）未明确完整 payload 的承载位置；本文 schema 引用 05 §2.9 字段定义，建议 05 明确 token 观测返回位置。
> （docs/05 已于 2026-11-14 00:05 修复 `JobSummary.type` 枚举与 reprocess `options{asrModel,...}`，本文已同步；此前记录的两项已关闭。）
