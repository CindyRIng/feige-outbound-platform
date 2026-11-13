#!/usr/bin/env node
/**
 * 飞鸽上游只读探针（Step 1 侦察用）
 *
 * 用途：在已用浏览器登录拿到 JWT 后，纯 HTTP 验证上游数据接口可用性。
 * 注意：只做只读调用；不写 token 到磁盘；日志中手机号脱敏。
 *
 * 使用：
 *   FEIGE_TOKEN='<cloud-token JWT>' node exploration/2026-11-13/http-probe.mjs list
 *   FEIGE_TOKEN='...' node exploration/2026-11-13/http-probe.mjs detail <callId>
 *   FEIGE_TOKEN='...' node exploration/2026-11-13/http-probe.mjs lines
 *   FEIGE_TOKEN='...' node exploration/2026-11-13/http-probe.mjs me
 */

const BASE = 'https://feige.duofangtongxin.com/duofang-feige-admin';
const token = process.env.FEIGE_TOKEN;
if (!token) {
  console.error('缺少 FEIGE_TOKEN 环境变量（浏览器登录后从 cookie CLOUD_TOKEN 取值）');
  process.exit(1);
}

const mask = (s) =>
  typeof s === 'string' ? s.replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '1**********') : s;
const maskDeep = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'string' ? mask(x) : x)));

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'cloud-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!text) return { http: res.status, empty: true, note: '空响应：token 失效或接口异常' };
  try {
    return JSON.parse(text);
  } catch {
    return { http: res.status, raw: text.slice(0, 500) };
  }
}

const LIST_BODY = {
  page: 1,
  limit: 5,
  tenantCode: null,
  realName: null,
  userMobile: null,
  customerMobile: null,
  lineName: null,
  lineId: null,
  callStatus: null,
  beginTime: null,
  finishTime: null,
  startTimeBegin: null,
  startTimeFinish: null,
  endTimeBegin: null,
  endTimeFinish: null,
  callType: '',
  userIds: [],
  callerAttr: '',
  calleeAttr: '',
};

const cmd = process.argv[2] ?? 'list';
let out;
switch (cmd) {
  case 'list': {
    const r = await call('POST', '/base/call/detail/getPage', LIST_BODY);
    const rows = (r.data?.list ?? []).map((x) => ({
      id: x.id,
      callStatus: x.callStatus,
      duration: x.duration,
      startTime: x.startTime,
      hasRecord: Boolean(x.preRecordUrl),
      recordUrl: mask(x.preRecordUrl),
    }));
    out = { code: r.code, total: r.data?.total, rows: maskDeep(rows) };
    break;
  }
  case 'detail': {
    const id = process.argv[3];
    if (!id) throw new Error('用法: detail <callId>');
    const r = await call('POST', '/base/call/detail/call-detail-content', { id });
    let payload = null;
    try {
      payload = JSON.parse(r.data?.content)?.payload ?? null;
    } catch {}
    out = {
      code: r.code,
      hasContent: Boolean(r.data?.content),
      checkStatus: payload?.checkStatus,
      statusText: payload?.status_text,
      recDuration: payload?.rec_duration,
      sentenceCount: payload?.sentences?.length,
      channelCount: payload ? new Set(payload.sentences.map((s) => s.channel_id)).size : null,
    };
    break;
  }
  case 'lines':
    out = await call('GET', '/base/api/agent/callLineList');
    break;
  case 'me':
    out = maskDeep(await call('GET', '/base/sys/user/userDetail'));
    break;
  case 'record': {
    const url = process.argv[3];
    if (!url) throw new Error('用法: record <preRecordUrl>');
    const res = await fetch(url, { headers: { range: 'bytes=0-0' } });
    out = { http: res.status, type: res.headers.get('content-type'), note: '仅探测可下载性' };
    break;
  }
  default:
    throw new Error(`未知命令: ${cmd}`);
}

console.log(JSON.stringify(out, null, 2));
