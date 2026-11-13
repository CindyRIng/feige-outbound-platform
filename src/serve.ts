import { CONFIG_FILE, ConfigStore } from './config.js';
import { existsSync } from 'node:fs';
import { openRepo } from './db/sqlite.js';
import { Logger, type LogLevel } from './logger.js';
import { EventBus } from './core/events.js';
import { JobQueue } from './core/jobs.js';
import { TermService } from './core/terms.js';
import { AccountService } from './core/accounts.js';
import { SyncService } from './core/sync.js';
import { PipelineService } from './core/pipeline.js';
import { CallsService } from './core/calls.js';
import { StatusService } from './core/status.js';
import { createUpstreamClient } from './upstream/client.js';
import { runLogin } from './upstream/auth.js';
import { createAsrClient } from './media/asr.js';
import { createAnalysisClient } from './media/analysis.js';
import { createServer } from './api/server.js';
import type { Services } from './api/context.js';

const VERSION = '0.1.0';
const UPSTREAM_BASE = process.env.FOP_UPSTREAM_BASE_URL ?? 'https://feige.duofangtongxin.com/duofang-feige-admin';

export async function startServer(args: string[] = []): Promise<void> {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--port') && args[i + 1]) { process.env.FOP_PORT = args[++i]; }
    else if (a.startsWith('--port=')) process.env.FOP_PORT = a.split('=')[1];
    else if ((a === '--host') && args[i + 1]) { process.env.FOP_HOST = args[++i]; }
    else if (a.startsWith('--host=')) process.env.FOP_HOST = a.split('=')[1];
  }
  const config = new ConfigStore();
  config.ensureDirs();
  if (!existsSync(CONFIG_FILE)) { try { config.patch({}); } catch { /* ignore */ } }
  const apiToken = config.ensureApiToken();
  const cfg = config.get();
  const paths = config.paths();
  const log = new Logger((cfg.logging.level as LogLevel) ?? 'info', paths.logFile);
  log.info('starting feige-outbound-platform', { version: VERSION, host: cfg.server.host, port: cfg.server.port });

  const repo = await openRepo(paths.dbPath);
  await repo.migrate();
  const events = new EventBus(repo, log);
  const jobs = new JobQueue(repo, events, log, {
    leaseMs: cfg.runtime.jobLeaseMs, pollMs: 500, concurrency: 12,
    typeLimits: { login: 1, sync: 1, audio_fetch: 2, asr: cfg.pipeline.asr.concurrency, analysis: cfg.pipeline.analysis.concurrency, reprocess: 1, backfill: 1 },
    backoffBaseMs: { asr: 20000, analysis: 5000, sync: 5000, audio_fetch: 5000, login: 30000 },
  });
  const terms = new TermService(repo, log);
  await terms.reload();

  const createUpstream = (baseUrl: string, token?: string | null) => createUpstreamClient({ baseUrl, token: token ?? null });
  const accounts = new AccountService({ repo, config, events, jobs, log, createUpstream, runLogin, upstreamBaseUrl: UPSTREAM_BASE });
  const sync = new SyncService({ repo, config, events, jobs, log, accounts, createUpstream, upstreamBaseUrl: UPSTREAM_BASE });
  const pipeline = new PipelineService({
    repo, config, events, jobs, log, terms, accounts,
    createAsr: (overrideModel?: string) => createAsrClient({ baseUrl: cfg.pipeline.asr.baseUrl, apiKey: config.secrets().minimaxApiKey ?? '', model: overrideModel ?? cfg.pipeline.asr.model, language: cfg.pipeline.asr.language, timeoutMs: cfg.pipeline.asr.timeoutMs, maxRetries: cfg.pipeline.asr.maxRetries }),
    createAnalysis: (overrideModel?: string) => createAnalysisClient({
      baseUrl: cfg.pipeline.analysis.baseUrl, apiKey: config.secrets().deepseekApiKey ?? '',
      model: overrideModel ?? cfg.pipeline.analysis.model, escalateModel: cfg.pipeline.analysis.escalateModel,
      promptVersion: cfg.pipeline.analysis.promptVersion, temperature: cfg.pipeline.analysis.temperature,
      maxTokens: cfg.pipeline.analysis.maxTokens, escalateMaxTokens: cfg.pipeline.analysis.escalateMaxTokens,
      maxRetries: cfg.pipeline.analysis.maxRetries,
    }),
  });
  const calls = new CallsService({ repo, config, events, jobs, log, accounts, sync, terms });
  const status = new StatusService({ repo, config, jobs, events, accounts, log, startedAt: new Date(), version: VERSION });

  // job handlers
  jobs.register('login', (ctx) => accounts.executeLoginJob(ctx.job));
  jobs.register('sync', (ctx) => sync.runSyncJob(ctx.job));
  jobs.register('audio_fetch', (ctx) => pipeline.runAudioJob(ctx.job));
  jobs.register('asr', (ctx) => pipeline.runAsrJob(ctx.job));
  jobs.register('analysis', (ctx) => pipeline.runAnalysisJob(ctx.job));
  jobs.register('reprocess', (ctx) => pipeline.runReprocessJob(ctx.job));
  jobs.register('backfill', async (ctx) => {
    const payload = JSON.parse(ctx.job.payloadJson ?? '{}');
    const job2 = { ...ctx.job, type: 'sync' as const, payloadJson: JSON.stringify({ mode: 'backfill', accountIds: payload.accountIds ?? (ctx.job.accountId ? [ctx.job.accountId] : []), from: payload.from, to: payload.to }) };
    return sync.runSyncJob(job2);
  });
  await jobs.recover();
  jobs.start();

  const services: Services = { config, repo, accounts, calls, sync, pipeline, status, terms, jobs, events, log, startedAt: new Date(), version: VERSION, token: apiToken };
  const app = await createServer(services);
  await app.listen({ host: cfg.server.host, port: cfg.server.port });
  log.info('http server listening', { url: `http://${cfg.server.host}:${cfg.server.port}/api/v1`, tokenFile: paths.dataDir ? undefined : undefined });

  const schedulerTimer = setInterval(() => { calls.tick().catch(e => log.warn('scheduler tick failed', { err: e.message })); }, 2000);
  const syncTimer = cfg.sync.intervalMs > 0 ? setInterval(() => { sync.start('incremental').catch(e => log.warn('auto sync failed', { err: e.message })); }, cfg.sync.intervalMs) : null;
  const keepAliveTimer = setInterval(async () => {
    try {
      const list = await repo.listAccounts({ enabled: true });
      for (const a of list) if (a.state === 'online') accounts.health(a.accountId).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
  }, Math.max(30000, cfg.runtime.keepAliveMs));

  const shutdown = async (sig: string) => {
    log.info('shutting down', { signal: sig });
    clearInterval(schedulerTimer); if (syncTimer) clearInterval(syncTimer); clearInterval(keepAliveTimer);
    try { await app.close(); } catch { /* ignore */ }
    await jobs.stop();
    try { await repo.close(); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 200);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  // 常驻
  await new Promise<void>((resolve) => {
    const onExit = () => resolve();
    process.once('SIGINT', onExit); process.once('SIGTERM', onExit);
  });
}
