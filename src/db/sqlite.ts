// SQLite 持久层实现（docs/04 数据模型）：迁移执行 + Repo 全方法（node:sqlite）
// 设计要点：
// - 单进程单写者：SqliteRepo 持有唯一 DatabaseSync 连接；写操作走短事务（BEGIN IMMEDIATE），支持 SAVEPOINT 嵌套。
// - 列 ↔ domain 字段映射集中在 mapXxx()/update 构造器中；DDL 以 docs/04 §7.1 为准（src/db/migrations/0001_init.sql）。
// - 枚举以 docs/01 §6.1 为准：写入前校验（VALIDATION_FAILED），DB CHECK 兜底。
// - jobs 租约：docs/04 无 lease_until 列，按 Lead 约定用 next_run_at 承载（queued=scheduledAt；running=租约到期）。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import type { Repo, CallFilter, EventFilter, JobFilter, ListResult, DbStats } from './repo.js';
import type {
  Account, AccountSession, Call, AudioAsset, Transcript, TranscriptSegment, AnalysisResult,
  CallEvent, Job, TranscriptChunk, TermRule, SyncCursor, AuditLog, IdempotencyRecord,
} from '../types/domain.js';
import type {
  CallStatus, JobType, JobStatus, StageStatus, EventType, IsoDateTime, AccountState,
  SpeakerRole, TermCategory,
} from '../types/common.js';
import { CALL_STATUSES, JOB_STATUSES, JOB_TYPES, STAGE_STATUSES, EVENT_TYPES, TERM_CATEGORIES } from '../types/common.js';
import { AppError } from '../errors.js';

const APP_VERSION = '0.1.0';
const EPOCH_ISO = '1970-01-01T00:00:00.000Z';
const SQLITE_APP_ID = 0x464f5001; // "FOP"+1（docs/04 §4.5）
const AUDIT_ACTORS = ['local-api', 'cli', 'mcp', 'scheduler', 'system'] as const;
const IDEM_SCOPES = ['calls.create', 'sync.start', 'calls.reprocess', 'accounts.login'] as const;
const ACCOUNT_STATUSES = ['enabled', 'disabled'] as const;
const LOGIN_STATES = ['unauthenticated', 'logging_in', 'authenticated', 'expired', 'failed'] as const;
const HEALTH_STATUSES = ['healthy', 'degraded', 'unhealthy', 'unknown'] as const;
const DIAL_STATES = ['none', 'sending', 'sent', 'failed', 'unknown'] as const;
const ORIGINS = ['local_dial', 'sync'] as const;
const ACCOUNT_ORIGINS = ['user', 'restored'] as const;
const AUDIT_RESULTS = ['success', 'failed'] as const;
const JOB_TRIGGERS = ['api', 'scheduler', 'pipeline', 'manual'] as const;
const SYNC_MODES = ['incremental', 'full', 'backfill'] as const;
const JOB_STAGES = ['audio', 'transcript', 'analysis'] as const;
const SPEAKER_ROLES = ['agent', 'customer', 'unknown'] as const;

type Row = Record<string, any>;
type Params = SQLInputValue[];

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------
function nowIso(): IsoDateTime { return new Date().toISOString(); }

function ensureOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new AppError('VALIDATION_FAILED', `非法枚举值 ${field}=${String(value)}`, {
      details: { fields: [{ field, reason: `allowed: ${allowed.join('|')}` }] },
    });
  }
  return value as T;
}

/** 时间写入前规范化：非法时间 → VALIDATION_FAILED；输出 UTC ISO 毫秒（DDL GLOB 守护）。 */
function normIso(value: unknown, field: string): IsoDateTime | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new AppError('VALIDATION_FAILED', `${field} 必须是 ISO 时间字符串`);
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new AppError('VALIDATION_FAILED', `${field} 不是合法时间: ${value}`);
  return new Date(t).toISOString();
}

function normIsoReq(value: unknown, field: string): IsoDateTime {
  const iso = normIso(value, field);
  if (iso === null) throw new AppError('VALIDATION_FAILED', `${field} 必填`);
  return iso;
}

function intOrNull(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new AppError('VALIDATION_FAILED', `${field} 必须是整数`);
  }
  return value;
}

function numOrNull(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new AppError('VALIDATION_FAILED', `${field} 必须是有限数字`);
  return value;
}

function boolToInt(value: boolean | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  return value ? 1 : 0;
}

function intToBool(value: unknown): boolean { return Number(value) === 1; }

function jsonCheck(value: string | null | undefined, field: string, maxBytes?: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new AppError('VALIDATION_FAILED', `${field} 必须是 JSON 字符串`);
  try { JSON.parse(value); } catch { throw new AppError('VALIDATION_FAILED', `${field} 不是合法 JSON`); }
  if (maxBytes !== undefined && Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new AppError('VALIDATION_FAILED', `${field} 超过长度上限 ${maxBytes} 字节`);
  }
  return value;
}

function jsonParse<T = any>(value: unknown): T | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

/** escape LIKE 通配符（%/_/\），配合 ESCAPE '\' 使用。 */
function escapeLike(s: string): string { return s.replace(/[\\%_]/g, (m) => '\\' + m); }
function stripDigits(s: string): string { return s.replace(/\D+/g, ''); }

function pageOf(f: { page?: number; size?: number }): { size: number; offset: number } {
  const page = f.page ?? 1;
  const size = f.size ?? 20;
  if (!Number.isInteger(page) || page < 1) throw new AppError('VALIDATION_FAILED', 'page 必须为 >=1 的整数');
  if (!Number.isInteger(size) || size < 1 || size > 100) throw new AppError('VALIDATION_FAILED', 'size 必须为 1..100 的整数');
  return { size, offset: (page - 1) * size };
}

/** Asia/Shanghai（固定 +08:00）自然日 → UTC ISO 区间（含端点，左闭右开）。 */
function shanghaiDateRange(dateFrom?: string, dateTo?: string): { from: string | null; to: string | null } {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  let from: string | null = null;
  let to: string | null = null;
  if (dateFrom) {
    if (!re.test(dateFrom)) throw new AppError('VALIDATION_FAILED', 'dateFrom 需为 YYYY-MM-DD');
    const t = Date.parse(`${dateFrom}T00:00:00+08:00`);
    if (Number.isNaN(t)) throw new AppError('VALIDATION_FAILED', 'dateFrom 非法日期');
    from = new Date(t).toISOString();
  }
  if (dateTo) {
    if (!re.test(dateTo)) throw new AppError('VALIDATION_FAILED', 'dateTo 需为 YYYY-MM-DD');
    const t = Date.parse(`${dateTo}T00:00:00+08:00`);
    if (Number.isNaN(t)) throw new AppError('VALIDATION_FAILED', 'dateTo 非法日期');
    to = new Date(t + 86400000).toISOString();
  }
  return { from, to };
}

// domain StageStatus ↔ DDL transcript_chunks.status 映射（docs/04 §7.1）
function chunkDbStatus(s: StageStatus): string {
  if (s === 'ready') return 'succeeded';
  if (s === 'missing') return 'skipped';
  return s;
}
function chunkDomainStatus(s: string): StageStatus { return s === 'succeeded' ? 'ready' : (s as StageStatus); }

const STATE_TO_LOGIN: Record<AccountState, (typeof LOGIN_STATES)[number]> = {
  online: 'authenticated', expired: 'expired', logging_in: 'logging_in',
  error: 'failed', disabled: 'unauthenticated', unknown: 'unauthenticated',
};

function deriveAccountState(r: Row): AccountState {
  if (r.deleted_at || r.status === 'disabled') return 'disabled';
  const loginState = r.s_login_state as string | null | undefined;
  if (loginState === 'logging_in') return 'logging_in';
  if (loginState === 'expired') return 'expired';
  if (r.s_jwt_expires_at && Date.parse(r.s_jwt_expires_at) <= Date.now()) return 'expired';
  if (loginState === 'failed' || r.s_health_status === 'unhealthy') return 'error';
  if (loginState === 'authenticated') return 'online';
  return 'unknown';
}

function cookieStateOf(loginState: string | null | undefined): 'valid' | 'expired' | 'unknown' {
  if (loginState === 'authenticated') return 'valid';
  if (loginState === 'expired') return 'expired';
  return 'unknown';
}

function errorBriefJson(code: string | null | undefined, at: IsoDateTime, message?: string | null): string | null {
  if (!code) return null;
  return JSON.stringify({ code, message: message ?? code, at });
}

const ACCOUNT_SELECT = `SELECT a.*,
  s.login_state AS s_login_state, s.jwt_expires_at AS s_jwt_expires_at, s.last_login_at AS s_last_login_at,
  s.last_check_at AS s_last_check_at, s.last_auth_error AS s_last_auth_error, s.health_status AS s_health_status
FROM accounts a LEFT JOIN account_sessions s ON s.account_id = a.account_id`;

const TRANSCRIPT_SELECT = `SELECT t.*,
  c.transcript_status AS c_transcript_status, c.transcript_last_error_code AS c_transcript_last_error_code
FROM transcripts t JOIN calls c ON c.call_id = t.call_id`;

const ANALYSIS_SELECT = `SELECT a.*,
  c.analysis_status AS c_analysis_status, c.analysis_last_error_code AS c_analysis_last_error_code
FROM analysis_results a JOIN calls c ON c.call_id = a.call_id`;

// ---------------------------------------------------------------------------
// 迁移（schema_version + 幂等 + 篡改/降级检测）
// ---------------------------------------------------------------------------
interface MigrationFile { version: number; name: string; path: string; checksum: string; sql: string; }

function moduleDir(): string {
  try { return dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); }
}

function migrationsDir(): string {
  const here = moduleDir();
  const candidates = [
    process.env.FOP_MIGRATIONS_DIR,
    join(process.cwd(), 'src', 'db', 'migrations'),
    join(process.cwd(), 'dist', 'src', 'db', 'migrations'),
    join(process.cwd(), 'dist', 'db', 'migrations'),
    join(here, 'migrations'),
    join(here, '..', '..', '..', 'src', 'db', 'migrations'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const dir of candidates) {
    if (existsSync(join(dir, '0001_init.sql'))) return resolve(dir);
  }
  throw new AppError('DB_UNAVAILABLE', `找不到数据库迁移目录（候选: ${candidates.join(', ')}）`);
}

function listMigrations(): MigrationFile[] {
  const dir = migrationsDir();
  const names = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  if (names.length === 0) throw new AppError('DB_UNAVAILABLE', `迁移目录为空: ${dir}`);
  const files: MigrationFile[] = [];
  for (const name of names) {
    const version = Number(name.slice(0, 4));
    if (!Number.isInteger(version) || version < 1 || version !== files.length + 1) {
      throw new AppError('CONFIG_INVALID', `迁移文件序号不连续: ${name}`);
    }
    const path = join(dir, name);
    const buf = readFileSync(path);
    files.push({
      version, name: name.replace(/\.sql$/, ''), path,
      checksum: createHash('sha256').update(buf).digest('hex'),
      sql: buf.toString('utf8'),
    });
  }
  return files;
}

// ---------------------------------------------------------------------------
// SqliteRepo
// ---------------------------------------------------------------------------
export class SqliteRepo implements Repo {
  private db: DatabaseSync;
  private readonly dbPath: string;
  private readonly stmtCache = new Map<string, StatementSync>();
  private txDepth = 0;
  private schemaCache: number | null = null;
  private closed = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this.db.exec('PRAGMA foreign_keys = ON;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
      this.db.exec('PRAGMA cache_size = -16000;');
      this.db.exec('PRAGMA temp_store = MEMORY;');
      this.db.exec('PRAGMA wal_autocheckpoint = 1000;');
    } catch (e) {
      try { this.db.close(); } catch { /* ignore */ }
      throw new AppError('DB_UNAVAILABLE', `数据库初始化失败: ${(e as Error).message}`);
    }
  }

  // ---------- 内部基础 ----------
  private assertOpen(): void {
    if (this.closed) throw new AppError('DB_UNAVAILABLE', '数据库连接已关闭');
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmtCache.get(sql);
    if (!s) {
      try { s = this.db.prepare(sql); } catch (e) { throw new AppError('DB_UNAVAILABLE', `SQL 预编译失败: ${(e as Error).message}`); }
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  private allRows(sql: string, params: Params = []): Row[] {
    this.assertOpen();
    try { return this.stmt(sql).all(...params) as Row[]; } catch (e) { throw this.mapDbError(e); }
  }

  private oneRow(sql: string, params: Params = []): Row | null {
    this.assertOpen();
    try { return (this.stmt(sql).get(...params) as Row | undefined) ?? null; } catch (e) { throw this.mapDbError(e); }
  }

  private run(sql: string, params: Params = []): number {
    this.assertOpen();
    try { return Number(this.stmt(sql).run(...params).changes); } catch (e) { throw this.mapDbError(e); }
  }

  private runDynamic(sql: string, params: Params = []): number {
    this.assertOpen();
    try { return Number(this.db.prepare(sql).run(...params).changes); } catch (e) { throw this.mapDbError(e); }
  }

  private allDynamic(sql: string, params: Params = []): Row[] {
    this.assertOpen();
    try { return this.db.prepare(sql).all(...params) as Row[]; } catch (e) { throw this.mapDbError(e); }
  }

  private mapDbError(e: unknown): AppError {
    if (e instanceof AppError) return e;
    const msg = (e as Error)?.message ?? String(e);
    if (/UNIQUE constraint failed/i.test(msg)) return new AppError('VALIDATION_FAILED', `唯一约束冲突: ${msg}`);
    if (/CHECK constraint failed/i.test(msg)) return new AppError('VALIDATION_FAILED', `枚举/约束校验失败: ${msg}`);
    if (/FOREIGN KEY constraint failed/i.test(msg)) return new AppError('VALIDATION_FAILED', `外键约束失败: ${msg}`);
    if (/NOT NULL constraint failed/i.test(msg)) return new AppError('VALIDATION_FAILED', `必填字段缺失: ${msg}`);
    if (/database is locked|SQLITE_BUSY/i.test(msg)) return new AppError('DB_UNAVAILABLE', `数据库被锁: ${msg}`);
    return new AppError('DB_UNAVAILABLE', `数据库错误: ${msg}`);
  }

  /** 事务（支持嵌套 SAVEPOINT）。 */
  private tx<T>(fn: () => T): T {
    this.assertOpen();
    if (this.txDepth > 0) {
      const sp = `sp_${this.txDepth}`;
      this.txDepth++;
      this.db.exec(`SAVEPOINT ${sp};`);
      try {
        const r = fn();
        this.db.exec(`RELEASE ${sp};`);
        return r;
      } catch (e) {
        try { this.db.exec(`ROLLBACK TO ${sp};`); this.db.exec(`RELEASE ${sp};`); } catch { /* ignore */ }
        throw this.mapDbError(e);
      } finally { this.txDepth--; }
    }
    this.txDepth = 1;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const r = fn();
      this.db.exec('COMMIT;');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK;'); } catch { /* ignore */ }
      throw this.mapDbError(e);
    } finally { this.txDepth = 0; }
  }

  private insertRow(table: string, columns: string[], values: Params): number {
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    return this.run(sql, values);
  }

  private tableExists(name: string): boolean {
    const row = this.oneRow("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [name]);
    return row !== null;
  }

  // ---------- 迁移/统计 ----------
  async migrate(): Promise<void> {
    this.assertOpen();
    const files = listMigrations();
    const applied = this.tableExists('schema_version')
      ? this.allRows('SELECT version, name, checksum FROM schema_version ORDER BY version ASC')
      : [];
    const appliedMap = new Map<number, Row>(applied.map((r) => [Number(r.version), r]));
    for (let i = 0; i < applied.length; i++) {
      if (!appliedMap.get(i + 1)) throw new AppError('CONFIG_INVALID', `schema_version 不连续：缺少 version=${i + 1}`);
    }
    if (applied.length > files.length) {
      throw new AppError('CONFIG_INVALID', `数据库 schema 版本(${applied.length})高于应用支持版本(${files.length})，禁止降级启动`);
    }
    for (const f of files) {
      const prev = appliedMap.get(f.version);
      if (prev) {
        if (String(prev.checksum) !== f.checksum) {
          throw new AppError('CONFIG_INVALID', `迁移文件校验和不匹配: ${f.name}（可能被篡改，拒绝启动）`);
        }
        continue;
      }
      const startedAt = Date.now();
      this.tx(() => {
        this.db.exec(f.sql);
        this.db.prepare(
          'INSERT INTO schema_version (version, name, checksum, app_version, execution_ms) VALUES (?, ?, ?, ?, ?)',
        ).run(f.version, f.name, f.checksum, APP_VERSION, Date.now() - startedAt);
      });
    }
    this.db.exec(`PRAGMA application_id = ${SQLITE_APP_ID};`);
    this.db.exec(`PRAGMA user_version = ${files.length};`);
    this.schemaCache = files.length;
  }

  async schemaVersion(): Promise<number> {
    if (this.schemaCache !== null) return this.schemaCache;
    if (!this.tableExists('schema_version')) return 0;
    const row = this.oneRow('SELECT MAX(version) AS v FROM schema_version');
    this.schemaCache = row && row.v !== null ? Number(row.v) : 0;
    return this.schemaCache;
  }

  async ping(): Promise<number> {
    const t0 = process.hrtime.bigint();
    this.oneRow('SELECT 1 AS ok');
    return Math.round(Number(process.hrtime.bigint() - t0) / 1000) / 1000; // ms，3 位小数
  }

  async stats(): Promise<DbStats> {
    let sizeBytes = 0;
    let walSizeBytes = 0;
    if (this.dbPath !== ':memory:') {
      try { sizeBytes = statSync(this.dbPath).size; } catch { sizeBytes = 0; }
      try { walSizeBytes = statSync(`${this.dbPath}-wal`).size; } catch { walSizeBytes = 0; }
    }
    return { sizeBytes, walSizeBytes, schemaVersion: await this.schemaVersion(), latencyMs: await this.ping() };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stmtCache.clear();
    try { this.db.close(); } catch { /* ignore */ }
  }

  // =========================================================================
  // accounts
  // =========================================================================
  private mapAccount(r: Row): Account {
    return {
      accountId: String(r.account_id),
      displayName: String(r.display_name),
      upstreamUsername: String(r.upstream_username),
      upstreamUserId: r.upstream_user_id ?? null,
      tenantCode: r.tenant_code ?? null,
      enterpriseName: r.enterprise_name ?? null,
      realName: r.real_name ?? null,
      enabled: r.status === 'enabled' && !r.deleted_at,
      concurrency: Number(r.concurrency_limit ?? 1),
      browserHeadless: r.browser_headless === null || r.browser_headless === undefined ? null : intToBool(r.browser_headless),
      browserProfileDir: r.profile_name ?? null,
      metadata: jsonParse<Record<string, string>>(r.metadata_json) ?? null,
      state: deriveAccountState(r),
      jwtExpiresAt: r.s_jwt_expires_at ?? null,
      lastLoginAt: r.s_last_login_at ?? null,
      lastCheckedAt: r.s_last_check_at ?? null,
      lastErrorJson: errorBriefJson(r.s_last_auth_error, String(r.updated_at)),
      agentCode: r.agent_code ?? null,
      telA: r.tel_a ?? null,
      lineId: r.line_id ?? null,
      lineName: r.line_name ?? null,
      lineMode: r.line_mode === null || r.line_mode === undefined ? null : Number(r.line_mode),
      dialCooldownMs: r.dial_cooldown_ms === null || r.dial_cooldown_ms === undefined ? null : Number(r.dial_cooldown_ms),
      origin: (r.origin as 'user' | 'restored') ?? 'user',
      status: (r.status as 'enabled' | 'disabled') ?? 'enabled',
      upstreamLineListJson: r.upstream_line_list_json ?? null,
      lastHealthJson: r.last_health_json ?? null,
      version: Number(r.version ?? 1),
      deletedAt: r.deleted_at ?? null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  async createAccount(a: Account): Promise<void> {
    const accountId = String(a.accountId);
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(accountId)) throw new AppError('VALIDATION_FAILED', 'accountId 需为 2–32 位 slug');
    const createdAt = normIsoReq(a.createdAt, 'createdAt');
    const updatedAt = normIso(a.updatedAt, 'updatedAt') ?? createdAt;
    const status = a.status ? ensureOneOf(a.status, ACCOUNT_STATUSES, 'status') : (a.enabled ? 'enabled' : 'disabled');
    const origin = a.origin ? ensureOneOf(a.origin, ACCOUNT_ORIGINS, 'origin') : 'user';
    const metadataJson = a.metadata === undefined || a.metadata === null ? '{}' : JSON.stringify(a.metadata);
    if (Buffer.byteLength(metadataJson, 'utf8') > 4096) throw new AppError('VALIDATION_FAILED', 'metadata 超过 4KB');
    this.insertRow('accounts',
      ['account_id', 'display_name', 'upstream_username', 'upstream_user_id', 'tenant_code', 'enterprise_name',
        'agent_code', 'real_name', 'tel_a', 'profile_name', 'browser_headless', 'credential_ref', 'line_id', 'line_name',
        'line_mode', 'status', 'concurrency_limit', 'dial_cooldown_ms', 'origin', 'upstream_line_list_json',
        'last_health_json', 'metadata_json', 'deleted_at', 'created_at', 'updated_at', 'version'],
      [
        accountId, a.displayName, a.upstreamUsername, a.upstreamUserId ?? null, a.tenantCode ?? null, a.enterpriseName ?? null,
        a.agentCode ?? null, a.realName ?? null, a.telA ?? null, a.browserProfileDir ?? accountId,
        boolToInt(a.browserHeadless), `secrets://${accountId}`, a.lineId ?? null, a.lineName ?? null,
        intOrNull(a.lineMode, 'lineMode'), status, Math.max(1, a.concurrency ?? 1), intOrNull(a.dialCooldownMs, 'dialCooldownMs'),
        origin, a.upstreamLineListJson ?? null, a.lastHealthJson ?? null, metadataJson,
        normIso(a.deletedAt, 'deletedAt'), createdAt, updatedAt, a.version ?? 1,
      ]);
  }

  async getAccount(accountId: string): Promise<Account | null> {
    const r = this.oneRow(`${ACCOUNT_SELECT} WHERE a.account_id = ?`, [accountId]);
    return r ? this.mapAccount(r) : null;
  }

  async listAccounts(opts: { enabled?: boolean } = {}): Promise<Account[]> {
    const where: string[] = ['a.deleted_at IS NULL'];
    const params: Params = [];
    if (opts.enabled !== undefined) { where.push('a.status = ?'); params.push(opts.enabled ? 'enabled' : 'disabled'); }
    const rows = this.allRows(`${ACCOUNT_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.created_at ASC, a.account_id ASC`, params);
    return rows.map((r) => this.mapAccount(r));
  }

  async updateAccount(accountId: string, patch: Partial<Account>): Promise<Account | null> {
    const sets: string[] = [];
    const params: Params = [];
    const push = (col: string, value: SQLInputValue): void => { sets.push(`${col} = ?`); params.push(value); };
    if (patch.displayName !== undefined) push('display_name', patch.displayName);
    if (patch.upstreamUsername !== undefined) push('upstream_username', patch.upstreamUsername);
    if (patch.upstreamUserId !== undefined) push('upstream_user_id', patch.upstreamUserId ?? null);
    if (patch.tenantCode !== undefined) push('tenant_code', patch.tenantCode ?? null);
    if (patch.enterpriseName !== undefined) push('enterprise_name', patch.enterpriseName ?? null);
    if (patch.realName !== undefined) push('real_name', patch.realName ?? null);
    if (patch.agentCode !== undefined) push('agent_code', patch.agentCode ?? null);
    if (patch.telA !== undefined) push('tel_a', patch.telA ?? null);
    if (patch.browserHeadless !== undefined) push('browser_headless', boolToInt(patch.browserHeadless ?? null));
    if (patch.browserProfileDir !== undefined) push('profile_name', patch.browserProfileDir);
    if (patch.lineId !== undefined) push('line_id', patch.lineId ?? null);
    if (patch.lineName !== undefined) push('line_name', patch.lineName ?? null);
    if (patch.lineMode !== undefined) push('line_mode', intOrNull(patch.lineMode, 'lineMode'));
    if (patch.dialCooldownMs !== undefined) push('dial_cooldown_ms', intOrNull(patch.dialCooldownMs, 'dialCooldownMs'));
    if (patch.origin !== undefined) push('origin', ensureOneOf(patch.origin, ACCOUNT_ORIGINS, 'origin'));
    if (patch.upstreamLineListJson !== undefined) push('upstream_line_list_json', jsonCheck(patch.upstreamLineListJson, 'upstreamLineListJson', 65536));
    if (patch.lastHealthJson !== undefined) push('last_health_json', jsonCheck(patch.lastHealthJson, 'lastHealthJson', 65536));
    if (patch.concurrency !== undefined) push('concurrency_limit', Math.max(1, patch.concurrency));
    if (patch.metadata !== undefined) {
      const metadataJson = patch.metadata === null ? '{}' : JSON.stringify(patch.metadata);
      if (Buffer.byteLength(metadataJson, 'utf8') > 4096) throw new AppError('VALIDATION_FAILED', 'metadata 超过 4KB');
      push('metadata_json', metadataJson);
    }
    if (patch.enabled !== undefined || patch.status !== undefined) {
      const status = patch.status ? ensureOneOf(patch.status, ACCOUNT_STATUSES, 'status') : (patch.enabled ? 'enabled' : 'disabled');
      push('status', status);
    }
    if (patch.deletedAt !== undefined) push('deleted_at', normIso(patch.deletedAt, 'deletedAt'));
    if (patch.version !== undefined) push('version', Math.max(1, patch.version));
    const sessionPatch = this.sessionColumnsFromAccountPatch(patch);
    if (sets.length === 0 && !sessionPatch) return this.getAccount(accountId);
    const updatedAt = normIso(patch.updatedAt, 'updatedAt') ?? nowIso();
    this.tx(() => {
      if (sets.length > 0) {
        sets.push('updated_at = ?');
        params.push(updatedAt);
        params.push(accountId);
        const changes = this.runDynamic(`UPDATE accounts SET ${sets.join(', ')} WHERE account_id = ?`, params);
        if (changes === 0) throw new AppError('ACCOUNT_NOT_FOUND', `账号不存在: ${accountId}`);
      }
      if (sessionPatch) {
        this.ensureSessionRow(accountId, updatedAt);
        const sp: Params = [...sessionPatch.params, updatedAt, accountId];
        this.runDynamic(`UPDATE account_sessions SET ${sessionPatch.sets.join(', ')}, updated_at = ?, version = version + 1 WHERE account_id = ?`, sp);
      }
    });
    return this.getAccount(accountId);
  }

  /** Account 上的会话级字段（jwtExpiresAt/lastLoginAt/lastCheckedAt/lastErrorJson/state）落到 account_sessions。 */
  private sessionColumnsFromAccountPatch(patch: Partial<Account>): { sets: string[]; params: Params } | null {
    const sets: string[] = [];
    const params: Params = [];
    if (patch.jwtExpiresAt !== undefined) { sets.push('jwt_expires_at = ?'); params.push(normIso(patch.jwtExpiresAt, 'jwtExpiresAt')); }
    if (patch.lastLoginAt !== undefined) { sets.push('last_login_at = ?'); params.push(normIso(patch.lastLoginAt, 'lastLoginAt')); }
    if (patch.lastCheckedAt !== undefined) { sets.push('last_check_at = ?'); params.push(normIso(patch.lastCheckedAt, 'lastCheckedAt')); }
    if (patch.lastErrorJson !== undefined) {
      const parsed = jsonParse<{ code?: string }>(patch.lastErrorJson ?? null);
      sets.push('last_auth_error = ?');
      params.push(parsed?.code ?? (patch.lastErrorJson ? String(patch.lastErrorJson) : null));
    }
    if (patch.state !== undefined) { sets.push('login_state = ?'); params.push(STATE_TO_LOGIN[patch.state] ?? 'unauthenticated'); }
    return sets.length > 0 ? { sets, params } : null;
  }

  private ensureSessionRow(accountId: string, at: IsoDateTime): void {
    const exists = this.oneRow('SELECT 1 AS x FROM account_sessions WHERE account_id = ?', [accountId]);
    if (!exists) {
      this.insertRow('account_sessions', ['account_id', 'login_state', 'updated_at', 'version'], [accountId, 'unauthenticated', at, 1]);
    }
  }

  async removeAccount(accountId: string): Promise<void> {
    const existing = this.oneRow('SELECT account_id FROM accounts WHERE account_id = ? AND deleted_at IS NULL', [accountId]);
    if (!existing) throw new AppError('ACCOUNT_NOT_FOUND', `账号不存在: ${accountId}`);
    const at = nowIso();
    this.tx(() => {
      this.run('UPDATE accounts SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE account_id = ?', [at, at, accountId]);
      this.run('DELETE FROM account_sessions WHERE account_id = ?', [accountId]);
    });
  }

  async hardDeleteAccount(accountId: string): Promise<void> {
    const existing = this.oneRow('SELECT account_id FROM accounts WHERE account_id = ?', [accountId]);
    if (!existing) throw new AppError('ACCOUNT_NOT_FOUND', `账号不存在: ${accountId}`);
    try {
      this.run('DELETE FROM accounts WHERE account_id = ?', [accountId]);
    } catch (e) {
      const msg = (e as Error).message;
      if (/FOREIGN KEY constraint failed/i.test(msg)) {
        throw new AppError('VALIDATION_FAILED', `账号 ${accountId} 存在历史话单/游标，禁止硬删除（需先按流程擦除）`);
      }
      throw e;
    }
  }

  async accountStats(accountId: string): Promise<{ totalCalls: number; calls24h: number; lastCallAt: IsoDateTime | null }> {
    const total = this.oneRow('SELECT COUNT(*) AS n FROM calls WHERE account_id = ?', [accountId]);
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const recent = this.oneRow('SELECT COUNT(*) AS n FROM calls WHERE account_id = ? AND started_at >= ?', [accountId, since]);
    const last = this.oneRow('SELECT MAX(started_at) AS t FROM calls WHERE account_id = ?', [accountId]);
    return { totalCalls: Number(total?.n ?? 0), calls24h: Number(recent?.n ?? 0), lastCallAt: (last?.t as string | undefined) ?? null };
  }

  // =========================================================================
  // account_sessions
  // =========================================================================
  private mapSession(r: Row): AccountSession {
    const loginState = (r.login_state as string | null) ?? 'unauthenticated';
    const token = r.jwt_ciphertext ? Buffer.from(r.jwt_ciphertext as Uint8Array).toString('utf8') : null;
    return {
      accountId: String(r.account_id),
      token,
      tokenKeyId: r.jwt_key_id ?? null,
      cookieState: cookieStateOf(loginState),
      wsConnected: intToBool(r.ws_connected),
      lastPongAt: r.ws_last_pong_at ?? null,
      loginState: loginState as AccountSession['loginState'],
      loginFailCount: Number(r.login_fail_count ?? 0),
      lastLoginJobId: r.last_login_job_id ?? null,
      lastAuthError: r.last_auth_error ?? null,
      wsConnectedAt: r.ws_connected_at ?? null,
      healthStatus: (r.health_status as AccountSession['healthStatus']) ?? 'unknown',
      healthDetailJson: r.health_detail_json ?? null,
      version: Number(r.version ?? 1),
      state: deriveAccountState({
        status: 'enabled', deleted_at: null,
        s_login_state: loginState, s_jwt_expires_at: r.jwt_expires_at, s_health_status: r.health_status,
      }),
      updatedAt: String(r.updated_at),
    };
  }

  async getSession(accountId: string): Promise<AccountSession | null> {
    const r = this.oneRow('SELECT * FROM account_sessions WHERE account_id = ?', [accountId]);
    return r ? this.mapSession(r) : null;
  }

  async upsertSession(s: AccountSession): Promise<void> {
    const loginState = s.loginState ? ensureOneOf(s.loginState, LOGIN_STATES, 'loginState') : (STATE_TO_LOGIN[s.state] ?? 'unauthenticated');
    const healthStatus = s.healthStatus ? ensureOneOf(s.healthStatus, HEALTH_STATUSES, 'healthStatus') : 'unknown';
    const tokenBuf: Uint8Array | null = s.token ? new Uint8Array(Buffer.from(s.token, 'utf8')) : null;
    const keyId = s.tokenKeyId ?? (s.token ? 'plain-v1' : null);
    const updatedAt = normIso(s.updatedAt, 'updatedAt') ?? nowIso();
    const columns = ['account_id', 'jwt_ciphertext', 'jwt_key_id', 'jwt_expires_at', 'login_state', 'login_fail_count',
      'last_login_job_id', 'last_auth_error', 'ws_connected', 'ws_connected_at', 'ws_last_pong_at', 'health_status',
      'health_detail_json', 'updated_at', 'version'];
    const values: Params = [
      s.accountId, tokenBuf, keyId, normIso(s.jwtExpiresAt ?? null, 'jwtExpiresAt'), loginState, intOrNull(s.loginFailCount, 'loginFailCount') ?? 0,
      s.lastLoginJobId ?? null, s.lastAuthError ?? null, boolToInt(s.wsConnected) ?? 0,
      normIso(s.wsConnectedAt, 'wsConnectedAt'), normIso(s.lastPongAt, 'lastPongAt'), healthStatus,
      jsonCheck(s.healthDetailJson, 'healthDetailJson', 65536), updatedAt, s.version ?? 1,
    ];
    const updates = columns.filter((c) => c !== 'account_id').map((c) => `${c} = excluded.${c}`);
    updates.push('jwt_expires_at = COALESCE(excluded.jwt_expires_at, account_sessions.jwt_expires_at)');
    this.run(
      `INSERT INTO account_sessions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
       ON CONFLICT(account_id) DO UPDATE SET ${updates.filter((u) => !u.startsWith('jwt_expires_at = COALESCE')).join(', ')},
         jwt_expires_at = COALESCE(excluded.jwt_expires_at, account_sessions.jwt_expires_at),
         version = account_sessions.version + 1`,
      values,
    );
  }

  async deleteSession(accountId: string): Promise<void> {
    this.run('DELETE FROM account_sessions WHERE account_id = ?', [accountId]);
  }

  // =========================================================================
  // calls
  // =========================================================================
  private mapUpstreamStatus(r: Row): string | null {
    const obj: Record<string, unknown> = {};
    if (r.call_status !== null && r.call_status !== undefined) obj.callStatus = Number(r.call_status);
    if (r.call_status_name !== null && r.call_status_name !== undefined) obj.callStatusName = r.call_status_name;
    if (r.finish_status !== null && r.finish_status !== undefined) obj.finishStatus = Number(r.finish_status);
    if (r.finish_status_name !== null && r.finish_status_name !== undefined) obj.finishStatusName = r.finish_status_name;
    return Object.keys(obj).length > 0 ? JSON.stringify(obj) : null;
  }

  private mapCall(r: Row): Call {
    const stage = r.audio_last_error_code ? 'audio' : (r.transcript_last_error_code ? 'transcript' : (r.analysis_last_error_code ? 'analysis' : null));
    const stageError = stage === 'audio' ? r.audio_last_error_code : stage === 'transcript' ? r.transcript_last_error_code : stage === 'analysis' ? r.analysis_last_error_code : null;
    return {
      callId: String(r.call_id),
      accountId: String(r.account_id),
      upstreamCallId: r.upstream_call_id ?? null,
      direction: 'outbound',
      toPhone: String(r.to_phone),
      toLocation: r.to_location ?? null,
      fromPhone: r.from_phone ?? null,
      fromLocation: r.from_location ?? null,
      lineNumber: r.line_number ?? null,
      customerName: r.customer_name ?? null,
      lineId: r.line_id ?? null,
      lineName: r.line_name ?? null,
      status: r.status as CallStatus,
      statusReason: r.failed_reason ?? null,
      dialedAt: r.dialed_at ?? null,
      submittedAt: r.submitted_at ?? null,
      answeredAt: r.answered_at ?? null,
      endedAt: r.ended_at ?? null,
      durationSec: r.duration_sec === null || r.duration_sec === undefined ? null : Number(r.duration_sec),
      cost: r.cost_cents === null || r.cost_cents === undefined ? null : Number(r.cost_cents) / 100,
      upstreamStatusJson: this.mapUpstreamStatus(r),
      upstreamRawJson: r.raw_upstream_json ?? null,
      metadataJson: r.metadata_json ?? null,
      audioStatus: r.audio_status as StageStatus,
      transcriptStatus: r.transcript_status as StageStatus,
      analysisStatus: r.analysis_status as StageStatus,
      pipelineLastErrorJson: stageError ? JSON.stringify({ code: stageError, stage, at: String(r.updated_at) }) : null,
      dialState: r.dial_state ?? null,
      upstreamError: r.upstream_error ?? null,
      origin: (r.origin as 'local_dial' | 'sync') ?? 'local_dial',
      upstreamUserId: r.upstream_user_id ?? null,
      scheduledAt: r.scheduled_at ?? null,
      startedAt: r.started_at ?? null,
      canceledAt: r.canceled_at ?? null,
      upstreamBindId: r.upstream_bind_id ?? null,
      failedReason: r.failed_reason ?? null,
      errorCode: r.error_code ?? null,
      reconciledAt: r.reconciled_at ?? null,
      audioRetryCount: Number(r.audio_retry_count ?? 0),
      transcriptRetryCount: Number(r.transcript_retry_count ?? 0),
      analysisRetryCount: Number(r.analysis_retry_count ?? 0),
      audioLastErrorCode: r.audio_last_error_code ?? null,
      transcriptLastErrorCode: r.transcript_last_error_code ?? null,
      analysisLastErrorCode: r.analysis_last_error_code ?? null,
      reprocessCount: Number(r.reprocess_count ?? 0),
      lastSyncedAt: r.last_synced_at ?? null,
      upstreamCreateTimeMs: r.upstream_create_time_ms === null || r.upstream_create_time_ms === undefined ? null : Number(r.upstream_create_time_ms),
      upstreamStartTimeMs: r.upstream_start_time_ms === null || r.upstream_start_time_ms === undefined ? null : Number(r.upstream_start_time_ms),
      upstreamEndTimeMs: r.upstream_end_time_ms === null || r.upstream_end_time_ms === undefined ? null : Number(r.upstream_end_time_ms),
      upstreamUpdateTimeMs: r.upstream_update_time_ms === null || r.upstream_update_time_ms === undefined ? null : Number(r.upstream_update_time_ms),
      handleStatus: r.handle_status === null || r.handle_status === undefined ? null : Number(r.handle_status),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      version: Number(r.version ?? 1),
    };
  }

  private splitPipelineError(json: string | null | undefined): { stage: 'audio' | 'transcript' | 'analysis'; code: string } | null {
    if (!json) return null;
    const parsed = jsonParse<Record<string, unknown>>(json);
    if (!parsed) throw new AppError('VALIDATION_FAILED', 'pipelineLastErrorJson 不是合法 JSON');
    const code = typeof parsed.code === 'string' ? parsed.code : null;
    if (!code) return null;
    const stage = parsed.stage === 'audio' || parsed.stage === 'analysis' ? parsed.stage : 'transcript';
    return { stage, code };
  }

  async insertCall(c: Call): Promise<void> {
    const status = ensureOneOf(c.status, CALL_STATUSES, 'status');
    const audioStatus = ensureOneOf(c.audioStatus, STAGE_STATUSES, 'audioStatus');
    const transcriptStatus = ensureOneOf(c.transcriptStatus, STAGE_STATUSES, 'transcriptStatus');
    const analysisStatus = ensureOneOf(c.analysisStatus, STAGE_STATUSES, 'analysisStatus');
    const origin = c.origin ? ensureOneOf(c.origin, ORIGINS, 'origin') : 'local_dial';
    const dialState = c.dialState ? ensureOneOf(c.dialState, DIAL_STATES, 'dialState') : 'none';
    if (c.direction !== undefined && c.direction !== 'outbound') throw new AppError('VALIDATION_FAILED', "direction 仅支持 'outbound'");
    const createdAt = normIsoReq(c.createdAt, 'createdAt');
    const updatedAt = normIso(c.updatedAt, 'updatedAt') ?? createdAt;
    const startedAt = normIso(c.startedAt, 'startedAt') ?? normIso(c.dialedAt, 'dialedAt') ?? normIso(c.submittedAt, 'submittedAt') ?? createdAt;
    const upstreamStatus = jsonParse<Record<string, unknown>>(c.upstreamStatusJson ?? null) ?? {};
    const pipelineErr = this.splitPipelineError(c.pipelineLastErrorJson ?? null);
    const costCents = c.cost === null || c.cost === undefined ? null : Math.round(c.cost * 100);
    const errCol = (stage: 'audio' | 'transcript' | 'analysis'): string | null => (pipelineErr?.stage === stage ? pipelineErr.code : null);
    const readyAt = (s: StageStatus): IsoDateTime | null => (s === 'ready' ? updatedAt : null);
    this.insertRow('calls',
      ['call_id', 'account_id', 'upstream_call_id', 'upstream_user_id', 'origin', 'status', 'from_phone', 'to_phone',
        'customer_name', 'line_number', 'line_id', 'line_name', 'call_type', 'call_status', 'call_status_name',
        'finish_status', 'finish_status_name', 'handle_status', 'started_at', 'dialed_at', 'submitted_at', 'dial_state',
        'upstream_bind_id', 'answered_at', 'ended_at', 'canceled_at', 'scheduled_at', 'duration_sec', 'cost_cents',
        'from_location', 'to_location', 'upstream_error', 'error_code', 'failed_reason', 'reconciled_at',
        'audio_status', 'audio_retry_count', 'audio_last_error_code', 'audio_ready_at',
        'transcript_status', 'transcript_source', 'transcript_retry_count', 'transcript_last_error_code', 'transcript_ready_at',
        'analysis_status', 'analysis_retry_count', 'analysis_last_error_code', 'analysis_ready_at', 'pipeline_updated_at',
        'reprocess_count', 'upstream_create_time_ms', 'upstream_start_time_ms', 'upstream_end_time_ms',
        'upstream_update_time_ms', 'last_synced_at', 'raw_upstream_json', 'metadata_json', 'version', 'created_at', 'updated_at'],
      [
        c.callId, c.accountId, c.upstreamCallId ?? null, c.upstreamUserId ?? null, origin, status,
        c.fromPhone ?? null, c.toPhone, c.customerName ?? null, c.lineNumber ?? null, c.lineId ?? null, c.lineName ?? null,
        null,
        upstreamStatus.callStatus === undefined ? null : intOrNull(upstreamStatus.callStatus, 'callStatus'),
        (upstreamStatus.callStatusName as string | undefined) ?? null,
        upstreamStatus.finishStatus === undefined ? null : intOrNull(upstreamStatus.finishStatus, 'finishStatus'),
        (upstreamStatus.finishStatusName as string | undefined) ?? null,
        intOrNull(c.handleStatus, 'handleStatus'), startedAt, normIso(c.dialedAt, 'dialedAt'), normIso(c.submittedAt, 'submittedAt'),
        dialState, c.upstreamBindId ?? null, normIso(c.answeredAt, 'answeredAt'), normIso(c.endedAt, 'endedAt'),
        normIso(c.canceledAt, 'canceledAt'), normIso(c.scheduledAt, 'scheduledAt'), intOrNull(c.durationSec, 'durationSec'),
        costCents, c.fromLocation ?? null, c.toLocation ?? null, c.upstreamError ?? null, c.errorCode ?? null,
        c.failedReason ?? c.statusReason ?? null, normIso(c.reconciledAt, 'reconciledAt'),
        audioStatus, intOrNull(c.audioRetryCount, 'audioRetryCount') ?? 0, c.audioLastErrorCode ?? errCol('audio'), readyAt(audioStatus),
        transcriptStatus, transcriptStatus === 'ready' ? 'asr' : null,
        intOrNull(c.transcriptRetryCount, 'transcriptRetryCount') ?? 0, c.transcriptLastErrorCode ?? errCol('transcript'), readyAt(transcriptStatus),
        analysisStatus, intOrNull(c.analysisRetryCount, 'analysisRetryCount') ?? 0, c.analysisLastErrorCode ?? errCol('analysis'),
        readyAt(analysisStatus), updatedAt, intOrNull(c.reprocessCount, 'reprocessCount') ?? 0,
        numOrNull(c.upstreamCreateTimeMs, 'upstreamCreateTimeMs'), numOrNull(c.upstreamStartTimeMs, 'upstreamStartTimeMs'),
        numOrNull(c.upstreamEndTimeMs, 'upstreamEndTimeMs'), numOrNull(c.upstreamUpdateTimeMs, 'upstreamUpdateTimeMs'),
        normIso(c.lastSyncedAt, 'lastSyncedAt'), jsonCheck(c.upstreamRawJson, 'upstreamRawJson', 65536),
        c.metadataJson === null || c.metadataJson === undefined ? '{}' : jsonCheck(c.metadataJson, 'metadataJson', 4096),
        c.version ?? 1, createdAt, updatedAt,
      ]);
  }

  async getCall(callId: string): Promise<Call | null> {
    const r = this.oneRow('SELECT * FROM calls WHERE call_id = ?', [callId]);
    return r ? this.mapCall(r) : null;
  }

  async getCallByUpstream(accountId: string, upstreamCallId: string): Promise<Call | null> {
    const r = this.oneRow('SELECT * FROM calls WHERE account_id = ? AND upstream_call_id = ?', [accountId, upstreamCallId]);
    return r ? this.mapCall(r) : null;
  }

  async updateCall(callId: string, patch: Partial<Call>, expectedVersion?: number | null): Promise<Call | null> {
    const sets: string[] = [];
    const params: Params = [];
    const push = (col: string, value: SQLInputValue): void => { sets.push(`${col} = ?`); params.push(value); };
    if (patch.upstreamCallId !== undefined) push('upstream_call_id', patch.upstreamCallId ?? null);
    if (patch.upstreamUserId !== undefined) push('upstream_user_id', patch.upstreamUserId ?? null);
    if (patch.origin !== undefined) push('origin', ensureOneOf(patch.origin, ORIGINS, 'origin'));
    if (patch.status !== undefined) push('status', ensureOneOf(patch.status, CALL_STATUSES, 'status'));
    if (patch.fromPhone !== undefined) push('from_phone', patch.fromPhone ?? null);
    if (patch.toPhone !== undefined) push('to_phone', patch.toPhone);
    if (patch.customerName !== undefined) push('customer_name', patch.customerName ?? null);
    if (patch.lineNumber !== undefined) push('line_number', patch.lineNumber ?? null);
    if (patch.lineId !== undefined) push('line_id', patch.lineId ?? null);
    if (patch.lineName !== undefined) push('line_name', patch.lineName ?? null);
    if (patch.handleStatus !== undefined) push('handle_status', intOrNull(patch.handleStatus, 'handleStatus'));
    if (patch.startedAt !== undefined) push('started_at', normIsoReq(patch.startedAt, 'startedAt'));
    if (patch.dialedAt !== undefined) push('dialed_at', normIso(patch.dialedAt, 'dialedAt'));
    if (patch.submittedAt !== undefined) push('submitted_at', normIso(patch.submittedAt, 'submittedAt'));
    if (patch.dialState !== undefined) push('dial_state', patch.dialState === null ? null : ensureOneOf(patch.dialState, DIAL_STATES, 'dialState'));
    if (patch.upstreamBindId !== undefined) push('upstream_bind_id', patch.upstreamBindId ?? null);
    if (patch.answeredAt !== undefined) push('answered_at', normIso(patch.answeredAt, 'answeredAt'));
    if (patch.endedAt !== undefined) push('ended_at', normIso(patch.endedAt, 'endedAt'));
    if (patch.canceledAt !== undefined) push('canceled_at', normIso(patch.canceledAt, 'canceledAt'));
    if (patch.scheduledAt !== undefined) push('scheduled_at', normIso(patch.scheduledAt, 'scheduledAt'));
    if (patch.durationSec !== undefined) push('duration_sec', intOrNull(patch.durationSec, 'durationSec'));
    if (patch.cost !== undefined) push('cost_cents', patch.cost === null ? null : Math.round(patch.cost * 100));
    if (patch.toLocation !== undefined) push('to_location', patch.toLocation ?? null);
    if (patch.fromLocation !== undefined) push('from_location', patch.fromLocation ?? null);
    if (patch.upstreamError !== undefined) push('upstream_error', patch.upstreamError ?? null);
    if (patch.errorCode !== undefined) push('error_code', patch.errorCode ?? null);
    if (patch.failedReason !== undefined || patch.statusReason !== undefined) {
      push('failed_reason', (patch.failedReason ?? patch.statusReason) ?? null);
    }
    if (patch.reconciledAt !== undefined) push('reconciled_at', normIso(patch.reconciledAt, 'reconciledAt'));
    if (patch.audioStatus !== undefined) {
      const s = ensureOneOf(patch.audioStatus, STAGE_STATUSES, 'audioStatus');
      push('audio_status', s);
      if (s === 'ready') push('audio_ready_at', nowIso());
    }
    if (patch.audioRetryCount !== undefined) push('audio_retry_count', intOrNull(patch.audioRetryCount, 'audioRetryCount') ?? 0);
    if (patch.audioLastErrorCode !== undefined) push('audio_last_error_code', patch.audioLastErrorCode ?? null);
    if (patch.transcriptStatus !== undefined) {
      const s = ensureOneOf(patch.transcriptStatus, STAGE_STATUSES, 'transcriptStatus');
      push('transcript_status', s);
      if (s === 'ready') { push('transcript_source', 'asr'); push('transcript_ready_at', nowIso()); }
    }
    if (patch.transcriptRetryCount !== undefined) push('transcript_retry_count', intOrNull(patch.transcriptRetryCount, 'transcriptRetryCount') ?? 0);
    if (patch.transcriptLastErrorCode !== undefined) push('transcript_last_error_code', patch.transcriptLastErrorCode ?? null);
    if (patch.analysisStatus !== undefined) {
      const s = ensureOneOf(patch.analysisStatus, STAGE_STATUSES, 'analysisStatus');
      push('analysis_status', s);
      if (s === 'ready') push('analysis_ready_at', nowIso());
    }
    if (patch.analysisRetryCount !== undefined) push('analysis_retry_count', intOrNull(patch.analysisRetryCount, 'analysisRetryCount') ?? 0);
    if (patch.analysisLastErrorCode !== undefined) push('analysis_last_error_code', patch.analysisLastErrorCode ?? null);
    if (patch.pipelineLastErrorJson !== undefined) {
      const err = this.splitPipelineError(patch.pipelineLastErrorJson ?? null);
      for (const stage of JOB_STAGES) push(`${stage}_last_error_code`, err && err.stage === stage ? err.code : null);
    }
    if (patch.reprocessCount !== undefined) push('reprocess_count', intOrNull(patch.reprocessCount, 'reprocessCount') ?? 0);
    if (patch.lastSyncedAt !== undefined) push('last_synced_at', normIso(patch.lastSyncedAt, 'lastSyncedAt'));
    if (patch.upstreamCreateTimeMs !== undefined) push('upstream_create_time_ms', numOrNull(patch.upstreamCreateTimeMs, 'upstreamCreateTimeMs'));
    if (patch.upstreamStartTimeMs !== undefined) push('upstream_start_time_ms', numOrNull(patch.upstreamStartTimeMs, 'upstreamStartTimeMs'));
    if (patch.upstreamEndTimeMs !== undefined) push('upstream_end_time_ms', numOrNull(patch.upstreamEndTimeMs, 'upstreamEndTimeMs'));
    if (patch.upstreamUpdateTimeMs !== undefined) push('upstream_update_time_ms', numOrNull(patch.upstreamUpdateTimeMs, 'upstreamUpdateTimeMs'));
    if (patch.upstreamStatusJson !== undefined) {
      const u = jsonParse<Record<string, unknown>>(patch.upstreamStatusJson ?? null) ?? {};
      push('call_status', u.callStatus === undefined ? null : intOrNull(u.callStatus, 'callStatus'));
      push('call_status_name', (u.callStatusName as string | undefined) ?? null);
      push('finish_status', u.finishStatus === undefined ? null : intOrNull(u.finishStatus, 'finishStatus'));
      push('finish_status_name', (u.finishStatusName as string | undefined) ?? null);
    }
    if (patch.upstreamRawJson !== undefined) push('raw_upstream_json', jsonCheck(patch.upstreamRawJson, 'upstreamRawJson', 65536));
    if (patch.metadataJson !== undefined) push('metadata_json', patch.metadataJson === null ? '{}' : jsonCheck(patch.metadataJson, 'metadataJson', 4096));
    if (sets.length === 0) return this.getCall(callId);
    const updatedAt = normIso(patch.updatedAt, 'updatedAt') ?? nowIso();
    sets.push('pipeline_updated_at = ?', 'updated_at = ?', 'version = version + 1');
    params.push(updatedAt, updatedAt);
    params.push(callId);
    let where = 'call_id = ?';
    if (expectedVersion !== undefined && expectedVersion !== null) {
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new AppError('VALIDATION_FAILED', 'expectedVersion 必须为 >=1 的整数');
      where += ' AND version = ?';
      params.push(expectedVersion);
    }
    const changes = this.runDynamic(`UPDATE calls SET ${sets.join(', ')} WHERE ${where}`, params);
    return changes > 0 ? this.getCall(callId) : null;
  }

  private callOrderBy(sort?: string): string {
    const raw = sort && sort.length > 0 ? sort : '-createdAt';
    const desc = raw.startsWith('-');
    const key = desc ? raw.slice(1) : raw;
    const map: Record<string, string> = {
      createdAt: 'c.started_at',
      startedAt: 'c.started_at',
      dialedAt: 'COALESCE(c.dialed_at, c.submitted_at, c.started_at)',
      endedAt: 'c.ended_at',
      durationSec: 'c.duration_sec',
    };
    const col = map[key];
    if (!col) {
      throw new AppError('VALIDATION_FAILED', `非法排序字段: ${key}`, {
        details: { fields: [{ field: 'sort', reason: `allowed: ${Object.keys(map).join(',')}` }] },
      });
    }
    const dir = desc ? 'DESC' : 'ASC';
    return `${col} ${dir}, c.call_id ${dir}`;
  }

  async listCalls(f: CallFilter): Promise<ListResult<Call>> {
    const { size, offset } = pageOf(f);
    const where: string[] = [];
    const params: Params = [];
    if (f.accountIds && f.accountIds.length > 0) {
      where.push(`c.account_id IN (${f.accountIds.map(() => '?').join(',')})`);
      params.push(...f.accountIds);
    }
    if (f.statuses && f.statuses.length > 0) {
      for (const s of f.statuses) ensureOneOf(s, CALL_STATUSES, 'statuses');
      where.push(`c.status IN (${f.statuses.map(() => '?').join(',')})`);
      params.push(...f.statuses);
    }
    const stageFilter = (col: string, values: StageStatus[] | undefined, field: string): void => {
      if (!values || values.length === 0) return;
      for (const s of values) ensureOneOf(s, STAGE_STATUSES, field);
      where.push(`c.${col} IN (${values.map(() => '?').join(',')})`);
      params.push(...values);
    };
    stageFilter('audio_status', f.pipelineAudio, 'pipelineAudio');
    stageFilter('transcript_status', f.pipelineTranscript, 'pipelineTranscript');
    stageFilter('analysis_status', f.pipelineAnalysis, 'pipelineAnalysis');
    if (f.hasAudio !== undefined) where.push(f.hasAudio ? "c.audio_status = 'ready'" : "c.audio_status <> 'ready'");
    if (f.hasTranscript !== undefined) where.push(f.hasTranscript ? "c.transcript_status = 'ready'" : "c.transcript_status <> 'ready'");
    if (f.toPhoneLike) {
      const raw = String(f.toPhoneLike).trim();
      const digits = stripDigits(raw);
      if (digits.length >= 3) {
        if (raw.startsWith('*')) {
          where.push("c.to_phone LIKE ? ESCAPE '\\'");
          params.push(`%${escapeLike(digits)}`);
        } else if (digits.length === 11) {
          where.push('c.to_phone = ?');
          params.push(digits);
        } else {
          where.push("c.to_phone LIKE ? ESCAPE '\\'");
          params.push(`%${escapeLike(digits)}`);
        }
      } else if (raw.length > 0) {
        throw new AppError('VALIDATION_FAILED', 'to 过滤需为号码或 *后缀（至少 3 位数字）');
      }
    }
    if (f.q) {
      const q = f.q.trim();
      if (q.length === 0) throw new AppError('VALIDATION_FAILED', 'q 不能为空白');
      if (q.length > 64) throw new AppError('VALIDATION_FAILED', 'q 长度需 ≤64');
      const like = `%${escapeLike(q)}%`;
      where.push(`(c.customer_name LIKE ? ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM transcripts t WHERE t.call_id = c.call_id AND t.is_current = 1
          AND (t.full_text LIKE ? ESCAPE '\\' OR t.full_text_raw LIKE ? ESCAPE '\\')))`);
      params.push(like, like, like);
    }
    const range = shanghaiDateRange(f.dateFrom, f.dateTo);
    if (range.from) { where.push('c.started_at >= ?'); params.push(range.from); }
    if (range.to) { where.push('c.started_at < ?'); params.push(range.to); }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = this.callOrderBy(f.sort);
    const totalRow = this.oneRow(`SELECT COUNT(*) AS n FROM calls c ${whereSql}`, params);
    const rows = this.allDynamic(`SELECT c.* FROM calls c ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`, [...params, size, offset]);
    return { items: rows.map((r) => this.mapCall(r)), total: Number(totalRow?.n ?? 0) };
  }

  async findRecentDial(accountId: string, toPhone: string, sinceIso: IsoDateTime): Promise<Call | null> {
    const since = normIsoReq(sinceIso, 'sinceIso');
    const r = this.oneRow(
      'SELECT * FROM calls WHERE account_id = ? AND to_phone = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1',
      [accountId, toPhone, since],
    );
    return r ? this.mapCall(r) : null;
  }

  async countOpenCalls(accountId: string): Promise<number> {
    const r = this.oneRow("SELECT COUNT(*) AS n FROM calls WHERE account_id = ? AND status IN ('pending','dialing','connected')", [accountId]);
    return Number(r?.n ?? 0);
  }

  async countByStatus(status: CallStatus): Promise<number> {
    ensureOneOf(status, CALL_STATUSES, 'status');
    const r = this.oneRow('SELECT COUNT(*) AS n FROM calls WHERE status = ?', [status]);
    return Number(r?.n ?? 0);
  }

  async pipelinePendingCounts(): Promise<{ audioPending: number; transcriptPending: number; analysisPending: number }> {
    const r = this.oneRow(`SELECT
      SUM(CASE WHEN audio_status = 'pending' THEN 1 ELSE 0 END) AS audio_pending,
      SUM(CASE WHEN transcript_status = 'pending' THEN 1 ELSE 0 END) AS transcript_pending,
      SUM(CASE WHEN analysis_status = 'pending' THEN 1 ELSE 0 END) AS analysis_pending
      FROM calls`);
    return {
      audioPending: Number(r?.audio_pending ?? 0),
      transcriptPending: Number(r?.transcript_pending ?? 0),
      analysisPending: Number(r?.analysis_pending ?? 0),
    };
  }

  async listCallsByStage(stage: 'audio' | 'transcript' | 'analysis', limit: number): Promise<Call[]> {
    const col = stage === 'audio' ? 'audio_status' : stage === 'transcript' ? 'transcript_status' : 'analysis_status';
    const n = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const rows = this.allRows(`SELECT * FROM calls WHERE ${col} = 'pending' ORDER BY started_at ASC, call_id ASC LIMIT ?`, [n]);
    return rows.map((r) => this.mapCall(r));
  }

  // =========================================================================
  // audio_assets
  // =========================================================================
  private mapAudio(r: Row): AudioAsset {
    return {
      audioId: String(r.audio_id),
      callId: String(r.call_id),
      sourceUrl: (r.source_url as string | null) ?? '',
      storagePath: String(r.storage_path),
      format: String(r.format),
      sampleRate: Number(r.sample_rate_hz),
      channels: Number(r.channels),
      durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
      sizeBytes: Number(r.size_bytes),
      sha256: String(r.sha256),
      downloadedAt: String(r.fetched_at),
    };
  }

  async upsertAudio(a: AudioAsset): Promise<void> {
    if ((a.format || 'wav') !== 'wav') throw new AppError('VALIDATION_FAILED', "v1 录音格式仅支持 'wav'");
    if (!/^[0-9a-f]{64}$/.test(a.sha256)) throw new AppError('VALIDATION_FAILED', 'sha256 需为 64 位小写 hex');
    if (!Number.isInteger(a.sizeBytes) || a.sizeBytes <= 0) throw new AppError('VALIDATION_FAILED', 'sizeBytes 需为正整数');
    if (a.channels !== 1 && a.channels !== 2) throw new AppError('VALIDATION_FAILED', 'channels 仅支持 1/2');
    const downloadedAt = normIso(a.downloadedAt, 'downloadedAt') ?? nowIso();
    this.run(
      `INSERT INTO audio_assets (audio_id, call_id, source_url, storage_path, sha256, size_bytes, duration_ms, format,
         sample_rate_hz, channels, bits_per_sample, download_attempts, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'wav', ?, ?, 16, 0, ?)
       ON CONFLICT(call_id) DO UPDATE SET
         source_url = excluded.source_url, storage_path = excluded.storage_path, sha256 = excluded.sha256,
         size_bytes = excluded.size_bytes, duration_ms = excluded.duration_ms, sample_rate_hz = excluded.sample_rate_hz,
         channels = excluded.channels, fetched_at = excluded.fetched_at`,
      [a.audioId, a.callId, a.sourceUrl || null, a.storagePath, a.sha256, a.sizeBytes,
        intOrNull(a.durationMs, 'durationMs'), Math.max(1, a.sampleRate), a.channels, downloadedAt],
    );
  }

  async getAudioByCall(callId: string): Promise<AudioAsset | null> {
    const r = this.oneRow('SELECT * FROM audio_assets WHERE call_id = ?', [callId]);
    return r ? this.mapAudio(r) : null;
  }

  // =========================================================================
  // transcripts / segments
  // =========================================================================
  private mapTranscript(r: Row): Transcript {
    const status = (r.c_transcript_status as StageStatus | undefined) ?? 'pending';
    const errCode = (r.c_transcript_last_error_code as string | null | undefined) ?? null;
    return {
      transcriptId: String(r.transcript_id),
      callId: String(r.call_id),
      source: 'asr',
      provider: String(r.provider),
      status,
      isCurrent: intToBool(r.is_current),
      language: String(r.language),
      fullText: r.full_text ?? null,
      fullTextRaw: r.full_text_raw ?? null,
      durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
      chunkCount: r.chunk_count === null || r.chunk_count === undefined ? null : Number(r.chunk_count),
      needsReview: intToBool(r.needs_review),
      speakerMappingJson: r.speaker_mapping_json ?? null,
      asrMetaJson: r.asr_meta_json ?? null,
      revision: Number(r.revision ?? 1),
      segmentCount: Number(r.segment_count ?? 0),
      lastErrorJson: errCode ? JSON.stringify({ code: errCode, at: String(r.updated_at) }) : null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  async createTranscript(t: Transcript): Promise<void> {
    if (t.source !== 'asr') throw new AppError('VALIDATION_FAILED', "transcripts.source 固定为 'asr'");
    const createdAt = normIso(t.createdAt, 'createdAt') ?? nowIso();
    const updatedAt = normIso(t.updatedAt, 'updatedAt') ?? createdAt;
    this.tx(() => {
      const revRow = this.oneRow('SELECT COALESCE(MAX(revision), 0) + 1 AS rev FROM transcripts WHERE call_id = ?', [t.callId]);
      const revision = Number(revRow?.rev ?? 1);
      if (t.isCurrent) this.run('UPDATE transcripts SET is_current = 0 WHERE call_id = ? AND is_current = 1', [t.callId]);
      this.insertRow('transcripts',
        ['transcript_id', 'call_id', 'source', 'provider', 'revision', 'is_current', 'language', 'duration_ms',
          'segment_count', 'chunk_count', 'needs_review', 'speaker_mapping_json', 'asr_meta_json', 'full_text',
          'full_text_raw', 'created_at', 'updated_at', 'version'],
        [
          t.transcriptId, t.callId, 'asr', t.provider || 'minimax:asr-1.0', revision, boolToInt(t.isCurrent) ?? 1,
          t.language || 'zh-CN', intOrNull(t.durationMs, 'durationMs'), intOrNull(t.segmentCount, 'segmentCount') ?? 0,
          Math.max(1, intOrNull(t.chunkCount, 'chunkCount') ?? 1), boolToInt(t.needsReview) ?? 0,
          jsonCheck(t.speakerMappingJson, 'speakerMappingJson', 65536), jsonCheck(t.asrMetaJson, 'asrMetaJson', 65536),
          t.fullText ?? null, t.fullTextRaw ?? null, createdAt, updatedAt, 1,
        ]);
      // 分块回填：同一 call + revision 的块结果绑定到该转写版本（docs/04 §5.15）
      this.run(
        'UPDATE transcript_chunks SET transcript_id = ?, updated_at = ? WHERE call_id = ? AND revision = ? AND transcript_id IS NULL',
        [t.transcriptId, updatedAt, t.callId, revision],
      );
    });
  }

  async updateTranscript(transcriptId: string, patch: Partial<Transcript>): Promise<Transcript | null> {
    const sets: string[] = [];
    const params: Params = [];
    const push = (col: string, value: SQLInputValue): void => { sets.push(`${col} = ?`); params.push(value); };
    if (patch.provider !== undefined) push('provider', patch.provider);
    if (patch.language !== undefined) push('language', patch.language);
    if (patch.durationMs !== undefined) push('duration_ms', intOrNull(patch.durationMs, 'durationMs'));
    if (patch.segmentCount !== undefined) push('segment_count', intOrNull(patch.segmentCount, 'segmentCount') ?? 0);
    if (patch.chunkCount !== undefined) push('chunk_count', Math.max(1, intOrNull(patch.chunkCount, 'chunkCount') ?? 1));
    if (patch.needsReview !== undefined) push('needs_review', boolToInt(patch.needsReview) ?? 0);
    if (patch.speakerMappingJson !== undefined) push('speaker_mapping_json', jsonCheck(patch.speakerMappingJson, 'speakerMappingJson', 65536));
    if (patch.asrMetaJson !== undefined) push('asr_meta_json', jsonCheck(patch.asrMetaJson, 'asrMetaJson', 65536));
    if (patch.fullText !== undefined) push('full_text', patch.fullText ?? null);
    if (patch.fullTextRaw !== undefined) push('full_text_raw', patch.fullTextRaw ?? null);
    if (patch.isCurrent !== undefined) {
      if (patch.isCurrent) {
        const cur = this.oneRow('SELECT call_id FROM transcripts WHERE transcript_id = ?', [transcriptId]);
        if (!cur) return null;
        this.run('UPDATE transcripts SET is_current = 0 WHERE call_id = ? AND transcript_id <> ?', [cur.call_id, transcriptId]);
      }
      push('is_current', boolToInt(patch.isCurrent) ?? 0);
    }
    if (sets.length === 0) return this.getTranscriptById(transcriptId);
    sets.push('updated_at = ?', 'version = version + 1');
    params.push(normIso(patch.updatedAt, 'updatedAt') ?? nowIso());
    params.push(transcriptId);
    const changes = this.runDynamic(`UPDATE transcripts SET ${sets.join(', ')} WHERE transcript_id = ?`, params);
    return changes > 0 ? this.getTranscriptById(transcriptId) : null;
  }

  private async getTranscriptById(transcriptId: string): Promise<Transcript | null> {
    const r = this.oneRow(`${TRANSCRIPT_SELECT} WHERE t.transcript_id = ?`, [transcriptId]);
    return r ? this.mapTranscript(r) : null;
  }

  async getCurrentTranscript(callId: string): Promise<Transcript | null> {
    const r = this.oneRow(`${TRANSCRIPT_SELECT} WHERE t.call_id = ? AND t.is_current = 1`, [callId]);
    return r ? this.mapTranscript(r) : null;
  }

  async markOtherTranscriptsNotCurrent(callId: string, keepTranscriptId: string): Promise<void> {
    this.run('UPDATE transcripts SET is_current = 0, updated_at = ? WHERE call_id = ? AND transcript_id <> ? AND is_current = 1', [nowIso(), callId, keepTranscriptId]);
  }

  async replaceSegments(transcriptId: string, callId: string, segments: TranscriptSegment[]): Promise<void> {
    const st = this.oneRow('SELECT call_id FROM transcripts WHERE transcript_id = ?', [transcriptId]);
    if (!st) throw new AppError('VALIDATION_FAILED', `转写不存在: ${transcriptId}`);
    void callId;
    const at = nowIso();
    this.tx(() => {
      this.run('DELETE FROM transcript_segments WHERE transcript_id = ?', [transcriptId]);
      const insert = this.db.prepare(
        `INSERT INTO transcript_segments (segment_id, transcript_id, seq, start_ms, end_ms, chunk_index, channel_id,
           speaker_label, speaker_role, text_raw, text_normalized, confidence, emotion_value, speech_rate, silence_before_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of segments) {
        if (typeof s.rawText !== 'string' || s.rawText.length < 1 || s.rawText.length > 4096) {
          throw new AppError('VALIDATION_FAILED', `segment ${s.idx} rawText 长度需 1..4096`);
        }
        if (typeof s.normalizedText !== 'string' || s.normalizedText.length < 1 || s.normalizedText.length > 4096) {
          throw new AppError('VALIDATION_FAILED', `segment ${s.idx} normalizedText 长度需 1..4096`);
        }
        insert.run(
          s.segmentId, transcriptId, intOrNull(s.idx, 'idx') ?? 0, intOrNull(s.beginMs, 'beginMs') ?? 0,
          intOrNull(s.endMs, 'endMs') ?? 0, intOrNull(s.chunkIndex, 'chunkIndex') ?? 0, intOrNull(s.channel, 'channel'),
          s.speakerLabel ?? null, ensureOneOf(s.role, SPEAKER_ROLES, 'role'), s.rawText, s.normalizedText,
          numOrNull(s.confidence, 'confidence'), numOrNull(s.emotionValue, 'emotionValue'),
          intOrNull(s.speechRate, 'speechRate'), intOrNull(s.silenceBeforeMs, 'silenceBeforeMs'), at,
        );
      }
      this.run('UPDATE transcripts SET segment_count = ?, updated_at = ?, version = version + 1 WHERE transcript_id = ?', [segments.length, at, transcriptId]);
    });
  }

  async listSegments(transcriptId: string): Promise<TranscriptSegment[]> {
    const rows = this.allRows(
      `SELECT s.*, t.call_id AS t_call_id FROM transcript_segments s JOIN transcripts t ON t.transcript_id = s.transcript_id
       WHERE s.transcript_id = ? ORDER BY s.seq ASC`,
      [transcriptId],
    );
    return rows.map((r) => ({
      segmentId: String(r.segment_id),
      transcriptId: String(r.transcript_id),
      callId: String(r.t_call_id),
      idx: Number(r.seq),
      beginMs: Number(r.start_ms),
      endMs: Number(r.end_ms),
      channel: r.channel_id === null || r.channel_id === undefined ? null : Number(r.channel_id),
      speakerLabel: r.speaker_label ?? null,
      chunkIndex: r.chunk_index === null || r.chunk_index === undefined ? null : Number(r.chunk_index),
      role: r.speaker_role as SpeakerRole,
      rawText: String(r.text_raw),
      normalizedText: String(r.text_normalized),
      confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
      emotionValue: r.emotion_value === null || r.emotion_value === undefined ? null : Number(r.emotion_value),
      speechRate: r.speech_rate === null || r.speech_rate === undefined ? null : Number(r.speech_rate),
      silenceBeforeMs: r.silence_before_ms === null || r.silence_before_ms === undefined ? null : Number(r.silence_before_ms),
    }));
  }

  async countSegments(transcriptId: string): Promise<number> {
    const r = this.oneRow('SELECT COUNT(*) AS n FROM transcript_segments WHERE transcript_id = ?', [transcriptId]);
    return Number(r?.n ?? 0);
  }

  // =========================================================================
  // analysis_results
  // =========================================================================
  private mapAnalysis(r: Row): AnalysisResult {
    const status = (r.c_analysis_status as StageStatus | undefined) ?? 'pending';
    const errCode = (r.c_analysis_last_error_code as string | null | undefined) ?? null;
    const summary = r.summary ?? null;
    const bullets = jsonParse<string[]>(r.summary_bullets_json) ?? [];
    const intentLabel = r.intent_label ?? null;
    const intentScore = r.intent_score === null || r.intent_score === undefined ? null : Number(r.intent_score);
    return {
      analysisId: String(r.analysis_id),
      callId: String(r.call_id),
      transcriptId: r.transcript_id ?? null,
      status,
      isCurrent: intToBool(r.is_current),
      provider: r.provider ?? null,
      revision: Number(r.revision ?? 1),
      termsVersion: r.terms_version ?? null,
      summary,
      summaryBulletsJson: r.summary_bullets_json ?? '[]',
      intentLabel,
      intentScore,
      termsAppliedJson: r.terms_applied_json ?? '[]',
      qualityFlagsJson: r.quality_flags_json ?? '[]',
      rawRequestHash: r.raw_request_hash ?? null,
      rawResponsePath: r.raw_response_path ?? null,
      model: r.model ?? null,
      promptVersion: r.prompt_version ?? null,
      schemaVersion: r.schema_version ?? null,
      paramsJson: r.params_json ?? null,
      usageJson: r.usage_json ?? null,
      summaryJson: summary !== null || bullets.length > 0 ? JSON.stringify({ short: summary ?? '', bullets }) : null,
      intentJson: intentLabel !== null ? JSON.stringify({ label: intentLabel, ...(intentScore !== null ? { score: intentScore } : {}) }) : null,
      keywordsJson: r.keywords_json ?? '[]',
      resultJson: r.result_json ?? null,
      speakerMappingJson: r.speaker_mapping_json ?? null,
      needsReview: intToBool(r.needs_review),
      lastErrorJson: errCode ? JSON.stringify({ code: errCode, at: String(r.updated_at) }) : null,
      generatedAt: String(r.created_at),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  private analysisSummaryColumns(a: Partial<AnalysisResult>): { summary: string | null; bulletsJson: string; intentLabel: string | null; intentScore: number | null } {
    const summaryJson = jsonParse<{ short?: string; bullets?: string[] }>(a.summaryJson ?? null);
    const intentJson = jsonParse<{ label?: string; score?: number }>(a.intentJson ?? null);
    const summary = a.summary ?? summaryJson?.short ?? null;
    const bulletsJson = a.summaryBulletsJson ?? (summaryJson?.bullets ? JSON.stringify(summaryJson.bullets) : '[]');
    jsonCheck(bulletsJson, 'summaryBulletsJson', 65536);
    const intentLabel = a.intentLabel ?? intentJson?.label ?? null;
    const intentScore = a.intentScore ?? intentJson?.score ?? null;
    return { summary, bulletsJson, intentLabel, intentScore };
  }

  async createAnalysis(a: AnalysisResult): Promise<void> {
    const createdAt = normIso(a.createdAt, 'createdAt') ?? nowIso();
    const updatedAt = normIso(a.updatedAt, 'updatedAt') ?? createdAt;
    const sum = this.analysisSummaryColumns(a);
    this.tx(() => {
      const revRow = this.oneRow('SELECT COALESCE(MAX(revision), 0) + 1 AS rev FROM analysis_results WHERE call_id = ?', [a.callId]);
      const revision = a.revision ?? Number(revRow?.rev ?? 1);
      if (a.isCurrent) this.run('UPDATE analysis_results SET is_current = 0 WHERE call_id = ? AND is_current = 1', [a.callId]);
      this.insertRow('analysis_results',
        ['analysis_id', 'call_id', 'transcript_id', 'revision', 'is_current', 'provider', 'model', 'prompt_version',
          'params_json', 'schema_version', 'terms_version', 'summary', 'summary_bullets_json', 'keywords_json',
          'intent_label', 'intent_score', 'terms_applied_json', 'speaker_mapping_json', 'needs_review', 'result_json',
          'quality_flags_json', 'usage_json', 'raw_request_hash', 'raw_response_path', 'created_at', 'updated_at', 'version'],
        [
          a.analysisId, a.callId, a.transcriptId ?? null, revision, boolToInt(a.isCurrent) ?? 1,
          a.provider || 'deepseek', a.model || 'deepseek-chat', a.promptVersion || 'analysis-v1',
          jsonCheck(a.paramsJson, 'paramsJson', 65536) ?? '{}', a.schemaVersion || 'analysis-output-v1',
          a.termsVersion ?? null, sum.summary, sum.bulletsJson,
          jsonCheck(a.keywordsJson, 'keywordsJson', 65536) ?? '[]', sum.intentLabel,
          numOrNull(sum.intentScore, 'intentScore'), jsonCheck(a.termsAppliedJson, 'termsAppliedJson', 65536) ?? '[]',
          jsonCheck(a.speakerMappingJson, 'speakerMappingJson', 65536), boolToInt(a.needsReview) ?? 0,
          jsonCheck(a.resultJson, 'resultJson', 262144), jsonCheck(a.qualityFlagsJson, 'qualityFlagsJson', 65536) ?? '[]',
          jsonCheck(a.usageJson, 'usageJson', 65536), a.rawRequestHash ?? null, a.rawResponsePath ?? null, createdAt, updatedAt, 1,
        ]);
    });
  }

  async updateAnalysis(analysisId: string, patch: Partial<AnalysisResult>): Promise<AnalysisResult | null> {
    const sets: string[] = [];
    const params: Params = [];
    const push = (col: string, value: SQLInputValue): void => { sets.push(`${col} = ?`); params.push(value); };
    if (patch.transcriptId !== undefined) push('transcript_id', patch.transcriptId ?? null);
    if (patch.provider !== undefined) push('provider', patch.provider ?? 'deepseek');
    if (patch.model !== undefined) push('model', patch.model ?? 'deepseek-chat');
    if (patch.promptVersion !== undefined) push('prompt_version', patch.promptVersion ?? 'analysis-v1');
    if (patch.paramsJson !== undefined) push('params_json', jsonCheck(patch.paramsJson, 'paramsJson', 65536) ?? '{}');
    if (patch.schemaVersion !== undefined) push('schema_version', patch.schemaVersion ?? 'analysis-output-v1');
    if (patch.termsVersion !== undefined) push('terms_version', patch.termsVersion ?? null);
    if (patch.summary !== undefined) push('summary', patch.summary ?? null);
    if (patch.summaryBulletsJson !== undefined) push('summary_bullets_json', jsonCheck(patch.summaryBulletsJson, 'summaryBulletsJson', 65536) ?? '[]');
    if (patch.keywordsJson !== undefined) push('keywords_json', jsonCheck(patch.keywordsJson, 'keywordsJson', 65536) ?? '[]');
    if (patch.intentLabel !== undefined) push('intent_label', patch.intentLabel ?? null);
    if (patch.intentScore !== undefined) push('intent_score', numOrNull(patch.intentScore, 'intentScore'));
    if (patch.termsAppliedJson !== undefined) push('terms_applied_json', jsonCheck(patch.termsAppliedJson, 'termsAppliedJson', 65536) ?? '[]');
    if (patch.speakerMappingJson !== undefined) push('speaker_mapping_json', jsonCheck(patch.speakerMappingJson, 'speakerMappingJson', 65536));
    if (patch.needsReview !== undefined) push('needs_review', boolToInt(patch.needsReview) ?? 0);
    if (patch.resultJson !== undefined) push('result_json', jsonCheck(patch.resultJson, 'resultJson', 262144));
    if (patch.qualityFlagsJson !== undefined) push('quality_flags_json', jsonCheck(patch.qualityFlagsJson, 'qualityFlagsJson', 65536) ?? '[]');
    if (patch.usageJson !== undefined) push('usage_json', jsonCheck(patch.usageJson, 'usageJson', 65536));
    if (patch.rawRequestHash !== undefined) push('raw_request_hash', patch.rawRequestHash ?? null);
    if (patch.rawResponsePath !== undefined) push('raw_response_path', patch.rawResponsePath ?? null);
    if (patch.isCurrent !== undefined) {
      if (patch.isCurrent) {
        const cur = this.oneRow('SELECT call_id FROM analysis_results WHERE analysis_id = ?', [analysisId]);
        if (!cur) return null;
        this.run('UPDATE analysis_results SET is_current = 0 WHERE call_id = ? AND analysis_id <> ?', [cur.call_id, analysisId]);
      }
      push('is_current', boolToInt(patch.isCurrent) ?? 0);
    }
    if (sets.length === 0) return this.getAnalysisById(analysisId);
    sets.push('updated_at = ?', 'version = version + 1');
    params.push(normIso(patch.updatedAt, 'updatedAt') ?? nowIso());
    params.push(analysisId);
    const changes = this.runDynamic(`UPDATE analysis_results SET ${sets.join(', ')} WHERE analysis_id = ?`, params);
    return changes > 0 ? this.getAnalysisById(analysisId) : null;
  }

  private async getAnalysisById(analysisId: string): Promise<AnalysisResult | null> {
    const r = this.oneRow(`${ANALYSIS_SELECT} WHERE a.analysis_id = ?`, [analysisId]);
    return r ? this.mapAnalysis(r) : null;
  }

  async getCurrentAnalysis(callId: string): Promise<AnalysisResult | null> {
    const r = this.oneRow(`${ANALYSIS_SELECT} WHERE a.call_id = ? AND a.is_current = 1`, [callId]);
    return r ? this.mapAnalysis(r) : null;
  }

  async markOtherAnalysesNotCurrent(callId: string, keepAnalysisId: string): Promise<void> {
    this.run('UPDATE analysis_results SET is_current = 0, updated_at = ? WHERE call_id = ? AND analysis_id <> ? AND is_current = 1', [nowIso(), callId, keepAnalysisId]);
  }

  // =========================================================================
  // transcript_chunks
  // =========================================================================
  private mapChunk(r: Row): TranscriptChunk {
    const errCode = (r.last_error_code as string | null) ?? null;
    const errMsg = (r.last_error_message as string | null) ?? null;
    return {
      chunkId: String(r.chunk_id),
      callId: String(r.call_id),
      revision: Number(r.revision),
      chunkIndex: Number(r.chunk_index),
      beginMs: Number(r.begin_ms),
      endMs: Number(r.end_ms),
      forcedCut: intToBool(r.forced_cut),
      status: chunkDomainStatus(String(r.status)),
      resultPath: r.result_path ?? null,
      resultSha256: r.result_sha256 ?? null,
      providerTraceId: r.provider_trace_id ?? null,
      segmentCount: r.segment_count === null || r.segment_count === undefined ? null : Number(r.segment_count),
      attempts: Number(r.attempts ?? 0),
      lastErrorJson: errCode ? JSON.stringify({ code: errCode, ...(errMsg ? { message: errMsg } : {}), at: String(r.updated_at) }) : null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  async upsertChunk(c: TranscriptChunk): Promise<void> {
    const status = chunkDbStatus(ensureOneOf(c.status, STAGE_STATUSES, 'status'));
    const err = jsonParse<{ code?: string; message?: string }>(c.lastErrorJson ?? null);
    const createdAt = normIso(c.createdAt, 'createdAt') ?? nowIso();
    const updatedAt = normIso(c.updatedAt, 'updatedAt') ?? createdAt;
    if ((intOrNull(c.endMs, 'endMs') ?? 0) <= (intOrNull(c.beginMs, 'beginMs') ?? 0)) {
      throw new AppError('VALIDATION_FAILED', 'chunk endMs 必须大于 beginMs');
    }
    this.run(
      `INSERT INTO transcript_chunks (chunk_id, call_id, revision, chunk_index, begin_ms, end_ms, forced_cut, status,
         result_path, result_sha256, provider_trace_id, segment_count, attempts, last_error_code, last_error_message,
         created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(call_id, revision, chunk_index) DO UPDATE SET
         begin_ms = excluded.begin_ms, end_ms = excluded.end_ms, forced_cut = excluded.forced_cut,
         status = excluded.status, result_path = excluded.result_path, result_sha256 = excluded.result_sha256,
         provider_trace_id = excluded.provider_trace_id, segment_count = excluded.segment_count,
         attempts = excluded.attempts, last_error_code = excluded.last_error_code,
         last_error_message = excluded.last_error_message, updated_at = excluded.updated_at,
         version = transcript_chunks.version + 1`,
      [
        c.chunkId, c.callId, intOrNull(c.revision, 'revision') ?? 1, intOrNull(c.chunkIndex, 'chunkIndex') ?? 0,
        intOrNull(c.beginMs, 'beginMs') ?? 0, intOrNull(c.endMs, 'endMs') ?? 0, boolToInt(c.forcedCut) ?? 0, status,
        c.resultPath ?? null, c.resultSha256 ?? null, c.providerTraceId ?? null,
        intOrNull(c.segmentCount, 'segmentCount') ?? 0, intOrNull(c.attempts, 'attempts') ?? 0,
        err?.code ?? null, err?.message ?? null, createdAt, updatedAt,
      ],
    );
  }

  async listChunks(callId: string, revision: number): Promise<TranscriptChunk[]> {
    const rows = this.allRows('SELECT * FROM transcript_chunks WHERE call_id = ? AND revision = ? ORDER BY chunk_index ASC', [callId, revision]);
    return rows.map((r) => this.mapChunk(r));
  }

  // =========================================================================
  // call_events
  // =========================================================================
  private mapEvent(r: Row): CallEvent {
    return {
      eventId: String(r.event_id),
      type: r.type as EventType,
      occurredAt: String(r.occurred_at),
      accountId: r.account_id ?? null,
      callId: r.call_id ?? null,
      jobId: r.job_id ?? null,
      dataJson: r.data_json ?? '{}',
      createdAt: String(r.created_at),
    };
  }

  async insertEvent(e: CallEvent): Promise<void> {
    const type = ensureOneOf(e.type, EVENT_TYPES, 'type');
    const occurredAt = normIsoReq(e.occurredAt, 'occurredAt');
    const dataJson = e.dataJson === null || e.dataJson === undefined ? '{}' : jsonCheck(e.dataJson, 'dataJson', 16384);
    this.run(
      `INSERT INTO call_events (event_id, type, occurred_at, account_id, call_id, job_id, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.eventId, type, occurredAt, e.accountId ?? null, e.callId ?? null, e.jobId ?? null, dataJson,
        normIso(e.createdAt, 'createdAt') ?? occurredAt],
    );
  }

  private eventTypeWhere(types?: string[]): { sql: string; params: Params } {
    if (!types || types.length === 0) return { sql: '', params: [] };
    const exact: string[] = [];
    const prefixes: string[] = [];
    for (const t of types) {
      const raw = String(t);
      if (raw.endsWith('*')) {
        const prefix = raw.slice(0, -1);
        if (prefix.length === 0) throw new AppError('VALIDATION_FAILED', '非法事件类型通配符');
        prefixes.push(prefix);
      } else {
        ensureOneOf(raw, EVENT_TYPES, 'types');
        exact.push(raw);
      }
    }
    const parts: string[] = [];
    const params: Params = [];
    if (exact.length > 0) { parts.push(`type IN (${exact.map(() => '?').join(',')})`); params.push(...exact); }
    for (const p of prefixes) { parts.push(`type LIKE ? ESCAPE '\\'`); params.push(`${escapeLike(p)}%`); }
    return { sql: `(${parts.join(' OR ')})`, params };
  }

  private eventOrderBy(sort?: string): string {
    const raw = sort && sort.length > 0 ? sort : '-occurredAt';
    const desc = raw.startsWith('-');
    const key = desc ? raw.slice(1) : raw;
    if (key !== 'occurredAt') throw new AppError('VALIDATION_FAILED', `非法排序字段: ${key}`, { details: { fields: [{ field: 'sort', reason: 'allowed: occurredAt' }] } });
    const dir = desc ? 'DESC' : 'ASC';
    return `occurred_at ${dir}, seq ${dir}`;
  }

  async listEvents(f: EventFilter): Promise<ListResult<CallEvent>> {
    const { size, offset } = pageOf(f);
    const where: string[] = [];
    const params: Params = [];
    const types = this.eventTypeWhere(f.types);
    if (types.sql) { where.push(types.sql); params.push(...types.params); }
    if (f.callId) { where.push('call_id = ?'); params.push(f.callId); }
    if (f.accountId) { where.push('account_id = ?'); params.push(f.accountId); }
    if (f.since) { where.push('occurred_at >= ?'); params.push(normIsoReq(f.since, 'since')); }
    if (f.until) { where.push('occurred_at <= ?'); params.push(normIsoReq(f.until, 'until')); }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = this.eventOrderBy(f.sort);
    const total = this.oneRow(`SELECT COUNT(*) AS n FROM call_events ${whereSql}`, params);
    const rows = this.allDynamic(`SELECT * FROM call_events ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`, [...params, size, offset]);
    return { items: rows.map((r) => this.mapEvent(r)), total: Number(total?.n ?? 0) };
  }

  async listCallEvents(callId: string, types?: string[]): Promise<CallEvent[]> {
    const where: string[] = ['call_id = ?'];
    const params: Params = [callId];
    const t = this.eventTypeWhere(types);
    if (t.sql) { where.push(t.sql); params.push(...t.params); }
    const rows = this.allRows(`SELECT * FROM call_events WHERE ${where.join(' AND ')} ORDER BY seq ASC`, params);
    return rows.map((r) => this.mapEvent(r));
  }

  // =========================================================================
  // jobs
  // =========================================================================
  private mapJob(r: Row): Job {
    const errCode = (r.last_error_code as string | null) ?? null;
    const errMsg = (r.last_error_message as string | null) ?? null;
    const status = r.status as JobStatus;
    const nextRunAt = (r.next_run_at as string | null) ?? null;
    const running = status === 'running';
    return {
      jobId: String(r.job_id),
      type: r.type as JobType,
      status,
      priority: Number(r.priority ?? 100),
      accountId: r.account_id ?? null,
      callId: r.call_id ?? null,
      payloadJson: r.payload_json ?? '{}',
      resultJson: r.result_json ?? null,
      progressJson: r.progress_json ?? null,
      attempts: Number(r.attempts ?? 0),
      maxAttempts: Number(r.max_attempts ?? 5),
      // 租约复用 next_run_at（Lead 约定）：queued 时即 scheduledAt；running 时即 leaseUntil
      scheduledAt: running ? String(r.started_at ?? nextRunAt ?? r.created_at) : (nextRunAt ?? String(r.created_at)),
      startedAt: r.started_at ?? null,
      finishedAt: r.finished_at ?? null,
      leaseUntil: running ? nextRunAt : null,
      stage: (r.stage as Job['stage']) ?? null,
      trigger: (r.trigger as Job['trigger']) ?? 'pipeline',
      idempotencyKey: r.idempotency_key ?? null,
      nextRunAt,
      durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
      lastErrorCode: errCode,
      lastErrorMessage: errMsg,
      version: Number(r.version ?? 1),
      lastErrorJson: errCode ? JSON.stringify({ code: errCode, ...(errMsg ? { message: errMsg } : {}), at: String(r.updated_at) }) : null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  private jobErrorColumns(json: string | null | undefined): { code: string | null; message: string | null } {
    if (!json) return { code: null, message: null };
    const parsed = jsonParse<Record<string, unknown>>(json);
    if (!parsed) throw new AppError('VALIDATION_FAILED', 'lastErrorJson 不是合法 JSON');
    return {
      code: typeof parsed.code === 'string' ? parsed.code : null,
      message: typeof parsed.message === 'string' ? parsed.message : null,
    };
  }

  async insertJob(j: Job): Promise<void> {
    const type = ensureOneOf(j.type, JOB_TYPES, 'type');
    const status = ensureOneOf(j.status, JOB_STATUSES, 'status');
    const stage = j.stage === undefined || j.stage === null ? null : ensureOneOf(j.stage, JOB_STAGES, 'stage');
    const trigger = j.trigger ? ensureOneOf(j.trigger, JOB_TRIGGERS, 'trigger') : 'pipeline';
    const scheduledAt = normIsoReq(j.scheduledAt, 'scheduledAt');
    const createdAt = normIso(j.createdAt, 'createdAt') ?? nowIso();
    const updatedAt = normIso(j.updatedAt, 'updatedAt') ?? createdAt;
    const err = j.lastErrorJson !== undefined && j.lastErrorJson !== null
      ? this.jobErrorColumns(j.lastErrorJson)
      : { code: j.lastErrorCode ?? null, message: j.lastErrorMessage ?? null };
    this.insertRow('jobs',
      ['job_id', 'type', 'status', 'stage', 'priority', 'account_id', 'call_id', 'trigger', 'payload_json',
        'idempotency_key', 'attempts', 'max_attempts', 'next_run_at', 'started_at', 'finished_at', 'duration_ms',
        'last_error_code', 'last_error_message', 'progress_json', 'result_json', 'created_at', 'updated_at', 'version'],
      [
        j.jobId, type, status, stage, intOrNull(j.priority, 'priority') ?? 100, j.accountId ?? null, j.callId ?? null,
        trigger, jsonCheck(j.payloadJson, 'payloadJson', 65536) ?? '{}', j.idempotencyKey ?? null,
        intOrNull(j.attempts, 'attempts') ?? 0, Math.max(1, intOrNull(j.maxAttempts, 'maxAttempts') ?? 5),
        scheduledAt, normIso(j.startedAt, 'startedAt'), normIso(j.finishedAt, 'finishedAt'),
        intOrNull(j.durationMs, 'durationMs'), err.code, err.message,
        jsonCheck(j.progressJson, 'progressJson', 65536), jsonCheck(j.resultJson, 'resultJson', 65536), createdAt, updatedAt, 1,
      ]);
  }

  async getJob(jobId: string): Promise<Job | null> {
    const r = this.oneRow('SELECT * FROM jobs WHERE job_id = ?', [jobId]);
    return r ? this.mapJob(r) : null;
  }

  async updateJob(jobId: string, patch: Partial<Job>): Promise<Job | null> {
    const sets: string[] = [];
    const params: Params = [];
    const push = (col: string, value: SQLInputValue): void => { sets.push(`${col} = ?`); params.push(value); };
    if (patch.status !== undefined) push('status', ensureOneOf(patch.status, JOB_STATUSES, 'status'));
    if (patch.priority !== undefined) push('priority', intOrNull(patch.priority, 'priority') ?? 100);
    if (patch.accountId !== undefined) push('account_id', patch.accountId ?? null);
    if (patch.callId !== undefined) push('call_id', patch.callId ?? null);
    if (patch.payloadJson !== undefined) push('payload_json', jsonCheck(patch.payloadJson, 'payloadJson', 65536) ?? '{}');
    if (patch.resultJson !== undefined) push('result_json', jsonCheck(patch.resultJson, 'resultJson', 65536));
    if (patch.progressJson !== undefined) push('progress_json', jsonCheck(patch.progressJson, 'progressJson', 65536));
    if (patch.attempts !== undefined) push('attempts', Math.max(0, intOrNull(patch.attempts, 'attempts') ?? 0));
    if (patch.maxAttempts !== undefined) push('max_attempts', Math.max(1, intOrNull(patch.maxAttempts, 'maxAttempts') ?? 5));
    if (patch.scheduledAt !== undefined) push('next_run_at', normIsoReq(patch.scheduledAt, 'scheduledAt'));
    else if (patch.nextRunAt !== undefined) push('next_run_at', normIso(patch.nextRunAt, 'nextRunAt'));
    if (patch.startedAt !== undefined) push('started_at', normIso(patch.startedAt, 'startedAt'));
    if (patch.finishedAt !== undefined) push('finished_at', normIso(patch.finishedAt, 'finishedAt'));
    if (patch.durationMs !== undefined) push('duration_ms', intOrNull(patch.durationMs, 'durationMs'));
    if (patch.stage !== undefined) push('stage', patch.stage === null ? null : ensureOneOf(patch.stage, JOB_STAGES, 'stage'));
    if (patch.trigger !== undefined) push('trigger', ensureOneOf(patch.trigger, JOB_TRIGGERS, 'trigger'));
    if (patch.idempotencyKey !== undefined) push('idempotency_key', patch.idempotencyKey ?? null);
    if (patch.lastErrorJson !== undefined) {
      const err = this.jobErrorColumns(patch.lastErrorJson ?? null);
      push('last_error_code', err.code);
      push('last_error_message', err.message);
    } else if (patch.lastErrorCode !== undefined || patch.lastErrorMessage !== undefined) {
      push('last_error_code', patch.lastErrorCode ?? null);
      push('last_error_message', patch.lastErrorMessage ?? null);
    }
    if (sets.length === 0) return this.getJob(jobId);
    sets.push('updated_at = ?', 'version = version + 1');
    params.push(normIso(patch.updatedAt, 'updatedAt') ?? nowIso());
    params.push(jobId);
    const changes = this.runDynamic(`UPDATE jobs SET ${sets.join(', ')} WHERE job_id = ?`, params);
    return changes > 0 ? this.getJob(jobId) : null;
  }

  async claimJob(types: JobType[], nowIsoStr: string, leaseUntilIso: string): Promise<Job | null> {
    if (!Array.isArray(types) || types.length === 0) return null;
    for (const t of types) ensureOneOf(t, JOB_TYPES, 'types');
    const now = normIsoReq(nowIsoStr, 'nowIso');
    const leaseUntil = normIsoReq(leaseUntilIso, 'leaseUntilIso');
    const placeholders = types.map(() => '?').join(',');
    for (let attempt = 0; attempt < 10; attempt++) {
      const claimed = this.tx((): string | null => {
        const candidate = this.oneRow(
          `SELECT job_id FROM jobs WHERE status = 'queued' AND type IN (${placeholders}) AND next_run_at <= ?
           ORDER BY priority ASC, next_run_at ASC, created_at ASC LIMIT 1`,
          [...types, now],
        );
        if (!candidate) return null;
        const jobId = String(candidate.job_id);
        const changes = this.run(
          `UPDATE jobs SET status = 'running', started_at = ?, next_run_at = ?, attempts = attempts + 1,
             updated_at = ?, version = version + 1
           WHERE job_id = ? AND status = 'queued'`,
          [now, leaseUntil, now, jobId],
        );
        return changes > 0 ? jobId : null;
      });
      if (claimed) return this.getJob(claimed);
    }
    return null;
  }

  async recoverExpiredJobs(nowIsoStr: string): Promise<number> {
    const now = normIsoReq(nowIsoStr, 'nowIso');
    // 租约 = running 状态下的 next_run_at；过期回 queued（attempts 不变，立即可再领取）
    return this.run(
      `UPDATE jobs SET status = 'queued', next_run_at = ?, updated_at = ?, version = version + 1
       WHERE status = 'running' AND next_run_at IS NOT NULL AND next_run_at <= ?`,
      [now, now, now],
    );
  }

  private jobOrderBy(sort?: string): string {
    const raw = sort && sort.length > 0 ? sort : '-createdAt';
    const desc = raw.startsWith('-');
    const key = desc ? raw.slice(1) : raw;
    const map: Record<string, string> = {
      createdAt: 'created_at', scheduledAt: 'next_run_at', startedAt: 'started_at',
      finishedAt: 'finished_at', priority: 'priority',
    };
    const col = map[key];
    if (!col) throw new AppError('VALIDATION_FAILED', `非法排序字段: ${key}`, { details: { fields: [{ field: 'sort', reason: `allowed: ${Object.keys(map).join(',')}` }] } });
    const dir = desc ? 'DESC' : 'ASC';
    return `${col} ${dir}, job_id ${dir}`;
  }

  async listJobs(f: JobFilter): Promise<ListResult<Job>> {
    const { size, offset } = pageOf(f);
    const where: string[] = [];
    const params: Params = [];
    if (f.types && f.types.length > 0) {
      for (const t of f.types) ensureOneOf(t, JOB_TYPES, 'types');
      where.push(`type IN (${f.types.map(() => '?').join(',')})`);
      params.push(...f.types);
    }
    if (f.statuses && f.statuses.length > 0) {
      for (const s of f.statuses) ensureOneOf(s, JOB_STATUSES, 'statuses');
      where.push(`status IN (${f.statuses.map(() => '?').join(',')})`);
      params.push(...f.statuses);
    }
    if (f.accountId) { where.push('account_id = ?'); params.push(f.accountId); }
    if (f.callId) { where.push('call_id = ?'); params.push(f.callId); }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = this.jobOrderBy(f.sort);
    const total = this.oneRow(`SELECT COUNT(*) AS n FROM jobs ${whereSql}`, params);
    const rows = this.allDynamic(`SELECT * FROM jobs ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`, [...params, size, offset]);
    return { items: rows.map((r) => this.mapJob(r)), total: Number(total?.n ?? 0) };
  }

  async jobCounts(): Promise<{ queued: number; running: number; failed24h: number }> {
    const q = this.oneRow("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'");
    const r = this.oneRow("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'");
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const failed = this.oneRow("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND finished_at >= ?", [cutoff]);
    return { queued: Number(q?.n ?? 0), running: Number(r?.n ?? 0), failed24h: Number(failed?.n ?? 0) };
  }

  async listJobsByStatus(type: JobType, status: JobStatus, limit: number): Promise<Job[]> {
    ensureOneOf(type, JOB_TYPES, 'type');
    ensureOneOf(status, JOB_STATUSES, 'status');
    const n = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const rows = this.allRows('SELECT * FROM jobs WHERE type = ? AND status = ? ORDER BY priority ASC, created_at ASC LIMIT ?', [type, status, n]);
    return rows.map((r) => this.mapJob(r));
  }

  // =========================================================================
  // term_rules
  // =========================================================================
  private mapTerm(r: Row): TermRule {
    const from = jsonParse<string[]>(r.from_aliases_json);
    return {
      termId: String(r.term_id),
      from: Array.isArray(from) ? from : [],
      to: String(r.to_term),
      category: (r.category as TermCategory | null) ?? null,
      priority: Number(r.priority ?? 100),
      enabled: intToBool(r.enabled),
      caseSensitive: intToBool(r.case_sensitive),
      note: r.note ?? null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  private aliasesJsonOf(from: unknown): string {
    if (!Array.isArray(from) || from.length === 0) throw new AppError('VALIDATION_FAILED', 'from 需为非空数组');
    if (from.some((a) => typeof a !== 'string' || a.length < 1 || a.length > 32)) {
      throw new AppError('VALIDATION_FAILED', 'from 每项长度需 1..32');
    }
    return JSON.stringify([...new Set(from as string[])]);
  }

  private termColumns(t: Partial<TermRule>): { aliasesJson: string; category: string | null } {
    const aliasesJson = this.aliasesJsonOf(t.from);
    if (t.to === undefined || typeof t.to !== 'string' || t.to.length < 1 || t.to.length > 32) {
      throw new AppError('VALIDATION_FAILED', 'to 长度需 1..32');
    }
    if ((t.from as string[]).some((a) => a === t.to)) throw new AppError('VALIDATION_FAILED', 'from 变体不得等于 to');
    const category = t.category === undefined || t.category === null ? null : ensureOneOf(t.category, TERM_CATEGORIES, 'category');
    return { aliasesJson, category };
  }

  async getTermRule(termId: string): Promise<TermRule | null> {
    const r = this.oneRow('SELECT * FROM term_rules WHERE term_id = ? AND deleted_at IS NULL', [termId]);
    return r ? this.mapTerm(r) : null;
  }

  async listTermRules(opts: { q?: string; enabled?: boolean } = {}): Promise<TermRule[]> {
    const where: string[] = ['deleted_at IS NULL'];
    const params: Params = [];
    if (opts.enabled !== undefined) { where.push('enabled = ?'); params.push(opts.enabled ? 1 : 0); }
    if (opts.q && opts.q.trim().length > 0) {
      const like = `%${escapeLike(opts.q.trim())}%`;
      where.push("(to_term LIKE ? ESCAPE '\\' OR from_aliases_json LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    const rows = this.allRows(`SELECT * FROM term_rules WHERE ${where.join(' AND ')} ORDER BY priority DESC, to_term ASC`, params);
    return rows.map((r) => this.mapTerm(r));
  }

  async createTermRule(t: TermRule): Promise<TermRule> {
    const { aliasesJson, category } = this.termColumns(t);
    const createdAt = normIso(t.createdAt, 'createdAt') ?? nowIso();
    const updatedAt = normIso(t.updatedAt, 'updatedAt') ?? createdAt;
    this.insertRow('term_rules',
      ['term_id', 'to_term', 'from_aliases_json', 'category', 'priority', 'enabled', 'case_sensitive', 'note',
        'created_at', 'updated_at', 'version'],
      [t.termId, t.to, aliasesJson, category, intOrNull(t.priority, 'priority') ?? 100, boolToInt(t.enabled) ?? 1,
        boolToInt(t.caseSensitive) ?? 0, t.note ?? null, createdAt, updatedAt, 1]);
    const created = await this.getTermRule(t.termId);
    if (!created) throw new AppError('INTERNAL_ERROR', '词条创建后读取失败');
    return created;
  }

  async updateTermRule(termId: string, patch: Partial<TermRule>): Promise<TermRule | null> {
    const existing = await this.getTermRule(termId);
    if (!existing) return null;
    const sets: string[] = [];
    const params: Params = [];
    const push = (col: string, value: SQLInputValue): void => { sets.push(`${col} = ?`); params.push(value); };
    if (patch.from !== undefined) push('from_aliases_json', this.aliasesJsonOf(patch.from));
    if (patch.to !== undefined) {
      if (typeof patch.to !== 'string' || patch.to.length < 1 || patch.to.length > 32) throw new AppError('VALIDATION_FAILED', 'to 长度需 1..32');
      push('to_term', patch.to);
    }
    if (patch.category !== undefined) push('category', patch.category === null ? null : ensureOneOf(patch.category, TERM_CATEGORIES, 'category'));
    if (patch.priority !== undefined) push('priority', intOrNull(patch.priority, 'priority') ?? 100);
    if (patch.enabled !== undefined) push('enabled', boolToInt(patch.enabled) ?? 1);
    if (patch.caseSensitive !== undefined) push('case_sensitive', boolToInt(patch.caseSensitive) ?? 0);
    if (patch.note !== undefined) push('note', patch.note ?? null);
    if (sets.length === 0) return existing;
    sets.push('updated_at = ?', 'version = version + 1');
    params.push(normIso(patch.updatedAt, 'updatedAt') ?? nowIso());
    params.push(termId);
    const changes = this.runDynamic(`UPDATE term_rules SET ${sets.join(', ')} WHERE term_id = ? AND deleted_at IS NULL`, params);
    return changes > 0 ? this.getTermRule(termId) : null;
  }

  async deleteTermRule(termId: string): Promise<boolean> {
    const at = nowIso();
    const changes = this.run('UPDATE term_rules SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE term_id = ? AND deleted_at IS NULL', [at, at, termId]);
    return changes > 0;
  }

  async replaceTermRules(rules: TermRule[]): Promise<void> {
    const at = nowIso();
    const prepared = rules.map((r) => ({ rule: r, cols: this.termColumns(r) }));
    const seen = new Set<string>();
    for (const p of prepared) {
      if (seen.has(p.rule.to)) throw new AppError('VALIDATION_FAILED', `重复的标准词: ${p.rule.to}`);
      seen.add(p.rule.to);
    }
    this.tx(() => {
      this.run('UPDATE term_rules SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE deleted_at IS NULL', [at, at]);
      const insert = this.db.prepare(
        `INSERT INTO term_rules (term_id, to_term, from_aliases_json, category, priority, enabled, case_sensitive, note,
           created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      );
      for (const { rule, cols } of prepared) {
        insert.run(
          rule.termId, rule.to, cols.aliasesJson, cols.category, intOrNull(rule.priority, 'priority') ?? 100,
          boolToInt(rule.enabled) ?? 1, boolToInt(rule.caseSensitive) ?? 0, rule.note ?? null,
          normIso(rule.createdAt, 'createdAt') ?? at, normIso(rule.updatedAt, 'updatedAt') ?? at,
        );
      }
    });
  }

  async termsVersion(): Promise<string> {
    const r = this.oneRow('SELECT MAX(updated_at) AS v FROM term_rules');
    return ((r?.v as string | null | undefined) ?? null) ?? EPOCH_ISO;
  }

  // =========================================================================
  // sync_cursors
  // =========================================================================
  private mapCursor(r: Row): SyncCursor {
    const ms = r.last_create_time_ms === null || r.last_create_time_ms === undefined ? null : Number(r.last_create_time_ms);
    return {
      accountId: String(r.account_id),
      lastStartTime: ms === null ? null : String(ms),
      lastUpstreamCallId: r.last_upstream_call_id ?? null,
      lastSyncedAt: r.last_success_at ?? null,
      updatedAt: String(r.updated_at),
      mode: (r.mode as SyncCursor['mode']) ?? 'incremental',
      lastCreateTimeMs: ms,
      lastJobId: r.last_job_id ?? null,
      lastStartedAt: r.last_started_at ?? null,
      lastSuccessAt: r.last_success_at ?? null,
      lastErrorCode: r.last_error_code ?? null,
      consecutiveFailures: Number(r.consecutive_failures ?? 0),
      fetchedTotal: Number(r.fetched_total ?? 0),
      upsertedTotal: Number(r.upserted_total ?? 0),
      backfillStateJson: r.backfill_state_json ?? null,
      windowBeginDate: r.window_begin_date ?? null,
      windowEndDate: r.window_end_date ?? null,
    };
  }

  async getCursor(accountId: string): Promise<SyncCursor | null> {
    const r = this.oneRow('SELECT * FROM sync_cursors WHERE account_id = ?', [accountId]);
    return r ? this.mapCursor(r) : null;
  }

  async upsertCursor(c: SyncCursor): Promise<void> {
    const mode = c.mode ? ensureOneOf(c.mode, SYNC_MODES, 'mode') : 'incremental';
    const lastCreateTimeMs = c.lastCreateTimeMs !== undefined && c.lastCreateTimeMs !== null
      ? intOrNull(c.lastCreateTimeMs, 'lastCreateTimeMs')
      : (c.lastStartTime !== undefined && c.lastStartTime !== null && /^\d+$/.test(String(c.lastStartTime)) ? Number(c.lastStartTime) : null);
    const updatedAt = normIso(c.updatedAt, 'updatedAt') ?? nowIso();
    this.run(
      `INSERT INTO sync_cursors (account_id, mode, last_create_time_ms, last_upstream_call_id, last_job_id,
         last_started_at, last_success_at, last_error_code, consecutive_failures, fetched_total, upserted_total,
         backfill_state_json, window_begin_date, window_end_date, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(account_id) DO UPDATE SET
         mode = excluded.mode, last_create_time_ms = excluded.last_create_time_ms,
         last_upstream_call_id = excluded.last_upstream_call_id, last_job_id = excluded.last_job_id,
         last_started_at = excluded.last_started_at, last_success_at = excluded.last_success_at,
         last_error_code = excluded.last_error_code, consecutive_failures = excluded.consecutive_failures,
         fetched_total = excluded.fetched_total, upserted_total = excluded.upserted_total,
         backfill_state_json = excluded.backfill_state_json, window_begin_date = excluded.window_begin_date,
         window_end_date = excluded.window_end_date, updated_at = excluded.updated_at,
         version = sync_cursors.version + 1`,
      [c.accountId, mode, lastCreateTimeMs, c.lastUpstreamCallId ?? null, c.lastJobId ?? null,
        normIso(c.lastStartedAt, 'lastStartedAt'), normIso(c.lastSyncedAt ?? c.lastSuccessAt, 'lastSyncedAt'),
        c.lastErrorCode ?? null, intOrNull(c.consecutiveFailures, 'consecutiveFailures') ?? 0,
        intOrNull(c.fetchedTotal, 'fetchedTotal') ?? 0, intOrNull(c.upsertedTotal, 'upsertedTotal') ?? 0,
        jsonCheck(c.backfillStateJson, 'backfillStateJson', 65536), c.windowBeginDate ?? null, c.windowEndDate ?? null, updatedAt],
    );
  }

  // =========================================================================
  // idempotency_keys
  // =========================================================================
  private mapIdem(r: Row): IdempotencyRecord {
    return {
      key: String(r.idem_key),
      scope: String(r.scope),
      requestHash: String(r.request_hash),
      responseJson: r.response_json ?? null,
      status: r.status === 'in_progress' ? 'in_progress' : 'completed',
      createdAt: String(r.created_at),
      expiresAt: String(r.expires_at),
    };
  }

  async createIdempotency(rec: IdempotencyRecord): Promise<void> {
    const scope = ensureOneOf(rec.scope, IDEM_SCOPES, 'scope');
    if (!rec.key || rec.key.length > 128) throw new AppError('VALIDATION_FAILED', 'key 长度需 1..128');
    if (!/^[0-9a-f]{64}$/.test(rec.requestHash)) throw new AppError('VALIDATION_FAILED', 'requestHash 需为 64 位小写 hex');
    const status = rec.status === 'in_progress' ? 'in_progress' : 'succeeded';
    const createdAt = normIso(rec.createdAt, 'createdAt') ?? nowIso();
    const expiresAt = normIsoReq(rec.expiresAt, 'expiresAt');
    try {
      this.run(
        'INSERT INTO idempotency_keys (scope, idem_key, request_hash, status, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [scope, rec.key, rec.requestHash, status, rec.responseJson ?? null, createdAt, expiresAt],
      );
    } catch (e) {
      const err = this.mapDbError(e);
      if (/唯一约束冲突/.test(err.message)) {
        throw new AppError('IDEMPOTENCY_CONFLICT', `幂等键冲突: ${scope}/${rec.key}`, { details: { reason: 'IN_PROGRESS_OR_DUPLICATE' } });
      }
      throw err;
    }
  }

  async getIdempotency(key: string, scope: string): Promise<IdempotencyRecord | null> {
    const r = this.oneRow('SELECT * FROM idempotency_keys WHERE scope = ? AND idem_key = ?', [scope, key]);
    return r ? this.mapIdem(r) : null;
  }

  async completeIdempotency(key: string, scope: string, responseJson: string): Promise<void> {
    if (typeof responseJson !== 'string') throw new AppError('VALIDATION_FAILED', 'responseJson 必须是字符串');
    if (Buffer.byteLength(responseJson, 'utf8') > 65536) throw new AppError('VALIDATION_FAILED', 'responseJson 超过 64KB');
    this.run(
      "UPDATE idempotency_keys SET status = 'succeeded', response_json = ?, completed_at = ? WHERE scope = ? AND idem_key = ?",
      [responseJson, nowIso(), scope, key],
    );
  }

  async deleteExpiredIdempotency(nowIsoStr: string): Promise<number> {
    const now = normIsoReq(nowIsoStr, 'nowIso');
    return this.run('DELETE FROM idempotency_keys WHERE expires_at <= ?', [now]);
  }

  // =========================================================================
  // audit_logs
  // =========================================================================
  async insertAudit(a: AuditLog): Promise<void> {
    const actor = a.actor ?? 'local-api';
    if (!(AUDIT_ACTORS as readonly string[]).includes(actor)) {
      throw new AppError('VALIDATION_FAILED', `非法审计 actor: ${actor}（允许: ${AUDIT_ACTORS.join('|')}）`);
    }
    const occurredAt = normIsoReq(a.at, 'at');
    const result = a.result
      ? ensureOneOf(a.result, AUDIT_RESULTS, 'result')
      : (jsonParse<{ result?: string }>(a.detailJson ?? null)?.result === 'failed' ? 'failed' : 'success');
    const detailJson = a.detailJson === null || a.detailJson === undefined ? '{}' : (jsonCheck(a.detailJson, 'detailJson', 4096) ?? '{}');
    let targetType = a.targetType ?? null;
    let targetId: string | null = null;
    if (a.target) {
      const idx = a.target.indexOf(':');
      if (idx > 0) {
        targetType = targetType ?? a.target.slice(0, idx);
        targetId = a.target.slice(idx + 1);
      } else {
        targetId = a.target;
      }
    }
    this.run(
      `INSERT INTO audit_logs (audit_id, occurred_at, actor, action, target_type, target_id, account_id, request_id,
         source_ip, result, error_code, details_redacted_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [a.auditId, occurredAt, actor, a.action, targetType, targetId, a.accountId ?? null, a.requestId ?? null,
        a.sourceIp ?? null, result, a.errorCode ?? null, detailJson],
    );
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
export async function openRepo(dbPath: string): Promise<Repo> {
  return new SqliteRepo(dbPath);
}
