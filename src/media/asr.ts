// MiniMax ASR 客户端（POST {base}/v1/speech_to_text，multipart/form-data）
//
// 契约：docs/13 §2.1/§2.2/§10；docs/09 §10.2–10.6。
// 响应 verbose_json：{ text, duration, n_speakers, segments[{start,end,speaker,text}], trace_id, base_resp }，
// start/end 为秒（浮点）→ 本地毫秒；speaker 为块内匿名标签 S1/S2/...。
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AsrClient, AsrChunkResult, AsrSegmentRaw } from './types.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';

export interface AsrClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  language: string;
  /** verbose_json（固定；docs/13 §2.1）。 */
  responseFormat?: string;
  /** sentence | word（docs/13 §2.1）。 */
  timestampLevel?: string;
  /** 单块请求总超时（默认 600000ms，与 config.pipeline.asr.timeoutMs 一致）。 */
  timeoutMs?: number;
  /** 单块可重试次数（默认 3，与 config.pipeline.asr.maxRetries 一致）。 */
  maxRetries?: number;
  /** 重试退避基数（默认 1000ms；测试可调小）。 */
  retryBaseMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Pick<Logger, 'debug' | 'warn' | 'error'>;
}

const RESPONSE_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

function err(message: string, opts: { retryable?: boolean; details?: Record<string, unknown>; providerCode?: number | string } = {}): AppError {
  return new AppError('ASR_FAILED', message, {
    retryable: opts.retryable ?? true,
    details: { provider: 'minimax', ...(opts.providerCode !== undefined ? { providerCode: opts.providerCode } : {}), ...(opts.details ?? {}) },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(base: number, attempt: number, retryAfterMs?: number): number {
  const jitter = 0.8 + Math.random() * 0.4;
  const exp = base * 2 ** Math.max(0, attempt - 1) * jitter;
  return Math.max(exp, retryAfterMs ?? 0);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

interface RawAsrResponse {
  text?: unknown;
  duration?: unknown;
  n_speakers?: unknown;
  segments?: unknown;
  trace_id?: unknown;
  traceId?: unknown;
  base_resp?: { status_code?: unknown; status_msg?: unknown } | unknown;
}

function normalizeSegments(raw: unknown, logger?: Pick<Logger, 'warn'>): AsrSegmentRaw[] {
  if (!Array.isArray(raw)) return [];
  const out: AsrSegmentRaw[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const seg = item as Record<string, unknown>;
    const start = Number(seg.start);
    const end = Number(seg.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const beginMs = Math.round(start * 1000);
    const endMs = Math.round(end * 1000);
    if (endMs < beginMs || beginMs < 0) {
      logger?.warn('asr segment skipped (invalid time range)', { beginMs, endMs });
      continue;
    }
    const speaker = typeof seg.speaker === 'string' && seg.speaker.trim() ? seg.speaker.trim() : 'S1';
    out.push({ beginMs, endMs, speakerLabel: speaker, text: typeof seg.text === 'string' ? seg.text : '' });
  }
  out.sort((a, b) => a.beginMs - b.beginMs || a.endMs - b.endMs);
  return out;
}

export function createAsrClient(opts: AsrClientOptions): AsrClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const maxRetries = Math.max(0, opts.maxRetries ?? 3);
  const retryBaseMs = Math.max(1, opts.retryBaseMs ?? 1000);
  const logger = opts.logger;

  return {
    async transcribeChunk(req): Promise<AsrChunkResult> {
      const language = req.language ?? opts.language;
      const perRequestTimeout = req.timeoutMs ?? timeoutMs;
      const audio = await readFile(req.audioPath).catch((e: Error) => {
        throw err(`读取音频文件失败: ${e.message}`, { retryable: false, details: { path: req.audioPath, reason: 'read_audio_failed' } });
      });
      const filename = basename(req.audioPath) || 'chunk.wav';

      for (let attempt = 1; ; attempt++) {
        try {
          return await transcribeOnce({ audio, filename, language, perRequestTimeout });
        } catch (e) {
          const appErr = e instanceof AppError ? e : err(`ASR 请求异常: ${(e as Error).message}`);
          const canRetry = appErr.retryable && attempt <= maxRetries;
          logger?.warn('asr chunk failed', {
            op: 'asrTranscribe',
            attempt,
            maxAttempts: maxRetries + 1,
            code: appErr.code,
            retryable: appErr.retryable,
            willRetry: canRetry,
            details: appErr.details,
          });
          if (!canRetry) throw appErr;
          const retryAfterMs = typeof appErr.details?.retryAfterMs === 'number' ? (appErr.details.retryAfterMs as number) : undefined;
          await sleep(backoffMs(retryBaseMs, attempt, retryAfterMs));
        }
      }
    },
  };

  async function transcribeOnce(ctx: { audio: Buffer; filename: string; language: string; perRequestTimeout: number }): Promise<AsrChunkResult> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(ctx.audio)], { type: 'audio/wav' }), ctx.filename);
    form.append('model', opts.model);
    form.append('response_format', opts.responseFormat ?? 'verbose_json');
    form.append('timestamp_level', opts.timestampLevel ?? 'sentence');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, ctx.perRequestTimeout));
    let response: Response;
    try {
      response = await fetchImpl(`${base}/v1/speech_to_text`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          accept: 'application/json',
          language: ctx.language,
        },
        body: form,
        signal: controller.signal,
      });
    } catch (e) {
      const name = (e as Error).name;
      if (name === 'AbortError' || controller.signal.aborted) {
        throw err('ASR 请求超时', { retryable: true, details: { httpStatus: undefined, timeoutMs: ctx.perRequestTimeout, reason: 'timeout' } });
      }
      throw err(`ASR 网络错误: ${(e as Error).message}`, { retryable: true, details: { reason: 'network' } });
    } finally {
      clearTimeout(timer);
    }

    const status = response.status;
    const textBody = await response.text().catch(() => '');
    if (Buffer.byteLength(textBody, 'utf8') > RESPONSE_BODY_LIMIT_BYTES) {
      throw err('ASR 响应体过大', { retryable: false, details: { httpStatus: status, reason: 'response_too_large' } });
    }

    let parsed: RawAsrResponse | undefined;
    if (textBody.trim()) {
      try {
        parsed = JSON.parse(textBody) as RawAsrResponse;
      } catch {
        throw err('ASR 响应不是合法 JSON', { retryable: status >= 500 || status === 429, details: { httpStatus: status, reason: 'invalid_json' } });
      }
    }

    if (status < 200 || status >= 300) {
      const providerCode = extractProviderCode(parsed);
      const detailMsg = providerDetail(parsed);
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      const retryable = status === 429 || status >= 500;
      throw err(`MiniMax ASR HTTP ${status}${detailMsg ? `: ${detailMsg}` : ''}`, {
        retryable,
        providerCode,
        details: {
          httpStatus: status,
          reason: status === 429 ? 'rate_limit' : status >= 500 ? 'server_error' : 'http_error',
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      });
    }

    if (parsed === undefined) {
      throw err('ASR 响应为空（HTTP 200 无 body）', { retryable: false, details: { httpStatus: status, reason: 'empty_body' } });
    }

    const providerCode = extractProviderCode(parsed);
    if (providerCode !== undefined && String(providerCode) !== '0') {
      // HTTP 200 + base_resp.status_code≠0：供应商业务错误（默认不可重试；429 类由 HTTP 状态覆盖）
      throw err(`MiniMax ASR 业务错误: ${providerDetail(parsed) ?? providerCode}`, {
        retryable: false,
        providerCode,
        details: { httpStatus: status, reason: 'provider_business_error' },
      });
    }

    let segments = normalizeSegments(parsed.segments, logger);
    if (!Array.isArray(parsed.segments)) {
      // 容错：部分音频（静音/非语音/特定编码）verbose_json 不返回 segments 但有 text → 合成单段
      const fallbackText = typeof parsed.text === 'string' ? parsed.text.trim() : '';
      const fallbackDur = Number(parsed.duration);
      if (fallbackText && Number.isFinite(fallbackDur) && fallbackDur > 0) {
        segments = [{ beginMs: 0, endMs: Math.round(fallbackDur * 1000), speakerLabel: 'S1', text: fallbackText }];
        logger?.warn('ASR 响应缺少 segments，已按全文合成单段', { textLength: fallbackText.length });
      } else {
        // 静音声道/非语音：合法返回空结果，不视为失败（双声道拆分时单个声道可能无人说话）
        segments = [];
        logger?.warn('ASR 响应无 segments 且无文本，按静音/空结果处理', { httpStatus: status });
      }
    }
    const durationSec = Number(parsed.duration);
    if (!Number.isFinite(durationSec) || durationSec < 0) {
      throw err('ASR 响应 duration 非法', { retryable: false, details: { httpStatus: status, reason: 'schema_invalid' } });
    }
    const nSpeakersRaw = Number(parsed.n_speakers);
    const distinctSpeakers = new Set(segments.map((s) => s.speakerLabel)).size;
    const nSpeakers = Number.isFinite(nSpeakersRaw) && nSpeakersRaw >= 0 ? nSpeakersRaw : distinctSpeakers;
    const traceId = typeof parsed.trace_id === 'string' && parsed.trace_id ? parsed.trace_id : typeof parsed.traceId === 'string' && parsed.traceId ? parsed.traceId : null;

    return {
      text: typeof parsed.text === 'string' ? parsed.text : segments.map((s) => s.text).join(''),
      durationMs: Math.round(durationSec * 1000),
      nSpeakers,
      segments,
      traceId,
    };
  }
}

function extractProviderCode(parsed: unknown): number | string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const baseResp = (parsed as { base_resp?: unknown }).base_resp;
  if (baseResp && typeof baseResp === 'object') {
    const code = (baseResp as { status_code?: unknown }).status_code;
    if (typeof code === 'number' || typeof code === 'string') return code;
  }
  return undefined;
}

function providerDetail(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const baseResp = (parsed as { base_resp?: unknown }).base_resp;
  if (baseResp && typeof baseResp === 'object') {
    const msg = (baseResp as { status_msg?: unknown }).status_msg;
    if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 200);
  }
  const msg = (parsed as { message?: unknown }).message;
  if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 200);
  return undefined;
}
