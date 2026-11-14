import type { IsoDateTime, CallStatus, StageStatus, JobType, JobStatus, AccountState, SpeakerRole, SpeakerMappingMethod, TermCategory, EventType, ErrorBrief, Pagination } from './common.js';

export interface Account {
  accountId: string;
  displayName: string;
  upstreamUsername: string;
  upstreamUserId?: string | null;
  tenantCode?: string | null;
  enterpriseName?: string | null;
  realName?: string | null;
  enabled: boolean;
  concurrency: number;
  browserHeadless?: boolean | null;
  browserProfileDir?: string | null;
  metadata?: Record<string, string> | null;
  state: AccountState;
  jwtExpiresAt?: IsoDateTime | null;
  lastLoginAt?: IsoDateTime | null;
  lastCheckedAt?: IsoDateTime | null;
  lastErrorJson?: string | null;
  agentCode?: string | null;
  telA?: string | null;
  lineId?: string | null;
  lineName?: string | null;
  lineMode?: number | null;
  dialCooldownMs?: number | null;
  origin?: 'user' | 'restored';
  status?: 'enabled' | 'disabled';
  upstreamLineListJson?: string | null;
  lastHealthJson?: string | null;
  version?: number;
  deletedAt?: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
export interface AccountSession {
  accountId: string;
  token?: string | null;          // JWT（v1 存明文于加密列，见数据层说明）
  tokenKeyId?: string | null;
  jwtExpiresAt?: IsoDateTime | null;
  cookieState?: 'valid' | 'expired' | 'unknown';
  wsConnected: boolean;
  lastPongAt?: IsoDateTime | null;
  loginState?: 'unauthenticated' | 'logging_in' | 'authenticated' | 'expired' | 'failed';
  loginFailCount?: number;
  lastLoginJobId?: string | null;
  lastAuthError?: string | null;
  wsConnectedAt?: IsoDateTime | null;
  healthStatus?: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  healthDetailJson?: string | null;
  version?: number;
  state: AccountState;
  updatedAt: IsoDateTime;
}
export interface Call {
  callId: string;
  accountId: string;
  upstreamCallId?: string | null;
  direction: 'outbound';
  toPhone: string;
  toLocation?: string | null;
  fromPhone?: string | null;
  fromLocation?: string | null;
  lineNumber?: string | null;
  customerName?: string | null;
  lineId?: string | null;
  lineName?: string | null;
  status: CallStatus;
  statusReason?: string | null;
  dialedAt?: IsoDateTime | null;
  submittedAt?: IsoDateTime | null;
  answeredAt?: IsoDateTime | null;
  endedAt?: IsoDateTime | null;
  durationSec?: number | null;
  cost?: number | null;
  upstreamStatusJson?: string | null;
  upstreamRawJson?: string | null;
  metadataJson?: string | null;
  audioStatus: StageStatus;
  transcriptStatus: StageStatus;
  analysisStatus: StageStatus;
  pipelineLastErrorJson?: string | null;
  dialState?: string | null;
  upstreamError?: string | null;
  origin?: 'local_dial' | 'sync';
  upstreamUserId?: string | null;
  scheduledAt?: IsoDateTime | null;
  startedAt?: IsoDateTime | null;
  canceledAt?: IsoDateTime | null;
  upstreamBindId?: string | null;
  failedReason?: string | null;
  errorCode?: string | null;
  reconciledAt?: IsoDateTime | null;
  audioRetryCount?: number;
  transcriptRetryCount?: number;
  analysisRetryCount?: number;
  audioLastErrorCode?: string | null;
  transcriptLastErrorCode?: string | null;
  analysisLastErrorCode?: string | null;
  reprocessCount?: number;
  lastSyncedAt?: IsoDateTime | null;
  upstreamCreateTimeMs?: number | null;
  upstreamStartTimeMs?: number | null;
  upstreamEndTimeMs?: number | null;
  upstreamUpdateTimeMs?: number | null;
  handleStatus?: number | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  version: number;
}
export interface AudioAsset {
  audioId: string;
  callId: string;
  sourceUrl: string;
  storagePath: string;
  format: string;
  sampleRate: number;
  channels: number;
  durationMs?: number | null;
  sizeBytes: number;
  sha256: string;
  downloadedAt: IsoDateTime;
}
export interface Transcript {
  transcriptId: string;
  callId: string;
  source: 'asr';
  provider: string;
  status: StageStatus;
  isCurrent: boolean;
  language: string;
  fullText?: string | null;
  fullTextRaw?: string | null;
  durationMs?: number | null;
  chunkCount?: number | null;
  needsReview: boolean;
  speakerMappingJson?: string | null;
  asrMetaJson?: string | null;
  revision?: number;
  segmentCount?: number;
  lastErrorJson?: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
export interface TranscriptSegment {
  segmentId: string;
  transcriptId: string;
  callId: string;
  idx: number;
  beginMs: number;
  endMs: number;
  channel?: number | null;
  speakerLabel?: string | null;
  chunkIndex?: number | null;
  role: SpeakerRole;
  rawText: string;
  normalizedText: string;
  confidence?: number | null;
  emotionValue?: number | null;
  speechRate?: number | null;
  silenceBeforeMs?: number | null;
}
export interface AnalysisResult {
  analysisId: string;
  callId: string;
  transcriptId?: string | null;
  status: StageStatus;
  isCurrent: boolean;
  provider?: string | null;
  revision?: number;
  termsVersion?: string | null;
  summary?: string | null;
  summaryBulletsJson?: string | null;
  intentLabel?: string | null;
  intentScore?: number | null;
  termsAppliedJson?: string | null;
  qualityFlagsJson?: string | null;
  rawRequestHash?: string | null;
  rawResponsePath?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  schemaVersion?: string | null;
  paramsJson?: string | null;
  usageJson?: string | null;
  summaryJson?: string | null;
  intentJson?: string | null;
  keywordsJson?: string | null;
  resultJson?: string | null;
  speakerMappingJson?: string | null;
  needsReview: boolean;
  lastErrorJson?: string | null;
  generatedAt?: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
export interface CallEvent {
  eventId: string;
  type: EventType;
  occurredAt: IsoDateTime;
  accountId?: string | null;
  callId?: string | null;
  jobId?: string | null;
  dataJson?: string | null;
  createdAt: IsoDateTime;
}
export interface Job {
  jobId: string;
  type: JobType;
  status: JobStatus;
  priority: number;
  accountId?: string | null;
  callId?: string | null;
  payloadJson?: string | null;
  resultJson?: string | null;
  progressJson?: string | null;
  attempts: number;
  maxAttempts: number;
  scheduledAt: IsoDateTime;
  startedAt?: IsoDateTime | null;
  finishedAt?: IsoDateTime | null;
  leaseUntil?: IsoDateTime | null;
  stage?: 'audio' | 'transcript' | 'analysis' | null;
  trigger?: 'api' | 'scheduler' | 'pipeline' | 'manual';
  idempotencyKey?: string | null;
  nextRunAt?: IsoDateTime | null;
  durationMs?: number | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  version?: number;
  lastErrorJson?: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
export interface TranscriptChunk {
  chunkId: string;
  callId: string;
  revision: number;
  chunkIndex: number;
  beginMs: number;
  endMs: number;
  forcedCut: boolean;
  status: StageStatus;
  resultPath?: string | null;
  resultSha256?: string | null;
  providerTraceId?: string | null;
  segmentCount?: number | null;
  attempts: number;
  lastErrorJson?: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
export interface TermRule {
  termId: string;
  from: string[];
  to: string;
  category?: TermCategory | null;
  priority: number;
  enabled: boolean;
  caseSensitive: boolean;
  note?: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
export interface SyncCursor {
  accountId: string;
  lastStartTime?: string | null;
  lastUpstreamCallId?: string | null;
  lastSyncedAt?: IsoDateTime | null;
  updatedAt: IsoDateTime;
  mode?: 'incremental' | 'full' | 'backfill';
  lastCreateTimeMs?: number | null;
  lastJobId?: string | null;
  lastStartedAt?: IsoDateTime | null;
  lastSuccessAt?: IsoDateTime | null;
  lastErrorCode?: string | null;
  consecutiveFailures?: number;
  fetchedTotal?: number;
  upsertedTotal?: number;
  backfillStateJson?: string | null;
  windowBeginDate?: string | null;
  windowEndDate?: string | null;
}
export interface AuditLog {
  auditId: string;
  actor: string;
  action: string;
  target?: string | null;
  detailJson?: string | null;
  at: IsoDateTime;
  targetType?: string | null;
  accountId?: string | null;
  requestId?: string | null;
  sourceIp?: string | null;
  result?: 'success' | 'failed';
  errorCode?: string | null;
}
export interface IdempotencyRecord {
  key: string;
  scope: string;
  requestHash: string;
  responseJson?: string | null;
  status: 'in_progress' | 'completed';
  createdAt: IsoDateTime;
  expiresAt: IsoDateTime;
}

// ---------- API DTO ----------
export interface AccountSummary {
  accountId: string; displayName: string; /** 完整上游登录手机号（security.maskPhones=false 时） */ upstreamUsername: string; upstreamUsernameMasked: string; upstreamUserId?: string | null;
  tenantCode?: string | null; enterpriseName?: string | null; realName?: string | null;
  dialMode: 'callback'; line?: { lineId: string; lineName: string; mode: number } | null;
  enabled: boolean; state: AccountState; jwtExpiresAt?: IsoDateTime | null;
  lastLoginAt?: IsoDateTime | null; lastCheckedAt?: IsoDateTime | null; lastError?: ErrorBrief | null;
  deletedAt?: IsoDateTime | null;
  stats: { totalCalls: number; calls24h: number; lastCallAt?: IsoDateTime | null };
  createdAt: IsoDateTime; updatedAt: IsoDateTime;
}
export interface AccountDetail extends AccountSummary {
  config: { concurrency: number; browser: { headless: boolean; profileDirMasked: string } };
  session: { state: AccountState; jwtExpiresAt?: IsoDateTime | null; wsConnected: boolean; cookieState: 'valid'|'expired'|'unknown'; lastPongAt?: IsoDateTime | null };
  sync: { lastSyncAt?: IsoDateTime | null; cursorStartTime?: string | null; lagSeconds?: number | null; lastError?: ErrorBrief | null };
  recentJobs: JobSummary[];
}
export interface AccountHealth {
  accountId: string; state: AccountState;
  jwt: { valid: boolean; expiresAt?: IsoDateTime | null; expiresInSec?: number | null };
  ws: { connected: boolean; lastPongAt?: IsoDateTime | null; latencyMs?: number | null };
  upstream: { reachable: boolean; latencyMs?: number | null; checkedAt: IsoDateTime };
  line?: { lineId: string; lineName: string; mode: number } | null;
  dialWindow: DialWindow;
  busy: { inCall: boolean; busyCallId?: string | null };
  lastError?: ErrorBrief | null;
}
export interface DialWindow { open: boolean; windowStart: string; windowEnd: string; timezone: string; nextOpenAt?: IsoDateTime | null; }
export interface CallSummary {
  callId: string; accountId: string; upstreamCallId?: string | null; direction: 'outbound';
  to: { phone: string; location?: string | null }; from: { phone: string; location?: string | null };
  lineNumber?: string | null; customerName?: string | null; lineId?: string | null; lineName?: string | null;
  status: CallStatus; statusReason?: string | null;
  dialedAt?: IsoDateTime | null; answeredAt?: IsoDateTime | null; endedAt?: IsoDateTime | null;
  durationSec?: number | null; cost?: number | null;
  upstreamStatus?: { callStatus?: number | null; callStatusName?: string | null; finishStatus?: number | null; finishStatusName?: string | null } | null;
  pipeline: PipelineSummary & { lastError?: ErrorBrief | null };
  transcriptPreview?: string | null; audioAvailable: boolean;
  createdAt: IsoDateTime; updatedAt: IsoDateTime;
}
export interface PipelineSummary { audio: StageStatus; transcript: StageStatus; analysis: StageStatus; }
export interface PipelineDetail {
  audio: { status: StageStatus; audioId?: string | null; downloadedAt?: IsoDateTime | null; lastError?: ErrorBrief | null };
  transcript: { status: StageStatus; transcriptId?: string | null; source?: 'asr' | null; provider?: string | null; chunkCount?: number | null; needsReview?: boolean | null; generatedAt?: IsoDateTime | null; lastError?: ErrorBrief | null };
  analysis: { status: StageStatus; analysisId?: string | null; generatedAt?: IsoDateTime | null; lastError?: ErrorBrief | null };
}
export interface CallDetail extends CallSummary {
  upstream?: Record<string, unknown> | null;
  timeline: { createdAt: IsoDateTime; submittedAt?: IsoDateTime | null; dialingAt?: IsoDateTime | null; connectedAt?: IsoDateTime | null; endedAt?: IsoDateTime | null };
  pipelineDetail: PipelineDetail;
  recording: { available: boolean; downloadUrl?: string | null; format?: 'wav'; durationMs?: number | null; sizeBytes?: number | null; sha256?: string | null; sampleRate?: number | null; channels?: number | null };
  transcript: { available: boolean; source?: 'asr'; segmentCount?: number | null; needsReview?: boolean | null; url?: string | null };
  analysis: { available: boolean; analysisId?: string | null; summary?: string | null; intent?: string | null; url?: string | null };
  eventsCount: number;
  metadata?: Record<string, string> | null;
  events?: EventRecord[] | null;
  analysisPayload?: AnalysisPayload | null;
}
export interface TranscriptSegmentDto {
  segmentId: string; index: number; beginMs: number; endMs: number;
  channel?: number | null; speakerLabel?: string | null; chunkIndex?: number | null;
  role: SpeakerRole; rawText: string; normalizedText: string; confidence?: number | null;
  emotionValue?: number | null; speechRate?: number | null; silenceBeforeMs?: number | null;
}
export interface AnalysisPayload {
  analysisId: string; callId: string; status: StageStatus;
  model?: string | null; promptVersion?: string | null;
  summary: { short: string; bullets: string[] } | null;
  intent?: { label: string; score?: number | null } | null;
  keywords: string[]; customerProfile?: Record<string, unknown> | null;
  actionItems: string[]; riskFlags: string[];
  quality?: { complianceIssues: string[]; coachingPoints: string[] } | null;
  termsApplied: { from: string; to: string; count: number }[];
  speakerMapping?: { method: SpeakerMappingMethod; agentChannels?: number[] | null; confidence?: number | null; needsReview?: boolean | null; evidence?: string | null } | null;
  usage?: { promptTokens?: number | null; completionTokens?: number | null; totalTokens?: number | null; latencyMs?: number | null } | null;
  generatedAt?: IsoDateTime | null;
}
export interface TranscriptPayload {
  callId: string; transcriptId: string; source: 'asr'; provider: string; language: string;
  status: StageStatus; isCurrent: boolean; durationMs?: number | null;
  fullText: string; segments: TranscriptSegmentDto[];
  analysis?: { analysisId: string; summary: string; intent?: string | null } | null;
  createdAt: IsoDateTime; updatedAt: IsoDateTime;
}
export interface JobSummary {
  jobId: string; type: JobType; status: JobStatus; accountId?: string | null; callId?: string | null;
  attempts: number; maxAttempts: number; progress?: Record<string, unknown> | null;
  scheduledAt: IsoDateTime; startedAt?: IsoDateTime | null; finishedAt?: IsoDateTime | null;
  lastError?: ErrorBrief | null; createdAt: IsoDateTime; updatedAt: IsoDateTime;
}
export interface JobDetail extends JobSummary { payload?: Record<string, unknown> | null; result?: Record<string, unknown> | null; logs: string[]; }
export interface EventRecord {
  eventId: string; type: EventType; occurredAt: IsoDateTime;
  accountId?: string | null; callId?: string | null; data?: Record<string, unknown>;
}
export interface StatusPayload {
  version: string; startedAt: IsoDateTime; uptimeSec: number; now: IsoDateTime;
  db: { ok: boolean; schemaVersion: number; sizeBytes: number; walSizeBytes: number; latencyMs: number };
  accounts: { total: number; online: number; expired: number; loggingIn: number; error: number; disabled: number };
  accountsDetail?: AccountSummary[];
  upstream: { reachable: boolean; lastCheckedAt?: IsoDateTime | null; latencyMs?: number | null };
  dialWindow: DialWindow;
  queues: { jobsQueued: number; jobsRunning: number; jobsFailed24h: number; audioPending: number; transcriptPending: number; analysisPending: number };
  sync: { lastSyncAt?: IsoDateTime | null; laggingAccounts: string[]; lastError?: ErrorBrief | null };
  events: { sseClients: number };
  limits: { apiQps: number; perAccountConcurrency: number; globalConcurrency: number; dialCooldownMs: number };
}
export interface AccountCreateResult { accountId: string; displayName: string; upstreamUsername: string; upstreamUsernameMasked: string; enabled: boolean; state: AccountState; dialMode: 'callback'; createdAt: IsoDateTime; }
export interface AccountLoginResult { accountId: string; state: AccountState; loggedIn: boolean; jwtExpiresAt?: IsoDateTime | null; loginJobId: string; }
export interface AccountLoginAccepted { loginJobId: string; status: JobStatus; pollUrl: string; }
export interface CallAccepted extends CallSummary {}
export interface SyncAccepted { jobId: string; type: 'sync'; mode: string; accountId?: string | null; status: JobStatus; pollUrl: string; }
export interface ReprocessAccepted { jobId: string; callId: string; stages: string[]; status: JobStatus; pollUrl: string; }
export interface DryRunResult { dryRun: true; willDial: boolean; accountId: string; to: string; dialWindow: DialWindow; warnings: string[]; estimatedCost?: number | null; }
export interface TermReplaceResult { count: number; version: IsoDateTime; }
export interface NormalizeResult { original: string; normalized: string; applied: { from: string; to: string; count: number }[]; rulesVersion: string; }
export interface WebhookTestResult { delivered: boolean; statusCode?: number | null; latencyMs?: number | null; deliveryError?: string | null; }
export interface Paginated<T> { items: T[]; pagination: Pagination; }
