// 飞鸽外呼上游 HTTP 客户端（cloud-token 鉴权 + 错误归一 + 读请求重试）
//
// 契约：docs/09 §3/§4/§5/§9/§11；docs/00 §2/§3/§6；docs/01 §8。
// 只使用 Node 内置 fetch；超时默认 15s；GET（读）可重试 2 次，写操作（callV2 等）绝不自动重试。
import type {
  UpstreamCallPageQuery,
  UpstreamCallPageResult,
  UpstreamCallRecord,
  UpstreamClient,
  UpstreamDialResult,
  UpstreamLine,
  UpstreamUserDetail,
} from './types.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const DIAL_WINDOW_RE = /(拨打时间段|拨打时间|7[:：]50\s*[-–—~至]\s*22[:：]00)/;
const NO_SIP_LINE_RE = /未绑定中间号/;

export interface UpstreamClientOptions {
  baseUrl: string;
  token?: string | null;
  /** 单请求超时（默认 15000ms）。 */
  timeoutMs?: number;
  /** GET/读请求最大重试次数（默认 2；总尝试 = 1 + maxRetries）。 */
  maxRetries?: number;
  /** 重试退避基数（默认 500ms；测试可调小）。 */
  retryBaseMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
  /** 内部：读语义的 POST 也允许重试（如 getPage）。 */
  retryableRead?: boolean;
  maxBodyBytes?: number;
}

interface Envelope {
  code?: unknown;
  msg?: unknown;
  message?: unknown;
  data?: unknown;
}

/** 计算下一次拨打窗口开始时间（Asia/Shanghai 固定 UTC+8，上游规则 07:50–22:00）。 */
export function nextDialWindowStartIso(nowMs: number = Date.now(), windowStart = '07:50'): string {
  const [hh, mm] = windowStart.split(':').map((v) => Number(v));
  const startMinutes = (Number.isFinite(hh) ? hh : 7) * 60 + (Number.isFinite(mm) ? mm : 50);
  const local = new Date(nowMs + SHANGHAI_OFFSET_MS);
  const y = local.getUTCFullYear();
  const mo = local.getUTCMonth();
  const d = local.getUTCDate();
  const todayStartUtc = Date.UTC(y, mo, d, 0, startMinutes) - SHANGHAI_OFFSET_MS;
  const targetUtc = nowMs < todayStartUtc ? todayStartUtc : Date.UTC(y, mo, d + 1, 0, startMinutes) - SHANGHAI_OFFSET_MS;
  return new Date(targetUtc + SHANGHAI_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, '+08:00');
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

function upstreamError(code: 'UPSTREAM_UNREACHABLE' | 'UPSTREAM_AUTH_EXPIRED' | 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_BUSINESS_ERROR' | 'UPSTREAM_RESPONSE_INVALID' | 'CALL_OUTSIDE_DIAL_WINDOW' | 'CALL_REJECTED_BY_UPSTREAM', message: string, opts: { retryable?: boolean; details?: Record<string, unknown>; retryAfter?: string } = {}): AppError {
  return new AppError(code, message, { retryable: opts.retryable, details: opts.details, retryAfter: opts.retryAfter });
}

function buildUrl(base: string, path: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(`${base.replace(/\/+$/, '')}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/** 解析上游响应封套并把业务现象归一为 docs/01 §5.4 错误码。 */
function unwrapEnvelope<T>(envelope: unknown, ctx: { path: string; httpStatus: number }): T {
  if (!envelope || typeof envelope !== 'object') {
    throw upstreamError('UPSTREAM_RESPONSE_INVALID', '上游响应不是 JSON 对象', {
      retryable: true,
      details: { path: ctx.path, httpStatus: ctx.httpStatus },
    });
  }
  const env = envelope as Envelope;
  const rawCode = env.code;
  const code = typeof rawCode === 'number' ? rawCode : typeof rawCode === 'string' && rawCode.trim() !== '' ? Number(rawCode) : Number.NaN;
  const message = (typeof env.msg === 'string' && env.msg) || (typeof env.message === 'string' && env.message) || '';
  if (!Number.isFinite(code)) {
    throw upstreamError('UPSTREAM_RESPONSE_INVALID', '上游响应缺少 code 字段', {
      retryable: true,
      details: { path: ctx.path, httpStatus: ctx.httpStatus },
    });
  }
  if (code === 0) return env.data as T;
  if (code === 401) {
    throw upstreamError('UPSTREAM_AUTH_EXPIRED', message || '登录已失效，请重新登录', {
      retryable: true,
      details: { path: ctx.path, httpStatus: ctx.httpStatus, upstreamCode: code },
    });
  }
  // 电信回拨线路级时段限制（实测 2516）：全局 UI 时段 07:50–22:00 之外，线路还可能有更严格时段
  if (code === 2516 || /当前时间段无法调用/.test(message)) {
    throw upstreamError('CALL_OUTSIDE_DIAL_WINDOW', message || '当前时间段无法调用（线路级时段限制）', {
      retryable: true,
      details: { path: ctx.path, httpStatus: ctx.httpStatus, upstreamCode: code, upstreamMessage: message.slice(0, 200), reason: 'line_time_restricted' },
    });
  }
  if (code === 10056) {
    if (DIAL_WINDOW_RE.test(message)) {
      throw upstreamError('CALL_OUTSIDE_DIAL_WINDOW', message || '当前不在可拨号时段（07:50–22:00）', {
        retryable: true,
        retryAfter: nextDialWindowStartIso(),
        details: { path: ctx.path, httpStatus: ctx.httpStatus, upstreamCode: code, upstreamMessage: message.slice(0, 200) },
      });
    }
    if (NO_SIP_LINE_RE.test(message)) {
      throw upstreamError('CALL_REJECTED_BY_UPSTREAM', message || '账号无可用线路（未绑定中间号）', {
        retryable: false,
        details: { path: ctx.path, httpStatus: ctx.httpStatus, upstreamCode: code, upstreamMessage: message.slice(0, 200), reason: 'no_sip_line' },
      });
    }
    throw upstreamError('CALL_REJECTED_BY_UPSTREAM', message || '上游业务拒绝', {
      retryable: false,
      details: { path: ctx.path, httpStatus: ctx.httpStatus, upstreamCode: code, upstreamMessage: message.slice(0, 200) },
    });
  }
  throw upstreamError('UPSTREAM_BUSINESS_ERROR', message || `上游业务错误（code=${code}）`, {
    retryable: false,
    details: { path: ctx.path, httpStatus: ctx.httpStatus, upstreamCode: code, upstreamMessage: message.slice(0, 200) },
  });
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function normalizeRecord(raw: unknown): UpstreamCallRecord {
  if (!raw || typeof raw !== 'object') {
    throw upstreamError('UPSTREAM_RESPONSE_INVALID', '话单列表项不是对象', { retryable: true });
  }
  const r = raw as Record<string, unknown>;
  const idRaw = r.id;
  const id = typeof idRaw === 'string' ? idRaw : typeof idRaw === 'number' && Number.isFinite(idRaw) ? String(idRaw) : '';
  if (!id) {
    throw upstreamError('UPSTREAM_RESPONSE_INVALID', '话单列表项缺少 id（疑似上游改版）', { retryable: true });
  }
  const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : v === null || v === undefined ? null : String(v));
  return {
    ...r,
    id,
    userId: strOrNull(r.userId),
    realName: strOrNull(r.realName),
    phone: strOrNull(r.phone),
    telA: strOrNull(r.telA),
    telB: strOrNull(r.telB),
    telX: strOrNull(r.telX),
    interfaceId: typeof r.interfaceId === 'number' || typeof r.interfaceId === 'string' ? r.interfaceId : null,
    interfaceName: strOrNull(r.interfaceName),
    lineName: strOrNull(r.lineName),
    mode: numOrNull(r.mode),
    callType: numOrNull(r.callType),
    callStatus: numOrNull(r.callStatus),
    callStatusName: strOrNull(r.callStatusName),
    finishStatus: numOrNull(r.finishStatus),
    finishStatusName: strOrNull(r.finishStatusName),
    handle: numOrNull(r.handle),
    duration: numOrNull(r.duration),
    createTime: numOrNull(r.createTime),
    startTime: numOrNull(r.startTime),
    endTime: numOrNull(r.endTime),
    updateTime: numOrNull(r.updateTime),
    preRecordUrl: strOrNull(r.preRecordUrl),
    postage: numOrNull(r.postage),
    agentCode: numOrNull(r.agentCode),
    callerAttr: strOrNull(r.callerAttr),
    calleeAttr: strOrNull(r.calleeAttr),
    sipCodeResult: strOrNull(r.sipCodeResult),
    tenantCode: strOrNull(r.tenantCode),
    enterpriseName: strOrNull(r.enterpriseName),
  };
}

export function createUpstreamClient(opts: UpstreamClientOptions): UpstreamClient {
  const baseUrl = opts.baseUrl;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = Math.max(0, opts.maxRetries ?? 2);
  const retryBaseMs = Math.max(1, opts.retryBaseMs ?? 500);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const logger = opts.logger;
  let token: string | null = opts.token ?? null;

  function shouldRetry(error: AppError): boolean {
    if (!error.retryable) return false;
    return (
      error.code === 'UPSTREAM_UNREACHABLE' ||
      error.code === 'UPSTREAM_RATE_LIMITED' ||
      error.code === 'UPSTREAM_RESPONSE_INVALID'
    );
  }

  async function doRequest<T>(method: 'GET' | 'POST', path: string, ro: RequestOptions = {}): Promise<T> {
    const readRetry = method === 'GET' || ro.retryableRead === true;
    const attempts = readRetry ? maxRetries + 1 : 1;
    let lastError: AppError | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await requestOnce<T>(method, path, ro);
      } catch (e) {
        const appErr = e instanceof AppError ? e : upstreamError('UPSTREAM_UNREACHABLE', (e as Error).message, { retryable: true, details: { path } });
        lastError = appErr;
        const willRetry = readRetry && attempt < attempts && shouldRetry(appErr);
        logger?.warn('upstream request failed', {
          op: path,
          method,
          attempt,
          maxAttempts: attempts,
          code: appErr.code,
          retryable: appErr.retryable,
          willRetry,
        });
        if (!willRetry) throw appErr;
        const retryAfterMs = appErr.retryAfter ? Math.max(0, Date.parse(appErr.retryAfter) - Date.now()) : undefined;
        const jitter = 0.8 + Math.random() * 0.4;
        await sleep(Math.max(retryBaseMs * 2 ** (attempt - 1) * jitter, retryAfterMs ?? 0));
      }
    }
    throw lastError ?? upstreamError('UPSTREAM_UNREACHABLE', '上游请求失败', { retryable: true });
  }

  async function requestOnce<T>(method: 'GET' | 'POST', path: string, ro: RequestOptions): Promise<T> {
    const controller = new AbortController();
    const perTimeout = ro.timeoutMs ?? timeoutMs;
    const timer = setTimeout(() => controller.abort(), Math.max(1, perTimeout));
    const url = buildUrl(baseUrl, path, ro.query);
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'FOP/0.1.0' };
    if (token) headers['cloud-token'] = token;
    let bodyText: string | undefined;
    if (ro.body !== undefined) {
      headers['content-type'] = 'application/json';
      bodyText = JSON.stringify(ro.body);
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: bodyText,
        signal: controller.signal,
      });
    } catch (e) {
      const timedOut = (e as Error).name === 'AbortError' || controller.signal.aborted;
      throw upstreamError('UPSTREAM_UNREACHABLE', timedOut ? '上游请求超时' : `上游网络错误: ${(e as Error).message}`, {
        retryable: true,
        details: { path, method, cause: timedOut ? 'timeout' : 'network', timeoutMs: perTimeout },
      });
    } finally {
      clearTimeout(timer);
    }

    const status = response.status;
    const text = await response.text().catch(() => '');
    const maxBody = ro.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (Buffer.byteLength(text, 'utf8') > maxBody) {
      throw upstreamError('UPSTREAM_RESPONSE_INVALID', '上游响应体超过上限', {
        retryable: false,
        details: { path, httpStatus: status, maxBodyBytes: maxBody },
      });
    }
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

    if (status === 204) return undefined as T;
    if (status === 401) {
      throw upstreamError('UPSTREAM_AUTH_EXPIRED', '登录已失效，请重新登录', {
        retryable: true,
        details: { path, httpStatus: status, reason: 'http-401' },
      });
    }
    if (status === 429) {
      throw upstreamError('UPSTREAM_RATE_LIMITED', '上游限流', {
        retryable: true,
        details: { path, httpStatus: status, reason: 'http-429', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
      });
    }
    if (status < 200 || status >= 300) {
      // 非 2xx 时，仅当响应封套明确给出认证/时段/业务错误时才按封套语义归一；
      // code=0 但仍 5xx 的情况按 HTTP 状态处理（不能把 5xx 当成功）。
      if (text.trim()) {
        try {
          const parsed = JSON.parse(text) as Envelope;
          if (parsed && typeof parsed === 'object' && parsed.code !== undefined) {
            const rawCode = parsed.code;
            const codeNum = typeof rawCode === 'number' ? rawCode : typeof rawCode === 'string' && rawCode.trim() !== '' ? Number(rawCode) : Number.NaN;
            if (codeNum === 401 || codeNum === 10056 || (Number.isFinite(codeNum) && codeNum !== 0 && status < 500)) {
              return unwrapEnvelope<T>(parsed, { path, httpStatus: status });
            }
          }
        } catch {
          /* 忽略，落到下面按 HTTP 状态归一 */
        }
      }
      throw upstreamError(status >= 500 ? 'UPSTREAM_UNREACHABLE' : 'UPSTREAM_BUSINESS_ERROR', `上游 HTTP ${status}`, {
        retryable: status >= 500 || status === 408,
        details: { path, httpStatus: status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
      });
    }

    if (!text.trim()) {
      // 实测：HTTP 200 + 空 body = token 非法/过期（docs/00 §2.3）
      throw upstreamError('UPSTREAM_AUTH_EXPIRED', '登录已失效（上游返回空响应）', {
        retryable: true,
        details: { path, httpStatus: status, reason: 'http-empty' },
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw upstreamError('UPSTREAM_RESPONSE_INVALID', '上游响应不是合法 JSON（疑似改版）', {
        retryable: true,
        details: { path, httpStatus: status },
      });
    }
    return unwrapEnvelope<T>(parsed, { path, httpStatus: status });
  }

  const client: UpstreamClient = {
    request<T>(
      method: 'GET' | 'POST',
      path: string,
      requestOpts?: { query?: Record<string, string | number | undefined>; body?: unknown; timeoutMs?: number },
    ): Promise<T> {
      return doRequest<T>(method, path, requestOpts);
    },
    async getUserDetail(): Promise<UpstreamUserDetail> {
      const data = await doRequest<Record<string, unknown> | null>('GET', '/base/sys/user/userDetail');
      if (!data || typeof data !== 'object') {
        throw upstreamError('UPSTREAM_RESPONSE_INVALID', 'userDetail 响应缺少 data', {
          retryable: true,
          details: { path: '/base/sys/user/userDetail' },
        });
      }
      const str = (v: unknown): string | null => (typeof v === 'string' ? v : v === null || v === undefined ? null : String(v));
      const balance = coerceNumber(data.balance ?? data.pay ?? null);
      return {
        ...data,
        userId: str(data.userId) ?? str(data.id) ?? '',
        realName: str(data.realName),
        mobile: str(data.mobile ?? data.username ?? null),
        tenantCode: str(data.tenantCode),
        enterpriseName: str(data.enterpriseName),
        balance,
      };
    },
    async getCallLineList(): Promise<UpstreamLine[]> {
      const data = await doRequest<unknown>('GET', '/base/api/agent/callLineList');
      if (!Array.isArray(data)) {
        throw upstreamError('UPSTREAM_RESPONSE_INVALID', 'callLineList 响应 data 不是数组', {
          retryable: true,
          details: { path: '/base/api/agent/callLineList' },
        });
      }
      return data.map((item) => {
        const r = (item ?? {}) as Record<string, unknown>;
        const lineId = typeof r.lineId === 'number' || typeof r.lineId === 'string' ? r.lineId : '';
        return {
          lineId,
          lineName: typeof r.lineName === 'string' ? r.lineName : '',
          mode: coerceNumber(r.mode) ?? 0,
          tbpsId: typeof r.tbpsId === 'string' ? r.tbpsId : null,
        };
      });
    },
    async getExistOther(mobile: string): Promise<number> {
      const data = await doRequest<unknown>('GET', '/base/crm/getExistOther', { query: { mobile } });
      // data=0 可拨；非 0 = 客户已存在/占用（v1 不阻断，语义待补测）
      if (data === null || data === undefined) return -1;
      const num = coerceNumber(data);
      if (num !== null) return num;
      if (typeof data === 'object') return 1;
      return 1;
    },
    async dialCall(params: { telB: string; interfaceId: string | number; octCustomerId?: string | null }): Promise<UpstreamDialResult> {
      const body: Record<string, unknown> = { telB: params.telB, interfaceId: params.interfaceId };
      if (params.octCustomerId !== undefined && params.octCustomerId !== null) body.octCustomerId = params.octCustomerId;
      const data = await doRequest<unknown>('POST', '/base/crmV2/callV2', { body });
      if (data === null || data === undefined) return { bindId: null };
      if (typeof data === 'string') return { bindId: data };
      if (typeof data === 'object') {
        const r = data as Record<string, unknown>;
        const bindId = typeof r.bindId === 'string' ? r.bindId : typeof r.bindId === 'number' && Number.isFinite(r.bindId) ? String(r.bindId) : null;
        return { ...r, bindId };
      }
      return { bindId: null };
    },
    async getCallPage(q: UpstreamCallPageQuery): Promise<UpstreamCallPageResult> {
      const body = {
        page: q.page,
        limit: q.limit,
        tenantCode: null,
        realName: null,
        userMobile: null,
        customerMobile: null,
        lineName: null,
        lineId: null,
        callStatus: q.callStatus ?? null,
        beginTime: null,
        finishTime: null,
        startTimeBegin: q.startTimeBegin ?? null,
        startTimeFinish: q.startTimeFinish ?? null,
        endTimeBegin: null,
        endTimeFinish: null,
        callType: q.callType ?? '',
        userIds: q.userIds ?? [],
        callerAttr: '',
        calleeAttr: '',
      };
      const data = await doRequest<{ total?: unknown; list?: unknown } | null>('POST', '/base/call/detail/getPage', { body, retryableRead: true });
      if (!data || typeof data !== 'object' || !Array.isArray(data.list)) {
        throw upstreamError('UPSTREAM_RESPONSE_INVALID', 'getPage 响应缺少 data.list 数组', {
          retryable: true,
          details: { path: '/base/call/detail/getPage' },
        });
      }
      const list = data.list.map((raw) => normalizeRecord(raw));
      const totalNum = coerceNumber(data.total);
      return { total: totalNum !== null ? totalNum : list.length, list };
    },
    async logout(): Promise<void> {
      // 尽力退出：失败只记录，不影响本地登出（docs/09 §5.2）
      try {
        await doRequest<unknown>('POST', '/sso/logout');
      } catch (e) {
        logger?.warn('upstream logout failed (ignored)', { code: (e as AppError).code ?? 'UNKNOWN' });
      }
    },
    setToken(next: string | null): void {
      token = next;
    },
    getToken(): string | null {
      return token;
    },
  };
  return client;
}
