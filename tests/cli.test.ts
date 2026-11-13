// CLI / MCP 接入层测试：使用本地 mock REST server（不依赖 Lead 的 serve 实现）。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const MAIN = join(ROOT, 'dist', 'src', 'main.js');

const cleanupDirs: string[] = [];
after(() => { for (const d of cleanupDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `feige-${prefix}-`));
  cleanupDirs.push(d);
  return d;
}

interface Captured { method: string; path: string; query: URLSearchParams; headers: IncomingMessage['headers']; body: string }
type Handler = (req: Captured, res: ServerResponse) => void;
interface MockServer { base: string; captured: Captured[]; server: Server; close: () => Promise<void> }

function envelope(data: unknown, meta: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: true, data, meta: { requestId: 'req_test', ts: '2026-11-14T00:00:00+08:00', ...meta } });
}
function errorBody(code: string, message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: false, error: { code, message, retryable: false, ...extra }, meta: { requestId: 'req_test', ts: '2026-11-14T00:00:00+08:00' } });
}

async function startMock(routes: Record<string, Handler>): Promise<MockServer> {
  const captured: Captured[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const item: Captured = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body };
      captured.push(item);
      const key = `${item.method} ${item.path}`;
      const handler = routes[key] ?? routes[`${item.method} *`];
      if (handler) handler(item, res);
      else { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(errorBody('NOT_FOUND', `no mock route: ${key}`)); }
    });
  });
  await new Promise<void>(res => server.listen(0, '127.0.0.1', () => res()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}/api/v1`,
    captured,
    server,
    close: () => new Promise<void>(resolveClose => { server.close(() => resolveClose()); server.closeAllConnections?.(); }),
  };
}

function cleanEnv(extra: Record<string, string>, configDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  delete env.FOP_API_TOKEN_FILE;
  env.FOP_CONFIG_DIR = configDir;
  env.FOP_API_TOKEN = 'test-token';
  return { ...env, ...extra };
}

interface RunResult { code: number | null; stdout: string; stderr: string }
function runCli(args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [MAIN, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); rejectRun(new Error(`CLI 超时：${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`)); }, 20_000);
    child.on('error', rejectRun);
    child.on('close', (code: number | null) => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
  });
}

function lastJson(stdout: string): any {
  const lines = stdout.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* continue */ }
  }
  throw new Error(`stdout 不是 JSON：${stdout}`);
}

const TOKEN_FILE_CONTENT = 'test-token\n';

// ---------------------------------------------------------------- CLI 测试
test('CLI health --json：输出 REST 同构 envelope，退出码 0', async () => {
  const mock = await startMock({
    'GET /api/v1/health': (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'req_mock' }); res.end(envelope({ ok: true, uptimeSec: 12, version: '0.1.0', startedAt: '2026-11-14T00:00:00+08:00' }, { requestId: 'req_mock' })); },
  });
  try {
    const r = await runCli(['health', '--json'], cleanEnv({ FOP_API_URL: mock.base }, tmpDir('cli')));
    assert.equal(r.code, 0, r.stderr);
    const json = lastJson(r.stdout);
    assert.equal(json.ok, true);
    assert.equal(json.data.version, '0.1.0');
    assert.equal(mock.captured[0]?.path, '/api/v1/health');
    assert.equal(mock.captured[0]?.headers.authorization, 'Bearer test-token');
  } finally { await mock.close(); }
});

test('CLI 未知命令 → 退出码 2（参数错误）', async () => {
  const r = await runCli(['no-such-command'], cleanEnv({}, tmpDir('cli')));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown command|error/i);
});

test('CLI 404 → 退出码 3，错误 envelope 保留 code/meta', async () => {
  const mock = await startMock({
    'GET /api/v1/calls/call_01J8Z3K5T9QW2M4R7X1C6V0B8N': (_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json', 'X-Request-Id': 'req_404' });
      res.end(errorBody('CALL_NOT_FOUND', '话单不存在'));
    },
  });
  try {
    const r = await runCli(['calls', 'get', 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N', '--json'], cleanEnv({ FOP_API_URL: mock.base }, tmpDir('cli')));
    assert.equal(r.code, 3, r.stderr);
    const json = lastJson(r.stdout);
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'CALL_NOT_FOUND');
  } finally { await mock.close(); }
});

test('CLI 422 CALL_OUTSIDE_DIAL_WINDOW → 退出码 4；请求体到 mock', async () => {
  const mock = await startMock({
    'POST /api/v1/calls': (_req, res) => {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(errorBody('CALL_OUTSIDE_DIAL_WINDOW', '当前不在可拨号时段', { retryable: true, retryAfter: '2026-11-15T07:50:00+08:00' }));
    },
  });
  try {
    const r = await runCli(['dial', '13800138000', '--yes', '--json'], cleanEnv({ FOP_API_URL: mock.base }, tmpDir('cli')));
    assert.equal(r.code, 4, r.stderr);
    const json = lastJson(r.stdout);
    assert.equal(json.error.code, 'CALL_OUTSIDE_DIAL_WINDOW');
    assert.equal(JSON.parse(mock.captured[0]!.body).to, '13800138000');
  } finally { await mock.close(); }
});

test('CLI dial 非交互缺 --yes → 退出码 2（本地 INVALID_REQUEST，不发请求）', async () => {
  const mock = await startMock({});
  try {
    const r = await runCli(['dial', '13800138000', '--json'], cleanEnv({ FOP_API_URL: mock.base }, tmpDir('cli')));
    assert.equal(r.code, 2, r.stderr);
    const json = lastJson(r.stdout);
    assert.equal(json.error.code, 'INVALID_REQUEST');
    assert.equal(mock.captured.length, 0);
  } finally { await mock.close(); }
});

test('CLI dial --dry-run 无需 --yes，返回 dryRun 计划', async () => {
  const mock = await startMock({
    'POST /api/v1/calls': (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(envelope({ dryRun: true, willDial: true, accountId: 'main', to: '13800138000', warnings: [], estimatedCost: null }));
    },
  });
  try {
    const r = await runCli(['dial', '13800138000', '--dry-run', '--json'], cleanEnv({ FOP_API_URL: mock.base }, tmpDir('cli')));
    assert.equal(r.code, 0, r.stderr);
    const json = lastJson(r.stdout);
    assert.equal(json.data.dryRun, true);
    assert.equal(JSON.parse(mock.captured[0]!.body).dryRun, true);
  } finally { await mock.close(); }
});

test('CLI 401 UNAUTHORIZED → 退出码 6；502 UPSTREAM_UNREACHABLE → 退出码 5', async () => {
  const mock401 = await startMock({ 'GET /api/v1/status': (_r, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(errorBody('UNAUTHORIZED', 'token 无效')); } });
  const mock502 = await startMock({ 'GET /api/v1/status': (_r, res) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(errorBody('UPSTREAM_UNREACHABLE', '上游不可达')); } });
  try {
    const r1 = await runCli(['status', '--json'], cleanEnv({ FOP_API_URL: mock401.base }, tmpDir('cli')));
    assert.equal(r1.code, 6, r1.stderr);
    assert.equal(lastJson(r1.stdout).error.code, 'UNAUTHORIZED');
    const r2 = await runCli(['status', '--json'], cleanEnv({ FOP_API_URL: mock502.base }, tmpDir('cli')));
    assert.equal(r2.code, 5, r2.stderr);
    assert.equal(lastJson(r2.stdout).error.code, 'UPSTREAM_UNREACHABLE');
  } finally { await mock401.close(); await mock502.close(); }
});

test('CLI 本地服务不可达 → 退出码 8', async () => {
  const r = await runCli(['health', '--json', '--timeout', '200ms'], cleanEnv({ FOP_API_URL: 'http://127.0.0.1:1/api/v1' }, tmpDir('cli')));
  assert.equal(r.code, 8, r.stderr);
  assert.equal(lastJson(r.stdout).error.code, 'SERVICE_UNAVAILABLE');
});

test('CLI 请求超时 → 退出码 9', async () => {
  const mock = await startMock({
    'GET /api/v1/health': (_req, res) => { const t = setTimeout(() => { try { res.writeHead(200); res.end(envelope({ ok: true })); } catch { /* closed */ } }, 5000); res.on('close', () => clearTimeout(t)); },
  });
  try {
    const r = await runCli(['health', '--json', '--timeout', '300ms'], cleanEnv({ FOP_API_URL: mock.base }, tmpDir('cli')));
    assert.equal(r.code, 9, r.stderr);
    assert.equal(lastJson(r.stdout).error.code, 'SERVICE_UNAVAILABLE');
  } finally { await mock.close(); }
});

test('CLI SSE --follow：解析事件流并通过 --duration 退出 0', async () => {
  const mock = await startMock({
    'GET /api/v1/events/stream': (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const ev1 = JSON.stringify({ eventId: 'evt_1', type: 'call.connected', occurredAt: '2026-11-14T10:03:12+08:00', accountId: 'main', callId: 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N', data: { answeredAt: '2026-11-14T10:03:12+08:00' } });
      const ev2 = JSON.stringify({ eventId: 'evt_2', type: 'call.ended', occurredAt: '2026-11-14T10:03:27+08:00', accountId: 'main', callId: 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N', data: { durationSec: 15 } });
      res.write(`event: call.connected\nid: evt_1\ndata: ${ev1}\n\n`);
      res.write(`event: call.ended\nid: evt_2\ndata: ${ev2}\n\n`);
      res.on('close', () => { try { res.end(); } catch { /* ignore */ } });
    },
  });
  try {
    const r = await runCli(['events', '--follow', '--duration', '1s', '--json'], cleanEnv({ FOP_API_URL: mock.base }, tmpDir('cli')));
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.ok(lines.some((x: any) => x.type === 'call.connected'));
    assert.ok(lines.some((x: any) => x.type === 'call.ended'));
  } finally { await mock.close(); }
});

test('CLI calls list：日期/状态映射到 REST query 并返回数组 data', async () => {
  const mock = await startMock({
    'GET /api/v1/calls': (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(envelope([{ callId: 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N', status: 'ended', to: { phone: '138****0000' }, durationSec: 15, createdAt: '2026-11-14T10:00:00+08:00' }], { pagination: { page: 1, size: 20, total: 1, totalPages: 1 } }));
    },
  });
  try {
    const r = await runCli(['calls', 'list', '--status', 'ended', '--date', '2026-11-14', '--json'], cleanEnv({ FOP_API_URL: mock.base }, tmpDir('cli')));
    assert.equal(r.code, 0, r.stderr);
    const json = lastJson(r.stdout);
    assert.ok(Array.isArray(json.data));
    assert.equal(json.meta.pagination.total, 1);
    assert.equal(mock.captured[0]!.query.get('status'), 'ended');
    assert.equal(mock.captured[0]!.query.get('dateFrom'), '2026-11-14');
    assert.equal(mock.captured[0]!.query.get('dateTo'), '2026-11-14');
  } finally { await mock.close(); }
});

test('CLI term import --dry-run：本地 diff，不发 PUT', async () => {
  const mock = await startMock({
    'GET /api/v1/terms': (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(envelope([{ termId: 'term_01J8Z3K5T9QW2M4R7X1C6V0B8Q', from: ['复萌'], to: '孚盟', priority: 100, enabled: true }], { pagination: { page: 1, size: 500, total: 1, totalPages: 1 } }));
    },
  });
  try {
    const dir = tmpDir('term');
    const file = join(dir, 'terms.json');
    writeFileSync(file, JSON.stringify({ rules: [{ from: ['复萌', '福梦'], to: '孚盟' }, { from: ['富盟'], to: '孚盟' }] }));
    const r = await runCli(['term', 'import', file, '--dry-run', '--json'], cleanEnv({ FOP_API_URL: mock.base }, tmpDir('cli')));
    assert.equal(r.code, 0, r.stderr);
    const json = lastJson(r.stdout);
    assert.equal(json.data.applied, false);
    assert.equal(json.data.diff.added, 2);
    assert.equal(json.data.diff.removed, 1);
    assert.equal(mock.captured.filter(c => c.method === 'PUT').length, 0);
  } finally { await mock.close(); }
});

test('CLI doctor --json：本地 + mock REST 检查（fail=0 时退出 0）', async () => {
  const dir = tmpDir('doctor');
  const dataDir = join(dir, 'data');
  mkdirSync(join(dataDir, 'audio'), { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    server: { host: '127.0.0.1', port: 8710, allowRemote: false },
    storage: { dataDir, dbFile: 'fop.db', audioDir: 'audio', asrDir: 'asr' },
    pipeline: { asr: { provider: 'minimax', baseUrl: 'https://api.minimax.io', model: 'asr-1.0' }, analysis: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }, roleMapping: { method: 'auto', llmVerify: true } },
  }));
  writeFileSync(join(dir, 'api-token'), TOKEN_FILE_CONTENT);
  chmodSync(join(dir, 'api-token'), 0o600);
  const mock = await startMock({
    'GET /api/v1/health': (_r, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(envelope({ ok: true, uptimeSec: 10, version: '0.1.0', startedAt: '2026-11-14T00:00:00+08:00' })); },
    'GET /api/v1/status': (_r, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(envelope({ version: '0.1.0', uptimeSec: 10, now: '2026-11-14T10:00:00+08:00', db: { ok: true, schemaVersion: 1, sizeBytes: 1024, walSizeBytes: 0, latencyMs: 1 }, accounts: { total: 1, online: 1, expired: 0, loggingIn: 0, error: 0, disabled: 0 }, dialWindow: { open: true, windowStart: '07:50', windowEnd: '22:00', timezone: 'Asia/Shanghai', nextOpenAt: null }, queues: {}, sync: {}, events: {}, upstream: { reachable: true, latencyMs: 10 } }));
    },
    'GET /api/v1/accounts': (_r, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(envelope([{ accountId: 'main', state: 'online' }])); },
  });
  try {
    const r = await runCli(['doctor', '--json'], cleanEnv({ FOP_API_URL: mock.base }, dir));
    assert.equal(r.code, 0, `${r.stderr}\n${r.stdout}`);
    const json = lastJson(r.stdout);
    assert.equal(json.data.summary.fail, 0);
    assert.ok(json.data.checks.some((c: any) => c.id === 'provider:minimax') || json.data.checks.some((c: any) => c.id === 'providers'));
  } finally { await mock.close(); }
});

// ---------------------------------------------------------------- MCP 测试
async function connectMcp(mock: MockServer, configDir: string, extraArgs: string[] = []): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MAIN, 'mcp', ...extraArgs],
    env: cleanEnv({ FOP_API_URL: mock.base }, configDir),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'feige-test-client', version: '0.0.1' });
  await client.connect(transport);
  return { client, close: async () => { await client.close(); await transport.close(); } };
}

test('MCP 只读模式：tools/list 18 个工具；tools/call feige_status 走 mock REST', async () => {
  const mock = await startMock({
    'GET /api/v1/status': (_r, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(envelope({ version: '0.1.0', db: { ok: true }, accounts: { total: 0 }, dialWindow: { open: true } }));
    },
  });
  const conn = await connectMcp(mock, tmpDir('mcp'));
  try {
    const tools = await conn.client.listTools();
    assert.equal(tools.tools.length, 18, tools.tools.map(t => t.name).join(','));
    const names = tools.tools.map(t => t.name);
    for (const expected of ['feige_health', 'feige_status', 'feige_call_list', 'feige_call_transcript', 'feige_terms_list', 'feige_text_normalize']) assert.ok(names.includes(expected), expected);
    assert.ok(!names.includes('feige_dial'), '默认只读模式不应注册写工具');
    const res = await conn.client.callTool({ name: 'feige_status', arguments: { detail: false } });
    assert.notEqual(res.isError, true, JSON.stringify(res));
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const payload = JSON.parse(text);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.version, '0.1.0');
    assert.equal(mock.captured[0]?.path, '/api/v1/status');
  } finally { await conn.close(); await mock.close(); }
});

test('MCP --allow-write：tools/list 32 个工具；feige_dial 需 confirm 且可成功调用', async () => {
  const mock = await startMock({
    'POST /api/v1/calls': (_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(envelope({ callId: 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N', status: 'pending', accountId: 'main', to: { phone: '138****0000' }, pipeline: { audio: 'pending', transcript: 'pending', analysis: 'pending' }, audioAvailable: false, createdAt: '2026-11-14T10:00:00+08:00', updatedAt: '2026-11-14T10:00:00+08:00' }));
    },
  });
  const conn = await connectMcp(mock, tmpDir('mcp'), ['--allow-write']);
  try {
    const tools = await conn.client.listTools();
    assert.equal(tools.tools.length, 32, tools.tools.map(t => t.name).join(','));
    const names = tools.tools.map(t => t.name);
    for (const expected of ['feige_dial', 'feige_call_reprocess', 'feige_account_login', 'feige_sync_start', 'feige_terms_replace']) assert.ok(names.includes(expected), expected);
    // 缺少 confirm → 工具层 schema 校验失败（isError 或 JSON-RPC 抛错）
    let rejected = false;
    try {
      const bad = await conn.client.callTool({ name: 'feige_dial', arguments: { to: '13800138000' } });
      rejected = bad.isError === true;
    } catch { rejected = true; }
    assert.equal(rejected, true, '缺少 confirm 必须被拒绝');
    const ok = await conn.client.callTool({ name: 'feige_dial', arguments: { to: '13800138000', confirm: true, idempotencyKey: 'test-key-1' } });
    assert.notEqual(ok.isError, true, JSON.stringify(ok));
    const text = (ok.content as Array<{ type: string; text: string }>)[0]!.text;
    const payload = JSON.parse(text);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.callId, 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N');
    assert.equal(JSON.parse(mock.captured[0]!.body).to, '13800138000');
  } finally { await conn.close(); await mock.close(); }
});

test('MCP resources/prompts：status 资源可读，3 个 prompts', async () => {
  const mock = await startMock({
    'GET /api/v1/status': (_r, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(envelope({ version: '0.1.0', dialWindow: { open: true } })); },
  });
  const conn = await connectMcp(mock, tmpDir('mcp'));
  try {
    const resources = await conn.client.listResources();
    assert.ok(resources.resources.some(r => r.uri === 'feige://status'), JSON.stringify(resources.resources));
    const read = await conn.client.readResource({ uri: 'feige://status' });
    const text = (read.contents as Array<{ text?: string }>)[0]!.text ?? '';
    assert.equal(JSON.parse(text).version, '0.1.0');
    const prompts = await conn.client.listPrompts();
    assert.equal(prompts.prompts.length, 3);
    const prompt = await conn.client.getPrompt({ name: 'review_call', arguments: { callId: 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N' } });
    assert.ok(prompt.messages.length > 0);
  } finally { await conn.close(); await mock.close(); }
});
