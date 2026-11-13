import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createReadStream, statSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Services } from './context.js';
import { AppError, asAppError } from '../errors.js';
import { newRequestId } from '../core/ids.js';
import { maskPhone } from '../util/phone.js';
import type { Pagination } from '../types/common.js';
import { safeJson, toJobDetail, toJobSummary } from '../core/jobs.js';
import { toAnalysisPayload } from '../core/calls.js';

export interface CreateServerOptions { services: Services; }
export async function createServer(s: Services): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: false });
  app.decorateRequest('requestId', '');
  app.addHook('onRequest', async (req, reply) => {
    const rid = (req.headers['x-request-id'] as string) || newRequestId();
    (req as any).requestId = rid;
    reply.header('X-Request-Id', rid);
    reply.header('X-Api-Version', '1');
    // auth（全部接口含 /health 都需要 token）
    if (req.url.startsWith('/api/v1/')) {
      const auth = String(req.headers.authorization ?? '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!tokenOk(token, s.token)) throw new AppError('UNAUTHORIZED', '本地 API token 缺失或错误');
    }
  });
  app.setErrorHandler((err, req, reply) => {
    let e: AppError;
    if (err instanceof AppError) e = err;
    else if ((err as any).validation) e = new AppError('VALIDATION_FAILED', (err as any).message ?? '参数校验失败', { details: { fields: (err as any).validation } });
    else if ((err as any).statusCode === 400 || (err as any).code === 'FST_ERR_CTP_INVALID_JSON_BODY') e = new AppError('INVALID_REQUEST', '请求体非法');
    else e = asAppError(err);
    if (!e) e = new AppError('INTERNAL_ERROR', (err as Error)?.message ?? 'unknown');
    void reply.status(e.httpStatus).send(errorBody(e, (req as any).requestId ?? newRequestId()));
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send(errorBody(new AppError('NOT_FOUND', `接口不存在: ${req.method} ${req.url}`), (req as any).requestId ?? newRequestId())));

  const meta = (req: FastifyRequest, pagination?: Pagination, extra: Record<string, unknown> = {}) => ({ requestId: (req as any).requestId, ts: new Date().toISOString(), ...(pagination ? { pagination } : {}), ...extra });
  const ok = (req: FastifyRequest, reply: FastifyReply, data: unknown, pagination?: Pagination, extra: Record<string, unknown> = {}) => reply.send({ ok: true, data, meta: meta(req, pagination, extra) });
  const paging = (page: number, size: number, total: number): Pagination => ({ page, size, total, totalPages: Math.max(1, Math.ceil(total / size)) });

  // ---------------- platform ----------------
  app.get('/api/v1/health', async (req, reply) => ok(req, reply, await s.status.health()));
  app.get('/api/v1/status', async (req, reply) => {
    const detail = String((req.query as any)?.detail ?? 'true') !== 'false';
    return ok(req, reply, await s.status.status(detail));
  });
  app.get('/api/v1/config', async (req, reply) => ok(req, reply, redactConfig(s.config)));
  app.patch('/api/v1/config', async (req, reply) => {
    const body = req.body as Record<string, any>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('INVALID_REQUEST', '请求体必须为对象');
    const allowed = new Set(['server','storage','browser','dial','limits','sync','pipeline','events','logging','backup','runtime']);
    for (const k of Object.keys(body)) if (!allowed.has(k)) throw new AppError('VALIDATION_FAILED', `未知配置节: ${k}`, { details: { fields: [{ field: k, reason: 'unknown' }] } });
    if (JSON.stringify(body).includes('"apiKey"') || JSON.stringify(body).includes('"password"')) throw new AppError('CONFIG_INVALID', '密钥字段不可通过本接口修改', { details: { readonlyFields: ['secrets'] } });
    const r = s.config.patch(body);
    return ok(req, reply, { ...redactConfig(s.config), ...r, config: redactConfig(s.config) });
  });

  // ---------------- accounts ----------------
  app.get('/api/v1/accounts', async (req, reply) => {
    const q = (req.query ?? {}) as any;
    const list = await s.accounts.list({ enabled: q.enabled !== undefined ? q.enabled === 'true' : undefined, state: q.state });
    return ok(req, reply, list);
  });
  app.post('/api/v1/accounts', async (req, reply) => {
    const b = req.body as any;
    const acct = await s.accounts.create(b);
    reply.status(201);
    return ok(req, reply, { accountId: acct.accountId, displayName: acct.displayName, upstreamUsernameMasked: acct.upstreamUsernameMasked, enabled: acct.enabled, state: acct.state, dialMode: 'callback', createdAt: acct.createdAt });
  });
  app.get('/api/v1/accounts/:accountId', async (req, reply) => {
    const { accountId } = req.params as any;
    return ok(req, reply, await s.accounts.get(accountId));
  });
  app.patch('/api/v1/accounts/:accountId', async (req, reply) => {
    const { accountId } = req.params as any;
    return ok(req, reply, await s.accounts.update(accountId, (req.body ?? {}) as any));
  });
  app.delete('/api/v1/accounts/:accountId', async (req, reply) => {
    const { accountId } = req.params as any;
    const q = (req.query ?? {}) as any;
    const purgeData = q.purgeData === 'true';
    if (purgeData && q.confirm !== `PURGE:${accountId}`) throw new AppError('VALIDATION_FAILED', `purgeData=true 需要 confirm=PURGE:${accountId}`);
    await s.accounts.remove(accountId, { purgeData });
    return reply.status(204).send();
  });
  app.post('/api/v1/accounts/:accountId/login', async (req, reply) => {
    const { accountId } = req.params as any;
    const b = (req.body ?? {}) as { wait?: boolean; timeoutMs?: number; force?: boolean };
    const r = await s.accounts.startLogin(accountId, { wait: b.wait, timeoutMs: b.timeoutMs, force: b.force });
    if ((r.job as any).jobId === 'cached') return ok(req, reply, { accountId, state: 'online', loggedIn: true, jwtExpiresAt: (await s.repo.getAccount(accountId))?.jwtExpiresAt ?? null, loginJobId: 'cached' });
    if (b.wait === false) {
      reply.status(202);
      return ok(req, reply, { loginJobId: r.job.jobId, status: r.job.status, pollUrl: `/api/v1/jobs/${r.job.jobId}` });
    }
    const finished = await s.accounts.waitLogin(r.job.jobId, Math.min(300000, Math.max(10000, b.timeoutMs ?? 120000)));
    const acct = await s.repo.getAccount(accountId);
    if (finished.status !== 'succeeded') {
      const err = safeJson<{ code?: string; message?: string }>(finished.lastErrorJson);
      throw new AppError('ACCOUNT_LOGIN_FAILED', err?.message ?? '登录失败', { details: { loginJobId: finished.jobId, reason: err?.code ?? 'login_failed' } });
    }
    return ok(req, reply, { accountId, state: acct?.state ?? 'online', loggedIn: true, jwtExpiresAt: acct?.jwtExpiresAt ?? null, loginJobId: finished.jobId });
  });
  app.post('/api/v1/accounts/:accountId/logout', async (req, reply) => {
    const { accountId } = req.params as any;
    await s.accounts.logout(accountId);
    return reply.status(204).send();
  });
  app.get('/api/v1/accounts/:accountId/health', async (req, reply) => {
    const { accountId } = req.params as any;
    return ok(req, reply, await s.accounts.health(accountId));
  });

  // ---------------- calls ----------------
  app.post('/api/v1/calls', async (req, reply) => {
    const idem = (req.headers['idempotency-key'] as string) || null;
    const body = (req.body ?? {}) as any;
    const result = await s.calls.create({ to: body.to, accountId: body.accountId, customerName: body.customerName, metadata: body.metadata, scheduledAt: body.scheduledAt, dryRun: body.dryRun }, idem);
    if ((result as any).dryRun) return ok(req, reply, result);
    reply.status(201);
    return ok(req, reply, result, undefined, { idempotencyReplayed: false });
  });
  app.get('/api/v1/calls', async (req, reply) => {
    const r = await s.calls.list((req.query ?? {}) as any);
    return ok(req, reply, r.items, r.pagination);
  });
  app.get('/api/v1/calls/:callId', async (req, reply) => {
    const { callId } = req.params as any;
    return ok(req, reply, await s.calls.toSummary(await s.calls.get(callId)));
  });
  app.get('/api/v1/calls/:callId/detail', async (req, reply) => {
    const { callId } = req.params as any; const q = (req.query ?? {}) as any;
    return ok(req, reply, await s.calls.detail(callId, { includeRaw: q.includeRaw === 'true', includeEvents: q.includeEvents === 'true', includeAnalysis: q.includeAnalysis === 'true' }));
  });
  app.get('/api/v1/calls/:callId/transcript', async (req, reply) => {
    const { callId } = req.params as any; const q = (req.query ?? {}) as any;
    return ok(req, reply, await s.calls.transcript(callId, { includeAnalysis: q.includeAnalysis === 'true' }));
  });
  app.get('/api/v1/calls/:callId/audio', async (req, reply) => {
    const { callId } = req.params as any; const q = (req.query ?? {}) as any;
    const info = await s.calls.audioInfo(callId);
    const stat = statSync(info.absPath);
    const range = req.headers.range as string | undefined;
    const etag = `"${info.sha256}"`;
    const baseHeaders = { 'Content-Type': info.mime, 'Accept-Ranges': 'bytes', ETag: etag, 'Cache-Control': 'private, max-age=86400', ...(q.download === 'true' ? { 'Content-Disposition': `attachment; filename="${callId}.wav"` } : {}) } as Record<string, string>;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) throw new AppError('INVALID_REQUEST', '非法 Range');
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
      if (start > end) throw new AppError('INVALID_REQUEST', '非法 Range');
      reply.status(206).headers({ ...baseHeaders, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${stat.size}` });
      return reply.send(createReadStream(info.absPath, { start, end }));
    }
    reply.headers({ ...baseHeaders, 'Content-Length': String(stat.size) });
    return reply.send(createReadStream(info.absPath));
  });
  app.post('/api/v1/calls/:callId/reprocess', async (req, reply) => {
    const { callId } = req.params as any;
    const job = await s.calls.reprocess(callId, (req.body ?? {}) as any);
    reply.status(202);
    return ok(req, reply, { jobId: job.jobId, callId, stages: (req.body as any)?.stages ?? [], status: job.status, pollUrl: `/api/v1/jobs/${job.jobId}` });
  });
  app.post('/api/v1/calls/:callId/cancel', async (req, reply) => {
    const { callId } = req.params as any;
    return ok(req, reply, await s.calls.cancel(callId));
  });
  app.get('/api/v1/calls/:callId/events', async (req, reply) => {
    const { callId } = req.params as any;
    const q = (req.query ?? {}) as any;
    const r = await s.calls.callEvents(callId, { types: q.types, page: Number(q.page ?? 1), size: Number(q.size ?? 50) });
    return ok(req, reply, r.items, r.pagination);
  });

  // ---------------- sync / jobs ----------------
  app.post('/api/v1/sync', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const job = await s.sync.start(b.mode ?? 'incremental', { accountId: b.accountId, from: b.from, to: b.to, wait: !!b.wait, timeoutMs: b.timeoutMs });
    if (b.wait && ['succeeded', 'failed'].includes(job.status)) return ok(req, reply, toJobDetail(job));
    reply.status(202);
    return ok(req, reply, { jobId: job.jobId, type: 'sync', mode: (b.mode ?? 'incremental'), accountId: job.accountId ?? null, status: job.status, pollUrl: `/api/v1/jobs/${job.jobId}` });
  });
  app.get('/api/v1/sync', async (req, reply) => {
    const q = (req.query ?? {}) as any;
    const page = Math.max(1, Number(q.page ?? 1)); const size = Math.min(100, Math.max(1, Number(q.size ?? 20)));
    const r = await s.repo.listJobs({ page, size, types: ['sync'], statuses: q.status ? [q.status] : undefined, accountId: q.accountId });
    return ok(req, reply, r.items.map(toJobSummary), paging(page, size, r.total));
  });
  app.get('/api/v1/sync/:jobId', async (req, reply) => {
    const { jobId } = req.params as any;
    const j = await s.repo.getJob(jobId);
    if (!j) throw new AppError('JOB_NOT_FOUND', `作业不存在: ${jobId}`);
    return ok(req, reply, toJobDetail(j));
  });
  app.get('/api/v1/jobs', async (req, reply) => {
    const q = (req.query ?? {}) as any;
    const page = Math.max(1, Number(q.page ?? 1)); const size = Math.min(100, Math.max(1, Number(q.size ?? 20)));
    const r = await s.repo.listJobs({ page, size, types: q.type ? String(q.type).split(',').map((x: string) => x.trim()) as any : undefined, statuses: q.status ? String(q.status).split(',').map((x: string) => x.trim()) as any : undefined, accountId: q.accountId, callId: q.callId, sort: q.sort });
    return ok(req, reply, r.items.map(toJobSummary), paging(page, size, r.total));
  });
  app.get('/api/v1/jobs/:jobId', async (req, reply) => {
    const { jobId } = req.params as any;
    const j = await s.repo.getJob(jobId);
    if (!j) throw new AppError('JOB_NOT_FOUND', `作业不存在: ${jobId}`);
    return ok(req, reply, toJobDetail(j));
  });

  // ---------------- events ----------------
  app.get('/api/v1/events', async (req, reply) => {
    const q = (req.query ?? {}) as any;
    const page = Math.max(1, Number(q.page ?? 1)); const size = Math.min(200, Math.max(1, Number(q.size ?? 50)));
    const r = await s.repo.listEvents({ page, size, types: q.types ? String(q.types).split(',') : undefined, callId: q.callId, accountId: q.accountId, since: q.since, until: q.until, sort: q.sort });
    return ok(req, reply, r.items.map(e => ({ eventId: e.eventId, type: e.type, occurredAt: e.occurredAt, accountId: e.accountId, callId: e.callId, data: safeJson(e.dataJson) ?? {} })), paging(page, size, r.total));
  });
  app.get('/api/v1/events/stream', async (req, reply) => {
    const q = (req.query ?? {}) as any;
    const types = q.types ? String(q.types).split(',').map((t: string) => t.trim()).filter(Boolean) : null;
    const lastEventId = (req.headers['last-event-id'] as string) ?? null;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    raw.write(`: connected ${new Date().toISOString()}\n\n`);
    let closed = false;
    const unsub = s.events.subscribe(ev => {
      if (closed) return;
      if (types && !types.some(t => t.endsWith('.*') ? ev.type.startsWith(t.slice(0, -1)) : t === ev.type)) return;
      if (q.callId && ev.callId !== q.callId) return;
      if (q.accountId && ev.accountId !== q.accountId) return;
      if (lastEventId && ev.eventId <= lastEventId) return;
      raw.write(`event: ${ev.type}\nid: ${ev.eventId}\ndata: ${JSON.stringify({ eventId: ev.eventId, type: ev.type, occurredAt: ev.occurredAt, accountId: ev.accountId, callId: ev.callId, data: ev.data })}\n\n`);
    });
    const hb = setInterval(() => { if (!closed) raw.write(': ping\n\n'); }, s.config.get().events.sseHeartbeatMs);
    const cleanup = () => { if (closed) return; closed = true; clearInterval(hb); unsub(); try { raw.end(); } catch { /* ignore */ } };
    req.raw.on('close', cleanup); req.raw.on('error', cleanup);
  });

  // ---------------- webhook test ----------------
  app.post('/api/v1/webhooks/test', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    if (!b.url || !/^https:\/\//.test(b.url)) throw new AppError('VALIDATION_FAILED', 'url 必须为 https');
    const t0 = Date.now();
    try {
      const res = await fetch(b.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ eventId: 'evt_test', type: b.eventType ?? 'call.ended', occurredAt: new Date().toISOString(), data: { test: true } }), signal: AbortSignal.timeout(10000) });
      return ok(req, reply, { delivered: res.ok, statusCode: res.status, latencyMs: Date.now() - t0 });
    } catch (e) {
      throw new AppError('UPSTREAM_UNREACHABLE', `webhook 投递失败: ${(e as Error).message}`, { details: { deliveryError: (e as Error).message } });
    }
  });

  // ---------------- terms / text ----------------
  app.get('/api/v1/terms', async (req, reply) => {
    const q = (req.query ?? {}) as any;
    const rules = await s.terms.list({ q: q.q, enabled: q.enabled !== undefined ? q.enabled === 'true' : undefined });
    const mapped = rules.map(r => ({ termId: r.termId, from: r.from, to: r.to, category: r.category, priority: r.priority, enabled: r.enabled, caseSensitive: r.caseSensitive, note: r.note, createdAt: r.createdAt, updatedAt: r.updatedAt }));
    return ok(req, reply, mapped);
  });
  app.put('/api/v1/terms', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const rules = Array.isArray(b) ? b : b.rules;
    if (!Array.isArray(rules)) throw new AppError('VALIDATION_FAILED', 'rules 必须为数组');
    if (b.mode && b.mode !== 'replace') throw new AppError('VALIDATION_FAILED', 'mode 仅支持 replace');
    await s.terms.ensureLoaded();
    const r = await s.terms.replaceAll(rules);
    await s.terms.reload();
    return ok(req, reply, r);
  });
  app.post('/api/v1/terms', async (req, reply) => {
    const rule = await s.terms.create((req.body ?? {}) as any);
    reply.status(201);
    return ok(req, reply, rule);
  });
  app.patch('/api/v1/terms/:termId', async (req, reply) => {
    const { termId } = req.params as any;
    return ok(req, reply, await s.terms.update(termId, (req.body ?? {}) as any));
  });
  app.delete('/api/v1/terms/:termId', async (req, reply) => {
    const { termId } = req.params as any;
    await s.terms.remove(termId);
    return reply.status(204).send();
  });
  app.post('/api/v1/text/normalize', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    if (typeof b.text !== 'string' || b.text.length === 0 || b.text.length > 20000) throw new AppError('VALIDATION_FAILED', 'text 长度需 1-20000');
    const r = await s.terms.normalizeText(b.text);
    return ok(req, reply, { original: b.text, normalized: r.normalized, applied: r.applied, rulesVersion: r.rulesVersion });
  });

  return app;
}

function tokenOk(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function errorBody(e: AppError, requestId: string) {
  return { ok: false, error: e.toBody(), meta: { requestId, ts: new Date().toISOString() } };
}
function redactConfig(cfg: { get(): any }): Record<string, unknown> {
  const c = JSON.parse(JSON.stringify(cfg.get()));
  if (c?.events?.webhooks) c.events.webhooks = c.events.webhooks.map((w: any) => ({ ...w, ...(w.secret ? { secret: '***' } : {}) }));
  return c;
}
