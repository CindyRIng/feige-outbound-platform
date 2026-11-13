// 飞鸽 WSS 实时通道客户端：连接后发「连接成功」，每 20s ping，收 pong 更新 lastPongAt，断线指数退避重连。
//
// 契约：docs/00 §2.4（纯文本帧，非 STOMP）、docs/09 §5.12/§6.8（保活/重连/认证类关闭）。
// v1 WS 只做保活与（待补测的）实时事件增强，不作为状态推进的唯一依据。
import type { RealtimeHandle, RealtimeHandler } from './types.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';

export interface RealtimeOptions {
  /** https://host/prefix 或 wss://host/prefix；内部转换并追加 /ws/websocket?token=。 */
  baseUrl: string;
  token: string;
  onMessage?: RealtimeHandler;
  /** ping 间隔（默认 20000ms）。 */
  heartbeatMs?: number;
  /** 连续未收到 pong 的 ping 次数上限（默认 3，超过则断开重连）。 */
  maxMissedPongs?: number;
  /** 重连退避序列（默认 1s/2s/5s/10s/30s/60s）。 */
  reconnectDelaysMs?: number[];
  WebSocketImpl?: typeof WebSocket;
  logger?: Pick<Logger, 'debug' | 'warn'>;
}

const DEFAULT_HEARTBEATS_MS = 20_000;
const DEFAULT_MAX_MISSED = 3;
const DEFAULT_RECONNECT_DELAYS = [1000, 2000, 5000, 10_000, 30_000, 60_000];

/** 把 https/http/wss/ws base 统一转换为 WSS 地址（保留账号路径前缀）。 */
export function buildRealtimeUrl(baseUrl: string, token: string): string {
  const raw = baseUrl.trim().replace(/\/+$/, '');
  let httpLike: string;
  if (/^wss?:\/\//i.test(raw)) httpLike = raw.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
  else if (/^https?:\/\//i.test(raw)) httpLike = raw;
  else throw new AppError('VALIDATION_FAILED', `非法 realtime baseUrl: ${baseUrl}`);
  const url = new URL(httpLike);
  url.protocol = 'wss:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws/websocket`;
  url.search = '';
  url.searchParams.set('token', token);
  return url.toString();
}

export function openRealtime(opts: RealtimeOptions): RealtimeHandle {
  const WebSocketImpl = opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WebSocketImpl) {
    throw new AppError('SERVICE_UNAVAILABLE', '当前 Node 运行时不支持全局 WebSocket，无法建立实时通道');
  }
  const url = buildRealtimeUrl(opts.baseUrl, opts.token);
  const heartbeatMs = Math.max(50, opts.heartbeatMs ?? DEFAULT_HEARTBEATS_MS);
  const maxMissedPongs = Math.max(1, opts.maxMissedPongs ?? DEFAULT_MAX_MISSED);
  const reconnectDelays = opts.reconnectDelaysMs && opts.reconnectDelaysMs.length > 0 ? opts.reconnectDelaysMs : DEFAULT_RECONNECT_DELAYS;
  const logger = opts.logger;

  let ws: WebSocket | null = null;
  let connected = false;
  let closed = false;
  let lastPongAt: string | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let missedPongs = 0;

  const clearTimers = (): void => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  const sendRaw = (text: string): void => {
    try {
      if (ws && ws.readyState === 1) ws.send(text);
    } catch (e) {
      logger?.warn('realtime send failed', { reason: (e as Error).message });
    }
  };

  const scheduleReconnect = (): void => {
    if (closed) return;
    const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)];
    reconnectAttempt++;
    logger?.debug('realtime reconnect scheduled', { delayMs: delay, attempt: reconnectAttempt });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const startHeartbeat = (): void => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    missedPongs = 0;
    heartbeatTimer = setInterval(() => {
      if (!connected) return;
      if (missedPongs >= maxMissedPongs) {
        logger?.warn('realtime heartbeat miss limit reached; reconnecting', { missedPongs });
        try { ws?.close(); } catch { /* ignore */ }
        return;
      }
      missedPongs++;
      sendRaw('ping');
    }, heartbeatMs);
  };

  const connect = (): void => {
    if (closed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocketImpl(url);
    } catch (e) {
      logger?.warn('realtime connect failed', { reason: (e as Error).message });
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.addEventListener('open', () => {
      if (closed) { try { socket.close(); } catch { /* ignore */ } return; }
      connected = true;
      reconnectAttempt = 0;
      logger?.debug('realtime connected');
      sendRaw('连接成功');
      startHeartbeat();
    });
    socket.addEventListener('message', (evt: MessageEvent) => {
      const data = evt.data;
      const text = typeof data === 'string' ? data : data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : String(data ?? '');
      if (text === 'pong' || /(^|\s)pong(\s|$)/.test(text)) {
        lastPongAt = new Date().toISOString();
        missedPongs = 0;
        return;
      }
      if (opts.onMessage) {
        let payload: unknown = text;
        try { payload = JSON.parse(text); } catch { /* 保留原始文本 */ }
        try { opts.onMessage(payload); } catch (e) { logger?.warn('realtime onMessage threw', { reason: (e as Error).message }); }
      }
    });
    socket.addEventListener('error', () => {
      logger?.warn('realtime socket error');
    });
    socket.addEventListener('close', () => {
      connected = false;
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (closed) return;
      logger?.debug('realtime closed; scheduling reconnect');
      scheduleReconnect();
    });
  };

  connect();

  const handle: RealtimeHandle = {
    get connected() { return connected; },
    get lastPongAt() { return lastPongAt; },
    close() {
      closed = true;
      clearTimers();
      connected = false;
      try { ws?.close(); } catch { /* ignore */ }
      ws = null;
    },
  };
  return handle;
}
