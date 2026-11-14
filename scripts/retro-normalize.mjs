#!/usr/bin/env node
/**
 * 词表重归一维护脚本（不重跑 ASR/LLM，低成本刷新历史数据）
 *
 * 用途：修改词表（term_rules）后，按**当前词表**重新计算已存转写与分析文本里的词表变体：
 *   - 转写：按 text_raw 重算每个 segment 的 text_normalized，并重建 transcripts.full_text；
 *           full_text_raw 保留原文（可追溯），不重跑 ASR（分块缓存保持不动）。
 *   - 分析：对 summary / bullets / keywords / result_json / quality_flags_json 中的字符串递归归一，
 *           并刷新 terms_applied_json / terms_version（不重跑 DeepSeek）。
 *
 * 默认 dry-run（只统计不写库）；确认后加 --apply 落库。
 *
 * 用法：
 *   node scripts/retro-normalize.mjs                 # dry-run：统计将变化的转写/分析
 *   node scripts/retro-normalize.mjs --apply         # 落库
 *   node scripts/retro-normalize.mjs --call <callId> --apply   # 只处理单条
 *   node scripts/retro-normalize.mjs --limit 50      # 只处理前 N 条（调试）
 */
import { openRepo } from '../dist/src/db/sqlite.js';
import { TermService } from '../dist/src/core/terms.js';
import { Logger } from '../dist/src/logger.js';
import { ConfigStore } from '../dist/src/config.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const ONLY_CALL = opt('--call');
const LIMIT = opt('--limit') ? Number(opt('--limit')) : 0;

const cfg = new ConfigStore();
const logger = new Logger('error');
const repo = await openRepo(cfg.paths().dbPath);
const terms = new TermService(repo, logger);
await terms.reload();
const rules = await repo.listTermRules({ enabled: true });
const aliasCount = rules.reduce((n, r) => n + r.from.length, 0);
console.log(`词表：${rules.length} 条规则 / ${aliasCount} 个别名 · 版本 ${await repo.termsVersion()} · 模式 ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

const addApplied = (agg, applied) => { for (const a of applied) { const k = `${a.from}=>${a.to}`; const prev = agg.get(k); agg.set(k, { from: a.from, to: a.to, count: (prev?.count ?? 0) + a.count }); } };
const appliedArr = (agg) => [...agg.values()];

/** 递归归一字符串（数组/对象遍历；保持键不变） */
async function normalizeDeep(value, agg) {
  if (typeof value === 'string') { const r = await terms.normalizeText(value); addApplied(agg, r.applied); return r.normalized; }
  if (Array.isArray(value)) { const out = []; for (const v of value) out.push(await normalizeDeep(v, agg)); return out; }
  if (value && typeof value === 'object') { const out = {}; for (const [k, v] of Object.entries(value)) out[k] = await normalizeDeep(v, agg); return out; }
  return value;
}
function parseJson(s, fallback) { if (!s) return fallback; try { return JSON.parse(s); } catch { return fallback; } }

const stats = { calls: 0, transcripts: 0, transcriptsChanged: 0, segments: 0, segmentsChanged: 0, analyses: 0, analysesChanged: 0 };
const samples = [];
const pageSize = 100;
let page = 1; let total = Infinity;
while ((page - 1) * pageSize < total) {
  const res = await repo.listCalls({ page, size: pageSize, hasTranscript: true });
  total = res.total;
  for (const call of res.items) {
    if (ONLY_CALL && call.callId !== ONLY_CALL) continue;
    if (LIMIT && stats.calls >= LIMIT) break;
    stats.calls++;
    const t = await repo.getCurrentTranscript(call.callId);
    if (!t) continue;
    stats.transcripts++;
    const segs = await repo.listSegments(t.transcriptId);
    const applied = new Map();
    let segChanged = 0;
    const newSegs = [];
    for (const seg of segs) {
      stats.segments++;
      const r = await terms.normalizeText(seg.rawText);
      addApplied(applied, r.applied);
      if (r.normalized !== seg.normalizedText) segChanged++;
      newSegs.push({ ...seg, normalizedText: r.normalized });
    }
    const fullText = newSegs.map(s => s.normalizedText).join('\n');
    const trChanged = segChanged > 0 || fullText !== (t.fullText ?? '');
    const termsArr = appliedArr(applied);
    // 分析：递归归一输出文本
    const a = await repo.getCurrentAnalysis(call.callId);
    let anChanged = false; let anPatch = null;
    if (a) {
      stats.analyses++;
      const anApplied = new Map();
      for (const v of appliedArr(applied)) addApplied(anApplied, [v]);
      const summary = await normalizeDeep(a.summary ?? '', anApplied);
      const bullets = await normalizeDeep(parseJson(a.summaryBulletsJson, []), anApplied);
      const keywords = await normalizeDeep(parseJson(a.keywordsJson, []), anApplied);
      const result = await normalizeDeep(parseJson(a.resultJson, null), anApplied);
      const quality = await normalizeDeep(parseJson(a.qualityFlagsJson, []), anApplied);
      const merged = appliedArr(anApplied);
      const next = {
        summary,
        summaryBulletsJson: JSON.stringify(bullets),
        keywordsJson: JSON.stringify(keywords),
        resultJson: result === null ? null : JSON.stringify(result),
        qualityFlagsJson: JSON.stringify(quality),
        termsAppliedJson: JSON.stringify(merged),
        termsVersion: JSON.stringify(merged),
        updatedAt: new Date().toISOString(),
      };
      anChanged = (a.summary ?? '') !== summary || a.summaryBulletsJson !== next.summaryBulletsJson
        || a.keywordsJson !== next.keywordsJson || a.resultJson !== next.resultJson
        || a.qualityFlagsJson !== next.qualityFlagsJson || a.termsAppliedJson !== next.termsAppliedJson;
      anPatch = next;
    }
    if (trChanged) stats.transcriptsChanged++;
    if (segChanged) stats.segmentsChanged += segChanged;
    if (anChanged) stats.analysesChanged++;
    if ((trChanged || anChanged) && samples.length < 5) samples.push({ callId: call.callId, segChanged, trChanged: !!trChanged, anChanged: !!anChanged, before: (segs[0]?.normalizedText ?? '').slice(0, 40), after: (newSegs[0]?.normalizedText ?? '').slice(0, 40) });
    if (!APPLY) continue;
    if (trChanged) {
      await repo.replaceSegments(t.transcriptId, call.callId, newSegs);
      await repo.updateTranscript(t.transcriptId, { fullText, updatedAt: new Date().toISOString() });
    }
    if (anChanged && a && anPatch) await repo.updateAnalysis(a.analysisId, anPatch);
    if (VERBOSE) console.log(`✔ ${call.callId} segments=${segChanged} transcript=${trChanged} analysis=${anChanged}`);
  }
  if (LIMIT && stats.calls >= LIMIT) break;
  page++;
  if (page > 200) break;
}
console.log(JSON.stringify({ ...stats, mode: APPLY ? 'apply' : 'dry-run' }, null, 2));
if (samples.length) { console.log('--- 样例 ---'); for (const s of samples) console.log(JSON.stringify(s)); }
await repo.close();
