# spec — REST v1 机器可读契约

> 本目录只放**机器可读契约**及其说明；人类可读权威契约是 `docs/05-对外API契约.md`，后处理实现规格见 `docs/13-后处理规格（ASR与LLM）.md`。
> 状态：**v0.1（Step 2 设计稿，2026-11-14）**；v1 "本地 ASR（MiniMax）+ DeepSeek 后处理" 决策已同步到本文件。

## 1. 用途

| 文件 | 用途 |
| --- | --- |
| [openapi.yaml](./openapi.yaml) | REST v1 的 OpenAPI 3.1 机器可读契约：供 SDK/客户端生成、契约测试、Mock server、API 文档站点（Redoc/Swagger UI）与 CI 校验使用 |
| README.md（本文件） | 说明版本、权威关系、内容清单、同步记录、校验方式、变更流程与已知限制/待确认项 |

使用方与典型场景：

- **二次开发者**：用 `openapi-generator` / `openapi-typescript` 等从本文件生成客户端类型；
- **测试**：M1 起据本文件生成契约测试用例（方法/路径/状态码/错误码/封套/分页/全局错误）；
- **文档站**：由本文件渲染交互式 API 文档；
- **评审**：与 `docs/05`、`docs/01`、`docs/13` 双向核对（本文件是机器副本，不产生新语义）。

## 2. 权威关系（单一事实源）

```
docs/01-决策与约定.md（全局约定：错误码 §5.4（40 个稳定码）、枚举 §6.1、幂等/分页/时间 §5、配置 §9）
        │ 基准
        ├──────────────────────────────────────────────┐
        ▼                                              ▼
docs/05-对外API契约.md（REST v1 人类可读权威：        docs/13-后处理规格（ASR与LLM）.md
   DTO §2（含 §2.14 操作结果 DTO）、接口清单 §3、          （ASR=MiniMax、LLM=DeepSeek、切分/说话人/
   错误矩阵 §8、示例 §4–§7）                               词表/prompt/输出 schema；§2.13 配置细化）
        │ 机器副本（同一次变更内同步）                        │ 仅作为 pipeline 行为/配置依据
        ▼                                                    ▼
spec/openapi.yaml  ←→  spec/README.md
```

- **冲突时以 `docs/05` + `docs/01` 为准**（pipeline 的 ASR/LLM 行为/枚举以 `docs/13` 为准），并回改本文件；本文件**不新增**文档未定义的字段/枚举。
- 文档未明确处采用**最保守的可选/可空建模**，全部记录在 §9「待确认项 / 已知限制」。
- 适配层/后台作业的**内部错误码不对外**（`docs/01` §5.4 注）；本文件只包含 40 个稳定码，不收录内部码。
- `docs/13` 中仅影响内部实现的内容（分块计划 `Transcript.meta.chunks[]`、rawResponse 存档、队列/回补策略、reasoning 参数等）**不进入对外契约**，见 §9.2-K15。
- 仅允许写 `spec/openapi.yaml`、`spec/README.md`；其它 `docs/*` 由各自负责人维护。

## 3. 版本

| 项 | 值 | 说明 |
| --- | --- | --- |
| 契约版本 | `v0.1` | = `docs/05` v0.1；Step 2 设计稿 |
| OpenAPI 版本 | `3.1.0` | JSON Schema 2020-12 语义；空值用 `type: [T, "null"]` / `oneOf` 表达 |
| API 版本 | `/api/v1` | 破坏性变更升 `/api/v2`（`docs/05` §11） |
| 平台版本 | `0.1.0` | `info.version`；与 `GET /health` 示例版本一致 |
| Base URL | `http://127.0.0.1:8710/api/v1` | 默认仅监听 127.0.0.1，端口可配置 |
| 对应文档 | `docs/05`、`docs/01`、`docs/13`（均 v0.1） | 变更时同一次提交内同步 |
| 最近同步 | **2026-11-14（task-11）** | v1 ASR/LLM 决策变更复核：**40 稳定码**（删 `UPSTREAM_TRANSCRIPT_PENDING`）、`TranscriptSource=[asr]`、Config 重构（asr/analysis/roleMapping）、`AnalysisPayload.promptVersion/usage`、`SpeakerMapping` 新枚举、`CallTimeline.submittedAt` 等（见 §5.2） |

## 4. 内容概览（自检统计，2026-11-14 本机，task-11 复核后）

| 项 | 数量 | 说明 |
| --- | --- | --- |
| path item | 26 | OpenAPI 按路径模板计（同一路径多方法合并） |
| **operation** | **35** | 与 `docs/05` §3 的 35 行**方法+路径逐字一致**（自检脚本比对为 True） |
| tags | 9 | platform / accounts / calls / sync / jobs / events / webhooks / terms / text |
| schemas | **103** | 含 `docs/05` §2 全部 DTO + §2.14 十个结果 DTO + `AsrConfig`/`AnalysisConfig`/`RoleMappingConfig`/`AnalysisUsage`/`WebhookConfig` 等 |
| 共享 responses | 10 | BadRequest / Unauthorized / Forbidden / NotFound / Conflict / UnprocessableEntity / TooManyRequests / BadGateway / ServiceUnavailable / InternalServerError，**全部引用 ErrorResponse** |
| parameters / headers | 7 / 9 | 分页 page、幂等 Idempotency-Key、路径参数、X-Request-Id、X-Api-Version、Retry-After 等 |
| securitySchemes | 1 | `bearerAuth`（http bearer，localApiToken）；35 个 operation 全部应用 |
| `$ref` | **575** 处引用 / **128** 个唯一目标 | 全部可解析（自检 unresolved=[]） |
| operation 内联 examples | 21 个 operation / 30 个命名示例 | 8 个 request 示例 + 22 个 response 示例；另 **12** 个共享错误响应示例，合计 **42** |
| ErrorCode enum | **40** | 与 `docs/01` §5.4 完整错误码表逐项一致（v1 删除 `UPSTREAM_TRANSCRIPT_PENDING`；missing=[] / extra=[]） |
| 429 `RATE_LIMITED` | **35/35 operation** | `docs/05` §8：429 适用于全部接口；每个 operation 均声明共享 429 响应 |
| 503 `SERVICE_UNAVAILABLE`/依赖不可用 | **35/35 operation** | 本地服务启动中/优雅关闭/传输中断或 DB/上游登录态不可用时的全局兜底响应（`docs/05` §8 已明示） |
| v1 后处理 | ASR=MiniMax `asr-1.0`，LLM=DeepSeek（默认 `deepseek-chat`） | `TranscriptSource` 固定 `asr`；JobType 删除 `transcript_fetch`/`transcript_pending_wait`；见 `docs/13` |
| 脱敏 | — | 示例手机号一律 `138****0000` 形式；无真实密码/JWT/API Key/完整手机号/内部错误码 |

**契约要点**

- 所有业务响应套 `{ ok, data | error, meta }` 封套（`Envelope` + allOf 组合）；列表接口 `meta` 为 `PagedMeta`（强制 `pagination: PaginationMeta`）。
- 失败响应统一 `ErrorResponse`（`{ ok: false, error: ErrorObject, meta }`）；`ErrorObject.code` 枚举 = `docs/01` §5.4 全量 **40 稳定码**。
- 每个 operation 带扩展：
  - `x-side-effects`：读接口 `[]`，写接口列出副作用（如 `real-outbound-call`、`modifies-config`）；
  - `x-idempotent`：boolean，对齐 `docs/05` §3「幂等」列；
  - `x-error-codes`：该操作允许的业务错误码（`docs/05` §8 矩阵子集 + 全局 `RATE_LIMITED`/`SERVICE_UNAVAILABLE`，供契约测试/SDK 生成）。
- HTTP 状态 ↔ 错误码（`docs/01` §5.4）：400 `INVALID_REQUEST`/`VALIDATION_FAILED`/`CONFIG_INVALID`；401 `UNAUTHORIZED`；409 冲突/幂等；422 业务不允许；**429 全接口** `RATE_LIMITED`；**502** 上游不可达/错误/不可解析（`UPSTREAM_UNREACHABLE`/`UPSTREAM_BUSINESS_ERROR`/`UPSTREAM_RESPONSE_INVALID`）；**503** 依赖/本地服务不可用（`UPSTREAM_AUTH_EXPIRED`/`DB_UNAVAILABLE`/`SERVICE_UNAVAILABLE`）。
- v1 流水线：`audio_fetch → asr → analysis`（不再有上游转写）；`TranscriptPayload.source` 固定 `asr`、`provider` 如 `minimax:asr-1.0`；`PipelineTranscriptStage` 通过 `chunkCount`/`needsReview` 暴露分块与人工复核摘要；`AnalysisPayload` 含 `promptVersion`/`usage`，`SpeakerMapping.method` ∈ `[channel, asr_diarization, llm_reconciled, heuristic]`。
- 配置：`Config.pipeline` = `{ asr: AsrConfig, analysis: AnalysisConfig, roleMapping: RoleMappingConfig }`（`docs/05` §2.13）；`PATCH /config` 的 `pipeline` 是局部 Merge Patch 对象。
- 认证：`Authorization: Bearer <localApiToken>`（`components.securitySchemes.bearerAuth`），根级 + 每个 operation 均声明。
- 幂等：`Idempotency-Key` 请求头（写接口），重放响应 `meta.idempotencyReplayed=true`（`docs/01` §5.6 已统一）。
- 敏感字段：`password` 标注 `format: password` + `writeOnly: true`；ASR/LLM API Key 只存 secrets 文件，不进入契约/示例/日志。

## 5. 同步记录

### 5.1 task-6（2026-11-13）：docs 回改 → spec 对齐

> `docs/01`、`docs/05` 已按 spec-writer 反馈回改，本节记录 spec 的逐项落地与验证（历史记录，保留供追溯）。

| # | 变更（文档依据） | spec 落地 | 状态 |
| --- | --- | --- | --- |
| 1 | 幂等标记统一 `meta.idempotencyReplayed`（`docs/01` §5.6、`docs/05` §1.2/§9） | `Meta.idempotencyReplayed` 保持；无 `replayed` 残留 | ✅ |
| 2 | `UPSTREAM_UNREACHABLE` HTTP 统一 **502**（`docs/01` §5.4；`docs/05` §5.6/§6.1） | `BadGateway`(502) 描述/示例增加该码；`login`/`sync`/`webhook` 增加 502；`calls` 保持 502；`ServiceUnavailable`(503) 移除该码 | ✅ |
| 3 | `AccountSummary` 新增 optional `deletedAt`（`docs/05` §2.2/§5.5 软删除） | `AccountSummary.deletedAt: string? date-time` | ✅ |
| 4 | `CallDetail` 明确 `metadata?: object`、`events?: EventRecord[]`（`docs/05` §2.9） | optional 字段，描述改为正式依据 §2.9 | ✅ |
| 5 | 新增 `docs/05` §2.14 操作结果 DTO | `CallAccepted`(=CallSummary 别名)、`DryRunResult`、`AccountCreateResult`、`AccountLoginResult`、`AccountLoginAccepted`、`SyncAccepted`、`ReprocessAccepted`、`TermReplaceResult`、`NormalizeResult`、`WebhookTestResult` 落地并被 operation data 引用；旧名 `NormalizeResponse` 保留为 deprecated 兼容别名 | ✅ |
| 6 | `TranscriptPayload.analysis` 固定为 `{ analysisId, summary, intent? }`（`docs/05` §2.9） | `AnalysisBrief`：required `analysisId`+`summary`(string)，`intent?` | ✅ |
| 7 | `Config.events.webhooks[]` 元素结构（`docs/01` §9、`docs/05` §2.13） | `WebhookConfig`：`url`(https)/`eventTypes`/`secret?`/`enabled`/`timeoutMs?` | ✅ |
| 8 | `/calls` 列表日期参数改名 `dateFrom`/`dateTo`（`docs/01` §5.5、`docs/05` §6.2） | `listCalls` 参数改名；其它列表接口无日期参数 | ✅ |
| 9 | 429 `RATE_LIMITED` 适用于全部接口（`docs/05` §8） | 35/35 operation 声明共享 429 响应与 `x-error-codes` 含该码 | ✅ |
| 10 | PATCH 语义补充 RFC 7386（`docs/05` §4.4） | `patchConfig`、`ConfigPatch`、`updateAccount` 描述明确 “JSON Merge Patch (RFC 7386)” 及 null/数组语义 | ✅ |
| 11 | `docs/05` §6.4 CallDetail 示例补 `pipeline`/`audioAvailable` | spec 示例完整含两字段 | ✅ |
| 12 | OAS 层无法表达项（confirm 条件必填 / Merge Patch null / 跨字段校验） | 保留在 §9.2「已知限制」 | ✅ |
| 13 | `docs/01` §5.4 增加 `SERVICE_UNAVAILABLE`（当时共 41 码，503，retryable=true） | 枚举加入该码、共享 503 响应含 `SERVICE_UNAVAILABLE` 示例、35/35 声明 503 兜底；**后续 task-11 删除 `UPSTREAM_TRANSCRIPT_PENDING` → 40 码（见 5.2）** | ✅ |

### 5.2 task-11（2026-11-14）：v1 ASR/LLM 决策变更 → spec 复核

> 决策：**不使用上游转写**（`docs/13` D1）；ASR=MiniMax（D2）、LLM=DeepSeek（D3）；`docs/01`/`docs/05`/`docs/13` 已更新，Lead 已手工更新 spec，本轮全面复核并修复遗漏。

| # | 决策/变更（文档依据） | spec 落地 / 本轮复核结果 | 状态 |
| --- | --- | --- | --- |
| 1 | 删除上游转写路径与 `UPSTREAM_TRANSCRIPT_PENDING`（`docs/01` §5.4/§6.1/§8.1、`docs/13` §1/§8） | `ErrorCode` **40/40**（删除该码）；info/描述/示例无上游转写旧路径 | ✅ |
| 2 | ASR=MiniMax `asr-1.0`、LLM=DeepSeek（`docs/13` §2/§3） | `Config.pipeline.asr/analysis` 落地；`TranscriptPayload.provider` 示例 `minimax:asr-1.0` | ✅ |
| 3 | `TranscriptSource` 枚举固定 `[asr]`（`docs/01` §6.1、`docs/05` §2.9） | `TranscriptSource.enum=[asr]`；`CallDetail.transcript.source` / `pipelineDetail.transcript.source` 示例改为 `asr` | ✅ |
| 4 | `TranscriptSegment` 增 `speakerLabel`/`chunkIndex`（`docs/05` §2.9、`docs/13` §4.2） | 字段存在，nullable 描述对齐（块内标签/分块序号） | ✅ |
| 5 | `PipelineTranscriptStage` 增 `chunkCount`/`needsReview`、删 `upstreamTaskId`（`docs/05` §2.9） | 字段存在；`upstreamTaskId` 已无残留；`TranscriptInfo` 补 `needsReview?` | ✅ |
| 6 | `AnalysisPayload` 增 `promptVersion`/`usage`（新增 `AnalysisUsage`）（`docs/05` §2.9、`docs/13` §6.4） | 字段存在；`AnalysisUsage` 内 4 个计数/耗时字段补 `required`（docs 未标 `?`）；示例不涉及 | ✅ |
| 7 | `SpeakerMapping.method` = `[channel, asr_diarization, llm_reconciled, heuristic]` + `needsReview`/`evidence`（`docs/05` §2.9、`docs/13` §4.2） | 枚举与字段均一致 | ✅ |
| 8 | Config/PipelineConfig 重构为 `asr`/`analysis`/`roleMapping` 嵌套（新增 `AsrConfig`/`AnalysisConfig`/`RoleMappingConfig`）（`docs/05` §2.13、`docs/01` §9、`docs/13` §9） | 三个 schema 落地；补齐 docs 示例中字段的 `required`；`Config`/`PipelineConfig` 引用正确 | ✅ |
| 9 | `ConfigPatch` 同步（`docs/05` §4.4） | 复核发现 Lead 原写法在 `ConfigPatch.pipeline` 直接 `$ref` 完整 required schema，导致 PATCH 局部更新语义不成立；已改为**局部对象**（`additionalProperties:false`、无 required） | ✅ 已修复 |
| 10 | `reprocess` options `asrProvider` → `asrModel`（v1 决策；`docs/05` §6.7 待回改，见 §9.2-K12） | `ReprocessRequest.options.asrModel` 已生效（`analysisModel`/`termRulesVersion` 保留） | ✅ |
| 11 | 示例更新：pipeline 配置、transcript `source`/`provider`（`docs/05` §2.13/§6.4） | `GET /config`、`PATCH /config` 响应示例为完整 `pipeline`；CallDetail 示例修正 `source: upstream → asr`、`provider → minimax:asr-1.0`，补 `chunkCount`/`needsReview`/`timeline.submittedAt` | ✅ |
| 12 | `CallTimeline` 增 `submittedAt`（`docs/05` §2.9、`docs/01` §8.2） | `CallTimeline.submittedAt? date-time`；CallDetail 示例已含；`CallSummary.dialedAt` 描述补充"未回填时回退 submittedAt" | ✅ |
| 13 | 配套复核修复（docs/05 最新契约对齐） | ① info 错误码 41→40；② 根 `tags.jobs` 与 `JobType` 删除 `transcript_fetch`/`transcript_pending_wait`（`docs/01` §6.1、`docs/13` §7）；③ `POST /accounts` 重复 accountId 改为 **400 `VALIDATION_FAILED`** 并删除旧 409 响应（`docs/05` §5.2）；④ `startSync`/`testWebhook` 描述 503→**502** `UPSTREAM_UNREACHABLE`（`docs/05` §6.1/§7.8）；⑤ `listCalls.q` 描述 FTS→"归一化全文 LIKE"（`docs/05` §6.2）；⑥ `GET transcript` 的 409 `details.stage` 改为 `asr_queued/asr_running/role_mapping/analysis`（`docs/05` §6.5）；⑦ 清理行尾空格 | ✅ 已修复 |

**本轮同步验证（详见 §7）**：35/35 操作、`$ref` unresolved=0、ErrorCode **40/40**、YAML 可解析、示例校验 0 错误、无敏感信息、无重复 YAML key、429/503 各 35/35。

## 6. 校验方式

> 本阶段（M0）执行环境**不允许安装依赖**，因此未运行 Redocly/Spectral 等需要安装的 linter；
> 已用本机 `python3`（PyYAML 6.0.3）完成语法、结构、引用、枚举、示例与敏感信息自检（结果见 §7）。
> M1 起在 CI 中放开依赖安装后，建议再跑 §6.3 的 linter。

### 6.1 基础校验命令（本机可复现）

```bash
# 1) YAML 语法 / 可解析性
python3 -c "import yaml; yaml.safe_load(open('spec/openapi.yaml', encoding='utf-8')); print('YAML OK')"

# 2) 方法+路径与 docs/05 §3 逐字比对（预期 35/35，match=True）
python3 - <<'PY'
import re, yaml
spec = yaml.safe_load(open('spec/openapi.yaml', encoding='utf-8'))
methods = {'get', 'post', 'put', 'patch', 'delete'}
ops = {(m.upper(), p) for p, item in spec['paths'].items() for m in item if m in methods}
doc = open('docs/05-对外API契约.md', encoding='utf-8').read()
expected = {(m, p.strip()) for m, p in re.findall(
    r'^\|\s*\d+\s*\|\s*`(GET|POST|PUT|PATCH|DELETE)\s+([^`]+)`', doc, re.M)}
print('spec ops:', len(ops), 'docs ops:', len(expected), 'match:', ops == expected)
print('missing:', sorted(expected - ops), 'extra:', sorted(ops - expected))
PY

# 3) $ref 目标存在性（预期全部可解析）
python3 - <<'PY'
import yaml
spec = yaml.safe_load(open('spec/openapi.yaml', encoding='utf-8'))
refs = []
def walk(x):
    if isinstance(x, dict):
        for k, v in x.items():
            walk(v) if k != '$ref' else refs.append(v)
    elif isinstance(x, list):
        for v in x: walk(v)
walk(spec)
def ok(ref):
    node = spec
    for part in ref[2:].split('/'):
        node = node.get(part.replace('~1', '/').replace('~0', '~')) if isinstance(node, dict) else None
        if node is None: return False
    return True
print('refs:', len(refs), 'unique:', len(set(refs)), 'unresolved:', [r for r in refs if not ok(r)])
PY

# 4) ErrorCode 枚举与 docs/01 §5.4 比对（预期 40/40，missing=[] extra=[]）
python3 - <<'PY'
import re, yaml
spec = yaml.safe_load(open('spec/openapi.yaml', encoding='utf-8'))
enum = set(spec['components']['schemas']['ErrorCode']['enum'])
doc01 = open('docs/01-决策与约定.md', encoding='utf-8').read()
codes = set(re.findall(r'^\| `([A-Z_]+)` \| (?:true|false) \|', doc01, re.M))
print('enum:', len(enum), 'docs:', len(codes), 'missing:', sorted(codes - enum), 'extra:', sorted(enum - codes))
PY

# 5) 全局错误覆盖：429/503 响应 + 全局码（预期均 35/35）
python3 - <<'PY'
import yaml
spec = yaml.safe_load(open('spec/openapi.yaml', encoding='utf-8'))
methods = {'get', 'post', 'put', 'patch', 'delete'}
ops = [o for p, i in spec['paths'].items() for m, o in i.items() if m in methods]
print('429:', sum('429' in o['responses'] for o in ops), '/', len(ops),
      '| 503:', sum('503' in o['responses'] for o in ops), '/', len(ops),
      '| common codes:', sum({'RATE_LIMITED', 'SERVICE_UNAVAILABLE'} <= set(o['x-error-codes']) for o in ops), '/', len(ops))
PY

# 6) v1 ASR/LLM 决策关键枚举/结构核验（预期见注释）
python3 - <<'PY'
import yaml
s = yaml.safe_load(open('spec/openapi.yaml', encoding='utf-8'))['components']['schemas']
print('JobType:', s['JobType']['enum'])                       # [login, sync, audio_fetch, asr, analysis, reprocess, backfill]
print('TranscriptSource:', s['TranscriptSource']['enum'])     # [asr]
print('SpeakerMapping.method:', s['SpeakerMapping']['properties']['method']['enum'])
print('PipelineConfig:', list(s['PipelineConfig']['properties']))   # [asr, analysis, roleMapping]
print('submittedAt:', 'submittedAt' in s['CallTimeline']['properties'])
print('AnalysisPayload extra:', [k for k in ('promptVersion', 'usage') if k in s['AnalysisPayload']['properties']])
print('pipeline transcript:', [k for k in ('chunkCount', 'needsReview', 'upstreamTaskId') if k in s['PipelineTranscriptStage']['properties']])
PY
```

### 6.2 敏感信息扫描（预期全部无输出）

```bash
# 完整手机号（含数字边界；号码正则以 \d 书写、脱敏值含 *，故不会误命中；上游雪花 ID 为 19 位数字，不会命中）
grep -nE '(^|[^0-9])1[3-9][0-9]{9}([^0-9]|$)' spec/openapi.yaml
# JWT 字面量
grep -n 'eyJ' spec/openapi.yaml
# 密码字面值
grep -nE 'password"[[:space:]]*:[[:space:]]*"' spec/openapi.yaml
# ASR/LLM API Key 字面值（MiniMax/DeepSeek）
grep -nE 'sk-[A-Za-z0-9]' spec/openapi.yaml
# 适配层内部错误码（不应出现在对外契约）——预期无命中
grep -nE 'BROWSER_LAUNCH_FAILED|CAPTCHA_FAILED|ASR_TIMEOUT' spec/openapi.yaml
```

### 6.3 后续 CI 建议（M1 起，本阶段未执行）

```bash
# 需在允许安装依赖的 CI 中运行（本阶段禁止安装依赖，故未执行）
npx @redocly/cli@latest lint spec/openapi.yaml      # 规范 lint（可加 --extends=recommended）
npx @redocly/cli@latest build-docs spec/openapi.yaml -o spec/redoc.html   # 生成交互式文档
npx @stoplight/spectral-cli lint spec/openapi.yaml  # 备选 linter
# 契约测试：由测试同学据本文件 + docs/05 §8/§9、docs/13 §8 生成用例（M1）
```

Redocly `recommended` 规则会对示例与 schema 的一致性、命名、未使用组件等给出告警；
若告警与 `docs/05`/`docs/01`/`docs/13` 冲突，以文档为准并在此记录豁免（见 §9）。

## 7. 自检结果（2026-11-14，本机 python3.13 + PyYAML 6.0.3，task-11 复核后）

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | YAML 语法（含重复 key 检测、无 tab/行尾空格/CRLF、UTF-8、末尾换行） | **通过**（`YAML OK`；重复 key=0；tabs=0；trailing-ws=0） |
| 2 | 操作数量与 `docs/05` §3 方法+路径逐字比对 | **35/35，match=True**（missing=[]，extra=[]；path item=26） |
| 3 | `operationId` camelCase 且唯一 | **通过**（35 个，唯一=True） |
| 4 | 每个 operation 具备 tags/summary/description/security/parameters/responses/x-side-effects/x-idempotent/x-error-codes | **通过**（缺失=0） |
| 5 | operation 的 tags 均已在根 `tags` 声明；security 统一 `bearerAuth` | **通过** |
| 6 | 需请求体的 POST/PUT/PATCH 均有 `requestBody`（logout/cancel 除外） | **通过** |
| 7 | 2xx JSON 响应均为 `Envelope` + `data` 组合；204 无 content | **通过** |
| 8 | 所有非 `$ref` 响应均带 `X-Request-Id` / `X-Api-Version` 响应头 | **通过** |
| 9 | 路径参数 `{accountId}/{callId}/{jobId}/{termId}` 均在 path/operation 层声明 | **通过** |
| 10 | 分页接口（accounts/calls/call events/sync/jobs/events/terms）`meta` 为 `PagedMeta` | **通过** |
| 11 | `$ref` 目标 | **575 处引用 / 128 唯一目标，unresolved=[]** |
| 12 | `ErrorCode` vs `docs/01` §5.4 | **40/40，missing=[]，extra=[]**（已删 `UPSTREAM_TRANSCRIPT_PENDING`；含 `SERVICE_UNAVAILABLE`；无内部错误码） |
| 13 | schemas 数量与 DTO 齐全性 | **103 个**；`docs/05` §2 全部 DTO、§2.14 十个结果 DTO、`AsrConfig`/`AnalysisConfig`/`RoleMappingConfig`/`AnalysisUsage`/`WebhookConfig` 全部存在 |
| 14 | operation 内联 examples 数量 | **21 个 operation、30 个命名示例**（8 request + 22 response；≥10 要求满足）；另 **12** 个共享错误示例，合计 **42** |
| 15 | 示例与 schema 一致性（环境无 `jsonschema`，用内置子集校验器：type/required/properties/items/allOf/oneOf/enum/const/pattern/min-max 等） | **30 个 operation 示例 + 12 个共享错误示例全部通过（errors=0）** |
| 16 | 敏感信息扫描（完整手机号 / `eyJ` JWT / 密码字面值 / ASR/LLM `sk-` Key / 内部错误码） | **通过**（均无命中） |
| 17 | `x-error-codes` 均为 `ErrorCode` 枚举子集；35/35 含全局 `RATE_LIMITED`+`SERVICE_UNAVAILABLE` | **通过** |
| 18 | 全局错误覆盖：429/503 响应 | **429 35/35；503 35/35**（`docs/05` §8 已明示 429/503 全局） |
| 19 | v1 ASR/LLM 决策核验 | `JobType` 7 值（无 `transcript_fetch`/`transcript_pending_wait`）；`TranscriptSource=[asr]`；`SpeakerMapping.method` 4 值；`PipelineDetail.transcript` 含 `chunkCount`/`needsReview`、无 `upstreamTaskId`；`TranscriptSegment` 含 `speakerLabel`/`chunkIndex`；`AnalysisPayload` 含 `promptVersion`/`usage`；`AnalysisUsage` 4 字段 required；`Config.pipeline` = asr/analysis/roleMapping；`ReprocessRequest.options.asrModel`；`CallTimeline.submittedAt`；CallDetail 示例 `source=asr`/`provider=minimax:asr-1.0` | **通过** |
| 20 | 本轮修复项回归 | info 错误码 41→40；`tags.jobs`/`JobType` 旧作业类型清理；`POST /accounts` 重复 accountId 409→400 `VALIDATION_FAILED`（删 409 响应）；`startSync`/`testWebhook` 描述 503→502；`listCalls.q` FTS→LIKE；transcript 409 stage 新值；`TranscriptInfo.needsReview`；`CallSummary.dialedAt` 回退说明；`ConfigPatch.pipeline` 局部对象；行尾空格清理 | **通过** |

> 备注（与文档的残留差异见 §9.2）：
> 1. `docs/05` §2.7 的 `JobType` 行仍列 `transcript_fetch`/`transcript_pending_wait`，与 `docs/01` §6.1、`docs/13` §7 的删除决定冲突；spec 依 `docs/01`（单一事实源）取 7 值（K11）。
> 2. `docs/05` §6.7 的 reprocess `options` 仍写 `asrProvider?`，spec 已按 v1 决策改为 `asrModel`（K12）。
> 3. `docs/13` §9 的配置示例字段多于 `docs/05` §2.13 对外契约（`responseFormat`/`timestampLevel`/`chunkOverlapSeconds`/`timeoutMs`/`maxRetries`、`roleMapping.lowConfidenceReview`），spec 仅暴露 `docs/05` §2.13 字段（K14）。

## 8. 变更流程

依据 `docs/05` §11 与 `docs/01` §10.2，**同一次变更内**按顺序：

1. 若涉及全局约定（错误码/枚举/封套/幂等/分页/配置结构）→ 先改 `docs/01-决策与约定.md`（单一事实源）；
2. 涉及 ASR/LLM 流水线行为/配置/enum → 改 `docs/13-后处理规格（ASR与LLM）.md`；
3. 再改 `docs/05-对外API契约.md`（人类可读权威：字段/行为/示例/错误矩阵/§2.14 结果 DTO）；
4. 同步修改 `spec/openapi.yaml` 与 `spec/README.md`（本文件 §4 统计、§5 同步记录、§9 待确认项/已知限制）；
5. 更新 `docs/12-里程碑与验收.md` 对应验收项（M0/M1 起）；
6. 运行 §6.1/§6.2 校验命令，并把结果贴到 PR；
7. 评审签字：契约变更需 Lead 确认（涉及 01/13 的需全局评审）。

**兼容性规则**

- 非破坏性变更（新增可选字段/枚举值/接口/新增全局错误码）：在 `/api/v1` 内进行；客户端须容错未知字段与新增枚举值（`docs/01` §5.8）；
- 破坏性变更（字段删除/类型变更/语义变更/必填性收紧，如删除 `UPSTREAM_TRANSCRIPT_PENDING`/旧 JobType）：升 `/api/v2`；v1 内部 M0 阶段的 v1 定稿前变更按 Lead 决策执行并记录于本文件；
- 错误码新增只增不改；废弃错误码必须先标记（已删除的码不得复用）。

**PR 检查清单（spec 部分）**

- [ ] 方法/路径/`operationId` 变更已按兼容性规则处理；
- [ ] 字段名/类型/必填/枚举与 `docs/05`/`docs/01`/`docs/13` 逐字一致（含 §2.14 结果 DTO、40 个稳定错误码、Pipeline/Config 结构）；
- [ ] 每个新增/修改 operation 含 tags/summary/description/security/parameters/requestBody/responses + `x-side-effects`/`x-idempotent`/`x-error-codes`，且声明共享 429/503 响应；
- [ ] 所有响应为 `{ok,data|error,meta}` 封套，错误响应引用 `ErrorResponse`；
- [ ] 示例无真实密码/JWT/完整手机号/API Key（手机号脱敏）；示例中不含适配层内部错误码；示例不出现已删除字段（如 `upstreamTaskId`/`source: upstream`）；
- [ ] `$ref` 全部可解析、无重复 YAML key、无行尾空格；
- [ ] 已跑 §6.1/§6.2 校验。

## 9. 待确认项 / 已知限制

> 9.1 为已解决项（文档已回改、spec 已对齐，保留供追溯）；
> 9.2 为**仍存差异或 OAS 无法表达**的项：不改 docs、仅登记；需 Lead/业务确认后按 §8 流程回改文档或另立契约。

### 9.1 已解决（✅）

| 编号 | 问题 | 解决依据（文档已回改） | spec 状态 |
| --- | --- | --- | --- |
| 1 | 幂等标记 `meta.replayed` vs `meta.idempotencyReplayed` | `docs/01` §5.6 已统一为 `meta.idempotencyReplayed` | ✅ |
| 2 | `UPSTREAM_UNREACHABLE` HTTP 502/503 归属 | `docs/01` §5.4 归 502；`docs/05` §5.6/§6.1 已改为 502 | ✅ |
| 3 | `accountDeletedAt` 未定义 | `docs/05` §2.2 定义 `AccountSummary.deletedAt`（软删除时间） | ✅ |
| 4 | `CallDetail.metadata` 未入表 | `docs/05` §2.9 已列 `metadata?: object` | ✅ |
| 5 | `CallDetail.events` 未入表 | `docs/05` §2.9 已列 `events?: EventRecord[]` | ✅ |
| 6 | `docs/05` §6.4 示例缺 `pipeline`/`audioAvailable` | `docs/05` §6.4 示例已补齐；spec 示例同步 | ✅ |
| 7 | `POST /accounts` 201 data 未定义 DTO | `docs/05` §2.14 定义 `AccountCreateResult` | ✅ |
| 8 | calls 202 / login 200/202 data 未定义 DTO | `docs/05` §2.14 定义 `CallAccepted`/`DryRunResult`/`AccountLoginResult`/`AccountLoginAccepted` | ✅ |
| 9 | `TranscriptPayload.analysis` 类型未明示 | `docs/05` §2.9 明确 `{analysisId, summary, intent?}` | ✅ |
| 10 | `Config.events.webhooks` 元素结构未定义 | `docs/01` §9、`docs/05` §2.13 已定义 | ✅ |
| 11 | `/calls` 日期参数 `from`/`toDate` | `docs/01` §5.5、`docs/05` §6.2 已改为 `dateFrom`/`dateTo` | ✅ |
| 12 | 429 仅 reprocess 声明 | `docs/05` §8 明确 429 适用于全部接口 | ✅ 35/35 |
| 13 | 错误码全集（`SERVICE_UNAVAILABLE` 增/删 `UPSTREAM_TRANSCRIPT_PENDING`） | `docs/01` §5.4：先增至 41、v1 决策后删上游转写码降至 **40** | ✅ 40/40 |
| 14 | `POST /accounts` 重复 accountId 语义（409 CONFLICT/INVALID_REQUEST） | `docs/05` §5.2 已统一为 400 `VALIDATION_FAILED`（`details.fields[]`） | ✅ 已改 400，删除 409 响应 |
| 15 | `docs/05` §6.1 的 202 示例为节选 | `docs/05` §6.1 已明确标注"下面为节选，完整字段见 §2.5" | ✅ 已消歧 |
| 16 | `docs/05` §7.8 webhook 响应与 §2.14 不一致 | `docs/05` §7.8 已改为 `data: WebhookTestResult` + `deliveryError` + 502 | ✅ |
| 17 | `SERVICE_UNAVAILABLE` 503 是否全接口兜底 | `docs/05` §8 已明示"所有接口都可能返回 503 SERVICE_UNAVAILABLE" | ✅ 35/35 |
| 18 | dryRun `estimatedCost: null` vs `?: number` | `docs/05` §2 引言 `?` 允许缺失/为 null；spec 允许 `number|null` 且非必填 | ✅ |
| 19 | 上游转写路径删除（D1） | `docs/01` §6.1/§8.1、`docs/13` §1/§7；spec 删除相关码/类型/示例 | ✅ |
| 20 | ASR=MiniMax / LLM=DeepSeek 的配置与结果结构（D2/D3） | `docs/13` §2/§3/§4/§6/§9、`docs/05` §2.9/§2.13；spec 新增/重构对应 schema 与示例 | ✅ |
| 21 | 旧 JobType（transcript_fetch/transcript_pending_wait）残留 | `docs/01` §6.1、`docs/13` §7 已删除；spec `JobType` 7 值 | ✅（docs/05 §2.7 文本待回改，见 K11） |
| 22 | `CallTimeline.submittedAt`、语气审核摘要字段（chunkCount/needsReview） | `docs/05` §2.9、`docs/01` §8.2 已定义；spec 落地 | ✅ |

### 9.2 仍存差异 / 已知限制（⚠️，需后续决策，不在本轮强建模）

| # | 问题 | spec 当前处理 | 建议 |
| --- | --- | --- | --- |
| K1 | `StatusPayload.accountsDetail` 示例在 `docs/05` §4.2 仍为节选（缺 `AccountSummary` 必填字段） | 示例按 `AccountSummary` 必填补全；schema 中 `accountsDetail` 为 optional | 补全 docs 示例；确认是否恒返回 |
| K2 | `PATCH /config` 的 JSON Merge Patch `null`=删除语义无法用 JSON Schema 表达 | `additionalProperties:false` + 字段清单约束；RFC 7386 语义写在 description | 契约测试补「null=删除并回落默认值、数组整体替换」用例 |
| K3 | `DELETE /accounts/{id}` 的 `confirm` 为条件必填（`purgeData=true` 时），OAS 3.1 参数层无法表达 | 仅 description 说明；SDK 生成器不会自动强制 | 客户端/SDK 显式校验；或改为请求体参数 |
| K4 | `sort` 白名单未完全列出（calls 有 pattern；jobs/events 允许字段与组合未逐项列） | calls 用 pattern；jobs 用 string 默认 `-createdAt`；events 用枚举 | 给出各列表接口排序字段白名单 |
| K5 | 重试依据三轨：`error.retryAfter`（body，绝对时间）/ `Retry-After`（header，秒）/ `details.retryAfterMs` | 按 docs 示例保留，三者并存 | 统一客户端重试依据（建议 header + body 双写并明确优先级） |
| K6 | SSE 控制事件 `stream.reset`（`docs/05` §7.7）不属于 `docs/01` §7.3 持久化 `EventType` | 未纳入 `EventType` 枚举，仅作为 SSE 控制帧在 description 说明 | 若需严格描述 SSE 帧，v1.1 补控制事件枚举 |
| K7 | `GET /accounts/{id}/health` 的 `UPSTREAM_UNREACHABLE`：docs 同时写「探测失败仍返回 200，不报错」又列入错误清单 | `x-error-codes` 保留该码；正确性以 `data.upstream.reachable=false` 为主 | 明确该接口是否可能返回 5xx；如不会，建议从错误清单移除 |
| K8 | `docs/05` §5.2 `concurrency`「默认 1（v1 仅允许 1）」未说明非 1 值错误码 | 请求 schema 用 `minimum: 1` + description；未加 enum | 确认非 1 值是否 `VALIDATION_FAILED` |
| K9 | `CallDetail.metadata` 值类型：docs 仅写 `object`；§6.1 请求侧 metadata 值 ≤256 字符字符串 | spec 用 `additionalProperties: string`（依据 §6.1） | 确认是否允许非 string 值 |
| K10 | `docs/01` §5.4 注：适配层内部错误码不对外，须归一为稳定码 | spec 仅含 40 个稳定码，已核验无内部码 | 实现/契约测试阶段补充「内部码→稳定码」映射测试用例 |
| K11 | **docs 残留（本轮发现）**：`docs/05` §2.7 `JobType` 行仍列 `transcript_fetch`/`transcript_pending_wait`，与 `docs/01` §6.1、`docs/13` §7 冲突 | spec 依单一事实源 `docs/01` 取 7 值（无旧类型） | 建议 Lead 回改 `docs/05` §2.7 |
| K12 | **docs 残留（本轮发现）**：`docs/05` §6.7 reprocess `options` 仍写 `asrProvider?`，v1 决策为 `asrModel`（`docs/13` §6.4 仅提 `analysisModel`） | spec 用 `asrModel?`（保留 `analysisModel?`/`termRulesVersion?`） | 回改 `docs/05` §6.7，并在 `docs/13` §6.4 明确 `asrModel` 语义 |
| K13 | **docs 残留（本轮发现）**：`docs/05` §10.3/§2.9 仍有「上游转写缺失/上游生成有延迟」「上游/ASR 原文」等旧路径措辞（v1 已 100% 本地 ASR） | 不影响字段契约；spec 描述已按本地 ASR 表述 | 建议回改 docs 文案 |
| K14 | **docs 差异（本轮发现）**：`docs/13` §9 配置示例含 `responseFormat`/`timestampLevel`/`chunkOverlapSeconds`/`timeoutMs`/`maxRetries`、`roleMapping.lowConfidenceReview`，但 `docs/05` §2.13 对外契约未列这些字段 | spec 仅暴露 `docs/05` §2.13 字段（`AsrConfig` 6 字段、`AnalysisConfig` 8 字段、`RoleMappingConfig` 2 字段） | 确认这些是否属 `docs/01` §9 所述"内部常量"；若需对外，先改 `docs/05` §2.13 |
| K15 | **OAS 无法表达**：`docs/13` §2.3 分块计划（`Transcript.meta.chunks[]`）、块级重试、§3.4 全量回补/队列策略、§6.4 `rawResponsePath`/`params` 等为内部实现语义 | 对外仅暴露摘要字段（`chunkCount`/`needsReview`/`usage`/`promptVersion`）；无 chunk 级 API | 如需 chunk 级可观测/重跑，另立契约（v1.1） |
| K16 | **OAS 无法表达**：`RoleMappingConfig.method` 的取值集合 docs 未逐项列出（`docs/05` §2.13 示例仅 `auto`；`docs/13` §4.2 给出 4 个映射结果方法） | spec 采用 `[auto, channel, asr_diarization, llm_reconciled, heuristic]`，并在 description 注明 `auto`=按声道自动选择 | 在 docs/05 §2.13 明确 config `method` 允许值 |
| K17 | **OAS 无法表达**：ASR/LLM provider 的细分错误（`providerCode`、限流/鉴权/截断/JSON 非法等）只在 `error.details` 中，无稳定字段 schema；docs/13 §8 仅映射为 `ASR_FAILED`/`ANALYSIS_FAILED` | `error.details` 为宽松 object；对外错误码只用稳定码 | 若客户端需按 provider 错误分支，定义 `details` 稳定字段子 schema |
| K18 | `docs/05` §1.2「异步受理 202 data 至少含 jobId/status/pollUrl」与 `POST /calls` 202（`CallAccepted`=CallSummary，无 jobId）仍不一致 | 以 §2.14 为准（202 data = `CallAccepted`）；spec 示例按 CallSummary 完整字段 | 明确呼出 202 的 data 契约（或明确 §1.2 仅适用于作业类 202） |
| K19 | 事件/作业中与 ASR 分块相关的新语义（如 `call.transcript.ready` 事件 data 的 `source`/`segmentCount`）沿用旧事件字段，未新增 ASR 专属事件/字段 | `EventType` 与事件 data 保持 docs/01 §7.3 原样；分块细节不对外 | 如需观测分块进度，评估新增事件类型（非破坏性） |

## 10. 维护约定

- **只改 spec，不发明语义**：任何文档未出现的字段先补文档、再进 spec；本文件 §9 用于收敛这类差异。
- **示例一律脱敏**：手机号 `138****0000` 形式；禁止真实密码、JWT、API Key（MiniMax/DeepSeek）、完整手机号、真实企业名/个人信息（示例企业名统一用「示例企业」）。
- **新增 operation 模板**：`tags` + `summary` + `description`（引用 `docs/05` 章节号）+ `operationId`（camelCase）+ `security: [{bearerAuth: []}]` + `parameters` + `requestBody`（如有）+ `responses`（成功/错误均带公共响应头，且包含共享 429/503）+ `x-side-effects` + `x-idempotent` + `x-error-codes`（含全局 `RATE_LIMITED`/`SERVICE_UNAVAILABLE`）。
- **错误响应**：优先复用 `components/responses/*`（均引用 `ErrorResponse`）；新增 HTTP 语义时新增共享 response 并在此登记。
- **错误码**：仅使用 `docs/01` §5.4 的 **40 个稳定码**；适配层内部码（ASR/LLM/浏览器等）不得进入对外响应/契约，须归一为稳定码（`docs/13` §8）。
- **v1 流水线**：转写只走本地 ASR（`TranscriptSource=asr`）；不得在契约中恢复上游转写类型/字段/错误码（`UPSTREAM_TRANSCRIPT_PENDING` 已删除）。
- **文件格式**：UTF-8（无 BOM）、LF、2 空格缩进、无 tab/行尾空格、YAML 无重复 key、以单个空行分隔顶层块。
- **版本记录**：本 README 的统计/同步记录/待确认项变更随 spec 变更一起提交；契约级变更记录到 `docs/12-里程碑与验收.md`。
