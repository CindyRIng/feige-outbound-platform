// 通用类型与分页/时间工具（与 docs/01 §5 对齐）
export type IsoDateTime = string;
export type DateOnly = string;
export interface Pagination { page: number; size: number; total: number; totalPages: number; }
export interface Meta { requestId: string; ts: IsoDateTime; pagination?: Pagination; idempotencyReplayed?: boolean; }
export interface OkEnvelope<T> { ok: true; data: T; meta: Meta; }
export interface ErrEnvelope { ok: false; error: AppErrorBody; meta: Meta; }
export interface AppErrorBody { code: ErrorCode; message: string; retryable: boolean; retryAfter?: IsoDateTime; details?: Record<string, unknown>; }
export type Envelope<T> = OkEnvelope<T> | ErrEnvelope;

export const CALL_STATUSES = ['pending','dialing','connected','ended','no_answer','failed','canceled'] as const;
export type CallStatus = typeof CALL_STATUSES[number];
export const TERMINAL_CALL_STATUSES: CallStatus[] = ['ended','no_answer','failed','canceled'];

export const STAGE_STATUSES = ['pending','in_progress','ready','missing','failed','skipped'] as const;
export type StageStatus = typeof STAGE_STATUSES[number];

export const JOB_TYPES = ['login','sync','audio_fetch','asr','analysis','reprocess','backfill'] as const;
export type JobType = typeof JOB_TYPES[number];
export const JOB_STATUSES = ['queued','running','succeeded','failed','canceled'] as const;
export type JobStatus = typeof JOB_STATUSES[number];

export const ACCOUNT_STATES = ['online','expired','logging_in','error','disabled','unknown'] as const;
export type AccountState = typeof ACCOUNT_STATES[number];

export const SPEAKER_METHODS = ['channel','asr_diarization','llm_reconciled','heuristic'] as const;
export type SpeakerMappingMethod = typeof SPEAKER_METHODS[number];
export type SpeakerRole = 'agent'|'customer'|'unknown';

export const EVENT_TYPES = [
  'account.login.started','account.login.succeeded','account.login.failed','account.session.expired','account.health.changed',
  'call.created','call.dialing','call.connected','call.ended','call.no_answer','call.failed','call.canceled',
  'call.audio.ready','call.audio.missing','call.audio.failed','call.transcript.ready','call.transcript.failed',
  'call.analysis.ready','call.analysis.failed','sync.started','sync.progress','sync.completed','sync.failed','job.updated',
] as const;
export type EventType = typeof EVENT_TYPES[number];

export const ERROR_CODES = {
  INVALID_REQUEST: { http: 400, retryable: false },
  VALIDATION_FAILED: { http: 400, retryable: false },
  CONFIG_INVALID: { http: 400, retryable: false },
  UNAUTHORIZED: { http: 401, retryable: false },
  FORBIDDEN: { http: 403, retryable: false },
  NOT_FOUND: { http: 404, retryable: false },
  CALL_NOT_FOUND: { http: 404, retryable: false },
  ACCOUNT_NOT_FOUND: { http: 404, retryable: false },
  JOB_NOT_FOUND: { http: 404, retryable: false },
  TERM_NOT_FOUND: { http: 404, retryable: false },
  ACCOUNT_DISABLED: { http: 403, retryable: false },
  ACCOUNT_LOGIN_REQUIRED: { http: 503, retryable: true },
  ACCOUNT_LOGIN_IN_PROGRESS: { http: 409, retryable: true },
  ACCOUNT_LOGIN_FAILED: { http: 422, retryable: true },
  ACCOUNT_BUSY: { http: 409, retryable: true },
  ACCOUNT_UPSTREAM_MISMATCH: { http: 422, retryable: false },
  CALL_OUTSIDE_DIAL_WINDOW: { http: 422, retryable: true },
  CALL_REJECTED_BY_UPSTREAM: { http: 422, retryable: false },
  CALL_NOT_DIALABLE: { http: 422, retryable: false },
  CALL_ALREADY_TERMINAL: { http: 409, retryable: false },
  CALL_NOT_CANCELABLE: { http: 409, retryable: false },
  CALL_TRACKING_TIMEOUT: { http: 202, retryable: true },
  IDEMPOTENCY_CONFLICT: { http: 409, retryable: false },
  RATE_LIMITED: { http: 429, retryable: true },
  UPSTREAM_UNREACHABLE: { http: 502, retryable: true },
  UPSTREAM_AUTH_EXPIRED: { http: 503, retryable: true },
  UPSTREAM_BUSINESS_ERROR: { http: 502, retryable: false },
  UPSTREAM_RATE_LIMITED: { http: 502, retryable: true },
  UPSTREAM_RESPONSE_INVALID: { http: 502, retryable: true },
  AUDIO_NOT_AVAILABLE: { http: 422, retryable: false },
  AUDIO_NOT_READY: { http: 409, retryable: true },
  AUDIO_DOWNLOAD_FAILED: { http: 502, retryable: true },
  TRANSCRIPT_NOT_AVAILABLE: { http: 422, retryable: false },
  TRANSCRIPT_PENDING: { http: 409, retryable: true },
  ASR_FAILED: { http: 502, retryable: true },
  ANALYSIS_FAILED: { http: 502, retryable: true },
  DB_UNAVAILABLE: { http: 503, retryable: true },
  SERVICE_UNAVAILABLE: { http: 503, retryable: true },
  INTERNAL_ERROR: { http: 500, retryable: true },
  NOT_IMPLEMENTED: { http: 501, retryable: false },
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

export const TERM_CATEGORIES = ['company','product','person','custom'] as const;
export type TermCategory = typeof TERM_CATEGORIES[number];

export interface ErrorBrief { code: string; message: string; at: IsoDateTime; details?: Record<string, unknown>; }
