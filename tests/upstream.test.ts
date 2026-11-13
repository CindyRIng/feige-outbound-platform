// 上游客户端 / 实时通道 / 登录编排测试（node:test；不访问真实上游与付费接口）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpstreamClient, nextDialWindowStartIso } from '../src/upstream/client.js';
import { openRealtime, buildRealtimeUrl } from '../src/upstream/realtime.js';
import { runLogin, decodeJwtPayload, resolveLoginWorkerPath } from '../src/upstream/auth.js';
import { AppError } from '../src/errors.js';

// ───────────────────────── 测试工具 ─────────────────────────

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface MockServer {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function startMockServer(
  handler: (ctx: { req: http.IncomingMessage; res: http.ServerResponse; body: Buffer; index: number }) => void | Promise<void>,
): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req).catch(() => Buffer.alloc(0));
    const captured: CapturedRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
    requests.push(captured);
    try {
      await handler({ req, res, body, index: requests.length - 1 });
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(payload));
}

const CALL_RECORD = {
  id: '2121158000000000001',
  userId: '2083119000000000001',
  realName: '宋××',
  phone: '186****3330',
  telA: '156****0075',
  telB: '186****3330',
  interfaceId: '9',
  interfaceName: '电信回拨',
  lineName: '回拨专线',
  mode: 1,
  callType: 1,
  callStatus: 1,
  callStatusName: '已接通',
  finishStatus: 4,
  finishStatusName: '其他',
  handle: 1,
  duration: 15,
  createTime: 1794558473000,
  updateTime: 1794558503000,
  startTime: 1794558478000,
  endTime: 1794558493000,
  preRecordUrl: 'http://112.192.20.62:9876/cloud-api/record/20261113/186****3330_2121158000000000001_hash.wav',
  postage: 0.14,
  callerAttr: '北京 北京',
  calleeAttr: '河北 衡水',
};

// ───────────────────────── 上游 HTTP 客户端 ─────────────────────────

test('client: getUserDetail 成功 + cloud-token 头', async () => {
  const server = await startMockServer(({ res }) =>
    sendJson(res, 200, { code: 0, msg: 'success', data: { userId: 'u-1', realName: '宋××', tenantCode: '24421', balance: 12.5 } }),
  );
  const client = createUpstreamClient({ baseUrl: server.url, token: 'test-cloud-token' });
  try {
    const detail = await client.getUserDetail();
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].method, 'GET');
    assert.equal(server.requests[0].url, '/base/sys/user/userDetail');
    assert.equal(server.requests[0].headers['cloud-token'], 'test-cloud-token');
    assert.equal(detail.userId, 'u-1');
    assert.equal(detail.tenantCode, '24421');
    assert.equal(detail.balance, 12.5);
  } finally {
    await server.close();
  }
});

test('client: getCallPage 请求体字段与响应归一', async () => {
  const server = await startMockServer(({ res }) =>
    sendJson(res, 200, { code: 0, msg: 'success', data: { total: '1073', list: [CALL_RECORD] } }),
  );
  const client = createUpstreamClient({ baseUrl: server.url, token: 'jwt' });
  try {
    const page = await client.getCallPage({ page: 1, limit: 100, startTimeBegin: '2026-11-01', startTimeFinish: '2026-11-14', callStatus: 1, userIds: [] });
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].url, '/base/call/detail/getPage');
    const body = JSON.parse(server.requests[0].body.toString('utf8')) as Record<string, unknown>;
    assert.equal(body.page, 1);
    assert.equal(body.limit, 100);
    assert.equal(body.startTimeBegin, '2026-11-01');
    assert.equal(body.startTimeFinish, '2026-11-14');
    assert.equal(body.callStatus, 1);
    assert.deepEqual(body.userIds, []);
    assert.equal(page.total, 1073);
    assert.equal(page.list.length, 1);
    assert.equal(page.list[0].id, '2121158000000000001');
    assert.equal(typeof page.list[0].createTime, 'number');
    assert.equal(page.list[0].preRecordUrl?.startsWith('http://112.192.20.62:9876/'), true);
  } finally {
    await server.close();
  }
});

test('client: getCallPage 列表项缺 id → UPSTREAM_RESPONSE_INVALID', async () => {
  const server = await startMockServer(({ res }) =>
    sendJson(res, 200, { code: 0, data: { total: 1, list: [{ telB: '186****3330' }] } }),
  );
  const client = createUpstreamClient({ baseUrl: server.url, token: 'jwt', maxRetries: 0 });
  try {
    await assert.rejects(client.getCallPage({ page: 1, limit: 100 }), (e: unknown) => (e as AppError).code === 'UPSTREAM_RESPONSE_INVALID');
  } finally {
    await server.close();
  }
});

test('client: HTTP200 空 body → UPSTREAM_AUTH_EXPIRED', async () => {
  const server = await startMockServer(({ res }) => {
    res.statusCode = 200;
    res.end('');
  });
  const client = createUpstreamClient({ baseUrl: server.url, token: 'expired', maxRetries: 0 });
  try {
    await assert.rejects(client.getUserDetail(), (e: unknown) => (e as AppError).code === 'UPSTREAM_AUTH_EXPIRED');
  } finally {
    await server.close();
  }
});

test('client: code=401 → UPSTREAM_AUTH_EXPIRED（即使 HTTP 200）', async () => {
  const server = await startMockServer(({ res }) => sendJson(res, 200, { code: 401, message: '登录已失效,请重新登录' }));
  const client = createUpstreamClient({ baseUrl: server.url, token: 'expired', maxRetries: 0 });
  try {
    await assert.rejects(client.getCallLineList(), (e: unknown) => (e as AppError).code === 'UPSTREAM_AUTH_EXPIRED');
  } finally {
    await server.close();
  }
});

test('client: 10056 拨打时段 → CALL_OUTSIDE_DIAL_WINDOW + retryAfter 下个窗口', async () => {
  const server = await startMockServer(({ res }) =>
    sendJson(res, 200, { code: 10056, msg: '拨打时间段在7:50-22:00之间', data: null }),
  );
  const client = createUpstreamClient({ baseUrl: server.url, token: 'jwt', maxRetries: 0 });
  try {
    await assert.rejects(client.dialCall({ telB: '186****3330', interfaceId: 1 }), (e: unknown) => {
      const err = e as AppError;
      assert.equal(err.code, 'CALL_OUTSIDE_DIAL_WINDOW');
      assert.ok(err.retryAfter, 'retryAfter 应该存在');
      assert.match(String(err.retryAfter), /\+\d{2}:\d{2}$/);
      assert.ok(Date.parse(String(err.retryAfter)) > Date.now(), 'retryAfter 应在未来');
      return true;
    });
  } finally {
    await server.close();
  }
});

test('client: 10056 未绑定中间号 → CALL_REJECTED_BY_UPSTREAM', async () => {
  const server = await startMockServer(({ res }) => sendJson(res, 200, { code: 10056, msg: '用户未绑定中间号', data: null }));
  const client = createUpstreamClient({ baseUrl: server.url, token: 'jwt', maxRetries: 0 });
  try {
    await assert.rejects(client.dialCall({ telB: '186****3330', interfaceId: 1 }), (e: unknown) => (e as AppError).code === 'CALL_REJECTED_BY_UPSTREAM');
  } finally {
    await server.close();
  }
});

test('client: GET 5xx 自动重试 2 次（共 3 次尝试）', async () => {
  const server = await startMockServer(({ res }) => sendJson(res, 500, { error: 'boom' }));
  const client = createUpstreamClient({ baseUrl: server.url, token: 'jwt', maxRetries: 2, retryBaseMs: 5 });
  try {
    await assert.rejects(client.getUserDetail(), (e: unknown) => (e as AppError).code === 'UPSTREAM_UNREACHABLE');
    assert.equal(server.requests.length, 3);
  } finally {
    await server.close();
  }
});

test('client: 写操作（dialCall）5xx 不重试', async () => {
  const server = await startMockServer(({ res }) => sendJson(res, 500, { error: 'boom' }));
  const client = createUpstreamClient({ baseUrl: server.url, token: 'jwt', maxRetries: 2, retryBaseMs: 5 });
  try {
    await assert.rejects(client.dialCall({ telB: '186****3330', interfaceId: 1 }), (e: unknown) => (e as AppError).code === 'UPSTREAM_UNREACHABLE');
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('client: dialCall 成功解析 bindId', async () => {
  const server = await startMockServer(({ res }) => sendJson(res, 200, { code: 0, msg: 'success', data: { bindId: 'bind-123' } }));
  const client = createUpstreamClient({ baseUrl: server.url, token: 'jwt' });
  try {
    const result = await client.dialCall({ telB: '186****3330', interfaceId: 1 });
    assert.equal(result.bindId, 'bind-123');
    const body = JSON.parse(server.requests[0].body.toString('utf8')) as Record<string, unknown>;
    assert.deepEqual(body, { telB: '186****3330', interfaceId: 1 });
  } finally {
    await server.close();
  }
});

test('client: getExistOther 语义（0 可拨 / 非 0 存在 / null 未知）', async () => {
  let n = 0;
  const server = await startMockServer(({ res }) => {
    n++;
    if (n === 1) sendJson(res, 200, { code: 0, data: 0 });
    else if (n === 2) sendJson(res, 200, { code: 0, data: 1 });
    else sendJson(res, 200, { code: 0, data: null });
  });
  const client = createUpstreamClient({ baseUrl: server.url, token: 'jwt' });
  try {
    assert.equal(await client.getExistOther('186****3330'), 0);
    assert.equal(await client.getExistOther('186****3330'), 1);
    assert.equal(await client.getExistOther('186****3330'), -1);
    assert.match(server.requests[0].url, /\/base\/crm\/getExistOther\?mobile=/);
  } finally {
    await server.close();
  }
});

test('client: 非法 JSON → UPSTREAM_RESPONSE_INVALID', async () => {
  const server = await startMockServer(({ res }) => {
    res.statusCode = 200;
    res.end('<html>gateway</html>');
  });
  const client = createUpstreamClient({ baseUrl: server.url, token: 'jwt', maxRetries: 0 });
  try {
    await assert.rejects(client.getUserDetail(), (e: unknown) => (e as AppError).code === 'UPSTREAM_RESPONSE_INVALID');
  } finally {
    await server.close();
  }
});

test('client: setToken 更新 cloud-token', async () => {
  const server = await startMockServer(({ res }) => sendJson(res, 200, { code: 0, data: {} }));
  const client = createUpstreamClient({ baseUrl: server.url, token: 'old' });
  try {
    await client.getUserDetail();
    client.setToken('new-token');
    assert.equal(client.getToken(), 'new-token');
    await client.getUserDetail();
    assert.equal(server.requests[1].headers['cloud-token'], 'new-token');
  } finally {
    await server.close();
  }
});

test('client: 超时 → UPSTREAM_UNREACHABLE（cause=timeout）', async () => {
  const server = await startMockServer(async ({ res }) => {
    await new Promise((r) => setTimeout(r, 300));
    sendJson(res, 200, { code: 0, data: {} });
  });
  const client = createUpstreamClient({ baseUrl: server.url, token: 'jwt', maxRetries: 0, timeoutMs: 40 });
  try {
    await assert.rejects(client.getUserDetail(), (e: unknown) => {
      const err = e as AppError;
      assert.equal(err.code, 'UPSTREAM_UNREACHABLE');
      assert.equal((err.details as Record<string, unknown>).cause, 'timeout');
      return true;
    });
  } finally {
    await server.close();
  }
});

test('client: logout 失败被忽略（尽力退出）', async () => {
  const server = await startMockServer(({ res }) => sendJson(res, 500, { error: 'boom' }));
  const client = createUpstreamClient({ baseUrl: server.url, token: 'jwt', maxRetries: 0 });
  try {
    await assert.doesNotReject(client.logout());
  } finally {
    await server.close();
  }
});

test('client: nextDialWindowStartIso 计算 Asia/Shanghai 下个窗口（+08:00）', () => {
  // 2026-11-14T13:00:00+08:00 → 下一个 07:50 是 11-15
  const next = nextDialWindowStartIso(Date.parse('2026-11-14T13:00:00+08:00'));
  assert.equal(next, '2026-11-15T07:50:00+08:00');
  // 凌晨 03:00 → 当天 07:50
  const sameDay = nextDialWindowStartIso(Date.parse('2026-11-14T03:00:00+08:00'));
  assert.equal(sameDay, '2026-11-14T07:50:00+08:00');
});

test('client: code 为字符串 "0" 视为成功（宽容解析）', async () => {
  const server = await startMockServer(({ res }) => sendJson(res, 200, { code: '0', data: [{ lineId: 9, lineName: '电信回拨', mode: 1 }] }));
  const client = createUpstreamClient({ baseUrl: server.url, token: 'jwt' });
  try {
    const lines = await client.getCallLineList();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].lineName, '电信回拨');
    assert.equal(lines[0].mode, 1);
  } finally {
    await server.close();
  }
});

test('client: HTTP 403 → UPSTREAM_BUSINESS_ERROR（不重试）', async () => {
  const server = await startMockServer(({ res }) => sendJson(res, 403, { code: 403, msg: '无权限' }));
  const client = createUpstreamClient({ baseUrl: server.url, token: 'jwt', maxRetries: 2, retryBaseMs: 5 });
  try {
    await assert.rejects(client.getUserDetail(), (e: unknown) => {
      const err = e as AppError;
      assert.equal(err.code, 'UPSTREAM_BUSINESS_ERROR');
      assert.equal(err.retryable, false);
      return true;
    });
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

// ───────────────────────── 实时通道 ─────────────────────────

type WsListener = (evt: Record<string, unknown>) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, WsListener[]>();
  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: WsListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type: string, evt: Record<string, unknown> = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(evt);
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(String(data));
  }
  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }
}

test('realtime: URL 转换（https → wss + 路径 + token）', () => {
  assert.equal(
    buildRealtimeUrl('https://feige.duofangtongxin.com/duofang-feige-admin', 'abc.def'),
    'wss://feige.duofangtongxin.com/duofang-feige-admin/ws/websocket?token=abc.def',
  );
  assert.equal(
    buildRealtimeUrl('wss://feige.duofangtongxin.com/duofang-feige-admin/', 't'),
    'wss://feige.duofangtongxin.com/duofang-feige-admin/ws/websocket?token=t',
  );
});

test('realtime: open 后发「连接成功」、收 pong 更新 lastPongAt、心跳发 ping、close 停止重连', async () => {
  FakeWebSocket.instances = [];
  const handle = openRealtime({
    baseUrl: 'https://feige.duofangtongxin.com/duofang-feige-admin',
    token: 'jwt-token',
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    heartbeatMs: 50,
    reconnectDelaysMs: [20],
  });
  try {
    const ws = FakeWebSocket.instances[0];
    assert.match(ws.url, /^wss:\/\/feige\.duofangtongxin\.com\/duofang-feige-admin\/ws\/websocket\?token=/);
    ws.readyState = 1;
    ws.emit('open');
    assert.equal(handle.connected, true);
    assert.deepEqual(ws.sent, ['连接成功']);
    assert.equal(handle.lastPongAt, null);

    ws.emit('message', { data: 'pong' });
    assert.ok(handle.lastPongAt, 'pong 后 lastPongAt 有值');

    // 等待一次心跳（heartbeatMs=50ms），应发送 ping
    await new Promise((r) => setTimeout(r, 90));
    assert.ok(ws.sent.includes('ping'), `期望心跳 ping，实际 ${JSON.stringify(ws.sent)}`);
  } finally {
    handle.close();
  }
  assert.equal(handle.connected, false);
  assert.equal(FakeWebSocket.instances.length, 1, 'close 后不应再重连');
});

test('realtime: 断线后指数退避重连（新连接）', async () => {
  FakeWebSocket.instances = [];
  const handle = openRealtime({
    baseUrl: 'https://feige.duofangtongxin.com/duofang-feige-admin',
    token: 'jwt-token',
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    heartbeatMs: 1000,
    reconnectDelaysMs: [20],
  });
  try {
    assert.equal(FakeWebSocket.instances.length, 1);
    FakeWebSocket.instances[0].readyState = 1;
    FakeWebSocket.instances[0].emit('open');
    FakeWebSocket.instances[0].emit('close', {});
    assert.equal(handle.connected, false);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(FakeWebSocket.instances.length, 2, 'close 后应按退避重连');
  } finally {
    handle.close();
  }
});

// ───────────────────────── 自动登录编排（fake spawn，不启动浏览器）─────────────────────────

function makeJwt(expEpochSec: number, iatEpochSec = expEpochSec - 604800): string {
  const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ userId: 'u-1', username: '156****0075', iat: iatEpochSec, exp: expEpochSec })}.signature`;
}

interface FakeSpawnPlan {
  stdout?: string;
  stderr?: string;
  code?: number;
  neverClose?: boolean;
  captured?: { command: string; args: string[]; env?: NodeJS.ProcessEnv };
  credFileContent?: string;
}

function fakeSpawn(plan: FakeSpawnPlan): typeof import('node:child_process').spawn {
  return ((command: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    if (plan.captured) {
      plan.captured.command = command;
      plan.captured.args = args;
      plan.captured.env = opts?.env;
    }
    const child = new EventEmitter() as unknown as ChildProcess & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (sig?: NodeJS.Signals) => boolean;
    };
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    (child as unknown as { stdout: PassThrough }).stdout = stdout;
    (child as unknown as { stderr: PassThrough }).stderr = stderr;
    (child as unknown as { kill: () => boolean }).kill = () => {
      if (plan.neverClose) return true;
      setTimeout(() => child.emit('close', null, 'SIGKILL'), 1);
      return true;
    };
    if (!plan.neverClose) {
      setTimeout(() => {
        // 验证凭证文件在 spawn 时确实存在且为 0600（由 runLogin 写入）
        try {
          if (plan.captured && args[2]) plan.credFileContent = readFileSync(args[2], 'utf8');
        } catch { /* ignore */ }
        if (plan.stdout) stdout.write(plan.stdout);
        if (plan.stderr) stderr.write(plan.stderr);
        stdout.end();
        stderr.end();
        setTimeout(() => child.emit('close', plan.code ?? 0, null), 5);
      }, 5);
    }
    return child as unknown as ChildProcess;
  }) as unknown as typeof import('node:child_process').spawn;
}

let authTmp: string;
before(async () => {
  authTmp = await mkdtemp(join(tmpdir(), 'fop-login-'));
});

after(async () => {
  await rm(authTmp, { recursive: true, force: true });
});

async function makeAuthFixtures(): Promise<{ cloakRun: string; worker: string }> {
  const cloakRun = join(authTmp, 'cloak-run');
  const worker = join(authTmp, 'login-worker.mjs');
  await writeFile(cloakRun, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await writeFile(worker, '// fake worker\n', { mode: 0o600 });
  return { cloakRun, worker };
}

test('auth: runLogin 成功（fake spawn）：解析 JWT、写 0600 临时凭证并清理', async () => {
  const { cloakRun, worker } = await makeAuthFixtures();
  const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
  const jwt = makeJwt(exp);
  const captured: NonNullable<FakeSpawnPlan['captured']> = { command: '', args: [] };
  const plan: FakeSpawnPlan = { stdout: JSON.stringify({ ok: true, jwt, jwtExpiresAt: new Date(exp * 1000).toISOString() }) + '\n', code: 0, captured };
  const configDir = join(authTmp, 'cfg-ok');
  const profileDir = join(authTmp, 'data', 'profiles', 'main');
  const result = await runLogin({
    accountId: 'main',
    username: '13800138000',
    password: 'fake-password-123',
    profileDir,
    headless: false,
    configDir,
    cloakRunPath: cloakRun,
    workerPath: worker,
    spawnImpl: fakeSpawn(plan),
    env: { DISPLAY: ':0' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.jwt, jwt);
  assert.equal(result.jwtExpiresAt, new Date(exp * 1000).toISOString());
  assert.equal(captured.command, cloakRun);
  assert.equal(captured.args[0], 'node');
  assert.equal(captured.args[1], worker);
  assert.match(captured.args[2], /\.login-main-[0-9a-f]+\.json$/);
  assert.equal(captured.env?.DISPLAY, ':0');
  assert.ok(plan.credFileContent, 'spawn 时应能读到临时凭证文件');
  const cred = JSON.parse(plan.credFileContent as string) as Record<string, unknown>;
  assert.equal(cred.username, '13800138000');
  assert.equal(cred.password, 'fake-password-123');
  // 临时凭证文件已清理
  await assert.rejects(access(captured.args[2]), /ENOENT/);
});

test('auth: worker 返回 CAPTCHA_FAILED → LoginResult.ok=false + reason', async () => {
  const { cloakRun, worker } = await makeAuthFixtures();
  const plan: FakeSpawnPlan = { stdout: JSON.stringify({ ok: false, reason: 'CAPTCHA_FAILED', needHuman: true }) + '\n', code: 1 };
  const result = await runLogin({
    accountId: 'main',
    username: '13800138000',
    password: 'p',
    profileDir: join(authTmp, 'data', 'profiles', 'main2'),
    headless: false,
    configDir: join(authTmp, 'cfg-fail'),
    cloakRunPath: cloakRun,
    workerPath: worker,
    spawnImpl: fakeSpawn(plan),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CAPTCHA_FAILED');
});

test('auth: worker 无 JSON 结果（非 0 退出）→ WORKER_ERROR（errorDetail 已脱敏）', async () => {
  const { cloakRun, worker } = await makeAuthFixtures();
  const plan: FakeSpawnPlan = { stdout: '', stderr: '[login-worker] failed for 13800138000\n', code: 2 };
  const result = await runLogin({
    accountId: 'main',
    username: '13800138000',
    password: 'p',
    profileDir: join(authTmp, 'data', 'profiles', 'main3'),
    headless: false,
    configDir: join(authTmp, 'cfg-noresult'),
    cloakRunPath: cloakRun,
    workerPath: worker,
    spawnImpl: fakeSpawn(plan),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'WORKER_ERROR');
  assert.ok(!String(result.errorDetail ?? '').includes('13800138000'), 'errorDetail 中手机号应脱敏');
});

test('auth: cloak-run 不存在 → CLOAK_RUN_MISSING', async () => {
  const result = await runLogin({
    accountId: 'main',
    username: 'u',
    password: 'p',
    profileDir: join(authTmp, 'data', 'profiles', 'main4'),
    headless: false,
    configDir: join(authTmp, 'cfg-nocloak'),
    cloakRunPath: join(authTmp, 'not-exists-cloak-run'),
    workerPath: join(authTmp, 'login-worker.mjs'),
    spawnImpl: fakeSpawn({}),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CLOAK_RUN_MISSING');
});

test('auth: 超时 kill worker → LOGIN_TIMEOUT', async () => {
  const { cloakRun, worker } = await makeAuthFixtures();
  const result = await runLogin({
    accountId: 'main',
    username: '13800138000',
    password: 'p',
    profileDir: join(authTmp, 'data', 'profiles', 'main5'),
    headless: false,
    configDir: join(authTmp, 'cfg-timeout'),
    cloakRunPath: cloakRun,
    workerPath: worker,
    spawnImpl: fakeSpawn({ neverClose: true }),
    timeoutMs: 1000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'LOGIN_TIMEOUT');
});

test('auth: decodeJwtPayload / resolveLoginWorkerPath', async () => {
  const exp = Math.floor(Date.now() / 1000) + 100;
  const payload = decodeJwtPayload(makeJwt(exp));
  assert.equal(payload?.exp, exp);
  assert.equal(payload?.userId, 'u-1');
  assert.equal(decodeJwtPayload('not-a-jwt'), null);
  const worker = resolveLoginWorkerPath();
  assert.ok(worker && worker.endsWith('login-worker.mjs'), `resolveLoginWorkerPath=${worker}`);
  const content = await readFile(worker as string, 'utf8');
  // worker 关键实现点（真实浏览器流程无法在单测中执行，用静态断言守卫）
  assert.match(content, /launchPersistentContext/);
  assert.match(content, /#aliyunCaptcha-sliding-wrapper/);
  assert.match(content, /#aliyunCaptcha-sliding-slider/);
  assert.match(content, /\/sso\/login/);
  assert.match(content, /ensureAgreementAccepted/);
  assert.match(content, /CLOUD_TOKEN|localStorage/);
  assert.match(content, /HOME_URL_RE/);
  // 语法必须合法（worker 为 .mjs 纯 JS，不参与 tsc 编译）
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, ['--check', worker as string], { stdio: 'pipe' });
});
