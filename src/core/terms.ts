import type { Repo } from '../db/repo.js';
import type { TermRule } from '../types/domain.js';
import type { TermCategory } from '../types/common.js';
import { newTermId } from './ids.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';

export interface TermInput { from: string[]; to: string; category?: TermCategory | null; priority?: number; enabled?: boolean; caseSensitive?: boolean; note?: string | null; }
interface CompiledRule { from: string; to: string; priority: number; length: number; caseSensitive: boolean; }
export interface NormalizeOutcome { normalized: string; applied: { from: string; to: string; count: number }[]; rulesVersion: string; }

const FULLWIDTH = /[\uff01-\uff5e]/g;
function toHalfWidth(s: string): string { return s.replace(FULLWIDTH, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)); }
function fold(s: string): string { return toHalfWidth(s).toLowerCase(); }

export class TermService {
  private rules: CompiledRule[] = [];
  private version = new Date(0).toISOString();
  private loaded = false;
  constructor(private repo: Repo, private log: Logger) {}

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.reload();
  }
  async reload(): Promise<void> {
    const rules = await this.repo.listTermRules({ enabled: true });
    this.rules = rules.flatMap(r => (r.enabled ? r.from : []).map(f => ({ from: f, to: r.to, priority: r.priority, length: f.length, caseSensitive: r.caseSensitive })))
      .sort((a, b) => (b.priority - a.priority) || (b.length - a.length));
    this.version = await this.repo.termsVersion();
    this.loaded = true;
    this.log.info('term rules loaded', { count: this.rules.length, version: this.version });
  }
  async list(opts: { q?: string; enabled?: boolean } = {}): Promise<TermRule[]> { return this.repo.listTermRules(opts); }
  async create(input: TermInput): Promise<TermRule> {
    validate(input);
    const now = new Date().toISOString();
    const rule: TermRule = {
      termId: newTermId(), from: dedupe(input.from), to: input.to.trim(),
      category: input.category ?? 'custom', priority: input.priority ?? 100,
      enabled: input.enabled ?? true, caseSensitive: input.caseSensitive ?? false,
      note: input.note ?? null, createdAt: now, updatedAt: now,
    };
    const created = await this.repo.createTermRule(rule);
    await this.reload();
    return created;
  }
  async update(termId: string, patch: Partial<TermInput>): Promise<TermRule> {
    const existing = await this.repo.getTermRule(termId);
    if (!existing) throw new AppError('TERM_NOT_FOUND', `词条不存在: ${termId}`);
    const merged: TermInput = { from: patch.from ?? existing.from, to: patch.to ?? existing.to, category: patch.category ?? existing.category, priority: patch.priority ?? existing.priority, enabled: patch.enabled ?? existing.enabled, caseSensitive: patch.caseSensitive ?? existing.caseSensitive, note: patch.note ?? existing.note };
    validate(merged);
    const updated = await this.repo.updateTermRule(termId, { from: dedupe(merged.from), to: merged.to, category: merged.category ?? null, priority: merged.priority, enabled: merged.enabled, caseSensitive: merged.caseSensitive, note: merged.note ?? null, updatedAt: new Date().toISOString() });
    await this.reload();
    return updated!;
  }
  async remove(termId: string): Promise<void> {
    const ok = await this.repo.deleteTermRule(termId);
    if (!ok) throw new AppError('TERM_NOT_FOUND', `词条不存在: ${termId}`);
    await this.reload();
  }
  async replaceAll(inputs: TermInput[]): Promise<{ count: number; version: string }> {
    inputs.forEach(validate);
    const now = new Date().toISOString();
    const rules: TermRule[] = inputs.map(i => ({ termId: newTermId(), from: dedupe(i.from), to: i.to.trim(), category: i.category ?? 'custom', priority: i.priority ?? 100, enabled: i.enabled ?? true, caseSensitive: i.caseSensitive ?? false, note: i.note ?? null, createdAt: now, updatedAt: now }));
    await this.repo.replaceTermRules(rules);
    await this.reload();
    return { count: rules.length, version: now };
  }
  async normalizeText(text: string): Promise<NormalizeOutcome> {
    await this.ensureLoaded();
    let out = text; const applied = new Map<string, { from: string; to: string; count: number }>();
    for (const rule of this.rules) {
      const hay = rule.caseSensitive ? out : fold(out);
      const needle = rule.caseSensitive ? rule.from : fold(rule.from);
      if (!hay.includes(needle)) continue;
      let count = 0; let idx = 0; let result = ''; let cursor = 0;
      const src = rule.caseSensitive ? out : fold(out);
      while (true) {
        const at = src.indexOf(needle, idx);
        if (at < 0) break;
        result += out.slice(cursor, at) + rule.to; cursor = at + rule.from.length; idx = cursor; count++;
      }
      if (count > 0) {
        result += out.slice(cursor); out = result;
        const k = `${rule.from}=>${rule.to}`;
        const prev = applied.get(k);
        applied.set(k, { from: rule.from, to: rule.to, count: (prev?.count ?? 0) + count });
      }
    }
    return { normalized: out, applied: [...applied.values()], rulesVersion: this.version };
  }
}

function validate(i: TermInput) {
  const errs: { field: string; reason: string }[] = [];
  if (!Array.isArray(i.from) || i.from.length === 0) errs.push({ field: 'from', reason: 'required non-empty array' });
  else if (i.from.some(f => !f || f.length > 32)) errs.push({ field: 'from', reason: 'each 1..32 chars' });
  if (!i.to || i.to.length > 32) errs.push({ field: 'to', reason: '1..32 chars' });
  if (i.from?.some(f => f === i.to)) errs.push({ field: 'from', reason: 'variant equals to' });
  if (i.priority !== undefined && (!Number.isInteger(i.priority) || i.priority < 0 || i.priority > 10000)) errs.push({ field: 'priority', reason: '0..10000' });
  if (errs.length) throw new AppError('VALIDATION_FAILED', '词条校验失败', { details: { fields: errs } });
}
function dedupe(a: string[]): string[] { return [...new Set(a.map(s => s.trim()).filter(Boolean))]; }
