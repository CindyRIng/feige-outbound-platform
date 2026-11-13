import type { ConfigStore } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { AccountService } from '../core/accounts.js';
import type { CallsService } from '../core/calls.js';
import type { SyncService } from '../core/sync.js';
import type { PipelineService } from '../core/pipeline.js';
import type { StatusService } from '../core/status.js';
import type { TermService } from '../core/terms.js';
import type { JobQueue } from '../core/jobs.js';
import type { EventBus } from '../core/events.js';
import type { Logger } from '../logger.js';
export interface Services {
  config: ConfigStore; repo: Repo; accounts: AccountService; calls: CallsService; sync: SyncService;
  pipeline: PipelineService; status: StatusService; terms: TermService; jobs: JobQueue; events: EventBus;
  log: Logger; startedAt: Date; version: string; token: string;
}
