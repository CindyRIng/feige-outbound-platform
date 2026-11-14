import type { Repo } from '../db/repo.js';
import type { ConfigStore } from '../config.js';
import type { Call, Job } from '../types/domain.js';
import type { CallStatus, IsoDateTime } from '../types/common.js';
import type { EventBus } from './events.js';
import type { JobQueue, JobContext } from './jobs.js';
import type { Logger } from '../logger.js';
import type { UpstreamClient, UpstreamCallRecord, UpstreamCallPageResult } from '../upstream/types.js';
import type { AccountService } from './accounts.js';
import { newCallId } from './ids.js';
import { AppError } from '../errors.js';
import { safeJson } from './jobs.js';

export interface SyncSvcDeps {
  repo: Repo; config: ConfigStore; events: EventBus; jobs: JobQueue; log: Logger;
  accounts: AccountService;
  createUpstream: (baseUrl: string, token?: string | null) => UpstreamClient;
  upstreamBaseUrl: string;
}
export interface SyncRunResult { fetched: number; upserted: number; skipped: number; failed: number; accounts: number; }

export class SyncService {
  constructor(private d: SyncSvcDeps) {}
  async start(mode: 'incremental' | 'full' | 'backfill', opts: { accountId?: string; from?: string; to?: string; wait?: boolean; timeoutMs?: number } = {}): Promise<Job> {
    const targets = opts.accountId ? [opts.accountId] : (await this.d.repo.listAccounts({ enabled: true })).map(a => a.accountId);
    if (targets.length === 0) throw new AppError('VALIDATION_FAILED', '没有可用账号');
    const job = await this.d.jobs.enqueue('sync', { accountId: opts.accountId ?? null, payload: { mode, accountIds: targets, from: opts.from ?? null, to: opts.to ?? null }, maxAttempts: 3 });
    if (opts.wait) {
      const deadline = Date.now() + (opts.timeoutMs ?? 30000);
      while (Date.now() < deadline) {
        const j = await this.d.repo.getJob(job.jobId);
        if (j && ['succeeded', 'failed', 'canceled'].includes(j.status)) return j;
        await new Promise(r => setTimeout(r, 300));
      }
    }
    return job;
  }
  async runSyncJob(job: Job): Promise<Record<string, unknown>> {
    const payload = safeJson<{ mode: 'incremental' | 'full' | 'backfill'; accountIds: string[]; from?: string | null; to?: string | null }>(job.payloadJson) ?? { mode: 'incremental', accountIds: job.accountId ? [job.accountId] : [] };
    const result: SyncRunResult = { fetched: 0, upserted: 0, skipped: 0, failed: 0, accounts: 0 };
    await this.d.events.emit({ type: 'sync.started', jobId: job.jobId, accountId: job.accountId, data: { mode: payload.mode, jobId: job.jobId } });
    for (const accountId of payload.accountIds) {
      try {
        const r = await this.syncAccount(accountId, payload.mode, job.jobId, payload.from ?? undefined, payload.to ?? undefined);
        result.fetched += r.fetched; result.upserted += r.upserted; result.skipped += r.skipped; result.failed += r.failed; result.accounts++;
        await this.d.events.emit({ type: 'sync.progress', jobId: job.jobId, accountId, data: { jobId: job.jobId, fetched: result.fetched, upserted: result.upserted } });
      } catch (e) {
        result.failed++;
        this.d.log.warn('sync account failed', { accountId, err: (e as Error).message });
      }
    }
    await this.d.events.emit({ type: 'sync.completed', jobId: job.jobId, accountId: job.accountId, data: { jobId: job.jobId, ...result } });
    return { ...result };
  }
  async syncAccount(accountId: string, mode: 'incremental' | 'full' | 'backfill', jobId: string, from?: string, to?: string): Promise<Omit<SyncRunResult, 'accounts'>> {
    const token = await this.d.accounts.requireOnlineToken(accountId);
    const client = this.d.createUpstream(this.d.upstreamBaseUrl, token);
    const cfg = this.d.config.get();
    const pageSize = Math.min(100, cfg.sync.pageSize);
    const dateStr = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date();
    let startDate: string;
    if (mode === 'incremental') {
      const cursor = await this.d.repo.getCursor(accountId);
      const lookback = new Date(Date.now() - cfg.sync.lookbackDays * 86400000);
      startDate = cursor?.lastStartTime ?? dateStr(lookback);
    } else {
      startDate = from ?? dateStr(new Date(today.getTime() - 365 * 86400000));
    }
    const endDate = to ?? dateStr(today);
    let fetched = 0, upserted = 0, skipped = 0, failed = 0;
    const maxPages = mode === 'incremental' ? 50 : 10000;
    for (let page = 1; page <= maxPages; page++) {
      const res: UpstreamCallPageResult = await client.getCallPage({
        page, limit: pageSize, startTimeBegin: startDate, startTimeFinish: endDate, callType: '', userIds: [],
      });
      fetched += res.list.length;
      for (const rec of res.list) {
        try {
          const changed = await this.applyRecord(accountId, rec);
          if (changed) upserted++; else skipped++;
        } catch (e) {
          failed++;
          this.d.log.warn('upsert call failed', { accountId, upstreamCallId: rec.id, err: (e as Error).message });
        }
      }
      if (res.list.length < pageSize || fetched >= res.total) break;
    }
    if (mode !== 'incremental') await this.kickPipeline();
    const cursor = await this.d.repo.getCursor(accountId);
    const now = new Date().toISOString();
    const nextStart = mode === 'incremental' ? dateStr(new Date(Date.now() - 86400000)) : startDate;
    await this.d.repo.upsertCursor({
      accountId, lastStartTime: nextStart, lastUpstreamCallId: null, lastSyncedAt: now, updatedAt: now,
      mode, lastJobId: jobId, lastSuccessAt: now, lastErrorCode: null, lastStartedAt: cursor?.lastStartedAt ?? now,
      fetchedTotal: (cursor?.fetchedTotal ?? 0) + fetched, upsertedTotal: (cursor?.upsertedTotal ?? 0) + upserted,
      consecutiveFailures: 0, lastCreateTimeMs: cursor?.lastCreateTimeMs ?? null,
    } as any);
    return { fetched, upserted, skipped, failed };
  }
  /** full/backfill：为已存在的话单补齐流水线作业（去重） */
  async kickPipeline(limit = 500): Promise<void> {
    const audioPending = await this.d.repo.listCallsByStage('audio', limit);
    for (const c of audioPending) {
      const raw = safeJson<{ preRecordUrl?: string | null }>(c.upstreamRawJson);
      if (!raw?.preRecordUrl) continue;
      await this.d.jobs.enqueueIfAbsent('audio_fetch', c.callId, { accountId: c.accountId, payload: { callId: c.callId }, maxAttempts: 5, priority: 50 });
    }
    const transcriptPending = await this.d.repo.listCallsByStage('transcript', limit);
    for (const c of transcriptPending) {
      if (c.audioStatus !== 'ready') continue;
      await this.d.jobs.enqueueIfAbsent('asr', c.callId, { accountId: c.accountId, payload: { callId: c.callId }, maxAttempts: 5, priority: 60 });
    }
    const analysisPending = await this.d.repo.listCallsByStage('analysis', limit);
    for (const c of analysisPending) {
      if (c.transcriptStatus !== 'ready') continue;
      await this.d.jobs.enqueueIfAbsent('analysis', c.callId, { accountId: c.accountId, payload: { callId: c.callId }, maxAttempts: 5, priority: 70 });
    }
  }
  async applyRecord(accountId: string, rec: UpstreamCallRecord): Promise<boolean> {
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const startMs = rec.startTime ?? rec.createTime ?? null;
    const endMs = rec.endTime ?? null;
    const mappedStatus = deriveStatus(rec);
    const isEnded = mappedStatus === 'ended' || (!endMs && mappedStatus === 'no_answer');
    let call = await this.d.repo.getCallByUpstream(accountId, rec.id);
    if (!call) {
      // 可能是本地呼出正在 dialing 的记录：按被叫号码 + 时间窗口绑定
      const to = rec.telB ?? rec.phone ?? '';
      const recent = await this.d.repo.findRecentDial(accountId, to, new Date(nowMs - 30 * 60000).toISOString());
      if (recent && !recent.upstreamCallId) {
        call = recent;
      }
    }
    const upstreamFields = {
      upstreamCallId: rec.id,
      upstreamUserId: rec.userId ?? null,
      fromPhone: rec.telA ?? null,
      toPhone: rec.telB ?? rec.phone ?? '',
      toLocation: rec.calleeAttr ?? null,
      fromLocation: rec.callerAttr ?? null,
      lineNumber: rec.telX ?? null,
      lineId: rec.interfaceId != null ? String(rec.interfaceId) : null,
      lineName: rec.lineName ?? rec.interfaceName ?? null,
      callType: rec.callType ?? null,
      callStatus: rec.callStatus ?? null,
      callStatusName: rec.callStatusName ?? null,
      finishStatus: rec.finishStatus ?? null,
      finishStatusName: rec.finishStatusName ?? null,
      handleStatus: rec.handle ?? null,
      durationSec: rec.duration ?? null,
      cost: rec.postage ?? null,
      upstreamError: rec.sipCodeResult ?? null,
      upstreamCreateTimeMs: rec.createTime ?? null,
      upstreamStartTimeMs: rec.startTime ?? null,
      upstreamEndTimeMs: rec.endTime ?? null,
      upstreamUpdateTimeMs: rec.updateTime ?? null,
      lastSyncedAt: now,
      updatedAt: now,
    } as Partial<Call>;
    const upstreamStatusJson = JSON.stringify({ callStatus: rec.callStatus, callStatusName: rec.callStatusName, finishStatus: rec.finishStatus, finishStatusName: rec.finishStatusName });
    let changed = false;
    if (!call) {
      const callId = newCallId();
      const status: CallStatus = mappedStatus;
      const c: Call = {
        callId, accountId, upstreamCallId: rec.id, direction: 'outbound',
        toPhone: rec.telB ?? rec.phone ?? '', customerName: null,
        status, statusReason: null,
        dialedAt: startMs ? new Date(startMs).toISOString() : null,
        answeredAt: mappedStatus === 'ended' || mappedStatus === 'connected' ? (startMs ? new Date(startMs).toISOString() : null) : null,
        endedAt: endMs ? new Date(endMs).toISOString() : null,
        audioStatus: rec.preRecordUrl ? 'pending' : 'missing',
        transcriptStatus: rec.preRecordUrl ? 'pending' : 'missing',
        analysisStatus: rec.preRecordUrl ? 'pending' : 'skipped',
        origin: 'sync', dialState: 'none', version: 1,
        createdAt: rec.createTime ? new Date(rec.createTime).toISOString() : now,
        ...upstreamFields,
      } as Call;
      c.upstreamStatusJson = upstreamStatusJson;
      c.upstreamRawJson = JSON.stringify(rec);
      await this.d.repo.insertCall(c);
      call = c;
      await this.d.events.emit({ type: 'call.created', accountId, callId, data: { callId, accountId, to: c.toPhone, status: c.status, origin: 'sync' } });
      if (c.status === 'ended') await this.d.events.emit({ type: 'call.ended', accountId, callId, data: { callId, durationSec: c.durationSec } });
      if (c.status === 'no_answer') await this.d.events.emit({ type: 'call.no_answer', accountId, callId, data: { callId } });
      changed = true;
    } else {
      const patch: Partial<Call> = { ...upstreamFields, upstreamStatusJson, upstreamRawJson: JSON.stringify(rec) };
      if (mappedStatus !== call.status && !['canceled', 'failed'].includes(call.status)) {
        patch.status = mappedStatus;
        if (mappedStatus === 'connected' && !call.answeredAt) patch.answeredAt = startMs ? new Date(startMs).toISOString() : now;
        if (mappedStatus === 'ended') { patch.answeredAt = call.answeredAt ?? (startMs ? new Date(startMs).toISOString() : now); patch.endedAt = endMs ? new Date(endMs).toISOString() : now; }
        if (mappedStatus === 'no_answer') patch.endedAt = endMs ? new Date(endMs).toISOString() : now;
        changed = true;
      }
      if (isEnded) {
        if (!rec.preRecordUrl) {
          if (['pending', 'in_progress'].includes(call.audioStatus)) { patch.audioStatus = 'missing'; patch.transcriptStatus = 'missing'; patch.analysisStatus = 'skipped'; changed = true; }
        } else if (['pending', 'missing', 'failed'].includes(call.audioStatus)) {
          // 录音可能在上游延迟生成（实测：通话结束后 preRecordUrl 稍后才出现）→ 允许 missing/failed 回补为 pending
          patch.audioStatus = 'pending';
          if (call.transcriptStatus !== 'ready') patch.transcriptStatus = 'pending';
          if (call.analysisStatus !== 'ready') patch.analysisStatus = 'pending';
          changed = true;
        }
      }
      const updated = await this.d.repo.updateCall(call.callId, patch, call.version);
      const c2 = updated ?? { ...call, ...patch } as Call;
      if (patch.status === 'ended') await this.d.events.emit({ type: 'call.ended', accountId, callId: c2.callId, data: { callId: c2.callId, durationSec: c2.durationSec } });
      if (patch.status === 'no_answer') await this.d.events.emit({ type: 'call.no_answer', accountId, callId: c2.callId, data: { callId: c2.callId } });
    }
    if (changed) { const cid = (call as Call).callId; const cur = await this.d.repo.getCall(cid); if (cur) await this.enqueuePipelineForCall(cur.callId); }
    return changed;
  }
  async enqueuePipelineForCall(callId: string): Promise<void> {
    const call = await this.d.repo.getCall(callId);
    if (!call) return;
    if (call.audioStatus === 'pending' && call.upstreamStatusJson) {
      const up = safeJson<{ callStatus?: number | null }>(call.upstreamStatusJson);
      if (up?.callStatus === 1) await this.d.jobs.enqueueIfAbsent('audio_fetch', callId, { accountId: call.accountId, payload: { callId }, maxAttempts: 5, priority: 50 });
    }
  }
  isDialingLike(c: Call): boolean { return ['pending', 'dialing', 'connected'].includes(c.status); }
}
function deriveStatus(rec: UpstreamCallRecord): CallStatus {
  if (rec.callStatus === 1) return rec.endTime ? 'ended' : 'connected';
  if (rec.callStatus === 2) return 'no_answer';
  if (rec.callStatus === 0) return 'no_answer';
  // callStatus 缺失（历史数据/上游异常）：按录音与时长推断
  if (rec.preRecordUrl) return rec.endTime ? 'ended' : 'connected';
  if ((rec.duration ?? 0) > 0) return rec.endTime ? 'ended' : 'connected';
  return 'no_answer';
}
