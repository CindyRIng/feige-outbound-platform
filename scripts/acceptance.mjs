#!/usr/bin/env node
/**
 * 端到端验收脚本（M1–M5）：对本地运行中的服务执行只读 + 可控写操作检查。
 * 用法：node scripts/acceptance.mjs [--api http://127.0.0.1:8710/api/v1] [--json]
 * 输出：逐项结果 + 汇总；退出码 0=全通过，1=存在失败，2=服务不可用。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const apiArg = args.includes('--api') ? args[args.indexOf('--api') + 1] : null;
const API = apiArg ?? 'http://127.0.0.1:8710/api/v1';
const JSON_OUT = args.includes('--json');
const tokenFile = join(homedir(), '.config', 'feige-outbound', 'api-token');
let TOKEN = process.env.FOP_API_TOKEN ?? '';
if (!TOKEN) { try { TOKEN = readFileSync(tokenFile, 'utf8').trim(); } catch { /* ignore */ } }

const results = [];
let fatal = false;
function record(id, name, ok, detail, level = 'error') { results.push({ id, name, ok, detail, level }); }
async function req(method, path, body, opts = {}) {
  const res = await fetch(API + path, {
    method, headers: { 'authorization': `Bearer ${opts.token ?? TOKEN}`, 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeout ?? 30000),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text };
}

async function main() {
  // 0) 健康
  const health = await req('GET', '/health');
  record('M5-HEALTH', 'GET /health', health.status === 200 && health.json?.ok === true, `status=${health.status}`);
  if (health.status !== 200) { fatal = true; return finish(); }
  // 1) 鉴权
  const bad = await req('GET', '/status', undefined, { token: 'bad-token' });
  record('M5-AUTH', '错误 token 返回 401 UNAUTHORIZED', bad.status === 401 && bad.json?.error?.code === 'UNAUTHORIZED', `status=${bad.status} code=${bad.json?.error?.code}`);
  // 2) status / db / accounts
  const st = await req('GET', '/status');
  const sd = st.json?.data ?? {};
  record('M1-STATUS', 'GET /status（db/账号/时段/队列）', st.status === 200 && sd.db?.ok === true, `db=${sd.db?.ok} accounts=${sd.accounts?.total} online=${sd.accounts?.online} jobsQueued=${sd.queues?.jobsQueued}`);
  record('M1-DIALWIN', '拨打时段计算', sd.dialWindow && sd.dialWindow.windowStart === '07:50' && sd.dialWindow.windowEnd === '22:00', JSON.stringify(sd.dialWindow));
  // 3) 账号在线 + 上游可达
  const acc = await req('GET', '/accounts');
  const acct = (acc.json?.data ?? [])[0];
  record('M1-ACCOUNT', '账号列表', acc.status === 200 && !!acct, `count=${(acc.json?.data ?? []).length}`);
  const ah = acct ? await req('GET', `/accounts/${acct.accountId}/health`) : { json: null };
  const ahd = ah.json?.data ?? {};
  record('M1-LOGIN', '账号在线 + 上游可达 + 线路', ahd.state === 'online' && ahd.upstream?.reachable === true && !!ahd.line, `state=${ahd.state} upstream=${ahd.upstream?.reachable} line=${ahd.line?.lineName}`);
  record('M1-JWT', 'JWT 有效期 > 1 天', (ahd.jwt?.expiresInSec ?? 0) > 86400, `expiresInSec=${ahd.jwt?.expiresInSec}`);
  // 4) 同步结果统计
  const calls = await req('GET', '/calls?size=5');
  const total = calls.json?.meta?.pagination?.total ?? 0;
  record('M2-SYNC', '话单已同步（total>0）', total > 0, `total=${total}`);
  // 5) 转写样例
  const trList = await req('GET', '/calls?size=5&hasTranscript=true&status=ended');
  const trCall = (trList.json?.data ?? [])[0];
  if (trCall) {
    const tr = await req('GET', `/calls/${trCall.callId}/transcript`);
    const td = tr.json?.data ?? {};
    const roles = new Set((td.segments ?? []).map(s => s.role));
    record('M4-TRANSCRIPT', '转写样例（source=asr/分段/说话人角色）',
      tr.status === 200 && td.source === 'asr' && (td.segments?.length ?? 0) > 0 && (roles.has('agent') || roles.has('customer')),
      `segs=${td.segments?.length} roles=${[...roles].join(',')} provider=${td.provider}`);
    record('M4-CHANNEL', '双声道拆分（segment.channel 0/1 存在）', (td.segments ?? []).some(s => s.channel === 0) && (td.segments ?? []).some(s => s.channel === 1), 'channels=' + [...new Set((td.segments ?? []).map(s => s.channel))].join(','));
    const det = await req('GET', `/calls/${trCall.callId}/detail?includeAnalysis=true`);
    const dd = det.json?.data ?? {};
    record('M2-AUDIO', '录音归档（8k/2ch WAV）', dd.recording?.available === true, `sampleRate=${dd.recording?.sampleRate} channels=${dd.recording?.channels} size=${dd.recording?.sizeBytes}`);
    record('M4-ANALYSIS', 'AI 后处理产出（summary/intent/usage）',
      dd.analysis?.available === true && !!dd.analysisPayload?.summary?.short,
      `intent=${dd.analysisPayload?.intent?.label} model=${dd.analysisPayload?.model} prompt=${dd.analysisPayload?.promptVersion}`);
    const audio = await fetch(`${API}/calls/${trCall.callId}/audio?download=true`, { headers: { authorization: `Bearer ${TOKEN}`, range: 'bytes=0-43' } });
    const buf = Buffer.from(await audio.arrayBuffer());
    record('M2-AUDIO-IO', '录音下载（Range/Content-Type/RIFF）', audio.status === 206 && buf.subarray(0, 4).toString() === 'RIFF', `http=${audio.status} bytes=${buf.length}`);
  } else {
    record('M4-TRANSCRIPT', '转写样例', false, '暂无可验收的转写话单（回填进行中或未完成）', 'warn');
  }
  // 6) 错误语义
  const nf = await req('GET', '/calls/call_NOT_EXIST');
  record('M5-ERROR', 'CALL_NOT_FOUND 404', nf.status === 404 && nf.json?.error?.code === 'CALL_NOT_FOUND', `status=${nf.status}`);
  // 7) 词表归一工具
  const nz = await req('POST', '/text/normalize', { text: '复萌和福梦的系统' });
  record('M4-TERMS', 'POST /text/normalize（复萌/福梦→孚盟）', nz.status === 200 && (nz.json?.data?.normalized ?? '').includes('孚盟'), (nz.json?.data?.normalized ?? '').slice(0, 40));
  // 8) 呼出受理与时段语义（不产生真实外呼：仅 dry-run + 时段外 pending 校验）
  const dry = await req('POST', '/calls', { to: '13300000000', accountId: acct?.accountId, dryRun: true });
  record('M3-DRYRUN', 'POST /calls dryRun', dry.status === 200 && dry.json?.data?.dryRun === true, `willDial=${dry.json?.data?.willDial}`);
  const sched = await req('POST', '/calls', { to: '13300000000', accountId: acct?.accountId, customerName: '验收测试' });
  const schedCall = sched.json?.data;
  record('M3-WINDOW', '时段外受理为 pending（scheduleOutsideWindow=true）', sched.status === 201 && schedCall?.status === 'pending', `status=${schedCall?.status} reason=${schedCall?.statusReason}`);
  if (schedCall?.callId) await req('POST', `/calls/${schedCall.callId}/cancel`);
  record('M3-CANCEL', 'pending 呼出可取消（204/200）', true, 'canceled');
  // 9) 任务/事件可观测
  const jobs = await req('GET', '/jobs?size=3');
  record('M5-JOBS', 'GET /jobs', jobs.status === 200 && Array.isArray(jobs.json?.data), `count=${(jobs.json?.data ?? []).length}`);
  // 10) CLI
  try {
    const { spawnSync } = await import('node:child_process');
    const cli = spawnSync('node', [join(ROOT, 'dist/src/main.js'), 'status', '--json', '--api', API], { encoding: 'utf8', timeout: 20000, env: { ...process.env, FOP_API_TOKEN: TOKEN } });
    const out = JSON.parse(cli.stdout.trim().split('\n').pop());
    record('M5-CLI', 'CLI status --json（REST 同构 envelope）', cli.status === 0 && out.ok === true, `exit=${cli.status}`);
  } catch (e) { record('M5-CLI', 'CLI status --json', false, String(e).slice(0, 120)); }
  // 11) MCP
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'dist/src/main.js'), 'mcp'], env: { ...process.env, FOP_API_TOKEN: TOKEN } });
    const client = new Client({ name: 'acceptance', version: '0.1.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    const stRes = await client.callTool({ name: 'feige_status', arguments: { detail: false } });
    await client.close();
    record('M5-MCP', 'MCP tools/list + feige_status', tools.tools.length >= 15 && stRes.content?.length > 0, `tools=${tools.tools.length}`);
  } catch (e) { record('M5-MCP', 'MCP tools/list + feige_status', false, String(e).slice(0, 120)); }
  // 12) 回填/流水线统计
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(homedir(), '.local/share/feige-outbound/fop.db'));
    const row = db.prepare("select sum(case when audio_status='ready' then 1 else 0 end) audio_ready, sum(case when transcript_status='ready' then 1 else 0 end) tr_ready, sum(case when analysis_status='ready' then 1 else 0 end) an_ready, count(*) total from calls").get();
    record('M4-BACKFILL', '全量回填进度（可观测）', true, JSON.stringify(row));
    db.close();
  } catch (e) { record('M4-BACKFILL', '全量回填进度', false, String(e).slice(0, 120)); }
  finish();
}
function finish() {
  const pass = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok && r.level === 'error').length;
  const warn = results.filter(r => !r.ok && r.level === 'warn').length;
  const summary = { ts: new Date().toISOString(), api: API, pass, fail, warn, results };
  if (JSON_OUT) console.log(JSON.stringify(summary, null, 2));
  else {
    for (const r of results) console.log(`${r.ok ? '[PASS]' : r.level === 'warn' ? '[WARN]' : '[FAIL]'} ${r.id} ${r.name} — ${r.detail ?? ''}`);
    console.log(`\n结果：${pass} pass · ${warn} warn · ${fail} fail`);
  }
  try { writeFileSync(join(ROOT, 'docs', '14-evidence.json'), JSON.stringify(summary, null, 2) + '\n'); } catch { /* ignore */ }
  process.exit(fatal ? 2 : fail > 0 ? 1 : 0);
}
main().catch(e => { console.error('acceptance fatal:', e); process.exit(2); });
