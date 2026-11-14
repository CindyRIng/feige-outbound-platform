import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { VERSION } from '../version.js';
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
  // 容忍空 JSON body（如无 body 的 POST /cancel、/logout）：空 → undefined，非空严格解析
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = String(body ?? '').trim();
    if (raw === '') { done(null, undefined); return; }
    try { done(null, JSON.parse(raw)); } catch (e) { done(e as Error, undefined); }
  });
  app.addHook('onRequest', async (req, reply) => {
    const rid = (req.headers['x-request-id'] as string) || newRequestId();
    (req as any).requestId = rid;
    reply.header('X-Request-Id', rid);
    reply.header('X-Api-Version', '1');
    // auth：业务接口全部需要 token；仅 OpenAPI/Swagger 文档与 API 发现页公开（服务默认只监听 127.0.0.1）
    const pathOnly = req.url.split('?')[0];
    const isPublicDoc = pathOnly === '/api/v1' || pathOnly === '/api/v1/' || pathOnly === '/api/v1/openapi.json'
      || pathOnly === '/api/v1/openapi.yaml' || pathOnly === '/api/v1/docs' || pathOnly === '/api/v1/docs/'
      || pathOnly.startsWith('/api/v1/docs/');
    if (req.url.startsWith('/api/v1/') && !isPublicDoc) {
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
  app.get('/favicon.ico', async (_req, reply) => reply.status(204).send());
  app.get('/api/v1/docs/favicon.ico', async (_req, reply) => reply.status(204).send());
  app.setNotFoundHandler((req, reply) => reply.status(404).send(errorBody(new AppError('NOT_FOUND', `接口不存在: ${req.method} ${req.url}`), (req as any).requestId ?? newRequestId())));

  const meta = (req: FastifyRequest, pagination?: Pagination, extra: Record<string, unknown> = {}) => ({ requestId: (req as any).requestId, ts: new Date().toISOString(), ...(pagination ? { pagination } : {}), ...extra });
  const ok = (req: FastifyRequest, reply: FastifyReply, data: unknown, pagination?: Pagination, extra: Record<string, unknown> = {}) => reply.send({ ok: true, data, meta: meta(req, pagination, extra) });
  const paging = (page: number, size: number, total: number): Pagination => ({ page, size, total, totalPages: Math.max(1, Math.ceil(total / size)) });

  // ---------------- OpenAPI / Swagger UI（运行时文档，无需 token） ----------------
  const openapi = loadOpenApiSpec();
  const swaggerDir = resolveSwaggerUiDir();
  app.get('/api/v1', async (_req, reply) => reply.send({
    ok: true,
    data: {
      name: 'feige-outbound-platform', version: VERSION, apiVersion: 'v1',
      docs: '/api/v1/docs', openapi: '/api/v1/openapi.json', openapiYaml: '/api/v1/openapi.yaml', health: '/api/v1/health',
      note: '业务接口均需 Authorization: Bearer <localApiToken>；文档端点公开（服务默认仅监听 127.0.0.1）',
    },
    meta: { ts: new Date().toISOString() },
  }));
  app.get('/api/v1/openapi.json', async (_req, reply) => {
    if (!openapi) throw new AppError('SERVICE_UNAVAILABLE', 'OpenAPI 契约文件未找到（spec/openapi.yaml）', { details: { hint: '设置 FOP_OPENAPI_FILE 或从仓库根目录启动' } });
    return reply.type('application/json; charset=utf-8').header('Cache-Control', 'no-cache').send(JSON.stringify(openapi.json));
  });
  app.get('/api/v1/openapi.yaml', async (_req, reply) => {
    if (!openapi) throw new AppError('SERVICE_UNAVAILABLE', 'OpenAPI 契约文件未找到（spec/openapi.yaml）');
    return reply.type('application/yaml; charset=utf-8').header('Cache-Control', 'no-cache').send(openapi.yamlText);
  });
  const docsHtml = (): string => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>飞鸽外呼本地平台 REST v1 · API 文档</title>
<link rel="stylesheet" href="/api/v1/docs/swagger-ui.css"/>
<style>
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif}
  .fop-banner{padding:10px 18px;background:#0b3d91;color:#fff;font-size:13px;line-height:1.6}
  .fop-banner code{background:rgba(255,255,255,.15);padding:1px 6px;border-radius:4px}
  .fop-banner a{color:#9fd0ff}
</style>
</head>
<body>
<div class="fop-banner">
  <b>feige-outbound-platform REST v1</b> · OpenAPI 3.1 · 共 35 个操作 ·
  <a href="/api/v1/openapi.yaml" target="_blank">下载 openapi.yaml</a> ·
  <a href="/api/v1/openapi.json" target="_blank">openapi.json</a><br/>
  业务接口需鉴权：点击右上角 <b>Authorize</b> 填入本地 API token（<code>~/.config/feige-outbound/api-token</code>），或访问 <code>/api/v1/docs?token=&lt;token&gt;</code> 自动注入。默认仅监听 127.0.0.1。
</div>
<div id="swagger-ui"></div>
<script src="/api/v1/docs/swagger-ui-bundle.js"></script>
<script src="/api/v1/docs/swagger-ui-standalone-preset.js"></script>
<script>
(function(){
  var q = new URLSearchParams(location.search);
  var t = q.get('token') || localStorage.getItem('fop_api_token') || '';
  if (q.get('token')) localStorage.setItem('fop_api_token', q.get('token'));
  window.ui = SwaggerUIBundle({
    url: '/api/v1/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    persistAuthorization: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    plugins: [SwaggerUIBundle.plugins.DownloadUrl],
    layout: 'StandaloneLayout',
    requestInterceptor: function(req){ if (t) req.headers.Authorization = 'Bearer ' + t; return req; }
  });
})();
</script>
</body>
</html>`;
  app.get('/api/v1/docs', async (_req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(docsHtml()));
  app.get('/api/v1/docs/', async (_req, reply) => reply.redirect('/api/v1/docs'));
  const swaggerAssets: Record<string, string> = {
    'swagger-ui.css': 'text/css; charset=utf-8',
    'swagger-ui-bundle.js': 'application/javascript; charset=utf-8',
    'swagger-ui-standalone-preset.js': 'application/javascript; charset=utf-8',
    'favicon-32x32.png': 'image/png', 'favicon-16x16.png': 'image/png',
  };
  app.get('/api/v1/docs/:asset', async (req, reply) => {
    const asset = String((req.params as any).asset ?? '');
    const mime = swaggerAssets[asset];
    if (!mime) throw new AppError('NOT_FOUND', `未知文档资源: ${asset}`);
    if (!swaggerDir) throw new AppError('SERVICE_UNAVAILABLE', 'swagger-ui-dist 未安装（npm install）');
    const file = join(swaggerDir, asset);
    if (!existsSync(file)) throw new AppError('SERVICE_UNAVAILABLE', `Swagger UI 资源缺失: ${asset}`);
    return reply.type(mime).header('Cache-Control', 'public, max-age=3600').send(readFileSync(file));
  });

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
    const allowed = new Set(['server','storage','browser','dial','limits','sync','pipeline','events','logging','backup','runtime','security']);
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
    return ok(req, reply, { accountId: acct.accountId, displayName: acct.displayName, upstreamUsername: acct.upstreamUsername, upstreamUsernameMasked: acct.upstreamUsernameMasked, enabled: acct.enabled, state: acct.state, dialMode: 'callback', createdAt: acct.createdAt });
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


/** 解析 OpenAPI 契约（spec/openapi.yaml），支持环境变量/仓库根/dist 多候选。 */
function loadOpenApiSpec(): { json: Record<string, unknown>; yamlText: string; source: string } | null {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    process.env.FOP_OPENAPI_FILE,
    join(process.cwd(), 'spec', 'openapi.yaml'),
    join(process.cwd(), 'dist', 'spec', 'openapi.yaml'),
    fileURLToPath(new URL('../../spec/openapi.yaml', import.meta.url)),
    fileURLToPath(new URL('../../../spec/openapi.yaml', import.meta.url)),
    join(dirname(here), '..', '..', '..', 'spec', 'openapi.yaml'),
  ].filter((x): x is string => !!x);
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const yamlText = readFileSync(file, 'utf8');
      const json = YAML.parse(yamlText) as Record<string, unknown>;
      if (json && typeof json === 'object' && json.openapi) return { json, yamlText, source: file };
    } catch { /* try next */ }
  }
  return null;
}

/** 解析 swagger-ui-dist 静态资源目录。 */
function resolveSwaggerUiDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('swagger-ui-dist/package.json');
    return dirname(pkg);
  } catch { return null; }
}
