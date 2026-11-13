// feige MCP stdio server：REST v1 的薄封装（docs/07）。server 名 feige-outbound，transport=stdio。
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ApiClient, CliError, MCP_SERVER_NAME, VERSION, configDir, errorEnvelope, okEnvelope, oneLine, sleep,
  type ApiResponse, type Meta,
} from './http.js';

type Content = Array<{ type: 'text'; text: string }>;
interface ToolResult { content: Content; structuredContent?: Record<string, unknown>; isError?: boolean }

interface ToolCfg {
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

const READ_ANN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const READ_WORLD_ANN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE_ANN = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE_WORLD_ANN = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const DESTRUCTIVE_ANN = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const DIAL_ANN = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function client(): ApiClient { return new ApiClient({}); }

function okResult<T>(res: ApiResponse<T>): ToolResult {
  const payload = { ok: true, data: res.data, meta: res.meta };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload as unknown as Record<string, unknown> };
}
function errResult(err: unknown): ToolResult {
  const env = errorEnvelope(err);
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(env) }], structuredContent: env as unknown as Record<string, unknown> };
}
function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  return fn().catch((err: unknown) => errResult(err));
}
function invalid(message: string): never { throw new CliError('VALIDATION_FAILED', message); }

const CALL_ID = z.string().regex(/^call_[0-9A-HJKMNP-TV-Z]{26}$/, 'callId 形如 call_<ULID>');
const ACCOUNT_ID = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,31}$/, 'accountId 为 slug');
const CALL_STATUS = z.enum(['pending', 'dialing', 'connected', 'ended', 'no_answer', 'failed', 'canceled'] as const);
const STAGE = z.enum(['audio', 'transcript', 'analysis'] as const);
const JOB_TYPE = z.enum(['login', 'sync', 'audio_fetch', 'asr', 'analysis', 'reprocess', 'backfill'] as const);
const JOB_STATUS = z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled'] as const);
const TERM_CATEGORY = z.enum(['company', 'product', 'person', 'custom'] as const);
const CONFIRM = z.literal(true);

function idemHeaders(idempotencyKey?: string): Record<string, string> {
  return idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
}

function queryFrom(args: Record<string, any>, keys: string[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined && args[k] !== null) q[k] = args[k];
  return q;
}

function secretsFileData(): Record<string, any> {
  try {
    const file = join(configDir(), 'secrets.json');
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  } catch { /* ignore */ }
  return {};
}
function resolvePassword(args: { passwordEnv?: string; secretRef?: string }): string {
  if (args.passwordEnv) {
    const v = process.env[args.passwordEnv];
    if (!v) invalid(`环境变量 ${args.passwordEnv} 不存在或为空（MCP 不接受明文密码）`);
    return v;
  }
  if (args.secretRef) {
    const acc = secretsFileData().accounts?.[args.secretRef];
    if (!acc?.password) invalid(`secrets.json 中缺少账号条目：${args.secretRef}`);
    return String(acc.password);
  }
  return invalid('缺少密码引用：passwordEnv 或 secretRef 二选一（MCP 不接受明文密码）');
}

function toolName(server: McpServer, name: string, cfg: ToolCfg, handler: (args: Record<string, any>) => Promise<ToolResult>): void {
  (server as any).registerTool(name, cfg as any, async (args: Record<string, any>) => handler(args ?? {}));
}

function registerReadTools(server: McpServer): void {
  toolName(server, 'feige_health', {
    title: '存活探针', description: '返回本地平台进程存活、版本与 uptime；不检查业务状态。',
    inputSchema: {}, annotations: READ_ANN,
  }, async () => run(async () => okResult(await client().get('/health'))));

  toolName(server, 'feige_status', {
    title: '平台健康', description: '返回平台整体健康（DB、账号池、上游可达、拨打时段、作业队列、流水线积压、同步延迟）。',
    inputSchema: { detail: z.boolean().optional() }, annotations: READ_ANN,
  }, async args => run(async () => {
    const q: Record<string, unknown> = args.detail === undefined ? {} : { detail: args.detail };
    return okResult(await client().get('/status', q));
  }));

  toolName(server, 'feige_config_get', {
    title: '读取生效配置', description: '读取生效配置（密钥脱敏），可按点路径取子集；pipeline 为嵌套 asr/analysis/roleMapping。',
    inputSchema: { key: z.string().max(64).optional() }, annotations: READ_ANN,
  }, async args => run(async () => {
    const res = await client().get<Record<string, any>>('/config');
    if (!args.key) return okResult(res);
    let data: unknown = res.data;
    for (const part of String(args.key).split('.')) {
      data = data !== null && typeof data === 'object' ? (data as Record<string, unknown>)[part] : undefined;
      if (data === undefined) invalid(`配置键不存在：${args.key}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data, meta: res.meta }) }], structuredContent: { ok: true, data, meta: res.meta } as Record<string, unknown> };
  }));

  toolName(server, 'feige_account_list', {
    title: '账号列表', description: '分页列出账号与健康摘要（AccountSummary）。',
    inputSchema: {
      enabled: z.boolean().optional(),
      state: z.union([z.string(), z.array(z.string())]).optional(),
      page: z.number().int().min(1).optional(), size: z.number().int().min(1).max(200).optional(),
    },
    annotations: READ_ANN,
  }, async args => run(async () => okResult(await client().get('/accounts', {
    ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
    ...(args.state ? { state: args.state } : {}),
    ...queryFrom(args, ['page', 'size']),
  }))));

  toolName(server, 'feige_account_get', {
    title: '账号详情', description: '返回账号配置、会话、同步状态与最近作业（AccountDetail）。',
    inputSchema: { accountId: ACCOUNT_ID }, annotations: READ_ANN,
  }, async args => run(async () => okResult(await client().get(`/accounts/${encodeURIComponent(args.accountId)}`))));

  toolName(server, 'feige_account_health', {
    title: '单账号健康', description: '返回单账号健康（JWT/WS/上游/线路/时段/当前通话）；探测失败不报错（upstream.reachable=false）。',
    inputSchema: { accountId: ACCOUNT_ID }, annotations: READ_WORLD_ANN,
  }, async args => run(async () => okResult(await client().get(`/accounts/${encodeURIComponent(args.accountId)}/health`))));

  toolName(server, 'feige_call_list', {
    title: '话单列表', description: '分页查询话单（默认 sort=-createdAt），支持账号/状态/日期/号码/文本/流水线过滤。',
    inputSchema: {
      accountId: z.string().optional(), status: z.union([CALL_STATUS, z.array(CALL_STATUS)]).optional(),
      pipeline: z.object({ audio: z.string().optional(), transcript: z.string().optional(), analysis: z.string().optional() }).optional(),
      hasAudio: z.boolean().optional(), hasTranscript: z.boolean().optional(),
      to: z.string().max(20).optional(), q: z.string().max(64).optional(),
      dateFrom: z.string().optional(), dateTo: z.string().optional(),
      sort: z.string().optional(), page: z.number().int().min(1).optional(), size: z.number().int().min(1).max(100).optional(),
      includePipeline: z.boolean().optional(),
    },
    annotations: READ_ANN,
  }, async args => run(async () => {
    const q: Record<string, unknown> = queryFrom(args, ['accountId', 'status', 'hasAudio', 'hasTranscript', 'to', 'q', 'dateFrom', 'dateTo', 'sort', 'page', 'size', 'includePipeline']);
    if (args.pipeline && typeof args.pipeline === 'object') {
      for (const [stage, value] of Object.entries(args.pipeline)) if (value !== undefined) q[`pipeline.${stage}`] = value;
    }
    return okResult(await client().get('/calls', q));
  }));

  toolName(server, 'feige_call_get', {
    title: '话单摘要', description: '返回单通话单摘要（状态、号码、时长、话费、流水线状态）。',
    inputSchema: { callId: CALL_ID }, annotations: READ_ANN,
  }, async args => run(async () => okResult(await client().get(`/calls/${encodeURIComponent(args.callId)}`))));

  toolName(server, 'feige_call_detail', {
    title: '话单详情', description: '返回话单详情（上游字段、时间线、录音/本地 ASR 转写/DeepSeek 分析三阶段明细）。',
    inputSchema: { callId: CALL_ID, includeRaw: z.boolean().optional(), includeEvents: z.boolean().optional() }, annotations: READ_ANN,
  }, async args => run(async () => okResult(await client().get(`/calls/${encodeURIComponent(args.callId)}/detail`, {
    ...(args.includeRaw !== undefined ? { includeRaw: args.includeRaw } : {}),
    ...(args.includeEvents !== undefined ? { includeEvents: args.includeEvents } : {}),
  }))));

  toolName(server, 'feige_call_transcript', {
    title: '转写全文+分段', description: '返回本地 ASR（MiniMax asr-1.0）转写全文与句级分段（speakerLabel/chunkIndex/confidence）；短通话可能无转写。',
    inputSchema: {
      callId: CALL_ID, includeAnalysis: z.boolean().optional(),
      format: z.enum(['json', 'text', 'markdown']).optional(),
      role: z.enum(['agent', 'customer', 'unknown']).optional(),
      maxSegments: z.number().int().min(1).max(2000).optional(),
    },
    annotations: READ_ANN,
  }, async args => run(async () => {
    const res = await client().get<Record<string, any>>(`/calls/${encodeURIComponent(args.callId)}/transcript`, {
      ...(args.includeAnalysis !== undefined ? { includeAnalysis: args.includeAnalysis } : {}),
    });
    const data = res.data;
    let segments: Array<Record<string, any>> = Array.isArray(data.segments) ? data.segments : [];
    if (args.role) segments = segments.filter(s => s.role === args.role);
    const maxSegments = Number(args.maxSegments ?? 2000);
    const truncated = segments.length > maxSegments;
    if (truncated) segments = segments.slice(0, maxSegments);
    const format = String(args.format ?? 'json');
    if (format === 'json') {
      const out = { ...data, segments, ...(truncated ? { truncated: true } : {}) };
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: out, meta: res.meta }) }], structuredContent: { ok: true, data: out, meta: res.meta } as Record<string, unknown> };
    }
    const roleLabel = (r: unknown): string => (r === 'agent' ? '坐席' : r === 'customer' ? '客户' : '未知');
    const ts = (ms: number): string => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${(Math.floor(ms / 1000) % 60).toFixed(2).padStart(5, '0')}`;
    let text: string;
    if (format === 'markdown') {
      text = `# 转写 ${oneLine(data.callId)}\n\n> source=${oneLine(data.source)} provider=${oneLine(data.provider)} 段数=${segments.length}\n\n` +
        segments.map(s => `- [${ts(Number(s.beginMs ?? 0))}] **${roleLabel(s.role)}** ${oneLine(s.normalizedText || s.rawText)}`).join('\n') + '\n';
    } else {
      text = segments.map(s => `[${ts(Number(s.beginMs ?? 0))}] ${roleLabel(s.role)} ${oneLine(s.normalizedText || s.rawText)}`).join('\n') +
        `\n（${segments.length} 段 · source=${oneLine(data.source)} · provider=${oneLine(data.provider)} · 已词表归一${truncated ? ' · 已截断' : ''}）`;
    }
    const out = { callId: data.callId, format, text, segmentCount: segments.length, ...(truncated ? { truncated: true } : {}) };
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: out, meta: res.meta }) }], structuredContent: { ok: true, data: out, meta: res.meta } as Record<string, unknown> };
  }));

  toolName(server, 'feige_call_audio', {
    title: '录音元数据/下载', description: '返回原始录音元数据与下载 URL；可选内联 ≤2MB 音频（base64）。',
    inputSchema: { callId: CALL_ID, download: z.boolean().optional(), inline: z.boolean().optional() }, annotations: READ_WORLD_ANN,
  }, async args => run(async () => {
    const c = client();
    const detail = await c.get<Record<string, any>>(`/calls/${encodeURIComponent(args.callId)}/detail`);
    const recording = detail.data.recording ?? {};
    if (!recording.available) invalid(`该话单无可用录音（未接通/上游缺失）：${args.callId}`);
    const out: Record<string, unknown> = { callId: args.callId, ...recording };
    if (args.inline) {
      const size = Number(recording.sizeBytes ?? 0);
      if (size > 2 * 1024 * 1024) invalid(`录音 ${size} 字节超过内联上限 2MB，请使用下载 URL 或 CLI 下载`);
      const dl = await c.download(`/calls/${encodeURIComponent(args.callId)}/audio`);
      out.contentBase64 = dl.buffer.toString('base64');
      out.mimeType = 'audio/wav';
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: out, meta: detail.meta }) }], structuredContent: { ok: true, data: out, meta: detail.meta } as Record<string, unknown> };
  }));

  toolName(server, 'feige_call_events', {
    title: '单通话单事件', description: '返回单通话单事件时间线（occurredAt asc），支持类型过滤与分页。',
    inputSchema: { callId: CALL_ID, types: z.array(z.string()).optional(), page: z.number().int().min(1).optional(), size: z.number().int().min(1).max(200).optional() },
    annotations: READ_ANN,
  }, async args => run(async () => {
    const q: Record<string, unknown> = {
      ...(args.types?.length ? { types: args.types } : {}),
      page: args.page ?? 1, size: args.size ?? 50,
    };
    return okResult(await client().get(`/calls/${encodeURIComponent(args.callId)}/events`, q));
  }));

  toolName(server, 'feige_sync_status', {
    title: '最近同步作业', description: '分页返回最近同步作业（type=sync）。',
    inputSchema: { accountId: z.string().optional(), status: JOB_STATUS.optional(), page: z.number().int().min(1).optional(), size: z.number().int().min(1).max(100).optional() },
    annotations: READ_ANN,
  }, async args => run(async () => okResult(await client().get('/sync', queryFrom(args, ['accountId', 'status', 'page', 'size'])))));

  toolName(server, 'feige_job_get', {
    title: '作业详情', description: '按 jobId 返回作业详情（JobDetail，含同步作业）。',
    inputSchema: { jobId: z.string() }, annotations: READ_ANN,
  }, async args => run(async () => okResult(await client().get(`/jobs/${encodeURIComponent(args.jobId)}`))));

  toolName(server, 'feige_job_list', {
    title: '作业列表', description: '分页列出后台作业，可按类型/状态/账号/话单过滤。',
    inputSchema: {
      type: z.union([JOB_TYPE, z.array(JOB_TYPE)]).optional(), status: JOB_STATUS.optional(),
      accountId: z.string().optional(), callId: CALL_ID.optional(),
      page: z.number().int().min(1).optional(), size: z.number().int().min(1).max(100).optional(), sort: z.string().optional(),
    },
    annotations: READ_ANN,
  }, async args => run(async () => okResult(await client().get('/jobs', queryFrom(args, ['type', 'status', 'accountId', 'callId', 'page', 'size', 'sort'])))));

  toolName(server, 'feige_events_list', {
    title: '事件历史', description: '按时间/类型/关联对象查询事件历史。',
    inputSchema: {
      types: z.array(z.string()).optional(), callId: CALL_ID.optional(), accountId: z.string().optional(),
      since: z.string().optional(), until: z.string().optional(),
      page: z.number().int().min(1).optional(), size: z.number().int().min(1).max(200).optional(), sort: z.string().optional(),
    },
    annotations: READ_ANN,
  }, async args => run(async () => okResult(await client().get('/events', queryFrom(args, ['types', 'callId', 'accountId', 'since', 'until', 'page', 'size', 'sort'])))));

  toolName(server, 'feige_terms_list', {
    title: '词表列表', description: '分页查询词表归一规则（from 为变体数组）。',
    inputSchema: { q: z.string().max(100).optional(), category: TERM_CATEGORY.optional(), enabled: z.boolean().optional(), page: z.number().int().min(1).optional(), size: z.number().int().min(1).max(500).optional() },
    annotations: READ_ANN,
  }, async args => run(async () => okResult(await client().get('/terms', queryFrom(args, ['q', 'category', 'enabled', 'page', 'size'])))));

  toolName(server, 'feige_text_normalize', {
    title: '文本归一化', description: '按当前词表对文本做归一化（同步、无副作用），返回归一结果与命中规则。',
    inputSchema: {
      text: z.string().min(1).max(20000),
      options: z.object({ includeUnchanged: z.boolean().optional(), categoryFilter: z.array(TERM_CATEGORY).optional() }).optional(),
    },
    annotations: READ_ANN,
  }, async args => run(async () => okResult(await client().post('/text/normalize', { text: args.text, ...(args.options ? { options: args.options } : {}) }))));
}

function registerWriteTools(server: McpServer): void {
  toolName(server, 'feige_config_set', {
    title: '局部更新配置', description: '按 JSON Merge Patch 局部更新配置；密钥字段只读；dryRun 只返回 diff。',
    inputSchema: { patch: z.record(z.unknown()), dryRun: z.boolean().optional(), confirm: CONFIRM }, annotations: WRITE_ANN,
  }, async args => run(async () => {
    const c = client();
    const flat = (o: unknown, p = ''): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      if (o === null || typeof o !== 'object') { out[p || '-'] = o; return out; }
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) Object.assign(out, flat(v, p ? `${p}.${k}` : k));
      return out;
    };
    const merge = (base: unknown, patch: unknown): unknown => {
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
      if (base === null || typeof base !== 'object' || Array.isArray(base)) return patch;
      const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
      for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = k in out ? merge(out[k], v) : v;
      return out;
    };
    if (args.dryRun) {
      const cur = await c.get<Record<string, unknown>>('/config');
      const before = flat(cur.data); const after = flat(merge(cur.data, args.patch));
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => before[k] !== after[k]);
      const data = { applied: false, diff: keys.map(k => ({ path: k, from: before[k] ?? null, to: after[k] ?? null })) };
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data, meta: cur.meta }) }], structuredContent: { ok: true, data, meta: cur.meta } as Record<string, unknown> };
    }
    return okResult(await c.patch('/config', args.patch));
  }));

  toolName(server, 'feige_account_add', {
    title: '注册账号', description: '注册上游坐席账号；凭证通过 passwordEnv/secretRef 引用（不接受明文密码）。',
    inputSchema: {
      accountId: ACCOUNT_ID, displayName: z.string().min(1).max(64), username: z.string().regex(/^1[3-9]\d{9}$/),
      concurrency: z.number().int().min(1).max(1).optional(), passwordEnv: z.string().optional(), secretRef: z.string().optional(),
      browser: z.object({ headless: z.boolean().optional(), profileDirName: z.string().max(64).optional() }).optional(),
      metadata: z.record(z.string()).optional(), confirm: CONFIRM,
    },
    annotations: WRITE_ANN,
  }, async args => run(async () => {
    const password = resolvePassword(args);
    const body = {
      accountId: args.accountId, displayName: args.displayName, username: args.username, password,
      ...(args.concurrency ? { concurrency: args.concurrency } : {}),
      ...(args.browser ? { browser: args.browser } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
    };
    return okResult(await client().post('/accounts', body));
  }));

  toolName(server, 'feige_account_update', {
    title: '更新账号', description: '更新展示名/启用状态/密码（轮换）/浏览器设置/metadata。',
    inputSchema: {
      accountId: ACCOUNT_ID, displayName: z.string().min(1).max(64).optional(), enabled: z.boolean().optional(),
      passwordEnv: z.string().optional(), secretRef: z.string().optional(),
      browser: z.object({ headless: z.boolean().optional() }).optional(),
      metadata: z.record(z.string()).optional(), relogin: z.boolean().optional(), confirm: CONFIRM,
    },
    annotations: WRITE_ANN,
  }, async args => run(async () => {
    const patch: Record<string, unknown> = {};
    if (args.displayName !== undefined) patch.displayName = args.displayName;
    if (args.enabled !== undefined) patch.enabled = args.enabled;
    if (args.passwordEnv || args.secretRef) patch.password = resolvePassword(args);
    if (args.browser) patch.browser = args.browser;
    if (args.metadata) patch.metadata = args.metadata;
    if (!Object.keys(patch).length) invalid('没有需要更新的字段');
    return okResult(await client().request('PATCH', `/accounts/${encodeURIComponent(args.accountId)}`, { body: patch, ...(args.relogin ? { query: { relogin: true } } : {}) }));
  }));

  toolName(server, 'feige_account_remove', {
    title: '移除账号', description: '移除本地账号（默认保留历史数据）；purgeData 需 purgeConfirm="PURGE:<accountId>"。',
    inputSchema: { accountId: ACCOUNT_ID, purgeData: z.boolean().optional(), purgeConfirm: z.string().optional(), confirm: CONFIRM },
    annotations: DESTRUCTIVE_ANN,
  }, async args => run(async () => {
    if (args.purgeData && args.purgeConfirm !== `PURGE:${args.accountId}`) invalid('purgeData=true 时 purgeConfirm 必须为 PURGE:<accountId>');
    const q: Record<string, unknown> = args.purgeData ? { purgeData: true, confirm: args.purgeConfirm } : {};
    return okResult(await client().del(`/accounts/${encodeURIComponent(args.accountId)}`, q));
  }));

  toolName(server, 'feige_account_login', {
    title: '触发登录', description: '触发上游登录（浏览器+滑块，异步作业）；wait 默认 true。',
    inputSchema: { accountId: ACCOUNT_ID, wait: z.boolean().optional(), timeoutMs: z.number().int().min(10000).max(300000).optional(), force: z.boolean().optional(), idempotencyKey: z.string().max(128).optional(), confirm: CONFIRM },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async args => run(async () => {
    const body: Record<string, unknown> = {
      wait: args.wait === undefined ? true : args.wait,
      ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
      ...(args.force ? { force: true } : {}),
    };
    return okResult(await client().post(`/accounts/${encodeURIComponent(args.accountId)}/login`, body, { headers: idemHeaders(args.idempotencyKey) }));
  }));

  toolName(server, 'feige_account_logout', {
    title: '退出登录', description: '清除账号本地会话（REST 204，幂等）。',
    inputSchema: { accountId: ACCOUNT_ID, confirm: CONFIRM }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async args => run(async () => okResult(await client().post(`/accounts/${encodeURIComponent(args.accountId)}/logout`))));

  toolName(server, 'feige_dial', {
    title: '发起呼出（有副作用/计费）', description: '发起真实外呼（回拨模式先振铃坐席手机，需人工接听）；受时段/串行/冷却/防重约束，禁止批量/循环调用。',
    inputSchema: {
      to: z.string().regex(/^(1[3-9]\d{9}|0\d{2,3}-?\d{7,8})$/, '被叫号码（手机或固话）'),
      accountId: z.string().optional(), customerName: z.string().max(64).optional(),
      metadata: z.record(z.string()).optional(), scheduledAt: z.string().optional(),
      idempotencyKey: z.string().max(128).optional(), dryRun: z.boolean().optional(), confirm: CONFIRM,
    },
    annotations: DIAL_ANN,
  }, async args => run(async () => {
    const body: Record<string, unknown> = {
      to: args.to,
      ...(args.accountId ? { accountId: args.accountId } : {}),
      ...(args.customerName ? { customerName: args.customerName } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
      ...(args.scheduledAt ? { scheduledAt: args.scheduledAt } : {}),
      ...(args.dryRun ? { dryRun: true } : {}),
    };
    return okResult(await client().post('/calls', body, { headers: idemHeaders(args.idempotencyKey) }));
  }));

  toolName(server, 'feige_call_reprocess', {
    title: '重跑流水线阶段', description: '重跑 audio/transcript/analysis（transcript=本地 ASR 重跑，analysis=DeepSeek 重跑）；幂等、有 ASR/LLM 成本。',
    inputSchema: {
      callId: CALL_ID, stages: z.array(STAGE).min(1).max(3), force: z.boolean().optional(),
      options: z.object({ asrModel: z.string().optional(), analysisModel: z.string().optional(), promptVersion: z.string().optional(), termRulesVersion: z.string().optional() }).optional(),
      wait: z.boolean().optional(), waitTimeoutSec: z.number().int().min(10).max(300).optional(),
      idempotencyKey: z.string().max(128).optional(), confirm: CONFIRM,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async args => run(async () => {
    const c = client();
    const res = await c.post<Record<string, any>>(`/calls/${encodeURIComponent(args.callId)}/reprocess`, {
      stages: args.stages,
      ...(args.force ? { force: true } : {}),
      ...(args.options ? { options: args.options } : {}),
    }, { headers: idemHeaders(args.idempotencyKey) });
    if (!args.wait || !res.data.jobId) return okResult(res);
    const timeout = Number(args.waitTimeoutSec ?? 300) * 1000; const deadline = Date.now() + timeout;
    let job = res.data;
    for (;;) {
      const j = await c.get<Record<string, any>>(`/jobs/${encodeURIComponent(String(res.data.jobId))}`);
      job = j.data;
      if (['succeeded', 'failed', 'canceled'].includes(String(job.status)) || Date.now() >= deadline) break;
      await sleep(1500);
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: job, meta: res.meta }) }], structuredContent: { ok: true, data: job, meta: res.meta } as Record<string, unknown> };
  }));

  toolName(server, 'feige_call_cancel', {
    title: '取消呼出', description: '取消尚未提交上游的呼出（仅 pending）。',
    inputSchema: { callId: CALL_ID, confirm: CONFIRM }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async args => run(async () => okResult(await client().post(`/calls/${encodeURIComponent(args.callId)}/cancel`))));

  toolName(server, 'feige_sync_start', {
    title: '触发同步', description: '触发话单同步；mode=full 会触发历史话单 ASR→DeepSeek 全量回补（不设预算上限，记录 token/耗时）。',
    inputSchema: {
      mode: z.enum(['incremental', 'full', 'backfill'] as const), accountId: z.string().optional(),
      from: z.string().optional(), to: z.string().optional(),
      wait: z.boolean().optional(), timeoutMs: z.number().int().min(1000).max(600000).optional(),
      idempotencyKey: z.string().max(128).optional(), confirm: CONFIRM,
    },
    annotations: WRITE_WORLD_ANN,
  }, async args => run(async () => {
    const body: Record<string, unknown> = {
      mode: args.mode,
      ...(args.accountId ? { accountId: args.accountId } : {}),
      ...(args.mode === 'backfill' ? { from: args.from, to: args.to } : {}),
      ...(args.wait ? { wait: true, ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}) } : {}),
    };
    return okResult(await client().post('/sync', body, { headers: idemHeaders(args.idempotencyKey) }));
  }));

  toolName(server, 'feige_terms_replace', {
    title: '全量替换词表', description: '以给定规则集全量替换词表（未出现的旧规则删除）；dryRun 只返回 diff。',
    inputSchema: {
      rules: z.array(z.object({
        from: z.array(z.string().min(1).max(32)).min(1), to: z.string().min(1).max(32),
        category: TERM_CATEGORY.optional(), priority: z.number().int().min(0).max(1000).optional(),
        enabled: z.boolean().optional(), caseSensitive: z.boolean().optional(), note: z.string().max(256).optional(),
      })), dryRun: z.boolean().optional(), confirm: CONFIRM,
    },
    annotations: DESTRUCTIVE_ANN,
  }, async args => run(async () => {
    const c = client();
    if (args.dryRun) {
      const all: Array<Record<string, any>> = []; let page = 1;
      for (;;) {
        const res = await c.get<Array<Record<string, any>>>('/terms', { page, size: 500 });
        all.push(...(res.data ?? []));
        const pg = res.meta.pagination; if (!pg || page >= pg.totalPages) break; page++;
      }
      const key = (r: Record<string, any>): string => `${(r.from ?? []).slice().sort().join('|')}=>${r.to}`;
      const before = new Set(all.map(key));
      const after = new Set((args.rules as Array<Record<string, any>>).map(key));
      const data = { applied: false, diff: { added: [...after].filter(k => !before.has(k)).length, updated: [...after].filter(k => before.has(k)).length, removed: [...before].filter(k => !after.has(k)).length, total: args.rules.length } };
      const meta = okEnvelope(null).meta;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data, meta }) }], structuredContent: { ok: true, data, meta } as Record<string, unknown> };
    }
    return okResult(await c.put('/terms', { rules: args.rules, mode: 'replace' }));
  }));

  toolName(server, 'feige_term_add', {
    title: '新增词表规则', description: '新增单条词表归一规则。',
    inputSchema: {
      from: z.array(z.string().min(1).max(32)).min(1), to: z.string().min(1).max(32),
      category: TERM_CATEGORY.optional(), priority: z.number().int().min(0).max(1000).optional(),
      enabled: z.boolean().optional(), caseSensitive: z.boolean().optional(), note: z.string().max(256).optional(), confirm: CONFIRM,
    },
    annotations: WRITE_ANN,
  }, async args => run(async () => {
    const { confirm: _confirm, ...body } = args;
    return okResult(await client().post('/terms', body));
  }));

  toolName(server, 'feige_term_update', {
    title: '修改词表规则', description: '修改词表规则的变体/归一目标/分类/优先级/开关/备注。',
    inputSchema: {
      termId: z.string().regex(/^term_[0-9A-HJKMNP-TV-Z]{26}$/),
      from: z.array(z.string().min(1).max(32)).min(1).optional(), to: z.string().min(1).max(32).optional(),
      category: TERM_CATEGORY.optional(), priority: z.number().int().min(0).max(1000).optional(),
      enabled: z.boolean().optional(), caseSensitive: z.boolean().optional(), note: z.string().max(256).optional(), confirm: CONFIRM,
    },
    annotations: WRITE_ANN,
  }, async args => run(async () => {
    const { termId, confirm: _confirm, ...patch } = args;
    if (!Object.keys(patch).length) invalid('没有需要更新的字段');
    return okResult(await client().patch(`/terms/${encodeURIComponent(termId)}`, patch));
  }));

  toolName(server, 'feige_term_remove', {
    title: '删除词表规则', description: '删除单条词表规则（REST 204；重复删除返回 TERM_NOT_FOUND）。',
    inputSchema: { termId: z.string().regex(/^term_[0-9A-HJKMNP-TV-Z]{26}$/), confirm: CONFIRM }, annotations: DESTRUCTIVE_ANN,
  }, async args => run(async () => okResult(await client().del(`/terms/${encodeURIComponent(args.termId)}`))));
}

function registerResources(server: McpServer): void {
  const register = (name: string, uriOrTemplate: string | ResourceTemplate, description: string, read: (uri: URL, vars: Record<string, unknown>) => Promise<{ data: unknown }>): void => {
    (server as any).registerResource(name, uriOrTemplate as any, { description, mimeType: 'application/json' }, async (uri: URL, vars: Record<string, unknown>) => {
      const { data } = await read(uri, vars ?? {});
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data) }] };
    });
  };
  register('status', 'feige://status', '平台健康快照（StatusPayload）', async () => ({ data: (await client().get('/status')).data }));
  register('accounts-collection', 'feige://accounts', '账号列表（AccountSummary[]）', async () => ({ data: (await client().get('/accounts')).data }));
  register('accounts', new ResourceTemplate('feige://accounts/{accountId}', { list: undefined }), '账号详情（AccountDetail）',
    async (_uri, vars) => ({ data: (await client().get(`/accounts/${encodeURIComponent(String(vars.accountId))}`)).data }));
  register('call', new ResourceTemplate('feige://calls/{callId}', { list: undefined }), '话单摘要（CallSummary）',
    async (_uri, vars) => ({ data: (await client().get(`/calls/${encodeURIComponent(String(vars.callId))}`)).data }));
  register('call-detail', new ResourceTemplate('feige://calls/{callId}/detail', { list: undefined }), '话单详情（CallDetail）',
    async (_uri, vars) => ({ data: (await client().get(`/calls/${encodeURIComponent(String(vars.callId))}/detail`)).data }));
  register('call-transcript', new ResourceTemplate('feige://calls/{callId}/transcript', { list: undefined }), '本地 ASR 转写（TranscriptPayload，source=asr）',
    async (_uri, vars) => ({ data: (await client().get(`/calls/${encodeURIComponent(String(vars.callId))}/transcript`)).data }));
  register('call-audio', new ResourceTemplate('feige://calls/{callId}/audio', { list: undefined }), '录音元数据（含 REST 下载 URL；不内联二进制）',
    async (_uri, vars) => {
      const res = await client().get<Record<string, any>>(`/calls/${encodeURIComponent(String(vars.callId))}/detail`);
      return { data: { callId: String(vars.callId), ...(res.data.recording ?? {}) } };
    });
  register('call-events', new ResourceTemplate('feige://calls/{callId}/events', { list: undefined }), '该话单事件时间线（EventRecord[]）',
    async (_uri, vars) => ({ data: (await client().get(`/calls/${encodeURIComponent(String(vars.callId))}/events`)).data }));
}

function registerPrompts(server: McpServer): void {
  const register = (name: string, title: string, description: string, argsSchema: Record<string, z.ZodTypeAny>, build: (args: Record<string, any>) => { description: string; messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }> }): void => {
    (server as any).registerPrompt(name, { title, description, argsSchema }, (args: Record<string, any>) => build(args ?? {}));
  };
  register('today_call_summary', '当日通话摘要', '汇总指定日期通话并列出意向客户（转写来自本地 ASR，分析来自 DeepSeek）',
    { date: z.string().optional(), accountId: z.string().optional() },
    args => ({
      description: `汇总 ${args.date ?? '今天'} 通话并列出意向客户`,
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `请汇总 ${args.date ?? '今天'}（Asia/Shanghai，accountId=${args.accountId ?? '全部'}）的通话：1) 调用 feige_status 确认账号/dialWindow 与本地 ASR/analysis 队列；2) 调用 feige_call_list（dateFrom/dateTo, size=100，必要时翻页）统计各状态数量；3) 对 ended 且 pipeline.transcript=ready 的通话调用 feige_call_transcript（includeAnalysis=true）提取客户意向（转写来自平台本地 ASR，分析来自 DeepSeek）；4) 对 transcript.needsReview=true 的通话标注"需人工复核"；5) 输出脱敏表格（callId、号码掩码、时长、意向、下一步）。禁止发起任何外呼。`,
        },
      }],
    }));
  register('follow_up_unanswered', '未接通回访建议', '基于未接通话单生成回访建议与名单（含冷却/时段提示）',
    { date: z.string().optional(), accountId: z.string().optional() },
    args => ({
      description: `生成 ${args.date ?? '今天'} 未接通话单的回访建议`,
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `请调用 feige_call_list（dateFrom/dateTo=${args.date ?? '今天'}，status=no_answer，size=100${args.accountId ? `，accountId=${args.accountId}` : ''}）读取未接通话单，结合 callId/号码掩码/时长/重试次数生成回访建议：注意同号 60s 冷却、单账号串行与 07:50–22:00 拨打时段；不要自动重拨或批量呼出，仅输出建议清单与需人工确认项。`,
        },
      }],
    }));
  register('review_call', '单通电话复盘', '单通电话复盘：详情→本地 ASR 转写→DeepSeek 分析，输出摘要/意向/待跟进点',
    { callId: CALL_ID },
    args => ({
      description: `复盘通话 ${args.callId}`,
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `请复盘通话 ${args.callId}：1) 调用 feige_call_detail 读取 pipeline/录音/分析状态；2) 转写 ready 后调用 feige_call_transcript（includeAnalysis=true）读取本地 ASR 分段与 DeepSeek 分析摘要；3) 输出摘要、意向、待跟进点、风险/合规提示，并标注 needsReview 与 AnalysisPayload.promptVersion/usage（若可用）。不要编造未出现的信息；号码需掩码。`,
        },
      }],
    }));
}

function parseMcpArgs(argv: string[]): { allowWrite: boolean; printConfig: boolean; transport: string } {
  let allowWrite = false; let printConfig = false; let transport = 'stdio';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--allow-write') allowWrite = true;
    else if (a === '--print-config') printConfig = true;
    else if (a === '--transport') { transport = argv[++i] ?? ''; }
    else if (a.startsWith('--transport=')) transport = a.slice('--transport='.length);
    else if (a === '--log-level') { i++; }
    else if (a.startsWith('--log-level=')) { /* ignore */ }
    else if (a === '--help' || a === '-h') {
      process.stderr.write('用法: feige mcp [--transport stdio] [--allow-write] [--print-config] [--log-level <level>]\n');
      process.exit(0);
    } else {
      process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'INVALID_REQUEST', message: `未知参数：${a}`, retryable: false } })}\n`);
      process.exit(2);
    }
  }
  return { allowWrite, printConfig, transport };
}

export async function runMcp(argv: string[]): Promise<void> {
  const { allowWrite, printConfig, transport } = parseMcpArgs(argv);
  if (transport !== 'stdio') {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'INVALID_REQUEST', message: `v1 仅支持 stdio，收到：${transport}`, retryable: false } })}\n`);
    process.exit(2);
  }
  if (printConfig) {
    process.stdout.write(`${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: 'feige', args: ['mcp', ...(allowWrite ? ['--allow-write'] : [])], env: { FOP_API_URL: new ApiClient().base } } } }, null, 2)}\n`);
    return;
  }

  const server = new McpServer({ name: MCP_SERVER_NAME, version: VERSION }, { capabilities: { tools: {}, resources: {}, prompts: {} } } as any);
  registerReadTools(server);
  if (allowWrite) registerWriteTools(server);
  registerResources(server);
  registerPrompts(server);

  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  // connect 后 stdin 监听维持进程；stdin 关闭时进程自然退出
}
