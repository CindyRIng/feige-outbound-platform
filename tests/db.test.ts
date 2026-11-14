// M1 数据层测试：迁移 + Repo 全方法（node:test，编译后运行 dist/tests/db.test.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openRepo } from '../src/db/sqlite.js';
import type { Repo } from '../src/db/repo.js';
import type { Account, Call, Transcript, TranscriptSegment, AnalysisResult, Job, TermRule } from '../src/types/domain.js';
import { AppError } from '../src/errors.js';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const T0 = '2026-11-14T02:00:00.000Z';
const T1 = '2026-11-14T02:05:00.000Z';
const T2 = '2026-11-14T02:10:00.000Z';
function iso(offsetSec = 0): string { return new Date(Date.parse(T0) + offsetSec * 1000).toISOString(); }
function future(sec = 3600): string { return new Date(Date.now() + sec * 1000).toISOString(); }

interface Ctx { repo: Repo; dir: string; dbPath: string; }
async function setup(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'fop-db-test-'));
  const dbPath = join(dir, 'fop.db');
  const repo = await openRepo(dbPath);
  await repo.migrate();
  return { repo, dir, dbPath };
}
async function teardown(ctx: Ctx): Promise<void> {
  await ctx.repo.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}
function mkAccount(over: Partial<Account> = {}): Account {
  return {
    accountId: 'main',
    displayName: '主账号',
    upstreamUsername: '156****0075',
    enabled: true,
    concurrency: 1,
    browserHeadless: false,
    browserProfileDir: 'main',
    metadata: { team: 'sales' },
    state: 'unknown',
    createdAt: iso(),
    updatedAt: iso(),
    ...over,
  };
}
function mkCall(over: Partial<Call> = {}): Call {
  return {
    callId: 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N',
    accountId: 'main',
    upstreamCallId: '2121158093386702849',
    direction: 'outbound',
    toPhone: '186****3330',
    fromPhone: '156****0075',
    lineNumber: '180****0053',
    status: 'ended',
    audioStatus: 'ready',
    transcriptStatus: 'pending',
    analysisStatus: 'pending',
    createdAt: iso(),
    updatedAt: iso(),
    version: 1,
    ...over,
  };
}
function mkTranscript(over: Partial<Transcript> = {}): Transcript {
  return {
    transcriptId: 'tr_01J8Z0000000000000000000A',
    callId: 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N',
    source: 'asr',
    provider: 'minimax:asr-1.0',
    status: 'pending',
    isCurrent: true,
    language: 'zh-CN',
    fullText: '喂，你好，我是孚盟的销售',
    fullTextRaw: '喂，你好，我是复萌的销售',
    needsReview: false,
    createdAt: iso(),
    updatedAt: iso(),
    ...over,
  };
}
function mkSegment(idx: number, over: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    segmentId: `seg_01J8Z0000000000000000000${idx}`,
    transcriptId: 'tr_01J8Z0000000000000000000A',
    callId: 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N',
    idx,
    beginMs: idx * 3000,
    endMs: idx * 3000 + 2800,
    speakerLabel: idx % 2 === 0 ? 'S1' : 'S2',
    chunkIndex: 0,
    role: idx % 2 === 0 ? 'agent' : 'customer',
    rawText: idx % 2 === 0 ? '喂，你好' : '嗯，我是',
    normalizedText: idx % 2 === 0 ? '喂，你好' : '嗯，我是',
    ...over,
  };
}
function mkAnalysis(over: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    analysisId: 'ana_01J8Z0000000000000000000A',
    callId: 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N',
    status: 'pending',
    isCurrent: true,
    provider: 'deepseek',
    model: 'deepseek-chat',
    promptVersion: 'analysis-v1',
    summary: '客户有初步兴趣',
    summaryBulletsJson: JSON.stringify(['客户为外贸公司', '对系统有兴趣']),
    intentLabel: '中意向',
    intentScore: 0.6,
    keywordsJson: JSON.stringify(['外贸', 'CRM']),
    needsReview: false,
    createdAt: iso(),
    updatedAt: iso(),
    ...over,
  };
}
function mkJob(over: Partial<Job> = {}): Job {
  return {
    jobId: 'job_01J8Z0000000000000000000A',
    type: 'asr',
    status: 'queued',
    priority: 100,
    accountId: 'main',
    callId: 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N',
    attempts: 0,
    maxAttempts: 5,
    scheduledAt: iso(),
    createdAt: iso(),
    updatedAt: iso(),
    ...over,
  };
}
function mkTerm(over: Partial<TermRule> = {}): TermRule {
  return {
    termId: 'term_01J8Z0000000000000000000A',
    from: ['复萌', '福梦'],
    to: '孚盟-测试',
    category: 'company',
    priority: 100,
    enabled: true,
    caseSensitive: false,
    createdAt: iso(),
    updatedAt: iso(),
    ...over,
  };
}
async function seeded(): Promise<Ctx> {
  const ctx = await setup();
  await ctx.repo.createAccount(mkAccount());
  return ctx;
}

// ---------------------------------------------------------------------------
// 迁移与库级约束
// ---------------------------------------------------------------------------
test('migrate：建 15 张表 + schema_version，幂等，统计可用', async () => {
  const ctx = await setup();
  try {
    assert.equal(await ctx.repo.schemaVersion(), 2);
    const stats = await ctx.repo.stats();
    assert.equal(stats.schemaVersion, 2);
    assert.ok(stats.sizeBytes > 0);
    assert.ok(stats.latencyMs >= 0);
    assert.ok((await ctx.repo.ping()) >= 0);
    // 幂等：重复 migrate 不报错、版本不变
    await ctx.repo.migrate();
    assert.equal(await ctx.repo.schemaVersion(), 2);
    // 表数量校验（业务表 15 + sqlite_sequence）
    const raw = new DatabaseSync(ctx.dbPath);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    raw.close();
    const expected = ['accounts', 'account_sessions', 'calls', 'audio_assets', 'transcripts', 'transcript_segments',
      'analysis_results', 'transcript_chunks', 'call_events', 'jobs', 'term_rules', 'sync_cursors',
      'idempotency_keys', 'audit_logs', 'schema_version'];
    for (const t of expected) assert.ok(tables.includes(t), `缺少表 ${t}`);
    assert.ok(tables.length >= expected.length + 1); // sqlite_sequence
    // 迁移 0002：内置「孚盟」词表必须覆盖 docs/13 §5 的 9 个同音变体
    const fumeng = (await ctx.repo.listTermRules({ enabled: true })).find(r => r.to === '孚盟');
    assert.ok(fumeng, '缺少内置「孚盟」词条');
    for (const v of ['复萌', '复盟', '福萌', '福盟', '富盟', '福梦', '弗盟', '孚蒙', '福蒙']) assert.ok(fumeng!.from.includes(v), `内置词表缺少变体 ${v}`);
  } finally { await teardown(ctx); }
});

test('DB CHECK：非法 status/source/job type/event type 被拒', async () => {
  const ctx = await seeded();
  try {
    await ctx.repo.insertCall(mkCall());
    const raw = new DatabaseSync(ctx.dbPath);
    const expectThrow = (sql: string): void => {
      assert.throws(() => raw.prepare(sql).run(), /CHECK|constraint/i);
    };
    expectThrow("INSERT INTO calls (call_id, account_id, to_phone, status, started_at) VALUES ('call_bad','main','138****0000','bogus','2026-11-14T02:00:00.000Z')");
    expectThrow("INSERT INTO transcripts (transcript_id, call_id, source, provider) VALUES ('tr_bad','call_01J8Z3K5T9QW2M4R7X1C6V0B8N','upstream','x')");
    expectThrow("INSERT INTO jobs (job_id, type, status) VALUES ('job_bad','transcript_fetch','queued')");
    expectThrow("INSERT INTO call_events (event_id, type, occurred_at) VALUES ('evt_bad','call.bogus','2026-11-14T02:00:00.000Z')");
    expectThrow("INSERT INTO calls (call_id, account_id, to_phone, status, transcript_source, started_at) VALUES ('call_bad2','main','138****0000','ended','upstream','2026-11-14T02:00:00.000Z')");
    raw.close();
  } finally { await teardown(ctx); }
});

test('迁移篡改检测：checksum 不一致拒绝 migrate', async () => {
  const ctx = await setup();
  try {
    const raw = new DatabaseSync(ctx.dbPath);
    raw.prepare("UPDATE schema_version SET checksum = '" + 'd'.repeat(64) + "'").run();
    raw.close();
    await assert.rejects(() => ctx.repo.migrate(), (e: unknown) => e instanceof AppError && e.code === 'CONFIG_INVALID');
  } finally { await teardown(ctx); }
});

// ---------------------------------------------------------------------------
// accounts / sessions
// ---------------------------------------------------------------------------
test('accounts：CRUD、软删除、唯一键释放、会话字段映射', async () => {
  const ctx = await setup();
  try {
    await ctx.repo.createAccount(mkAccount());
    const acc = await ctx.repo.getAccount('main');
    assert.ok(acc);
    assert.equal(acc.displayName, '主账号');
    assert.equal(acc.enabled, true);
    assert.deepEqual(acc.metadata, { team: 'sales' });
    assert.equal(acc.browserProfileDir, 'main');
    assert.equal((await ctx.repo.listAccounts()).length, 1);
    assert.equal((await ctx.repo.listAccounts({ enabled: false })).length, 0);

    // 重复活跃账号（同 upstream_username）应被拒绝
    await assert.rejects(() => ctx.repo.createAccount(mkAccount({ accountId: 'main2' })), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_FAILED');

    // 账会字段更新 + 会话字段（jwtExpiresAt/lastLoginAt/state）落 account_sessions
    const exp = future(3600);
    const updated = await ctx.repo.updateAccount('main', {
      displayName: '主账号-改', metadata: { team: 'ops' },
      jwtExpiresAt: exp, lastLoginAt: T1, lastCheckedAt: T2, state: 'online',
    } as Partial<Account>);
    assert.ok(updated);
    assert.equal(updated.displayName, '主账号-改');
    assert.equal(updated.enabled, true);
    assert.deepEqual(updated.metadata, { team: 'ops' });
    assert.equal(updated.jwtExpiresAt, exp);
    assert.equal(updated.lastLoginAt, T1);
    assert.equal(updated.state, 'online');
    // 停用优先于会话状态（派生 state=disabled）
    const disabledAcc = await ctx.repo.updateAccount('main', { enabled: false });
    assert.equal(disabledAcc!.enabled, false);
    assert.equal(disabledAcc!.state, 'disabled');

    // 软删除后同 upstream_username 可重新接入（唯一索引释放）
    await ctx.repo.removeAccount('main');
    const removed = await ctx.repo.getAccount('main');
    assert.ok(removed);
    assert.ok(removed.deletedAt);
    assert.equal(removed.enabled, false);
    assert.equal(await ctx.repo.getSession('main'), null);
    await ctx.repo.createAccount(mkAccount({ accountId: 'main3', displayName: '新账号' }));
    assert.equal((await ctx.repo.listAccounts()).length, 1);

    // 不存在的账号
    await assert.rejects(() => ctx.repo.removeAccount('nope'), (e: unknown) => e instanceof AppError && e.code === 'ACCOUNT_NOT_FOUND');

    // 有历史话单时禁止硬删除（FK RESTRICT）
    await ctx.repo.insertCall(mkCall({ callId: 'call_01J8Z3K5T9QW2M4R7X1C6V0B8B', accountId: 'main3' }));
    await assert.rejects(() => ctx.repo.hardDeleteAccount('main3'), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_FAILED');

    const stats = await ctx.repo.accountStats('main3');
    assert.equal(stats.totalCalls, 1);
    assert.equal(stats.calls24h, 1);
    assert.ok(stats.lastCallAt);
  } finally { await teardown(ctx); }
});

test('sessions：写读映射（token/cookieState/state/json 列）', async () => {
  const ctx = await seeded();
  try {
    await ctx.repo.upsertSession({
      accountId: 'main', token: 'eyJhbGciOiJIUzI1NiJ9.fake-token', tokenKeyId: 'plain-v1',
      wsConnected: true, lastPongAt: T2, state: 'online', loginState: 'authenticated',
      loginFailCount: 2, lastLoginJobId: 'job_x', healthStatus: 'healthy',
      healthDetailJson: JSON.stringify({ latencyMs: 12 }), updatedAt: iso(),
    });
    const s = await ctx.repo.getSession('main');
    assert.ok(s);
    assert.equal(s.token, 'eyJhbGciOiJIUzI1NiJ9.fake-token');
    assert.equal(s.tokenKeyId, 'plain-v1');
    assert.equal(s.cookieState, 'valid');
    assert.equal(s.wsConnected, true);
    assert.equal(s.lastPongAt, T2);
    assert.equal(s.healthStatus, 'healthy');
    assert.deepEqual(JSON.parse(s.healthDetailJson ?? '{}'), { latencyMs: 12 });

    // upsert 更新 + version 递增
    await ctx.repo.upsertSession({ ...(s as any), wsConnected: false, state: 'expired', loginState: 'expired', updatedAt: iso(60) });
    const s2 = await ctx.repo.getSession('main');
    assert.ok(s2);
    assert.equal(s2.wsConnected, false);
    assert.equal(s2.state, 'expired');
    assert.ok((s2.version ?? 1) > (s.version ?? 1));

    await ctx.repo.deleteSession('main');
    assert.equal(await ctx.repo.getSession('main'), null);
  } finally { await teardown(ctx); }
});

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------
test('calls：插入/读取/映射（cost、upstreamStatus、pipelineLastError）与 CAS', async () => {
  const ctx = await seeded();
  try {
    await ctx.repo.insertCall(mkCall({
      cost: 0.14,
      upstreamStatusJson: JSON.stringify({ callStatus: 1, callStatusName: '已接通', finishStatus: 4, finishStatusName: '其他' }),
      upstreamRawJson: JSON.stringify({ id: '2121158093386702849' }),
      transcriptStatus: 'ready',
      pipelineLastErrorJson: JSON.stringify({ code: 'ASR_FAILED', stage: 'transcript' }),
      dialState: 'sent',
      handleStatus: 1,
      metadataJson: JSON.stringify({ campaign: 'a' }),
    }));
    const c = await ctx.repo.getCall('call_01J8Z3K5T9QW2M4R7X1C6V0B8N');
    assert.ok(c);
    assert.equal(c.accountId, 'main');
    assert.equal(c.status, 'ended');
    assert.equal(c.cost, 0.14);
    assert.equal(c.transcriptStatus, 'ready');
    assert.equal(c.dialState, 'sent');
    assert.equal(c.handleStatus, 1);
    assert.equal(c.version, 1);
    assert.deepEqual(JSON.parse(c.upstreamStatusJson ?? '{}'), { callStatus: 1, callStatusName: '已接通', finishStatus: 4, finishStatusName: '其他' });
    assert.deepEqual(JSON.parse(c.metadataJson ?? '{}'), { campaign: 'a' });
    assert.deepEqual(JSON.parse(c.pipelineLastErrorJson ?? '{}').code, 'ASR_FAILED');
    assert.ok(c.startedAt);

    // CAS：版本不匹配 → null；匹配 → 更新且 version+1
    const fail = await ctx.repo.updateCall('call_01J8Z3K5T9QW2M4R7X1C6V0B8N', { status: 'failed' }, 99);
    assert.equal(fail, null);
    const ok = await ctx.repo.updateCall('call_01J8Z3K5T9QW2M4R7X1C6V0B8N', { status: 'failed', errorCode: 'CALL_REJECTED_BY_UPSTREAM', statusReason: '被上游拒绝' }, 1);
    assert.ok(ok);
    assert.equal(ok.status, 'failed');
    assert.equal(ok.errorCode, 'CALL_REJECTED_BY_UPSTREAM');
    assert.equal(ok.statusReason, '被上游拒绝');
    assert.equal(ok.version, 2);

    // 按上游 ID 查
    const byUp = await ctx.repo.getCallByUpstream('main', '2121158093386702849');
    assert.ok(byUp);
    assert.equal(byUp.callId, c.callId);

    // 状态计数
    assert.equal(await ctx.repo.countByStatus('failed'), 1);
    assert.equal(await ctx.repo.countOpenCalls('main'), 0);
  } finally { await teardown(ctx); }
});

test('calls：listCalls 过滤/排序/分页/q 搜索/日期', async () => {
  const ctx = await seeded();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const callId = `call_01J8Z0000000000000000000${i}`;
      ids.push(callId);
      await ctx.repo.insertCall(mkCall({
        callId, upstreamCallId: `21211580933867028${40 + i}`,
        status: i === 3 ? 'no_answer' : 'ended',
        toPhone: i === 0 ? '13800000001' : `186****${String(3000 + i)}`,
        audioStatus: i === 1 ? 'missing' : 'ready',
        transcriptStatus: i === 2 ? 'ready' : 'pending',
        startedAt: iso(i * 600),
        createdAt: iso(i * 600),
        updatedAt: iso(i * 600),
      }));
    }
    // q 搜索：给 call 2 建当前转写，命中关键词
    await ctx.repo.updateCall(ids[2], { transcriptStatus: 'ready' });
    await ctx.repo.createTranscript(mkTranscript({ callId: ids[2] }));
    const q = await ctx.repo.listCalls({ page: 1, size: 10, q: '复萌' });
    assert.equal(q.total, 1);
    assert.equal(q.items[0].callId, ids[2]);

    // 默认排序 -createdAt（内部 started_at DESC）
    const all = await ctx.repo.listCalls({ page: 1, size: 10 });
    assert.equal(all.total, 5);
    assert.equal(all.items[0].callId, ids[4]);

    // 升序 + 分页
    const p1 = await ctx.repo.listCalls({ page: 1, size: 2, sort: 'createdAt' });
    const p2 = await ctx.repo.listCalls({ page: 2, size: 2, sort: 'createdAt' });
    assert.equal(p1.items.length, 2);
    assert.equal(p1.items[0].callId, ids[0]);
    assert.equal(p2.items[0].callId, ids[2]);
    assert.equal(p2.total, 5);

    // status/hasAudio/hasTranscript/pipeline 过滤
    assert.equal((await ctx.repo.listCalls({ page: 1, size: 10, statuses: ['no_answer'] })).total, 1);
    assert.equal((await ctx.repo.listCalls({ page: 1, size: 10, hasAudio: false })).total, 1);
    assert.equal((await ctx.repo.listCalls({ page: 1, size: 10, hasTranscript: true })).total, 1);
    assert.equal((await ctx.repo.listCalls({ page: 1, size: 10, pipelineTranscript: ['pending'] })).total, 4);

    // 号码过滤（完整/后缀）
    const full = await ctx.repo.listCalls({ page: 1, size: 10, toPhoneLike: '13800000001' });
    assert.equal(full.total, 1);
    const suffix = await ctx.repo.listCalls({ page: 1, size: 10, toPhoneLike: '*3001' });
    assert.equal(suffix.total, 1);

    // 日期过滤（Asia/Shanghai 自然日）：T0 北京 10:00 → 同一自然日
    const day = await ctx.repo.listCalls({ page: 1, size: 10, dateFrom: '2026-11-14', dateTo: '2026-11-14' });
    assert.equal(day.total, 5);
    const otherDay = await ctx.repo.listCalls({ page: 1, size: 10, dateFrom: '2026-11-15', dateTo: '2026-11-15' });
    assert.equal(otherDay.total, 0);

    // 非法排序/分页
    await assert.rejects(() => ctx.repo.listCalls({ page: 1, size: 10, sort: 'bogus' }), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_FAILED');
    await assert.rejects(() => ctx.repo.listCalls({ page: 0, size: 10 }), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_FAILED');
    await assert.rejects(() => ctx.repo.listCalls({ page: 1, size: 500 }), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_FAILED');

    // 阶段队列辅助
    const pendingCounts = await ctx.repo.pipelinePendingCounts();
    assert.equal(pendingCounts.transcriptPending, 4);
    const byStage = await ctx.repo.listCallsByStage('transcript', 10);
    assert.equal(byStage.length, 4);

    // findRecentDial
    const recent = await ctx.repo.findRecentDial('main', '13800000001', iso(-60));
    assert.ok(recent);
  } finally { await teardown(ctx); }
});

// ---------------------------------------------------------------------------
// audio / transcript / analysis / chunks
// ---------------------------------------------------------------------------
test('audio：upsert 幂等与映射', async () => {
  const ctx = await seeded();
  try {
    await ctx.repo.insertCall(mkCall());
    await ctx.repo.upsertAudio({
      audioId: 'aud_01J8Z0000000000000000000A', callId: 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N',
      sourceUrl: 'http://<redacted-host>/<redacted-url>', storagePath: 'audio/2026/11/14/call.wav',
      format: 'wav', sampleRate: 16000, channels: 1, durationMs: 10356, sizeBytes: 331392,
      sha256: 'a'.repeat(64), downloadedAt: T1,
    });
    const a = await ctx.repo.getAudioByCall('call_01J8Z3K5T9QW2M4R7X1C6V0B8N');
    assert.ok(a);
    assert.equal(a.sampleRate, 16000);
    assert.equal(a.channels, 1);
    assert.equal(a.durationMs, 10356);
    assert.equal(a.downloadedAt, T1);
    // 重复 upsert 不报错
    await ctx.repo.upsertAudio({ ...a!, sha256: 'b'.repeat(64) });
    assert.equal((await ctx.repo.getAudioByCall('call_01J8Z3K5T9QW2M4R7X1C6V0B8N'))!.sha256, 'b'.repeat(64));
  } finally { await teardown(ctx); }
});

test('transcripts：版本切换、分段替换、chunk 回填、状态来源 calls', async () => {
  const ctx = await seeded();
  try {
    await ctx.repo.insertCall(mkCall());
    await ctx.repo.updateCall('call_01J8Z3K5T9QW2M4R7X1C6V0B8N', { transcriptStatus: 'in_progress' });
    // 分块计划（chunk 状态 domain 用 ready/missing，写库映射 succeeded/skipped）
    await ctx.repo.upsertChunk({
      chunkId: 'chk_01J8Z0000000000000000000A', callId: 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N',
      revision: 1, chunkIndex: 0, beginMs: 0, endMs: 420000, forcedCut: false, status: 'ready',
      resultPath: 'asr/call_x/chunk-0.json', resultSha256: 'c'.repeat(64), providerTraceId: 'trace-1',
      segmentCount: 3, attempts: 1, createdAt: iso(), updatedAt: iso(),
    });
    const chunks = await ctx.repo.listChunks('call_01J8Z3K5T9QW2M4R7X1C6V0B8N', 1);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].status, 'ready');

    await ctx.repo.createTranscript(mkTranscript({ isCurrent: true }));
    // chunk 回填 transcript_id
    const rawChunk = await (async () => {
      const { DatabaseSync } = await import('node:sqlite');
      const raw = new DatabaseSync(ctx.dbPath);
      const row = raw.prepare('SELECT transcript_id FROM transcript_chunks WHERE chunk_id = ?').get('chk_01J8Z0000000000000000000A') as any;
      raw.close();
      return row;
    })();
    assert.equal(rawChunk.transcript_id, 'tr_01J8Z0000000000000000000A');

    const segs = [mkSegment(0), mkSegment(1), mkSegment(2)];
    await ctx.repo.replaceSegments('tr_01J8Z0000000000000000000A', 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N', segs);
    assert.equal(await ctx.repo.countSegments('tr_01J8Z0000000000000000000A'), 3);
    const listed = await ctx.repo.listSegments('tr_01J8Z0000000000000000000A');
    assert.equal(listed.length, 3);
    assert.equal(listed[1].role, 'customer');
    assert.equal(listed[0].speakerLabel, 'S1');
    assert.equal(listed[0].callId, 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N');

    // ready 后状态来自 calls.transcript_status
    await ctx.repo.updateCall('call_01J8Z3K5T9QW2M4R7X1C6V0B8N', { transcriptStatus: 'ready' });
    const cur = await ctx.repo.getCurrentTranscript('call_01J8Z3K5T9QW2M4R7X1C6V0B8N');
    assert.ok(cur);
    assert.equal(cur.status, 'ready');
    assert.equal(cur.revision, 1);
    assert.equal(cur.source, 'asr');
    assert.equal(cur.chunkCount, 1);
    assert.equal(cur.segmentCount, 3);

    // 新版本：revision+1，旧版本 is_current=0
    await ctx.repo.createTranscript(mkTranscript({ transcriptId: 'tr_01J8Z0000000000000000000B', isCurrent: true, fullText: 'v2' }));
    const cur2 = await ctx.repo.getCurrentTranscript('call_01J8Z3K5T9QW2M4R7X1C6V0B8N');
    assert.equal(cur2!.transcriptId, 'tr_01J8Z0000000000000000000B');
    assert.equal(cur2!.revision, 2);
    assert.equal(await ctx.repo.updateTranscript('tr_01J8Z0000000000000000000A', { needsReview: true }) !== null, true);
    await ctx.repo.markOtherTranscriptsNotCurrent('call_01J8Z3K5T9QW2M4R7X1C6V0B8N', 'tr_01J8Z0000000000000000000B');
    // 新版本非 current → 查询 current 仍返回 B
    const after = await ctx.repo.getCurrentTranscript('call_01J8Z3K5T9QW2M4R7X1C6V0B8N');
    assert.equal(after!.transcriptId, 'tr_01J8Z0000000000000000000B');
  } finally { await teardown(ctx); }
});

test('analysis：版本化、current 切换、JSON 列映射', async () => {
  const ctx = await seeded();
  try {
    await ctx.repo.insertCall(mkCall());
    await ctx.repo.updateCall('call_01J8Z3K5T9QW2M4R7X1C6V0B8N', { analysisStatus: 'ready' });
    await ctx.repo.createAnalysis(mkAnalysis({
      paramsJson: JSON.stringify({ temperature: 0.2, maxTokens: 2000 }),
      usageJson: JSON.stringify({ promptTokens: 208, completionTokens: 265 }),
      speakerMappingJson: JSON.stringify({ method: 'asr_diarization', confidence: 0.86 }),
      resultJson: JSON.stringify({ summary: { short: '客户有初步兴趣' } }),
    }));
    const a = await ctx.repo.getCurrentAnalysis('call_01J8Z3K5T9QW2M4R7X1C6V0B8N');
    assert.ok(a);
    assert.equal(a.status, 'ready');
    assert.equal(a.model, 'deepseek-chat');
    assert.equal(a.promptVersion, 'analysis-v1');
    assert.equal(a.intentLabel, '中意向');
    assert.equal(a.intentScore, 0.6);
    assert.deepEqual(JSON.parse(a.summaryJson ?? '{}'), { short: '客户有初步兴趣', bullets: ['客户为外贸公司', '对系统有兴趣'] });
    assert.deepEqual(JSON.parse(a.usageJson ?? '{}'), { promptTokens: 208, completionTokens: 265 });
    assert.equal(JSON.parse(a.speakerMappingJson ?? '{}').method, 'asr_diarization');

    // 新版本切换 current
    await ctx.repo.createAnalysis(mkAnalysis({ analysisId: 'ana_01J8Z0000000000000000000B', model: 'deepseek-v4-pro', isCurrent: true, summary: 'v2' }));
    const cur = await ctx.repo.getCurrentAnalysis('call_01J8Z3K5T9QW2M4R7X1C6V0B8N');
    assert.equal(cur!.analysisId, 'ana_01J8Z0000000000000000000B');
    assert.equal(cur!.revision, 2);
    assert.equal(cur!.model, 'deepseek-v4-pro');
    const upd = await ctx.repo.updateAnalysis('ana_01J8Z0000000000000000000B', { needsReview: true, intentLabel: '高意向' });
    assert.ok(upd);
    assert.equal(upd.needsReview, true);
    assert.equal(upd.intentLabel, '高意向');
    await ctx.repo.markOtherAnalysesNotCurrent('call_01J8Z3K5T9QW2M4R7X1C6V0B8N', 'ana_01J8Z0000000000000000000B');
    assert.equal((await ctx.repo.getCurrentAnalysis('call_01J8Z3K5T9QW2M4R7X1C6V0B8N'))!.analysisId, 'ana_01J8Z0000000000000000000B');
  } finally { await teardown(ctx); }
});

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------
test('events：插入/查询/前缀过滤/单通话时间线', async () => {
  const ctx = await seeded();
  try {
    await ctx.repo.insertCall(mkCall());
    const events = [
      { eventId: 'evt_A', type: 'call.created' as const, occurredAt: iso(0) },
      { eventId: 'evt_B', type: 'call.ended' as const, occurredAt: iso(1) },
      { eventId: 'evt_C', type: 'call.transcript.ready' as const, occurredAt: iso(2) },
      { eventId: 'evt_D', type: 'job.updated' as const, occurredAt: iso(3) },
    ];
    for (const e of events) {
      await ctx.repo.insertEvent({
        ...e, accountId: 'main', callId: 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N',
        jobId: e.type === 'job.updated' ? 'job_x' : null,
        dataJson: JSON.stringify({ idx: e.eventId }), createdAt: e.occurredAt,
      });
    }
    const all = await ctx.repo.listEvents({ page: 1, size: 10 });
    assert.equal(all.total, 4);
    assert.equal(all.items[0].eventId, 'evt_D'); // 默认 occurredAt DESC

    const callOnly = await ctx.repo.listEvents({ page: 1, size: 10, types: ['call.*'] });
    assert.equal(callOnly.total, 3);
    const exact = await ctx.repo.listEvents({ page: 1, size: 10, types: ['job.updated'] });
    assert.equal(exact.total, 1);
    const since = await ctx.repo.listEvents({ page: 1, size: 10, since: iso(2) });
    assert.equal(since.total, 2);

    const timeline = await ctx.repo.listCallEvents('call_01J8Z3K5T9QW2M4R7X1C6V0B8N');
    assert.equal(timeline.length, 4);
    assert.equal(timeline[0].eventId, 'evt_A');
    assert.equal(timeline[3].eventId, 'evt_D');

    // 非法事件类型被校验拒绝
    await assert.rejects(() => ctx.repo.insertEvent({ eventId: 'evt_X', type: 'call.bogus' as any, occurredAt: iso(9), dataJson: '{}', createdAt: iso(9) }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_FAILED');
  } finally { await teardown(ctx); }
});

// ---------------------------------------------------------------------------
// jobs（租约/领取/恢复）
// ---------------------------------------------------------------------------
test('jobs：claimJob 租约、recoverExpiredJobs、更新与统计', async () => {
  const ctx = await seeded();
  try {
    await ctx.repo.insertCall(mkCall());
    const j1 = mkJob({ jobId: 'job_01J8Z0000000000000000000A', type: 'asr', scheduledAt: iso(0) });
    const j2 = mkJob({ jobId: 'job_01J8Z0000000000000000000B', type: 'analysis', scheduledAt: iso(0) });
    const j3 = mkJob({ jobId: 'job_01J8Z0000000000000000000C', type: 'asr', scheduledAt: iso(7200) });
    await ctx.repo.insertJob(j1);
    await ctx.repo.insertJob(j2);
    await ctx.repo.insertJob(j3);

    // 只领取 asr：最早 scheduledAt 优先；领取后 running + leaseUntil
    const claimed = await ctx.repo.claimJob(['asr'], iso(10), iso(400));
    assert.ok(claimed);
    assert.equal(claimed.jobId, j1.jobId);
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.attempts, 1);
    assert.ok(claimed.leaseUntil);
    assert.ok(claimed.startedAt);
    // 未到期的 running 不再被领取
    assert.equal(await ctx.repo.claimJob(['asr'], iso(20), iso(500)), null);

    // 未到期 → 不恢复；过期 → 回 queued（attempts 不变）
    assert.equal(await ctx.repo.recoverExpiredJobs(iso(30)), 0);
    const queuedNow = await ctx.repo.recoverExpiredJobs(iso(5000));
    assert.equal(queuedNow, 1);
    const recovered = await ctx.repo.getJob(j1.jobId);
    assert.equal(recovered!.status, 'queued');
    assert.equal(recovered!.attempts, 1);
    assert.equal(recovered!.leaseUntil, null);
    // 立即可再领取
    const reclaimed = await ctx.repo.claimJob(['asr'], iso(5000), iso(5500));
    assert.equal(reclaimed!.jobId, j1.jobId);
    assert.equal(reclaimed!.attempts, 2);

    // 更新为 succeeded + 结果摘要
    const done = await ctx.repo.updateJob(j1.jobId, {
      status: 'succeeded', finishedAt: iso(5600), durationMs: 1200,
      resultJson: JSON.stringify({ transcriptId: 'tr_x' }), leaseUntil: null,
    });
    assert.ok(done);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.durationMs, 1200);
    assert.equal(JSON.parse(done.resultJson ?? '{}').transcriptId, 'tr_x');

    // 失败 + lastErrorJson → last_error_code/message
    const failed = await ctx.repo.updateJob(j2.jobId, {
      status: 'failed', finishedAt: iso(-10),
      lastErrorJson: JSON.stringify({ code: 'ANALYSIS_FAILED', message: 'JSON 不合法' }),
    });
    assert.equal(failed!.lastErrorCode, 'ANALYSIS_FAILED');
    assert.equal(JSON.parse(failed!.lastErrorJson ?? '{}').code, 'ANALYSIS_FAILED');

    const counts = await ctx.repo.jobCounts();
    assert.equal(counts.queued, 1); // j3
    assert.equal(counts.running, 0);
    assert.equal(counts.failed24h, 1);

    const listed = await ctx.repo.listJobs({ page: 1, size: 10, types: ['asr'] });
    assert.equal(listed.total, 2);
    const byStatus = await ctx.repo.listJobsByStatus('asr', 'queued', 10);
    assert.equal(byStatus.length, 1);
    assert.equal(byStatus[0].jobId, j3.jobId);

    // 非法 job type/status
    await assert.rejects(() => ctx.repo.insertJob(mkJob({ jobId: 'job_bad', type: 'transcript_fetch' as any })), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_FAILED');
    await assert.rejects(() => ctx.repo.insertJob(mkJob({ jobId: 'job_bad2', status: 'bogus' as any })), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_FAILED');
  } finally { await teardown(ctx); }
});

// ---------------------------------------------------------------------------
// terms
// ---------------------------------------------------------------------------
test('terms：CRUD、软删除默认排除、全量替换、版本', async () => {
  const ctx = await seeded();
  try {
    await ctx.repo.replaceTermRules([]); // 清空内置种子（迁移种子：孚盟）
    const t1 = await ctx.repo.createTermRule(mkTerm());
    assert.equal(t1.to, '孚盟-测试');
    assert.deepEqual(t1.from, ['复萌', '福梦']);
    assert.equal(t1.enabled, true);

    // 重复 to → VALIDATION_FAILED
    await assert.rejects(() => ctx.repo.createTermRule(mkTerm({ termId: 'term_dup' })), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_FAILED');

    const upd = await ctx.repo.updateTermRule(t1.termId, { from: ['复盟', '福盟'], priority: 200 });
    assert.ok(upd);
    assert.deepEqual(upd.from, ['复盟', '福盟']);
    assert.equal(upd.priority, 200);

    // q 搜索 + enabled 过滤
    assert.equal((await ctx.repo.listTermRules({ q: '孚盟-测试' })).length, 1);
    assert.equal((await ctx.repo.listTermRules({ q: '复盟' })).length, 1);
    assert.equal((await ctx.repo.listTermRules({ enabled: false })).length, 0);

    // 软删除后默认排除、get 返回 null
    assert.equal(await ctx.repo.deleteTermRule(t1.termId), true);
    assert.equal(await ctx.repo.deleteTermRule(t1.termId), false);
    assert.equal((await ctx.repo.listTermRules()).length, 0);
    assert.equal(await ctx.repo.getTermRule(t1.termId), null);

    // 全量替换（旧集软删 + 新集插入）
    const v1 = await ctx.repo.termsVersion();
    await ctx.repo.replaceTermRules([
      mkTerm({ termId: 'term_A', to: '孚盟', from: ['复萌', '福梦', '复盟'] }),
      mkTerm({ termId: 'term_B', to: '孚盟软件', from: ['富盟系统'], category: 'product' }),
    ]);
    const list = await ctx.repo.listTermRules();
    assert.equal(list.length, 2);
    const v2 = await ctx.repo.termsVersion();
    assert.ok(v2 >= v1);

    // 替换时重复标准词 → 拒绝
    await assert.rejects(() => ctx.repo.replaceTermRules([mkTerm({ termId: 'term_C', to: 'X' }), mkTerm({ termId: 'term_D', to: 'X' })]),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_FAILED');
  } finally { await teardown(ctx); }
});

// ---------------------------------------------------------------------------
// cursor / idempotency / audit
// ---------------------------------------------------------------------------
test('sync_cursors：upsert 与映射', async () => {
  const ctx = await seeded();
  try {
    await ctx.repo.upsertCursor({ accountId: 'main', mode: 'incremental', lastCreateTimeMs: 1763083200000, lastUpstreamCallId: '2121158093386702849', lastSyncedAt: T1, updatedAt: T1, fetchedTotal: 100, upsertedTotal: 98, consecutiveFailures: 2 });
    const c = await ctx.repo.getCursor('main');
    assert.ok(c);
    assert.equal(c.mode, 'incremental');
    assert.equal(c.lastCreateTimeMs, 1763083200000);
    assert.equal(c.lastStartTime, '1763083200000');
    assert.equal(c.lastUpstreamCallId, '2121158093386702849');
    assert.equal(c.lastSyncedAt, T1);
    assert.equal(c.fetchedTotal, 100);
    assert.equal(c.consecutiveFailures, 2);
    await ctx.repo.upsertCursor({ ...(c as any), lastCreateTimeMs: 1763083900000, updatedAt: T2 });
    const c2 = await ctx.repo.getCursor('main');
    assert.equal(c2!.lastCreateTimeMs, 1763083900000);
    assert.ok((c2!.lastSyncedAt) === T1);
  } finally { await teardown(ctx); }
});

test('idempotency：创建/冲突/完成/过期清理', async () => {
  const ctx = await seeded();
  try {
    await ctx.repo.createIdempotency({
      key: 'idem-1', scope: 'calls.create', requestHash: 'd'.repeat(64),
      status: 'in_progress', createdAt: iso(), expiresAt: iso(7200),
    });
    const rec = await ctx.repo.getIdempotency('idem-1', 'calls.create');
    assert.ok(rec);
    assert.equal(rec.status, 'in_progress');
    // 同键重复 → IDEMPOTENCY_CONFLICT
    await assert.rejects(() => ctx.repo.createIdempotency({ key: 'idem-1', scope: 'calls.create', requestHash: 'e'.repeat(64), status: 'in_progress', createdAt: iso(), expiresAt: iso(7200) }),
      (e: unknown) => e instanceof AppError && e.code === 'IDEMPOTENCY_CONFLICT');
    await ctx.repo.completeIdempotency('idem-1', 'calls.create', JSON.stringify({ ok: true }));
    const done = await ctx.repo.getIdempotency('idem-1', 'calls.create');
    assert.equal(done!.status, 'completed');
    assert.deepEqual(JSON.parse(done!.responseJson ?? '{}'), { ok: true });
    // 过期清理
    await ctx.repo.createIdempotency({ key: 'idem-2', scope: 'sync.start', requestHash: 'f'.repeat(64), status: 'in_progress', createdAt: iso(), expiresAt: iso(-10) });
    const deleted = await ctx.repo.deleteExpiredIdempotency(iso());
    assert.equal(deleted, 1);
    assert.equal(await ctx.repo.getIdempotency('idem-2', 'sync.start'), null);
  } finally { await teardown(ctx); }
});

test('audit_logs：写入与 actor 校验', async () => {
  const ctx = await seeded();
  try {
    await ctx.repo.insertAudit({
      auditId: 'audit_01J8Z00000000000000000A', actor: 'local-api', action: 'call.dial',
      target: 'call:call_01J8Z3K5T9QW2M4R7X1C6V0B8N', detailJson: JSON.stringify({ to: '138****0000' }), at: T1,
    });
    await ctx.repo.insertAudit({
      auditId: 'audit_01J8Z00000000000000000B', actor: 'system', action: 'data.retention_purge',
      targetType: 'data', result: 'failed', errorCode: 'INTERNAL_ERROR', at: T2,
    });
    const raw = new DatabaseSync(ctx.dbPath);
    const rows = raw.prepare('SELECT audit_id, target_type, target_id, result, action FROM audit_logs ORDER BY occurred_at').all() as any[];
    raw.close();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].target_type, 'call');
    assert.equal(rows[0].target_id, 'call_01J8Z3K5T9QW2M4R7X1C6V0B8N');
    assert.equal(rows[1].result, 'failed');
    assert.equal(rows[0].action, 'call.dial');

    await assert.rejects(() => ctx.repo.insertAudit({ auditId: 'audit_bad', actor: 'hacker', action: 'x', at: T1 }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_FAILED');
  } finally { await teardown(ctx); }
});

test('JSON 列：非法 JSON 被拒绝，合法 JSON 往返一致', async () => {
  const ctx = await seeded();
  try {
    await assert.rejects(() => ctx.repo.insertCall(mkCall({ upstreamRawJson: '{not-json' })), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_FAILED');
    await ctx.repo.insertCall(mkCall());
    await ctx.repo.updateCall('call_01J8Z3K5T9QW2M4R7X1C6V0B8N', { metadataJson: JSON.stringify({ campaign: '双11', note: 'test' }) });
    const c = await ctx.repo.getCall('call_01J8Z3K5T9QW2M4R7X1C6V0B8N');
    assert.deepEqual(JSON.parse(c!.metadataJson ?? '{}'), { campaign: '双11', note: 'test' });
  } finally { await teardown(ctx); }
});
