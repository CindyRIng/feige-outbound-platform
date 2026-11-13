#!/usr/bin/env node
/**
 * M3 真实拨测验收脚本（在飞鸽时段 07:50–22:00 Asia/Shanghai 使用）。
 *
 * 安全默认：不带 --confirm 只做预检与计划打印，绝不呼出；真实呼出必须显式 --confirm。
 * 用法：
 *   node scripts/live-dial.mjs                      # 预检（不呼出）
 *   node scripts/live-dial.mjs --confirm            # 真实呼出 + 全程状态/流水线观测
 *   node scripts/live-dial.mjs --confirm --to <被叫号码> --account main
 * 产出：docs/14-live-dial-evidence.json（callId、时间线、录音/转写/分析证据）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const has = (name) => args.includes(name);
const API = opt('--api', process.env.FOP_API_URL ?? 'http://127.0.0.1:8710/api/v1');
const TO = opt('--to', '');
const ACCOUNT = opt('--account', 'main');
const CONFIRM = has('--confirm');
const RETRIES = Number(opt('--retries', '2'));
const DIAL_POLL_SEC = Number(opt('--dial-timeout', '240'));
const PIPE_TIMEOUT_SEC = Number(opt('--pipeline-timeout', '1200'));
const OUT = join(ROOT, 'docs', '14-live-dial-evidence.json');
let TOKEN = process.env.FOP_API_TOKEN ?? '';
if (!TOKEN) { try { TOKEN = readFileSync(join(homedir(), '.config', 'feige-outbound', 'api-token'), 'utf8').trim(); } catch { /* ignore */ } }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
async function req(method, path, body, timeout = 30000) {
  const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json };
}
function log(msg) { console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`); }

async function preflight() {
  const health = await req('GET', '/health');
  if (health.status !== 200) { console.error('服务不可达:', health.status); process.exit(2); }
  const st = await req('GET', '/status');
  const dw = st.json?.data?.dialWindow ?? {};
  const ah = await req('GET', `/accounts/${ACCOUNT}/health`);
  const a = ah.json?.data ?? {};
  log(`预检：dialWindow.open=${dw.open} nextOpenAt=${dw.nextOpenAt} account=${a.state} upstream=${a.upstream?.reachable} line=${a.line?.lineName}`);
  return { dw, account: a, dialOpen: !!dw.open };
}
async function waitPipeline(callId, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const d = await req('GET', `/calls/${callId}/detail?includeAnalysis=true`);
    const p = d.json?.data?.pipeline ?? {};
    const key = `${p.audio}/${p.transcript}/${p.analysis}`;
    if (key !== last) { log(`流水线状态：${key}`); last = key; }
    const audioDone = ['ready', 'missing', 'failed'].includes(p.audio);
    const trDone = ['ready', 'missing', 'failed'].includes(p.transcript);
    const anDone = ['ready', 'skipped', 'failed'].includes(p.analysis) || p.transcript === 'missing';
    if (audioDone && trDone && anDone) return d.json?.data;
    await sleep(3000);
  }
  return (await req('GET', `/calls/${callId}/detail?includeAnalysis=true`)).json?.data;
}
async function pollDial(callId) {
  const timeline = [];
  const deadline = Date.now() + DIAL_POLL_SEC * 1000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const r = await req('GET', `/calls/${callId}`);
    const c = r.json?.data; if (!c) { await sleep(2000); continue; }
    if (c.status !== lastStatus) {
      lastStatus = c.status;
      timeline.push({ at: now(), status: c.status, reason: c.statusReason ?? null, upstream: c.upstreamStatus ?? null });
      log(`状态：${c.status}${c.statusReason ? '（' + c.statusReason + '）' : ''}${c.durationSec ? `，时长 ${c.durationSec}s` : ''}`);
    }
    if (['ended', 'no_answer', 'failed', 'canceled'].includes(c.status)) return { call: c, timeline };
    await sleep(2000);
  }
  return { call: (await req('GET', `/calls/${callId}`)).json?.data, timeline };
}

async function main() {
  if (!/^1[3-9]\d{9}$/.test(TO)) { console.error('必须通过 --to 指定 11 位被叫手机号（示例：--to 133****2072）'); process.exit(2); }
  const { dw, account, dialOpen } = await preflight();
  log(`计划：真实呼出至 ${TO.slice(0, 3)}****${TO.slice(7)}（坐席 156****0075 需接听）账号=${ACCOUNT}`);
  if (!dialOpen) {
    log(`当前不在飞鸽拨打时段（07:50–22:00 Asia/Shanghai），下次开窗：${dw.nextOpenAt}`);
    if (!has('--allow-outside-window')) { log('未带 --confirm 时仅预检；本次未呼出。'); process.exit(0); }
  }
  if (!CONFIRM) { log('预检通过。真实呼出需显式加 --confirm（会产生真实电话，坐席手机需接听）。'); process.exit(0); }
  const evidence = { ts: now(), to: TO.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'), account: ACCOUNT, dialWindow: dw, attempts: [] };
  let final = null;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    log(`=== 第 ${attempt}/${RETRIES} 次呼出 ===`);
    const created = await req('POST', '/calls', { to: TO, accountId: ACCOUNT, customerName: '拨测' }, 30000);
    const callId = created.json?.data?.callId;
    if (created.status !== 201 || !callId) { console.error('呼出受理失败:', created.status, JSON.stringify(created.json)); process.exit(4); }
    log(`已受理 callId=${callId}，等待状态流转…`);
    const { call, timeline } = await pollDial(callId);
    log(`终态：${call?.status}（${call?.statusReason ?? ''}）`);
    const detail = await waitPipeline(callId, PIPE_TIMEOUT_SEC);
    const tr = detail?.transcript?.available ? await req('GET', `/calls/${callId}/transcript`) : null;
    const evidenceAttempt = {
      attempt, callId, createdAt: created.json?.data?.createdAt, timeline, finalStatus: call?.status, finalReason: call?.statusReason ?? null,
      durationSec: call?.durationSec ?? null, upstream: call?.upstreamStatus ?? null,
      recording: detail?.recording ?? null, pipeline: detail?.pipeline ?? null,
      transcript: tr?.json?.data ? { source: tr.json.data.source, provider: tr.json.data.provider, segments: tr.json.data.segments?.length ?? 0, fullTextPreview: (tr.json.data.fullText ?? '').slice(0, 300), roles: [...new Set((tr.json.data.segments ?? []).map(s => s.role))] } : null,
      analysis: detail?.analysisPayload ? { summary: detail.analysisPayload.summary?.short ?? null, intent: detail.analysisPayload.intent?.label ?? null, model: detail.analysisPayload.model ?? null, promptVersion: detail.analysisPayload.promptVersion ?? null } : null,
    };
    evidence.attempts.push(evidenceAttempt);
    if (call?.status === 'ended' && detail?.pipeline?.transcript !== 'missing') { final = evidenceAttempt; break; }
    if (attempt < RETRIES) { log(`未接通/未完成，60s 后重试（最多 ${RETRIES} 次）`); await sleep(60000); }
  }
  evidence.final = final;
  evidence.pass = !!final && final.pipeline?.audio === 'ready' && final.pipeline?.transcript === 'ready' && ['ready', 'skipped'].includes(final.pipeline?.analysis);
  writeFileSync(OUT, JSON.stringify(evidence, null, 2) + '\n');
  log(`证据已写入 ${OUT}`);
  log(evidence.pass ? '✅ M3 真实拨测闭环通过（通话→录音→转写→分析）' : `⚠️ 未闭环：finalStatus=${evidence.attempts.map(a => a.finalStatus).join(',')}`);
  process.exit(evidence.pass ? 0 : 5);
}
main().catch(e => { console.error('live-dial fatal:', e); process.exit(2); });
