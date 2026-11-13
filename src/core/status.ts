import type { Repo } from '../db/repo.js';
import type { ConfigStore } from '../config.js';
import type { StatusPayload, AccountSummary } from '../types/domain.js';
import type { JobQueue } from './jobs.js';
import type { EventBus } from './events.js';
import type { AccountService } from './accounts.js';
import type { Logger } from '../logger.js';
import { dialWindow } from './time.js';

export interface StatusSvcDeps {
  repo: Repo; config: ConfigStore; jobs: JobQueue; events: EventBus; accounts: AccountService; log: Logger;
  startedAt: Date; version: string;
}
export class StatusService {
  constructor(private d: StatusSvcDeps) {}
  async health(): Promise<{ ok: boolean; uptimeSec: number; version: string; startedAt: string }> {
    return { ok: true, uptimeSec: Math.round((Date.now() - this.d.startedAt.getTime()) / 1000), version: this.d.version, startedAt: this.d.startedAt.toISOString() };
  }
  async status(detail = true): Promise<StatusPayload> {
    const repo = this.d.repo;
    let db: StatusPayload['db'];
    try {
      const stats = await repo.stats();
      db = { ok: true, schemaVersion: stats.schemaVersion, sizeBytes: stats.sizeBytes, walSizeBytes: stats.walSizeBytes, latencyMs: stats.latencyMs };
    } catch { db = { ok: false, schemaVersion: 0, sizeBytes: 0, walSizeBytes: 0, latencyMs: -1 }; }
    const accounts = await this.d.accounts.list().catch(() => [] as AccountSummary[]);
    const counts = { total: accounts.length, online: 0, expired: 0, loggingIn: 0, error: 0, disabled: 0 };
    for (const a of accounts) {
      if (a.state === 'online') counts.online++;
      else if (a.state === 'expired') counts.expired++;
      else if (a.state === 'logging_in') counts.loggingIn++;
      else if (a.state === 'error') counts.error++;
      else if (a.state === 'disabled') counts.disabled++;
    }
    const jc = await repo.jobCounts().catch(() => ({ queued: 0, running: 0, failed24h: 0 }));
    const pc = await repo.pipelinePendingCounts().catch(() => ({ audioPending: 0, transcriptPending: 0, analysisPending: 0 }));
    const cursors = await Promise.all(accounts.map(a => repo.getCursor(a.accountId).catch(() => null)));
    const lastSync = cursors.map(c => c?.lastSyncedAt).filter(Boolean).sort().pop() ?? null;
    const lagging = accounts.filter((a, i) => { const c = cursors[i]; return a.state === 'online' && c?.lastSuccessAt && Date.now() - new Date(c.lastSuccessAt).getTime() > 10 * 60000; }).map(a => a.accountId);
    const lastChecked = accounts.map(a => a.lastCheckedAt).filter(Boolean).sort().pop() ?? null;
    return {
      version: this.d.version,
      startedAt: this.d.startedAt.toISOString(),
      uptimeSec: Math.round((Date.now() - this.d.startedAt.getTime()) / 1000),
      now: new Date().toISOString(),
      db,
      accounts: counts,
      accountsDetail: detail ? accounts : [],
      upstream: { reachable: counts.online > 0, lastCheckedAt: lastChecked ?? null, latencyMs: null },
      dialWindow: dialWindow(this.d.config.get()),
      queues: { jobsQueued: jc.queued, jobsRunning: jc.running, jobsFailed24h: jc.failed24h, ...pc },
      sync: { lastSyncAt: lastSync, laggingAccounts: lagging, lastError: null },
      events: { sseClients: this.d.events.subscribers },
      limits: { apiQps: 100, perAccountConcurrency: 1, globalConcurrency: this.d.config.get().limits.globalConcurrency, dialCooldownMs: this.d.config.get().limits.dialCooldownMs },
    };
  }
}
