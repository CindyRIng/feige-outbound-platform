// REST 客户端与 CLI 通用工具：CLI/MCP 都是 REST v1 的薄封装（docs/06 §3、docs/07 §3）。
// 不 import 服务内部实现；仅使用标准库 fetch。
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { VERSION } from '../version.js';
export { VERSION };
export const DEFAULT_API = 'http://127.0.0.1:8710/api/v1';
export const MCP_SERVER_NAME = 'feige-outbound';

export interface GlobalOpts {
  api?: string;
  token?: string;
  tokenFile?: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  timeout?: string | number;
  yes?: boolean;
  noColor?: boolean;
}

export interface Meta {
  requestId: string;
  ts: string;
  pagination?: { page: number; size: number; total: number; totalPages: number };
  idempotencyReplayed?: boolean;
}

export interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  retryAfter?: string;
  details?: Record<string, unknown>;
}

export interface OkEnvelope<T> { ok: true; data: T; meta: Meta }
export interface ErrEnvelope { ok: false; error: ErrorBody; meta: Meta }
export type Envelope<T> = OkEnvelope<T> | ErrEnvelope;

export interface ApiResponse<T> {
  status: number;
  data: T;
  meta: Meta;
  headers: Headers;
}

/** 稳定错误码 → CLI 退出码（docs/06 §3.7） */
const EXIT_BY_CODE: Record<string, number> = {
  INVALID_REQUEST: 2, VALIDATION_FAILED: 2, CONFIG_INVALID: 2,
  NOT_FOUND: 3, CALL_NOT_FOUND: 3, ACCOUNT_NOT_FOUND: 3, JOB_NOT_FOUND: 3, TERM_NOT_FOUND: 3,
  FORBIDDEN: 4, ACCOUNT_DISABLED: 4, ACCOUNT_BUSY: 4, ACCOUNT_UPSTREAM_MISMATCH: 4,
  CALL_OUTSIDE_DIAL_WINDOW: 4, CALL_NOT_DIALABLE: 4, CALL_ALREADY_TERMINAL: 4, CALL_NOT_CANCELABLE: 4,
  IDEMPOTENCY_CONFLICT: 4, RATE_LIMITED: 4, AUDIO_NOT_AVAILABLE: 4, AUDIO_NOT_READY: 4,
  TRANSCRIPT_NOT_AVAILABLE: 4, TRANSCRIPT_PENDING: 4,
  UPSTREAM_UNREACHABLE: 5, UPSTREAM_AUTH_EXPIRED: 5, UPSTREAM_BUSINESS_ERROR: 5, UPSTREAM_RATE_LIMITED: 5,
  UPSTREAM_RESPONSE_INVALID: 5, CALL_REJECTED_BY_UPSTREAM: 5, CALL_TRACKING_TIMEOUT: 5, AUDIO_DOWNLOAD_FAILED: 5,
  UNAUTHORIZED: 6, ACCOUNT_LOGIN_REQUIRED: 6, ACCOUNT_LOGIN_IN_PROGRESS: 6, ACCOUNT_LOGIN_FAILED: 6,
  INTERNAL_ERROR: 7, DB_UNAVAILABLE: 7, ASR_FAILED: 7, ANALYSIS_FAILED: 7,
  SERVICE_UNAVAILABLE: 9, NOT_IMPLEMENTED: 10,
};

const RETRYABLE = new Set([
  'ACCOUNT_LOGIN_REQUIRED', 'ACCOUNT_LOGIN_IN_PROGRESS', 'ACCOUNT_LOGIN_FAILED', 'ACCOUNT_BUSY',
  'CALL_OUTSIDE_DIAL_WINDOW', 'CALL_TRACKING_TIMEOUT', 'RATE_LIMITED',
  'UPSTREAM_UNREACHABLE', 'UPSTREAM_AUTH_EXPIRED', 'UPSTREAM_RATE_LIMITED', 'UPSTREAM_RESPONSE_INVALID',
  'AUDIO_NOT_READY', 'TRANSCRIPT_PENDING', 'ASR_FAILED', 'ANALYSIS_FAILED',
  'DB_UNAVAILABLE', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR',
]);

export type TransportKind = 'connect' | 'timeout';

export class CliError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly retryAfter?: string;
  readonly httpStatus?: number;
  readonly transport?: TransportKind;
  readonly requestId?: string;
  constructor(code: string, message: string, opts: { retryable?: boolean; details?: Record<string, unknown>; retryAfter?: string; httpStatus?: number; transport?: TransportKind; requestId?: string } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE.has(code);
    this.details = opts.details;
    this.retryAfter = opts.retryAfter;
    this.httpStatus = opts.httpStatus;
    this.transport = opts.transport;
    this.requestId = opts.requestId;
  }
  get exitCode(): number { return exitCodeFor(this); }
}

export function exitCodeFor(err: CliError): number {
  if (err.transport === 'connect') return 8;
  if (err.transport === 'timeout') return 9;
  if (err.code in EXIT_BY_CODE) return EXIT_BY_CODE[err.code];
  if (err.httpStatus) {
    if (err.httpStatus === 400) return 2;
    if (err.httpStatus === 401) return 6;
    if (err.httpStatus === 403 || err.httpStatus === 409 || err.httpStatus === 422 || err.httpStatus === 429) return 4;
    if (err.httpStatus === 404) return 3;
    if (err.httpStatus === 501) return 10;
    if (err.httpStatus === 502) return 5;
    if (err.httpStatus >= 500) return 7;
  }
  return 1;
}

const CODE_BY_HTTP: Record<number, string> = {
  400: 'INVALID_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CALL_ALREADY_TERMINAL', 422: 'VALIDATION_FAILED', 429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR', 501: 'NOT_IMPLEMENTED', 502: 'UPSTREAM_UNREACHABLE', 503: 'SERVICE_UNAVAILABLE',
};

export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new CliError('INTERNAL_ERROR', msg);
}

export function newRequestId(prefix = 'req_cli'): string {
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function nowIso(): string { return new Date().toISOString().replace('Z', '+00:00'); }

export function errorEnvelope(err: unknown): ErrEnvelope {
  const e = toCliError(err);
  const error: ErrorBody = {
    code: e.code, message: e.message, retryable: e.retryable,
    ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}),
    ...(e.details ? { details: e.details } : {}),
  };
  return { ok: false, error, meta: { requestId: e.requestId ?? newRequestId(), ts: nowIso() } };
}

export function okEnvelope<T>(data: T, meta?: Partial<Meta>): OkEnvelope<T> {
  return { ok: true, data, meta: { requestId: meta?.requestId ?? newRequestId(), ts: meta?.ts ?? nowIso(), ...(meta?.pagination ? { pagination: meta.pagination } : {}) } };
}

/** 解析时长：`500ms` / `30s` / `5m` / 纯数字=毫秒 */
export function parseDuration(v: string | number | undefined, fallbackMs = 30_000): number {
  if (v === undefined || v === null || v === '') return fallbackMs;
  if (typeof v === 'number') return Math.max(1, v);
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i.exec(String(v).trim());
  if (!m) throw new CliError('VALIDATION_FAILED', `非法时长: ${v}（示例 30s / 5m / 500ms）`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'ms').toLowerCase();
  return Math.max(1, Math.round(unit === 'm' ? n * 60_000 : unit === 's' ? n * 1000 : n));
}

export function resolveApiBase(api?: string): string {
  const raw = cmdArg(api) ?? process.env.FOP_API_URL ?? DEFAULT_API;
  let base = raw.trim().replace(/\/+$/, '');
  if (!/\/api\/v\d+$/.test(base)) base = `${base}/api/v1`;
  return base.replace(/\/+$/, '');
}

function cmdArg(v?: string): string | undefined {
  const s = v?.trim();
  return s ? s : undefined;
}

export function configDir(): string {
  return process.env.FOP_CONFIG_DIR ?? join(homedir(), '.config', 'feige-outbound');
}
export function defaultTokenFile(): string { return join(configDir(), 'api-token'); }
export function tokenFileFor(opts: GlobalOpts): string {
  return cmdArg(opts.tokenFile) ?? process.env.FOP_API_TOKEN_FILE ?? defaultTokenFile();
}
export function readToken(opts: GlobalOpts): string | undefined {
  const direct = cmdArg(opts.token) ?? cmdArg(process.env.FOP_API_TOKEN);
  if (direct) return direct;
  const file = tokenFileFor(opts);
  try { if (existsSync(file)) { const t = readFileSync(file, 'utf8').trim(); if (t) return t; } } catch { /* ignore */ }
  return undefined;
}
export function requireToken(opts: GlobalOpts): string {
  const t = readToken(opts);
  if (!t) throw new CliError('UNAUTHORIZED', `本地 API token 不存在：${tokenFileFor(opts)}（可设置 FOP_API_TOKEN 或执行 feige doctor --fix-token）`);
  return t;
}
export function fixToken(): { tokenFile: string; created: boolean } {
  const file = defaultTokenFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t) { try { chmodSync(file, 0o600); } catch { /* ignore */ } return { tokenFile: file, created: false }; }
  }
  const token = `fop_${cryptoRandomHex(24)}`;
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* ignore */ }
  return { tokenFile: file, created: true };
}
function cryptoRandomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function encodeQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) { if (v.length) usp.set(k, v.join(',')); continue; }
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

export type QueryValue = string | number | boolean | (string | number | boolean)[] | undefined | null;

export class ApiClient {
  readonly base: string;
  private readonly opts: GlobalOpts;
  private readonly timeoutMs: number;
  constructor(opts: GlobalOpts = {}) {
    this.opts = opts;
    this.base = resolveApiBase(opts.api);
    this.timeoutMs = parseDuration(opts.timeout, 30_000);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json', 'X-Request-Id': newRequestId(), ...extra };
    const token = readToken(this.opts);
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  private async doFetch(method: string, path: string, options: { query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string>; accept?: string }): Promise<Response> {
    if (!readToken(this.opts)) requireToken(this.opts); // 抛出 UNAUTHORIZED（exit 6）
    const url = `${this.base}${path.startsWith('/') ? path : `/${path}`}${encodeQuery(options.query)}`;
    this.log(`${method} ${url}`);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { ...this.headers({ ...(options.accept ? { Accept: options.accept } : {}), ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers }) },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error & { name?: string; cause?: { code?: string } };
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new CliError('SERVICE_UNAVAILABLE', `请求超时（${this.timeoutMs}ms）：${this.base}`, { transport: 'timeout' });
      const code = e?.cause?.code ?? e?.name;
      throw new CliError('SERVICE_UNAVAILABLE', `无法连接本地服务 ${this.base}：${code ?? e?.message ?? 'connect failed'}`, { transport: 'connect', details: { endpoint: this.base } });
    }
    return res;
  }

  private log(msg: string): void {
    if (this.opts.verbose) process.stderr.write(`[feige:verbose] ${msg}\n`);
  }

  private async parseEnvelope<T>(res: Response): Promise<ApiResponse<T>> {
    const requestId = res.headers.get('x-request-id') ?? undefined;
    const text = await res.text();
    let parsed: { ok?: unknown; data?: unknown; meta?: Meta; error?: ErrorBody } | undefined;
    if (text) { try { parsed = JSON.parse(text) as typeof parsed; } catch { parsed = undefined; } }
    if (parsed && parsed.ok === false) {
      const err: ErrorBody = parsed.error ?? { code: CODE_BY_HTTP[res.status] ?? 'INTERNAL_ERROR', message: text.slice(0, 200), retryable: false };
      throw new CliError(err.code, err.message, { retryable: err.retryable, details: err.details, retryAfter: err.retryAfter, httpStatus: res.status, requestId: parsed.meta?.requestId ?? requestId });
    }
    if (!res.ok) {
      const code = CODE_BY_HTTP[res.status] ?? (res.status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST');
      const message = parsed?.error?.message || text.slice(0, 300) || `HTTP ${res.status}`;
      throw new CliError(code, message, { httpStatus: res.status, requestId });
    }
    if (res.status === 204) {
      return { status: 204, data: null as T, meta: { requestId: requestId ?? newRequestId(), ts: nowIso() }, headers: res.headers };
    }
    if (parsed && parsed.ok === true) {
      return { status: res.status, data: parsed.data as T, meta: parsed.meta ?? { requestId: requestId ?? newRequestId(), ts: nowIso() }, headers: res.headers };
    }
    // 非封套直返：整体作为 data
    return { status: res.status, data: (parsed as T) ?? (text as unknown as T), meta: { requestId: requestId ?? newRequestId(), ts: nowIso() }, headers: res.headers };
  }

  async request<T = unknown>(method: string, path: string, options: { query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string> } = {}): Promise<ApiResponse<T>> {
    const res = await this.doFetch(method, path, options);
    return this.parseEnvelope<T>(res);
  }
  get<T = unknown>(path: string, query?: Record<string, unknown>): Promise<ApiResponse<T>> { return this.request<T>('GET', path, { query }); }
  post<T = unknown>(path: string, body?: unknown, opts: { headers?: Record<string, string> } = {}): Promise<ApiResponse<T>> { return this.request<T>('POST', path, { body, headers: opts.headers }); }
  patch<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>> { return this.request<T>('PATCH', path, { body }); }
  put<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>> { return this.request<T>('PUT', path, { body }); }
  del<T = unknown>(path: string, query?: Record<string, unknown>): Promise<ApiResponse<T>> { return this.request<T>('DELETE', path, { query }); }

  /** 二进制下载（录音）：返回 Buffer 与响应头 */
  async download(path: string, query?: Record<string, unknown>): Promise<{ status: number; buffer: Buffer; headers: Headers }> {
    const res = await this.doFetch('GET', path, { query, accept: 'audio/wav' });
    if (!res.ok) {
      const text = await res.text();
      let env: Envelope<unknown> | undefined;
      try { env = text ? JSON.parse(text) as Envelope<unknown> : undefined; } catch { /* ignore */ }
      if (env && !env.ok) throw new CliError(env.error.code, env.error.message, { httpStatus: res.status, details: env.error.details, requestId: env.meta?.requestId });
      throw new CliError(CODE_BY_HTTP[res.status] ?? 'INTERNAL_ERROR', text.slice(0, 300) || `HTTP ${res.status}`, { httpStatus: res.status });
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buffer, headers: res.headers };
  }

  async sse(path: string, query: Record<string, unknown> | undefined, onEvent: (ev: SseEvent) => void, opts: { signal?: AbortSignal; lastEventId?: string } = {}): Promise<void> {
    requireToken(this.opts);
    const url = `${this.base}${path.startsWith('/') ? path : `/${path}`}${encodeQuery(query)}`;
    this.log(`GET ${url} (SSE)`);
    const headers = this.headers({ Accept: 'text/event-stream', ...(opts.lastEventId ? { 'Last-Event-ID': opts.lastEventId } : {}) });
    const timeoutSignal = AbortSignal.timeout(Math.max(this.timeoutMs, 24 * 3600_000));
    const signal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;
    let res: Response;
    try {
      res = await fetch(url, { headers, signal });
    } catch (err) {
      const e = err as Error;
      if (opts.signal?.aborted) return;
      throw new CliError('SERVICE_UNAVAILABLE', `SSE 连接失败：${e.message}`, { transport: e.name === 'TimeoutError' ? 'timeout' : 'connect' });
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new CliError(CODE_BY_HTTP[res.status] ?? 'INTERNAL_ERROR', text.slice(0, 300) || `HTTP ${res.status}`, { httpStatus: res.status });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = parseSseBlock(block);
          if (ev) onEvent(ev);
        }
      }
    } catch (err) {
      if (!opts.signal?.aborted) throw err;
    }
  }
}

export interface SseEvent { event?: string; id?: string; data: string }
function parseSseBlock(block: string): SseEvent | undefined {
  let event: string | undefined; let id: string | undefined; const dataLines: string[] = [];
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon >= 0 ? line.slice(0, colon) : line;
    const value = colon >= 0 ? line.slice(colon + 1).replace(/^ /, '') : '';
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (!dataLines.length && !event) return undefined;
  return { event, id, data: dataLines.join('\n') };
}

/** ---------------- CLI 输出 ---------------- */
export function writeJson(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
export function writeLine(line = ''): void { process.stdout.write(`${line}\n`); }
export function writeErr(line: string): void { process.stderr.write(`${line}\n`); }

export function printError(err: unknown, opts: GlobalOpts): void {
  const e = toCliError(err);
  if (opts.json) { writeJson(errorEnvelope(e)); return; }
  writeErr(`✖ ${e.code}: ${e.message}`);
  if (e.retryAfter) writeErr(`  retryAfter: ${e.retryAfter}`);
  if (e.retryable) writeErr('  （可重试）');
}

export function printOk(data: unknown, opts: GlobalOpts, human: () => void): void {
  if (opts.json) { writeJson(okEnvelope(data)); return; }
  if (!opts.quiet) human();
}

export function table(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)));
  const fmt = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  writeLine(fmt(headers));
  for (const r of rows) writeLine(fmt(r));
}

export function kv(pairs: Array<[string, string]>): void {
  const w = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) writeLine(`${k.padEnd(w)}  ${v}`);
}

export function oneLine(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export function flatten(obj: unknown, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (obj === null || typeof obj !== 'object') { out.push([prefix || '-', oneLine(obj)]); return out; }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...flatten(v, key));
    else out.push([key, oneLine(v)]);
  }
  return out;
}

export function isoToHuman(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function msToTimestamp(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const rest = (s % 60).toFixed(2).padStart(5, '0');
  return `${String(m).padStart(2, '0')}:${rest}`;
}

/** 从 REST 响应构造同构 envelope（用于二进制/本地结果） */
export function envelopeFrom<T>(res: ApiResponse<T>): OkEnvelope<T> {
  return { ok: true, data: res.data, meta: res.meta };
}

export function requireYes(opts: GlobalOpts & { dryRun?: boolean }, action: string): void {
  if (opts.dryRun) return;
  if (opts.yes) return;
  if (process.stdin.isTTY) return;
  throw new CliError('INVALID_REQUEST', `非交互模式执行「${action}」必须显式加 --yes（或先 --dry-run 查看计划）`);
}

export function confirmInteractive(action: string): boolean {
  if (!process.stdin.isTTY) return false;
  return true;
}

export function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
