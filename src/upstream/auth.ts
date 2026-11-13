// 自动登录编排：写临时账号信息（0600）→ spawn cloak-run + login-worker.mjs（headful + 阿里云滑块）→ 解析 JWT。
//
// 契约：docs/09 §6（登录流程/失败分类/人工介入）；docs/00 §2（登录页/滑块/JWT 7 天）。
// 注意：密码只经 0600 临时文件传给 worker，不落日志；worker 输出 stdout JSON 结果，stderr 日志。
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdir, writeFile, readFile, unlink, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { IsoDateTime } from '../types/common.js';
import type { LoginResult } from './types.js';
import { AppError } from '../errors.js';

const DEFAULT_LOGIN_URL = 'https://feige.duofangtongxin.com/#/login';
const DEFAULT_TIMEOUT_MS = 180_000;
const OUTPUT_CAP_BYTES = 256 * 1024;

export interface LoginRunOptions {
  accountId: string;
  username: string;
  password: string;
  /** 浏览器 profile 目录（dataDir/profiles/<accountId>）。 */
  profileDir: string;
  headless: boolean;
  /** ~/.config/feige-outbound（临时凭证文件写这里）。 */
  configDir: string;
  timeoutMs?: number;
  loginUrl?: string;
  /** cloak-run 路径（默认 ~/cloak-env/bin/cloak-run）。 */
  cloakRunPath?: string;
  /** 指定 login-worker.mjs（默认自动探测 dist/ 与 src/）。 */
  workerPath?: string;
  /** 诊断截图目录（默认 dataDir/diagnostics/login）。 */
  diagnosticsDir?: string;
  spawnImpl?: typeof spawn;
  env?: NodeJS.ProcessEnv;
}

function redact(text: string): string {
  return String(text ?? '')
    .replace(/1[3-9]\d{9}/g, (m) => `${m.slice(0, 3)}****${m.slice(-4)}`)
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '***JWT***')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-***')
    .replace(/"password"\s*:\s*"[^"]*"/g, '"password":"***"');
}

function truncateTail(text: string, maxBytes = OUTPUT_CAP_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8');
  return buf.subarray(buf.length - maxBytes).toString('utf8');
}

/** 解析 JWT payload（base64url；不做签名校验——无上游密钥，仅用于计算过期时间）。 */
export function decodeJwtPayload(jwt: string): { exp?: number; iat?: number; [k: string]: unknown } | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as { exp?: number; iat?: number; [k: string]: unknown };
  } catch {
    return null;
  }
}

function toIso(epochSec: number): IsoDateTime {
  return new Date(epochSec * 1000).toISOString();
}

/** 解析 login-worker 路径：优先同目录（dist 构建产物），其次项目 src/，最后 cwd/src/。 */
export function resolveLoginWorkerPath(): string | null {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const projectRoot = join(here, '..', '..');
  const candidates = [
    join(here, 'login-worker.mjs'),
    join(projectRoot, 'src', 'upstream', 'login-worker.mjs'),
    join(process.cwd(), 'src', 'upstream', 'login-worker.mjs'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function resolveCloakRunPath(opts: LoginRunOptions): string {
  return opts.cloakRunPath ?? process.env.FOP_CLOAK_RUN ?? join(homedir(), 'cloak-env', 'bin', 'cloak-run');
}

interface WorkerRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

async function runWorker(opts: LoginRunOptions, command: string, workerPath: string, credFile: string): Promise<WorkerRunResult> {
  const spawnImpl = opts.spawnImpl ?? spawn;
  return await new Promise<WorkerRunResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: string | undefined;
    const append = (cur: string, chunk: Buffer): string => truncateTail(cur + chunk.toString('utf8'));
    let child: ChildProcess;
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, spawnError });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child?.kill('SIGKILL'); } catch { /* ignore */ }
      settle(null, 'SIGKILL');
    }, Math.max(1000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    try {
      const spawnOpts: SpawnOptions = {
        cwd: process.cwd(),
        env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ':0', ...(opts.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      };
      child = spawnImpl(command, ['node', workerPath, credFile], spawnOpts);
    } catch (e) {
      spawnError = (e as Error).message;
      settle(null, null);
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on('error', (err: Error) => {
      spawnError = err.message;
      settle(null, null);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => settle(code, signal));
  });
}

function parseWorkerOutput(stdout: string): (Partial<LoginResult> & Record<string, unknown>) | null {
  const lines = stdout.split('\n');
  let result: (Partial<LoginResult> & Record<string, unknown>) | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') {
        result = parsed as Partial<LoginResult> & Record<string, unknown>;
      }
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
  return result;
}

/**
 * 执行一次自动登录（含 worker 内 2 次失败重试）。
 * 返回 LoginResult：ok=false 时 reason 为稳定分类（CAPTCHA_FAILED/BAD_CREDENTIALS/SECONDARY_AUTH_REQUIRED/…）。
 */
export async function runLogin(opts: LoginRunOptions): Promise<LoginResult> {
  if (!opts.accountId) throw new AppError('VALIDATION_FAILED', 'runLogin 缺少 accountId');
  if (!opts.username || !opts.password) {
    return { ok: false, reason: 'CREDENTIALS_UNAVAILABLE', errorDetail: '账号或密码缺失' };
  }
  const workerPath = opts.workerPath ?? resolveLoginWorkerPath();
  if (!workerPath) {
    return { ok: false, reason: 'WORKER_NOT_FOUND', errorDetail: '未找到 login-worker.mjs（检查构建产物或 src/upstream/）' };
  }
  const cloakRunPath = resolveCloakRunPath(opts);
  if (!existsSync(cloakRunPath)) {
    return { ok: false, reason: 'CLOAK_RUN_MISSING', errorDetail: `未找到 cloak-run: ${cloakRunPath}` };
  }

  const profileDir = opts.profileDir;
  const diagnosticsDir = opts.diagnosticsDir ?? join(dirname(profileDir), 'diagnostics', 'login', opts.accountId);
  const tmpDir = join(opts.configDir, 'tmp');
  await mkdir(opts.configDir, { recursive: true, mode: 0o700 });
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  if (diagnosticsDir) await mkdir(diagnosticsDir, { recursive: true, mode: 0o700 }).catch(() => undefined);

  const credFile = join(tmpDir, `.login-${opts.accountId}-${randomBytes(6).toString('hex')}.json`);
  const credPayload = {
    accountId: opts.accountId,
    username: opts.username,
    password: opts.password,
    profileDir,
    headless: opts.headless,
    loginUrl: opts.loginUrl ?? DEFAULT_LOGIN_URL,
    diagnosticsDir,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  let workerResult: WorkerRunResult;
  try {
    await writeFile(credFile, JSON.stringify(credPayload), { mode: 0o600 });
    await chmod(credFile, 0o600);
    // 验证权限（0600）；失败则不把密码交给 worker
    const written = await readFile(credFile, 'utf8').catch(() => '');
    if (!written) return { ok: false, reason: 'STORAGE_UNAVAILABLE', errorDetail: '临时凭证文件写入失败' };
    workerResult = await runWorker(opts, cloakRunPath, workerPath, credFile);
  } finally {
    await unlink(credFile).catch(() => undefined);
  }

  if (workerResult.timedOut) {
    return { ok: false, reason: 'LOGIN_TIMEOUT', errorDetail: `登录超时（${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）` };
  }
  if (workerResult.spawnError) {
    return { ok: false, reason: 'BROWSER_LAUNCH_FAILED', errorDetail: redact(workerResult.spawnError) };
  }
  const parsed = parseWorkerOutput(workerResult.stdout);
  if (!parsed) {
    return {
      ok: false,
      reason: workerResult.code === 0 ? 'WORKER_NO_RESULT' : 'WORKER_ERROR',
      errorDetail: redact(truncateTail(workerResult.stderr, 4096)).trim(),
    };
  }
  if (parsed.ok !== true) {
    return {
      ok: false,
      reason: typeof parsed.reason === 'string' && parsed.reason ? parsed.reason : 'LOGIN_FAILED',
      errorDetail: typeof parsed.errorDetail === 'string' ? redact(parsed.errorDetail) : undefined,
    };
  }
  const jwt = typeof parsed.jwt === 'string' ? parsed.jwt.trim() : '';
  if (!jwt) {
    return { ok: false, reason: 'INVALID_JWT', errorDetail: 'worker 未返回 JWT' };
  }
  const payload = decodeJwtPayload(jwt);
  const exp = typeof payload?.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : null;
  if (exp === null) {
    return { ok: false, reason: 'INVALID_JWT', errorDetail: 'JWT 缺少 exp claim' };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (exp <= nowSec + 60) {
    return { ok: false, reason: 'INVALID_JWT', errorDetail: 'JWT 已过期或剩余不足 60s' };
  }
  const iat = typeof payload?.iat === 'number' && Number.isFinite(payload.iat) ? payload.iat : undefined;
  const result: LoginResult = {
    ok: true,
    jwt,
    jwtExpiresAt: toIso(exp),
    ...(iat !== undefined ? { jwtIssuedAt: toIso(iat) } : {}),
  };
  return result;
}
