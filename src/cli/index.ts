// feige CLI：REST v1 的薄封装（docs/06）。不 import 服务内部实现，仅经 HTTP 调用。
import { Command, CommanderError } from 'commander';
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  ApiClient, CliError, MCP_SERVER_NAME, VERSION, configDir, fixToken, flatten, isoToHuman, kv,
  msToTimestamp, nowIso, okEnvelope, oneLine, parseDuration, printError, readToken, sleep, table,
  toCliError, tokenFileFor, writeJson, writeLine,
  type ApiResponse, type GlobalOpts,
} from './http.js';

/** ---------------- 通用小工具 ---------------- */
function str(v: unknown): string | undefined { return typeof v === 'string' && v.trim() ? v.trim() : undefined; }
function num(v: unknown): number | undefined { if (v === undefined || v === null || v === '') return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; }
function collect(val: string, prev: string[] = []): string[] { return [...(Array.isArray(prev) ? prev : []), val]; }
function splitCsv(v: unknown): string[] { const s = str(v); return s ? s.split(',').map(x => x.trim()).filter(Boolean) : []; }

function globals(cmd: Command): GlobalOpts {
  const o = cmd.optsWithGlobals() as Record<string, unknown>;
  return {
    api: str(o.api), token: str(o.token), tokenFile: str(o.tokenFile),
    json: o.json === true, quiet: o.quiet === true, verbose: o.verbose === true,
    timeout: o.timeout as string | number | undefined, yes: o.yes === true,
  };
}
function api(cmd: Command): ApiClient { return new ApiClient(globals(cmd)); }

function emit<T>(cmd: Command, res: ApiResponse<T>, human: (d: T) => void): void {
  const o = globals(cmd);
  if (o.json) { writeJson({ ok: true, data: res.data, meta: res.meta }); return; }
  if (o.quiet) return;
  human(res.data);
}
function emitLocal<T>(cmd: Command, data: T, human: () => void): void {
  const o = globals(cmd);
  if (o.json) { writeJson(okEnvelope(data)); return; }
  if (o.quiet) return;
  human();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

async function confirmOrThrow(action: string, o: GlobalOpts & { dryRun?: boolean }): Promise<void> {
  if (o.dryRun || o.yes) return;
  if (!process.stdin.isTTY) throw new CliError('INVALID_REQUEST', `非交互模式执行「${action}」必须显式加 --yes（或先 --dry-run 查看计划）`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const ans = await rl.question(`⚠ ${action}，确认执行？输入 yes 继续：`);
    if (ans.trim() !== 'yes') throw new CliError('INVALID_REQUEST', '已取消');
  } finally { rl.close(); }
}

function metadataOf(pairs?: string[]): Record<string, string> | undefined {
  if (!pairs?.length) return undefined;
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const idx = p.indexOf('=');
    if (idx <= 0) throw new CliError('VALIDATION_FAILED', `--metadata 需要 k=v 形式：${p}`);
    out[p.slice(0, idx)] = p.slice(idx + 1);
  }
  if (Object.keys(out).length > 10) throw new CliError('VALIDATION_FAILED', 'metadata 最多 10 个键');
  return out;
}

function applyDot(base: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.').filter(Boolean);
  if (!parts.length) throw new CliError('VALIDATION_FAILED', '配置键不能为空');
  let cur = base;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}
function parseScalar(raw: string): unknown {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t);
  if (/^[\[{]/.test(t)) { try { return JSON.parse(t); } catch { /* keep string */ } }
  return raw;
}
function parseKeyValues(pairs: string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const p of pairs) {
    const idx = p.indexOf('=');
    if (idx <= 0) throw new CliError('VALIDATION_FAILED', `配置参数需要 key=value 形式：${p}`);
    applyDot(patch, p.slice(0, idx), parseScalar(p.slice(idx + 1)));
  }
  return patch;
}
function deepMergeAny(base: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = k in out ? deepMergeAny(out[k], v) : v;
  return out;
}
function configFile(): string { return join(configDir(), 'config.json'); }
function secretsFile(): string { return join(configDir(), 'secrets.json'); }
function readJsonFile(p: string): Record<string, unknown> | undefined {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown> : undefined; } catch { return undefined; }
}
function paginationOpts(opts: Record<string, unknown>): Record<string, unknown> {
  const page = num(opts.page); const size = num(opts.size);
  return { ...(page ? { page } : {}), ...(size ? { size } : {}) };
}
function isTerminal(status: string): boolean { return ['ended', 'no_answer', 'failed', 'canceled'].includes(status); }

async function pollCall(cmd: Command, callId: string, timeoutMs: number): Promise<Record<string, any>> {
  const c = api(cmd); const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await c.get<Record<string, any>>(`/calls/${encodeURIComponent(callId)}`);
    const status = String(res.data.status ?? '');
    if (isTerminal(status) || Date.now() >= deadline) return res.data;
    await sleep(2000);
  }
}
async function pollJob(cmd: Command, jobId: string, timeoutMs: number): Promise<Record<string, any>> {
  const c = api(cmd); const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await c.get<Record<string, any>>(`/jobs/${encodeURIComponent(jobId)}`);
    const status = String(res.data.status ?? '');
    if (['succeeded', 'failed', 'canceled'].includes(status) || Date.now() >= deadline) return res.data;
    await sleep(1500);
  }
}

/** ---------------- 人类可读渲染 ---------------- */
function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` : `${h}h ${String(m).padStart(2, '0')}m`;
}
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function renderStatus(d: Record<string, any>): void {
  const dw = d.dialWindow ?? {}; const acc = d.accounts ?? {}; const db = d.db ?? {};
  const q = d.queues ?? {}; const sync = d.sync ?? {};
  kv([
    ['平台状态', `${d.version ?? '-'}   运行 ${fmtUptime(Number(d.uptimeSec ?? 0))}`],
    ['服务端时间', oneLine(d.now)],
    ['数据库', `${db.ok ? 'ok' : '异常'}  ${fmtBytes(Number(db.sizeBytes ?? 0))}  schema v${oneLine(db.schemaVersion)}  ${oneLine(db.latencyMs)}ms`],
    ['拨打时段', `${dw.open ? '开放' : '关闭'}  ${oneLine(dw.windowStart)}–${oneLine(dw.windowEnd)} ${oneLine(dw.timezone)}`],
    ['账号', `${acc.total ?? 0} 个：online ${acc.online ?? 0} / expired ${acc.expired ?? 0} / logging_in ${acc.loggingIn ?? 0}`],
    ['上游', `${d.upstream?.reachable ? '可达' : '不可达'}  ${oneLine(d.upstream?.latencyMs)}ms`],
    ['队列', `作业 queued ${q.jobsQueued ?? 0} / running ${q.jobsRunning ?? 0} / 24h 失败 ${q.jobsFailed24h ?? 0}`],
    ['流水线', `audio ${q.audioPending ?? 0} / 本地 ASR ${q.transcriptPending ?? 0} / analysis ${q.analysisPending ?? 0}`],
    ['最近同步', `${isoToHuman(sync.lastSyncAt)}  滞后账号 ${(sync.laggingAccounts ?? []).length}`],
    ['SSE 客户端', oneLine(d.events?.sseClients)],
  ]);
}
function renderAccount(a: Record<string, any>): void {
  kv([
    ['accountId', oneLine(a.accountId)], ['展示名', oneLine(a.displayName)], ['状态', oneLine(a.state)],
    ['启用', oneLine(a.enabled)], ['拨打模式', oneLine(a.dialMode)],
    ['线路', `${oneLine(a.line?.lineName)} lineId=${oneLine(a.line?.lineId)}`],
    ['JWT 到期', oneLine(a.jwtExpiresAt)], ['最近登录', isoToHuman(a.lastLoginAt)], ['最近检查', isoToHuman(a.lastCheckedAt)],
    ['最近错误', a.lastError ? `${oneLine(a.lastError.code)}: ${oneLine(a.lastError.message)}` : '-'],
    ['统计', `话单 ${oneLine(a.stats?.totalCalls)} / 24h ${oneLine(a.stats?.calls24h)}`],
  ]);
}
function renderCallSummary(c: Record<string, any>): void {
  kv([
    ['callId', oneLine(c.callId)], ['状态', `${oneLine(c.status)}${c.statusReason ? `（${c.statusReason}）` : ''}`],
    ['号码', `${oneLine(c.to?.phone)}（客户） ← ${oneLine(c.from?.phone)}（坐席）`],
    ['账号', oneLine(c.accountId)], ['拨号', isoToHuman(c.dialedAt)], ['接通', isoToHuman(c.answeredAt)],
    ['结束', `${isoToHuman(c.endedAt)}  时长 ${oneLine(c.durationSec)}s  话费 ¥${oneLine(c.cost)}`],
    ['流水线', `audio ${oneLine(c.pipeline?.audio)} · transcript ${oneLine(c.pipeline?.transcript)} · analysis ${oneLine(c.pipeline?.analysis)}`],
    ['录音', c.audioAvailable ? '已归档' : '-'], ['转写预览', oneLine(c.transcriptPreview)],
    ['线路', `${oneLine(c.lineName)} lineId=${oneLine(c.lineId)}`], ['客户名', oneLine(c.customerName)],
  ]);
}
function roleLabel(r: unknown): string { return r === 'agent' ? '坐席' : r === 'customer' ? '客户' : '未知'; }
function srtTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms)); const h = Math.floor(total / 3600000); const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000); const ms3 = total % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms3).padStart(3, '0')}`;
}
function renderTranscript(data: Record<string, any>, format: string, role?: string): string {
  const segments: Array<Record<string, any>> = Array.isArray(data.segments) ? data.segments : [];
  const filtered = role ? segments.filter(s => s.role === role) : segments;
  if (format === 'json') return JSON.stringify(data, null, 2);
  if (format === 'markdown') {
    const head = `# 转写 ${oneLine(data.callId)}\n\n> source=${oneLine(data.source)} provider=${oneLine(data.provider)} 段数=${filtered.length} 段\n\n`;
    return head + filtered.map(s => `- [${msToTimestamp(Number(s.beginMs ?? 0))}] **${roleLabel(s.role)}** ${oneLine(s.normalizedText || s.rawText)}`).join('\n') + '\n';
  }
  if (format === 'srt') {
    return filtered.map((s, i) => `${i + 1}\n${srtTime(Number(s.beginMs ?? 0))} --> ${srtTime(Number(s.endMs ?? 0))}\n${roleLabel(s.role)}: ${oneLine(s.normalizedText || s.rawText)}\n`).join('\n');
  }
  const lines = filtered.map(s => `[${msToTimestamp(Number(s.beginMs ?? 0))}] ${roleLabel(s.role).padEnd(2, '　')} ${oneLine(s.normalizedText || s.rawText)}`);
  return `${lines.join('\n')}\n（${filtered.length} 段 · source=${oneLine(data.source)} · provider=${oneLine(data.provider)} · 已词表归一）`;
}

/** ---------------- 命令注册辅助 ---------------- */
interface CliState { exitCode: number; interrupted: boolean; abort: AbortController }

function addCommonOptions(cmd: Command): Command {
  return cmd
    .option('--api <url>', 'REST 基址（默认 FOP_API_URL 或 http://127.0.0.1:8710/api/v1）')
    .option('--token <token>', '本地 API token（默认读 token 文件）')
    .option('--token-file <path>', '本地 API token 文件')
    .option('-j, --json', '输出与 REST 同构的 JSON 封套')
    .option('-q, --quiet', '只输出关键结果/错误')
    .option('-v, --verbose', '调试日志到 stderr')
    .option('--timeout <dur>', '单次请求超时（30s / 5m）')
    .option('-y, --yes', '跳过危险操作确认（非交互必需）');
}

function fmtEvent(ev: Record<string, any>): string {
  const data = ev.data && typeof ev.data === 'object' ? ev.data : {};
  const extra = Object.entries(data).slice(0, 3).map(([k, v]) => `${k}=${oneLine(v)}`).join(' ');
  return `${isoToHuman(ev.occurredAt)}  ${String(ev.type ?? '').padEnd(28)}  ${oneLine(ev.callId ?? ev.accountId ?? '')}  ${extra}`.trimEnd();
}

async function followEvents(cmd: Command, state: CliState, query: Record<string, unknown>, durationSec?: number): Promise<void> {
  const o = globals(cmd);
  const local = new AbortController();
  const timer = durationSec && durationSec > 0 ? setTimeout(() => local.abort(), durationSec * 1000) : undefined;
  const signal = AbortSignal.any([state.abort.signal, local.signal]);
  try {
    await api(cmd).sse('/events/stream', query, ev => {
      if (o.json) {
        try { writeJson(JSON.parse(ev.data)); } catch { writeJson({ ok: true, data: ev.data, meta: { requestId: newLocalId(), ts: nowIso() } }); }
        return;
      }
      try {
        const parsed = JSON.parse(ev.data) as Record<string, any>;
        writeLine(fmtEvent(parsed));
      } catch { writeLine(ev.data); }
    }, { signal, lastEventId: str((cmd.opts() as any).lastEventId) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function newLocalId(): string { return `req_cli_${Date.now().toString(36)}`; }

/** ---------------- 程序构建 ---------------- */
export function buildProgram(state: CliState): Command {
  const program = new Command();
  program.name('feige').description('飞鸽外呼本地平台 CLI（REST 薄封装）').version(VERSION, '--version', '显示版本');
  addCommonOptions(program).option('--no-color', '禁用颜色')
    .option('--help-all', '显示全部命令与子命令的完整帮助（递归，含所有选项）');
  program.addHelpText('after', '\n使用 `feige help <command>` 查看某个命令的子命令；\n使用 `feige --help-all` 查看完整命令树（所有命令与子命令、参数、选项）；\nREST API 运行时文档：http://127.0.0.1:8710/api/v1/docs');
  program.exitOverride();
  program.configureOutput({ writeErr: () => { /* 由 runCli 统一输出 */ } });

  // ---- 常驻进程（serve/mcp 由 main.ts 直接路由；此处注册仅为帮助文档完整性）----
  addCommonOptions(program.command('serve').description('启动本地服务（systemd 常驻；main.ts 直接路由）')
    .option('--port <n>', '监听端口（默认 8710 / FOP_PORT）')
    .option('--host <host>', '监听地址（默认 127.0.0.1 / FOP_HOST）'))
    .action((...args: any[]) => {
      const cmd = args[args.length - 1] as Command; void cmd;
      writeLine('serve 由 `feige serve` 直接启动（不经过 CLI 解析）；端口/地址可用 --port/--host 或 FOP_PORT/FOP_HOST。');
    });
  addCommonOptions(program.command('mcp').description('启动 MCP stdio server（main.ts 直接路由；agent 集成入口）')
    .option('--allow-write', '开放写工具（默认只读 18 个；开启后 32 个，写工具需 confirm:true）'))
    .action((...args: any[]) => {
      const cmd = args[args.length - 1] as Command; void cmd;
      writeLine('MCP server 由 `feige mcp` 直接启动（stdio JSON-RPC）；工具列表见 `docs/07-MCP工具契约.md`。');
    });

  // ---- 平台 ----
  addCommonOptions(program.command('health').description('存活探针（GET /health）'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command;
      const res = await api(cmd).get<Record<string, any>>('/health');
      emit(cmd, res, d => writeLine(`OK  ${MCP_SERVER_NAME} v${oneLine(d.version)}  uptime ${fmtUptime(Number(d.uptimeSec ?? 0))}`));
    });

  addCommonOptions(program.command('status').description('平台健康（GET /status）'))
    .option('--no-detail', '不返回 accountsDetail')
    .option('--watch', '持续刷新')
    .option('--interval <dur>', '刷新间隔', '5s')
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const o = globals(cmd); const opts = cmd.opts() as any;
      const detail = opts.detail !== false;
      if (!opts.watch) { const res = await api(cmd).get<Record<string, any>>('/status', { detail }); emit(cmd, res, renderStatus); return; }
      const interval = parseDuration(opts.interval as string, 5000);
      while (!state.interrupted) {
        const res = await api(cmd).get<Record<string, any>>('/status', { detail });
        if (o.json) writeJson({ ok: true, data: res.data, meta: res.meta });
        else { if (!o.quiet) renderStatus(res.data); writeLine(''); }
        await sleep(interval);
      }
    });

  addCommonOptions(program.command('version').description('版本信息'))
    .action((...args: any[]) => {
      const cmd = args[args.length - 1] as Command;
      emitLocal(cmd, { version: VERSION, apiVersion: 'v1', mcpServer: MCP_SERVER_NAME, protocol: 'stdio' },
        () => writeLine(`feige ${VERSION}   api v1   mcp ${MCP_SERVER_NAME} (stdio)   node ${process.version}`));
    });

  // ---- config ----
  const configCmd = program.command('config').description('生效配置');
  addCommonOptions(configCmd.command('get').description('读取配置（GET /config）').option('--key <path>', '点路径，如 pipeline.asr'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const key = str((cmd.opts() as any).key);
      const res = await api(cmd).get<Record<string, unknown>>('/config');
      let data: unknown = res.data;
      if (key) {
        for (const part of key.split('.')) {
          data = data !== null && typeof data === 'object' ? (data as Record<string, unknown>)[part] : undefined;
          if (data === undefined) throw new CliError('VALIDATION_FAILED', `配置键不存在：${key}`);
        }
      }
      if (globals(cmd).json) { writeJson({ ok: true, data, meta: res.meta }); return; }
      const pairs = data !== null && typeof data === 'object' && !Array.isArray(data) ? flatten(data, key) : [[key ?? '-', oneLine(data)] as [string, string]];
      if (!globals(cmd).quiet) kv(pairs);
    });
  addCommonOptions(configCmd.command('set').description('局部更新配置（PATCH /config）')
    .argument('[pairs...]', 'key=value 形式，如 dial.windowEnd=21:30')
    .option('--file <path>', 'Merge Patch JSON 文件（- 表示 stdin）')
    .option('--dry-run', '只输出 diff，不 PATCH'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const pairs = (args[0] as string[]) ?? [];
      const o = globals(cmd); const opts = cmd.opts() as any;
      let patch: Record<string, unknown>;
      if (opts.file) {
        const raw = opts.file === '-' ? await readStdin() : readFileSync(String(opts.file), 'utf8');
        try { patch = JSON.parse(raw) as Record<string, unknown>; } catch (e) { throw new CliError('VALIDATION_FAILED', `patch JSON 解析失败：${(e as Error).message}`); }
      } else {
        if (!pairs.length) throw new CliError('VALIDATION_FAILED', '缺少 key=value 或 --file');
        patch = parseKeyValues(pairs);
      }
      if (opts.dryRun) {
        const res = await api(cmd).get<Record<string, unknown>>('/config');
        const before = Object.fromEntries(flatten(res.data));
        const after = Object.fromEntries(flatten(deepMergeAny(res.data, patch)));
        const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => before[k] !== after[k]);
        const diff = keys.map(k => ({ path: k, from: before[k] ?? null, to: after[k] ?? null }));
        emitLocal(cmd, { applied: false, diff }, () => { writeLine('配置变更（未应用）'); if (diff.length) kv(diff.map(x => [x.path, `${oneLine(x.from ?? '-')} → ${oneLine(x.to ?? '-')}`])); else writeLine('无变化'); });
        return;
      }
      await confirmOrThrow('应用配置变更', o);
      const res = await api(cmd).patch<Record<string, unknown>>('/config', patch);
      emit(cmd, res, d => writeLine(`✔ 已应用配置（restartRequired=${oneLine(d.restartRequired)}）`));
    });

  // ---- account ----
  const accountCmd = program.command('account').description('账号管理');
  addCommonOptions(accountCmd.command('list').description('账号列表（GET /accounts）')
    .option('--state <s>', '状态过滤（逗号分隔）').option('--enabled', '仅启用').option('--page <n>').option('--size <n>'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const opts = cmd.opts() as any;
      const query = { ...(opts.enabled ? { enabled: true } : {}), ...(splitCsv(opts.state).length ? { state: splitCsv(opts.state) } : {}), ...paginationOpts(opts) };
      const res = await api(cmd).get<Array<Record<string, any>>>('/accounts', query);
      emit(cmd, res, rows => table(['ACCOUNT', 'DISPLAY', 'STATE', 'JWT 到期', '最近登录', '24h 话单'],
        (rows ?? []).map(a => [oneLine(a.accountId), oneLine(a.displayName), oneLine(a.state), oneLine(a.jwtExpiresAt), isoToHuman(a.lastLoginAt), oneLine(a.stats?.calls24h)])));
    });
  addCommonOptions(accountCmd.command('show').description('账号详情（GET /accounts/{id}）').argument('<accountId>'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const accountId = String(args[0]);
      const res = await api(cmd).get<Record<string, any>>(`/accounts/${encodeURIComponent(accountId)}`);
      emit(cmd, res, renderAccount);
    });
  addCommonOptions(accountCmd.command('add').description('注册账号（POST /accounts）').argument('<accountId>')
    .option('--username <phone>', '上游登录手机号')
    .option('--password-stdin', '从 stdin 读取密码')
    .option('--password-env <ENV>', '从环境变量读取密码')
    .option('--display-name <name>', '展示名')
    .option('--concurrency <n>', '并发（v1 固定 1）')
    .option('--browser-headless', '登录浏览器 headless')
    .option('--profile-dir-name <name>', '浏览器 profile 目录名')
    .option('--metadata <k=v>', '自定义键值（可重复）', collect, [])
    .option('--dry-run', '只做本地校验'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const accountId = String(args[0]); const opts = cmd.opts() as any;
      const username = str(opts.username);
      if (!username) throw new CliError('VALIDATION_FAILED', '缺少 --username');
      if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(accountId)) throw new CliError('VALIDATION_FAILED', `accountId 非法（^[a-z0-9][a-z0-9_-]{1,31}$）：${accountId}`);
      if (!/^1[3-9]\d{9}$/.test(username)) throw new CliError('VALIDATION_FAILED', 'username 需为 11 位手机号');
      let password: string | undefined;
      if (opts.passwordStdin) password = (await readStdin()).trim();
      else if (opts.passwordEnv) password = process.env[String(opts.passwordEnv)];
      if (!opts.dryRun && !password) throw new CliError('VALIDATION_FAILED', '缺少密码：使用 --password-stdin 或 --password-env（不接受命令行明文）');
      if (password && (password.length < 8 || password.length > 64)) throw new CliError('VALIDATION_FAILED', '密码长度需 8–64');
      const metadata = metadataOf(opts.metadata as string[]);
      if (opts.dryRun) {
        emitLocal(cmd, { dryRun: true, accountId, username, displayName: str(opts.displayName) ?? accountId },
          () => writeLine(`预检通过（未创建）：accountId=${accountId} username=${username}`));
        return;
      }
      const body: Record<string, unknown> = {
        accountId, displayName: str(opts.displayName) ?? accountId, username, password,
        ...(num(opts.concurrency) ? { concurrency: num(opts.concurrency) } : {}),
        ...(opts.browserHeadless || str(opts.profileDirName) ? { browser: { ...(opts.browserHeadless ? { headless: true } : {}), ...(str(opts.profileDirName) ? { profileDirName: str(opts.profileDirName) } : {}) } } : {}),
        ...(metadata ? { metadata } : {}),
      };
      const res = await api(cmd).post<Record<string, any>>('/accounts', body);
      emit(cmd, res, d => { writeLine(`✔ 账号已创建  ${oneLine(d.accountId)}`); kv([['展示名', oneLine(d.displayName)], ['上游手机', oneLine(d.upstreamUsername ?? d.upstreamUsernameMasked)], ['状态', oneLine(d.state)], ['下一步', `feige account login ${oneLine(d.accountId)}`]]); });
    });
  addCommonOptions(accountCmd.command('update').description('更新账号（PATCH /accounts/{id}）').argument('<accountId>')
    .option('--display-name <name>', '展示名')
    .option('--enable', '启用')
    .option('--disable', '停用')
    .option('--password-stdin', '轮换密码（stdin）')
    .option('--password-env <ENV>', '轮换密码（环境变量）')
    .option('--browser-headless', '浏览器 headless')
    .option('--browser-headful', '浏览器 headful')
    .option('--metadata <k=v>', '覆盖/新增 metadata（可重复）', collect, [])
    .option('--relogin', '密码变更后立即重登'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const accountId = String(args[0]); const opts = cmd.opts() as any;
      const patch: Record<string, unknown> = {};
      if (str(opts.displayName)) patch.displayName = str(opts.displayName);
      if (opts.enable) patch.enabled = true;
      if (opts.disable) patch.enabled = false;
      let password: string | undefined;
      if (opts.passwordStdin) password = (await readStdin()).trim();
      else if (opts.passwordEnv) password = process.env[String(opts.passwordEnv)];
      if (opts.passwordStdin || opts.passwordEnv) { if (!password) throw new CliError('VALIDATION_FAILED', '未能读取到密码'); patch.password = password; }
      if (opts.browserHeadless) patch.browser = { ...((patch.browser as object) ?? {}), headless: true };
      if (opts.browserHeadful) patch.browser = { ...((patch.browser as object) ?? {}), headless: false };
      const metadata = metadataOf(opts.metadata as string[]); if (metadata) patch.metadata = metadata;
      if (!Object.keys(patch).length) throw new CliError('VALIDATION_FAILED', '没有需要更新的字段');
      if (patch.password) await confirmOrThrow('轮换账号密码（会清除现有会话）', globals(cmd));
      const res = await api(cmd).request<Record<string, any>>('PATCH', `/accounts/${encodeURIComponent(accountId)}`, { body: patch, ...(opts.relogin ? { query: { relogin: true } } : {}) });
      emit(cmd, res, d => writeLine(`✔ 已更新 ${oneLine(d.accountId)}  displayName=${oneLine(d.displayName)} enabled=${oneLine(d.enabled)}`));
    });
  addCommonOptions(accountCmd.command('remove').description('移除账号（DELETE /accounts/{id}）').argument('<accountId>')
    .option('--purge-data', '同时删除本地历史数据（不可恢复）')
    .option('--dry-run', '只显示将移除的账号'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const accountId = String(args[0]); const opts = cmd.opts() as any;
      if (opts.dryRun) {
        const res = await api(cmd).get<Record<string, any>>(`/accounts/${encodeURIComponent(accountId)}`);
        emitLocal(cmd, { dryRun: true, accountId, purgeData: !!opts.purgeData },
          () => { writeLine(`账号 ${accountId} 将被移除${opts.purgeData ? '（并删除历史数据，不可恢复）' : '（历史数据默认保留）'}`); renderAccount(res.data); });
        return;
      }
      await confirmOrThrow(`移除账号 ${accountId}${opts.purgeData ? ' 并删除历史数据（不可恢复）' : ''}`, globals(cmd));
      const query: Record<string, unknown> = opts.purgeData ? { purgeData: true, confirm: `PURGE:${accountId}` } : {};
      const res = await api(cmd).del<null>(`/accounts/${encodeURIComponent(accountId)}`, query);
      emit(cmd, res, () => writeLine(`✔ 已移除账号 ${accountId}`));
    });
  addCommonOptions(accountCmd.command('login').description('触发登录（POST /accounts/{id}/login）').argument('<accountId>')
    .option('--async', '不等待登录结果（wait=false）')
    .option('--timeout-ms <n>', '等待上限（毫秒，10000–300000）')
    .option('--force', '已有会话也强制重登')
    .option('--idempotency-key <key>', '幂等键'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const accountId = String(args[0]); const opts = cmd.opts() as any;
      await confirmOrThrow('使用上游凭证在浏览器中登录（可能触发滑块/风控）', globals(cmd));
      const body: Record<string, unknown> = { wait: opts.async ? false : true, ...(num(opts.timeoutMs) ? { timeoutMs: num(opts.timeoutMs) } : {}), ...(opts.force ? { force: true } : {}) };
      const headers: Record<string, string> = {};
      if (str(opts.idempotencyKey)) headers['Idempotency-Key'] = String(opts.idempotencyKey);
      const res = await api(cmd).post<Record<string, any>>(`/accounts/${encodeURIComponent(accountId)}/login`, body, { headers });
      emit(cmd, res, d => {
        if (d.loginJobId && d.loggedIn === undefined) writeLine(`✔ 登录已受理  ${accountId}  loginJobId=${oneLine(d.loginJobId)}  pollUrl=${oneLine(d.pollUrl)}`);
        else { writeLine(`✔ 登录成功  ${accountId}`); kv([['state', oneLine(d.state)], ['jwtExpiresAt', oneLine(d.jwtExpiresAt)], ['loginJobId', oneLine(d.loginJobId)]]); }
      });
    });
  addCommonOptions(accountCmd.command('logout').description('退出本地会话（POST /accounts/{id}/logout）').argument('<accountId>'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const accountId = String(args[0]);
      await confirmOrThrow(`退出账号 ${accountId} 的本地会话`, globals(cmd));
      const res = await api(cmd).post<null>(`/accounts/${encodeURIComponent(accountId)}/logout`);
      emit(cmd, res, () => writeLine(`✔ 已退出本地会话  ${accountId}`));
    });
  addCommonOptions(accountCmd.command('health').description('单账号健康（GET /accounts/{id}/health）').argument('<accountId>'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const accountId = String(args[0]);
      const res = await api(cmd).get<Record<string, any>>(`/accounts/${encodeURIComponent(accountId)}/health`);
      emit(cmd, res, d => kv([
        ['账号', `${oneLine(d.accountId)}  state=${oneLine(d.state)}`],
        ['jwt', `${d.jwt?.valid ? '有效' : '无效'}  剩余 ${oneLine(d.jwt?.expiresInSec)}s`],
        ['ws', `${d.ws?.connected ? 'connected' : 'disconnected'}  ${oneLine(d.ws?.latencyMs)}ms`],
        ['上游', `${d.upstream?.reachable ? '可达' : '不可达'}  ${isoToHuman(d.upstream?.checkedAt)}`],
        ['线路', `${oneLine(d.line?.lineName)} lineId=${oneLine(d.line?.lineId)}`],
        ['拨打时段', `${d.dialWindow?.open ? '开放' : '关闭'} ${oneLine(d.dialWindow?.windowStart)}–${oneLine(d.dialWindow?.windowEnd)}`],
        ['当前通话', d.busy?.inCall ? oneLine(d.busy?.busyCallId) : '无'],
      ]));
    });

  // ---- dial ----
  addCommonOptions(program.command('dial').description('发起呼出（POST /calls，有副作用/计费）').argument('<toPhone>')
    .option('--account <accountId>', '指定账号')
    .option('--customer-name <name>', '客户名')
    .option('--metadata <k=v>', '自定义键值（可重复）', collect, [])
    .option('--scheduled-at <iso>', '期望呼出时间')
    .option('--idempotency-key <key>', '幂等键')
    .option('--wait', '等待接通/终态')
    .option('--wait-timeout <dur>', '等待超时', '180s')
    .option('--dry-run', '只做预检，不产生话单'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const to = String(args[0]); const opts = cmd.opts() as any;
      if (!/^(1[3-9]\d{9}|0\d{2,3}-?\d{7,8})$/.test(to)) throw new CliError('VALIDATION_FAILED', `号码格式非法：${to}`);
      const body: Record<string, unknown> = {
        to,
        ...(str(opts.account) ? { accountId: str(opts.account) } : {}),
        ...(str(opts.customerName) ? { customerName: str(opts.customerName) } : {}),
        ...(metadataOf(opts.metadata as string[]) ? { metadata: metadataOf(opts.metadata as string[]) } : {}),
        ...(str(opts.scheduledAt) ? { scheduledAt: str(opts.scheduledAt) } : {}),
        ...(opts.dryRun ? { dryRun: true } : {}),
      };
      if (!opts.dryRun) await confirmOrThrow(`向 ${to} 发起真实外呼（可能产生话费，需坐席手机接听）`, globals(cmd));
      const headers: Record<string, string> = {};
      if (str(opts.idempotencyKey)) headers['Idempotency-Key'] = String(opts.idempotencyKey);
      const res = await api(cmd).post<Record<string, any>>('/calls', body, { headers });
      if (!globals(cmd).json) {
        if (opts.dryRun) { writeLine(`预检通过（未产生话单）  willDial=${oneLine(res.data.willDial)}  账号=${oneLine(res.data.accountId)}  号码=${oneLine(res.data.to)}`); return; }
        writeLine(`✔ 呼出已受理`); kv([['callId', oneLine(res.data.callId)], ['号码', oneLine(res.data.to?.phone)], ['账号', oneLine(res.data.accountId)], ['状态', oneLine(res.data.status)]]);
      }
      if (opts.wait && !opts.dryRun && res.data.callId) {
        const final = await pollCall(cmd, String(res.data.callId), parseDuration(opts.waitTimeout, 180_000));
        if (globals(cmd).json) writeJson({ ok: true, data: final, meta: res.meta });
        else { writeLine(''); renderCallSummary(final); }
        return;
      }
      if (globals(cmd).json) writeJson({ ok: true, data: res.data, meta: res.meta });
    });

  // ---- calls ----
  const callsCmd = program.command('calls').description('话单');
  addCommonOptions(callsCmd.command('list').description('话单列表（GET /calls）')
    .option('--account <id>', '账号过滤')
    .option('--status <s>', '状态（逗号分隔）')
    .option('--pipeline <stage:status>', '流水线过滤，如 transcript:ready（可重复）', collect, [])
    .option('--has-audio', '仅已归档录音')
    .option('--has-transcript', '仅有转写')
    .option('--to <phone>', '被叫号码（支持 *1234 后四位模糊）')
    .option('--q <text>', '文本搜索')
    .option('--from-date <date>', 'startedAt 起始日期')
    .option('--to-date <date>', 'startedAt 结束日期')
    .option('--date <date>', '单日（等价 from-date=to-date）')
    .option('--sort <field>', '排序', '-createdAt')
    .option('--page <n>').option('--size <n>').option('--no-include-pipeline', '不返回 pipeline'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const opts = cmd.opts() as any;
      const query: Record<string, unknown> = {
        ...(str(opts.account) ? { accountId: str(opts.account) } : {}),
        ...(splitCsv(opts.status).length ? { status: splitCsv(opts.status) } : {}),
        ...(opts.hasAudio ? { hasAudio: true } : {}),
        ...(opts.hasTranscript ? { hasTranscript: true } : {}),
        ...(str(opts.to) ? { to: str(opts.to) } : {}),
        ...(str(opts.q) ? { q: str(opts.q) } : {}),
        ...(str(opts.date) ? { dateFrom: str(opts.date), dateTo: str(opts.date) } : {}),
        ...(str(opts.fromDate) ? { dateFrom: str(opts.fromDate) } : {}),
        ...(str(opts.toDate) ? { dateTo: str(opts.toDate) } : {}),
        ...(str(opts.sort) ? { sort: str(opts.sort) } : {}),
        ...(opts.includePipeline === false ? { includePipeline: false } : {}),
        ...paginationOpts(opts),
      };
      for (const p of (opts.pipeline as string[]) ?? []) { const [stage, value] = p.split(':'); if (!stage || !value) throw new CliError('VALIDATION_FAILED', `--pipeline 需要 stage:status：${p}`); query[`pipeline.${stage}`] = value; }
      const res = await api(cmd).get<Array<Record<string, any>>>('/calls', query);
      emit(cmd, res, rows => {
        table(['CALLID', 'TO', 'STATUS', 'DURATION', 'CREATED AT'],
          (rows ?? []).map(c => [oneLine(c.callId), oneLine(c.to?.phone), oneLine(c.status), c.durationSec ? `${c.durationSec}s` : '-', isoToHuman(c.createdAt)]));
        const pg = res.meta.pagination; if (pg) writeLine(`\n共 ${pg.total} 条 · page ${pg.page}/${pg.totalPages} · size ${pg.size}`);
      });
    });
  addCommonOptions(callsCmd.command('get').description('话单摘要（GET /calls/{id}）').argument('<callId>'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const callId = String(args[0]);
      const res = await api(cmd).get<Record<string, any>>(`/calls/${encodeURIComponent(callId)}`);
      emit(cmd, res, renderCallSummary);
    });
  addCommonOptions(callsCmd.command('detail').description('话单详情（GET /calls/{id}/detail）').argument('<callId>')
    .option('--include-raw', '返回上游原始对象')
    .option('--include-events', '内联最近 50 条事件'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const callId = String(args[0]); const opts = cmd.opts() as any;
      const res = await api(cmd).get<Record<string, any>>(`/calls/${encodeURIComponent(callId)}/detail`, { includeRaw: !!opts.includeRaw, includeEvents: !!opts.includeEvents });
      emit(cmd, res, d => {
        renderCallSummary(d);
        const pd = d.pipelineDetail ?? {};
        const tr = pd.transcript ?? {}; const an = pd.analysis ?? {};
        writeLine('');
        kv([
          ['时间线', `created ${isoToHuman(d.timeline?.createdAt)} → dialing ${isoToHuman(d.timeline?.dialingAt)} → connected ${isoToHuman(d.timeline?.connectedAt)} → ended ${isoToHuman(d.timeline?.endedAt)}`],
          ['录音', `${oneLine(pd.audio?.status)}  ${oneLine(pd.audio?.audioId)}  ${fmtBytes(Number(d.recording?.sizeBytes ?? 0))}  ${oneLine(d.recording?.durationMs)}ms`],
          ['转写', `${oneLine(tr.status)}  ${oneLine(tr.transcriptId)}  source=${oneLine(tr.source)} provider=${oneLine(tr.provider)}  ${oneLine(tr.chunkCount)} 块  needsReview=${oneLine(tr.needsReview)}`],
          ['分析', `${oneLine(an.status)}  ${oneLine(an.analysisId)}  摘要：${oneLine(d.analysis?.summary)}  intent=${oneLine(d.analysis?.intent)}`],
          ['事件', `${oneLine(d.eventsCount)} 条（--include-events 可内联）`],
        ]);
      });
    });
  addCommonOptions(callsCmd.command('transcript').description('转写全文+分段（GET /calls/{id}/transcript）').argument('<callId>')
    .option('--include-analysis', '附带分析摘要')
    .option('--format <fmt>', 'text|markdown|srt|json', 'text')
    .option('--role <role>', 'agent|customer|unknown（客户端过滤）')
    .option('--out <path>', '写入文件（- 表示 stdout）')
    .option('--force', '允许覆盖 --out 目标'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const callId = String(args[0]); const opts = cmd.opts() as any;
      const o = globals(cmd);
      const res = await api(cmd).get<Record<string, any>>(`/calls/${encodeURIComponent(callId)}/transcript`, { includeAnalysis: !!opts.includeAnalysis });
      if (o.json) { writeJson({ ok: true, data: res.data, meta: res.meta }); return; }
      const rendered = renderTranscript(res.data, String(opts.format ?? 'text'), str(opts.role));
      if (opts.out) {
        const out = String(opts.out);
        if (out === '-') { writeLine(rendered); return; }
        if (existsSync(out) && !opts.force) throw new CliError('VALIDATION_FAILED', `目标已存在：${out}（加 --force 覆盖）`);
        writeFileSync(out, `${rendered}\n`);
        writeLine(`✔ 已写入 ${out}`);
        return;
      }
      writeLine(rendered);
    });
  addCommonOptions(callsCmd.command('audio').description('下载原始录音（GET /calls/{id}/audio）').argument('<callId>')
    .option('--out <path>', '输出文件（默认 ./<callId>.wav；- 表示 stdout）')
    .option('--attachment', '以附件形式下载'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const callId = String(args[0]); const opts = cmd.opts() as any;
      const o = globals(cmd);
      const outRaw = str(opts.out) ?? `./${callId}.wav`;
      if (o.json && outRaw === '-') throw new CliError('INVALID_REQUEST', '--json 不能与 --out - 同用');
      const dl = await api(cmd).download(`/calls/${encodeURIComponent(callId)}/audio`, { download: !!opts.attachment });
      const etag = dl.headers.get('etag')?.replace(/"/g, '');
      if (outRaw === '-') { process.stdout.write(dl.buffer); return; }
      let outPath = outRaw;
      if (outRaw.endsWith('/')) outPath = `${outRaw}${callId}.wav`;
      writeFileSync(outPath, dl.buffer);
      const data = { callId, outputPath: outPath, sizeBytes: dl.buffer.length, sha256: etag ?? null, contentType: dl.headers.get('content-type') };
      emit(cmd, { status: dl.status, data, meta: { requestId: newLocalId(), ts: nowIso() }, headers: dl.headers } as ApiResponse<typeof data>,
        d => writeLine(`✔ 已保存 ${d.outputPath}（${fmtBytes(d.sizeBytes)}）`));
    });
  addCommonOptions(callsCmd.command('reprocess').description('重跑流水线阶段（POST /calls/{id}/reprocess）').argument('<callId>')
    .option('--stage <stages>', 'audio|transcript|analysis（逗号分隔，可重复）', collect, [])
    .option('--force', '忽略已 ready 强制重跑')
    .option('--asr-model <model>', 'ASR 模型（如 asr-1.0）')
    .option('--analysis-model <model>', '分析模型（如 deepseek-v4-pro）')
    .option('--prompt-version <v>', '分析 prompt 版本')
    .option('--term-rules-version <v>', '词表版本')
    .option('--idempotency-key <key>', '幂等键')
    .option('--dry-run', '只列出将重跑的阶段')
    .option('--wait', '等待作业结束')
    .option('--wait-timeout <dur>', '等待超时', '600s'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const callId = String(args[0]); const opts = cmd.opts() as any;
      const stages = splitCsv(opts.stage);
      if (!stages.length) throw new CliError('VALIDATION_FAILED', '缺少 --stage（audio|transcript|analysis）');
      for (const s of stages) if (!['audio', 'transcript', 'analysis'].includes(s)) throw new CliError('VALIDATION_FAILED', `非法阶段：${s}`);
      const options: Record<string, unknown> = { ...(str(opts.asrModel) ? { asrModel: str(opts.asrModel) } : {}), ...(str(opts.analysisModel) ? { analysisModel: str(opts.analysisModel) } : {}), ...(str(opts.promptVersion) ? { promptVersion: str(opts.promptVersion) } : {}), ...(str(opts.termRulesVersion) ? { termRulesVersion: str(opts.termRulesVersion) } : {}) };
      if (opts.dryRun) {
        const detail = await api(cmd).get<Record<string, any>>(`/calls/${encodeURIComponent(callId)}/detail`);
        const pd = detail.data.pipelineDetail ?? {};
        emitLocal(cmd, { dryRun: true, callId, stages, current: { audio: pd.audio?.status, transcript: pd.transcript?.status, analysis: pd.analysis?.status } },
          () => { writeLine(`重跑预检（未提交）：callId=${callId}`); kv([['阶段', stages.join(',')], ['当前', `audio=${oneLine(pd.audio?.status)} transcript=${oneLine(pd.transcript?.status)} analysis=${oneLine(pd.analysis?.status)}`], ['模型/版本', JSON.stringify(options)]]); });
        return;
      }
      await confirmOrThrow(`重跑 callId=${callId} 的阶段 ${stages.join(',')}（产生 ASR/LLM 成本）`, globals(cmd));
      const headers: Record<string, string> = {};
      if (str(opts.idempotencyKey)) headers['Idempotency-Key'] = String(opts.idempotencyKey);
      const res = await api(cmd).post<Record<string, any>>(`/calls/${encodeURIComponent(callId)}/reprocess`, { stages, ...(opts.force ? { force: true } : {}), ...(Object.keys(options).length ? { options } : {}) }, { headers });
      if (opts.wait && res.data.jobId) { const job = await pollJob(cmd, String(res.data.jobId), parseDuration(opts.waitTimeout, 600_000)); if (globals(cmd).json) writeJson({ ok: true, data: job, meta: res.meta }); else { writeLine(`✔ 重跑结束  status=${oneLine(job.status)}  jobId=${oneLine(job.jobId)}`); } return; }
      emit(cmd, res, d => { writeLine('✔ 已受理重跑'); kv([['callId', oneLine(d.callId)], ['阶段', (d.stages ?? []).join(',')], ['jobId', oneLine(d.jobId)], ['pollUrl', oneLine(d.pollUrl)]]); });
    });
  addCommonOptions(callsCmd.command('cancel').description('取消 pending 呼出（POST /calls/{id}/cancel）').argument('<callId>'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const callId = String(args[0]);
      await confirmOrThrow(`取消呼出 ${callId}`, globals(cmd));
      const res = await api(cmd).post<Record<string, any>>(`/calls/${encodeURIComponent(callId)}/cancel`);
      emit(cmd, res, d => writeLine(`✔ 已取消 ${oneLine(d.callId)}（status=${oneLine(d.status)}）`));
    });
  addCommonOptions(callsCmd.command('events').description('单通话单事件（GET /calls/{id}/events；--follow 走 SSE）').argument('<callId>')
    .option('--types <types>', '事件类型（逗号分隔）')
    .option('--page <n>').option('--size <n>')
    .option('--follow', 'SSE 持续跟随')
    .option('--duration <dur>', '跟随时长，如 60s'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const callId = String(args[0]); const opts = cmd.opts() as any; const o = globals(cmd);
      if (opts.follow) {
        const duration = opts.duration ? parseDuration(opts.duration, 0) : undefined;
        await followEvents(cmd, state, { callId, ...(splitCsv(opts.types).length ? { types: splitCsv(opts.types) } : {}) }, duration ? Math.ceil(duration / 1000) : undefined);
        if (state.interrupted) return;
        return;
      }
      const res = await api(cmd).get<Array<Record<string, any>>>(`/calls/${encodeURIComponent(callId)}/events`, { ...(splitCsv(opts.types).length ? { types: splitCsv(opts.types) } : {}), ...paginationOpts(opts) });
      if (o.json) { writeJson({ ok: true, data: res.data, meta: res.meta }); return; }
      for (const ev of res.data ?? []) writeLine(fmtEvent(ev));
      const pg = res.meta.pagination; if (pg) writeLine(`\n共 ${pg.total} 条 · page ${pg.page}/${pg.totalPages}`);
    });

  // ---- sync ----
  const syncCmd = program.command('sync').description('触发同步（POST /sync）')
    .option('--account <id>', '仅指定账号')
    .option('--mode <mode>', 'incremental|full|backfill', 'incremental')
    .option('--from <date>', 'backfill 起始日期')
    .option('--to <date>', 'backfill 结束日期')
    .option('--full', '等价 --mode full（全量回补 ASR/analysis）')
    .option('--wait', '等待作业结束')
    .option('--wait-timeout <dur>', '等待超时', '300s')
    .option('--idempotency-key <key>', '幂等键');
  addCommonOptions(syncCmd).action(async (...args: any[]) => {
    const cmd = args[args.length - 1] as Command; const opts = cmd.opts() as any;
    const mode = opts.full ? 'full' : String(opts.mode ?? 'incremental');
    if (!['incremental', 'full', 'backfill'].includes(mode)) throw new CliError('VALIDATION_FAILED', `非法 mode：${mode}`);
    if (mode === 'backfill' && (!str(opts.from) || !str(opts.to))) throw new CliError('VALIDATION_FAILED', 'backfill 需要 --from/--to');
    const body: Record<string, unknown> = {
      mode,
      ...(str(opts.account) ? { accountId: str(opts.account) } : {}),
      ...(mode === 'backfill' ? { from: str(opts.from), to: str(opts.to) } : {}),
      ...(opts.wait ? { wait: true, timeoutMs: parseDuration(opts.waitTimeout, 300_000) } : {}),
    };
    const headers: Record<string, string> = {};
    if (str(opts.idempotencyKey)) headers['Idempotency-Key'] = String(opts.idempotencyKey);
    const res = await api(cmd).post<Record<string, any>>('/sync', body, { headers });
    emit(cmd, res, d => {
      if (d.status === 'queued' && d.jobId) { writeLine('✔ 同步已受理'); kv([['jobId', oneLine(d.jobId)], ['mode', oneLine(d.mode)], ['accountId', oneLine(d.accountId)], ['pollUrl', oneLine(d.pollUrl)], ['提示', mode === 'full' ? '全量回补已排队（ASR/analysis，不设预算上限，记录 token/耗时）' : '可继续操作']]); }
      else { writeLine(`✔ 同步结束  status=${oneLine(d.status)}`); if (d.result) kv(Object.entries(d.result).map(([k, v]) => [k, oneLine(v)] as [string, string])); }
    });
  });
  addCommonOptions(syncCmd.command('status').description('最近同步作业（GET /sync）')
    .option('--account <id>').option('--status <s>').option('--page <n>').option('--size <n>'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const opts = cmd.opts() as any;
      const res = await api(cmd).get<Array<Record<string, any>>>('/sync', { ...(str(opts.account) ? { accountId: str(opts.account) } : {}), ...(str(opts.status) ? { status: str(opts.status) } : {}), ...paginationOpts(opts) });
      emit(cmd, res, rows => {
        table(['JOBID', 'MODE', 'STATUS', 'ACCOUNT', 'RESULT', 'FINISHED AT'],
          (rows ?? []).map(j => [oneLine(j.jobId), oneLine(j.mode), oneLine(j.status), oneLine(j.accountId), j.result ? Object.entries(j.result).map(([k, v]) => `${k} ${oneLine(v)}`).join('/') : '-', isoToHuman(j.finishedAt)]));
      });
    });

  // ---- jobs ----
  const jobsCmd = program.command('jobs').description('后台作业');
  addCommonOptions(jobsCmd.command('list').description('作业列表（GET /jobs）')
    .option('--type <types>', '类型（逗号分隔）')
    .option('--status <s>', '状态')
    .option('--account <id>').option('--call <callId>')
    .option('--page <n>').option('--size <n>').option('--sort <field>'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const opts = cmd.opts() as any;
      const res = await api(cmd).get<Array<Record<string, any>>>('/jobs', {
        ...(splitCsv(opts.type).length ? { type: splitCsv(opts.type) } : {}),
        ...(str(opts.status) ? { status: str(opts.status) } : {}),
        ...(str(opts.account) ? { accountId: str(opts.account) } : {}),
        ...(str(opts.call) ? { callId: str(opts.call) } : {}),
        ...(str(opts.sort) ? { sort: str(opts.sort) } : {}),
        ...paginationOpts(opts),
      });
      emit(cmd, res, rows => table(['JOBID', 'TYPE', 'STATUS', 'CALL/ACCOUNT', 'ATTEMPTS', 'UPDATED AT'],
        (rows ?? []).map(j => [oneLine(j.jobId), oneLine(j.type), oneLine(j.status), oneLine(j.callId ?? j.accountId), `${oneLine(j.attempts)}/${oneLine(j.maxAttempts)}`, isoToHuman(j.updatedAt)])));
    });
  addCommonOptions(jobsCmd.command('get').description('作业详情（GET /jobs/{id}）').argument('<jobId>')
    .option('--wait', '等待作业结束').option('--wait-timeout <dur>', '等待超时', '300s'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const jobId = String(args[0]); const opts = cmd.opts() as any;
      let data = (await api(cmd).get<Record<string, any>>(`/jobs/${encodeURIComponent(jobId)}`)).data;
      if (opts.wait) data = await pollJob(cmd, jobId, parseDuration(opts.waitTimeout, 300_000));
      if (globals(cmd).json) { writeJson(okEnvelope(data)); return; }
      kv([
        ['jobId', oneLine(data.jobId)], ['type', oneLine(data.type)], ['status', oneLine(data.status)],
        ['attempts', `${oneLine(data.attempts)}/${oneLine(data.maxAttempts)}`],
        ['callId', oneLine(data.callId)], ['accountId', oneLine(data.accountId)],
        ['进度', data.progress ? `current ${oneLine(data.progress.current)} / total ${oneLine(data.progress.total)} ${oneLine(data.progress.unit)} ${oneLine(data.progress.message)}` : '-'],
        ['最近错误', data.lastError ? `${oneLine(data.lastError.code)}: ${oneLine(data.lastError.message)}` : '-'],
        ['结果', data.result ? JSON.stringify(data.result) : '-'],
      ]);
    });

  // ---- events ----
  addCommonOptions(program.command('events').description('事件历史/实时流（GET /events，--follow 走 SSE）')
    .option('--types <types>', '事件类型（逗号分隔，支持 call.*）')
    .option('--call <callId>').option('--account <id>')
    .option('--since <iso>').option('--until <iso>')
    .option('--page <n>').option('--size <n>').option('--sort <field>')
    .option('--follow', 'SSE 持续跟随')
    .option('--last-event-id <id>', 'SSE 断点续传')
    .option('--duration <dur>', '跟随时长，如 60s'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const opts = cmd.opts() as any; const o = globals(cmd);
      if (opts.follow) {
        const duration = opts.duration ? parseDuration(opts.duration, 0) : undefined;
        await followEvents(cmd, state, {
          ...(splitCsv(opts.types).length ? { types: splitCsv(opts.types) } : {}),
          ...(str(opts.call) ? { callId: str(opts.call) } : {}),
          ...(str(opts.account) ? { accountId: str(opts.account) } : {}),
        }, duration ? Math.ceil(duration / 1000) : undefined);
        return;
      }
      const res = await api(cmd).get<Array<Record<string, any>>>('/events', {
        ...(splitCsv(opts.types).length ? { types: splitCsv(opts.types) } : {}),
        ...(str(opts.call) ? { callId: str(opts.call) } : {}),
        ...(str(opts.account) ? { accountId: str(opts.account) } : {}),
        ...(str(opts.since) ? { since: str(opts.since) } : {}),
        ...(str(opts.until) ? { until: str(opts.until) } : {}),
        ...(str(opts.sort) ? { sort: str(opts.sort) } : {}),
        ...paginationOpts(opts),
      });
      if (o.json) { writeJson({ ok: true, data: res.data, meta: res.meta }); return; }
      for (const ev of res.data ?? []) writeLine(fmtEvent(ev));
      const pg = res.meta.pagination; if (pg) writeLine(`\n共 ${pg.total} 条 · page ${pg.page}/${pg.totalPages}`);
    });

  // ---- term ----
  const termCmd = program.command('term').description('词表');
  addCommonOptions(termCmd.command('list').description('词表列表（GET /terms）')
    .option('--q <text>').option('--category <c>').option('--enabled').option('--page <n>').option('--size <n>'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const opts = cmd.opts() as any;
      const res = await api(cmd).get<Array<Record<string, any>>>('/terms', {
        ...(str(opts.q) ? { q: str(opts.q) } : {}), ...(str(opts.category) ? { category: str(opts.category) } : {}),
        ...(opts.enabled ? { enabled: true } : {}), ...paginationOpts(opts),
      });
      emit(cmd, res, rows => table(['TERMID', 'FROM', 'TO', 'CATEGORY', 'PRIORITY', 'ENABLED'],
        (rows ?? []).map(t => [oneLine(t.termId), (t.from ?? []).join('|'), oneLine(t.to), oneLine(t.category), oneLine(t.priority), oneLine(t.enabled)])));
    });
  addCommonOptions(termCmd.command('add').description('新增规则（POST /terms）')
    .option('--from <词>', '变体（可重复）', collect, [])
    .option('--to <归一>').option('--category <c>').option('--priority <n>')
    .option('--note <s>').option('--case-sensitive').option('--disabled'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const opts = cmd.opts() as any;
      const from = (opts.from as string[]) ?? []; const to = str(opts.to);
      if (!from.length || !to) throw new CliError('VALIDATION_FAILED', '缺少 --from / --to');
      const body = { from, to, ...(str(opts.category) ? { category: str(opts.category) } : {}), ...(num(opts.priority) !== undefined ? { priority: num(opts.priority) } : {}), ...(str(opts.note) ? { note: str(opts.note) } : {}), ...(opts.caseSensitive ? { caseSensitive: true } : {}), ...(opts.disabled ? { enabled: false } : {}) };
      const res = await api(cmd).post<Record<string, any>>('/terms', body);
      emit(cmd, res, t => writeLine(`✔ 已新增词表规则 ${oneLine(t.termId)}  [${(t.from ?? []).join(',')}] → ${oneLine(t.to)}`));
    });
  addCommonOptions(termCmd.command('update').description('修改规则（PATCH /terms/{id}）').argument('<termId>')
    .option('--from <词>', '变体（可重复）', collect, [])
    .option('--to <归一>').option('--category <c>').option('--priority <n>')
    .option('--note <s>').option('--enable').option('--disable').option('--case-sensitive'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const termId = String(args[0]); const opts = cmd.opts() as any;
      const patch: Record<string, unknown> = {};
      if ((opts.from as string[])?.length) patch.from = opts.from;
      if (str(opts.to)) patch.to = str(opts.to);
      if (str(opts.category)) patch.category = str(opts.category);
      if (num(opts.priority) !== undefined) patch.priority = num(opts.priority);
      if (str(opts.note)) patch.note = str(opts.note);
      if (opts.enable) patch.enabled = true;
      if (opts.disable) patch.enabled = false;
      if (opts.caseSensitive !== undefined) patch.caseSensitive = !!opts.caseSensitive;
      if (!Object.keys(patch).length) throw new CliError('VALIDATION_FAILED', '没有需要更新的字段');
      const res = await api(cmd).patch<Record<string, any>>(`/terms/${encodeURIComponent(termId)}`, patch);
      emit(cmd, res, t => writeLine(`✔ 已更新 ${oneLine(t.termId)}  [${(t.from ?? []).join(',')}] → ${oneLine(t.to)}`));
    });
  addCommonOptions(termCmd.command('remove').description('删除规则（DELETE /terms/{id}）').argument('<termId>'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const termId = String(args[0]);
      await confirmOrThrow(`删除词表规则 ${termId}`, globals(cmd));
      const res = await api(cmd).del<null>(`/terms/${encodeURIComponent(termId)}`);
      emit(cmd, res, () => writeLine(`✔ 已删除词表规则 ${termId}`));
    });
  addCommonOptions(termCmd.command('import').description('全量替换词表（PUT /terms）').argument('<file>')
    .option('--format <fmt>', 'json|csv（默认按扩展名）')
    .option('--dry-run', '只输出 diff，不 PUT'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const file = String(args[0]); const opts = cmd.opts() as any;
      const raw = file === '-' ? await readStdin() : readFileSync(file, 'utf8');
      const format = str(opts.format) ?? (file.toLowerCase().endsWith('.csv') ? 'csv' : 'json');
      const rules = parseTermRules(raw, format);
      if (opts.dryRun) {
        const before = await fetchAllTerms(cmd);
        const key = (r: Record<string, any>): string => `${(r.from ?? []).slice().sort().join('|')}=>${r.to}`;
        const beforeMap = new Map(before.map(r => [key(r), r] as [string, Record<string, any>]));
        const afterMap = new Map(rules.map(r => [key(r), r] as [string, Record<string, any>]));
        const added = [...afterMap.keys()].filter(k => !beforeMap.has(k)).length;
        const removed = [...beforeMap.keys()].filter(k => !afterMap.has(k)).length;
        const updated = [...afterMap.keys()].filter(k => beforeMap.has(k)).length;
        emitLocal(cmd, { applied: false, diff: { added, updated, removed, total: rules.length } },
          () => { writeLine('词表导入预检（未写入）'); kv([['+ 新增', String(added)], ['~ 保留/更新', String(updated)], ['- 删除', String(removed)], ['总条数', String(rules.length)]]); });
        return;
      }
      await confirmOrThrow(`全量替换词表（${rules.length} 条，未出现的旧规则会删除）`, globals(cmd));
      const res = await api(cmd).put<Record<string, any>>('/terms', { rules, mode: 'replace' });
      emit(cmd, res, d => writeLine(`✔ 词表已替换  count=${oneLine(d.count)}  version=${oneLine(d.version)}`));
    });

  // ---- text ----
  addCommonOptions(program.command('text').description('文本工具').command('normalize').description('文本归一化（POST /text/normalize）').argument('<text>')
    .option('--include-unchanged').option('--category-filter <cats>'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const raw = String(args[0]);
      const text = raw === '-' ? await readStdin() : raw;
      if (!text.trim()) throw new CliError('VALIDATION_FAILED', '文本不能为空');
      if (text.length > 20000) throw new CliError('VALIDATION_FAILED', '文本超过 20000 字符');
      const opts = cmd.opts() as any;
      const options = { ...(opts.includeUnchanged ? { includeUnchanged: true } : {}), ...(splitCsv(opts.categoryFilter).length ? { categoryFilter: splitCsv(opts.categoryFilter) } : {}) };
      const res = await api(cmd).post<Record<string, any>>('/text/normalize', { text, ...(Object.keys(options).length ? { options } : {}) });
      emit(cmd, res, d => {
        writeLine(oneLine(d.original)); writeLine(`→ ${oneLine(d.normalized)}`);
        if ((d.applied ?? []).length) writeLine(`（命中 ${d.applied.length} 条：${d.applied.map((a: any) => `${a.from}→${a.to}`).join('、')}）`);
      });
    });

  // ---- doctor / completion ----
  addCommonOptions(program.command('doctor').description('自检/排障（配置/DB/token/provider/出站）')
    .option('--probe-upstream', '额外探测上游')
    .option('--probe-providers', '检查 MiniMax/DeepSeek 配置/密钥引用/出站白名单/连通性')
    .option('--fix-token', '生成缺失的本地 API token'))
    .action(async (...args: any[]) => {
      const cmd = args[args.length - 1] as Command;
      await runDoctor(cmd, state);
    });
  addCommonOptions(program.command('completion').description('生成 shell 补全脚本').argument('<shell>'))
    .action((...args: any[]) => {
      const cmd = args[args.length - 1] as Command; const shell = String(args[0]);
      const script = completionScript(shell);
      if (!script) throw new CliError('VALIDATION_FAILED', `不支持的 shell：${shell}（bash/zsh/fish/powershell）`);
      process.stdout.write(script);
    });


  return program;
}

/**
 * 递归渲染完整帮助（供 `feige --help-all`、CLI 参考文档生成脚本复用）。
 * 输出：全局选项 + 所有命令/子命令/参数/命令级选项。全局选项对所有命令通用。
 */
export function renderAllHelp(program: Command): string {
  const lines: string[] = [];
  const pad = (n: number) => ' '.repeat(n);
  const commonFlags = new Set<string>(['--api <url>', '--token <token>', '--token-file <path>', '-j, --json', '-q, --quiet', '-v, --verbose', '--timeout <dur>', '-y, --yes']);
  const formatOpt = (o: any, indent: string): string => {
    const flags = String(o.flags ?? '');
    const desc = String(o.description ?? '');
    const def = o.defaultValue !== undefined && o.defaultValue !== null ? `（默认 ${JSON.stringify(o.defaultValue)}）` : '';
    return `${indent}${flags.padEnd(30)}${desc}${def}`;
  };
  lines.push(`${program.name()} v${VERSION} — ${program.description()}`);
  lines.push('');
  lines.push('Usage: feige [global options] <command> [subcommand] [options]');
  lines.push('');
  lines.push('全局选项（所有命令通用）:');
  for (const o of program.options as any[]) lines.push(formatOpt(o, '  '));
  lines.push('');
  lines.push('命令树:');
  const walk = (cmd: any, path: string, depth: number): void => {
    const name = cmd.name();
    if (name === 'help' || name === '--help') return;
    const args = (cmd.registeredArguments ?? []).map((a: any) => (a.required ? `<${a.name()}>` : `[${a.name()}]`)).join(' ');
    const usage = `${path}${args ? ' ' + args : ''}`;
    const desc = cmd.description() ? ` — ${cmd.description()}` : '';
    lines.push(`${pad(depth * 2)}${name}${desc}`);
    lines.push(`${pad(depth * 2 + 2)}usage: feige ${usage} [options]`);
    const own = (cmd.options as any[]).filter((o: any) => !commonFlags.has(String(o.flags)));
    for (const o of own) lines.push(formatOpt(o, pad(depth * 2 + 2)));
    for (const child of cmd.commands as any[]) walk(child, `${usage} ${child.name()}`, depth + 1);
  };
  for (const cmd of program.commands as any[]) walk(cmd, cmd.name(), 1);
  lines.push('');
  lines.push('说明：以上为完整命令树；每个命令也支持 `feige <command...> --help` 查看该级帮助。');
  return lines.join('\n');
}

/** ---------------- 词表导入解析 ---------------- */
function parseTermRules(raw: string, format: string): Array<Record<string, unknown>> {
  if (format === 'csv') {
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const out: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      if (/^from\s*,/i.test(line)) continue;
      const cells = line.split(',').map(c => c.trim());
      const from = cells[0] ? cells[0].split(/[|;]/).map(x => x.trim()).filter(Boolean) : [];
      const to = cells[1] ?? '';
      if (!from.length || !to) throw new CliError('VALIDATION_FAILED', `CSV 行非法：${line}`);
      out.push({ from, to, ...(cells[2] ? { category: cells[2] } : {}), ...(cells[3] ? { priority: Number(cells[3]) } : {}), ...(cells[4] ? { enabled: cells[4] !== 'false' } : {}) });
    }
    return out;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e) { throw new CliError('VALIDATION_FAILED', `JSON 解析失败：${(e as Error).message}`); }
  const arr = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>)?.rules;
  if (!Array.isArray(arr)) throw new CliError('VALIDATION_FAILED', '词表 JSON 需要 rules[] 或数组');
  return arr as Array<Record<string, unknown>>;
}

async function fetchAllTerms(cmd: Command): Promise<Array<Record<string, any>>> {
  const c = api(cmd); const all: Array<Record<string, any>> = [];
  let page = 1;
  for (;;) {
    const res = await c.get<Array<Record<string, any>>>('/terms', { page, size: 500 });
    all.push(...(res.data ?? []));
    const pg = res.meta.pagination;
    if (!pg || page >= pg.totalPages) break;
    page++;
  }
  return all;
}

/** ---------------- doctor ---------------- */
interface DoctorCheck { id: string; status: 'pass' | 'warn' | 'fail' | 'skip'; message: string; fix?: string; details?: Record<string, unknown> }

async function runDoctor(cmd: Command, state: CliState): Promise<void> {
  const started = Date.now();
  const o = globals(cmd); const opts = cmd.opts() as any;
  const checks: DoctorCheck[] = [];
  const push = (c: DoctorCheck): void => { checks.push(c); };

  // 1) config
  const cfgFile = configFile();
  const cfg = readJsonFile(cfgFile);
  if (cfg === undefined && existsSync(cfgFile)) push({ id: 'config', status: 'fail', message: `配置文件解析失败：${cfgFile}`, fix: `检查 JSON 格式或删除后由 serve 重新生成` });
  else if (!existsSync(cfgFile)) push({ id: 'config', status: 'warn', message: `配置文件不存在（使用默认值）：${cfgFile}`, fix: 'feige serve 首次启动会生成默认配置' });
  else push({ id: 'config', status: 'pass', message: `配置文件可读：${cfgFile}` });

  // 2) token
  const tokenPath = tokenFileFor(o);
  let tokenOk = false;
  try {
    if (existsSync(tokenPath)) {
      const token = readFileSync(tokenPath, 'utf8').trim();
      if (token) {
        tokenOk = true;
        const mode = statSync(tokenPath).mode & 0o777;
        if (mode !== 0o600) push({ id: 'token', status: 'warn', message: `${tokenPath} 权限 ${mode.toString(8)}，建议 0600`, fix: `chmod 600 ${tokenPath}` });
        else push({ id: 'token', status: 'pass', message: `本地 API token 存在且权限 0600` });
      }
    }
  } catch { /* ignore */ }
  if (!tokenOk) {
    if (opts.fixToken) {
      try { const r = fixToken(); tokenOk = true; push({ id: 'token', status: 'pass', message: `已生成本地 API token：${r.tokenFile}` }); }
      catch (e) { push({ id: 'token', status: 'fail', message: `生成 token 失败：${(e as Error).message}` }); }
    } else if (readToken(o)) {
      tokenOk = true; push({ id: 'token', status: 'pass', message: 'token 来自环境变量/--token' });
    } else {
      push({ id: 'token', status: 'fail', message: `本地 API token 不存在：${tokenPath}`, fix: 'feige doctor --fix-token' });
    }
  }

  // 3) API / health + status
  let status: Record<string, any> | undefined;
  try {
    const t0 = Date.now();
    await api(cmd).get('/health');
    push({ id: 'api', status: 'pass', message: `${new ApiClient(o).base} 可达（${Date.now() - t0}ms）` });
    const st = await api(cmd).get<Record<string, any>>('/status', { detail: false });
    status = st.data;
    push({ id: 'db', status: st.data?.db?.ok ? 'pass' : 'fail', message: st.data?.db?.ok ? `数据库 ok（${fmtBytes(Number(st.data.db.sizeBytes ?? 0))}）` : '数据库不可用', ...(st.data?.db?.ok ? {} : { fix: '查看服务日志/feige status' }) });
  } catch (e) {
    const err = toCliError(e);
    if (err.code === 'UNAUTHORIZED') {
      push({ id: 'api', status: 'fail', message: '本地 API 认证失败（token 错误）', fix: '删除 token 文件后执行 feige doctor --fix-token，或检查 --token' });
    } else {
      push({ id: 'api', status: 'fail', message: `本地服务不可达：${err.message}`, fix: 'feige serve' });
    }
  }

  // 4) accounts
  if (status) {
    try {
      const acc = await api(cmd).get<Array<Record<string, any>>>('/accounts');
      const rows = acc.data ?? [];
      const online = rows.filter(a => a.state === 'online').length;
      if (!rows.length) push({ id: 'accounts', status: 'warn', message: '尚未注册账号', fix: 'feige account add <accountId> --username ... --password-stdin' });
      else if (!online) push({ id: 'accounts', status: 'warn', message: `${rows.length} 个账号均非 online`, fix: 'feige account login <accountId>' });
      else push({ id: 'accounts', status: 'pass', message: `${rows.length} 个账号，online ${online}` });
    } catch (e) { push({ id: 'accounts', status: 'fail', message: `账号检查失败：${toCliError(e).message}` }); }
  } else {
    push({ id: 'accounts', status: 'skip', message: '本地服务不可达，跳过账号检查' });
  }

  // 5) dial window
  if (status?.dialWindow) {
    const dw = status.dialWindow as Record<string, any>;
    push({ id: 'dial-window', status: dw.open ? 'pass' : 'warn', message: `${dw.open ? '开放' : '关闭'}（${oneLine(dw.windowStart)}–${oneLine(dw.windowEnd)} ${oneLine(dw.timezone)}）`, ...(dw.open ? {} : { fix: '时段外写操作会排队/被拒（CALL_OUTSIDE_DIAL_WINDOW）' }) });
  } else push({ id: 'dial-window', status: 'skip', message: '无 /status 数据' });

  // 6) audio dir
  const storage = (cfg?.storage ?? {}) as Record<string, any>;
  const dataDir = str(storage.dataDir) ?? join(process.env.HOME ?? '.', '.local', 'share', 'feige-outbound');
  const audioDir = join(dataDir, str(storage.audioDir) ?? 'audio');
  try {
    if (existsSync(audioDir)) { accessSync(audioDir, fsConstants.W_OK); push({ id: 'audio-dir', status: 'pass', message: `录音目录可写：${audioDir}` }); }
    else push({ id: 'audio-dir', status: 'warn', message: `录音目录不存在：${audioDir}`, fix: 'feige serve 首次启动会创建，或检查 storage.dataDir 权限' });
  } catch { push({ id: 'audio-dir', status: 'fail', message: `录音目录不可写：${audioDir}`, fix: `chmod 700 ${audioDir}` }); }

  // 7) upstream
  if (opts.probeUpstream) {
    if (status?.upstream) push({ id: 'upstream', status: status.upstream.reachable ? 'pass' : 'warn', message: `上游${status.upstream.reachable ? '可达' : '不可达'}（${oneLine(status.upstream.latencyMs)}ms）` });
    else push({ id: 'upstream', status: 'skip', message: '无 /status 数据' });
  } else push({ id: 'upstream', status: 'skip', message: '未加 --probe-upstream' });

  // 8) providers
  if (opts.probeProviders) {
    const secrets = readJsonFile(secretsFile()) ?? {};
    const pipeline = (cfg?.pipeline ?? {}) as Record<string, any>;
    const asr = (pipeline.asr ?? {}) as Record<string, any>;
    const analysis = (pipeline.analysis ?? {}) as Record<string, any>;
    const egress = ['api.minimax.io', 'api.minimax.cn', 'api.deepseek.com'];
    const providerCheck = async (id: string, provider: string, model: string, baseUrl: string, keyPresent: boolean): Promise<void> => {
      let host = ''; try { host = new URL(baseUrl).hostname; } catch { host = ''; }
      const egressAllowed = egress.includes(host);
      let reachable = false;
      try { await fetch(baseUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000) }); reachable = true; } catch { reachable = false; }
      const ok = egressAllowed && keyPresent && reachable;
      push({
        id: `provider:${id}`, status: ok ? 'pass' : 'warn',
        message: `${provider} model=${model} 密钥${keyPresent ? '已配置' : '缺失'} 出站${egressAllowed ? '在白名单' : '不在白名单'} ${reachable ? '可达' : '不可达'}`,
        fix: ok ? undefined : '检查 secrets.json / FOP_*_API_KEY 与出站白名单（api.minimax.io|api.minimax.cn|api.deepseek.com）',
        details: { provider, baseUrl, model, keyConfigured: keyPresent, egressAllowed, reachable },
      });
    };
    await providerCheck('minimax', str(asr.provider) ?? 'minimax', str(asr.model) ?? 'asr-1.0', str(asr.baseUrl) ?? 'https://api.minimax.io', !!(str(secrets.minimaxApiKey) || process.env.FOP_MINIMAX_API_KEY));
    await providerCheck('deepseek', str(analysis.provider) ?? 'deepseek', str(analysis.model) ?? 'deepseek-chat', str(analysis.baseUrl) ?? 'https://api.deepseek.com', !!(str(secrets.deepseekApiKey) || process.env.FOP_DEEPSEEK_API_KEY));
    try {
      const failed = await api(cmd).get<Array<Record<string, any>>>('/jobs', { type: 'analysis', status: 'failed', size: 50 });
      const n = (failed.data ?? []).length;
      if (n >= 3) push({ id: 'analysis-failures', status: 'warn', message: `最近 50 条 analysis 作业有 ${n} 条失败`, fix: '查看 job.lastError 并 reprocess --stage analysis' });
    } catch { /* ignore */ }
  } else {
    push({ id: 'providers', status: 'skip', message: '未加 --probe-providers（配置/密钥/出站未检查）' });
  }

  const pass = checks.filter(c => c.status === 'pass').length;
  const warn = checks.filter(c => c.status === 'warn').length;
  const fail = checks.filter(c => c.status === 'fail').length;
  const exitCode = fail > 0 ? 7 : warn > 0 ? 4 : 0;
  state.exitCode = exitCode;
  if (o.json) {
    writeJson(okEnvelope({ version: VERSION, summary: { pass, warn, fail, exitCode }, checks }));
    return;
  }
  if (o.quiet) { writeLine(`结果：${pass} pass · ${warn} warn · ${fail} fail（退出码 ${exitCode}）`); return; }
  writeLine(`feige doctor  v${VERSION}`);
  writeLine('');
  for (const c of checks) {
    writeLine(`[${c.status.toUpperCase().padEnd(4)}] ${c.id.padEnd(22)} ${c.message}`);
    if (c.fix) writeLine(`       修复： ${c.fix}`);
  }
  writeLine('');
  writeLine(`结果：${pass} pass · ${warn} warn · ${fail} fail（退出码 ${exitCode}） 耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/** ---------------- completion ---------------- */
function completionScript(shell: string): string | undefined {
  const commands = ['serve', 'mcp', 'health', 'status', 'version', 'config', 'account', 'dial', 'calls', 'sync', 'jobs', 'events', 'term', 'text', 'doctor', 'completion'];
  const subs: Record<string, string[]> = {
    config: ['get', 'set'], account: ['list', 'show', 'add', 'update', 'remove', 'login', 'logout', 'health'],
    calls: ['list', 'get', 'detail', 'transcript', 'audio', 'reprocess', 'cancel', 'events'],
    sync: ['status'], jobs: ['list', 'get'], term: ['list', 'add', 'update', 'remove', 'import'], text: ['normalize'],
  };
  if (shell === 'bash' || shell === 'zsh') {
    const lines: string[] = [];
    lines.push('_feige_complete() {');
    lines.push('  local cur prev');
    lines.push('  cur="${COMP_WORDS[COMP_CWORD]}"');
    lines.push('  prev="${COMP_WORDS[COMP_CWORD-1]}"');
    lines.push(`  local commands="${commands.join(' ')}"`);
    lines.push('  case "$prev" in');
    for (const [k, v] of Object.entries(subs)) lines.push(`    ${k}) COMPREPLY=( $(compgen -W "${v.join(' ')}" -- "$cur") ); return 0 ;;`);
    lines.push('  esac');
    lines.push('  COMPREPLY=( $(compgen -W "$commands" -- "$cur") )');
    lines.push('}');
    lines.push(`complete -F _feige_complete feige`);
    return `${lines.join('\n')}\n`;
  }
  if (shell === 'fish') {
    const lines = commands.map(c => `complete -c feige -f -a "${c}"`);
    for (const [k, v] of Object.entries(subs)) for (const s of v) lines.push(`complete -c feige -n "__fish_seen_subcommand_from ${k}" -a "${s}"`);
    return `${lines.join('\n')}\n`;
  }
  if (shell === 'powershell') {
    return `Register-ArgumentCompleter -Native -CommandName feige -ScriptBlock { param($wordToComplete) @(${commands.map(c => `'${c}'`).join(',')}) | Where-Object { $_ -like "$wordToComplete*" } }\n`;
  }
  return undefined;
}

/** ---------------- 入口 ---------------- */
export async function runCli(argv: string[]): Promise<number> {
  const state: CliState = { exitCode: 0, interrupted: false, abort: new AbortController() };
  const onSigint = (): void => { state.interrupted = true; state.abort.abort(); };
  process.on('SIGINT', onSigint);
  const program = buildProgram(state);
  try {
    if (argv.includes('--help-all')) { writeLine(renderAllHelp(program)); return 0; }
    await program.parseAsync(argv.length ? argv : ['--help'], { from: 'user' });
    if (state.interrupted) return 130;
    return state.exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (['commander.helpDisplayed', 'commander.version', 'commander.help'].includes(err.code)) return 0;
      printError(new CliError('INVALID_REQUEST', err.message), optsFromArgv(argv));
      return 2;
    }
    printError(err, optsFromArgv(argv));
    return toCliError(err).exitCode;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

function optsFromArgv(argv: string[]): GlobalOpts {
  const pick = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined; };
  return {
    json: argv.includes('--json') || argv.includes('-j'),
    quiet: argv.includes('--quiet') || argv.includes('-q'),
    verbose: argv.includes('--verbose') || argv.includes('-v'),
    yes: argv.includes('--yes') || argv.includes('-y'),
    api: pick('--api'), token: pick('--token'), tokenFile: pick('--token-file'), timeout: pick('--timeout'),
  };
}

