import type { Repo, CallFilter } from '../db/repo.js';
import type { ConfigStore } from '../config.js';
import type { Call, CallDetail, CallSummary, CallAccepted, CallEvent, DryRunResult, EventRecord, TranscriptPayload, Job } from '../types/domain.js';
import type { CallStatus, Pagination } from '../types/common.js';
import type { EventBus } from './events.js';
import type { JobQueue } from './jobs.js';
import type { Logger } from '../logger.js';
import type { AccountService } from './accounts.js';
import type { SyncService } from './sync.js';
import type { TermService } from './terms.js';
import { createHash } from 'node:crypto';
import { AppError } from '../errors.js';
import { newAuditId, newCallId } from './ids.js';
import { dialWindow } from './time.js';
import { isValidPhone, normalizePhone, maskPhone } from '../util/phone.js';
import { safeJson } from './jobs.js';

export interface CallsSvcDeps {
  repo: Repo; config: ConfigStore; events: EventBus; jobs: JobQueue; log: Logger;
  accounts: AccountService; sync: SyncService; terms: TermService;
}
export interface CreateCallInput {
  to: string; accountId?: string | null; customerName?: string | null;
  metadata?: Record<string, string>; scheduledAt?: string | null; dryRun?: boolean;
}
export class CallsService {
  private tracking = new Set<string>();
  constructor(private d: CallsSvcDeps) {}

  async create(input: CreateCallInput, idempotencyKey?: string | null): Promise<CallAccepted | DryRunResult> {
    const to = normalizePhone(String(input.to ?? ''));
    if (!isValidPhone(to)) throw new AppError('VALIDATION_FAILED', '被叫号码格式不正确', { details: { fields: [{ field: 'to', reason: 'format' }] } });
    if (input.customerName && input.customerName.length > 64) throw new AppError('VALIDATION_FAILED', 'customerName 过长');
    if (input.metadata && Object.keys(input.metadata).length > 10) throw new AppError('VALIDATION_FAILED', 'metadata 最多 10 个键');
    // account selection
    let accountId = input.accountId ?? null;
    if (!accountId) {
      const enabled = (await this.d.repo.listAccounts({ enabled: true })).filter(a => !a.deletedAt);
      if (enabled.length === 1) accountId = enabled[0].accountId;
      else if (enabled.length === 0) throw new AppError('ACCOUNT_NOT_FOUND', '没有可用账号');
      else throw new AppError('VALIDATION_FAILED', '多账号时必须指定 accountId', { details: { reason: 'account_required' } });
    }
    const account = await this.d.repo.getAccount(accountId);
    if (!account || account.deletedAt) throw new AppError('ACCOUNT_NOT_FOUND', `账号不存在: ${accountId}`);
    if (!account.enabled) throw new AppError('ACCOUNT_DISABLED', `账号已停用: ${accountId}`);
    // dial window
    const dw = dialWindow(this.d.config.get());
    const cfg = this.d.config.get();
    if (!dw.open && !cfg.dial.scheduleOutsideWindow) throw new AppError('CALL_OUTSIDE_DIAL_WINDOW', '当前不在可拨号时段（07:50–22:00，Asia/Shanghai）', { retryAfter: dw.nextOpenAt ?? undefined });
    // idempotency
    if (idempotencyKey && !input.dryRun) {
      const idem = await this.d.repo.getIdempotency(idempotencyKey, 'calls.create');
      if (idem) {
        if (idem.status === 'in_progress') throw new AppError('IDEMPOTENCY_CONFLICT', '相同幂等键的请求正在处理中');
        const prev = safeJson<CallSummary>(idem.responseJson);
        if (prev) return { ...prev } as any;
      }
      const requestHash = createHash('sha256').update(JSON.stringify({ to, accountId })).digest('hex');
      await this.d.repo.createIdempotency({ key: idempotencyKey, scope: 'calls.create', requestHash, status: 'in_progress', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString() } as any);
    }
    // cooldown & busy
    const cooldownSince = new Date(Date.now() - cfg.limits.dialCooldownMs).toISOString();
    const recent = await this.d.repo.findRecentDial(accountId, to, cooldownSince);
    if (recent) throw new AppError('IDEMPOTENCY_CONFLICT', '该号码在冷却期内已呼出', { details: { recentCallId: recent.callId } });
    // 并发占用：dialing/connected 一定占用；pending 仅“已到点”的占用（时段外排队的未来任务不应阻塞新建呼出）
    const openList = await this.d.repo.listCalls({ page: 1, size: 50, statuses: ['pending', 'dialing', 'connected'], accountIds: [accountId] } as CallFilter);
    const blocking = openList.items.filter(c => c.status !== 'pending' || !c.scheduledAt || new Date(c.scheduledAt).getTime() <= Date.now());
    if (blocking.length > 0) throw new AppError('ACCOUNT_BUSY', '账号正在通话中', { details: { busyCallId: blocking[0].callId } });
    const token = await this.d.accounts.requireOnlineToken(accountId);
    const now = new Date();
    const scheduledAt = input.scheduledAt ?? (dw.open ? now.toISOString() : dw.nextOpenAt ?? now.toISOString());
    if (input.dryRun) {
      let warnings: string[] = [];
      try { const num = await this.d.accounts.client(accountId, token).getExistOther(to); if (num && num !== 0) warnings.push('number_exists_in_crm'); } catch { /* ignore */ }
      return { dryRun: true, willDial: true, accountId, to, dialWindow: dw, warnings } as DryRunResult;
    }
    const callId = newCallId();
    const call: Call = {
      callId, accountId, upstreamCallId: null, direction: 'outbound',
      toPhone: to, customerName: input.customerName ?? null,
      status: 'pending', statusReason: dw.open ? '等待调度' : '等待拨打时段',
      audioStatus: 'pending', transcriptStatus: 'pending', analysisStatus: 'pending',
      scheduledAt, dialState: 'none', version: 1,
      metadataJson: JSON.stringify(input.metadata ?? {}),
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    } as Call;
    await this.d.repo.insertCall(call);
    await this.d.events.emit({ type: 'call.created', accountId, callId, data: { callId, accountId, to, status: 'pending' } });
    await this.audit('call.create', 'call', callId, 'success');
    const summary = await this.toSummary(call);
    if (idempotencyKey) await this.d.repo.completeIdempotency(idempotencyKey, 'calls.create', JSON.stringify(summary));
    return summary;
  }

  async get(callId: string): Promise<Call> {
    const c = await this.d.repo.getCall(callId);
    if (!c) throw new AppError('CALL_NOT_FOUND', `话单不存在: ${callId}`);
    return c;
  }
  async cancel(callId: string): Promise<CallSummary> {
    const c = await this.get(callId);
    if (c.status !== 'pending') {
      if (['ended', 'no_answer', 'failed', 'canceled'].includes(c.status)) throw new AppError('CALL_ALREADY_TERMINAL', '话单已终态，不能取消');
      throw new AppError('CALL_NOT_CANCELABLE', '已提交上游，不能取消');
    }
    const updated = await this.d.repo.updateCall(callId, { status: 'canceled', canceledAt: new Date().toISOString(), statusReason: '用户取消', updatedAt: new Date().toISOString() }, null);
    await this.d.events.emit({ type: 'call.canceled', accountId: c.accountId, callId, data: { callId } });
    await this.audit('call.cancel', 'call', callId, 'success');
    return this.toSummary(updated as Call);
  }
  async list(q: Record<string, string | undefined>): Promise<{ items: CallSummary[]; pagination: Pagination }> {
    const page = Math.max(1, Number(q.page ?? 1));
    const size = Math.min(100, Math.max(1, Number(q.size ?? 20)));
    const filter: CallFilter = {
      page, size,
      accountIds: q.accountId ? q.accountId.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      statuses: q.status ? q.status.split(',').map(s => s.trim()) as CallStatus[] : undefined,
      hasAudio: q.hasAudio !== undefined ? q.hasAudio === 'true' : undefined,
      hasTranscript: q.hasTranscript !== undefined ? q.hasTranscript === 'true' : undefined,
      pipelineAudio: q['pipeline.audio'] ? [q['pipeline.audio'] as any] : undefined,
      pipelineTranscript: q['pipeline.transcript'] ? [q['pipeline.transcript'] as any] : undefined,
      pipelineAnalysis: q['pipeline.analysis'] ? [q['pipeline.analysis'] as any] : undefined,
      toPhoneLike: q.to ? q.to.replace(/^\*/, '') : undefined,
      q: q.q, dateFrom: q.dateFrom, dateTo: q.dateTo, sort: q.sort,
    } as CallFilter;
    const r = await this.d.repo.listCalls(filter);
    return { items: await Promise.all(r.items.map(c => this.toSummary(c))), pagination: { page, size, total: r.total, totalPages: Math.max(1, Math.ceil(r.total / size)) } };
  }
  async detail(callId: string, opts: { includeRaw?: boolean; includeEvents?: boolean; includeAnalysis?: boolean } = {}): Promise<CallDetail> {
    const c = await this.get(callId);
    return this.toDetail(c, opts);
  }
  async transcript(callId: string, opts: { includeAnalysis?: boolean } = {}): Promise<TranscriptPayload> {
    const c = await this.get(callId);
    if (c.transcriptStatus === 'pending' || c.transcriptStatus === 'in_progress') throw new AppError('TRANSCRIPT_PENDING', '转写处理中', { details: { stage: c.audioStatus === 'in_progress' ? 'asr_queued' : 'asr_running' } });
    const t = await this.d.repo.getCurrentTranscript(callId);
    if (!t || t.status !== 'ready') throw new AppError('TRANSCRIPT_NOT_AVAILABLE', '该话单无可用转写');
    const segs = await this.d.repo.listSegments(t.transcriptId);
    const analysis = opts.includeAnalysis ? await this.d.repo.getCurrentAnalysis(callId) : null;
    return {
      callId, transcriptId: t.transcriptId, source: 'asr', provider: t.provider, language: t.language,
      status: t.status, isCurrent: t.isCurrent, durationMs: t.durationMs ?? null, fullText: t.fullText ?? '',
      segments: segs.map(s => ({ segmentId: s.segmentId, index: s.idx, beginMs: s.beginMs, endMs: s.endMs, channel: s.channel ?? null, speakerLabel: s.speakerLabel ?? null, chunkIndex: s.chunkIndex ?? null, role: s.role, rawText: s.rawText, normalizedText: s.normalizedText, confidence: s.confidence ?? null, emotionValue: null, speechRate: null, silenceBeforeMs: null })),
      analysis: analysis ? { analysisId: analysis.analysisId, summary: analysis.summary ?? '', intent: analysis.intentLabel ?? null } : null,
      createdAt: t.createdAt, updatedAt: t.updatedAt,
    };
  }
  async audioInfo(callId: string): Promise<{ absPath: string; mime: string; sha256: string; sizeBytes: number; durationMs: number | null }> {
    const c = await this.get(callId);
    if (c.audioStatus === 'pending' || c.audioStatus === 'in_progress') throw new AppError('AUDIO_NOT_READY', '录音下载中');
    const a = await this.d.repo.getAudioByCall(callId);
    if (!a) throw new AppError('AUDIO_NOT_AVAILABLE', '该话单无录音');
    const { join } = await import('node:path');
    return { absPath: join(this.d.config.paths().dataDir, a.storagePath), mime: 'audio/wav', sha256: a.sha256, sizeBytes: a.sizeBytes, durationMs: a.durationMs ?? null };
  }
  async reprocess(callId: string, input: { stages: string[]; force?: boolean; options?: { asrModel?: string; analysisModel?: string; promptVersion?: string; termRulesVersion?: string } }): Promise<Job> {
    const c = await this.get(callId);
    if (!input.stages || input.stages.length === 0) throw new AppError('VALIDATION_FAILED', 'stages 不能为空');
    for (const s of input.stages) if (!['audio', 'transcript', 'analysis'].includes(s)) throw new AppError('VALIDATION_FAILED', `非法 stage: ${s}`);
    return this.d.jobs.enqueue('reprocess', { callId, accountId: c.accountId, payload: { callId, stages: input.stages, force: !!input.force, options: input.options ?? {} }, maxAttempts: 3 });
  }
  async callEvents(callId: string, q: { types?: string; page?: number; size?: number }): Promise<{ items: EventRecord[]; pagination: Pagination }> {
    await this.get(callId);
    const page = Math.max(1, q.page ?? 1); const size = Math.min(200, Math.max(1, q.size ?? 50));
    const types = q.types ? q.types.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const events = await this.d.repo.listCallEvents(callId, types);
    const total = events.length; const slice = events.slice((page - 1) * size, page * size);
    return { items: slice.map(e => ({ eventId: e.eventId, type: e.type, occurredAt: e.occurredAt, accountId: e.accountId, callId: e.callId, data: safeJson(e.dataJson) ?? {} })), pagination: { page, size, total, totalPages: Math.max(1, Math.ceil(total / size)) } };
  }

  async toSummary(c: Call): Promise<CallSummary> {
    const up = safeJson<{ callStatus?: number; callStatusName?: string; finishStatus?: number; finishStatusName?: string }>(c.upstreamStatusJson);
    let preview: string | null = null;
    if (c.transcriptStatus === 'ready') {
      const t = await this.d.repo.getCurrentTranscript(c.callId);
      if (t?.fullText) preview = t.fullText.slice(0, 80);
    }
    return {
      callId: c.callId, accountId: c.accountId, upstreamCallId: c.upstreamCallId ?? null, direction: 'outbound',
      to: { phone: maskPhone(c.toPhone), location: c.toLocation ?? null },
      from: { phone: maskPhone(c.fromPhone), location: c.fromLocation ?? null },
      lineNumber: c.lineNumber ? maskPhone(c.lineNumber) : null, customerName: c.customerName ?? null,
      lineId: c.lineId ?? null, lineName: c.lineName ?? null,
      status: c.status, statusReason: c.statusReason ?? null,
      dialedAt: c.dialedAt ?? null, answeredAt: c.answeredAt ?? null, endedAt: c.endedAt ?? null,
      durationSec: c.durationSec ?? null, cost: c.cost ?? null,
      upstreamStatus: up ?? null,
      pipeline: { audio: c.audioStatus, transcript: c.transcriptStatus, analysis: c.analysisStatus, lastError: safeJson(c.pipelineLastErrorJson) },
      transcriptPreview: preview, audioAvailable: c.audioStatus === 'ready',
      createdAt: c.createdAt, updatedAt: c.updatedAt,
    };
  }
  async toDetail(c: Call, opts: { includeRaw?: boolean; includeEvents?: boolean; includeAnalysis?: boolean } = {}): Promise<CallDetail> {
    const summary = await this.toSummary(c);
    const audio = await this.d.repo.getAudioByCall(c.callId);
    const t = await this.d.repo.getCurrentTranscript(c.callId);
    const segCount = t ? await this.d.repo.countSegments(t.transcriptId) : 0;
    const a = await this.d.repo.getCurrentAnalysis(c.callId);
    const up = safeJson<Record<string, unknown>>(c.upstreamStatusJson) ?? {};
    const raw = opts.includeRaw ? safeJson<Record<string, unknown>>(c.upstreamRawJson) ?? null : undefined;
    const detail: CallDetail = {
      ...summary,
      upstream: { ...up, telA: c.fromPhone ? maskPhone(c.fromPhone) : null, telB: maskPhone(c.toPhone), ...(raw ? { raw } : {}) },
      timeline: { createdAt: c.createdAt, submittedAt: c.submittedAt ?? null, dialingAt: c.dialedAt ?? c.submittedAt ?? null, connectedAt: c.answeredAt ?? null, endedAt: c.endedAt ?? null },
      pipelineDetail: {
        audio: { status: c.audioStatus, audioId: audio?.audioId ?? null, downloadedAt: audio?.downloadedAt ?? null, lastError: null },
        transcript: { status: c.transcriptStatus, transcriptId: t?.transcriptId ?? null, source: t ? 'asr' : null, provider: t?.provider ?? null, chunkCount: t?.chunkCount ?? null, needsReview: t?.needsReview ?? null, generatedAt: t?.updatedAt ?? null, lastError: null },
        analysis: { status: c.analysisStatus, analysisId: a?.analysisId ?? null, generatedAt: a?.generatedAt ?? null, lastError: null },
      },
      recording: { available: !!audio, downloadUrl: audio ? `/api/v1/calls/${c.callId}/audio` : null, format: audio ? 'wav' : undefined, durationMs: audio?.durationMs ?? null, sizeBytes: audio?.sizeBytes ?? null, sha256: audio?.sha256 ?? null, sampleRate: audio?.sampleRate ?? null, channels: audio?.channels ?? null },
      transcript: { available: !!t && t.status === 'ready', source: t ? 'asr' : undefined, segmentCount: segCount, needsReview: t?.needsReview ?? null, url: t ? `/api/v1/calls/${c.callId}/transcript` : null },
      analysis: { available: !!a, analysisId: a?.analysisId ?? null, summary: a?.summary ?? null, intent: a?.intentLabel ?? null, url: a ? `/api/v1/calls/${c.callId}/transcript?includeAnalysis=true` : null },
      eventsCount: (await this.d.repo.listCallEvents(c.callId)).length,
      metadata: safeJson<Record<string, string>>(c.metadataJson) ?? null,
      events: null, analysisPayload: null,
    };
    if (opts.includeEvents) detail.events = (await this.d.repo.listCallEvents(c.callId)).slice(-50).map(e => ({ eventId: e.eventId, type: e.type, occurredAt: e.occurredAt, accountId: e.accountId, callId: e.callId, data: safeJson(e.dataJson) ?? {} }));
    if (opts.includeAnalysis && a) detail.analysisPayload = toAnalysisPayload(a);
    return detail;
  }

  // ---------- scheduler ticks ----------
  async tick(): Promise<void> {
    await this.dispatchPending();
    await this.trackDialing();
  }
  private async dispatchPending(): Promise<void> {
    const dw = dialWindow(this.d.config.get());
    const pending = await this.d.repo.listCalls({ page: 1, size: 50, statuses: ['pending'] } as CallFilter);
    for (const c of pending.items) {
      if (!dw.open) break;
      if (c.scheduledAt && new Date(c.scheduledAt).getTime() > Date.now()) continue;
      if (this.d.accounts.isBusy(c.accountId)) continue;
      try { await this.dispatch(c); } catch (e) { this.d.log.warn('dispatch failed', { callId: c.callId, err: (e as Error).message }); }
    }
  }
  private async dispatch(c: Call): Promise<void> {
    const account = await this.d.repo.getAccount(c.accountId);
    if (!account || !account.enabled) { await this.fail(c, 'ACCOUNT_DISABLED', '账号不可用'); return; }
    const token = await this.d.accounts.requireOnlineToken(c.accountId).catch((e) => { throw e; });
    const line = await this.d.accounts.getLine(c.accountId);
    const interfaceId = line?.mode ?? Number(account.lineMode ?? 1);
    const client = this.d.accounts.client(c.accountId, token);
    // 号码查重（不阻断，仅 warning）
    try { await client.getExistOther(c.toPhone); } catch { /* ignore */ }
    await this.d.repo.updateCall(c.callId, { dialState: 'sending', statusReason: '提交上游中', updatedAt: new Date().toISOString() }, null);
    const submittedAt = new Date();
    try {
      await client.dialCall({ telB: c.toPhone, interfaceId });
    } catch (e) {
      const err = e as Error & { code?: string; retryAfter?: string };
      if (err.code === 'CALL_OUTSIDE_DIAL_WINDOW' && this.d.config.get().dial.scheduleOutsideWindow) {
        const dw = dialWindow(this.d.config.get());
        // 线路级时段限制可能比全局窗口更严（retryAfter 未知）→ 10 分钟后重试，避免抢占/空转
        const retryAt = (err as { retryAfter?: string }).retryAfter ?? dw.nextOpenAt ?? new Date(Date.now() + 10 * 60 * 1000).toISOString();
        await this.d.repo.updateCall(c.callId, { status: 'pending', scheduledAt: retryAt, statusReason: '等待拨打时段（线路级限制）', dialState: 'none' }, null);
        return;
      }
      await this.fail(c, err.code ?? 'CALL_REJECTED_BY_UPSTREAM', err.message);
      return;
    }
    const updated = await this.d.repo.updateCall(c.callId, { status: 'dialing', dialState: 'sent', submittedAt: submittedAt.toISOString(), dialedAt: submittedAt.toISOString(), statusReason: '已提交上游，等待坐席接听', updatedAt: new Date().toISOString() }, null);
    this.d.accounts.markBusy(c.accountId, c.callId);
    await this.d.events.emit({ type: 'call.dialing', accountId: c.accountId, callId: c.callId, data: { callId: c.callId, submittedAt: submittedAt.toISOString() } });
    await this.audit('call.dial', 'call', c.callId, 'success');
    void updated;
  }
  private async fail(c: Call, code: string, message: string): Promise<void> {
    await this.d.repo.updateCall(c.callId, { status: 'failed', failedReason: message, errorCode: code, statusReason: message, dialState: 'failed', updatedAt: new Date().toISOString() } as any, null);
    await this.d.events.emit({ type: 'call.failed', accountId: c.accountId, callId: c.callId, data: { callId: c.callId, errorCode: code, errorMessage: message } });
  }
  private async trackDialing(): Promise<void> {
    const dialing = await this.d.repo.listCalls({ page: 1, size: 50, statuses: ['dialing'] } as CallFilter);
    const now = Date.now();
    for (const c of dialing.items) {
      const submitted = c.submittedAt ? new Date(c.submittedAt).getTime() : now;
      if (now - submitted > 120000) {
        this.d.accounts.markBusy(c.accountId, null);
        await this.d.repo.updateCall(c.callId, { status: 'failed', failedReason: '跟踪超时，未在上游查到话单（需人工核对）', errorCode: 'CALL_TRACKING_TIMEOUT', updatedAt: new Date().toISOString() } as any, null);
        await this.d.events.emit({ type: 'call.failed', accountId: c.accountId, callId: c.callId, data: { callId: c.callId, errorCode: 'CALL_TRACKING_TIMEOUT' } });
        continue;
      }
      if (this.tracking.has(c.callId)) continue;
      this.tracking.add(c.callId);
      try {
        const token = await this.d.accounts.requireOnlineToken(c.accountId).catch(() => null);
        if (!token) continue;
        const client = this.d.accounts.client(c.accountId, token);
        const today = new Date().toISOString().slice(0, 10);
        const pageRes = await client.getCallPage({ page: 1, limit: 20, startTimeBegin: today, startTimeFinish: today, callType: '', userIds: [] });
        const match = pageRes.list.find(r => {
          const telB = r.telB ?? r.phone ?? '';
          const ts = r.startTime ?? r.createTime ?? 0;
          return telB === c.toPhone && ts >= submitted - 300000;
        });
        if (match) {
          await this.d.sync.applyRecord(c.accountId, match);
          this.d.accounts.markBusy(c.accountId, null);
        }
      } catch (e) { this.d.log.debug('dialing track failed', { callId: c.callId, err: (e as Error).message }); }
      finally { this.tracking.delete(c.callId); }
    }
    // 清理已结束话单的 busy 标记
    const connected = await this.d.repo.listCalls({ page: 1, size: 20, statuses: ['ended', 'no_answer', 'failed', 'canceled'] } as CallFilter);
    for (const c of connected.items) this.d.accounts.markBusy(c.accountId, null);
  }
  private async audit(action: string, targetType: string, targetId: string, result: 'success' | 'failed') {
    try { await this.d.repo.insertAudit({ auditId: newAuditId(), actor: 'local-api', action, targetType, targetId, result, at: new Date().toISOString() } as any); } catch { /* ignore */ }
  }
}

export function toAnalysisPayload(a: import('../types/domain.js').AnalysisResult): import('../types/domain.js').AnalysisPayload {
  const bullets = safeJson<string[]>(a.summaryBulletsJson) ?? [];
  const keywords = safeJson<string[]>(a.keywordsJson) ?? [];
  const terms = safeJson<{ from: string; to: string; count: number }[]>(a.termsAppliedJson) ?? [];
  const result = safeJson<Record<string, any>>(a.resultJson) ?? {};
  return {
    analysisId: a.analysisId, callId: a.callId, status: a.status, model: a.model ?? null, promptVersion: a.promptVersion ?? null,
    summary: a.summary ? { short: a.summary, bullets } : null,
    intent: a.intentLabel ? { label: a.intentLabel, score: a.intentScore ?? null } : null,
    keywords, customerProfile: result.customer_profile ?? null,
    actionItems: result.action_items ?? [], riskFlags: result.risk_flags ?? [],
    quality: result.quality ? { complianceIssues: result.quality.compliance_issues ?? [], coachingPoints: result.quality.coaching_points ?? [] } : null,
    termsApplied: terms,
    speakerMapping: safeJson(a.speakerMappingJson) ?? null,
    usage: safeJson(a.usageJson) ?? null,
    generatedAt: a.generatedAt ?? null,
  };
}
