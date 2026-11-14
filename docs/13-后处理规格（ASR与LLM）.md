# 13 后处理规格（ASR 与 LLM）

> 本文定义"录音 → 文字 → 结构化分析"的完整实现规格：ASR 供应商接入、长音频切分、说话人分离与角色映射、词表归一、LLM 语义后处理（prompt 契约 / 输出 schema / 校验重试 / 版本化 / 全量回补）。
>
> 地位：**取代原"上游转写优先"路径**。v1 起 **所有转写均由本地平台自建（MiniMax ASR）**，完全不使用飞鸽上游转写；上游 `call-detail-content` 仅保留为侦察/抽样对账用途，**不进入产品流水线**。
>
> 基准文档：[01-决策与约定.md](./01-决策与约定.md)（术语/枚举/错误码）、[05-对外API契约.md](./05-对外API契约.md)（DTO）、[04-数据模型与状态机.md](./04-数据模型与状态机.md)（存储）、[09-上游适配层契约.md](./09-上游适配层契约.md)（上游接入）。
> 状态：v0.1（2026-11-14），关键 API 已用真实密钥实测验证（实测数据见 §2.4/§3.3）。

---

## 1. 决策（已由业务方确认）

| # | 决策 | 结论 |
| --- | --- | --- |
| D1 | 是否使用上游转写 | **不使用**。100% 本地转写（MiniMax ASR） |
| D2 | ASR 供应商 | **MiniMax ASR 云 API**（模型 `asr-1.0`） |
| D3 | LLM 供应商 | **DeepSeek 云 API**（OpenAI 兼容协议） |
| D4 | AI 后处理架构 | **平台内置 pipeline**（不经外部 agent）；外部 agent 仍可通过 MCP/SKILL 读取结果做二次分析 |
| D5 | 批量策略 | **全量跑**（历史话单 + 新话单），不设预算上限；仍需并发控制/重试/可观测 |
| D6 | 说话人分离 | 优先声道分离；单声道用 ASR 自带 diarization（MiniMax 原生返回 `n_speakers`/`speaker`）+ 角色映射 |
| D7 | 词汇归一 | **确定性词表**（`TermRule`）在 ASR 后、LLM 前执行；LLM 不负责改写词表；LLM 输出再做一次确定性归一 |
| D8 | 语义后处理模型 | 默认 `deepseek-chat`（= `deepseek-flash`，快）；JSON 校验失败/低置信度时升级 `deepseek-v4-pro` |

> 密钥只存 `~/.config/feige-outbound/secrets.json`（0600）或环境变量，**禁止**写入 docs/spec/日志/事件。

---

## 2. ASR 接入规格（MiniMax）

### 2.1 接口

```
POST https://api.minimax.cn/v1/speech_to_text        # 国内区域（v1 默认，需匹配 key 区域）；global key 用 https://api.minimax.io
Authorization: Bearer <MINIMAX_API_KEY>
Content-Type: multipart/form-data

表单字段：
  file            音频文件（wav/flac/mp3/m4a/aac/opus/ogg/aiff；≤ 50 MB，≤ 500 秒）
  model           asr-1.0
  response_format verbose_json
  timestamp_level sentence | word
HTTP 头：
  language        zh（BCP-47 语言提示，可省略=自动检测）
```

响应（`verbose_json`，实测 10.3s 双人对话）：

```jsonc
{
  "text": "喂，你好，我是福盟的销售，请问是李总吗？嗯，我是有什么事吗？我们这边用的就是富盟的系统。",
  "duration": 10.356188,
  "n_speakers": 2,
  "segments": [
    { "id": 0, "start": 0.24,  "end": 3.84,  "speaker": "S1", "text": "喂，你好，我是福盟的销售，请问是李总吗？" },
    { "id": 1, "start": 4.28,  "end": 10.08, "speaker": "S2", "text": "嗯，我是有什么事吗？我们这边用的就是富盟的系统。" }
  ],
  "trace_id": "074662e15d71a0c90bead022b675519b"
}
```

- `start`/`end` 单位为**秒（浮点）** → 本地统一转毫秒 `beginMs=round(start*1000)`。
- `speaker` 为 `S1/S2/...` 的**匿名聚类标签**；`n_speakers` 为人数。**不含角色语义**（谁是坐席/客户需本地映射，见 §4）。
- 所有响应带 `base_resp.status_code`（非 0 即错误，需归一为 `ASR_FAILED` 并分类重试）。
- 错误语义：鉴权失败（401/403）、文件超限、格式不支持、时长超限、服务端 5xx、限流（若有）→ 分别映射 `ASR_FAILED`（`details.providerCode`）按可重试性处理。

### 2.2 密钥与配置

```jsonc
// config（非密钥部分）
"pipeline": {
  "asr": {
    "provider": "minimax",
    "baseUrl": "https://api.minimax.cn",    // 需与 key 区域匹配；global key 用 https://api.minimax.io
    "model": "asr-1.0",
    "language": "zh",
    "responseFormat": "verbose_json",
    "timestampLevel": "sentence",
    "chunkSeconds": 420,                    // 单请求音频上限：420s（留 80s 余量）
    "chunkOverlapSeconds": 0,               // 在静音点切分，不重叠（边界句去重）
    "concurrency": 4,
    "timeoutMs": 600000,
    "maxRetries": 3
  }
}
// secrets.json（0600）
{ "minimaxApiKey": "sk-api-...", "deepseekApiKey": "sk-..." }
// 可选环境变量覆盖：FOP_MINIMAX_API_KEY / FOP_DEEPSEEK_API_KEY
```

### 2.3 长音频切分（关键）

上游录音可能超过 MiniMax 单请求上限（**500s / 50MB**，实测约 8 分 20 秒）。切分规则：

1. **时长 ≤ 480s**：整段一次请求（含 50MB 保护：8k stereo 480s≈15MB，安全）。实测录音为 **8kHz/2ch**，因此默认按声道拆分（每块 2 个请求）。
2. **时长 > 480s**：按 **420s 窗口**切分，切点必须落在**静音区间**（能量阈值 + ≥300ms 静音），避免切在句中；窗口尾部若找不到静音点，允许最多延长到 480s 强制切分并标记 `forcedCut=true`。
3. 时间戳拼接：`globalMs = chunkOffsetMs + chunkLocalMs`。
4. 切分计划落库（`Transcript.meta.chunks[]`：`{index, beginMs, endMs, providerTraceId, segments, forcedCut}`），支持断点续跑与重跑单块。
5. 块内 ASR 结果原始 JSON 存 `{dataDir}/asr/{callId}/chunk-{index}.json`（0600），便于审计/重跑，不重复计费。

> 交接语/边界句去重：相邻块边界若出现同一句重复（文本相似度 >0.85 且时间相接），保留前块。

### 2.4 实测性能（真实密钥，2026-11-14）

| 音频 | 时长 | ASR 耗时 | 实时因子 RTF | 备注 |
| --- | --- | --- | --- | --- |
| 双人对话合成样本 | 10.36s | 1.62s | 0.16 | 2 说话人识别正确（S1/S2） |
| 重复拼接样本 | 62.1s | 4.67s | 0.075 | 12 段；n_speakers=2 |

→ 单通 8 分钟录音预计 ASR 约 20–40s；**实测该账号 MiniMax 并发连接上限为 1**（2 并发即 429 `conn limit`），故 ASR 并发固定 1，全量回填约数小时级（回补编排见 §3.4）。

### 2.5 ASR 文本质量问题（必须靠词表解决）

实测：`孚盟 → 福盟 / 富盟 / 复萌` 等同音近音错误稳定出现。这属于领域专有名词识别问题，**不在 ASR 供应商侧解决**，由 §5 词表归一处理；词表需覆盖同音变体（福盟/富盟/复萌/复盟/福梦/弗盟等）。

---

## 3. LLM 后处理接入规格（DeepSeek）

### 3.1 接口

```
POST https://api.deepseek.com/chat/completions
Authorization: Bearer <DEEPSEEK_API_KEY>
Content-Type: application/json

{
  "model": "deepseek-chat",              // = deepseek-flash；升级模型 deepseek-v4-pro
  "messages": [{"role":"system",...},{"role":"user",...}],
  "response_format": {"type": "json_object"},
  "temperature": 0.2,
  "max_tokens": 2000
}
```

- 兼容 OpenAI Chat Completions；`response_format=json_object` 实测有效。
- 可用模型（实测 `/models`）：`deepseek-flash`（别名 `deepseek-chat`，上下文 1M）与 `deepseek-v4-pro`（默认推理 effort=high）。
- **注意**：`deepseek-v4-pro` 默认 reasoning 会消耗大量 `max_tokens`（实测 1200 tokens 全被 reasoning 占用、正文为空）→ 使用 v4-pro 时 `max_tokens ≥ 4096`，或调低 effort；v1 默认用 flash。
- 失败分类：401（密钥）、429（限流，退避重试）、5xx（重试）、`finish_reason=length`（截断 → 提高 max_tokens 重试一次）、JSON 不可解析（带错误提示重试一次，再升级模型）。

### 3.2 配置

```jsonc
"pipeline": {
  "analysis": {
    "provider": "deepseek",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-chat",
    "escalateModel": "deepseek-v4-pro",
    "promptVersion": "analysis-v1",
    "temperature": 0.2,
    "maxTokens": 2000,
    "concurrency": 8,
    "maxRetries": 3,
    "redactPhones": true,
    "redactNames": false
  }
}
```

### 3.3 实测性能

| 模型 | 输入 | 输出 | 耗时 | JSON 合法 |
| --- | --- | --- | --- | --- |
| `deepseek-chat`（flash） | 10s 双人转写 + 元数据（208 prompt tokens） | 265 tokens | **2.3s** | ✅ |
| `deepseek-v4-pro`（默认 effort） | 同上 | 1200 tokens（全 reasoning，正文空） | 15.7s | ⚠️ 需更大 max_tokens |

→ 默认 flash 满足吞吐；升级策略：JSON 校验失败 2 次、或 summary 质量标记低、或业务指定"高价值通话"时用 v4-pro。

### 3.4 全量批量策略（D5：不设预算上限）

- **全量回补**：`feige sync --full` 后自动为全部历史话单入队 `analysis` 作业；也可 `POST /calls/{id}/reprocess` 单条重跑。
- 队列：`analysis` 作业持久化（SQLite），按 `call.endedAt` 升序消费；并发 `pipeline.analysis.concurrency`（默认 8），限速器按供应商响应自适应（429 退避）。
- 断点：每通完成即落库 + `analysis.ready` 事件；进程重启从 `queued/in_progress` 恢复。
- 可观测：作业进度（总数/完成/失败/重试）、token 用量统计（本地累计，仅观测不限额）、失败原因分布。
- 幂等：同 `callId + transcriptId + promptVersion + model` 已 ready 则默认跳过（`reprocess?force=true` 才重跑）。
- 成本可见性：即使不设上限，仍记录每次调用的 token 数/耗时（`AnalysisResult.usage`），便于事后核对。

### 3.5 输入构造与裁剪

```
[元数据]
通话方向=呼出（回拨）; 坐席号码=<脱敏>; 客户号码=<脱敏>; 客户名=<可选>;
线路=<lineName>; 通话时长=<durationSec>s; 开始/结束时间=<ISO>; ASR=minimax asr-1.0
[转写]（已做说话人分离 + 词表归一）
[0] 00:00.24-00:03.84 agent: 喂，你好，我是孚盟的销售，请问是李总吗？
[1] 00:04.28-00:10.08 customer: 嗯，我是，有什么事吗？……
```

- 默认**全量送入**（DeepSeek 上下文 1M tokens，30 分钟通话约 6–10k tokens，无需切分）。
- 超过 `analysis.maxInputChars`（默认 120,000 字符 ≈ 2 小时通话）时：按 20 分钟分块摘要 → 汇总摘要（两阶段）；v1 该分支仅作保护，预计不用。
- PII：默认脱敏电话号码（`138****0000`）；客户名/公司名按 `redactNames` 配置；原始未脱敏转写只在本地库。

---

## 4. 说话人识别与角色映射

### 4.1 两条路径（按录音实际声道选择）

**路径 A：录音为双声道（A/B 分离）** —— **v1 默认且已实测确认**（真实录音 8kHz/2ch）
1. 拆分左右声道为两个单声道音频；
2. 每声道分别 ASR（单声道各自 1 个说话人，标签必为 S1）→ 天然无混叠、无 diarization 误差；
3. 合并两路片段按时间排序；
4. 角色判定：含坐席自报家门/开场白/话术特征的声道 = `agent`，另一路 = `customer`（确定性规则 + LLM 复核，双保险）。

**路径 B：录音为单声道**（当前上游 WAV 疑似单声道，待拨测后 `ffprobe` 确认）
1. 整段 ASR 使用 MiniMax diarization（`n_speakers` + `segments[].speaker`）；
2. 角色映射：
   - 规则打分：坐席特征（自报家门"我是…"、公司名"孚盟"、问候/邀约话术、"请问是X总吗"、语速/话量占比）、客户特征（"不需要""在用""多少钱"、短应答多、被称呼为客户名）；
   - LLM 复核：把转写（S1/S2 标签 + 时间 + 文本）与元数据交给 DeepSeek，要求输出 `{S1: "agent"|"customer", S2: ..., confidence, evidence}`；
   - 规则与 LLM 一致 → 高置信；不一致 → 标记 `roleConfidence=low` + `needsReview=true`，写入事件供人工复核；
3. 角色标签落库：`segment.role = agent|customer|unknown`，`speakerLabel = S1/S2`。

**跨块（长通话 >480s）**：每块独立 ASR，S1/S2 仅在块内有效。处理：
- 优先用路径 A（双声道拆分后每块内角色稳定）；
- 单声道时：块间以**首句连续性 + LLM 全局角色判定**重映射，`speakerMapping.method = "llm_reconciled"`，并在 `Transcript.meta` 标注各块映射表；
- 低置信块标记 `needsReview`（不阻塞入库，事件提示）。

### 4.2 结果字段（对应 API DTO）

| 字段 | 取值 |
| --- | --- |
| `segment.role` | `agent` / `customer` / `unknown` |
| `segment.speakerLabel` | `S1`/`S2`/…（ASR 原始标签） |
| `segment.channel` | 声道号（路径 A 有值；路径 B 为 null） |
| `analysis.speakerMapping.method` | `channel` / `asr_diarization` / `llm_reconciled` / `heuristic` |
| `analysis.speakerMapping.confidence` | 0–1 |
| `analysis.speakerMapping.needsReview` | boolean |
| `analysis.speakerMapping.evidence` | 判定依据（规则命中/LLM 说明，≤200 字） |

> 上游录音声道布局将在首次真实拨测后确认（`ffprobe`）；若确认为 8kHz 双声道，路径 A 成为默认；若为 16kHz 单声道，默认走路径 B。

---

## 5. 词表归一（确定性）

- 数据源：`TermRule`（`from: string[]` 变体 → `to` 标准词，priority 越大越优先，支持启用/分类）。
- 执行时机：ASR 分段后、LLM 前；LLM 输出摘要再执行一次（保证展示一致）。
- 算法：最长优先 + 大小写/全半角/繁简预处理 → 命中替换 → 记录 `{from,to,count}` 到 `termsApplied`。
- 冲突：不同规则命中同一片段时，priority 高者优先；同 priority 按 `to` 长度降序。
- 词表初始建议（实测变体）：

| 标准词 | 建议变体 |
| --- | --- |
| 孚盟 | 复萌、复盟、福萌、福盟、富盟、福梦、弗盟、孚蒙、福蒙 |
| 孚盟软件 | 复盟软件、福盟软件、富盟系统（视上下文，谨慎配置） |

- 词表校验：`to` 不得出现在任何规则 `from` 中（防循环）；变体不得跨规则重复。
- 可选离线任务：从转写中挖掘高频未登录词/疑似同音词 → 生成候选规则 CSV 供人工确认（不影响主流程）。

> **实现现状（v0.3.2）**：内置词表种子已按上表 9 个变体落地（`0002_term_aliases.sql` 迁移 + 当前库；`0001` 保持历史原样以兼容 checksum）；并新增**低成本重归一维护脚本**（不重跑 ASR/LLM）：
>
> ```bash
> npm run terms:renormalize            # dry-run：统计将变化的转写/分析
> npm run terms:renormalize -- --apply # 落库（重算 text_normalized/full_text 与分析文本）
> ```
>
> - 实测覆盖率修复：全库 1,683 条转写中，**516 条**含未覆盖变体（福盟 449 / 富盟 35 / 福蒙 37），重归一后 `normalized/fullText/分析输出` 残留 **0**，`full_text_raw` 保留原文可追溯；
> - 改动词表后**新数据**自动生效；**历史数据**需运行上述脚本（或 `feige calls reprocess`，会重跑 ASR/LLM，成本更高）；
> - 词表调整流程：改规则 → dry-run 检查 → `--apply` → 抽查 `feige calls transcript` / 分析关键词。

---

## 6. LLM 语义后处理规格

### 6.1 系统 prompt（v1，`analysis-v1`）

```text
你是电话销售质检与分析助手。输入是一通电话的元数据与已做说话人分离、已做专有名词归一化的转写。
请输出严格的 JSON 对象，不要输出 markdown、注释或任何 JSON 之外的文本。

分析要求：
1. 只依据输入内容，不得编造未出现的信息；不确定时在对应字段给出 "unknown" 或空值。
2. 不得输出任何电话号码/身份证号等 PII。
3. summary.short 不超过 80 个汉字；summary.bullets 3-5 条，每条不超过 40 字。
4. intent.label 只能是：高意向、中意向、低意向、无意向、需跟进、无效。
   判定标准：明确表达采购/试用/报价意向=高；有交流但未明确=中/需跟进；明确拒绝=无意向；
   空号/错号/非目标人/未实际对话=无效。
5. quality.compliance_issues 仅记录转写中可证实的问题（如未表明身份、承诺无法兑现、辱骂）；
   没有证据则输出空数组；不要臆断。
6. 输出字段必须齐全，值为字符串/数字/布尔/数组/对象，不要用 null 以外的占位符。
```

### 6.2 User 消息结构

```
【元数据】
callId: <call_...>
方向: 呼出（回拨） | 线路: 电信回拨 | 时长: 123s | 开始: 2026-11-14T10:03:00+08:00
坐席号码: 156****0075 | 客户号码: 186****3330 | 客户名: 李总（可空）
ASR: minimax/asr-1.0 | 说话人映射: asr_diarization(confidence 0.86)
【转写】
[0] 00:00.24-00:03.84 agent: 喂，你好，我是孚盟的销售，请问是李总吗？
[1] 00:04.28-00:10.08 customer: 嗯，我是，有什么事吗？……
```

### 6.3 输出 JSON schema（必须严格校验）

```jsonc
{
  "summary": { "short": "string(≤80)", "bullets": ["string(≤40)", "...3-5条"] },
  "intent": { "label": "高意向|中意向|低意向|无意向|需跟进|无效", "score": 0.0 },
  "keywords": ["string", "..."],                       // 3-10 个
  "customer_profile": { "contact_name": "string?", "company": "string?", "role": "string?",
                        "current_vendor": "string?", "status": "string?", "engagement": "string?" },
  "action_items": ["string"],                          // 0-5 条，可执行建议
  "risk_flags": ["string"],                            // 0-5 条；合规/商机风险
  "quality": { "compliance_issues": ["string"], "coaching_points": ["string"] },
  "meta": { "model": "string", "prompt_version": "analysis-v1", "confidence": 0.0 }
}
```

- 校验：zod schema 严格校验（未知字段拒绝/裁剪策略见实现）；枚举白名单；长度上限；`intent.score` 0–1。
- 失败处理：
  1. 第 1 次：原样重试（temperature 不变）；
  2. 第 2 次：附加"上次输出不合法，原因：<校验错误>，请仅输出合法 JSON"重试；
  3. 第 3 次：升级 `escalateModel`（v4-pro，`max_tokens`≥4096）+ 修复提示；
  4. 仍失败：`analysis.failed`，错误 `ANALYSIS_FAILED`，后续可 `reprocess`。
- 后处理：LLM 输出再做**词表归一**（防止摘要里出现变体），并做 PII 扫描（若发现号码则替换为掩码并记录 warning）。

### 6.4 版本化与审计

- `AnalysisResult` 存：`promptVersion`、`model`、`params`（temperature/maxTokens/effort）、`schemaVersion`、`usage`（prompt/completion tokens）、`latencyMs`、`rawRequestHash`、`rawResponsePath`（可选，0600 存档，默认关）。
- prompt 变更流程：新版本号（`analysis-v2`）→ 金标集回归 → 灰度 10% → 全量；`isCurrent` 切换，旧版本保留可追溯。
- 重跑：`reprocess(stages=["analysis"])` 默认使用当前 promptVersion；`options.analysisModel` 可指定模型，`options.asrModel` 可指定 ASR 模型（重跑 transcript 时）。

### 6.5 评测（金标集）

- 构建：20–50 通真实通话（覆盖高/中/低/无意向、长短通话、单/双声道）人工标注 `intent` 与关键事实。
- 指标：
  - JSON 合法率（目标 ≥99.5%）
  - intent 标签准确率（目标 ≥85%）
  - summary 事实一致性（人工抽检，目标 ≥90% 无捏造）
  - 词表变体在最终产物中残留率（目标 0）
  - P50/P95 端到端时延（录音就绪 → analysis.ready）
- 回归：prompt/模型/词表变更必须跑一遍金标集并记录 diff。

---

## 7. 流水线编排（替换 docs/01 §7.2 的上游路径）

```
call.ended（或 no_answer → transcript/analysis 直接 missing/skipped）
  → [audio_fetch]  下载 WAV、sha256、归档
  → [asr]          §2：切分计划 → 分块 ASR → 合并分段（毫秒时间戳、speakerLabel）
  → [normalize]    词表归一（确定性，可内联在 asr 阶段）
  → [role_map]     说话人角色映射（$4；写入 segment.role）
  → [analysis]     LLM 语义后处理（$6）+ 输出再归一
  → 入库 + 事件 call.transcript.ready / call.analysis.ready
```

- 作业类型：`audio_fetch` → `asr` → `analysis`（`transcript_fetch`/`transcript_pending_wait` **删除**）。
- 失败重试：每个阶段独立 job，指数退避最多 5 次；ASR 分块级重试（保留已完成块）。
- 未接通：`audio=missing, transcript=missing, analysis=skipped`。
- 无有效语音（如接通即挂断）：ASR 返回空/极少文本 → `transcript.ready` 且 `segments=[]`，analysis 标记 `skipped`（`reason=no_speech`）并记录。

---

## 8. 错误码映射（新增/删除）

| 场景 | code | HTTP | retryable | 说明 |
| --- | --- | --- | --- | --- |
| ASR 失败（鉴权/格式/超限/5xx/解析） | `ASR_FAILED` | 500/502 | true（部分不可重试，见 details.providerCode） | 累计 5 次失败 → 转写 failed |
| 转写处理中 | `TRANSCRIPT_PENDING` | 409 | true | 本地 ASR 队列中 |
| 无有效语音/无转写 | `TRANSCRIPT_NOT_AVAILABLE` | 422 | false | |
| LLM 失败（校验/超时/限流/鉴权） | `ANALYSIS_FAILED` | 500/502 | true | 可 reprocess |
| 删除：`UPSTREAM_TRANSCRIPT_PENDING` | — | — | — | 不再存在该上游路径 |

> 稳定错误码从 41 个变为 **40 个**（删除 `UPSTREAM_TRANSCRIPT_PENDING`）；其余不变。

---

## 9. 配置与密钥（汇总）

```jsonc
// ~/.config/feige-outbound/config.json（非密钥）
{
  "pipeline": {
    "asr": {
      "provider": "minimax", "baseUrl": "https://api.minimax.cn", "model": "asr-1.0",
      "language": "zh", "responseFormat": "verbose_json", "timestampLevel": "sentence",
      "chunkSeconds": 420, "concurrency": 1, "timeoutMs": 600000, "maxRetries": 3
    },
    "analysis": {
      "provider": "deepseek", "baseUrl": "https://api.deepseek.com",
      "model": "deepseek-chat", "escalateModel": "deepseek-v4-pro",
      "promptVersion": "analysis-v1", "temperature": 0.2, "maxTokens": 2000,
      "concurrency": 8, "maxRetries": 3, "redactPhones": true, "redactNames": false,
      "maxInputChars": 120000
    },
    "roleMapping": { "method": "auto", "llmVerify": true, "lowConfidenceReview": true }
  }
}
// secrets.json（0600，不入库/不入 git）
{ "minimaxApiKey": "sk-api-...", "deepseekApiKey": "sk-..." }
```

环境变量覆盖：`FOP_MINIMAX_API_KEY`、`FOP_DEEPSEEK_API_KEY`、`FOP_ASR_MODEL`、`FOP_ANALYSIS_MODEL`。

> **对外契约 vs 内部常量**：`/config` 对外暴露的 pipeline 字段以 docs/05 §2.13 为准（`asr.provider/baseUrl/model/language/chunkSeconds/concurrency`、`analysis.provider/baseUrl/model/escalateModel/promptVersion/temperature/maxTokens/concurrency`、`roleMapping.method/llmVerify`）。本文 §9 中额外的 `responseFormat`、`timestampLevel`、`chunkOverlapSeconds`、`timeoutMs`、`maxRetries`、`roleMapping.lowConfidenceReview` 属于**实现内部常量**（在 docs/10 运维配置清单集中定义），不进入对外 `/config` 契约。

出站白名单（docs/11）：`api.minimax.io` / `api.minimax.cn` / `api.deepseek.com`（HTTPS 443）。

---

## 10. 安全与合规要点（详见 docs/11）

1. 录音与转写**发送至第三方云**（MiniMax / DeepSeek）：属于个人信息委托处理，需在隐私政策/告知中覆盖；通话录音前应告知客户。
2. 发送前默认**手机号脱敏**；客户姓名默认保留（可配脱敏）；不发送任何登录凭证/上游 token。
3. 供应商侧数据留存策略需确认（MiniMax/DeepSeek 的删除与训练使用条款）→ docs/01 Q4 关联事项。
4. 密钥：仅 secrets 文件/环境变量；`FOP_SECRET_KEY` 加密存储；日志/事件/错误信息严禁输出密钥或 Authorization 头。
5. ASR/LLM 的原始请求/响应默认不落盘（仅存 `traceId`/`usage`）；排障需开 `rawResponsePath` 时按 0600 短留存并脱敏。

---

## 11. 待验证 / 已知限制

| # | 项 | 说明 | 计划 |
| --- | --- | --- | --- |
| 1 | ~~上游录音真实声道布局~~ **已确认**：8kHz/16bit/双声道 A/B（下载后 WAV 头解析：sampleRate=8000, channels=2）；**默认走 §4.1 路径 A（声道拆分）** | v1 实现已按路径 A 落地 | ✅ 已确认（2026-11-14，真实录音） |
| 2 | MiniMax ASR 对真实电话录音效果 | 合成 TTS 效果好；真实 8k 电话音质/口音需评估 | 拨测录���实测，构建金标集 |
| 3 | 长通话切分与跨块说话人一致性 | 单声道长通话的角色重映射可能出错 | 首版 `llm_reconciled`+`needsReview`；v1.1 评估本地声纹嵌入 |
| 4 | MiniMax ASR 并发/限流上限 | 官方未明示；实测并发 10 是否 429 | 实现时压测，配置自适应退避 |
| 5 | DeepSeek v4-pro reasoning 参数 | `reasoning_effort` 等控制未验证；默认 effort 会占满 max_tokens | v1 默认 flash；需要 pro 时 max_tokens≥4096 |
| 6 | 全量 4,000+ 通回补时长 | 估算 ASR+LLM 数小时至一天 | 实现后压测，不设预算上限但可暂停/恢复 |
