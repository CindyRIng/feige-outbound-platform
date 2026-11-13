// DeepSeek Chat Completions 客户端（OpenAI 兼容）+ 严格 JSON 校验 + 模型升级链
//
// 契约：docs/13 §3（接口/配置/实测）、§6（system prompt analysis-v1、user 输入构造、输出 JSON schema、
// 失败处理：原样重试 → 附校验错误重试 → 升级 deepseek-v4-pro（max_tokens≥4096）→ ANALYSIS_FAILED）、§10.7。
import { z } from 'zod';
import type { AnalysisClient, AnalysisInput, AnalysisOutput } from './types.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';

export const ANALYSIS_PROMPT_VERSION = 'analysis-v1';
export const ANALYSIS_SCHEMA_VERSION = 'analysis-json-v1';
const DEFAULT_TIMEOUT_MS = 120_000;
const RESPONSE_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/** docs/13 §6.1（analysis-v1）原文。 */
export const ANALYSIS_SYSTEM_PROMPT = `你是电话销售质检与分析助手。输入是一通电话的元数据与已做说话人分离、已做专有名词归一化的转写。
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
6. 输出字段必须齐全，值为字符串/数字/布尔/数组/对象，不要用 null 以外的占位符。`;

export interface AnalysisClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  escalateModel: string;
  promptVersion: string;
  temperature: number;
  maxTokens: number;
  escalateMaxTokens: number;
  maxRetries: number;
  /** 单次 HTTP 请求总超时（默认 120s；v4-pro reasoning 可放宽）。 */
  timeoutMs?: number;
  /** 重试退避基数（默认 1000ms；测试可调小）。 */
  retryBaseMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Pick<Logger, 'debug' | 'warn' | 'error'>;
}

const TRIMMED = (max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(max));

const SummarySchema = z.object({
  short: TRIMMED(80),
  bullets: z.array(TRIMMED(40)).min(3).max(5),
});

const IntentLabelSchema = z.enum(['高意向', '中意向', '低意向', '无意向', '需跟进', '无效']);
const IntentSchema = z.object({
  label: IntentLabelSchema,
  score: z.number().min(0).max(1).optional().nullable(),
});

const CustomerProfileSchema = z
  .object({
    contact_name: z.string().optional().nullable(),
    company: z.string().optional().nullable(),
    role: z.string().optional().nullable(),
    current_vendor: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    engagement: z.string().optional().nullable(),
  })
  .optional()
  .nullable();

const QualitySchema = z
  .object({
    compliance_issues: z.array(z.string()).max(20).default([]),
    coaching_points: z.array(z.string()).max(20).default([]),
  })
  .optional()
  .nullable();

const MetaSchema = z
  .object({
    model: z.string().optional(),
    prompt_version: z.string().optional(),
    confidence: z.number().min(0).max(1).optional().nullable(),
  })
  .optional()
  .nullable();

/** docs/13 §6.3 输出 JSON schema（未知字段剥离；枚举白名单；长度上限）。 */
export const ANALYSIS_OUTPUT_SCHEMA = z.object({
  summary: SummarySchema,
  intent: IntentSchema,
  keywords: z.array(TRIMMED(40)).min(1).max(10),
  customer_profile: CustomerProfileSchema,
  action_items: z.array(z.string()).max(5).default([]),
  risk_flags: z.array(z.string()).max(5).default([]),
  quality: QualitySchema,
  meta: MetaSchema,
});

export type AnalysisParsedOutput = z.infer<typeof ANALYSIS_OUTPUT_SCHEMA>;

/** 按 docs/13 §6.2 组装 user 消息（PII 由调用方脱敏后传入）。 */
export function buildAnalysisUserMessage(input: AnalysisInput): string {
  const meta = input.meta;
  const confidence = meta.speakerConfidence;
  const metaBlock = [
    '【元数据】',
    `callId: ${input.callId}`,
    `方向: 呼出（回拨） | 线路: ${meta.lineName ?? '-'} | 时长: ${meta.durationSec ?? '-'}s | 开始: ${meta.startedAt ?? '-'}`,
    `坐席号码: ${meta.fromPhoneMasked ?? '-'} | 客户号码: ${meta.toPhoneMasked} | 客户名: ${meta.customerName ?? '（空）'}`,
    `ASR: ${meta.asrProvider} | 说话人映射: ${meta.speakerMappingMethod}${typeof confidence === 'number' ? `(confidence ${confidence.toFixed(2)})` : ''}`,
  ].join('\n');
  const transcriptBlock =
    input.segments.length === 0
      ? '（无转写分段）'
      : input.segments
          .map(
            (seg, i) =>
              `[${i}] ${formatBeginEnd(seg.beginMs, seg.endMs)} ${seg.role}${seg.speakerLabel ? `(${seg.speakerLabel})` : ''}: ${seg.text}`,
          )
          .join('\n');
  return `${metaBlock}\n【转写】\n${transcriptBlock}`;
}

/** 毫秒 → mm:ss.SS（不足 1h）或 hh:mm:ss.SS（docs/13 §6.2 展示格式）。 */
export function formatBeginEnd(beginMs: number, endMs: number): string {
  return `${formatClock(beginMs)}-${formatClock(endMs)}`;
}

function formatClock(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const centis = Math.floor((totalMs % 1000) / 10);
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const cs = String(centis).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}.${cs}` : `${mm}:${ss}.${cs}`;
}

interface ChatUsage {
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
}

interface ChatCallResult {
  content: string;
  finishReason: string;
  usage: ChatUsage;
  latencyMs: number;
  model: string;
  requestId?: string;
}

function analysisErr(message: string, opts: { retryable?: boolean; details?: Record<string, unknown> } = {}): AppError {
  return new AppError('ANALYSIS_FAILED', message, {
    retryable: opts.retryable ?? true,
    details: { provider: 'deepseek', ...(opts.details ?? {}) },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return m ? m[1].trim() : trimmed;
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

export function createAnalysisClient(opts: AnalysisClientOptions): AnalysisClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = Math.max(0, opts.maxRetries ?? 3);
  const retryBaseMs = Math.max(1, opts.retryBaseMs ?? 1000);
  const promptVersion = opts.promptVersion || ANALYSIS_PROMPT_VERSION;
  const logger = opts.logger;

  async function callChat(model: string, maxTokens: number, messages: { role: 'system' | 'user'; content: string }[], attempt: number): Promise<ChatCallResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          response_format: { type: 'json_object' },
          temperature: opts.temperature,
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      });
    } catch (e) {
      const timedOut = (e as Error).name === 'AbortError' || controller.signal.aborted;
      throw analysisErr(timedOut ? 'DeepSeek 请求超时' : `DeepSeek 网络错误: ${(e as Error).message}`, {
        retryable: true,
        details: { model, attempt, reason: timedOut ? 'timeout' : 'network' },
      });
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Date.now() - startedAt;
    const status = response.status;
    const textBody = await response.text().catch(() => '');
    if (Buffer.byteLength(textBody, 'utf8') > RESPONSE_BODY_LIMIT_BYTES) {
      throw analysisErr('DeepSeek 响应体过大', { retryable: false, details: { httpStatus: status, reason: 'response_too_large' } });
    }
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    if (status < 200 || status >= 300) {
      const retryable = status === 429 || status >= 500;
      throw analysisErr(`DeepSeek HTTP ${status}`, {
        retryable,
        details: {
          httpStatus: status,
          providerCode: status,
          model,
          attempt,
          reason: status === 429 ? 'rate_limit' : status >= 500 ? 'server_error' : 'http_error',
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      });
    }
    let parsed: { choices?: unknown; usage?: unknown; model?: unknown; id?: unknown; error?: unknown };
    try {
      parsed = JSON.parse(textBody) as typeof parsed;
    } catch {
      throw analysisErr('DeepSeek 响应不是合法 JSON', { retryable: true, details: { httpStatus: status, model, attempt, reason: 'invalid_json' } });
    }
    const choices = Array.isArray(parsed.choices) ? (parsed.choices as unknown[]) : [];
    const first = choices[0] as { message?: { content?: unknown }; finish_reason?: unknown } | undefined;
    const content = typeof first?.message?.content === 'string' ? first.message.content : undefined;
    if (!content) {
      throw analysisErr('DeepSeek 响应缺少 choices[0].message.content', {
        retryable: false,
        details: { httpStatus: status, model, attempt, reason: 'schema_invalid' },
      });
    }
    const usageRaw = (parsed.usage ?? {}) as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      content,
      finishReason: typeof first?.finish_reason === 'string' ? first.finish_reason : 'unknown',
      usage: {
        promptTokens: num(usageRaw.prompt_tokens),
        completionTokens: num(usageRaw.completion_tokens),
        totalTokens: num(usageRaw.total_tokens),
      },
      latencyMs,
      model,
      requestId: typeof parsed.id === 'string' ? parsed.id : undefined,
    };
  }

  async function callChatWithRetry(model: string, maxTokens: number, messages: { role: 'system' | 'user'; content: string }[]): Promise<ChatCallResult> {
    let lastError: AppError | undefined;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        return await callChat(model, maxTokens, messages, attempt);
      } catch (e) {
        const appErr = e instanceof AppError ? e : analysisErr(`DeepSeek 调用异常: ${(e as Error).message}`);
        lastError = appErr;
        const canRetry = appErr.retryable && attempt <= maxRetries;
        logger?.warn('analysis chat call failed', {
          op: 'llmChatCompletion',
          attempt,
          maxAttempts: maxRetries + 1,
          model,
          code: appErr.code,
          retryable: appErr.retryable,
          willRetry: canRetry,
          details: appErr.details,
        });
        if (!canRetry) throw appErr;
        const retryAfterMs = typeof appErr.details?.retryAfterMs === 'number' ? (appErr.details.retryAfterMs as number) : undefined;
        const jitter = 0.8 + Math.random() * 0.4;
        await sleep(Math.max(retryBaseMs * 2 ** (attempt - 1) * jitter, retryAfterMs ?? 0));
      }
    }
    throw lastError ?? analysisErr('DeepSeek 调用失败');
  }

  return {
    async analyze(input: AnalysisInput): Promise<AnalysisOutput> {
      if (typeof input.callId !== 'string' || !input.callId) {
        throw new AppError('VALIDATION_FAILED', 'analysis input.callId 必填');
      }
      if (!input.meta || typeof input.meta.toPhoneMasked !== 'string') {
        throw new AppError('VALIDATION_FAILED', 'analysis input.meta.toPhoneMasked 必填');
      }
      if (!Array.isArray(input.segments)) {
        throw new AppError('VALIDATION_FAILED', 'analysis input.segments 必须为数组');
      }
      const userMessage = buildAnalysisUserMessage(input);
      const maxInputChars = Number.isFinite(input.maxInputChars) && input.maxInputChars > 0 ? input.maxInputChars : 120_000;
      if (userMessage.length > maxInputChars) {
        throw new AppError('VALIDATION_FAILED', `分析输入超过 maxInputChars（${userMessage.length} > ${maxInputChars}）`, {
          details: { field: 'input', reason: 'max_input_chars', length: userMessage.length, maxInputChars },
        });
      }

      const baseMessages: { role: 'system' | 'user'; content: string }[] = [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ];
      const attempts: { model: string; maxTokens: number; hint?: string }[] = [
        { model: opts.model, maxTokens: opts.maxTokens },
        { model: opts.model, maxTokens: opts.maxTokens },
        { model: opts.escalateModel, maxTokens: Math.max(opts.escalateMaxTokens, 4096) },
      ];

      let lastFailureReason = '';
      let attemptNo = 0;
      for (let i = 0; i < attempts.length; i++) {
        const plan = attempts[i];
        attemptNo = i + 1;
        const messages = plan.hint ? [...baseMessages, { role: 'user' as const, content: plan.hint }] : [...baseMessages];
        const completion = await callChatWithRetry(plan.model, plan.maxTokens, messages);
        try {
          const parsedJson = JSON.parse(stripJsonFence(completion.content)) as unknown;
          if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
            throw new Error('输出不是 JSON 对象');
          }
          const validated = ANALYSIS_OUTPUT_SCHEMA.parse(parsedJson);
          const raw = parsedJson as Record<string, unknown>;
          return {
            // 以实际请求的模型为准（LLM 自述的 meta.model 不可信，仅保留在 raw 中）
            model: completion.model,
            promptVersion,
            schemaVersion: ANALYSIS_SCHEMA_VERSION,
            raw,
            summary: { short: validated.summary.short, bullets: validated.summary.bullets },
            intent: { label: validated.intent.label, score: validated.intent.score ?? null },
            keywords: validated.keywords,
            customerProfile: (validated.customer_profile ?? null) as Record<string, unknown> | null,
            actionItems: validated.action_items,
            riskFlags: validated.risk_flags,
            quality: validated.quality
              ? {
                  complianceIssues: validated.quality.compliance_issues ?? [],
                  coachingPoints: validated.quality.coaching_points ?? [],
                }
              : null,
            usage: {
              promptTokens: completion.usage.promptTokens ?? null,
              completionTokens: completion.usage.completionTokens ?? null,
              totalTokens: completion.usage.totalTokens ?? null,
              latencyMs: completion.latencyMs,
            },
          };
        } catch (e) {
          const isZod = e instanceof z.ZodError;
          lastFailureReason = isZod ? formatZodIssues(e) : (e as Error).message;
          logger?.warn('analysis output invalid', {
            op: 'llmChatCompletion',
            attempt: attemptNo,
            model: plan.model,
            finishReason: completion.finishReason,
            reason: lastFailureReason.slice(0, 300),
          });
          if (i === attempts.length - 1) break;
          if (completion.finishReason === 'length') {
            // 截断：下一次尝试提升 max_tokens（docs/13 §3.1：finish_reason=length → 提高 max_tokens 重试一次）
            attempts[i + 1] = {
              ...attempts[i + 1],
              maxTokens: Math.max(attempts[i + 1].maxTokens, opts.escalateMaxTokens, 4096),
              hint: `上次输出被截断（finish_reason=length）。请精简输出并仅输出合法 JSON。原因：${lastFailureReason}`,
            };
          } else {
            attempts[i + 1] = {
              ...attempts[i + 1],
              hint: `上次输出不合法，原因：${lastFailureReason}。请仅输出符合 schema 的合法 JSON，不要输出任何 JSON 之外的文本。`,
            };
          }
        }
      }

      throw analysisErr(`DeepSeek 分析失败（已尝试 ${attemptNo} 次，含升级模型 ${opts.escalateModel}）: ${lastFailureReason}`, {
        retryable: true,
        details: { attempts: attemptNo, model: opts.model, escalateModel: opts.escalateModel, reason: 'validation_failed' },
      });
    },
  };
}
