import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT_KEYS = ['password','token','cloud-token','authorization','apikey','api_key','secret','jwt','cookie'];
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;

export class Logger {
  constructor(private level: LogLevel = 'info', private logFile?: string) {}
  child(fields: Record<string, unknown>): Logger { 
    const child = new Logger(this.level, this.logFile);
    (child as any).base = { ...((this as any).base ?? {}), ...fields };
    return child;
  }
  debug(msg: string, f?: Record<string, unknown>) { this.write('debug', msg, f); }
  info(msg: string, f?: Record<string, unknown>) { this.write('info', msg, f); }
  warn(msg: string, f?: Record<string, unknown>) { this.write('warn', msg, f); }
  error(msg: string, f?: Record<string, unknown>) { this.write('error', msg, f); }
  private write(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (ORDER[level] < ORDER[this.level]) return;
    const base = (this as any).base ?? {};
    const safe = this.redact({ ...base, ...(fields ?? {}) });
    const rec = { ts: new Date().toISOString(), level, msg: this.redactString(msg), ...safe };
    const line = JSON.stringify(rec);
    if (level === 'error') process.stderr.write(line + '\n'); else process.stdout.write(line + '\n');
    if (this.logFile) { try { mkdirSync(dirname(this.logFile), { recursive: true }); appendFileSync(this.logFile, line + '\n'); } catch { /* ignore */ } }
  }
  private redact(o: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (REDACT_KEYS.some(r => k.toLowerCase().includes(r))) out[k] = '***';
      else if (typeof v === 'string') out[k] = this.redactString(v);
      else if (v && typeof v === 'object') out[k] = Array.isArray(v) ? v : '[object]';
      else out[k] = v;
    }
    return out;
  }
  private redactString(s: string): string {
    return String(s ?? '').replace(PHONE, m => m.slice(0,3) + '****' + m.slice(-4))
      .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '***JWT***')
      .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***');
  }
}
export const logger = new Logger((process.env.FOP_LOG_LEVEL as LogLevel) ?? 'info');
