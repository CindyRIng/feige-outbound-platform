# 06 CLI 契约（`feige`）

> 状态：v0.3（Step 2 设计稿，2026-11-14；按 v1 决策修订：转写=本地自建 ASR（MiniMax `asr-1.0`）、LLM 后处理=DeepSeek、稳定错误码 40 个；已对齐 [01](./01-决策与约定.md)/[05](./05-对外API契约.md)/[13](./13-后处理规格（ASR与LLM）.md)）
> 上游事实依据：[00-上游可行性侦察.md](./00-上游可行性侦察.md)；全局基准：[01-决策与约定.md](./01-决策与约定.md)（冲突以 01 为准）。
> **字段级权威**：[05-对外API契约.md](./05-对外API契约.md)（本文的 `--json` 输出即 REST 封套；DTO 字段见 05 §2）；后处理规格：[13-后处理规格（ASR与LLM）.md](./13-后处理规格（ASR与LLM）.md)。
> 本文只描述**契约**（命令、参数、输出、退出码、错误语义），不含实现代码。

---

## 1. 定位与原则

`feige` 是本地飞鸽外呼平台的命令行入口，是 REST 的**薄封装**，不重复实现业务逻辑。

| 原则 | 说明 |
| --- | --- |
| 单一契约源 | 命令映射的 REST 方法/路径严格采用 [01 §4.1](./01-决策与约定.md)「CLI」列，禁止另起命名 |
| 同构输出 | `--json` 输出与 REST 响应封套（[01 §5.3](./01-决策与约定.md)）完全一致，可被 `jq` 直接消费 |
| 字段对齐 | 所有 JSON 示例字段与 [05 §2](./05-对外API契约.md) 的 DTO 一致（`data` 为数组或对象，见各命令） |
| 人类可读优先 | 无 `--json` 时输出表格/字段样式；诊断信息只走 stderr |
| 写操作显式化 | 呼出/登录/重跑/删除等有副作用命令必须通过确认闸门（交互确认或 `--yes`），支持幂等键 |
| 可脚本化 | 非 TTY 自动进入非交互模式；stdin/管道/纯 JSON 输出齐全；退出码稳定可判定 |
| 无隐藏副作用 | 读命令只读；`--dry-run` 不产生写副作用（详见 §10） |
| 转写/后处理 | v1 **不使用上游转写**：转写全部由本地 ASR（MiniMax `asr-1.0`）生成；分析由平台内置 DeepSeek pipeline 完成（默认 `deepseek-chat`，校验失败升级 `deepseek-v4-pro`）；规格见 [13-后处理规格（ASR与LLM）.md](./13-后处理规格（ASR与LLM）.md) |

**本地命令 vs 远程命令**：

| 类别 | 命令 | 是否访问 REST |
| --- | --- | --- |
| 本地命令 | `serve` `doctor` `mcp` `completion` `version` | 否（`doctor` 部分检查项会只读访问 REST） |
| 远程命令 | 其余全部 | 是，经 `--api` 指向的 REST 基址 |

---

## 2. 安装与调用约定

- 可执行名：`feige`（必须能在 `PATH` 中解析）；`feige --version` 可验证。
- 安装：`npm install && npm run build && npm run install:cli`（默认安装到 `~/.local/bin/feige`，见 docs/15）。
- 帮助：`feige --help`（顶层命令/全局选项）、`feige help <command>`（含子命令）、**`feige --help-all`（完整命令树，全部命令/子命令/参数/选项）**；完整参考见自动生成的 [16-CLI参考手册.md](./16-CLI参考手册.md)。
- 平台侧依赖：`feige serve` 常驻服务已运行（systemd user service，见 [10-部署与运维.md](./10-部署与运维.md)）。
- 身份：本地 API token 存于 `~/.config/feige-outbound/api-token`（0600，[01 §5.2](./01-决策与约定.md)），CLI 默认读取；也可用 `--token-file` 或环境变量指定。
- 示例中的号码、账号、ID 均已**脱敏**；实际使用时传真实完整值。

---

## 3. 全局约定

### 3.1 全局参数

| 短 | 长 | 默认值 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `-a` | `--api <url>` | `FOP_API_URL` 或 `http://127.0.0.1:8710/api/v1` | 否 | REST 基址。只给 `host:port` 或根 URL 时自动补 `/api/v1` |
| `-t` | `--token-file <path>` | `FOP_API_TOKEN_FILE` 或 `~/.config/feige-outbound/api-token` | 否 | 本地 API token 文件（0600）；与 `FOP_API_TOKEN` 二选一，文件优先 |
| `-j` | `--json` | false | 否 | 输出与 REST 同构的 JSON 封套（成功 `{ok,data,meta}`，失败 `{ok:false,error,meta}`） |
| `-q` | `--quiet` | false | 否 | 静默模式：只输出关键结果行/错误摘要（优先级低于 `--json`） |
| `-v` | `--verbose` | false | 否 | 调试日志到 stderr（HTTP 方法/路径/耗时/requestId；不打印 token、密码、完整号码） |
| | `--timeout <dur>` | `30s` | 否 | **单次 HTTP 请求**超时；格式 `500ms` / `30s` / `5m` |
| | `--request-id <id>` | 自动生成 | 否 | 覆盖请求头 `X-Request-Id`，便于全链路追踪 |
| | `--idempotency-key <key>` | 写命令自动生成 | 否 | 写操作幂等键（UUID/ULID）；同 key + 同请求体 24h 内重放首次结果（[01 §5.6](./01-决策与约定.md)） |
| `-y` | `--yes` | false | 否 | 跳过危险操作确认；**非交互模式下危险命令必须显式提供** |
| | `--no-color` | 非 TTY 自动关闭 | 否 | 禁用 ANSI 颜色 |
| | `--no-interactive` | 非 TTY 自动开启 | 否 | 强制非交互模式（不读 stdin 确认） |
| `-h` | `--help` | — | — | 命令帮助；`feige help <command>` 等价 |
| | `--version` | — | — | 版本信息（等价 `feige version`） |

> 全局参数可出现在子命令前后（`feige --json calls list` 与 `feige calls list --json` 等价）。

### 3.2 输出与流纪律

| 流 | 内容 |
| --- | --- |
| stdout | 命令结果：人类可读表格/字段，或 `--json` 的 JSON 封套；二进制输出（`calls audio --out -`）仅二进制 |
| stderr | 提示、确认问句、进度、`--verbose` 调试日志；人类模式下非 0 退出的错误摘要 |
| 退出码 | 稳定可判定，见 §3.6 |

- `--json` 模式下**失败也输出 JSON 到 stdout**（便于 `jq` 判断 `ok`），同时以非 0 退出码表达失败；错误人类摘要仍写 stderr。
- 非交互模式（stdout/stderr 非 TTY，或 `CI=true`，或 `--no-interactive`）：无确认问句、无彩色表格；危险命令缺 `--yes` → 退出码 `2`。
- 二进制与 JSON 互斥：`calls audio --out -` 不可与 `--json` 同用（本地参数错误，退出码 `2`）。

### 3.3 JSON 输出（与 REST 同构）

成功（与 [01 §5.3](./01-决策与约定.md) 完全一致）：

```jsonc
{
  "ok": true,
  "data": { "示例": "见各命令 data 摘要；列表命令此处为数组" },
  "meta": { "requestId": "req_01J8Z3K5T9QW2M4R7X1C6V0B8N", "ts": "2026-11-14T10:05:00+08:00" }
}
```

失败：

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

- 列表命令的 `data` 为**数组**（如 `CallSummary[]`/`AccountSummary[]`/`JobSummary[]`/`EventRecord[]`/`TermRule[]`），`meta.pagination` 见 [01 §5.5](./01-决策与约定.md)。
- 写接口幂等重放时 `meta.idempotencyReplayed: true`（[05 §1.2](./05-对外API契约.md)）。
- 异步受理（202）的 `data` 至少含 `jobId`、`status`、`pollUrl`。
- `204 No Content`（logout/remove/term remove）在 CLI 侧补 `{ok:true,data:null,meta:{...}}`（`meta.requestId` 取响应头 `X-Request-Id`）。
- CLI 本地参数校验失败（未发 HTTP）时，`--json` 输出 `ok:false`，`error.code` 复用 `INVALID_REQUEST`/`VALIDATION_FAILED`，`meta.requestId` 由 CLI 生成（前缀 `cli_`）。**不新增 error.code**。

### 3.4 环境变量

| 变量 | 作用 | 优先级 |
| --- | --- | --- |
| `FOP_API_URL` | REST 基址 | 低于 `--api` |
| `FOP_API_TOKEN` | 本地 API token 明文 | 低于 `--token-file` / 默认 token 文件 |
| `FOP_API_TOKEN_FILE` | token 文件路径 | 低于 `--token-file` |
| `FOP_TIMEOUT` | 单次请求超时 | 低于 `--timeout` |
| `FOP_IDEMPOTENCY_KEY` | 幂等键 | 低于 `--idempotency-key` |
| `FOP_NO_COLOR=1` / `NO_COLOR` / `CI` | 无色/非交互提示 | 低于命令行显式参数 |

> 优先级：**命令行 > 环境变量 > 默认值**。CLI 不读取服务端 `config.json`（服务端配置用 `feige config` 远程管理）。

### 3.5 交互与非交互

| 场景 | 行为 |
| --- | --- |
| TTY + 危险命令 | 展示操作摘要与副作用，要求输入 `yes` 确认；其它输入 → 取消（退出码 `1`，说明"已取消"） |
| 非 TTY + 危险命令 | 必须 `--yes`，否则本地校验失败（退出码 `2`） |
| 非 TTY + 读命令 | 直接执行，纯文本输出（无颜色、无进度条） |
| `--quiet` | 危险命令确认仍生效（问句写 stderr）；结果行简化 |
| `--no-interactive` | 强制按非交互处理，即使 stdin 是 TTY |

### 3.6 退出码

| 退出码 | 名称 | 含义 | 触发来源 |
| --- | --- | --- | --- |
| `0` | `OK` | 成功 | HTTP 2xx（含 204）或本地命令正常结束 |
| `1` | `FAILED` | 未分类失败 | 未知错误、用户取消确认、部分成功中的非关键失败 |
| `2` | `USAGE` | 用法/参数错误 | 未知命令/参数、缺必填、取值非法、非交互缺 `--yes`；`INVALID_REQUEST`/`VALIDATION_FAILED`/`CONFIG_INVALID` |
| `3` | `NOT_FOUND` | 资源不存在 | `NOT_FOUND`/`CALL_NOT_FOUND`/`ACCOUNT_NOT_FOUND`/`JOB_NOT_FOUND`/`TERM_NOT_FOUND` |
| `4` | `REJECTED` | 业务拒绝/状态冲突/限流 | `FORBIDDEN`/`ACCOUNT_DISABLED`/`ACCOUNT_BUSY`/`ACCOUNT_UPSTREAM_MISMATCH`/`CALL_OUTSIDE_DIAL_WINDOW`/`CALL_NOT_DIALABLE`/`CALL_ALREADY_TERMINAL`/`CALL_NOT_CANCELABLE`/`IDEMPOTENCY_CONFLICT`/`RATE_LIMITED`/`AUDIO_NOT_AVAILABLE`/`AUDIO_NOT_READY`/`TRANSCRIPT_NOT_AVAILABLE`/`TRANSCRIPT_PENDING` |
| `5` | `UPSTREAM` | 上游错误 | `UPSTREAM_UNREACHABLE`/`UPSTREAM_AUTH_EXPIRED`/`UPSTREAM_BUSINESS_ERROR`/`UPSTREAM_RATE_LIMITED`/`UPSTREAM_RESPONSE_INVALID`/`CALL_REJECTED_BY_UPSTREAM`/`CALL_TRACKING_TIMEOUT`/`AUDIO_DOWNLOAD_FAILED` |
| `6` | `AUTH` | 认证/登录态问题 | `UNAUTHORIZED`/`ACCOUNT_LOGIN_REQUIRED`/`ACCOUNT_LOGIN_IN_PROGRESS`/`ACCOUNT_LOGIN_FAILED` |
| `7` | `INTERNAL` | 服务内部/依赖失败 | `INTERNAL_ERROR`/`DB_UNAVAILABLE`/`ASR_FAILED`/`ANALYSIS_FAILED` |
| `8` | `UNREACHABLE` | 本地服务不可达 | 连接被拒、DNS/网络层失败（未获得 HTTP 响应） |
| `9` | `TIMEOUT` | 超时 | `--timeout`/`--wait-timeout` 到期仍未完成；`SERVICE_UNAVAILABLE` 归此类 |
| `10` | `NOT_IMPLEMENTED` | 能力未实现 | `NOT_IMPLEMENTED`（501） |
| `130` | `INTERRUPTED` | 用户中断 | `SIGINT`（Ctrl-C）；读/幂等写可安全重试 |

判定顺序：**`error.code` 精确命中 → 表中归属**；未命中时按 HTTP 状态家族回落（400→2、401→6、403/409/422/429→4、404→3、500→7、501→10、502→5、503→9）；无 HTTP 响应时连接失败→8、超时→9。

### 3.7 错误码 → 退出码（全量对照，40 个）

> 错误码全集与 `retryable` 以 [01 §5.4](./01-决策与约定.md) 为准；本表只补退出码归属，不新增/不改写错误码。

| 退出码 | error.code |
| --- | --- |
| `2` | `INVALID_REQUEST` `VALIDATION_FAILED` `CONFIG_INVALID` |
| `3` | `NOT_FOUND` `CALL_NOT_FOUND` `ACCOUNT_NOT_FOUND` `JOB_NOT_FOUND` `TERM_NOT_FOUND` |
| `4` | `FORBIDDEN` `ACCOUNT_DISABLED` `ACCOUNT_BUSY` `ACCOUNT_UPSTREAM_MISMATCH` `CALL_OUTSIDE_DIAL_WINDOW` `CALL_NOT_DIALABLE` `CALL_ALREADY_TERMINAL` `CALL_NOT_CANCELABLE` `IDEMPOTENCY_CONFLICT` `RATE_LIMITED` `AUDIO_NOT_AVAILABLE` `AUDIO_NOT_READY` `TRANSCRIPT_NOT_AVAILABLE` `TRANSCRIPT_PENDING` |
| `5` | `UPSTREAM_UNREACHABLE` `UPSTREAM_AUTH_EXPIRED` `UPSTREAM_BUSINESS_ERROR` `UPSTREAM_RATE_LIMITED` `UPSTREAM_RESPONSE_INVALID` `CALL_REJECTED_BY_UPSTREAM` `CALL_TRACKING_TIMEOUT` `AUDIO_DOWNLOAD_FAILED` |
| `6` | `UNAUTHORIZED` `ACCOUNT_LOGIN_REQUIRED` `ACCOUNT_LOGIN_IN_PROGRESS` `ACCOUNT_LOGIN_FAILED` |
| `7` | `INTERNAL_ERROR` `DB_UNAVAILABLE` `ASR_FAILED` `ANALYSIS_FAILED` |
| `9` | `SERVICE_UNAVAILABLE` |
| `10` | `NOT_IMPLEMENTED` |
| `8` / `9` / `130` | 传输层错误：连接失败 / 超时 / 用户中断（无 `error.code`） |

> 说明：① v1 稳定错误码为 **40 个**，已删除原“上游转写等待”错误码（v1 不再有上游转写路径）；`TRANSCRIPT_PENDING` 的 `details.stage` 取 `asr_queued`/`asr_running`/`role_mapping`/`analysis`（本地 ASR + 角色映射 + 分析），CLI 归入退出码 `4`。② `SERVICE_UNAVAILABLE` 为 [01 §5.4](./01-决策与约定.md) 稳定码（retryable=true），表示"本地服务暂不可用（启动中/优雅关闭/传输中断）"，亦用于客户端侧"平台不可达"归一；CLI 归入退出码 `9`。

---

## 4. 命令树总览

```text
feige
├── serve                         # 启动本地常驻服务（本地命令）
├── health                        # 存活探针（GET /health）
├── status                        # 平台健康（GET /status）
├── version                       # 版本信息（本地命令）
├── doctor                        # 自检/排障（本地 + 只读 REST）
├── mcp                           # 启动 MCP stdio server（feige-outbound）
├── completion <shell>            # 生成补全脚本（本地命令）
├── account
│   ├── add <accountId>           # POST /accounts
│   ├── list                      # GET /accounts
│   ├── show <accountId>          # GET /accounts/{accountId}
│   ├── update <accountId>        # PATCH /accounts/{accountId}
│   ├── remove <accountId>        # DELETE /accounts/{accountId}
│   ├── login <accountId>         # POST /accounts/{accountId}/login
│   ├── logout <accountId>        # POST /accounts/{accountId}/logout
│   └── health <accountId>        # GET /accounts/{accountId}/health
├── dial <toPhone>                # POST /calls（发起呼出，有副作用/计费）
├── calls
│   ├── list                      # GET /calls
│   ├── get <callId>              # GET /calls/{callId}
│   ├── detail <callId>           # GET /calls/{callId}/detail
│   ├── transcript <callId>       # GET /calls/{callId}/transcript
│   ├── audio <callId>            # GET /calls/{callId}/audio（二进制）
│   ├── reprocess <callId>        # POST /calls/{callId}/reprocess
│   ├── cancel <callId>           # POST /calls/{callId}/cancel
│   └── events <callId>           # GET /calls/{callId}/events
├── sync [start]                  # POST /sync（触发同步，异步作业）
│   └── status                    # GET /sync（最近同步作业）
├── jobs
│   ├── list                      # GET /jobs
│   └── get <jobId>               # GET /jobs/{jobId}（同步作业亦可 /sync/{jobId}）
├── events                        # GET /events（--follow 走 GET /events/stream）
├── term
│   ├── list                      # GET /terms
│   ├── add                       # POST /terms
│   ├── update <termId>           # PATCH /terms/{termId}
│   ├── remove <termId>           # DELETE /terms/{termId}
│   └── import <file|->           # PUT /terms（全量替换）
├── config
│   ├── get                       # GET /config
│   └── set <key=value>...        # PATCH /config（JSON Merge Patch）
├── text
│   └── normalize <text|->        # POST /text/normalize
└── webhook (v1.1 可选)
    └── test                      # POST /webhooks/test
```

> 每个命令支持 `-h/--help`；命令名与 [01 §4.1](./01-决策与约定.md)「CLI」列一一对应，无改名。

---

## 5. 本地与平台命令

### 5.1 `feige serve`

启动常驻主进程（HTTP API + 事件总线 + worker），生产由 systemd user service 以 `--foreground` 运行（见 [10-部署与运维.md](./10-部署与运维.md)）。

```bash
feige serve [--host <ip>] [--port <n>] [--config <file>] [--foreground] [--log-level <level>]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--host <ip>` | `127.0.0.1` | 否 | 监听地址；非本机地址需显式配置并启用认证（[01 §5.2](./01-决策与约定.md)） |
| `--port <n>` | `8710` | 否 | 监听端口 |
| `--config <file>` | `~/.config/feige-outbound/config.json` | 否 | 配置文件路径 |
| `--foreground` | false | 否 | 前台运行（systemd 必需） |
| `--log-level <l>` | `info` | 否 | `debug`/`info`/`warn`/`error`；结构化 JSON 日志写 stderr |

```text
feige serve v0.1.0  starting
  api      http://127.0.0.1:8710/api/v1
  config   ~/.config/feige-outbound/config.json
  data     ~/.local/share/feige-outbound
  dial     07:50–22:00 Asia/Shanghai (window open)
  accounts 2 loaded (online 1, expired 1)
  ready in 842ms  (Ctrl-C to stop)
```

- `--json`：每行一条 JSON 日志（非 REST 封套）；stdout 仅版本行与就绪行。
- 退出码：`0` 优雅关闭；`1` 启动失败（端口占用/配置非法/DB 不可用）；`2` 参数错误；`130` SIGINT。

### 5.2 `feige health`

存活探针（`GET /health`，不做上游检查）。

```bash
feige health [--json]
```

```text
OK  feige-outbound v0.1.0  uptime 1d 02:14
```

`--json` 的 `data`（[05 §4.1](./05-对外API契约.md)）：`{ "ok": true, "uptimeSec": 93780, "version": "0.1.0", "startedAt": "2026-11-13T20:00:00+08:00" }`

- 服务不可达 → 退出码 `8`；返回 `503` → 退出码 `9`。
- 错误：`UNAUTHORIZED`(6)、`INTERNAL_ERROR`(7)。

### 5.3 `feige status`

平台健康总览（`GET /status`，即 `getStatus → Status`）。单通话单状态用 `calls get/detail`。

```bash
feige status [--detail|--no-detail] [--watch] [--interval <dur>] [--json]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--detail` / `--no-detail` | `--detail` | 否 | 是否返回 `accountsDetail`（映射 REST query `detail`） |
| `--watch` | false | 否 | 持续刷新（默认 5s）；`--json` 时每行一条封套 |
| `--interval <dur>` | `5s` | 否 | 刷新间隔，仅配合 `--watch` |

```text
平台状态     v0.1.0    运行 1d 02:14
服务端时间   2026-11-14T10:00:00+08:00
数据库       ok  24.0 MB（WAL 1.0 MB）  schema v1  1ms
拨打时段     开放  07:50–22:00 Asia/Shanghai  下次开启 -
账号         2 个：online 1 / expired 1 / disabled 0
上游         可达  最近检查 10s 前  180ms
队列         作业 queued 3 / running 1 / 24h 失败 0
             流水线 audio 待处理 2 / 本地 ASR 待处理 1 / analysis 待处理 0
最近同步     2026-11-14T09:59:30+08:00  滞后账号 0
SSE 客户端   1
```

`--json` 的 `data`（`StatusPayload`，[05 §2.11](./05-对外API契约.md)）：

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

- 退出码：`0` 成功；`8` 服务不可达；`6` `UNAUTHORIZED`。
- 错误：`UNAUTHORIZED`(6)、`DB_UNAVAILABLE`(7)、`INTERNAL_ERROR`(7)。
- 字段语义：`queues.transcriptPending` = **本地 ASR 队列**积压（v1 转写全部自建，[01 §7.2](./01-决策与约定.md)）；ASR/LLM 供应商健康与 token 消耗用 `feige doctor --probe-providers`、`feige jobs`（analysis 作业）观测。

### 5.4 `feige doctor`

自检/排障：本机环境 + 本地服务 + 账号 + 上游可达 + 拨打时段 + **第三方 provider（MiniMax ASR / DeepSeek）**的只读诊断，给出修复建议命令。**不修改任何状态**。

```bash
feige doctor [--json] [--probe-upstream] [--probe-providers] [--verbose]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--probe-upstream` | false | 否 | 对上游做一次轻量只读探测（可能消耗 1 次上游读请求） |
| `--probe-providers` | false | 否 | 检查 MiniMax/DeepSeek：配置项、密钥引用是否配置（只判存在，不打印值）、`baseUrl` 是否命中出站白名单、HTTPS 443 连通性、最近一次成功作业；**不调用付费接口、不上传录音/转写** |
| `--json` / `--verbose` | false | 否 | 机器可读输出 / 调试日志 |

```text
feige doctor  v0.1.0

[PASS] config             配置文件可读，schema 校验通过
[PASS] token              本地 API token 存在且权限 0600
[PASS] api                127.0.0.1:8710 可达（12ms）
[WARN] db                 WAL 1.0 MB；建议 checkpoint
[PASS] account:main       state=online  jwt 剩余 5d 03:12
[WARN] account:shouji-1   state=expired（JWT 已过期）
       修复： feige account login shouji-1 --yes
[PASS] dial-window        开放（07:50–22:00 Asia/Shanghai）
[PASS] provider:minimax   provider=minimax model=asr-1.0 密钥已配置 出站可达 最近成功 ASR 10:04:01
[PASS] provider:deepseek  provider=deepseek model=deepseek-chat 升级=deepseek-v4-pro 密钥已配置 出站可达 最近成功分析 10:04:12
[WARN] provider:deepseek  24h 内 ANALYSIS_FAILED 3 次（2.1%）；检查 prompt/model/限流
[FAIL] audio-dir          目录不可写：~/.local/share/feige-outbound/audio
       修复： chmod 700 ~/.local/share/feige-outbound/audio
[SKIP] upstream           未加 --probe-upstream
[SKIP] providers          未加 --probe-providers

结果：4 pass · 3 warn · 1 fail（退出码 7） 耗时 1.4s
```

`--json` 的 `data`：

```jsonc
{
  "version": "0.1.0",
  "summary": { "pass": 4, "warn": 3, "fail": 1, "exitCode": 7 },
  "checks": [
    { "id": "config", "status": "pass", "message": "配置文件可读，schema 校验通过" },
    { "id": "provider:minimax", "status": "pass",
      "message": "provider=minimax model=asr-1.0 密钥已配置 出站可达 最近成功 ASR 10:04:01",
      "details": { "provider": "minimax", "baseUrl": "https://api.minimax.io", "model": "asr-1.0",
                    "keyConfigured": true, "egressAllowed": true, "reachable": true,
                    "lastSuccessAt": "2026-11-14T10:04:01+08:00" } },
    { "id": "provider:deepseek", "status": "warn",
      "message": "24h 内 ANALYSIS_FAILED 3 次（2.1%）",
      "fix": "检查 promptVersion/model/限流；必要时 feige calls reprocess --stage analysis" },
    { "id": "audio-dir", "status": "fail", "message": "目录不可写", "fix": "chmod 700 ..." }
  ]
}
```

- 检查内容（开启 `--probe-providers` 时）：
  - `provider:minimax`：`GET /config` 的 `pipeline.asr.provider/model/baseUrl`（v1 应为 `minimax` / `asr-1.0`）；本机 secrets（`minimaxApiKey`）或环境变量 `FOP_MINIMAX_API_KEY` 是否配置（**只判存在，不输出值**）；`baseUrl` 命中出站白名单（`api.minimax.io` / `api.minimax.cn`，[13 §9](./13-后处理规格（ASR与LLM）.md)）；HTTPS 443 可达；`GET /jobs?type=asr&status=succeeded&size=1` 的最近成功时间。
  - `provider:deepseek`：`pipeline.analysis.provider/model/escalateModel/promptVersion`（v1 应为 `deepseek` / `deepseek-chat` / `deepseek-v4-pro` / `analysis-v1`）；`deepseekApiKey` / `FOP_DEEPSEEK_API_KEY` 是否配置；`baseUrl` 命中白名单（`api.deepseek.com`）；HTTPS 443 可达；最近一次成功 analysis 作业与 24h 失败分布（失败率 >5% 给 warn）。
  - 密钥的**强有效性**由平台在真实 ASR/分析作业中验证；若从未有成功作业，doctor 给 `warn`（"尚未验证密钥有效性"）而非 fail。
- 退出码：`0` 全部通过；`4` 存在 warn；`7` 存在 fail；`8` 本地服务不可达；`2` 参数错误。
- 提示：provider 检查只读取配置/密钥存在性与公开端点连通性，**不发送录音/转写、不产生 token 费用**；后处理排障见 [13](./13-后处理规格（ASR与LLM）.md) 与 [10-部署与运维.md](./10-部署与运维.md)。

### 5.5 `feige mcp`

启动 MCP stdio server（server 名 `feige-outbound`）。完整契约见 [07-MCP工具契约.md](./07-MCP工具契约.md)。

```bash
feige mcp [--transport stdio] [--allow-write] [--print-config] [--log-level <level>]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--transport stdio` | `stdio` | 否 | v1 仅 stdio；其它值 → 退出码 `2` |
| `--allow-write` | false | 否 | 注册写操作工具（默认只读） |
| `--print-config` | false | 否 | 打印 MCP 客户端配置片段后退出 |
| `--log-level <l>` | `warn` | 否 | 日志一律 stderr；stdout 仅 JSON-RPC |

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

- 退出码：`0` stdin 正常关闭；`1` 启动失败；`2` 参数错误；`130` 被中断。
- 安全：默认只读；写工具需 `--allow-write` **且**调用参数 `confirm: true`（双闸，见 [07 §6](./07-MCP工具契约.md)）。

### 5.6 `feige completion`

```bash
feige completion <bash|zsh|fish|powershell>
```

```bash
feige completion bash > ~/.local/share/bash-completion/completions/feige
source ~/.local/share/bash-completion/completions/feige
feige calls <TAB>     # → list get detail transcript audio reprocess cancel events
```

- 未知 shell → 退出码 `2`。

### 5.7 `feige version`

```bash
feige version [--json]
```

```text
feige 0.1.0   api v1   mcp feige-outbound (stdio)   node 22.x
```

`--json` 的 `data`：`{ "version": "0.1.0", "apiVersion": "v1", "mcpServer": "feige-outbound", "protocol": "stdio" }`。

---

## 6. 账号命令 `feige account`

> REST 映射：[01 §4.1 #5–#12](./01-决策与约定.md)；DTO 见 [05 §2.2–2.4](./05-对外API契约.md) 与 [05 §5](./05-对外API契约.md)。
> **凭证安全**：不接受明文密码作为命令行参数；只用 `--password-stdin` / `--password-env`（避免进程列表泄漏）。

### 6.1 `feige account add <accountId>`

注册上游账号（`POST /accounts`，201）。`accountId` 为 slug（`^[a-z0-9][a-z0-9_-]{1,31}$`）；`displayName` 在 REST 为必填，CLI 省略时默认使用 `accountId`。

```bash
feige account add <accountId> --username <手机号> \
  (--password-stdin | --password-env <ENV>) \
  [--display-name <名>] [--concurrency <n>] [--browser-headless] \
  [--profile-dir-name <名>] [--metadata <k=v>]... [--dry-run]
```

| 短 | 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| | `--username <phone>` | — | 是 | 上游登录手机号（11 位），映射请求体 `username` |
| | `--password-stdin` | — | 二选一 | 从 stdin 读取密码（映射请求体 `password`，write-only） |
| | `--password-env <ENV>` | — | 二选一 | 从环境变量读取密码（推荐脚本） |
| | `--display-name <s>` | 同 accountId | 否 | 展示名（1–64 字符；REST 必填） |
| | `--concurrency <n>` | `1` | 否 | v1 回拨模式仅允许 1（其它值 REST 侧 `VALIDATION_FAILED`） |
| | `--browser-headless` | false | 否 | 登录浏览器是否 headless（映射 `browser.headless`） |
| | `--profile-dir-name <s>` | 同 accountId | 否 | 浏览器 profile 目录名（映射 `browser.profileDirName`） |
| | `--metadata <k=v>` | — | 否 | 自定义键值（≤10 个，值 ≤256 字符；可重复） |
| | `--dry-run` | false | 否 | 仅本地校验参数（slug/手机号/密码长度），不创建 |

```bash
read -rsp "上游密码: " PW && printf '%s' "$PW" | feige account add main \
  --username '138****0000' --password-stdin --display-name '主账号'
```

```text
✔ 账号已创建  main
  展示名      主账号
  上游手机    138****0000
  状态        unknown
  拨打模式    callback（回拨）
  下一步      feige account login main
```

`--json` 的 `data`（[05 §5.2](./05-对外API契约.md) 201）：

```jsonc
{
  "accountId": "main",
  "displayName": "主账号",
  "upstreamUsernameMasked": "156****0075",
  "enabled": true,
  "state": "unknown",
  "dialMode": "callback",
  "createdAt": "2026-11-14T10:00:00+08:00"
}
```

- 常见错误：`VALIDATION_FAILED`(2)、`CONFIG_INVALID`(2)、`UNAUTHORIZED`(6)、`INTERNAL_ERROR`(7)。
- 注册后不自动登录，需 `feige account login`。

### 6.2 `feige account list`

账号列表+健康摘要（`GET /accounts`，`data: AccountSummary[]` + 分页）。

```bash
feige account list [--enabled|--disabled] [--state <s>[,<s>...]] [--page <n>] [--size <n>] [--json]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--enabled` / `--disabled` | — | 否 | 过滤启用状态（映射 query `enabled`） |
| `--state <s>` | — | 否 | 逗号分隔，枚举 `online,expired,logging_in,error,disabled,unknown` |
| `--page` / `--size` | `1` / `20` | 否 | 分页（≤200 账号可 `--size 200`） |

```text
ACCOUNT     DISPLAY   STATE     JWT 到期              最近登录              24h 话单
main        主账号    online    2026-11-21T09:00:00   2026-11-14T09:00:00   12
shouji-1    手机1     expired   -                     2026-11-10T12:00:00   0

共 2 个账号 · page 1/1
```

`--json` 的 `data`（数组，字段见 [05 §2.2](./05-对外API契约.md)）：

```jsonc
[
  {
    "accountId": "main",
    "displayName": "主账号",
    "upstreamUsernameMasked": "156****0075",
    "upstreamUserId": "2083119985948770306",
    "dialMode": "callback",
    "line": { "lineId": "9", "lineName": "电信回拨", "mode": 1 },
    "enabled": true,
    "state": "online",
    "jwtExpiresAt": "2026-11-21T09:00:00+08:00",
    "lastLoginAt": "2026-11-14T09:00:00+08:00",
    "lastCheckedAt": "2026-11-14T10:00:00+08:00",
    "lastError": null,
    "stats": { "totalCalls": 1073, "calls24h": 12, "lastCallAt": "2026-11-14T09:59:00+08:00" },
    "createdAt": "2026-11-13T20:10:00+08:00",
    "updatedAt": "2026-11-14T10:00:00+08:00"
  }
]
```

- 错误：`UNAUTHORIZED`(6)、`INTERNAL_ERROR`(7)。

### 6.3 `feige account show <accountId>`

账号详情（`GET /accounts/{accountId}`，`data: AccountDetail`）。

```bash
feige account show <accountId> [--json]
```

```text
accountId    main
展示名       主账号
启用         true          拨打模式 callback
上游用户     2083119985948770306（宋* / 示例企业）
线路         电信回拨  lineId=9  mode=1
状态         online        JWT 2026-11-21T09:00:00+08:00
会话         wsConnected=true  cookieState=valid  最近 pong 10:00:00
并发         1
同步         最近 2026-11-14T09:59:30+08:00  滞后 30s
最近作业     job_...（analysis）succeeded、job_...（sync）succeeded
统计         话单 1073 / 24h 12 / 最近通话 2026-11-14T09:59:00+08:00
```

`--json` 的 `data`（[05 §2.3](./05-对外API契约.md)）：AccountSummary 全部字段 + `config{concurrency,browser{headless,profileDirMasked}}`、`session{state,jwtExpiresAt,wsConnected,cookieState,lastPongAt}`、`sync{lastSyncAt,cursorStartTime,lagSeconds,lastError}`、`recentJobs[]`。

- 错误：`ACCOUNT_NOT_FOUND`(3)、`UNAUTHORIZED`(6)。

### 6.4 `feige account update <accountId>`

更新账号（`PATCH /accounts/{accountId}`，`data: AccountDetail`）。v1 可改：展示名、启用状态、密码轮换、浏览器设置、metadata。

```bash
feige account update <accountId> [--display-name <s>] [--enable|--disable] \
  (--password-stdin | --password-env <ENV>) [--browser-headless|--browser-headful] \
  [--metadata <k=v>]... [--relogin]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--display-name <s>` | — | 否 | 展示名（1–64 字符） |
| `--enable` / `--disable` | — | 否 | 启用/停用（停用后停止调度与同步，保留数据） |
| `--password-stdin` / `--password-env` | — | 否 | 轮换上游密码（write-only）；修改后需重新登录 |
| `--browser-headless` / `--browser-headful` | — | 否 | 登录浏览器模式 |
| `--metadata <k=v>` | — | 否 | 覆盖/新增 metadata（可重复） |
| `--relogin` | false | 否 | 密码变更后立即触发重登（映射 query `relogin=true`） |

```text
✔ 已更新 main   displayName=主账号  enabled=true  browser.headless=false
```

- 常见错误：`ACCOUNT_NOT_FOUND`(3)、`VALIDATION_FAILED`(2)、`UNAUTHORIZED`(6)。

### 6.5 `feige account remove <accountId>`

移除本地账号（`DELETE /accounts/{accountId}`，204）。**默认保留历史话单/录音/转写**（标记 `deletedAt`）。`--purge-data` 级联删除数据，REST 要求 `confirm=PURGE:<accountId>`，CLI 自动填充并在 TTY 下要求输入 accountId 二次确认。

```bash
feige account remove <accountId> [--purge-data] [--dry-run] [--yes]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--purge-data` | false | 否 | 同时删除关联数据（不可恢复）；REST query `purgeData=true` + `confirm=PURGE:<accountId>` |
| `--dry-run` | false | 否 | 只显示账号与统计（来自 `account show`），不调用 DELETE |
| `--yes` | false | 非交互必填 | 跳过确认 |

```text
账号 main 将被移除；历史数据默认保留。
已有数据：话单 1073 条、24h 通话 12（--purge-data 将一并删除，且不可恢复）
确认移除？输入 yes 继续：
```

- 交互模式需输入 `yes`；`--purge-data` 还需再次输入 `accountId`；非交互必须 `--yes`（`--purge-data` 时 CLI 发送 `confirm=PURGE:main`）。
- 常见错误：`ACCOUNT_NOT_FOUND`(3)、`VALIDATION_FAILED`(2，confirm 不匹配)、`UNAUTHORIZED`(6)。

### 6.6 `feige account login <accountId>`

触发上游登录（`POST /accounts/{accountId}/login`）。REST **默认同步等待**（`wait=true`，最长 `timeoutMs`，默认 120000，范围 10000–300000）；`--async` 时 `wait=false` 返回 202 作业。

```bash
feige account login <accountId> [--async] [--timeout-ms <n>] [--force] [--idempotency-key <key>] [--yes]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--async` | false | 否 | 不等待（映射 `wait=false`，返回 202 + `loginJobId`/`pollUrl`） |
| `--timeout-ms <n>` | `120000` | 否 | 等待上限（10000–300000） |
| `--force` | false | 否 | 已有有效会话也强制重新登录（映射 `force`） |
| `--idempotency-key` | 自动 | 否 | 幂等键；登录中重复提交返回 409 `ACCOUNT_LOGIN_IN_PROGRESS` |
| `--yes` | false | 非交互必填 | 跳过确认 |

```text
⚠ 将使用账号 main 的上游凭证在浏览器中登录（可能触发滑块/风控；失败需人工）。
确认登录？输入 yes 继续：
```

成功（REST 200，wait=true）：

```text
✔ 登录成功  main
  state          online
  jwtExpiresAt   2026-11-21T10:00:00+08:00（7 天）
  loginJobId     job_01J8Z3K5T9QW2M4R7X1C6V0B8N
```

`--json` 的 `data`（[05 §5.6](./05-对外API契约.md)）：

```jsonc
// wait=true（200）
{ "accountId": "main", "state": "online", "loggedIn": true,
  "jwtExpiresAt": "2026-11-21T10:00:00+08:00", "loginJobId": "job_01J8Z3K5T9QW2M4R7X1C6V0B8N" }
// --async（202）
{ "loginJobId": "job_01J8Z3K5T9QW2M4R7X1C6V0B8N", "status": "queued",
  "pollUrl": "/api/v1/jobs/job_01J8Z3K5T9QW2M4R7X1C6V0B8N" }
```

- 常见错误：`ACCOUNT_NOT_FOUND`(3)、`ACCOUNT_LOGIN_IN_PROGRESS`(4，`details.loginJobId`)、`ACCOUNT_LOGIN_FAILED`(6，`details.reason=captcha_failed|bad_credentials|need_human`)、`UPSTREAM_UNREACHABLE`(5)、`INTERNAL_ERROR`(7，`details.needDisplay=true` 时需显示环境)、`RATE_LIMITED`(4)。

### 6.7 `feige account logout <accountId>`

清除本地会话（`POST /accounts/{accountId}/logout`，**204**；幂等），不注销上游账号。

```bash
feige account logout <accountId> [--yes]
```

```text
✔ 已退出本地会话  main（上游账号不受影响，历史数据保留）
```

`--json`：`{ "ok": true, "data": null, "meta": { ... } }`（204 无响应体，CLI 补空 data）。

- 错误：`ACCOUNT_NOT_FOUND`(3)、`INTERNAL_ERROR`(7)。

### 6.8 `feige account health <accountId>`

单账号健康（`GET /accounts/{accountId}/health`，`data: AccountHealth`；会触发上游探测，结果缓存 30s；**探测失败不报错**，返回 `data.upstream.reachable=false`）。

```bash
feige account health <accountId> [--json]
```

```text
账号 main            state=online
jwt                  有效  剩余 583200s  到期 2026-11-21T10:00:00+08:00
ws                   connected  最近 pong 10:00:00  47ms
上游                 reachable=true  180ms  checkedAt 2026-11-14T10:00:00+08:00
线路                 电信回拨 lineId=9 mode=1
拨打时段             开放 07:50–22:00 Asia/Shanghai
当前通话             inCall=false
```

`--json` 的 `data`（[05 §2.4/§5.8](./05-对外API契约.md)）：

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

- 错误：`ACCOUNT_NOT_FOUND`(3)、`UNAUTHORIZED`(6)。

---

## 7. 呼出与话单命令

### 7.1 `feige dial <toPhone>`

发起呼出（`POST /calls`，201 异步受理）——**写操作，有副作用与计费**。上游为回拨模式（先振铃坐席手机，见 [00 §6](./00-上游可行性侦察.md)）。

```bash
feige dial <toPhone> [--account <accountId>] [--customer-name <s>] \
  [--metadata <k=v>]... [--scheduled-at <iso>] [--idempotency-key <key>] \
  [--wait] [--wait-timeout <dur>] [--dry-run] [--yes]
```

| 短 | 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| | `<toPhone>` | — | 是 | 客户号码：大陆手机或固话（`^1[3-9]\d{9}$` / `^0\d{2,3}-?\d{7,8}$`）；`-` 表示从 stdin 读取 |
| | `--account <id>` | 自动 | 否 | 指定账号（多账号省略会 `VALIDATION_FAILED details.reason=account_required`） |
| | `--customer-name <s>` | — | 否 | 客户名（≤64 字符，落库） |
| | `--metadata <k=v>` | — | 否 | 自定义键值（≤10 个），随话单保存；可重复 |
| | `--scheduled-at <iso>` | — | 否 | 期望呼出时间（未来且在窗口内）；省略=立即 |
| | `--idempotency-key <k>` | 自动生成 | 否 | 幂等键；同 key 重复调用 24h 内返回首单（[01 §5.6](./01-决策与约定.md)） |
| | `--wait` | false | 否 | CLI 侧轮询 `calls get` 直到接通/终态或超时（非 REST 参数） |
| | `--wait-timeout <dur>` | `180s` | 否 | `--wait` 超时；退出码 `9`，话单仍在后台跟踪 |
| | `--dry-run` | false | 否 | 映射 REST `dryRun:true`：只做校验、返回计划，**不产生 Call** |
| | `--yes` | false | 非交互必填 | 跳过确认 |

交互确认（TTY）：

```text
⚠ 即将发起外呼（有副作用/计费）
  号码     138****0000
  账号     main（回拨模式，先振铃坐席手机，需人工接听）
  时段     07:50–22:00 开放中
  幂等键   dial-20261114-001（重试请复用；勿对同一号码盲目重拨）
确认呼出？输入 yes 继续：
```

输出示例（受理）：

```text
✔ 呼出已受理
  callId     call_01J8Z3K5T9QW2M4R7X1C6V0B8N
  号码       138****0000
  账号       main
  状态       pending（等待调度）
  幂等键     dial-20261114-001
```

`--json` 的 `data`（201，`CallSummary`，[05 §6.1](./05-对外API契约.md)）：

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

`--dry-run` 输出（REST 200）：

```text
预检通过（未产生话单）
  willDial      true
  账号          main
  号码          138****0000
  时段          开放（07:50–22:00 Asia/Shanghai）
  警告          number_exists_in_crm（不阻断）
```

`--json`（dry-run）的 `data`：

```jsonc
{
  "dryRun": true, "willDial": true, "accountId": "main", "to": "138****0000",
  "dialWindow": { "open": true, "windowStart": "07:50", "windowEnd": "22:00", "timezone": "Asia/Shanghai" },
  "warnings": ["number_exists_in_crm"], "estimatedCost": null
}
```

- 常见错误：`INVALID_REQUEST`(2)、`VALIDATION_FAILED`(2，号码/accountId/metadata/scheduledAt)、`ACCOUNT_NOT_FOUND`(3)、`ACCOUNT_DISABLED`(4)、`ACCOUNT_BUSY`(4)、`ACCOUNT_LOGIN_REQUIRED`(6)、`IDEMPOTENCY_CONFLICT`(4)、`CALL_OUTSIDE_DIAL_WINDOW`(4，`retryAfter` 给下个窗口)、`CALL_NOT_DIALABLE`(4)、`UPSTREAM_BUSINESS_ERROR`(5)、`UPSTREAM_AUTH_EXPIRED`(5)、`UPSTREAM_UNREACHABLE`(5)。
- **防重**：同 `accountId+to` 在 `limits.dialCooldownMs`（默认 60s）内重复请求会被拒（[01 §5.7](./01-决策与约定.md)）；重试必须复用 `--idempotency-key`。

### 7.2 `feige calls list`

话单列表（`GET /calls`，`data: CallSummary[]` + 分页，默认 `sort=-createdAt`）。

```bash
feige calls list [--account <id>] [--status <s>[,<s>...]] \
  [--pipeline <stage:status>] [--has-audio|--no-audio] [--has-transcript|--no-transcript] \
  [--to <phone>] [--q <text>] [--from-date <YYYY-MM-DD>] [--to-date <YYYY-MM-DD>] \
  [--date <YYYY-MM-DD>] [--sort <field>] [--page <n>] [--size <n>] [--no-pipeline] [--json]
```

| 短 | 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| | `--account <id>` | 全部 | 否 | 账号过滤（多账号可逗号分隔，映射 `accountId`） |
| | `--status <s>` | 全部 | 否 | 逗号分隔，枚举 Call status（[01 §6.1](./01-决策与约定.md)） |
| | `--pipeline <stage:status>` | — | 否 | 按流水线阶段过滤（如 `transcript:ready`），可重复 |
| | `--has-audio` / `--no-audio` | — | 否 | 映射 `hasAudio` |
| | `--has-transcript` / `--no-transcript` | — | 否 | 映射 `hasTranscript` |
| | `--to <phone>` | — | 否 | 被叫号码（支持后 4 位模糊，如 `*1234`） |
| | `--q <text>` | — | 否 | 全文搜索：客户名/号码/转写（≤64 字符） |
| | `--from-date` / `--to-date` | — | 否 | `startedAt` 日期区间（含端点，Asia/Shanghai；映射 REST `dateFrom`/`dateTo`） |
| | `--date <YYYY-MM-DD>` | — | 否 | 单日快捷方式（等价 `--from-date D --to-date D`） |
| | `--sort <field>` | `-createdAt` | 否 | 允许 `createdAt`/`dialedAt`/`endedAt`/`durationSec`，`-` 降序 |
| | `--page` / `--size` | `1` / `20` | 否 | `size ≤ 100` |
| | `--no-pipeline` | false | 否 | 映射 `includePipeline=false`（减少体积） |

```bash
feige calls list --date 2026-11-14 --status ended,no_answer --size 5
```

```text
CALLID                 TO            STATUS      DURATION  CREATED AT
call_01J8Z3K5T9...B8N  186****3330   ended       15s       2026-11-14 10:03
call_01J8ZAK5T9Q...C1D  139****7788   ended       62s       2026-11-14 09:41
call_01J8ZB45T9Q...D2E  137****1122   no_answer   -         2026-11-14 09:12
...
共 1073 条 · page 1/54 · size 5
```

`--json` 的 `data`（数组；[05 §6.2](./05-对外API契约.md)）：

```jsonc
{
  "ok": true,
  "data": [
    {
      "callId": "call_01J8Z3K5T9QW2M4R7X1C6V0B8N",
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
      "updatedAt": "2026-11-14T10:30:00+08:00"
    }
  ],
  "meta": { "requestId": "req_...", "ts": "2026-11-14T10:05:00+08:00",
            "pagination": { "page": 1, "size": 20, "total": 1073, "totalPages": 54 } }
}
```

- 错误：`VALIDATION_FAILED`(2)、`UNAUTHORIZED`(6)、`DB_UNAVAILABLE`(7)。

### 7.3 `feige calls get <callId>`

单通话单摘要（`GET /calls/{callId}`，`data: CallSummary`，即 `Dial Status`）。

```bash
feige calls get <callId> [--json]
```

```text
callId     call_01J8Z3K5T9QW2M4R7X1C6V0B8N
状态       ended（已结束且接通）
号码       186****3330（客户，河北 衡水）  ←  156****0075（坐席，北京 北京）
账号       main    线路 电信回拨 lineId=9
拨号       2026-11-13T16:27:58+08:00
接通       2026-11-13T16:27:58+08:00
结束       2026-11-13T16:28:13+08:00   时长 15s   话费 ¥0.14
流水线     audio ready · transcript ready · analysis ready
录音       已归档  转写预览 "喂。喂，李总，你好。嗯。…"
```

`--json` 的 `data`：`CallSummary`（字段见 [05 §2.5](./05-对外API契约.md)，与 §7.2 单项一致）。

- 错误：`CALL_NOT_FOUND`(3)、`UNAUTHORIZED`(6)。

### 7.4 `feige calls detail <callId>`

单通话单详情+流水线（`GET /calls/{callId}/detail`，`data: CallDetail`）。

```bash
feige calls detail <callId> [--include-raw] [--include-events] [--json]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--include-raw` | false | 否 | 映射 query `includeRaw=true`（返回上游原始对象，体积大） |
| `--include-events` | false | 否 | 映射 query `includeEvents=true`（内联最近 50 条事件） |

```text
call   call_01J8Z3K5T9QW2M4R7X1C6V0B8N   ended   15s   ¥0.14
上游   callStatus=已接通  finishStatus=其他  callType=1  interfaceId=9 电信回拨
时间线 created 16:27:53 → dialing 16:27:56 → connected 16:27:58 → ended 16:28:13
录音   ready   aud_01J8Z...  481,964 B  15,060 ms  sha256=ab12…  16kHz/mono
转写   ready   tr_01J8Z...  source=asr  provider=minimax:asr-1.0  7 段 / 1 块  needsReview=false
分析   ready   ana_01J8Z...  模型 deepseek-chat  prompt=analysis-v1  摘要 "客户为外贸公司负责人，对客户管理系统有初步兴趣。"  intent=medium
事件   6 条（--include-events 可内联）
```

`--json` 的 `data`（[05 §2.9/§6.4](./05-对外API契约.md)）：CallSummary 全部字段 + `upstream{}`、`timeline{createdAt,submittedAt?,dialingAt,connectedAt,endedAt}`、`pipelineDetail{audio{status,audioId,downloadedAt,lastError},transcript{status,transcriptId,source:"asr",provider,chunkCount,needsReview,generatedAt,lastError},analysis{status,analysisId,generatedAt,lastError}}`、`recording{available,downloadUrl,format,durationMs,sizeBytes,sha256,sampleRate,channels}`、`transcript{available,source:"asr",segmentCount,needsReview,url}`、`analysis{available,analysisId,summary,intent,url}`、`eventsCount`、`metadata`（`--include-events` 时另有 `events[]`）。完整 `AnalysisPayload`（含 `promptVersion` / `usage` / `speakerMapping.needsReview`）字段定义见 [05 §2.9](./05-对外API契约.md)，`--json` 原样透传。

- 错误：`CALL_NOT_FOUND`(3)、`UNAUTHORIZED`(6)、`DB_UNAVAILABLE`(7)。

### 7.5 `feige calls transcript <callId>`

转写全文+分段（`GET /calls/{callId}/transcript`，`data: TranscriptPayload`）。REST 的 `format` v1 固定 `json`；CLI 的文本/markdown/srt 格式为**客户端渲染**（不改变 REST 契约）。

```bash
feige calls transcript <callId> [--include-analysis] [--format <text|markdown|srt|json>] \
  [--role <agent|customer|unknown>] [--out <path|->] [--force] [--json]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--include-analysis` | false | 否 | 映射 query `includeAnalysis=true`（附带 AI 后处理结果） |
| `--format <f>` | `text` | 否 | `json` = REST 原样；`text`/`markdown`/`srt` 由 CLI 渲染 |
| `--role <r>` | 全部 | 否 | 仅输出某说话人（客户端过滤） |
| `--out <path>` | — | 否 | 写入文件（`-` 表示 stdout）；默认不覆盖已有文件 |
| `--force` | false | 否 | 允许覆盖 `--out` 目标 |

```bash
feige calls transcript call_01J8Z3K5T9QW2M4R7X1C6V0B8N
```

```text
[00:00.83] 坐席  喂，李总，你好。
[00:02.23] 客户  喂。
[00:03.10] 坐席  我是看你们那边最近在做出海业务……
...
（7 段 · source=asr · provider=minimax:asr-1.0 · 1 块 · 已词表归一）
```

`--json` 的 `data`（[05 §2.9](./05-对外API契约.md)）：

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

- 说明：v1 转写由**本地 ASR（MiniMax `asr-1.0`）**生成，`source` 固定 `asr`、`provider` 形如 `minimax:asr-1.0`；`channel` 仅在双声道拆分路径有值，单声道路径为 `null`；`speakerLabel` 为 ASR 匿名标签（`S1`/`S2`…，块内有效）；长通话按 420s 静音点切块，`chunkIndex` 为块序号。`emotionValue`/`speechRate`/`silenceBeforeMs` 为 v1 预留字段（恒 `null`，可忽略）。
- 错误：`CALL_NOT_FOUND`(3)、`TRANSCRIPT_NOT_AVAILABLE`(4，未接通/无有效语音或本地 ASR 无法产出)、`TRANSCRIPT_PENDING`(4，`details.stage=asr_queued|asr_running|role_mapping|analysis`)、`NOT_FOUND`(3，`version` 不存在)、`DB_UNAVAILABLE`(7)。
- 提示：先查 `detail` 的 `pipeline.transcript`，`ready` 后再取转写可避免 409；ASR 作业失败记录在同话单 `feige jobs list --call <callId>` 的 `lastError.code=ASR_FAILED`。

### 7.6 `feige calls audio <callId>`

原始录音下载（`GET /calls/{callId}/audio`，二进制 `audio/wav`，支持 Range）。

```bash
feige calls audio <callId> [--out <path|->] [--attachment] [--json]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--out <path>` | `./<callId>.wav` | 否 | 输出文件；`-` 表示二进制写 stdout（此时禁止 `--json`） |
| `--attachment` | false | 否 | 映射 query `download=true`（响应带 `Content-Disposition: attachment`） |
| `--json` | false | 否 | 下载后输出封套（不打印二进制） |

```bash
feige calls audio call_01J8Z3K5T9QW2M4R7X1C6V0B8N --out ./recordings/
# → ./recordings/call_01J8Z3K5T9QW2M4R7X1C6V0B8N.wav

feige calls audio call_01J8Z... --out - | ffprobe -
```

`--json` 的 `data`（由响应头 `Content-Length`/`ETag`(sha256) 推导）：

```jsonc
{ "callId": "call_01J8Z3K5T9QW2M4R7X1C6V0B8N", "outputPath": "./recordings/call_01J8Z3K5T9QW2M4R7X1C6V0B8N.wav",
  "sizeBytes": 481964, "sha256": "ab12...", "contentType": "audio/wav" }
```

> 完整录音元数据（时长/采样率/声道/下载 URL）在 `feige calls detail` 的 `recording` 字段（[05 §6.4](./05-对外API契约.md)）。

- 错误：`CALL_NOT_FOUND`(3)、`AUDIO_NOT_AVAILABLE`(4，未接通/上游缺失)、`AUDIO_NOT_READY`(4，下载中，`Retry-After: 10`)、`NOT_FOUND`(3，DB 有记录但磁盘文件丢失)。
- 隐私：录音含个人信息，落盘后须按 [11-安全与合规.md](./11-安全与合规.md) 保护，禁止外传。

### 7.7 `feige calls reprocess <callId>`

重跑流水线阶段（`POST /calls/{callId}/reprocess`，202；幂等；不改变 `Call.status`；同一 call 同时只允许一个 reprocess 作业）。`transcript` = 重跑本地 ASR（MiniMax）→ 角色映射 → 词表归一；`analysis` = 重跑 DeepSeek 后处理（默认当前 `promptVersion`）。**有成本副作用**（ASR/LLM token 消耗，见 [13 §3.4/§6.4](./13-后处理规格（ASR与LLM）.md)）。

```bash
feige calls reprocess <callId> --stage <audio|transcript|analysis>[,...] \
  [--force] [--asr-model <m>] [--analysis-model <m>] [--prompt-version <v>] [--term-rules-version <v>] \
  [--idempotency-key <k>] [--dry-run] [--wait] [--wait-timeout <dur>] [--yes]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--stage <s>` | — | **是** | 逗号分隔/可重复，枚举 `audio,transcript,analysis`（REST 要求 `stages` 非空；`analysis` 隐含需要 transcript） |
| `--force` | false | 否 | 忽略已 `ready` 状态强制重跑（映射 `force`） |
| `--asr-model <m>` | 当前配置 | 否 | 映射 `options.asrModel`（如 `asr-1.0`） |
| `--analysis-model <m>` | 当前配置 | 否 | 映射 `options.analysisModel`（如 `deepseek-chat` / `deepseek-v4-pro`） |
| `--prompt-version <v>` | 当前配置 | 否 | 映射 `options.promptVersion`（如 `analysis-v1`；配合 analysis 重跑） |
| `--term-rules-version <v>` | 当前版本 | 否 | 映射 `options.termRulesVersion`（词表版本/快照） |
| `--idempotency-key <k>` | 自动 | 否 | 幂等键 |
| `--dry-run` | false | 否 | CLI 本地预览：读取 `calls detail` 的流水线状态，列出将重跑阶段与预计成本（ASR 时长/LLM 输入规模），**不发 POST** |
| `--wait` | false | 否 | 轮询 `jobs get` 至作业结束（非 REST 参数） |
| `--wait-timeout <dur>` | `600s` | 否 | `--wait` 超时 |
| `--yes` | false | 非交互必填 | 跳过确认 |

```bash
feige calls reprocess call_01J8Z3K5T9QW2M4R7X1C6V0B8N --stage transcript --yes
```

```text
✔ 已受理重跑
  callId  call_01J8Z3K5T9QW2M4R7X1C6V0B8N
  阶段    transcript（本地 ASR：MiniMax asr-1.0 → 角色映射 → 词表归一）
  jobId   job_01J8Z3K5T9QW2M4R7X1C6V0B8N
  pollUrl /api/v1/jobs/job_01J8Z3K5T9QW2M4R7X1C6V0B8N
```

```bash
feige calls reprocess call_01J8Z... --stage analysis \
  --analysis-model deepseek-v4-pro --force --yes
# → analysis（DeepSeek deepseek-v4-pro，prompt=analysis-v1）；token 用量记录在 AnalysisPayload.usage
```

`--json` 的 `data`（202）：

```jsonc
{ "jobId": "job_01J8Z3K5T9QW2M4R7X1C6V0B8N", "callId": "call_01J8Z3K5T9QW2M4R7X1C6V0B8N",
  "stages": ["transcript"], "status": "queued",
  "pollUrl": "/api/v1/jobs/job_01J8Z3K5T9QW2M4R7X1C6V0B8N" }
```

- 常见错误：`CALL_NOT_FOUND`(3)、`VALIDATION_FAILED`(2，stages 为空/非法)、`CALL_ALREADY_TERMINAL`(4)、`RATE_LIMITED`(4，`details.reason=reprocess_in_progress`)、`UNAUTHORIZED`(6)。
- 作业内阶段失败不改变 202 受理结果，以 `job.lastError.code` 暴露：`ASR_FAILED`（ASR 鉴权/限流/格式/超时，retryable=true）或 `ANALYSIS_FAILED`（JSON 校验/超时/限流，retryable=true）；累计 5 次失败后该阶段置 `failed`，可再次 `reprocess`（[13 §7](./13-后处理规格（ASR与LLM）.md)）。
- 幂等：相同阶段作业已存在时返回已有 `jobId`（`meta.idempotencyReplayed=true`）；`--wait` 超时后请用 `jobs get` 续查，勿重复提交。

### 7.8 `feige calls cancel <callId>`

取消**尚未提交上游**的呼出（`POST /calls/{callId}/cancel`，200，`data: CallSummary` status=`canceled`）。仅 `pending` 可取消。

```bash
feige calls cancel <callId> [--yes]
```

```text
✔ 已取消  call_01J8Z3K5T9QW2M4R7X1C6V0B8N（pending → canceled）
```

- 错误：`CALL_NOT_FOUND`(3)、`CALL_NOT_CANCELABLE`(4，`dialing`+ 不可取消，上游无取消接口)、`CALL_ALREADY_TERMINAL`(4)。

### 7.9 `feige calls events <callId>`

单通话单事件时间线（`GET /calls/{callId}/events`，`data: EventRecord[]` + 分页，排序固定 `occurredAt asc`）；`--follow` 走 SSE（`GET /events/stream?callId=`）。

```bash
feige calls events <callId> [--types <t1,t2>] [--page <n>] [--size <n>] \
  [--follow] [--duration <dur>] [--json]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--types <t>` | 全部 | 否 | 逗号分隔事件类型（支持 `call.*`） |
| `--page` / `--size` | `1` / `50` | 否 | `size ≤ 200` |
| `--follow` | false | 否 | 持续跟随新事件（SSE，按 callId 过滤；Ctrl-C 退出 `130`） |
| `--duration <dur>` | 无限 | 否 | `--follow` 最长跟随时间，到期退出 `0` |

```text
$ feige calls events call_01J8Z3K5T9QW2M4R7X1C6V0B8N
10:03:00  call.created           pending
10:03:02  call.dialing           dialing   upstreamCallId=2121158093386702849
10:03:12  call.connected         connected answeredAt=2026-11-14T10:03:12+08:00
10:03:27  call.ended             ended     durationSec=15
10:03:29  call.audio.ready       ready     sizeBytes=481964 durationMs=15060
10:04:01  call.transcript.ready  ready     source=asr provider=minimax:asr-1.0 segmentCount=7 needsReview=false
```

`--json` 的 `data`（数组，EventRecord 见 [05 §2.12](./05-对外API契约.md)）：

```jsonc
[ { "eventId": "evt_01J8Z3K5T9QW2M4R7X1C6V0B8P", "type": "call.connected",
    "occurredAt": "2026-11-14T10:03:12+08:00", "accountId": "main",
    "callId": "call_01J8Z3K5T9QW2M4R7X1C6V0B8N",
    "data": { "answeredAt": "2026-11-14T10:03:12+08:00" } } ]
```

- 错误：`CALL_NOT_FOUND`(3)、`UNAUTHORIZED`(6)。

---

## 8. 同步 / 作业 / 事件 / 词表 / 配置 / 文本

### 8.1 `feige sync [start]`

触发同步（`POST /sync`，202 异步作业）。`start` 为可选子命令（等价 `feige sync`）。

```bash
feige sync [--account <id>] [--mode incremental|full|backfill] [--from <date>] [--to <date>] \
  [--wait] [--wait-timeout <dur>] [--idempotency-key <k>]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--account <id>` | 全部启用账号 | 否 | 仅同步指定账号 |
| `--mode <m>` | `incremental` | 否 | `incremental`/`full`/`backfill`（REST `mode` 必填，CLI 默认 incremental） |
| `--from` / `--to` | — | 否 | `backfill` 专用日期区间（`YYYY-MM-DD`）；其它模式传了会 `VALIDATION_FAILED` |
| `--wait` | false | 否 | 映射 REST `wait=true`（同步等待作业结束） |
| `--wait-timeout <dur>` | `300s` | 否 | 映射 `timeoutMs`（≤600000） |
| `--idempotency-key` | 自动 | 否 | 幂等键（同参数 10s 内重复触发会合并为同一作业） |

```bash
feige sync --account main --mode incremental --wait
```

```text
✔ 同步完成  main  incremental
  fetched 812  upserted 798  skipped 0  failed 0  duration 6.4s
```

`--json`（202 受理；[05 §7.1](./05-对外API契约.md)）：

```jsonc
{ "jobId": "job_01J8Z3K5T9QW2M4R7X1C6V0B8N", "type": "sync", "mode": "incremental",
  "accountId": null, "status": "queued", "pollUrl": "/api/v1/jobs/job_01J8Z3K5T9QW2M4R7X1C6V0B8N" }
```

`--wait` 完成后（200）`data` 为 `JobDetail`，含 `result{ fetched, upserted, skipped, failed }`。

- **全量回补（`--full`）**：`--full` 同步完成后，平台对历史话单排队执行后处理（本地 ASR → DeepSeek analysis，[13 §3.4/§7](./13-后处理规格（ASR与LLM）.md)）；**不设预算上限**，但每次调用记录 token/耗时（`AnalysisPayload.usage`，[13 §6.4](./13-后处理规格（ASR与LLM）.md)）。
- 回补可观测：`feige jobs list --type asr,analysis --status queued,running` 看进度与失败分布；`feige calls detail <callId>` 看单通阶段状态；建议先 `feige doctor --probe-providers` 确认 MiniMax/DeepSeek 可用。
- 常见错误：`VALIDATION_FAILED`(2)、`ACCOUNT_NOT_FOUND`(3)、`ACCOUNT_LOGIN_REQUIRED`(6，`details.accounts[]`)、`UPSTREAM_UNREACHABLE`(5)、`UNAUTHORIZED`(6)。
- 同步对上游为只读操作，可安全重试；`full`/`backfill` 代价高，非必要时用 `incremental`。

### 8.2 `feige sync status`

最近同步作业（`GET /sync`，`data: JobSummary[]` + 分页）。

```bash
feige sync status [--account <id>] [--status <s>] [--page <n>] [--size <n>] [--json]
```

```text
JOBID                  MODE         STATUS     ACCOUNT   RESULT                    FINISHED AT
job_01J8Z3K5T9...B8N   incremental  succeeded  main      fetched 812/upserted 798  10:06:12
job_01J8ZAK5T9Q...C1D  incremental  succeeded  shouji-1  fetched 120/upserted 118  10:05:02
```

- `--json` 的 `data`：`JobSummary[]`（字段见 [05 §2.7](./05-对外API契约.md)）。

### 8.3 `feige jobs list`

全部后台作业（`GET /jobs`，`data: JobSummary[]` + 分页，默认 `sort=-createdAt`）。

```bash
feige jobs list [--type <t>[,<t>...]] [--status <s>] [--account <id>] [--call <callId>] \
  [--page <n>] [--size <n>] [--sort <field>] [--json]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--type <t>` | 全部 | 否 | 逗号分隔；枚举 Job type：`login`/`sync`/`audio_fetch`/`asr`/`analysis`/`reprocess`/`backfill`（[01 §6.1](./01-决策与约定.md)；v1 已删除旧的上游转写作业类型） |
| `--status <s>` | 全部 | 否 | 枚举 `queued,running,succeeded,failed,canceled` |
| `--account` / `--call` | — | 否 | 关联过滤 |
| `--page` / `--size` | `1` / `20` | 否 | `size ≤ 100` |
| `--sort <field>` | `-createdAt` | 否 | 允许字段以 05 为准 |

```text
JOBID                  TYPE               STATUS     CALL/ACCOUNT          ATTEMPTS  UPDATED AT
job_01J8Z3K5T9...B8N   asr                running    call_01J8Z...B8N      1/5       10:04:01
job_01J8ZAK5T9Q...C1D  analysis           queued     call_01J8ZAK...C1D    0/5       10:04:02
job_01J8ZB45T9Q...D2E  sync               succeeded  main                  1/3       10:06:12
```

### 8.4 `feige jobs get <jobId>`

作业详情（`GET /jobs/{jobId}`，`data: JobDetail`；同步作业亦可 `GET /sync/{jobId}`）。对应 [01 §4.1 #24/#26](./01-决策与约定.md)。

```bash
feige jobs get <jobId> [--wait] [--wait-timeout <dur>] [--json]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--wait` | false | 否 | CLI 侧轮询直到作业结束（非 REST 参数） |
| `--wait-timeout <dur>` | `300s` | 否 | `--wait` 超时返回 `9`，作业可能在后台继续 |

```text
jobId     job_01J8Z3K5T9QW2M4R7X1C6V0B8N
type      asr
status    running   attempts 1/5
call      call_01J8Z3K5T9QW2M4R7X1C6V0B8N
进度      ASR 分块处理中（current 42 / total 600 unit=s）
最近错误  -
```

`--json` 的 `data`（[05 §2.7](./05-对外API契约.md)）：`JobSummary` + `payload`（脱敏）+ `result` + `logs[]`。

- 错误：`JOB_NOT_FOUND`(3)、`UNAUTHORIZED`(6)。

### 8.5 `feige events`

事件历史（`GET /events`，`data: EventRecord[]` + 分页）与实时流（`--follow` → `GET /events/stream`）。

```bash
feige events [--types <t1,t2>] [--call <callId>] [--account <id>] \
  [--since <iso>] [--until <iso>] [--page <n>] [--size <n>] [--sort <field>] \
  [--follow] [--last-event-id <eventId>] [--duration <dur>] [--json]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--types <t>` | 全部 | 否 | 逗号分隔，支持通配（`call.*,account.*`，[01 §7.3](./01-决策与约定.md)） |
| `--call` / `--account` | — | 否 | 关联过滤 |
| `--since` / `--until` | — | 否 | `occurredAt` 时间区间（ISO 8601） |
| `--page` / `--size` | `1` / `50` | 否 | `size ≤ 200` |
| `--sort` | `-occurredAt` | 否 | 仅时间排序 |
| `--follow` | false | 否 | SSE 持续跟随（等价 `GET /events/stream`） |
| `--last-event-id <id>` | — | 否 | 断点续传（SSE `Last-Event-ID`，[01 §7.3](./01-决策与约定.md)） |
| `--duration <dur>` | 无限 | 否 | `--follow` 最长时长，到期退出 `0` |

```bash
$ feige events --types 'call.*' --follow --duration 60s
10:03:12  call.connected  call_01J8Z...B8N  main
10:03:27  call.ended      call_01J8Z...B8N  main  durationSec=15
10:04:01  call.transcript.ready call_01J8Z...B8N source=asr
```

- `--json`：历史查询为 `EventRecord[]` + `meta.pagination`；`--follow` 时每行一条事件封套，可直接 `jq -c`。
- 错误：`VALIDATION_FAILED`(2)、`UNAUTHORIZED`(6)。

### 8.6 `feige term list`

词表规则列表（`GET /terms`，`data: TermRule[]` + 分页；`from` 为**变体数组**）。

```bash
feige term list [--q <text>] [--category <c>] [--enabled|--disabled] \
  [--page <n>] [--size <n>] [--json]
```

```text
TERMID                  FROM                 TO       CATEGORY  PRIORITY  ENABLED
term_01J8Z3K5T9...B8Q   复萌,福梦,复盟        孚盟      company   100       true
term_01J8ZAK5T9Q...C1D  fumasoft,FumaSoft    孚盟      product   90        true
```

### 8.7 `feige term add`

新增单条规则（`POST /terms`，201，`data: TermRule`）。

```bash
feige term add --from <词> [--from <词>]... --to <归一> \
  [--category <company|product|person|custom>] [--priority <n>] \
  [--note <s>] [--case-sensitive] [--disabled]
```

```bash
feige term add --from 复萌 --from 福梦 --from 复盟 --to 孚盟 --category company
# ✔ 已新增词表规则 term_01J8Z3K5T9QW2M4R7X1C6V0B8Q  [复萌,福梦,复盟] → 孚盟  priority=100
```

`--json` 的 `data`：`TermRule`（`termId/from[]/to/category/priority/enabled/caseSensitive/note/createdAt/updatedAt`）。

- 常见错误：`VALIDATION_FAILED`(2，空词/冲突/`to` 出现在自身 `from` 中)、`UNAUTHORIZED`(6)。

### 8.8 `feige term update <termId>`

```bash
feige term update <termId> [--from <词>]... [--to <归一>] [--category <c>] \
  [--priority <n>] [--note <s>] [--enable|--disable] [--case-sensitive]
```

```text
✔ 已更新 term_01J8Z...B8Q  [复萌,福梦,复盟] → 孚盟  category=company  priority=120  enabled=true
```

- 错误：`TERM_NOT_FOUND`(3)、`VALIDATION_FAILED`(2)。

### 8.9 `feige term remove <termId>`

```bash
feige term remove <termId> [--yes]
```

```text
✔ 已删除词表规则 term_01J8Z...B8Q（复萌,福梦,复盟 → 孚盟）
```

- `--json`：204 → `{ "ok": true, "data": null, "meta": {...} }`。
- 错误：`TERM_NOT_FOUND`(3，重复删除返回 404)；非交互需 `--yes`。

### 8.10 `feige term import <file|->`

全量替换词表（`PUT /terms`，请求体 `{ "rules": TermRuleInput[], "mode": "replace" }`，响应 `data: { count, version }`）——**危险操作**：原子替换，未出现的旧规则被删除。

```bash
feige term import <terms.json|terms.csv|-> [--format json|csv] [--dry-run] [--yes]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `<file>` 或 `-` | — | 是 | 文件路径或 `-`（stdin） |
| `--format <f>` | 按扩展名推断 | 否 | 输入格式 |
| `--dry-run` | false | 否 | CLI 本地 diff：先 `GET /terms` 全量，再与导入文件比较，输出 diff，**不发 PUT** |
| `--yes` | false | 非交互必填 | 跳过确认（全量替换会删除未出现的旧规则） |

输入示例（JSON）：

```jsonc
{
  "rules": [
    { "from": ["复萌", "福梦", "复盟"], "to": "孚盟", "category": "company", "priority": 100, "enabled": true },
    { "from": ["fumasoft", "FumaSoft"], "to": "孚盟", "category": "product", "priority": 90, "caseSensitive": true }
  ]
}
```

`--dry-run` 输出：

```text
词表导入预检（未写入）
  + 新增 2 条
  ~ 修改 1 条（term_01J8Z...B8Q priority 90 → 100）
  - 删除 2 条（未出现在导入文件中）
确认全量替换？输入 yes 继续：
```

`--json`（PUT 成功）：

```jsonc
{ "count": 42, "version": "2026-11-14T10:00:00+08:00" }
```

- 错误：`VALIDATION_FAILED`(2，`details.fields[]` 指出第几条规则哪项非法)、`UNAUTHORIZED`(6)。

### 8.11 `feige config get`

生效配置（`GET /config`，`data: Config`；密钥字段脱敏）。

```bash
feige config get [--key <dot.path>] [--json]
```

```bash
feige config get --key dial
# dial.windowStart=07:50  dial.windowEnd=22:00  dial.timezone=Asia/Shanghai  dial.scheduleOutsideWindow=true

feige config get --key pipeline
# pipeline.asr.provider=minimax  pipeline.asr.model=asr-1.0  pipeline.asr.chunkSeconds=420  pipeline.asr.concurrency=4
# pipeline.analysis.provider=deepseek  pipeline.analysis.model=deepseek-chat
# pipeline.analysis.escalateModel=deepseek-v4-pro  pipeline.analysis.promptVersion=analysis-v1
# pipeline.roleMapping.method=auto  pipeline.roleMapping.llmVerify=true
```

`--json` 的 `data`：完整 Config（结构见 [05 §2.13](./05-对外API契约.md)：`server/storage/browser/dial/limits/sync/pipeline/events`；`pipeline` 为嵌套 `asr` / `analysis` / `roleMapping` 结构，**不再有**旧的扁平 provider 字段（v1 已改为嵌套 `pipeline.asr` / `pipeline.analysis`））；`--key` 为 CLI 客户端过滤（不改变 REST 响应）。密钥（`minimaxApiKey` / `deepseekApiKey`）不属于 Config，存 secrets 文件/环境变量，接口不返回。

### 8.12 `feige config set <key=value>...`

局部更新配置（`PATCH /config`，JSON Merge Patch；响应 `data` = 完整 Config + `restartRequired`）。

```bash
feige config set <key=value>... [--file <patch.json>] [--dry-run] [--yes]
```

| 长 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `<key=value>` | — | 是（或 `--file`） | 点路径赋值，如 `dial.windowEnd=21:30`；CLI 组装为嵌套对象 |
| `--file <patch.json>` | — | 否 | 直接提供 Merge Patch JSON（`-` 表示 stdin） |
| `--dry-run` | false | 否 | CLI 本地 diff：`GET /config` 与 patch 比较后输出 diff，**不发 PATCH** |
| `--yes` | false | 非交互必填 | 跳过确认 |

```bash
feige config set pipeline.analysis.model=deepseek-v4-pro pipeline.asr.concurrency=6 --dry-run
```

```text
配置变更（未应用）
  pipeline.analysis.model      deepseek-chat → deepseek-v4-pro
  pipeline.asr.concurrency     4 → 6
确认应用？输入 yes 继续：
```

- 校验要点（[05 §4.4](./05-对外API契约.md) / [01 §9](./01-决策与约定.md)）：`dial.windowStart < windowEnd`；`sync.pageSize ∈ [10,100]`；`sync.intervalMs ≥ 10000`；`limits.perAccountConcurrency=1`（v1 固定）；`pipeline.asr.provider=minimax`、`pipeline.analysis.provider=deepseek`（v1 固定，改动 → `VALIDATION_FAILED`/`CONFIG_INVALID`）；使用 `deepseek-v4-pro` 时 `pipeline.analysis.maxTokens` 建议 ≥4096（[13 §3.1](./13-后处理规格（ASR与LLM）.md)）。
- 密钥字段只读：`minimaxApiKey` / `deepseekApiKey` / 账号密码走 secrets 文件或 `FOP_*` 环境变量，`PATCH /config` 修改会返回 `CONFIG_INVALID details.readonlyFields`。
- `pipeline.*` 变更对**新入队作业**生效；进行中作业沿用原参数（需要时用 `calls reprocess` 显式重跑）。
- 改 `server.host/port` 返回 `restartRequired:true`，需重启生效。
- 错误：`INVALID_REQUEST`(2)、`VALIDATION_FAILED`(2)、`CONFIG_INVALID`(2)、`UNAUTHORIZED`(6)。

### 8.13 `feige text normalize <text|->`

文本归一化（`POST /text/normalize`，同步、无副作用；`text` 1–20000 字符）。

```bash
feige text normalize <text|-> [--include-unchanged] [--category-filter <c1,c2>] [--json]
```

```bash
$ feige text normalize '复萌那边说福梦的系统不错'
复萌那边说福梦的系统不错
→ 孚盟那边说孚盟的系统不错（命中 2 条：复萌→孚盟、福梦→孚盟）
```

`--json` 的 `data`（[05 §7.9](./05-对外API契约.md)）：

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

- 错误：`VALIDATION_FAILED`(2，超长/空文本)、`UNAUTHORIZED`(6)。

### 8.14 `feige webhook test`（v1.1 可选）

测试 webhook 出站配置（`POST /webhooks/test`）。

```bash
feige webhook test [--url <url>] [--event-type <type>]
```

```text
✔ webhook 测试已投递  url=https://example.invalid/hook  eventType=call.ended  status=200  latency=142ms
```

`--json` 的 `data`：`{ "delivered": true, "statusCode": 200, "latencyMs": 142 }`。

- 错误：`VALIDATION_FAILED`(2，非 https/非法 URL/未配置 webhook)、`UPSTREAM_UNREACHABLE`(5，投递失败 `details.deliveryError`)。

---

## 9. 危险操作与确认矩阵

| 命令 | 副作用 | TTY 行为 | 非 TTY 行为 | 可撤销 |
| --- | --- | --- | --- | --- |
| `dial` | 真实外呼、计费、振铃坐席手机 | 展示号码/账号/时段/幂等键，输入 `yes` | 必须 `--yes` | 仅 `pending` 可 `calls cancel` |
| `account login` | 上游登录、可能触发滑块/风控 | 确认后执行；等待结果 | 必须 `--yes` | 可 `logout` |
| `account logout` | 清本地会话，影响在途任务 | 确认 | 必须 `--yes` | 重新 `login` |
| `account remove` | 删除本地账号配置；`--purge-data` 删数据 | 输入 `yes`；purge 需再输 accountId | 必须 `--yes` | 重新 `add`+`login`；purge 不可恢复 |
| `account update`（密码轮换） | 清除现有会话 | 确认 | 必须 `--yes` | 重新 `login` |
| `calls reprocess` | ASR/LLM token 成本（ASR 按音频时长、analysis 按 token；不设预算上限但全程记录） | 确认 | 必须 `--yes` | 幂等，可再次重跑 |
| `term import` | 全量替换词表（删旧规则） | 展示 diff 后确认 | 必须 `--yes` | 用备份文件回滚 |
| `config set` | 改运行参数 | 展示 diff 后确认 | 必须 `--yes` | 改回原值 |
| `calls cancel` | 终止 pending 呼出 | 确认 | 必须 `--yes` | 不可（需重新 dial） |
| `sync`（full/backfill） | 大量上游读请求；`full` 触发历史话单 ASR/analysis 全量回补（不设预算上限，记录 token/耗时） | 确认 | 必须 `--yes` | 只读/可重跑，回补作业可观测 |

> `--quiet` 不抑制确认；`--yes` 只跳过确认，不改变服务端校验（时段/并发/幂等/审计照常生效）。

---

## 10. `--dry-run` 支持矩阵

| 命令 | 支持 | `--dry-run` 行为 | 对应 REST |
| --- | --- | --- | --- |
| `dial` | ✅ | 只做校验并返回将执行的计划，不产生 Call | `POST /calls` body `dryRun:true`（200） |
| `calls reprocess` | ✅ | CLI 本地预览：读取 detail 的流水线状态，列出将重跑阶段与预计 ASR/LLM 成本，不发 POST | 无（CLI 侧） |
| `term import` | ✅ | CLI 本地 diff：`GET /terms` 与导入文件比较，不发 PUT | 无（CLI 侧） |
| `config set` | ✅ | CLI 本地 diff：`GET /config` 与 patch 比较，不发 PATCH | 无（CLI 侧） |
| `account remove` | ✅ | 只显示账号与统计数据（来自 `account show`），不 DELETE | 无（CLI 侧） |
| `account add` | ✅ | 仅本地参数校验（slug/手机号/密码长度） | 无（CLI 侧） |
| `sync` / `account login` / `account logout` / `calls cancel` | ❌ | 无 dry-run 语义 | — |
| 读命令 | — | 天然无副作用 | — |

---

## 11. stdin / 管道 / 脚本模式

| 约定 | 说明 |
| --- | --- |
| `-` 参数 | 从 stdin 读取该参数值：`dial -`（号码）、`text normalize -`（文本）、`term import -`（rules JSON）、`config set --file -`（patch） |
| 密码输入 | 只允许 `--password-stdin` / `--password-env`；**不提供** `--password <明文>` |
| 二进制输出 | `calls audio --out -`：stdout 只有 WAV 字节；诊断全走 stderr |
| 管道示例 | `feige calls list --date 2026-11-14 --json \| jq -r '.data[] \| .callId'` |
| 非交互 | 无 TTY 自动启用；`CI=true` 或 `--no-interactive` 强制；危险命令需 `--yes` |
| 幂等重试 | 网络类失败（8/9）可安全重试读命令；写命令重试须复用 `--idempotency-key` |
| 长任务 | `--wait` 超时返回 `9`，任务仍在后台；用 `jobs get <jobId>` 续查，**不要重复提交** |

---

## 12. Agent 典型用法（18 例）

> 所有示例可直接用于 agent 的 shell 调用；号码/ID 已脱敏。`--json` 输出均可被 `jq` 消费。

**① 探活/自检**

```bash
feige health --json                                   # 存活探针
feige status --json | jq '.data.dialWindow.open'      # 是否在可呼出时段
feige doctor --json | jq '.data.summary'              # 自检汇总（含失败项）
feige doctor --probe-providers --json                 # 额外检查 MiniMax/DeepSeek 配置/密钥/出站
```

**② 查最新话单（默认 sort=-createdAt 倒序）**

```bash
feige calls list --size 5 --json
```

**③ 按号码/客户名检索**

```bash
feige calls list --to '*0000' --size 10 --json           # 后 4 位模糊
feige calls list --date 2026-11-14 --q '李总' --json
```

**④ 查今天已接通通话的流水线状态**

```bash
feige calls list --date 2026-11-14 --status ended --json \
  | jq -r '.data[] | [.callId, .pipeline.audio, .pipeline.transcript, .pipeline.analysis] | @tsv'
```

**⑤ 拉起单通详情（含录音/转写/分析状态）**

```bash
feige calls detail call_01J8Z3K5T9QW2M4R7X1C6V0B8N --json
```

**⑥ 拉转写（人类可读 / 机器可读）**

```bash
feige calls transcript call_01J8Z3K5T9QW2M4R7X1C6V0B8N
feige calls transcript call_01J8Z3K5T9QW2M4R7X1C6V0B8N --json | jq '.data.fullText'
```

**⑦ 下载录音归档**

```bash
feige calls audio call_01J8Z3K5T9QW2M4R7X1C6V0B8N --out ./recordings/
```

**⑧ 发起呼出（带幂等键，非交互）**

```bash
feige dial '138****0000' --account main --customer-name '李总' \
  --idempotency-key "dial-$(date +%Y%m%d%H%M%S)-001" --yes --json
```

**⑨ 呼出后轮询状态（短轮询；长任务用事件流）**

```bash
for i in $(seq 1 20); do
  s=$(feige calls get call_01J8Z3K5T9QW2M4R7X1C6V0B8N --json | jq -r '.data.status')
  case "$s" in ended|no_answer|failed|canceled) break;; esac
  sleep 5
done
echo "final=$s"
```

**⑩ 用事件流跟踪呼出结果（SSE）**

```bash
feige events --types 'call.connected,call.ended,call.no_answer,call.failed' --follow --duration 180s
```

**⑪ 单通话单事件时间线**

```bash
feige calls events call_01J8Z3K5T9QW2M4R7X1C6V0B8N --json
```

**⑫ 触发/等待增量同步**

```bash
feige sync --account main --mode incremental --wait --json
```

**⑬ 查看失败作业并定位原因**

```bash
feige jobs list --status failed --json \
  | jq -r '.data[] | [.jobId,.type,.callId,.lastError.code] | @tsv'
```

**⑭ ASR 转写/分析失败时重跑**

```bash
feige calls reprocess call_01J8Z3K5T9QW2M4R7X1C6V0B8N --stage transcript --asr-model asr-1.0 --wait --yes --json
feige calls reprocess call_01J8Z3K5T9QW2M4R7X1C6V0B8N --stage analysis \
  --analysis-model deepseek-v4-pro --force --wait --yes --json
```

**⑮ 词表归一（文本工具）**

```bash
feige text normalize '复萌科技的方案' --json
```

**⑯ 账号登录与健康巡检**

```bash
feige account list --json | jq -r '.data[] | [.accountId,.state,.jwtExpiresAt] | @tsv'
feige account login shouji-1 --yes --json
feige account health main --json
```

**⑰ 全量回补 ASR + DeepSeek 分析（不设预算上限，观测 token/耗时）**

```bash
feige sync --full --wait --json                                    # 全量同步并触发历史话单后处理排队
feige jobs list --type asr,analysis --status queued,running --json  # 回补进度
feige jobs list --type analysis --status failed --json \
  | jq -r '.data[] | [.jobId,.callId,.lastError.code] | @tsv'       # 失败分布
feige calls detail call_01J8Z3K5T9QW2M4R7X1C6V0B8N --json \
  | jq '.pipelineDetail'                                           # 单通阶段状态
```

> 回补不设预算上限，但每次 ASR/LLM 调用都记录 token/耗时（`AnalysisPayload.usage`，[13 §6.4](./13-后处理规格（ASR与LLM）.md)）；建议先 `feige doctor --probe-providers` 确认链路。

**⑱ 人工复核低置信说话人（needsReview）**

```bash
feige calls list --date 2026-11-14 --status ended --size 100 --json \
  | jq -r '.data[] | select(.pipeline.transcript=="ready") | .callId' \
  | while read -r id; do
      feige calls detail "$id" --json \
        | jq -c '{callId, needsReview:.transcript.needsReview, chunkCount:.pipelineDetail.transcript.chunkCount}'
    done | jq -s '[.[] | select(.needsReview==true)]'
```

**批量脚本模式（示例：今日未接通话单导出）**

```bash
feige calls list --date 2026-11-14 --status no_answer --size 100 --json \
  | jq -r '.data[] | [.callId, .to.phone, .createdAt] | @tsv' > no_answer.tsv
```

---

## 13. CLI ↔ REST 映射总表

> 方法/路径以 [01 §4.1](./01-决策与约定.md) 为准；`#` 为 01 的编号。

| CLI | REST | # | 类型 |
| --- | --- | --- | --- |
| `feige health` | `GET /health` | 1 | 读 |
| `feige status` | `GET /status` | 2 | 读 |
| `feige config get` | `GET /config` | 3 | 读 |
| `feige config set` | `PATCH /config` | 4 | 写 |
| `feige account list` | `GET /accounts` | 5 | 读 |
| `feige account add` | `POST /accounts` | 6 | 写 |
| `feige account show` | `GET /accounts/{accountId}` | 7 | 读 |
| `feige account update` | `PATCH /accounts/{accountId}` | 8 | 写 |
| `feige account remove` | `DELETE /accounts/{accountId}` | 9 | 写 |
| `feige account login` | `POST /accounts/{accountId}/login` | 10 | 写 |
| `feige account logout` | `POST /accounts/{accountId}/logout` | 11 | 写 |
| `feige account health` | `GET /accounts/{accountId}/health` | 12 | 读 |
| `feige dial` | `POST /calls` | 13 | 写（有计费） |
| `feige calls list` | `GET /calls` | 14 | 读 |
| `feige calls get` | `GET /calls/{callId}` | 15 | 读 |
| `feige calls detail` | `GET /calls/{callId}/detail` | 16 | 读 |
| `feige calls transcript` | `GET /calls/{callId}/transcript` | 17 | 读 |
| `feige calls audio` | `GET /calls/{callId}/audio` | 18 | 读（二进制） |
| `feige calls reprocess` | `POST /calls/{callId}/reprocess` | 19 | 写 |
| `feige calls cancel` | `POST /calls/{callId}/cancel` | 20 | 写 |
| `feige calls events` | `GET /calls/{callId}/events` | 21 | 读 |
| `feige sync` | `POST /sync` | 22 | 写（异步作业） |
| `feige sync status` | `GET /sync` | 23 | 读 |
| `feige jobs get <jobId>` | `GET /sync/{jobId}` | 24 | 读 |
| `feige jobs list` | `GET /jobs` | 25 | 读 |
| `feige jobs get <jobId>` | `GET /jobs/{jobId}` | 26 | 读 |
| `feige events` | `GET /events` | 27 | 读 |
| `feige events --follow` | `GET /events/stream` | 28 | SSE |
| `feige webhook test` | `POST /webhooks/test` | 29 | 写（v1.1 可选） |
| `feige term list` | `GET /terms` | 30 | 读 |
| `feige term import` | `PUT /terms` | 31 | 写（全量替换） |
| `feige term add` | `POST /terms` | 32 | 写 |
| `feige term update` | `PATCH /terms/{termId}` | 33 | 写 |
| `feige term remove` | `DELETE /terms/{termId}` | 34 | 写 |
| `feige text normalize` | `POST /text/normalize` | 35 | 读（无副作用） |
| `feige serve` / `doctor` / `mcp` / `completion` / `version` | — | — | 本地命令 |

---

## 14. 一致性声明与对齐清单

**基准优先级**：[01-决策与约定.md](./01-决策与约定.md) > [05-对外API契约.md](./05-对外API契约.md) > 本文。若 05 与本文冲突，以 05 为准并回改本文。

| 核对项 | 结论（对齐依据：docs/01 v1 ASR/LLM 决策、docs/05、docs/13，2026-11-14） |
| --- | --- |
| 命令命名 | 与 [01 §4.1](./01-决策与约定.md)「CLI」列逐一对应（35 个 REST 操作 + 5 个本地命令），无改名；`doctor` 新增 `--probe-providers`（CLI 专有能力，不改 REST） |
| REST 方法/路径 | 与 01 §4.1 #1–#35 一致；`webhook test` 标注 v1.1 可选 |
| 封套 | `{ok,data,meta}` / `{ok:false,error,meta}` / `meta.pagination` / `meta.idempotencyReplayed` 与 01 §5.3、05 §1.2 一致 |
| 列表 data 形态 | 均为数组（`CallSummary[]`/`AccountSummary[]`/`JobSummary[]`/`EventRecord[]`/`TermRule[]`），与 05 各接口一致 |
| DTO 字段 | `to.phone`/`from.phone`、`status/statusReason`、`pipeline{audio,transcript,analysis}`、`upstreamStatus`、`recording`、`transcript{source:"asr",provider,chunkCount,needsReview}`、segments `{speakerLabel,chunkIndex,channel,confidence,rawText,normalizedText}`、`AnalysisPayload{promptVersion,usage,speakerMapping{method,needsReview,evidence}}`、`dialWindow{open,windowStart,windowEnd,timezone,nextOpenAt}`、`accounts{...}`、`termId=term_...`、`from: string[]`、`dateFrom`/`dateTo` 与 05 §2 一致 |
| 关键行为 | `POST /calls` 201+dryRun 200、`login` 默认 wait=true / `--async` 202、`logout` 204、`reprocess` stages 必填且 `options{asrModel,analysisModel,promptVersion,termRulesVersion}`、`sync` mode 含 `full`/`backfill`（`--full` 后历史话单 ASR/analysis 排队回补，[13 §3.4/§7](./13-后处理规格（ASR与LLM）.md)）、`TRANSCRIPT_PENDING` 的 `details.stage` 取 `asr_queued`/`asr_running`/`role_mapping`/`analysis`、`DELETE /terms/{termId}` 204/重复 404、`PUT /terms` `{rules,mode:"replace"}`、`text/normalize` 1–20000 字符 与 05 一致 |
| 后处理链路 | 转写=本地 ASR（MiniMax `asr-1.0`，不使用上游转写）；分析=平台内置 DeepSeek（默认 `deepseek-chat`，校验失败升级 `deepseek-v4-pro`，`promptVersion=analysis-v1`）；`config pipeline` 为嵌套 `asr`/`analysis`/`roleMapping`；`doctor --probe-providers` 检查 provider 配置/密钥引用/出站白名单/连通性与最近成功作业 |
| 错误码 | 仅使用 [01 §5.4](./01-决策与约定.md) 的 **40 个**稳定错误码（已删除原上游转写等待码，含 `SERVICE_UNAVAILABLE`/`ASR_FAILED`/`ANALYSIS_FAILED`），未新增；本地参数错误复用 `INVALID_REQUEST`/`VALIDATION_FAILED`/`CONFIG_INVALID` |
| 枚举 | Call status、Pipeline stage status、Job type（`login,sync,audio_fetch,asr,analysis,reprocess,backfill`）/Job status、Transcript source（固定 `asr`）、SpeakerMapping method、Event type 与 01 §6.1/§7.3 一致 |
| 时间/ID | 时间 ISO 8601 `+08:00`；`callId/jobId/eventId/termId` 为 `前缀_ULID`；`accountId` 为 slug（01 §5.6） |
| CLI 专有能力 | `--watch`、`--wait`（CLI 轮询）、`--dry-run`（CLI 本地 diff/预览）、`--key`/`--date` 快捷方式、`--format` 客户端渲染、`doctor --probe-providers`——均标注为 CLI 侧能力，不改变 REST 契约 |
| 脱敏 | 全文无真实密码/JWT/完整手机号；示例统一 `138****0000`/`156****0075`；密钥仅 secrets/环境变量，示例用 `sk-api-...` 占位 |
| 实现代码 | 无；本文仅为契约 |

> 已知 docs/05 待澄清项（不影响本文契约，将在本轮汇报中提交 Lead 确认）：§2.9 定义了 `AnalysisPayload`（含 `promptVersion`/`usage`），但 `TranscriptPayload.analysis` 为 brief、`pipelineDetail.analysis` 无 usage，完整 payload 的具体承载位置未明确；本文示例按 05 已定义的响应字段输出，完整字段定义引用 05 §2.9，建议 05 明确 token 观测的返回位置。
> （docs/05 已于 2026-11-14 00:05 修复 `JobSummary.type` 枚举与 reprocess `options{asrModel,...}`，本文已同步；此前记录的两项已关闭。）
