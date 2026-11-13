import { ERROR_CODES, type ErrorCode } from './types/common.js';
import type { IsoDateTime } from './types/common.js';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly retryAfter?: IsoDateTime;
  constructor(code: ErrorCode, message: string, opts: { retryable?: boolean; details?: Record<string, unknown>; retryAfter?: IsoDateTime } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.retryable = opts.retryable ?? ERROR_CODES[code].retryable;
    this.details = opts.details;
    this.retryAfter = opts.retryAfter;
  }
  get httpStatus(): number { return ERROR_CODES[this.code].http; }
  toBody() {
    return { code: this.code, message: this.message, retryable: this.retryable, ...(this.retryAfter ? { retryAfter: this.retryAfter } : {}), ...(this.details ? { details: this.details } : {}) };
  }
}

export function asAppError(err: unknown, fallbackCode: ErrorCode = 'INTERNAL_ERROR'): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError(fallbackCode, message);
}

export function notFound(code: ErrorCode, message: string): never { throw new AppError(code, message); }
export function badRequest(code: ErrorCode = 'VALIDATION_FAILED', message = '参数校验失败', details?: Record<string, unknown>): never { throw new AppError(code, message, { details }); }
export function internal(message: string, details?: Record<string, unknown>): never { throw new AppError('INTERNAL_ERROR', message, { details }); }
