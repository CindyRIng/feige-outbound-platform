-- ============================================================================
-- 0001_init.sql  |  schema v1  |  FOP 0.1.0
-- 说明：初始基线（全部 STRICT 表）。后续迁移见 §12 命名规范。
-- ============================================================================

-- ---------- 迁移记录 ----------
CREATE TABLE schema_version (
  version      INTEGER PRIMARY KEY CHECK (version >= 1),
  name         TEXT    NOT NULL UNIQUE,
  checksum     TEXT    NOT NULL CHECK (length(checksum) = 64),
  applied_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  app_version  TEXT    NOT NULL,
  execution_ms INTEGER CHECK (execution_ms IS NULL OR execution_ms >= 0)
) STRICT;

-- ---------- 账号 ----------
CREATE TABLE accounts (
  account_id        TEXT    PRIMARY KEY
                    CHECK (account_id GLOB '[a-z0-9][a-z0-9_-]*' AND length(account_id) BETWEEN 2 AND 32),
  display_name      TEXT    NOT NULL CHECK (length(display_name) BETWEEN 1 AND 64),
  upstream_username TEXT    NOT NULL,
  upstream_user_id  TEXT,
  tenant_code       TEXT,
  enterprise_name   TEXT,
  agent_code        TEXT,
  real_name         TEXT,
  tel_a             TEXT,
  profile_name      TEXT    NOT NULL,
  browser_headless  INTEGER CHECK (browser_headless IS NULL OR browser_headless IN (0,1)),
  credential_ref    TEXT    NOT NULL,
  line_id           TEXT,
  line_name         TEXT,
  line_mode         INTEGER,
  status            TEXT    NOT NULL DEFAULT 'enabled'
                    CHECK (status IN ('enabled','disabled')),
  concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK (concurrency_limit >= 1),
  dial_cooldown_ms  INTEGER CHECK (dial_cooldown_ms IS NULL OR dial_cooldown_ms >= 0),
  origin            TEXT    NOT NULL DEFAULT 'user' CHECK (origin IN ('user','restored')),
  upstream_line_list_json TEXT,
  last_health_json  TEXT,
  metadata_json     TEXT    NOT NULL DEFAULT '{}' CHECK (length(metadata_json) <= 4096),
  deleted_at        TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE UNIQUE INDEX ux_accounts_username
  ON accounts(upstream_username) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ux_accounts_upstream_user
  ON accounts(upstream_user_id) WHERE upstream_user_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_accounts_status ON accounts(status) WHERE deleted_at IS NULL;

-- ---------- 登录态 ----------
CREATE TABLE account_sessions (
  account_id        TEXT    PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  jwt_ciphertext    BLOB,
  jwt_iv            BLOB,
  jwt_tag           BLOB,
  jwt_key_id        TEXT,
  jwt_issued_at     TEXT,
  jwt_expires_at    TEXT,
  login_state       TEXT    NOT NULL DEFAULT 'unauthenticated'
                    CHECK (login_state IN ('unauthenticated','logging_in','authenticated','expired','failed')),
  login_fail_count  INTEGER NOT NULL DEFAULT 0 CHECK (login_fail_count >= 0),
  last_login_job_id TEXT,
  last_login_at     TEXT,
  last_auth_error   TEXT,
  ws_connected      INTEGER NOT NULL DEFAULT 0 CHECK (ws_connected IN (0,1)),
  ws_connected_at   TEXT,
  ws_last_pong_at   TEXT,
  health_status     TEXT    NOT NULL DEFAULT 'unknown'
                    CHECK (health_status IN ('healthy','degraded','unhealthy','unknown')),
  health_detail_json TEXT,
  last_check_at     TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE INDEX ix_sessions_health ON account_sessions(health_status);
CREATE INDEX ix_sessions_jwt_expiry ON account_sessions(jwt_expires_at);

-- ---------- 话单 ----------
CREATE TABLE calls (
  call_id        TEXT    PRIMARY KEY,
  account_id     TEXT    NOT NULL REFERENCES accounts(account_id) ON DELETE RESTRICT,
  upstream_call_id TEXT,
  upstream_user_id TEXT,
  origin         TEXT    NOT NULL DEFAULT 'local_dial' CHECK (origin IN ('local_dial','sync')),
  status         TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','dialing','connected','ended','no_answer','failed','canceled')),
  from_phone     TEXT,
  to_phone       TEXT    NOT NULL,
  customer_name  TEXT,
  line_number    TEXT,
  line_id        TEXT,
  line_name      TEXT,
  call_type      INTEGER,
  call_status    INTEGER,
  call_status_name TEXT,
  finish_status  INTEGER,
  finish_status_name TEXT,
  handle_status  INTEGER CHECK (handle_status IS NULL OR handle_status IN (0,1,2)),
  started_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 CHECK (started_at GLOB
                   '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  dialed_at      TEXT,
  submitted_at   TEXT,
  dial_state     TEXT    NOT NULL DEFAULT 'none'
                 CHECK (dial_state IN ('none','sending','sent','failed','unknown')),
  upstream_bind_id TEXT,
  answered_at    TEXT,
  ended_at       TEXT,
  canceled_at    TEXT,
  scheduled_at   TEXT,
  duration_sec   INTEGER CHECK (duration_sec IS NULL OR duration_sec >= 0),
  cost_cents     INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0),
  from_location  TEXT,
  to_location    TEXT,
  upstream_error TEXT,
  error_code     TEXT,
  failed_reason  TEXT,
  reconciled_at  TEXT,
  audio_status   TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (audio_status IN ('pending','in_progress','ready','missing','failed','skipped')),
  audio_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (audio_retry_count >= 0),
  audio_last_error_code TEXT,
  audio_ready_at TEXT,
  transcript_status TEXT NOT NULL DEFAULT 'pending'
                 CHECK (transcript_status IN ('pending','in_progress','ready','missing','failed','skipped')),
  transcript_source TEXT CHECK (transcript_source IS NULL OR transcript_source IN ('asr')),
  transcript_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (transcript_retry_count >= 0),
  transcript_last_error_code TEXT,
  transcript_ready_at TEXT,
  analysis_status TEXT NOT NULL DEFAULT 'pending'
                 CHECK (analysis_status IN ('pending','in_progress','ready','missing','failed','skipped')),
  analysis_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (analysis_retry_count >= 0),
  analysis_last_error_code TEXT,
  analysis_ready_at TEXT,
  pipeline_updated_at TEXT,
  reprocess_count INTEGER NOT NULL DEFAULT 0 CHECK (reprocess_count >= 0),
  upstream_create_time_ms INTEGER,
  upstream_start_time_ms  INTEGER,
  upstream_end_time_ms    INTEGER,
  upstream_update_time_ms INTEGER,
  last_synced_at TEXT,
  raw_upstream_json TEXT,
  metadata_json  TEXT    NOT NULL DEFAULT '{}' CHECK (length(metadata_json) <= 4096),
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
) STRICT;

CREATE UNIQUE INDEX ux_calls_upstream
  ON calls(account_id, upstream_call_id) WHERE upstream_call_id IS NOT NULL;
CREATE INDEX ix_calls_started ON calls(started_at DESC);
CREATE INDEX ix_calls_account_started ON calls(account_id, started_at DESC);
CREATE INDEX ix_calls_status_started ON calls(status, started_at DESC);
CREATE INDEX ix_calls_to_phone_started ON calls(to_phone, started_at DESC);
CREATE INDEX ix_calls_dial_state ON calls(dial_state) WHERE dial_state IN ('sending','unknown');
CREATE INDEX ix_calls_upstream_update ON calls(account_id, upstream_update_time_ms)
  WHERE upstream_update_time_ms IS NOT NULL;
CREATE INDEX ix_calls_error_code ON calls(error_code) WHERE error_code IS NOT NULL;

-- ---------- 录音资产 ----------
CREATE TABLE audio_assets (
  audio_id       TEXT    PRIMARY KEY,
  call_id        TEXT    NOT NULL UNIQUE REFERENCES calls(call_id) ON DELETE CASCADE,
  source_url     TEXT,
  storage_path   TEXT    NOT NULL,
  sha256         TEXT    NOT NULL CHECK (length(sha256) = 64),
  size_bytes     INTEGER NOT NULL CHECK (size_bytes > 0),
  duration_ms    INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  format         TEXT    NOT NULL DEFAULT 'wav' CHECK (format IN ('wav')),
  sample_rate_hz INTEGER NOT NULL DEFAULT 16000 CHECK (sample_rate_hz > 0),
  channels       INTEGER NOT NULL DEFAULT 1 CHECK (channels IN (1,2)),
  bits_per_sample INTEGER NOT NULL DEFAULT 16 CHECK (bits_per_sample IN (8,16,24,32)),
  download_attempts INTEGER NOT NULL DEFAULT 0 CHECK (download_attempts >= 0),
  last_error_code TEXT,
  fetched_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  verified_at    TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX ix_audio_sha ON audio_assets(sha256);

-- ---------- 转写（本地自建 ASR；source 固定 asr） ----------
CREATE TABLE transcripts (
  transcript_id  TEXT    PRIMARY KEY,
  call_id        TEXT    NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  source         TEXT    NOT NULL DEFAULT 'asr' CHECK (source IN ('asr')),
  provider       TEXT    NOT NULL DEFAULT 'minimax:asr-1.0'
                 CHECK (length(provider) BETWEEN 1 AND 64),
  revision       INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  is_current     INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1)),
  language       TEXT    NOT NULL DEFAULT 'zh-CN',
  duration_ms    INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  segment_count  INTEGER NOT NULL DEFAULT 0 CHECK (segment_count >= 0),
  chunk_count    INTEGER NOT NULL DEFAULT 1 CHECK (chunk_count BETWEEN 1 AND 64),
  needs_review   INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0,1)),
  speaker_mapping_json TEXT CHECK (speaker_mapping_json IS NULL OR json_valid(speaker_mapping_json)),
  asr_meta_json  TEXT    CHECK (asr_meta_json IS NULL OR (json_valid(asr_meta_json) AND length(asr_meta_json) <= 65536)),
  full_text      TEXT,
  full_text_raw  TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE UNIQUE INDEX ux_transcripts_current ON transcripts(call_id) WHERE is_current = 1;
CREATE INDEX ix_transcripts_call ON transcripts(call_id, created_at DESC);
CREATE INDEX ix_transcripts_review ON transcripts(needs_review) WHERE needs_review = 1;

CREATE TABLE transcript_segments (
  segment_id      TEXT    PRIMARY KEY,
  transcript_id   TEXT    NOT NULL REFERENCES transcripts(transcript_id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL CHECK (seq >= 0),
  start_ms        INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms          INTEGER NOT NULL CHECK (end_ms >= start_ms),
  chunk_index     INTEGER NOT NULL DEFAULT 0 CHECK (chunk_index >= 0),
  channel_id      INTEGER CHECK (channel_id IS NULL OR channel_id IN (0,1)),
  speaker_label   TEXT    CHECK (speaker_label IS NULL OR length(speaker_label) BETWEEN 1 AND 16),
  speaker_role    TEXT    NOT NULL DEFAULT 'unknown' CHECK (speaker_role IN ('agent','customer','unknown')),
  text_raw        TEXT    NOT NULL CHECK (length(text_raw) BETWEEN 1 AND 4096),
  text_normalized TEXT    NOT NULL CHECK (length(text_normalized) BETWEEN 1 AND 4096),
  confidence      REAL    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  emotion_value   REAL,      -- 预留：v1 ASR 不返回，恒 NULL
  speech_rate     INTEGER,   -- 预留：v1 ASR 不返回，恒 NULL
  silence_before_ms INTEGER, -- 预留：v1 ASR 不返回，恒 NULL
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE UNIQUE INDEX ux_segments_transcript_seq ON transcript_segments(transcript_id, seq);
CREATE INDEX ix_segments_transcript_time ON transcript_segments(transcript_id, start_ms);
CREATE INDEX ix_segments_transcript_chunk ON transcript_segments(transcript_id, chunk_index);
CREATE INDEX ix_segments_role ON transcript_segments(speaker_role);
CREATE INDEX ix_segments_label ON transcript_segments(speaker_label) WHERE speaker_label IS NOT NULL;

-- ---------- ASR 分块（支撑表；长通话切分计划/块结果状态，D16） ----------
CREATE TABLE transcript_chunks (
  chunk_id       TEXT    PRIMARY KEY,
  call_id        TEXT    NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  revision       INTEGER NOT NULL CHECK (revision >= 1),
  chunk_index    INTEGER NOT NULL CHECK (chunk_index >= 0),
  transcript_id  TEXT    REFERENCES transcripts(transcript_id) ON DELETE SET NULL,
  begin_ms       INTEGER NOT NULL CHECK (begin_ms >= 0),
  end_ms         INTEGER NOT NULL CHECK (end_ms > begin_ms),
  forced_cut     INTEGER NOT NULL DEFAULT 0 CHECK (forced_cut IN (0,1)),
  status         TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','in_progress','succeeded','failed','skipped')),
  result_path    TEXT,
  result_sha256  TEXT    CHECK (result_sha256 IS NULL OR length(result_sha256) = 64),
  provider_trace_id TEXT,
  segment_count  INTEGER NOT NULL DEFAULT 0 CHECK (segment_count >= 0),
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code TEXT,
  last_error_message TEXT,
  started_at     TEXT,
  finished_at    TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (call_id, revision, chunk_index)
) STRICT;

CREATE INDEX ix_chunks_call_rev ON transcript_chunks(call_id, revision, chunk_index);
CREATE INDEX ix_chunks_transcript ON transcript_chunks(transcript_id) WHERE transcript_id IS NOT NULL;
CREATE INDEX ix_chunks_pending ON transcript_chunks(status) WHERE status IN ('pending','in_progress','failed');

-- ---------- AI 后处理 ----------
CREATE TABLE analysis_results (
  analysis_id     TEXT    PRIMARY KEY,
  call_id         TEXT    NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  transcript_id   TEXT    REFERENCES transcripts(transcript_id) ON DELETE SET NULL,
  revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  is_current      INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1)),
  provider        TEXT    NOT NULL DEFAULT 'deepseek' CHECK (length(provider) BETWEEN 1 AND 32),
  model           TEXT    NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
  prompt_version  TEXT    NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 32),
  params_json     TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(params_json)),
  schema_version  TEXT    NOT NULL DEFAULT 'analysis-output-v1'
                  CHECK (length(schema_version) BETWEEN 1 AND 32),
  terms_version   TEXT,
  summary         TEXT,
  summary_bullets_json TEXT NOT NULL DEFAULT '[]',
  keywords_json   TEXT    NOT NULL DEFAULT '[]',
  intent_label    TEXT,
  intent_score    REAL    CHECK (intent_score IS NULL OR (intent_score >= 0 AND intent_score <= 1)),
  terms_applied_json TEXT NOT NULL DEFAULT '[]',
  speaker_mapping_json TEXT CHECK (speaker_mapping_json IS NULL OR json_valid(speaker_mapping_json)),
  needs_review    INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0,1)),
  result_json     TEXT    CHECK (result_json IS NULL OR (json_valid(result_json) AND length(result_json) <= 262144)),
  quality_flags_json TEXT NOT NULL DEFAULT '[]',
  usage_json      TEXT    CHECK (usage_json IS NULL OR json_valid(usage_json)),
  raw_request_hash TEXT   CHECK (raw_request_hash IS NULL OR length(raw_request_hash) = 64),
  raw_response_path TEXT,  -- 排障开关写入（默认 NULL）；0600 短留存，见 11 安全 §7.6
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE UNIQUE INDEX ux_analysis_current ON analysis_results(call_id) WHERE is_current = 1;
CREATE INDEX ix_analysis_call ON analysis_results(call_id, created_at DESC);
CREATE INDEX ix_analysis_transcript ON analysis_results(transcript_id) WHERE transcript_id IS NOT NULL;
CREATE INDEX ix_analysis_intent ON analysis_results(intent_label) WHERE intent_label IS NOT NULL;
CREATE INDEX ix_analysis_model ON analysis_results(model, created_at DESC);
CREATE INDEX ix_analysis_review ON analysis_results(needs_review) WHERE needs_review = 1;

-- ---------- 事件 ----------
CREATE TABLE call_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT    NOT NULL UNIQUE,
  type        TEXT    NOT NULL CHECK (type IN (
                'account.login.started','account.login.succeeded','account.login.failed',
                'account.session.expired','account.health.changed',
                'call.created','call.dialing','call.connected','call.ended','call.no_answer',
                'call.failed','call.canceled',
                'call.audio.ready','call.audio.missing','call.audio.failed',
                'call.transcript.ready','call.transcript.failed',
                'call.analysis.ready','call.analysis.failed',
                'sync.started','sync.progress','sync.completed','sync.failed',
                'job.updated')),
  occurred_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
              CHECK (occurred_at GLOB
                '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  account_id  TEXT,
  call_id     TEXT    REFERENCES calls(call_id) ON DELETE CASCADE,
  job_id      TEXT,
  request_id  TEXT,
  data_json   TEXT    NOT NULL DEFAULT '{}',
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (length(data_json) <= 16384)
) STRICT;

CREATE INDEX ix_events_call_seq ON call_events(call_id, seq) WHERE call_id IS NOT NULL;
CREATE INDEX ix_events_account_seq ON call_events(account_id, seq) WHERE account_id IS NOT NULL;
CREATE INDEX ix_events_type_seq ON call_events(type, seq);
CREATE INDEX ix_events_occurred ON call_events(occurred_at);
CREATE INDEX ix_events_job ON call_events(job_id) WHERE job_id IS NOT NULL;

-- ---------- 作业 ----------
CREATE TABLE jobs (
  job_id         TEXT    PRIMARY KEY,
  type           TEXT    NOT NULL CHECK (type IN (
                   'login','sync','audio_fetch','asr','analysis','reprocess','backfill')),
  status         TEXT    NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  stage          TEXT    CHECK (stage IS NULL OR stage IN ('audio','transcript','analysis')),
  priority       INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 999),
  account_id     TEXT    REFERENCES accounts(account_id) ON DELETE SET NULL,
  call_id        TEXT    REFERENCES calls(call_id) ON DELETE SET NULL,
  trigger        TEXT    NOT NULL DEFAULT 'pipeline'
                 CHECK (trigger IN ('api','scheduler','pipeline','manual')),
  payload_json   TEXT    NOT NULL DEFAULT '{}',
  idempotency_key TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts   INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  next_run_at    TEXT,
  started_at     TEXT,
  finished_at    TEXT,
  duration_ms    INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  last_error_code TEXT,
  last_error_message TEXT,
  progress_json  TEXT,
  result_json    TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE INDEX ix_jobs_queue ON jobs(status, next_run_at, priority)
  WHERE status IN ('queued','running');
CREATE INDEX ix_jobs_type_status ON jobs(type, status, created_at DESC);
CREATE INDEX ix_jobs_call_stage ON jobs(call_id, stage, created_at DESC) WHERE call_id IS NOT NULL;
CREATE INDEX ix_jobs_account_started ON jobs(account_id, created_at DESC) WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX ux_jobs_active_call_stage
  ON jobs(call_id, type, stage) WHERE call_id IS NOT NULL AND status IN ('queued','running');
CREATE UNIQUE INDEX ux_jobs_active_login
  ON jobs(account_id) WHERE type = 'login' AND status IN ('queued','running');

-- ---------- 词表 ----------
CREATE TABLE term_rules (
  term_id      TEXT    PRIMARY KEY,
  to_term      TEXT    NOT NULL CHECK (length(to_term) BETWEEN 1 AND 32),
  from_aliases_json TEXT NOT NULL DEFAULT '[]',
  category     TEXT    CHECK (category IS NULL OR category IN ('company','product','person','custom')),
  priority     INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 999),
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  case_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (case_sensitive IN (0,1)),
  source       TEXT    CHECK (source IS NULL OR source IN ('builtin','import','manual')),
  note         TEXT,
  deleted_at   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version      INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE UNIQUE INDEX ux_terms_to_active ON term_rules(to_term) WHERE deleted_at IS NULL;
CREATE INDEX ix_terms_category ON term_rules(category, enabled) WHERE deleted_at IS NULL;
CREATE INDEX ix_terms_enabled ON term_rules(enabled, priority DESC, to_term) WHERE deleted_at IS NULL;

-- ---------- 同步游标 ----------
CREATE TABLE sync_cursors (
  account_id     TEXT    PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  mode           TEXT    NOT NULL DEFAULT 'incremental'
                 CHECK (mode IN ('incremental','full','backfill')),
  last_create_time_ms INTEGER CHECK (last_create_time_ms IS NULL OR last_create_time_ms >= 0),
  last_upstream_call_id TEXT,
  overlap_lookback_ms INTEGER NOT NULL DEFAULT 172800000 CHECK (overlap_lookback_ms >= 0),
  window_begin_date TEXT,
  window_end_date   TEXT,
  last_job_id    TEXT,
  last_started_at TEXT,
  last_success_at TEXT,
  last_error_code TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  fetched_total  INTEGER NOT NULL DEFAULT 0 CHECK (fetched_total >= 0),
  upserted_total INTEGER NOT NULL DEFAULT 0 CHECK (upserted_total >= 0),
  backfill_state_json TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE INDEX ix_sync_last_success ON sync_cursors(last_success_at);

-- ---------- 审计（只追加） ----------
CREATE TABLE audit_logs (
  audit_id    TEXT    PRIMARY KEY,
  occurred_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor       TEXT    NOT NULL CHECK (actor IN ('local-api','cli','mcp','scheduler','system')),
  action      TEXT    NOT NULL,
  target_type TEXT    CHECK (target_type IS NULL OR target_type IN (
                'account','call','job','term','config','audio','transcript','data')),
  target_id   TEXT,
  account_id  TEXT,
  request_id  TEXT,
  source_ip   TEXT,
  result      TEXT    NOT NULL CHECK (result IN ('success','failed')),
  error_code  TEXT,
  details_redacted_json TEXT NOT NULL DEFAULT '{}',
  CHECK (length(details_redacted_json) <= 4096)
) STRICT;

CREATE INDEX ix_audit_occurred ON audit_logs(occurred_at DESC);
CREATE INDEX ix_audit_target ON audit_logs(target_type, target_id, occurred_at DESC);
CREATE INDEX ix_audit_action ON audit_logs(action, occurred_at DESC);
CREATE INDEX ix_audit_actor ON audit_logs(actor, occurred_at DESC);

CREATE TRIGGER trg_audit_logs_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

-- ---------- 幂等键 ----------
CREATE TABLE idempotency_keys (
  scope          TEXT    NOT NULL CHECK (scope IN (
                   'calls.create','sync.start','calls.reprocess','accounts.login')),
  idem_key       TEXT    NOT NULL CHECK (length(idem_key) BETWEEN 1 AND 128),
  request_hash   TEXT    NOT NULL CHECK (length(request_hash) = 64),
  status         TEXT    NOT NULL DEFAULT 'in_progress'
                 CHECK (status IN ('in_progress','succeeded','failed')),
  http_status    INTEGER,
  resource_type  TEXT    CHECK (resource_type IS NULL OR resource_type IN ('call','job','account')),
  resource_id    TEXT,
  response_json  TEXT,
  account_id     TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at   TEXT,
  expires_at     TEXT    NOT NULL,
  PRIMARY KEY (scope, idem_key)
) STRICT, WITHOUT ROWID;

CREATE INDEX ix_idem_expiry ON idempotency_keys(expires_at);
CREATE INDEX ix_idem_status ON idempotency_keys(status, created_at);

-- ---------- 基础种子数据 ----------
-- 内置词表（source=builtin；可被 PUT /terms 全量替换，替换后 source 变化）
INSERT INTO term_rules (term_id, to_term, from_aliases_json, category, priority, enabled, case_sensitive, source)
VALUES
 ('term_01J8Z00000000000000000000', '孚盟', '["复萌","福梦","复盟"]', 'company', 100, 1, 0, 'builtin');
