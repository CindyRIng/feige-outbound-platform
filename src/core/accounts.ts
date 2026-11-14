import type { Repo } from '../db/repo.js';
import { CONFIG_DIR, type ConfigStore } from '../config.js';
import type { Account, AccountDetail, AccountHealth, AccountSession, AccountSummary, Job } from '../types/domain.js';
import type { AccountState, ErrorBrief, IsoDateTime } from '../types/common.js';
import { AppError } from '../errors.js';
import { EventBus } from './events.js';
import { JobQueue } from './jobs.js';
import { dialWindow } from './time.js';
import { maskPhone, displayPhone } from '../util/phone.js';
import type { Logger } from '../logger.js';
import type { UpstreamClient, LoginResult, UpstreamLine } from '../upstream/types.js';
import { newAuditId } from './ids.js';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface LoginRunOpts { accountId: string; username: string; password: string; profileDir: string; headless: boolean; configDir: string; timeoutMs?: number; }
export interface AccountSvcDeps {
  repo: Repo; config: ConfigStore; events: EventBus; jobs: JobQueue; log: Logger;
  createUpstream: (baseUrl: string, token?: string | null) => UpstreamClient;
  runLogin: (opts: LoginRunOpts) => Promise<LoginResult>;
  upstreamBaseUrl: string;
}
interface AccountLine { lineId: string; lineName: string; mode: number; }

export class AccountService {
  private lineCache = new Map<string, AccountLine | null>();
  private busyCalls = new Map<string, string>();
  constructor(private d: AccountSvcDeps) {}

  get repo(): Repo { return this.d.repo; }
  get events(): EventBus { return this.d.events; }
  get log(): Logger { return this.d.log; }
  get config(): ConfigStore { return this.d.config; }

  async create(input: { accountId: string; displayName: string; username: string; password: string; concurrency?: number; browser?: { headless?: boolean; profileDirName?: string }; metadata?: Record<string, string> }): Promise<AccountSummary> {
    const accountId = String(input.accountId ?? '');
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(accountId)) throw new AppError('VALIDATION_FAILED', 'accountId 需为 2-32 位小写 slug', { details: { fields: [{ field: 'accountId', reason: 'slug' }] } });
    if (!/^1[3-9]\d{9}$/.test(String(input.username ?? ''))) throw new AppError('VALIDATION_FAILED', 'username 需为 11 位手机号', { details: { fields: [{ field: 'username', reason: 'mobile' }] } });
    if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 64) throw new AppError('VALIDATION_FAILED', 'password 长度需 8-64', { details: { fields: [{ field: 'password', reason: 'length' }] } });
    if (!input.displayName || input.displayName.length > 64) throw new AppError('VALIDATION_FAILED', 'displayName 必填且 ≤64', { details: { fields: [{ field: 'displayName', reason: 'length' }] } });
    const existing = await this.d.repo.getAccount(accountId);
    if (existing && !existing.deletedAt) throw new AppError('VALIDATION_FAILED', `账号已存在: ${accountId}`, { details: { fields: [{ field: 'accountId', reason: 'duplicate' }] } });
    const now = new Date().toISOString();
    const acct: Account = {
      accountId, displayName: input.displayName, upstreamUsername: input.username,
      enabled: true, concurrency: 1, state: 'unknown',
      browserHeadless: input.browser?.headless ?? this.d.config.get().browser.headless,
      browserProfileDir: input.browser?.profileDirName ?? accountId,
      origin: 'user', status: 'enabled', version: 1,
      metadata: input.metadata ?? {}, createdAt: now, updatedAt: now,
    } as Account;
    if (existing?.deletedAt) {
      await this.d.repo.updateAccount(accountId, { ...acct, deletedAt: null, state: 'unknown', jwtExpiresAt: null, lastLoginAt: null, lastErrorJson: null } as Partial<Account>);
    } else {
      await this.d.repo.createAccount(acct);
    }
    this.d.config.putAccountSecret(accountId, input.username, input.password, acct.browserProfileDir ?? accountId);
    await this.audit('account.create', 'account', accountId, 'success');
    return this.toSummary(await this.d.repo.getAccount(accountId) as Account);
  }

  async list(opts: { enabled?: boolean; state?: AccountState } = {}): Promise<AccountSummary[]> {
    let list = await this.d.repo.listAccounts({ enabled: opts.enabled });
    if (opts.state) list = list.filter(a => a.state === opts.state);
    return Promise.all(list.map(a => this.toSummary(a)));
  }
  async get(accountId: string): Promise<AccountDetail> {
    const a = await this.d.repo.getAccount(accountId);
    if (!a || (a.deletedAt && !a.enabled)) throw new AppError('ACCOUNT_NOT_FOUND', `账号不存在: ${accountId}`);
    return this.toDetail(a);
  }
  async update(accountId: string, patch: { displayName?: string; enabled?: boolean; password?: string; browser?: { headless?: boolean }; metadata?: Record<string, string> }): Promise<AccountDetail> {
    const a = await this.d.repo.getAccount(accountId);
    if (!a || a.deletedAt) throw new AppError('ACCOUNT_NOT_FOUND', `账号不存在: ${accountId}`);
    const p: Partial<Account> = { updatedAt: new Date().toISOString() };
    if (patch.displayName !== undefined) p.displayName = patch.displayName;
    if (patch.enabled !== undefined) { p.enabled = patch.enabled; p.status = patch.enabled ? 'enabled' : 'disabled'; if (!patch.enabled) p.state = 'disabled'; }
    if (patch.browser?.headless !== undefined) p.browserHeadless = patch.browser.headless;
    if (patch.metadata !== undefined) p.metadata = patch.metadata;
    if (patch.password) {
      const sec = this.d.config.secrets().accounts[accountId];
      if (!sec) throw new AppError('CONFIG_INVALID', '账号凭证缺失，请重新添加账号');
      this.d.config.putAccountSecret(accountId, sec.username, patch.password, sec.browserProfile);
      await this.d.repo.deleteSession(accountId);
      p.state = 'expired'; p.jwtExpiresAt = null;
    }
    const updated = await this.d.repo.updateAccount(accountId, p);
    await this.audit('account.update', 'account', accountId, 'success');
    return this.toDetail(updated as Account);
  }
  async remove(accountId: string, opts: { purgeData?: boolean } = {}): Promise<void> {
    const a = await this.d.repo.getAccount(accountId);
    if (!a) throw new AppError('ACCOUNT_NOT_FOUND', `账号不存在: ${accountId}`);
    if (opts.purgeData) await this.d.repo.hardDeleteAccount(accountId);
    else await this.d.repo.updateAccount(accountId, { deletedAt: new Date().toISOString(), enabled: false, state: 'disabled', updatedAt: new Date().toISOString() });
    this.d.config.removeAccountSecret(accountId);
    this.lineCache.delete(accountId);
    await this.audit(opts.purgeData ? 'account.purge' : 'account.remove', 'account', accountId, 'success');
  }

  async startLogin(accountId: string, opts: { force?: boolean; wait?: boolean; timeoutMs?: number } = {}): Promise<{ job: Job; wait: boolean }> {
    const a = await this.d.repo.getAccount(accountId);
    if (!a || a.deletedAt) throw new AppError('ACCOUNT_NOT_FOUND', `账号不存在: ${accountId}`);
    const inProgress = (await this.d.repo.listJobsByStatus('login', 'running', 5)).find(j => j.accountId === accountId);
    if (inProgress) throw new AppError('ACCOUNT_LOGIN_IN_PROGRESS', '该账号登录进行中', { details: { loginJobId: inProgress.jobId } });
    if (!opts.force) {
      const session = await this.d.repo.getSession(accountId);
      const expOk = !session?.jwtExpiresAt || new Date(session.jwtExpiresAt).getTime() > Date.now() + 60_000;
      if (session?.token && session.state === 'online' && expOk) return { job: { jobId: 'cached', type: 'login', status: 'succeeded' } as Job, wait: false };
    }
    const job = await this.d.jobs.enqueue('login', { accountId, payload: { force: !!opts.force }, maxAttempts: 3 });
    return { job, wait: !!opts.wait };
  }
  async waitLogin(jobId: string, timeoutMs: number): Promise<Job> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const j = await this.d.repo.getJob(jobId);
      if (!j) throw new AppError('JOB_NOT_FOUND', `作业不存在: ${jobId}`);
      if (j.status === 'succeeded' || j.status === 'failed' || j.status === 'canceled') return j;
      await new Promise(r => setTimeout(r, 400));
    }
    throw new AppError('ACCOUNT_LOGIN_IN_PROGRESS', '登录仍在进行，请稍后查询作业状态', { details: { loginJobId: jobId } });
  }
  /** JobQueue handler */
  async executeLoginJob(job: Job): Promise<Record<string, unknown>> {
    const accountId = job.accountId as string;
    const a = await this.d.repo.getAccount(accountId);
    if (!a) throw new AppError('ACCOUNT_NOT_FOUND', `账号不存在: ${accountId}`);
    const sec = this.d.config.secrets().accounts[accountId];
    if (!sec) throw new AppError('CONFIG_INVALID', '账号凭证缺失');
    await this.d.repo.updateAccount(accountId, { state: 'logging_in', updatedAt: new Date().toISOString() });
    await this.d.events.emit({ type: 'account.login.started', accountId, jobId: job.jobId, data: { accountId } });
    const profileDir = `${this.d.config.paths().profilesDir}/${a.browserProfileDir ?? accountId}`;
    const payload = job.payloadJson ? (JSON.parse(job.payloadJson) as { force?: boolean }) : {};
    const clearProfile = (): void => { if (existsSync(profileDir)) { try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ } } };
    if (payload.force) clearProfile();
    const verifyToken = async (token: string): Promise<boolean> => {
      try { await this.client(accountId, token).getUserDetail(); return true; } catch (e) { return (e as { code?: string }).code !== 'UPSTREAM_AUTH_EXPIRED'; }
    };
    let result: LoginResult;
    try {
      result = await this.d.runLogin({ accountId, username: sec.username, password: sec.password, profileDir, headless: !!(a.browserHeadless ?? false), configDir: CONFIG_DIR, timeoutMs: 150000 });
      // 校验 JWT 是否真实可用：worker 可能从旧 profile 复用已被服务端登出的 JWT
      if (result.ok && result.jwt && !(await verifyToken(result.jwt))) {
        this.d.log.warn('login token invalid, retrying with fresh profile', { accountId });
        clearProfile();
        result = await this.d.runLogin({ accountId, username: sec.username, password: sec.password, profileDir, headless: !!(a.browserHeadless ?? false), configDir: CONFIG_DIR, timeoutMs: 150000 });
        if (result.ok && result.jwt && !(await verifyToken(result.jwt))) throw new AppError('ACCOUNT_LOGIN_FAILED', '登录成功但 JWT 校验失败（上游返回 401）', { details: { reason: 'jwt_invalid' } });
      }
    } catch (e) {
      const err = e as Error & { code?: string };
      await this.d.repo.updateAccount(accountId, { state: 'error', lastErrorJson: JSON.stringify({ code: err.code ?? 'ACCOUNT_LOGIN_FAILED', message: err.message, at: new Date().toISOString() }), updatedAt: new Date().toISOString() });
      await this.d.repo.updateJob(job.jobId, { lastErrorJson: JSON.stringify({ code: err.code ?? 'ACCOUNT_LOGIN_FAILED', message: err.message }) });
      await this.d.events.emit({ type: 'account.login.failed', accountId, jobId: job.jobId, data: { reason: err.code ?? 'login_failed', needHuman: true } });
      throw err;
    }
    if (!result.ok || !result.jwt) {
      await this.d.repo.updateAccount(accountId, { state: 'error', lastErrorJson: JSON.stringify({ code: 'ACCOUNT_LOGIN_FAILED', message: result.reason ?? 'login failed', at: new Date().toISOString() }), updatedAt: new Date().toISOString() });
      await this.d.events.emit({ type: 'account.login.failed', accountId, jobId: job.jobId, data: { reason: result.reason ?? 'login_failed', needHuman: true } });
      throw new AppError('ACCOUNT_LOGIN_FAILED', result.reason ?? '登录失败', { details: { reason: result.reason ?? 'login_failed' } });
    }
    const now = new Date();
    const exp = result.jwtExpiresAt ?? parseJwtExp(result.jwt);
    const session: AccountSession = { accountId, token: result.jwt, state: 'online', wsConnected: false, updatedAt: now.toISOString(), loginState: 'authenticated', jwtExpiresAt: exp ?? null } as AccountSession;
    await this.d.repo.upsertSession(session);
    await this.d.repo.updateAccount(accountId, { state: 'online', jwtExpiresAt: exp ?? null, lastLoginAt: now.toISOString(), lastCheckedAt: now.toISOString(), lastErrorJson: null, updatedAt: now.toISOString() });
    // 拉取线路（best-effort）
    try { await this.refreshLines(accountId); } catch { /* ignore */ }
    await this.d.events.emit({ type: 'account.login.succeeded', accountId, jobId: job.jobId, data: { accountId, jwtExpiresAt: exp ?? null } });
    await this.audit('account.login', 'account', accountId, 'success');
    return { accountId, loggedIn: true, jwtExpiresAt: exp ?? null };
  }
  async logout(accountId: string): Promise<void> {
    const a = await this.d.repo.getAccount(accountId);
    if (!a) throw new AppError('ACCOUNT_NOT_FOUND', `账号不存在: ${accountId}`);
    const session = await this.d.repo.getSession(accountId);
    if (session?.token) {
      try { const c = this.client(accountId, session.token); await c.logout(); } catch { /* ignore */ }
    }
    await this.d.repo.deleteSession(accountId);
    await this.d.repo.updateAccount(accountId, { state: 'expired', jwtExpiresAt: null, updatedAt: new Date().toISOString() });
    this.lineCache.delete(accountId);
    // 上游 logout 已使旧 JWT 失效；清空浏览器 profile，避免 worker 复用旧 localStorage/cookie 返回失效 JWT
    const profileDir = join(this.d.config.paths().profilesDir, a.browserProfileDir ?? accountId);
    if (existsSync(profileDir)) { try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    await this.audit('account.logout', 'account', accountId, 'success');
  }
  async requireOnlineToken(accountId: string): Promise<string> {
    const a = await this.d.repo.getAccount(accountId);
    if (!a || a.deletedAt) throw new AppError('ACCOUNT_NOT_FOUND', `账号不存在: ${accountId}`);
    if (!a.enabled) throw new AppError('ACCOUNT_DISABLED', `账号已停用: ${accountId}`);
    const s = await this.d.repo.getSession(accountId);
    if (!s?.token) throw new AppError('ACCOUNT_LOGIN_REQUIRED', `账号未登录: ${accountId}`, { details: { accountId } });
    if (s.state !== 'online') throw new AppError('ACCOUNT_LOGIN_REQUIRED', `账号登录态失效: ${accountId}`, { details: { accountId } });
    return s.token;
  }
  async health(accountId: string): Promise<AccountHealth> {
    const a = await this.d.repo.getAccount(accountId);
    if (!a) throw new AppError('ACCOUNT_NOT_FOUND', `账号不存在: ${accountId}`);
    const s = await this.d.repo.getSession(accountId);
    const now = new Date();
    const expiresAt = a.jwtExpiresAt ?? s?.jwtExpiresAt ?? null;
    const jwt = { valid: !!expiresAt && new Date(expiresAt).getTime() > now.getTime(), expiresAt, expiresInSec: expiresAt ? Math.max(0, Math.round((new Date(expiresAt).getTime() - now.getTime()) / 1000)) : null };
    let upstream = { reachable: false, latencyMs: null as number | null, checkedAt: now.toISOString() };
    let line: AccountLine | null | undefined = this.lineCache.get(accountId);
    if (s?.token) {
      const t0 = Date.now();
      try {
        const c = this.client(accountId, s.token);
        await c.getUserDetail();
        upstream = { reachable: true, latencyMs: Date.now() - t0, checkedAt: new Date().toISOString() };
        if (line === undefined) line = await this.refreshLines(accountId);
      } catch (e) {
        const err = e as Error & { code?: string };
        if (err.code === 'UPSTREAM_AUTH_EXPIRED') {
          // 保留 token 便于诊断；仅标记登录态失效（不要清空 jwt_ciphertext，否则无法区分“过期”与“未登录”）
          await this.d.repo.updateAccount(accountId, { state: 'expired', updatedAt: new Date().toISOString() });
          await this.d.repo.upsertSession({ ...(s as AccountSession), state: 'expired', loginState: 'expired' } as AccountSession);
          this.lineCache.delete(accountId);
          await this.d.events.emit({ type: 'account.session.expired', accountId, data: { detectedBy: 'health' } });
        }
        upstream = { reachable: false, latencyMs: Date.now() - t0, checkedAt: new Date().toISOString() };
      }
      await this.d.repo.updateAccount(accountId, { lastCheckedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    const busy = this.busyCalls.get(accountId);
    return {
      accountId, state: a.state, jwt,
      ws: { connected: !!s?.wsConnected, lastPongAt: s?.lastPongAt ?? null, latencyMs: null },
      upstream, line: line ?? null, dialWindow: dialWindow(this.d.config.get()),
      busy: { inCall: !!busy, busyCallId: busy ?? null }, lastError: safeErr(a.lastErrorJson),
    };
  }
  async getLine(accountId: string): Promise<AccountLine | null> {
    if (this.lineCache.has(accountId)) return this.lineCache.get(accountId) ?? null;
    try { return await this.refreshLines(accountId); } catch { return null; }
  }
  private async refreshLines(accountId: string): Promise<AccountLine | null> {
    const token = await this.d.repo.getSession(accountId).then(s => s?.token ?? null);
    if (!token) return null;
    const lines: UpstreamLine[] = await this.client(accountId, token).getCallLineList();
    const first = lines[0] ? { lineId: String(lines[0].lineId), lineName: lines[0].lineName, mode: lines[0].mode } : null;
    this.lineCache.set(accountId, first);
    await this.d.repo.updateAccount(accountId, { lineId: first?.lineId ?? null, lineName: first?.lineName ?? null, lineMode: first?.mode ?? null, upstreamLineListJson: JSON.stringify(lines), updatedAt: new Date().toISOString() } as Partial<Account>);
    return first;
  }
  client(accountId: string, token?: string | null): UpstreamClient {
    const c = this.d.createUpstream(this.d.upstreamBaseUrl, token ?? null);
    return c;
  }
  markBusy(accountId: string, callId: string | null): void { if (callId) this.busyCalls.set(accountId, callId); else this.busyCalls.delete(accountId); }
  isBusy(accountId: string): boolean { return this.busyCalls.has(accountId); }

  private async toSummary(a: Account): Promise<AccountSummary> {
    const stats = await this.d.repo.accountStats(a.accountId);
    const line = this.lineCache.get(a.accountId) ?? (a.lineId ? { lineId: a.lineId, lineName: a.lineName ?? '', mode: a.lineMode ?? 1 } : null);
    return {
      accountId: a.accountId, displayName: a.displayName,
      upstreamUsername: displayPhone(a.upstreamUsername, !!this.d.config.get().security?.maskPhones),
      upstreamUsernameMasked: maskPhone(a.upstreamUsername),
      upstreamUserId: a.upstreamUserId ?? null, tenantCode: a.tenantCode ?? null, enterpriseName: a.enterpriseName ?? null,
      realName: a.realName ?? null, dialMode: 'callback', line,
      enabled: a.enabled, state: a.state, jwtExpiresAt: a.jwtExpiresAt ?? null,
      lastLoginAt: a.lastLoginAt ?? null, lastCheckedAt: a.lastCheckedAt ?? null,
      lastError: safeErr(a.lastErrorJson), deletedAt: a.deletedAt ?? null, stats,
      createdAt: a.createdAt, updatedAt: a.updatedAt,
    };
  }
  private async toDetail(a: Account): Promise<AccountDetail> {
    const summary = await this.toSummary(a);
    const s = await this.d.repo.getSession(a.accountId);
    const cursor = await this.d.repo.getCursor(a.accountId);
    const jobs = (await this.d.repo.listJobs({ page: 1, size: 5 })).items.filter(j => j.accountId === a.accountId);
    return {
      ...summary,
      config: { concurrency: a.concurrency, browser: { headless: !!a.browserHeadless, profileDirMasked: maskProfile(a.browserProfileDir ?? a.accountId) } },
      session: { state: a.state, jwtExpiresAt: a.jwtExpiresAt ?? null, wsConnected: !!s?.wsConnected, cookieState: (s?.state === 'online' ? 'valid' : s?.state === 'expired' ? 'expired' : 'unknown') as 'valid'|'expired'|'unknown', lastPongAt: s?.lastPongAt ?? null },
      sync: { lastSyncAt: cursor?.lastSyncedAt ?? null, cursorStartTime: cursor?.lastStartTime ?? null, lagSeconds: null, lastError: null },
      recentJobs: jobs.map(j => ({ jobId: j.jobId, type: j.type, status: j.status, accountId: j.accountId, callId: j.callId, attempts: j.attempts, maxAttempts: j.maxAttempts, scheduledAt: j.scheduledAt, startedAt: j.startedAt, finishedAt: j.finishedAt, lastError: null, createdAt: j.createdAt, updatedAt: j.updatedAt })),
    };
  }
  private async audit(action: string, targetType: string, targetId: string, result: 'success' | 'failed') {
    try { await this.d.repo.insertAudit({ auditId: newAuditId(), actor: 'local-api', action, targetType, targetId, result, at: new Date().toISOString() } as any); } catch { /* ignore */ }
  }
}
function parseJwtExp(jwt: string): string | null {
  try {
    const payload = jwt.split('.')[1]; const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof json.exp === 'number') return new Date(json.exp * 1000).toISOString();
  } catch { /* ignore */ }
  return null;
}
function safeErr(json?: string | null): ErrorBrief | null { if (!json) return null; try { const x = JSON.parse(json); return { code: x.code ?? 'INTERNAL_ERROR', message: x.message ?? '', at: x.at ?? new Date().toISOString() }; } catch { return null; } }
function maskProfile(p: string): string { return p.length <= 4 ? '***' : p.slice(0, 2) + '***' + p.slice(-2); }
