import type { Repo } from '../db/repo.js';
import type { Job, JobSummary } from '../types/domain.js';
import type { JobType, JobStatus, IsoDateTime } from '../types/common.js';
import { newJobId } from './ids.js';
import type { Logger } from '../logger.js';
import type { EventBus } from './events.js';

export interface JobContext {
  job: Job;
  updateProgress: (progress: Record<string, unknown>) => Promise<void>;
  log: Logger;
}
export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | void>;

export interface EnqueueOptions {
  priority?: number; scheduledAt?: IsoDateTime; maxAttempts?: number;
  accountId?: string | null; callId?: string | null; payload?: Record<string, unknown>;
}

export class JobQueue {
  private handlers = new Map<JobType, JobHandler>();
  private running = new Set<string>();
  private stopping = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private runningByType = new Map<JobType, number>();
  constructor(private repo: Repo, private events: EventBus, private log: Logger, private opts: { leaseMs: number; pollMs: number; concurrency: number; typeLimits?: Partial<Record<JobType, number>>; backoffBaseMs?: Partial<Record<JobType, number>> }) {}
  private typeLimit(t: JobType): number { return this.opts.typeLimits?.[t] ?? this.opts.concurrency; }
  register(type: JobType, handler: JobHandler): void { this.handlers.set(type, handler); }
  get registeredTypes(): JobType[] { return [...this.handlers.keys()]; }
  async enqueue(type: JobType, o: EnqueueOptions = {}): Promise<Job> {
    const now = new Date().toISOString();
    const job: Job = {
      jobId: newJobId(), type, status: 'queued', priority: o.priority ?? 100,
      accountId: o.accountId ?? null, callId: o.callId ?? null,
      payloadJson: JSON.stringify(o.payload ?? {}), resultJson: null, progressJson: null,
      attempts: 0, maxAttempts: o.maxAttempts ?? 5,
      scheduledAt: o.scheduledAt ?? now, startedAt: null, finishedAt: null, leaseUntil: null, lastErrorJson: null,
      createdAt: now, updatedAt: now,
    };
    await this.repo.insertJob(job);
    await this.events.emit({ type: 'job.updated', accountId: job.accountId, callId: job.callId, jobId: job.jobId, data: { status: 'queued', type } });
    return job;
  }
  async enqueueIfAbsent(type: JobType, callId: string, o: EnqueueOptions = {}): Promise<Job | null> {
    const active = await this.repo.listJobs({ page: 1, size: 20, types: [type], statuses: ['queued', 'running'], callId });
    if (active.total > 0) return null;
    return this.enqueue(type, { ...o, callId });
  }
  start(): void {
    this.stopping = false;
    const tick = async () => {
      if (this.stopping) return;
      try { await this.drain(); } catch (e) { this.log.error('job queue tick failed', { err: (e as Error).message }); }
      if (!this.stopping) this.loopTimer = setTimeout(tick, this.opts.pollMs);
    };
    this.loopTimer = setTimeout(tick, 250);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    // 等待运行中作业（最多 10s）
    const deadline = Date.now() + 10000;
    while (this.running.size > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
  }
  private async drain(): Promise<void> {
    if (this.running.size >= this.opts.concurrency) return;
    const types = [...this.handlers.keys()];
    if (types.length === 0) return;
    let progressed = true;
    while (!this.stopping && this.running.size < this.opts.concurrency && progressed) {
      progressed = false;
      for (const t of types) {
        if (this.stopping || this.running.size >= this.opts.concurrency) break;
        if ((this.runningByType.get(t) ?? 0) >= this.typeLimit(t)) continue;
        const now = new Date().toISOString();
        const leaseUntil = new Date(Date.now() + this.opts.leaseMs).toISOString();
        const job = await this.repo.claimJob([t], now, leaseUntil);
        if (!job) continue;
        progressed = true;
        this.running.add(job.jobId);
        this.runningByType.set(job.type, (this.runningByType.get(job.type) ?? 0) + 1);
        void this.run(job).finally(() => {
          this.running.delete(job.jobId);
          const n = (this.runningByType.get(job.type) ?? 1) - 1;
          if (n <= 0) this.runningByType.delete(job.type); else this.runningByType.set(job.type, n);
        });
      }
    }
  }
  private async run(job: Job): Promise<void> {
    const startedAt = new Date().toISOString();
    await this.repo.updateJob(job.jobId, { status: 'running', startedAt, attempts: job.attempts + 1 });
    await this.events.emit({ type: 'job.updated', accountId: job.accountId, callId: job.callId, jobId: job.jobId, data: { status: 'running', type: job.type, attempt: job.attempts + 1 } });
    const ctx: JobContext = {
      job: { ...job, status: 'running', startedAt, attempts: job.attempts + 1 },
      updateProgress: async (p) => { await this.repo.updateJob(job.jobId, { progressJson: JSON.stringify(p) }); },
      log: this.log.child({ jobId: job.jobId, jobType: job.type }),
    };
    try {
      const handler = this.handlers.get(job.type);
      if (!handler) throw new Error(`未注册的作业类型: ${job.type}`);
      const result = await handler(ctx);
      await this.repo.updateJob(job.jobId, { status: 'succeeded', finishedAt: new Date().toISOString(), resultJson: JSON.stringify(result ?? {}), leaseUntil: null });
      await this.events.emit({ type: 'job.updated', accountId: job.accountId, callId: job.callId, jobId: job.jobId, data: { status: 'succeeded', type: job.type } });
    } catch (e) {
      const err = e as Error & { code?: string };
      const attempts = job.attempts + 1;
      const final = attempts >= job.maxAttempts;
      const base = this.opts.backoffBaseMs?.[job.type] ?? 3000;
      const delayMs = final ? 0 : Math.min(600000, base * Math.pow(2, attempts - 1));
      const patch = {
        status: (final ? 'failed' : 'queued') as JobStatus,
        finishedAt: final ? new Date().toISOString() : null,
        lastErrorJson: JSON.stringify({ code: err.code ?? 'INTERNAL_ERROR', message: err.message }),
        leaseUntil: null,
        scheduledAt: new Date(Date.now() + delayMs).toISOString(),
      };
      await this.repo.updateJob(job.jobId, patch);
      this.log.warn('job failed', { jobId: job.jobId, type: job.type, attempts, final, err: err.message });
      await this.events.emit({ type: 'job.updated', accountId: job.accountId, callId: job.callId, jobId: job.jobId, data: { status: patch.status, type: job.type, attempt: attempts, error: { code: err.code ?? 'INTERNAL_ERROR', message: err.message } } });
    }
  }
  async recover(): Promise<number> {
    const n = await this.repo.recoverExpiredJobs(new Date().toISOString());
    if (n > 0) this.log.warn('recovered expired jobs', { count: n });
    return n;
  }
}
export function toJobSummary(j: Job): JobSummary {
  return {
    jobId: j.jobId, type: j.type, status: j.status, accountId: j.accountId, callId: j.callId,
    attempts: j.attempts, maxAttempts: j.maxAttempts,
    progress: j.progressJson ? safeJson(j.progressJson) : null,
    scheduledAt: j.scheduledAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
    lastError: j.lastErrorJson ? safeJson(j.lastErrorJson) : null,
    createdAt: j.createdAt, updatedAt: j.updatedAt,
  };
}
export function toJobDetail(j: Job): import('../types/domain.js').JobDetail {
  return { ...toJobSummary(j), payload: j.payloadJson ? safeJson(j.payloadJson) : null, result: j.resultJson ? safeJson(j.resultJson) : null, logs: [] };
}
export function safeJson<T = Record<string, unknown>>(s: string | null | undefined): T | null { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } }
