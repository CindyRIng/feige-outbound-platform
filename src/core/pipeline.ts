import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import type { Repo } from '../db/repo.js';
import type { ConfigStore } from '../config.js';
import type { Call, Transcript, TranscriptSegment, TranscriptChunk, Job } from '../types/domain.js';
import type { AsrChunkResult, ChunkPlan, WavInfo, AnalysisClient, AsrClient } from '../media/types.js';
import { probeWav, planChunks, sliceWav, sliceChannelWav, detectSilences } from '../media/chunker.js';
import type { EventBus } from './events.js';
import type { JobQueue } from './jobs.js';
import type { Logger } from '../logger.js';
import { newAudioId, newTranscriptId, newSegmentId, newAnalysisId, newChunkId } from './ids.js';
import { AppError } from '../errors.js';
import { safeJson } from './jobs.js';
import { maskPhone, maskName, maskPhonesInText } from '../util/phone.js';
import type { TermService } from './terms.js';
import type { AccountService } from './accounts.js';

export interface PipelineSvcDeps {
  repo: Repo; config: ConfigStore; events: EventBus; jobs: JobQueue; log: Logger;
  terms: TermService; accounts: AccountService;
  createAsr: (overrideModel?: string) => AsrClient;
  createAnalysis: (overrideModel?: string) => AnalysisClient;
}

export class PipelineService {
  constructor(private d: PipelineSvcDeps) {}

  // ---------- jobs ----------
  async runAudioJob(job: Job): Promise<Record<string, unknown>> {
    const callId = job.callId ?? (safeJson<{ callId?: string }>(job.payloadJson)?.callId ?? '');
    const call = await this.d.repo.getCall(callId);
    if (!call) throw new AppError('CALL_NOT_FOUND', `话单不存在: ${callId}`);
    try {
      const asset = await this.fetchAudio(call);
      return { callId, audioId: asset.audioId, sizeBytes: asset.sizeBytes, sha256: asset.sha256 };
    } catch (e) {
      await this.d.repo.updateCall(call.callId, { audioStatus: 'failed', audioLastErrorCode: (e as any).code ?? 'AUDIO_DOWNLOAD_FAILED', pipelineLastErrorJson: JSON.stringify({ code: (e as any).code ?? 'AUDIO_DOWNLOAD_FAILED', message: (e as Error).message, at: new Date().toISOString() }), updatedAt: new Date().toISOString() } as any, null);
      await this.d.events.emit({ type: 'call.audio.failed', callId: call.callId, accountId: call.accountId, data: { callId: call.callId, errorCode: (e as any).code ?? 'AUDIO_DOWNLOAD_FAILED' } });
      throw e;
    }
  }
  async runAsrJob(job: Job): Promise<Record<string, unknown>> {
    const callId = job.callId ?? (safeJson<{ callId?: string }>(job.payloadJson)?.callId ?? '');
    const call = await this.d.repo.getCall(callId);
    if (!call) throw new AppError('CALL_NOT_FOUND', `话单不存在: ${callId}`);
    try {
      const t = await this.transcribe(call);
      return { callId, transcriptId: t.transcriptId, segmentCount: t.segmentCount ?? 0, needsReview: t.needsReview };
    } catch (e) {
      await this.d.repo.updateCall(call.callId, { transcriptStatus: 'failed', transcriptLastErrorCode: (e as any).code ?? 'ASR_FAILED', pipelineLastErrorJson: JSON.stringify({ code: (e as any).code ?? 'ASR_FAILED', message: (e as Error).message, at: new Date().toISOString() }), updatedAt: new Date().toISOString() } as any, null);
      await this.d.events.emit({ type: 'call.transcript.failed', callId: call.callId, accountId: call.accountId, data: { callId: call.callId, errorCode: (e as any).code ?? 'ASR_FAILED' } });
      throw e;
    }
  }
  async runAnalysisJob(job: Job): Promise<Record<string, unknown>> {
    const callId = job.callId ?? (safeJson<{ callId?: string }>(job.payloadJson)?.callId ?? '');
    const call = await this.d.repo.getCall(callId);
    if (!call) throw new AppError('CALL_NOT_FOUND', `话单不存在: ${callId}`);
    try {
      const a = await this.analyze(call, job);
      if (!a) return { callId, skipped: true };
      return { callId, analysisId: a };
    } catch (e) {
      await this.d.repo.updateCall(call.callId, { analysisStatus: 'failed', analysisLastErrorCode: (e as any).code ?? 'ANALYSIS_FAILED', pipelineLastErrorJson: JSON.stringify({ code: (e as any).code ?? 'ANALYSIS_FAILED', message: (e as Error).message, at: new Date().toISOString() }), updatedAt: new Date().toISOString() } as any, null);
      await this.d.events.emit({ type: 'call.analysis.failed', callId: call.callId, accountId: call.accountId, data: { callId: call.callId, errorCode: (e as any).code ?? 'ANALYSIS_FAILED' } });
      throw e;
    }
  }
  async runReprocessJob(job: Job): Promise<Record<string, unknown>> {
    const p = safeJson<{ callId: string; stages: string[]; force?: boolean; options?: { asrModel?: string; analysisModel?: string } }>(job.payloadJson);
    if (!p?.callId) throw new AppError('VALIDATION_FAILED', 'reprocess 缺少 callId');
    const call = await this.d.repo.getCall(p.callId);
    if (!call) throw new AppError('CALL_NOT_FOUND', `话单不存在: ${p.callId}`);
    if (call.status === 'canceled') throw new AppError('CALL_ALREADY_TERMINAL', '已取消话单不可重跑');
    const done: string[] = [];
    for (const stage of p.stages) {
      if (stage === 'audio') { await this.d.repo.updateCall(call.callId, { audioStatus: 'pending' } as any, null); await this.fetchAudio(call); done.push('audio'); }
      else if (stage === 'transcript') { await this.d.repo.updateCall(call.callId, { transcriptStatus: 'pending' } as any, null); await this.transcribe(call, { asrModel: p.options?.asrModel, force: p.force }); done.push('transcript'); }
      else if (stage === 'analysis') { await this.d.repo.updateCall(call.callId, { analysisStatus: 'pending' } as any, null); await this.analyze(call, job, { analysisModel: p.options?.analysisModel, force: p.force }); done.push('analysis'); }
    }
    return { callId: call.callId, stages: done };
  }

  // ---------- audio ----------
  async fetchAudio(call: Call): Promise<{ audioId: string; sizeBytes: number; sha256: string }> {
    if (call.audioStatus === 'ready') { const a = await this.d.repo.getAudioByCall(call.callId); if (a) return { audioId: a.audioId, sizeBytes: a.sizeBytes, sha256: a.sha256 }; }
    const raw = safeJson<{ preRecordUrl?: string | null; telB?: string | null }>(call.upstreamRawJson) ?? {};
    const url = raw.preRecordUrl;
    const now = new Date().toISOString();
    await this.d.repo.updateCall(call.callId, { audioStatus: 'in_progress', audioRetryCount: (call.audioRetryCount ?? 0) + 1, pipelineUpdatedAt: now } as any, null);
    if (!url) {
      await this.d.repo.updateCall(call.callId, { audioStatus: 'missing', transcriptStatus: 'missing', analysisStatus: 'skipped', audioReadyAt: now } as any, null);
      await this.d.events.emit({ type: 'call.audio.missing', callId: call.callId, accountId: call.accountId, data: { callId: call.callId } });
      throw new AppError('AUDIO_NOT_AVAILABLE', '该话单无录音');
    }
    const candidates = buildCandidates(url);
    let lastErr: Error | null = null; let buf: Buffer | null = null;
    for (const u of candidates) {
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(120000) });
        if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        buf = Buffer.from(await res.arrayBuffer()); break;
      } catch (e) { lastErr = e as Error; }
    }
    if (!buf) throw new AppError('AUDIO_DOWNLOAD_FAILED', `录音下载失败: ${lastErr?.message ?? 'unknown'}`, { details: { url } });
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const dir = dateDir(this.d.config.paths().audioDir, call.endedAt ?? call.createdAt);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const storagePath = relativeToDataDir(this.d.config.paths().dataDir, join(dir, `${call.callId}.wav`));
    const abs = join(this.d.config.paths().dataDir, storagePath);
    await writeFileAtomic(abs, buf);
    let info: WavInfo | null = null; try { info = await probeWav(abs); } catch { info = null; }
    const audioId = newAudioId();
    await this.d.repo.upsertAudio({ audioId, callId: call.callId, sourceUrl: url, storagePath, format: 'wav', sampleRate: info?.sampleRate ?? 16000, channels: info?.channels ?? 1, durationMs: info?.durationMs ?? (call.durationSec ?? 0) * 1000, sizeBytes: buf.length, sha256, downloadedAt: now } as any);
    await this.d.repo.updateCall(call.callId, { audioStatus: 'ready', audioReadyAt: now, transcriptStatus: 'pending', audioLastErrorCode: null, pipelineLastErrorJson: null, pipelineUpdatedAt: now } as any, null);
    await this.d.events.emit({ type: 'call.audio.ready', callId: call.callId, accountId: call.accountId, data: { callId: call.callId, audioId, sizeBytes: buf.length, durationMs: info?.durationMs ?? null } });
    await this.d.jobs.enqueueIfAbsent('asr', call.callId, { accountId: call.accountId, payload: { callId: call.callId }, maxAttempts: 5, priority: 60 });
    return { audioId, sizeBytes: buf.length, sha256 };
  }

  // ---------- ASR ----------
  async transcribe(call: Call, opts: { asrModel?: string; force?: boolean } = {}): Promise<Transcript> {
    const audio = await this.d.repo.getAudioByCall(call.callId);
    if (!audio) throw new AppError('AUDIO_NOT_AVAILABLE', '录音未归档，无法转写');
    const abs = join(this.d.config.paths().dataDir, audio.storagePath);
    if (!existsSync(abs)) throw new AppError('AUDIO_NOT_AVAILABLE', `录音文件缺失: ${audio.storagePath}`);
    const now = new Date().toISOString();
    await this.d.repo.updateCall(call.callId, { transcriptStatus: 'in_progress', transcriptRetryCount: (call.transcriptRetryCount ?? 0) + 1, pipelineUpdatedAt: now } as any, null);
    const info = await probeWav(abs);
    const cfg = this.d.config.get();
    const asr = this.d.createAsr(opts.asrModel);
    const revision = ((await this.d.repo.getCurrentTranscript(call.callId))?.revision ?? 0) + 1;
    let plans: ChunkPlan[];
    const maxOne = 480000;
    if (info.durationMs <= maxOne) plans = [{ index: 0, beginMs: 0, endMs: info.durationMs, forcedCut: false }];
    else plans = planChunks(info.durationMs, cfg.pipeline.asr.chunkSeconds, await detectSilences(info, 300));
    const chunkResults: AsrChunkResult[] = [];
    const asrMetaChunks: Record<string, unknown>[] = [];
    const stereo = info.channels === 2;
    const mergedRaw: { beginMs: number; endMs: number; label: string; text: string; chunkIndex: number; channel: number | null }[] = [];
    for (const plan of plans) {
      const existing = await this.d.repo.listChunks(call.callId, revision);
      const found = existing.find(c => c.chunkIndex === plan.index && c.status === 'ready' && c.resultPath);
      const outRel = `asr/${call.callId}/chunk-${plan.index}.json`;
      const outAbs = join(this.d.config.paths().dataDir, outRel);
      if (found && found.resultPath && existsSync(join(this.d.config.paths().dataDir, found.resultPath)) && !opts.force) {
        const cached = JSON.parse(await readFile(join(this.d.config.paths().dataDir, found.resultPath), 'utf8')) as { segments?: AsrChunkResult['segments']; text?: string; durationMs?: number; nSpeakers?: number; traceId?: string | null };
        const r: AsrChunkResult = { text: cached.text ?? '', durationMs: cached.durationMs ?? 0, nSpeakers: cached.nSpeakers ?? 1, segments: cached.segments ?? [], traceId: cached.traceId ?? null };
        for (const seg of r.segments) mergedRaw.push({ beginMs: plan.beginMs + seg.beginMs, endMs: plan.beginMs + seg.endMs, label: seg.speakerLabel || 'S1', text: seg.text.trim(), chunkIndex: plan.index, channel: (seg as any).channel ?? null });
        chunkResults.push(r); asrMetaChunks.push({ index: plan.index, beginMs: plan.beginMs, endMs: plan.endMs, forcedCut: plan.forcedCut, providerTraceId: found.providerTraceId, fileName: found.resultPath }); continue;
      }
      const chunkRec: TranscriptChunk = {
        chunkId: newChunkId(), callId: call.callId, revision, chunkIndex: plan.index,
        beginMs: plan.beginMs, endMs: plan.endMs, forcedCut: plan.forcedCut, status: 'in_progress',
        resultPath: null, resultSha256: null, providerTraceId: null, segmentCount: 0, attempts: 1,
        lastErrorJson: null, createdAt: now, updatedAt: now,
      } as TranscriptChunk;
      await this.d.repo.upsertChunk(chunkRec);
      try {
        const parts: AsrChunkResult[] = [];
        if (stereo) {
          for (const ch of [0, 1] as const) {
            const tmp = join(this.d.config.paths().tmpDir, `${call.callId}-chunk-${plan.index}-ch${ch}-${Date.now()}.wav`);
            try {
              await sliceChannelWav(info, plan, tmp, ch);
              const r = await asr.transcribeChunk({ audioPath: tmp, language: cfg.pipeline.asr.language, timeoutMs: cfg.pipeline.asr.timeoutMs });
              parts.push(r);
              for (const seg of r.segments) mergedRaw.push({ beginMs: plan.beginMs + seg.beginMs, endMs: plan.beginMs + seg.endMs, label: `CH${ch}`, text: seg.text.trim(), chunkIndex: plan.index, channel: ch });
            } finally { try { await unlink(tmp); } catch { /* ignore */ } }
          }
        } else {
          const tmp = join(this.d.config.paths().tmpDir, `${call.callId}-chunk-${plan.index}-${Date.now()}.wav`);
          try {
            await sliceWav(info, plan, tmp);
            const r = await asr.transcribeChunk({ audioPath: tmp, language: cfg.pipeline.asr.language, timeoutMs: cfg.pipeline.asr.timeoutMs });
            parts.push(r);
            for (const seg of r.segments) mergedRaw.push({ beginMs: plan.beginMs + seg.beginMs, endMs: plan.beginMs + seg.endMs, label: seg.speakerLabel || 'S1', text: seg.text.trim(), chunkIndex: plan.index, channel: null });
          } finally { try { await unlink(tmp); } catch { /* ignore */ } }
        }
        const combined: AsrChunkResult = {
          text: parts.map(p => p.text).join('\n'), durationMs: Math.max(...parts.map(p => p.durationMs), plan.endMs - plan.beginMs),
          nSpeakers: stereo ? 2 : Math.max(...parts.map(p => p.nSpeakers), 1),
          segments: parts.flatMap((p, idx) => p.segments.map(seg => ({ beginMs: seg.beginMs, endMs: seg.endMs, speakerLabel: stereo ? `CH${idx}` : (seg.speakerLabel || 'S1'), text: seg.text }))),
          traceId: parts.map(p => p.traceId).filter(Boolean).join(',') || null,
        };
        await mkdir(dirname(outAbs), { recursive: true, mode: 0o700 });
        await writeFileAtomic(outAbs, Buffer.from(JSON.stringify(combined), 'utf8'));
        const sha = createHash('sha256').update(JSON.stringify(combined)).digest('hex');
        await this.d.repo.upsertChunk({ ...chunkRec, status: 'ready', resultPath: outRel, resultSha256: sha, providerTraceId: combined.traceId ?? null, segmentCount: combined.segments.length, updatedAt: new Date().toISOString() } as TranscriptChunk);
        chunkResults.push(combined);
        asrMetaChunks.push({ index: plan.index, beginMs: plan.beginMs, endMs: plan.endMs, forcedCut: plan.forcedCut, providerTraceId: combined.traceId, fileName: outRel, stereo });
      } catch (e) {
        await this.d.repo.upsertChunk({ ...chunkRec, status: 'failed', lastErrorJson: JSON.stringify({ code: (e as any).code ?? 'ASR_FAILED', message: (e as Error).message }), updatedAt: new Date().toISOString() } as TranscriptChunk);
        throw e;
      }
    }
    // merge + role + normalize
    const merged = mergedRaw.sort((a, b) => a.beginMs - b.beginMs || a.endMs - b.endMs);
    merged.sort((a, b) => a.beginMs - b.beginMs);
    const roleMap = mapRoles(merged);
    const segments: TranscriptSegment[] = [];
    const termsApplied = new Map<string, { from: string; to: string; count: number }>();
    let fullTextRaw = '';
    for (let i = 0; i < merged.length; i++) {
      const m = merged[i];
      if (!m.text) continue;
      const norm = await this.d.terms.normalizeText(m.text);
      for (const a of norm.applied) { const k = `${a.from}=>${a.to}`; const prev = termsApplied.get(k); termsApplied.set(k, { from: a.from, to: a.to, count: (prev?.count ?? 0) + a.count }); }
      segments.push({
        segmentId: newSegmentId(), transcriptId: 'PENDING', callId: call.callId, idx: segments.length,
        beginMs: m.beginMs, endMs: m.endMs, speakerLabel: m.label, chunkIndex: m.chunkIndex, channel: m.channel ?? null,
        role: roleMap.roles[m.label] ?? 'unknown', rawText: m.text, normalizedText: norm.normalized,
        confidence: null, emotionValue: null, speechRate: null, silenceBeforeMs: null,
      } as TranscriptSegment);
      fullTextRaw += m.text + '\n';
    }
    const transcriptId = newTranscriptId();
    for (const s of segments) s.transcriptId = transcriptId;
    const asrMeta = {
      chunks: asrMetaChunks, roleMapping: { method: roleMap.method, confidence: roleMap.confidence, needsReview: roleMap.needsReview },
      termsApplied: [...termsApplied.values()], provider: `minimax:${cfg.pipeline.asr.model}`,
      audio: { durationMs: info.durationMs, sampleRate: info.sampleRate, channels: info.channels },
    };
    const fullText = segments.map(s => s.normalizedText).join('\n');
    const transcript: Transcript = {
      transcriptId, callId: call.callId, source: 'asr', provider: `minimax:${cfg.pipeline.asr.model}`,
      status: 'ready', isCurrent: true, revision, segmentCount: segments.length, chunkCount: plans.length,
      needsReview: roleMap.needsReview, language: cfg.pipeline.asr.language === 'zh' ? 'zh-CN' : cfg.pipeline.asr.language,
      fullText, fullTextRaw, durationMs: info.durationMs,
      speakerMappingJson: JSON.stringify({ method: roleMap.method, confidence: roleMap.confidence, needsReview: roleMap.needsReview }),
      asrMetaJson: JSON.stringify(asrMeta), lastErrorJson: null,
      createdAt: now, updatedAt: new Date().toISOString(),
    } as Transcript;
    await this.d.repo.createTranscript(transcript);
    await this.d.repo.markOtherTranscriptsNotCurrent(call.callId, transcriptId);
    await this.d.repo.replaceSegments(transcriptId, call.callId, segments);
    await this.d.repo.updateCall(call.callId, { transcriptStatus: 'ready', transcriptReadyAt: new Date().toISOString(), transcriptSource: 'asr', transcriptLastErrorCode: null, analysisStatus: 'pending', pipelineLastErrorJson: null, pipelineUpdatedAt: new Date().toISOString() } as any, null);
    await this.d.events.emit({ type: 'call.transcript.ready', callId: call.callId, accountId: call.accountId, data: { callId: call.callId, source: 'asr', segmentCount: segments.length, needsReview: roleMap.needsReview } });
    await this.d.jobs.enqueueIfAbsent('analysis', call.callId, { accountId: call.accountId, payload: { callId: call.callId }, maxAttempts: 5, priority: 70 });
    return transcript;
  }

  // ---------- analysis ----------
  async analyze(call: Call, job: Job, opts: { analysisModel?: string; force?: boolean } = {}): Promise<string | null> {
    const transcript = await this.d.repo.getCurrentTranscript(call.callId);
    if (!transcript || transcript.status !== 'ready') throw new AppError('TRANSCRIPT_NOT_AVAILABLE', '转写未就绪，无法进行 AI 后处理');
    const segments = await this.d.repo.listSegments(transcript.transcriptId);
    if (segments.length === 0) {
      await this.d.repo.updateCall(call.callId, { analysisStatus: 'skipped', pipelineUpdatedAt: new Date().toISOString() } as any, null);
      return null;
    }
    const cfg = this.d.config.get();
    const now = new Date().toISOString();
    await this.d.repo.updateCall(call.callId, { analysisStatus: 'in_progress', analysisRetryCount: (call.analysisRetryCount ?? 0) + 1, pipelineUpdatedAt: now } as any, null);
    const roleMeta = safeJson<{ method?: string; confidence?: number; needsReview?: boolean }>(transcript.speakerMappingJson) ?? {};
    const input = {
      callId: call.callId,
      meta: {
        direction: 'outbound' as const, durationSec: call.durationSec, toPhoneMasked: maskPhone(call.toPhone),
        fromPhoneMasked: call.fromPhone ? maskPhone(call.fromPhone) : null,
        customerName: maskName(call.customerName, cfg.pipeline.analysis.redactNames),
        lineName: call.lineName ?? null, startedAt: call.dialedAt ?? null,
        asrProvider: transcript.provider, speakerMappingMethod: roleMeta.method ?? 'asr_diarization', speakerConfidence: roleMeta.confidence ?? null,
      },
      segments: segments.map(s => ({ role: s.role, speakerLabel: s.speakerLabel ?? null, beginMs: s.beginMs, endMs: s.endMs, text: s.normalizedText })),
      maxInputChars: cfg.pipeline.analysis.maxInputChars,
    };
    const client = this.d.createAnalysis(opts.analysisModel);
    const out = await client.analyze(input);
    // 后归一 + 脱敏
    const normShort = await this.d.terms.normalizeText(out.summary.short);
    const normBullets = await Promise.all(out.summary.bullets.map(b => this.d.terms.normalizeText(b).then(r => r.normalized)));
    const normKeywords = await Promise.all(out.keywords.map(k => this.d.terms.normalizeText(k).then(r => r.normalized)));
    const asrMeta = safeJson<{ termsApplied?: { from: string; to: string; count: number }[] }>(transcript.asrMetaJson);
    const analysisId = newAnalysisId();
    const result = {
      ...out.raw,
      summary: { short: maskPhonesInText(normShort.normalized), bullets: normBullets.map(maskPhonesInText) },
      keywords: normKeywords.map(maskPhonesInText),
      intent: out.intent,
    };
    await this.d.repo.createAnalysis({
      analysisId, callId: call.callId, transcriptId: transcript.transcriptId, status: 'ready', isCurrent: true,
      provider: 'deepseek', model: out.model, promptVersion: out.promptVersion, schemaVersion: out.schemaVersion,
      paramsJson: JSON.stringify({ temperature: cfg.pipeline.analysis.temperature, maxTokens: cfg.pipeline.analysis.maxTokens }),
      termsVersion: asrMeta ? JSON.stringify(asrMeta.termsApplied ?? []) : null,
      summary: result.summary.short, summaryBulletsJson: JSON.stringify(result.summary.bullets),
      keywordsJson: JSON.stringify(result.keywords), intentLabel: out.intent.label, intentScore: out.intent.score ?? null,
      termsAppliedJson: JSON.stringify(asrMeta?.termsApplied ?? []),
      speakerMappingJson: JSON.stringify({ method: roleMeta.method ?? 'asr_diarization', confidence: roleMeta.confidence ?? null, needsReview: roleMeta.needsReview ?? false }),
      needsReview: out.intent.score != null && out.intent.score < 0.3,
      resultJson: JSON.stringify(result), qualityFlagsJson: JSON.stringify(out.riskFlags ?? []),
      usageJson: JSON.stringify(out.usage), generatedAt: new Date().toISOString(),
      createdAt: now, updatedAt: new Date().toISOString(),
    } as any);
    await this.d.repo.markOtherAnalysesNotCurrent(call.callId, analysisId);
    await this.d.repo.updateCall(call.callId, { analysisStatus: 'ready', analysisReadyAt: new Date().toISOString(), analysisLastErrorCode: null, pipelineLastErrorJson: null, pipelineUpdatedAt: new Date().toISOString() } as any, null);
    await this.d.events.emit({ type: 'call.analysis.ready', callId: call.callId, accountId: call.accountId, data: { callId: call.callId, analysisId } });
    return analysisId;
  }
}

// ---------- helpers ----------
function buildCandidates(rawUrl: string): string[] {
  const out: string[] = [];
  try {
    const u = new URL(rawUrl);
    if (u.protocol === 'http:' && (u.hostname === '112.192.20.62')) {
      out.push(`https://feige.duofangtongxin.com${u.pathname}`);
    }
    out.push(rawUrl);
  } catch { out.push(rawUrl); }
  return [...new Set(out)];
}
function dateDir(base: string, iso: string): string {
  const d = new Date(iso); const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
  return join(base, String(y), m, day);
}
function relativeToDataDir(dataDir: string, abs: string): string { return abs.startsWith(dataDir + '/') ? abs.slice(dataDir.length + 1) : abs; }
async function writeFileAtomic(abs: string, buf: Buffer): Promise<void> {
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, buf, { mode: 0o600 });
  await rename(tmp, abs);
}
export function mapRoles(merged: { label: string; text: string; beginMs: number }[]): { roles: Record<string, 'agent' | 'customer' | 'unknown'>; method: 'asr_diarization'; confidence: number; needsReview: boolean } {
  const labels = [...new Set(merged.map(m => m.label))];
  if (labels.length < 2) return { roles: labels.length === 1 ? { [labels[0]]: 'unknown' } : {}, method: 'asr_diarization', confidence: 0.2, needsReview: true };
  const score = new Map<string, number>();
  for (const l of labels) score.set(l, 0);
  const agentRe = /(我是|这边是|给您|请问|您好|孚盟|销售|经理|顾问|联系您|打扰|推荐|介绍|方案|合作)/g;
  const customerRe = /(不需要|多少钱|什么价|在用|已有|没兴趣|考虑|再说|嗯|你好|哪位)/g;
  merged.forEach((m, i) => {
    const a = (m.text.match(agentRe) ?? []).length; const c = (m.text.match(customerRe) ?? []).length;
    score.set(m.label, (score.get(m.label) ?? 0) + a * 2 - c + Math.min(4, m.text.length / 30) + (i < 2 ? 0.5 : 0));
  });
  const sorted = [...score.entries()].sort((a, b) => b[1] - a[1]);
  const roles: Record<string, 'agent' | 'customer' | 'unknown'> = {};
  roles[sorted[0][0]] = 'agent';
  for (const [l] of sorted.slice(1)) roles[l] = 'customer';
  const total = sorted.reduce((s, [, v]) => s + Math.max(0, v), 0) || 1;
  const confidence = Math.min(0.95, Math.max(0, (sorted[0][1] - (sorted[1]?.[1] ?? 0)) / total + 0.4));
  return { roles, method: 'asr_diarization', confidence, needsReview: confidence < 0.55 };
}
