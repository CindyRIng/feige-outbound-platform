import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config } from './types/config.js';
import type { Secrets } from './types/config.js';
import { AppError } from './errors.js';

export const CONFIG_DIR = process.env.FOP_CONFIG_DIR ?? join(homedir(), '.config', 'feige-outbound');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
export const SECRETS_FILE = join(CONFIG_DIR, 'secrets.json');
export const TOKEN_FILE = join(CONFIG_DIR, 'api-token');

export function defaultConfig(): Config {
  const dataDir = join(homedir(), '.local', 'share', 'feige-outbound');
  return {
    server: { host: '127.0.0.1', port: 8710, allowRemote: false, apiTokenFile: null },
    storage: { dataDir, dbFile: 'fop.db', audioDir: 'audio', asrDir: 'asr' },
    browser: { headless: false, profileRoot: join(dataDir, 'profiles'), executablePath: null },
    dial: { windowStart: '07:50', windowEnd: '22:00', timezone: 'Asia/Shanghai', scheduleOutsideWindow: true },
    limits: { perAccountConcurrency: 1, globalConcurrency: 8, upstreamReadQps: 5, dialCooldownMs: 60000, apiQps: 100 },
    sync: { intervalMs: 60000, pageSize: 100, lookbackDays: 7 },
    pipeline: {
      asr: { provider: 'minimax', baseUrl: 'https://api.minimax.cn', model: 'asr-1.0', language: 'zh', responseFormat: 'verbose_json', timestampLevel: 'sentence', chunkSeconds: 420, concurrency: 1, timeoutMs: 600000, maxRetries: 3 },
      analysis: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', escalateModel: 'deepseek-v4-pro', promptVersion: 'analysis-v1', temperature: 0.2, maxTokens: 2000, escalateMaxTokens: 4096, concurrency: 8, maxRetries: 3, redactPhones: true, redactNames: false, maxInputChars: 120000 },
      roleMapping: { method: 'auto', llmVerify: true, lowConfidenceReview: true },
      rawDump: { enabled: false },
    },
    events: { sseHeartbeatMs: 15000, webhooks: [] },
    logging: { level: 'info' },
    backup: { includeAsrChunks: false },
    runtime: { keepAliveMs: 60000, jobLeaseMs: 300000 },
  };
}

function deepMerge<T>(base: T, patch: any): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch)) return patch as T;
  if (typeof patch !== 'object') return patch as T;
  const out: any = Array.isArray(base) ? [...base] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) { delete out[k]; continue; }
    out[k] = (base && typeof base === 'object' && k in (base as any)) ? deepMerge((base as any)[k], v) : v;
  }
  return out as T;
}

export class ConfigStore {
  private cfg: Config;
  private sec: Secrets;
  constructor() {
    this.cfg = defaultConfig();
    this.sec = { accounts: {} };
    this.load();
  }
  private load() {
    try { if (existsSync(CONFIG_FILE)) this.cfg = deepMerge(this.cfg, JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))); } catch (e) { throw new AppError('CONFIG_INVALID', `配置文件解析失败: ${(e as Error).message}`); }
    try { if (existsSync(SECRETS_FILE)) this.sec = { accounts: {}, ...JSON.parse(readFileSync(SECRETS_FILE, 'utf8')) }; } catch (e) { throw new AppError('CONFIG_INVALID', `密钥文件解析失败: ${(e as Error).message}`); }
    // env overrides
    if (process.env.FOP_PORT) this.cfg.server.port = Number(process.env.FOP_PORT);
    if (process.env.FOP_HOST) this.cfg.server.host = process.env.FOP_HOST;
    if (process.env.FOP_DATA_DIR) { this.cfg.storage.dataDir = process.env.FOP_DATA_DIR; this.cfg.storage.asrDir = 'asr'; }
    if (process.env.FOP_MINIMAX_API_KEY) this.sec.minimaxApiKey = process.env.FOP_MINIMAX_API_KEY;
    if (process.env.FOP_DEEPSEEK_API_KEY) this.sec.deepseekApiKey = process.env.FOP_DEEPSEEK_API_KEY;
    if (process.env.FOP_ASR_MODEL) this.cfg.pipeline.asr.model = process.env.FOP_ASR_MODEL;
    if (process.env.FOP_ANALYSIS_MODEL) this.cfg.pipeline.analysis.model = process.env.FOP_ANALYSIS_MODEL;
    if (process.env.FOP_LOG_LEVEL) this.cfg.logging.level = process.env.FOP_LOG_LEVEL as any;
  }
  get(): Config { return this.cfg; }
  secrets(): Secrets { return this.sec; }
  apiToken(): string {
    const explicit = this.cfg.server.apiTokenFile ?? TOKEN_FILE;
    try {
      if (existsSync(explicit)) { const t = readFileSync(explicit, 'utf8').trim(); if (t) return t; }
      // backwards-compatible default location
      if (explicit !== TOKEN_FILE && existsSync(TOKEN_FILE)) { const t = readFileSync(TOKEN_FILE, 'utf8').trim(); if (t) return t; }
    } catch { /* ignore */ }
    throw new AppError('SERVICE_UNAVAILABLE', '本地 API token 不存在，请先运行 `feige serve` 初始化或执行 `feige doctor --fix-token`');
  }
  ensureApiToken(): string {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    try { if (existsSync(TOKEN_FILE)) { const t = readFileSync(TOKEN_FILE, 'utf8').trim(); if (t) return t; } } catch { /* ignore */ }
    const token = 'fop_' + crypto.randomUUID().replace(/-/g, '');
    writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 }); chmodSync(TOKEN_FILE, 0o600);
    return token;
  }
  ensureDirs(): void {
    const s = this.cfg.storage;
    for (const d of [s.dataDir, join(s.dataDir, s.audioDir), join(s.dataDir, s.asrDir), join(s.dataDir, 'tmp'), join(s.dataDir, 'diagnostics'), this.cfg.browser.profileRoot]) {
      mkdirSync(d, { recursive: true, mode: 0o700 });
    }
  }
  patch(patch: Record<string, any>): { config: Config; restartRequired: boolean } {
    const allowed = new Set(['server','storage','browser','dial','limits','sync','pipeline','events','logging','backup','runtime']);
    for (const k of Object.keys(patch)) if (!allowed.has(k)) throw new AppError('VALIDATION_FAILED', `未知配置节: ${k}`, { details: { fields: [{ field: k, reason: 'unknown' }] } });
    const before = JSON.stringify(this.cfg);
    const merged = deepMerge(this.cfg, patch);
    validateConfig(merged);
    this.cfg = merged;
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CONFIG_FILE, JSON.stringify(this.cfg, null, 2) + '\n', { mode: 0o600 }); chmodSync(CONFIG_FILE, 0o600);
    const restartRequired = this.cfg.server.host !== JSON.parse(before).server.host || this.cfg.server.port !== JSON.parse(before).server.port;
    return { config: this.cfg, restartRequired };
  }
  putAccountSecret(accountId: string, username: string, password: string, browserProfile?: string) {
    this.sec.accounts[accountId] = { username, password, ...(browserProfile ? { browserProfile } : {}) };
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(SECRETS_FILE, JSON.stringify(this.sec, null, 2) + '\n', { mode: 0o600 }); chmodSync(SECRETS_FILE, 0o600);
  }
  removeAccountSecret(accountId: string) { delete this.sec.accounts[accountId]; this.saveSecrets(); }
  saveSecrets() { writeFileSync(SECRETS_FILE, JSON.stringify(this.sec, null, 2) + '\n', { mode: 0o600 }); chmodSync(SECRETS_FILE, 0o600); }
  paths() {
    const s = this.cfg.storage;
    return {
      dataDir: s.dataDir,
      dbPath: join(s.dataDir, s.dbFile),
      audioDir: join(s.dataDir, s.audioDir),
      asrDir: join(s.dataDir, s.asrDir),
      tmpDir: join(s.dataDir, 'tmp'),
      diagnosticsDir: join(s.dataDir, 'diagnostics'),
      profilesDir: this.cfg.browser.profileRoot,
      logFile: join(s.dataDir, 'logs', 'fop.log'),
    };
  }
}

export function validateConfig(c: Config) {
  const errs: { field: string; reason: string }[] = [];
  const hhmm = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  if (!hhmm(c.dial.windowStart)) errs.push({ field: 'dial.windowStart', reason: 'HH:MM' });
  if (!hhmm(c.dial.windowEnd)) errs.push({ field: 'dial.windowEnd', reason: 'HH:MM' });
  if (c.dial.windowStart >= c.dial.windowEnd) errs.push({ field: 'dial', reason: 'windowStart<windowEnd' });
  if (c.sync.pageSize < 10 || c.sync.pageSize > 100) errs.push({ field: 'sync.pageSize', reason: '10..100' });
  if (c.limits.perAccountConcurrency !== 1) errs.push({ field: 'limits.perAccountConcurrency', reason: 'v1 callback mode must be 1' });
  if (c.pipeline.asr.chunkSeconds < 60 || c.pipeline.asr.chunkSeconds > 480) errs.push({ field: 'pipeline.asr.chunkSeconds', reason: '60..480' });
  if (c.pipeline.analysis.maxTokens < 100) errs.push({ field: 'pipeline.analysis.maxTokens', reason: '>=100' });
  if (errs.length) throw new AppError('VALIDATION_FAILED', '配置校验失败', { details: { fields: errs } });
}
