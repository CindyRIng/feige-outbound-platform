# 16 CLI 参考手册（`feige`）

> 版本：v0.3.2｜自动生成：`npm run docs:cli`（来源：CLI 命令树；与 `feige --help-all` 一致）

`feige` 是 REST v1 的薄封装：所有命令通过 HTTP 调用本地服务（默认 `http://127.0.0.1:8710/api/v1`），不直接访问数据库或上游。

## 安装

```bash
npm install && npm run build
npm run install:cli      # 安装到 ~/.local/bin/feige
feige --version
```

## 帮助

```bash
feige --help            # 顶层命令与全局选项
feige help <command>    # 某个命令（含子命令）的帮助
feige --help-all        # 完整命令树（全部命令/子命令/参数/选项）
```

## 全局选项（所有命令通用）

| 选项 | 说明 |
| --- | --- |
| `--version`| 显示版本 |
| `--api <url>`| REST 基址（默认 FOP_API_URL 或 http://127.0.0.1:8710/api/v1） |
| `--token <token>`| 本地 API token（默认读 token 文件） |
| `--token-file <path>`| 本地 API token 文件 |
| `-j, --json`| 输出与 REST 同构的 JSON 封套 |
| `-q, --quiet`| 只输出关键结果/错误 |
| `-v, --verbose`| 调试日志到 stderr |
| `--timeout <dur>`| 单次请求超时（30s / 5m） |
| `-y, --yes`| 跳过危险操作确认（非交互必需） |
| `--no-color`| 禁用颜色 |
| `--help-all`| 显示全部命令与子命令的完整帮助（递归，含所有选项） |

## 命令树

### `feige serve`

启动本地服务（systemd 常驻；main.ts 直接路由）

```text
Usage: feige serve [options]
```

| 选项 | 说明 |
| --- | --- |
| `--port <n>`| 监听端口（默认 8710 / FOP_PORT） |
| `--host <host>`| 监听地址（默认 127.0.0.1 / FOP_HOST） |

### `feige mcp`

启动 MCP stdio server（main.ts 直接路由；agent 集成入口）

```text
Usage: feige mcp [options]
```

| 选项 | 说明 |
| --- | --- |
| `--allow-write`| 开放写工具（默认只读 18 个；开启后 32 个，写工具需 confirm:true） |

### `feige health`

存活探针（GET /health）

```text
Usage: feige health [options]
```

### `feige status`

平台健康（GET /status）

```text
Usage: feige status [options]
```

| 选项 | 说明 |
| --- | --- |
| `--no-detail`| 不返回 accountsDetail |
| `--watch`| 持续刷新 |
| `--interval <dur>`| 刷新间隔（默认 "5s"） |

### `feige version`

版本信息

```text
Usage: feige version [options]
```

### `feige config`

生效配置

```text
Usage: feige config [options]
```

#### `feige config get`

读取配置（GET /config）

```text
Usage: feige config get [options]
```

| 选项 | 说明 |
| --- | --- |
| `--key <path>`| 点路径，如 pipeline.asr |

#### `feige config set [pairs]`

局部更新配置（PATCH /config）

```text
Usage: feige config set [pairs] [options]
```

| 选项 | 说明 |
| --- | --- |
| `--file <path>`| Merge Patch JSON 文件（- 表示 stdin） |
| `--dry-run`| 只输出 diff，不 PATCH |

### `feige account`

账号管理

```text
Usage: feige account [options]
```

#### `feige account list`

账号列表（GET /accounts）

```text
Usage: feige account list [options]
```

| 选项 | 说明 |
| --- | --- |
| `--state <s>`| 状态过滤（逗号分隔） |
| `--enabled`| 仅启用 |
| `--page <n>`|  |
| `--size <n>`|  |

#### `feige account show <accountId>`

账号详情（GET /accounts/{id}）

```text
Usage: feige account show <accountId> [options]
```

#### `feige account add <accountId>`

注册账号（POST /accounts）

```text
Usage: feige account add <accountId> [options]
```

| 选项 | 说明 |
| --- | --- |
| `--username <phone>`| 上游登录手机号 |
| `--password-stdin`| 从 stdin 读取密码 |
| `--password-env <ENV>`| 从环境变量读取密码 |
| `--display-name <name>`| 展示名 |
| `--concurrency <n>`| 并发（v1 固定 1） |
| `--browser-headless`| 登录浏览器 headless |
| `--profile-dir-name <name>`| 浏览器 profile 目录名 |
| `--metadata <k=v>`| 自定义键值（可重复）（默认 []） |
| `--dry-run`| 只做本地校验 |

#### `feige account update <accountId>`

更新账号（PATCH /accounts/{id}）

```text
Usage: feige account update <accountId> [options]
```

| 选项 | 说明 |
| --- | --- |
| `--display-name <name>`| 展示名 |
| `--enable`| 启用 |
| `--disable`| 停用 |
| `--password-stdin`| 轮换密码（stdin） |
| `--password-env <ENV>`| 轮换密码（环境变量） |
| `--browser-headless`| 浏览器 headless |
| `--browser-headful`| 浏览器 headful |
| `--metadata <k=v>`| 覆盖/新增 metadata（可重复）（默认 []） |
| `--relogin`| 密码变更后立即重登 |

#### `feige account remove <accountId>`

移除账号（DELETE /accounts/{id}）

```text
Usage: feige account remove <accountId> [options]
```

| 选项 | 说明 |
| --- | --- |
| `--purge-data`| 同时删除本地历史数据（不可恢复） |
| `--dry-run`| 只显示将移除的账号 |

#### `feige account login <accountId>`

触发登录（POST /accounts/{id}/login）

```text
Usage: feige account login <accountId> [options]
```

| 选项 | 说明 |
| --- | --- |
| `--async`| 不等待登录结果（wait=false） |
| `--timeout-ms <n>`| 等待上限（毫秒，10000–300000） |
| `--force`| 已有会话也强制重登 |
| `--idempotency-key <key>`| 幂等键 |

#### `feige account logout <accountId>`

退出本地会话（POST /accounts/{id}/logout）

```text
Usage: feige account logout <accountId> [options]
```

#### `feige account health <accountId>`

单账号健康（GET /accounts/{id}/health）

```text
Usage: feige account health <accountId> [options]
```

### `feige dial <toPhone>`

发起呼出（POST /calls，有副作用/计费）

```text
Usage: feige dial <toPhone> [options]
```

| 选项 | 说明 |
| --- | --- |
| `--account <accountId>`| 指定账号 |
| `--customer-name <name>`| 客户名 |
| `--metadata <k=v>`| 自定义键值（可重复）（默认 []） |
| `--scheduled-at <iso>`| 期望呼出时间 |
| `--idempotency-key <key>`| 幂等键 |
| `--wait`| 等待接通/终态 |
| `--wait-timeout <dur>`| 等待超时（默认 "180s"） |
| `--dry-run`| 只做预检，不产生话单 |

### `feige calls`

话单

```text
Usage: feige calls [options]
```

#### `feige calls list`

话单列表（GET /calls）

```text
Usage: feige calls list [options]
```

| 选项 | 说明 |
| --- | --- |
| `--account <id>`| 账号过滤 |
| `--status <s>`| 状态（逗号分隔） |
| `--pipeline <stage:status>`| 流水线过滤，如 transcript:ready（可重复）（默认 []） |
| `--has-audio`| 仅已归档录音 |
| `--has-transcript`| 仅有转写 |
| `--to <phone>`| 被叫号码（支持 *1234 后四位模糊） |
| `--q <text>`| 文本搜索 |
| `--from-date <date>`| startedAt 起始日期 |
| `--to-date <date>`| startedAt 结束日期 |
| `--date <date>`| 单日（等价 from-date=to-date） |
| `--sort <field>`| 排序（默认 "-createdAt"） |
| `--page <n>`|  |
| `--size <n>`|  |
| `--no-include-pipeline`| 不返回 pipeline |

#### `feige calls get <callId>`

话单摘要（GET /calls/{id}）

```text
Usage: feige calls get <callId> [options]
```

#### `feige calls detail <callId>`

话单详情（GET /calls/{id}/detail）

```text
Usage: feige calls detail <callId> [options]
```

| 选项 | 说明 |
| --- | --- |
| `--include-raw`| 返回上游原始对象 |
| `--include-events`| 内联最近 50 条事件 |

#### `feige calls transcript <callId>`

转写全文+分段（GET /calls/{id}/transcript）

```text
Usage: feige calls transcript <callId> [options]
```

| 选项 | 说明 |
| --- | --- |
| `--include-analysis`| 附带分析摘要 |
| `--format <fmt>`| text|markdown|srt|json（默认 "text"） |
| `--role <role>`| agent|customer|unknown（客户端过滤） |
| `--out <path>`| 写入文件（- 表示 stdout） |
| `--force`| 允许覆盖 --out 目标 |

#### `feige calls audio <callId>`

下载原始录音（GET /calls/{id}/audio）

```text
Usage: feige calls audio <callId> [options]
```

| 选项 | 说明 |
| --- | --- |
| `--out <path>`| 输出文件（默认 ./<callId>.wav；- 表示 stdout） |
| `--attachment`| 以附件形式下载 |

#### `feige calls reprocess <callId>`

重跑流水线阶段（POST /calls/{id}/reprocess）

```text
Usage: feige calls reprocess <callId> [options]
```

| 选项 | 说明 |
| --- | --- |
| `--stage <stages>`| audio|transcript|analysis（逗号分隔，可重复）（默认 []） |
| `--force`| 忽略已 ready 强制重跑 |
| `--asr-model <model>`| ASR 模型（如 asr-1.0） |
| `--analysis-model <model>`| 分析模型（如 deepseek-v4-pro） |
| `--prompt-version <v>`| 分析 prompt 版本 |
| `--term-rules-version <v>`| 词表版本 |
| `--idempotency-key <key>`| 幂等键 |
| `--dry-run`| 只列出将重跑的阶段 |
| `--wait`| 等待作业结束 |
| `--wait-timeout <dur>`| 等待超时（默认 "600s"） |

#### `feige calls cancel <callId>`

取消 pending 呼出（POST /calls/{id}/cancel）

```text
Usage: feige calls cancel <callId> [options]
```

#### `feige calls events <callId>`

单通话单事件（GET /calls/{id}/events；--follow 走 SSE）

```text
Usage: feige calls events <callId> [options]
```

| 选项 | 说明 |
| --- | --- |
| `--types <types>`| 事件类型（逗号分隔） |
| `--page <n>`|  |
| `--size <n>`|  |
| `--follow`| SSE 持续跟随 |
| `--duration <dur>`| 跟随时长，如 60s |

### `feige sync`

触发同步（POST /sync）

```text
Usage: feige sync [options]
```

| 选项 | 说明 |
| --- | --- |
| `--account <id>`| 仅指定账号 |
| `--mode <mode>`| incremental|full|backfill（默认 "incremental"） |
| `--from <date>`| backfill 起始日期 |
| `--to <date>`| backfill 结束日期 |
| `--full`| 等价 --mode full（全量回补 ASR/analysis） |
| `--wait`| 等待作业结束 |
| `--wait-timeout <dur>`| 等待超时（默认 "300s"） |
| `--idempotency-key <key>`| 幂等键 |

#### `feige sync status`

最近同步作业（GET /sync）

```text
Usage: feige sync status [options]
```

| 选项 | 说明 |
| --- | --- |
| `--account <id>`|  |
| `--status <s>`|  |
| `--page <n>`|  |
| `--size <n>`|  |

### `feige jobs`

后台作业

```text
Usage: feige jobs [options]
```

#### `feige jobs list`

作业列表（GET /jobs）

```text
Usage: feige jobs list [options]
```

| 选项 | 说明 |
| --- | --- |
| `--type <types>`| 类型（逗号分隔） |
| `--status <s>`| 状态 |
| `--account <id>`|  |
| `--call <callId>`|  |
| `--page <n>`|  |
| `--size <n>`|  |
| `--sort <field>`|  |

#### `feige jobs get <jobId>`

作业详情（GET /jobs/{id}）

```text
Usage: feige jobs get <jobId> [options]
```

| 选项 | 说明 |
| --- | --- |
| `--wait`| 等待作业结束 |
| `--wait-timeout <dur>`| 等待超时（默认 "300s"） |

### `feige events`

事件历史/实时流（GET /events，--follow 走 SSE）

```text
Usage: feige events [options]
```

| 选项 | 说明 |
| --- | --- |
| `--types <types>`| 事件类型（逗号分隔，支持 call.*） |
| `--call <callId>`|  |
| `--account <id>`|  |
| `--since <iso>`|  |
| `--until <iso>`|  |
| `--page <n>`|  |
| `--size <n>`|  |
| `--sort <field>`|  |
| `--follow`| SSE 持续跟随 |
| `--last-event-id <id>`| SSE 断点续传 |
| `--duration <dur>`| 跟随时长，如 60s |

### `feige term`

词表

```text
Usage: feige term [options]
```

#### `feige term list`

词表列表（GET /terms）

```text
Usage: feige term list [options]
```

| 选项 | 说明 |
| --- | --- |
| `--q <text>`|  |
| `--category <c>`|  |
| `--enabled`|  |
| `--page <n>`|  |
| `--size <n>`|  |

#### `feige term add`

新增规则（POST /terms）

```text
Usage: feige term add [options]
```

| 选项 | 说明 |
| --- | --- |
| `--from <词>`| 变体（可重复）（默认 []） |
| `--to <归一>`|  |
| `--category <c>`|  |
| `--priority <n>`|  |
| `--note <s>`|  |
| `--case-sensitive`|  |
| `--disabled`|  |

#### `feige term update <termId>`

修改规则（PATCH /terms/{id}）

```text
Usage: feige term update <termId> [options]
```

| 选项 | 说明 |
| --- | --- |
| `--from <词>`| 变体（可重复）（默认 []） |
| `--to <归一>`|  |
| `--category <c>`|  |
| `--priority <n>`|  |
| `--note <s>`|  |
| `--enable`|  |
| `--disable`|  |
| `--case-sensitive`|  |

#### `feige term remove <termId>`

删除规则（DELETE /terms/{id}）

```text
Usage: feige term remove <termId> [options]
```

#### `feige term import <file>`

全量替换词表（PUT /terms）

```text
Usage: feige term import <file> [options]
```

| 选项 | 说明 |
| --- | --- |
| `--format <fmt>`| json|csv（默认按扩展名） |
| `--dry-run`| 只输出 diff，不 PUT |

### `feige text`

文本工具

```text
Usage: feige text [options]
```

#### `feige text normalize <text>`

文本归一化（POST /text/normalize）

```text
Usage: feige text normalize <text> [options]
```

| 选项 | 说明 |
| --- | --- |
| `--include-unchanged`|  |
| `--category-filter <cats>`|  |

### `feige doctor`

自检/排障（配置/DB/token/provider/出站）

```text
Usage: feige doctor [options]
```

| 选项 | 说明 |
| --- | --- |
| `--probe-upstream`| 额外探测上游 |
| `--probe-providers`| 检查 MiniMax/DeepSeek 配置/密钥引用/出站白名单/连通性 |
| `--fix-token`| 生成缺失的本地 API token |

### `feige completion <shell>`

生成 shell 补全脚本

```text
Usage: feige completion <shell> [options]
```

## 通用约定

- 默认人类可读输出；`--json` 输出与 REST 同构的 JSON 封套（`{ok,data,meta}`），便于脚本处理。
- 退出码：`0` 成功、`2` 参数/用法、`3` 未找到、`4` 业务拒绝、`5` 上游/服务端、`6` 鉴权、`8` 网络不可达、`9` 超时、`130` Ctrl-C。
- 危险操作（`dial`、`account remove`、`reprocess` 等）默认需交互确认；非交互必须 `--yes` 或先 `--dry-run`。
- Token 读取顺序：`--token` → `FOP_API_TOKEN` → `~/.config/feige-outbound/api-token`；也可 `--token-file` 指定。
- REST 基址：`--api` → `FOP_API_URL` → 默认 `http://127.0.0.1:8710/api/v1`。
