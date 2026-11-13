import type {
  Account, AccountSession, Call, AudioAsset, Transcript, TranscriptSegment, AnalysisResult,
  CallEvent, Job, TranscriptChunk, TermRule, SyncCursor, AuditLog, IdempotencyRecord,
} from '../types/domain.js';
import type { CallStatus, JobType, JobStatus, StageStatus, EventType, IsoDateTime, Pagination } from '../types/common.js';

export interface CallFilter {
  page: number; size: number;
  accountIds?: string[];
  statuses?: CallStatus[];
  hasAudio?: boolean;
  hasTranscript?: boolean;
  pipelineAudio?: StageStatus[];
  pipelineTranscript?: StageStatus[];
  pipelineAnalysis?: StageStatus[];
  toPhoneLike?: string;
  q?: string;
  dateFrom?: string;
  dateTo?: string;
  sort?: string;
}
export interface EventFilter { page: number; size: number; types?: string[]; callId?: string; accountId?: string; since?: string; until?: string; sort?: string; }
export interface JobFilter { page: number; size: number; types?: JobType[]; statuses?: JobStatus[]; accountId?: string; callId?: string; sort?: string; }
export interface ListResult<T> { items: T[]; total: number; }
export interface DbStats { sizeBytes: number; walSizeBytes: number; schemaVersion: number; latencyMs: number; }

export interface Repo {
  migrate(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<number>;
  stats(): Promise<DbStats>;
  schemaVersion(): Promise<number>;

  // accounts
  createAccount(a: Account): Promise<void>;
  getAccount(accountId: string): Promise<Account | null>;
  listAccounts(opts?: { enabled?: boolean }): Promise<Account[]>;
  updateAccount(accountId: string, patch: Partial<Account>): Promise<Account | null>;
  removeAccount(accountId: string): Promise<void>;
  hardDeleteAccount(accountId: string): Promise<void>;
  accountStats(accountId: string): Promise<{ totalCalls: number; calls24h: number; lastCallAt: IsoDateTime | null }>;
  // sessions
  getSession(accountId: string): Promise<AccountSession | null>;
  upsertSession(s: AccountSession): Promise<void>;
  deleteSession(accountId: string): Promise<void>;
  // calls
  insertCall(c: Call): Promise<void>;
  getCall(callId: string): Promise<Call | null>;
  getCallByUpstream(accountId: string, upstreamCallId: string): Promise<Call | null>;
  updateCall(callId: string, patch: Partial<Call>, expectedVersion?: number | null): Promise<Call | null>;
  listCalls(f: CallFilter): Promise<ListResult<Call>>;
  findRecentDial(accountId: string, toPhone: string, sinceIso: IsoDateTime): Promise<Call | null>;
  countOpenCalls(accountId: string): Promise<number>;
  countByStatus(status: CallStatus): Promise<number>;
  pipelinePendingCounts(): Promise<{ audioPending: number; transcriptPending: number; analysisPending: number }>;
  listCallsByStage(stage: 'audio' | 'transcript' | 'analysis', limit: number): Promise<Call[]>;
  // audio
  upsertAudio(a: AudioAsset): Promise<void>;
  getAudioByCall(callId: string): Promise<AudioAsset | null>;
  // transcript
  createTranscript(t: Transcript): Promise<void>;
  updateTranscript(transcriptId: string, patch: Partial<Transcript>): Promise<Transcript | null>;
  getCurrentTranscript(callId: string): Promise<Transcript | null>;
  markOtherTranscriptsNotCurrent(callId: string, keepTranscriptId: string): Promise<void>;
  replaceSegments(transcriptId: string, callId: string, segments: TranscriptSegment[]): Promise<void>;
  listSegments(transcriptId: string): Promise<TranscriptSegment[]>;
  countSegments(transcriptId: string): Promise<number>;
  // analysis
  createAnalysis(a: AnalysisResult): Promise<void>;
  updateAnalysis(analysisId: string, patch: Partial<AnalysisResult>): Promise<AnalysisResult | null>;
  getCurrentAnalysis(callId: string): Promise<AnalysisResult | null>;
  markOtherAnalysesNotCurrent(callId: string, keepAnalysisId: string): Promise<void>;
  // chunks
  upsertChunk(c: TranscriptChunk): Promise<void>;
  listChunks(callId: string, revision: number): Promise<TranscriptChunk[]>;
  // events
  insertEvent(e: CallEvent): Promise<void>;
  listEvents(f: EventFilter): Promise<ListResult<CallEvent>>;
  listCallEvents(callId: string, types?: string[]): Promise<CallEvent[]>;
  // jobs
  insertJob(j: Job): Promise<void>;
  getJob(jobId: string): Promise<Job | null>;
  updateJob(jobId: string, patch: Partial<Job>): Promise<Job | null>;
  claimJob(types: JobType[], nowIso: string, leaseUntilIso: string): Promise<Job | null>;
  recoverExpiredJobs(nowIso: string): Promise<number>;
  listJobs(f: JobFilter): Promise<ListResult<Job>>;
  jobCounts(): Promise<{ queued: number; running: number; failed24h: number }>;
  listJobsByStatus(type: JobType, status: JobStatus, limit: number): Promise<Job[]>;
  // terms
  getTermRule(termId: string): Promise<TermRule | null>;
  listTermRules(opts?: { q?: string; enabled?: boolean }): Promise<TermRule[]>;
  createTermRule(t: TermRule): Promise<TermRule>;
  updateTermRule(termId: string, patch: Partial<TermRule>): Promise<TermRule | null>;
  deleteTermRule(termId: string): Promise<boolean>;
  replaceTermRules(rules: TermRule[]): Promise<void>;
  termsVersion(): Promise<string>;
  // cursor
  getCursor(accountId: string): Promise<SyncCursor | null>;
  upsertCursor(c: SyncCursor): Promise<void>;
  // idempotency
  createIdempotency(rec: IdempotencyRecord): Promise<void>;
  getIdempotency(key: string, scope: string): Promise<IdempotencyRecord | null>;
  completeIdempotency(key: string, scope: string, responseJson: string): Promise<void>;
  deleteExpiredIdempotency(nowIso: string): Promise<number>;
  // audit
  insertAudit(a: AuditLog): Promise<void>;
}
