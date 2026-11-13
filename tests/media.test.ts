// 媒体预处理与 AI 客户端测试（node:test；不调用真实付费接口，全部走本地 mock HTTP server）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeWav, planChunks, sliceWav, detectSilences } from '../src/media/chunker.js';
import { createAsrClient } from '../src/media/asr.js';
import {
  createAnalysisClient,
  buildAnalysisUserMessage,
  ANALYSIS_SYSTEM_PROMPT,
  ANALYSIS_OUTPUT_SCHEMA,
} from '../src/media/analysis.js';
import type { AnalysisInput } from '../src/media/types.js';
import { AppError } from '../src/errors.js';

// ───────────────────────── 测试工具 ─────────────────────────

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface MockServer {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function startMockServer(
  handler: (ctx: { req: http.IncomingMessage; res: http.ServerResponse; body: Buffer; index: number }) => void | Promise<void>,
): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req).catch(() => Buffer.alloc(0));
    const captured: CapturedRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
    requests.push(captured);
    try {
      await handler({ req, res, body, index: requests.length - 1 });
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(payload));
}

/** 生成最小合法 PCM WAV：pattern(tMs) → 振幅 [-1,1]。 */
function buildWav(opts: {
  sampleRate?: number;
  channels?: number;
  seconds: number;
  pattern?: (ms: number) => number;
}): { buffer: Buffer; sampleRate: number; channels: number; dataLength: number } {
  const sampleRate = opts.sampleRate ?? 16000;
  const channels = opts.channels ?? 1;
  const frames = Math.round(sampleRate * opts.seconds);
  const dataLength = frames * channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  const data = Buffer.alloc(dataLength);
  for (let f = 0; f < frames; f++) {
    const ms = (f / sampleRate) * 1000;
    const amp = Math.max(-1, Math.min(1, opts.pattern ? opts.pattern(ms) : 0));
    const v = Math.round(amp * 32767);
    for (let c = 0; c < channels; c++) data.writeInt16LE(v, (f * channels + c) * 2);
  }
  return { buffer: Buffer.concat([header, data]), sampleRate, channels, dataLength };
}

const tone = (ms: number): number => Math.sin((2 * Math.PI * 440 * ms) / 1000) * 0.5;

let tmpRoot: string;
before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'fop-media-'));
});
after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function writeTmp(name: string, buffer: Buffer): Promise<string> {
  const file = join(tmpRoot, name);
  await writeFile(file, buffer);
  return file;
}

// ───────────────────────── chunker ─────────────────────────

test('probeWav: 16k mono 1s WAV 解析正确', async () => {
  const wav = buildWav({ seconds: 1, pattern: () => 0 });
  const file = await writeTmp('mono16k.wav', wav.buffer);
  const info = await probeWav(file);
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.durationMs, 1000);
  assert.equal(info.dataOffset, 44);
  assert.equal(info.dataLength, wav.dataLength);
});

test('probeWav: 8k stereo WAV 识别正确', async () => {
  const wav = buildWav({ sampleRate: 8000, channels: 2, seconds: 0.5 });
  const file = await writeTmp('stereo8k.wav', wav.buffer);
  const info = await probeWav(file);
  assert.equal(info.sampleRate, 8000);
  assert.equal(info.channels, 2);
  assert.equal(info.durationMs, 500);
});

test('probeWav: 非 WAV 文件抛 VALIDATION_FAILED', async () => {
  const file = await writeTmp('bad.wav', Buffer.from('this is not a wav file at all', 'utf8'));
  await assert.rejects(probeWav(file), (e: unknown) => (e as AppError).code === 'VALIDATION_FAILED');
});

test('probeWav: 文件不存在抛 AUDIO_NOT_AVAILABLE', async () => {
  await assert.rejects(probeWav(join(tmpRoot, 'missing.wav')), (e: unknown) => (e as AppError).code === 'AUDIO_NOT_AVAILABLE');
});

test('planChunks: ≤480s 整段一块', () => {
  const plans = planChunks(300_000, 420);
  assert.deepEqual(plans, [{ index: 0, beginMs: 0, endMs: 300_000, forcedCut: false }]);
  assert.deepEqual(planChunks(480_000, 420), [{ index: 0, beginMs: 0, endMs: 480_000, forcedCut: false }]);
});

test('planChunks: 无静音点信息时 >480s 按 480s 硬切并标 forcedCut', () => {
  const plans = planChunks(1000_000, 420, []);
  assert.equal(plans.length, 3);
  assert.equal(plans[0].beginMs, 0);
  assert.equal(plans[0].endMs, 480_000);
  assert.equal(plans[0].forcedCut, true);
  assert.equal(plans[1].beginMs, 480_000);
  assert.equal(plans[1].endMs, 960_000);
  // 末尾剩余 ≤480s 作为最后一块，不算强制切
  assert.equal(plans[2].beginMs, 960_000);
  assert.equal(plans[2].endMs, 1_000_000);
  assert.equal(plans[2].forcedCut, false);
  // 覆盖完整、无空洞/重叠
  for (let i = 1; i < plans.length; i++) assert.equal(plans[i].beginMs, plans[i - 1].endMs);
});

test('planChunks: 420s 窗口尾部静音点切分（非强制）', () => {
  const silences = [{ beginMs: 421_000, endMs: 424_000 }];
  const plans = planChunks(600_000, 420, silences);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].forcedCut, false);
  assert.equal(plans[0].endMs, 424_000); // 落在静音区间内（最晚可行点）
  assert.ok(plans[0].endMs >= 421_000 && plans[0].endMs <= 424_000);
  assert.equal(plans[1].beginMs, 424_000);
  assert.equal(plans[1].endMs, 600_000);
});

test('planChunks: 静音点早于窗口（不应切 <420s）时延长到 480s 强制切', () => {
  const silences = [{ beginMs: 400_000, endMs: 410_000 }];
  const plans = planChunks(700_000, 420, silences);
  assert.equal(plans[0].forcedCut, true);
  assert.equal(plans[0].endMs, 480_000);
});

test('detectSilences: 识别前后静音区间', async () => {
  const wav = buildWav({
    seconds: 3,
    pattern: (ms) => (ms < 1000 || ms >= 2000 ? 0 : tone(ms)),
  });
  const file = await writeTmp('silence3s.wav', wav.buffer);
  const info = await probeWav(file);
  const silences = await detectSilences(info, 300);
  assert.ok(silences.length >= 2, `期望至少 2 段静音，实际 ${JSON.stringify(silences)}`);
  for (const s of silences) assert.ok(s.endMs - s.beginMs >= 300);
  const near = (actual: number, expected: number, tol = 60): boolean => Math.abs(actual - expected) <= tol;
  assert.ok(silences.some((s) => near(s.beginMs, 0) && near(s.endMs, 1000)), JSON.stringify(silences));
  assert.ok(silences.some((s) => near(s.beginMs, 2000) && near(s.endMs, 3000)), JSON.stringify(silences));
});

test('detectSilences: 自定义阈值/帧长选项', async () => {
  const wav = buildWav({ seconds: 1, pattern: (ms) => (ms < 500 ? 0 : tone(ms)) });
  const file = await writeTmp('silence-opts.wav', wav.buffer);
  const info = await probeWav(file);
  const silences = await detectSilences(info, { minSilenceMs: 300, frameMs: 10, thresholdDb: -35 });
  assert.ok(silences.some((s) => s.beginMs <= 20 && s.endMs >= 450), JSON.stringify(silences));
});

test('detectSilences: 全静音音频整段为静音', async () => {
  const wav = buildWav({ seconds: 1 });
  const file = await writeTmp('all-silence.wav', wav.buffer);
  const info = await probeWav(file);
  const silences = await detectSilences(info, 300);
  assert.equal(silences.length, 1);
  assert.equal(silences[0].beginMs, 0);
  assert.ok(Math.abs(silences[0].endMs - 1000) <= 60);
});

test('sliceWav: 切出合法 WAV 且 PCM 数据与源一致', async () => {
  const wav = buildWav({ seconds: 1, pattern: (ms) => tone(ms) });
  const file = await writeTmp('slice-src.wav', wav.buffer);
  const info = await probeWav(file);
  const out = join(tmpRoot, 'slice-out.wav');
  await sliceWav(info, { index: 0, beginMs: 250, endMs: 750, forcedCut: false }, out);
  const outInfo = await probeWav(out);
  assert.equal(outInfo.sampleRate, 16000);
  assert.equal(outInfo.channels, 1);
  assert.ok(Math.abs(outInfo.durationMs - 500) <= 2);
  const src = await readFile(file);
  const dst = await readFile(out);
  const expectStart = info.dataOffset + Math.floor(0.25 * 16000) * 2;
  assert.deepEqual(dst.subarray(44, 44 + 200), src.subarray(expectStart, expectStart + 200));
});

// ───────────────────────── MiniMax ASR ─────────────────────────

const ASR_VALID_RESPONSE = {
  text: '喂，你好，我是福盟的销售。',
  duration: 10.356188,
  n_speakers: 2,
  segments: [
    { id: 0, start: 0.24, end: 3.84, speaker: 'S1', text: '喂，你好，我是福盟的销售。' },
    { id: 1, start: 4.28, end: 10.08, speaker: 'S2', text: '嗯，我是有什么事吗？' },
  ],
  trace_id: 'trace-abc',
  base_resp: { status_code: 0, status_msg: 'success' },
};

async function withAsrServer(
  handler: (ctx: { res: http.ServerResponse; body: Buffer; index: number }) => void | Promise<void>,
  fn: (server: MockServer, audioPath: string, client: ReturnType<typeof createAsrClient>) => Promise<void>,
): Promise<void> {
  const server = await startMockServer(({ res, body, index }) => handler({ res, body, index }));
  try {
    const wav = buildWav({ seconds: 0.5, pattern: () => 0 });
    const audioPath = await writeTmp(`asr-${Date.now()}-${Math.random()}.wav`, wav.buffer);
    const client = createAsrClient({ baseUrl: server.url, apiKey: 'test-minimax-key', model: 'asr-1.0', language: 'zh', maxRetries: 0, retryBaseMs: 5, timeoutMs: 5000 });
    await fn(server, audioPath, client);
  } finally {
    await server.close();
  }
}

test('asr: multipart 请求形状与秒→毫秒/speaker 映射', async () => {
  await withAsrServer(
    ({ res }) => sendJson(res, 200, ASR_VALID_RESPONSE),
    async (server, audioPath, client) => {
      const result = await client.transcribeChunk({ audioPath });
      assert.equal(server.requests.length, 1);
      const req = server.requests[0];
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/speech_to_text');
      assert.equal(req.headers.authorization, 'Bearer test-minimax-key');
      assert.equal(req.headers.language, 'zh');
      assert.match(String(req.headers['content-type']), /multipart\/form-data/);
      const bodyText = req.body.toString('utf8');
      assert.match(bodyText, /name="model"\r\n\r\nasr-1\.0/);
      assert.match(bodyText, /name="response_format"\r\n\r\nverbose_json/);
      assert.match(bodyText, /name="timestamp_level"\r\n\r\nsentence/);
      assert.match(bodyText, /name="file"; filename="/);

      assert.equal(result.durationMs, 10356);
      assert.equal(result.nSpeakers, 2);
      assert.equal(result.traceId, 'trace-abc');
      assert.equal(result.segments.length, 2);
      assert.equal(result.segments[0].beginMs, 240);
      assert.equal(result.segments[0].endMs, 3840);
      assert.equal(result.segments[0].speakerLabel, 'S1');
      assert.equal(result.segments[1].speakerLabel, 'S2');
    },
  );
});

test('asr: 401 不重试 → ASR_FAILED(retryable=false)', async () => {
  await withAsrServer(
    ({ res }) => sendJson(res, 401, { base_resp: { status_code: 1004, status_msg: 'invalid api key' } }),
    async (server, audioPath, client) => {
      await assert.rejects(client.transcribeChunk({ audioPath }), (e: unknown) => {
        const err = e as AppError;
        assert.equal(err.code, 'ASR_FAILED');
        assert.equal(err.retryable, false);
        assert.equal((err.details as Record<string, unknown>).httpStatus, 401);
        return true;
      });
      assert.equal(server.requests.length, 1);
    },
  );
});

test('asr: 5xx 按 maxRetries 重试后抛 ASR_FAILED', async () => {
  const server = await startMockServer(({ res }) => sendJson(res, 500, { error: 'boom' }));
  const wav = buildWav({ seconds: 0.2 });
  const audioPath = await writeTmp('asr-retry.wav', wav.buffer);
  const client = createAsrClient({ baseUrl: server.url, apiKey: 'k', model: 'asr-1.0', language: 'zh', maxRetries: 2, retryBaseMs: 5 });
  try {
    await assert.rejects(client.transcribeChunk({ audioPath }), (e: unknown) => (e as AppError).code === 'ASR_FAILED');
    assert.equal(server.requests.length, 3); // 1 + 2 retries
  } finally {
    await server.close();
  }
});

test('asr: 429 后成功（尊重重试）', async () => {
  let n = 0;
  await withAsrServer(
    ({ res }) => {
      n++;
      if (n === 1) sendJson(res, 429, { base_resp: { status_code: 1002, status_msg: 'rate limit' } }, { 'retry-after': '0' });
      else sendJson(res, 200, ASR_VALID_RESPONSE);
    },
    async (server, audioPath) => {
      const client = createAsrClient({ baseUrl: server.url, apiKey: 'k', model: 'asr-1.0', language: 'zh', maxRetries: 2, retryBaseMs: 5 });
      const result = await client.transcribeChunk({ audioPath });
      assert.equal(result.segments.length, 2);
      assert.equal(server.requests.length, 2);
    },
  );
});

test('asr: HTTP200 + base_resp.status_code≠0 → ASR_FAILED(providerCode)', async () => {
  await withAsrServer(
    ({ res }) => sendJson(res, 200, { text: '', segments: [], base_resp: { status_code: 1001, status_msg: 'invalid request' } }),
    async (_server, audioPath, client) => {
      await assert.rejects(client.transcribeChunk({ audioPath }), (e: unknown) => {
        const err = e as AppError;
        assert.equal(err.code, 'ASR_FAILED');
        assert.equal((err.details as Record<string, unknown>).providerCode, 1001);
        return true;
      });
    },
  );
});

test('asr: 非法 JSON → ASR_FAILED', async () => {
  await withAsrServer(
    ({ res }) => {
      res.statusCode = 200;
      res.end('not-json');
    },
    async (_server, audioPath, client) => {
      await assert.rejects(client.transcribeChunk({ audioPath }), (e: unknown) => (e as AppError).code === 'ASR_FAILED');
    },
  );
});

test('asr: 超时 → ASR_FAILED(retryable=true)', async () => {
  const server = await startMockServer(async ({ res }) => {
    await new Promise((r) => setTimeout(r, 300));
    sendJson(res, 200, ASR_VALID_RESPONSE);
  });
  const wav = buildWav({ seconds: 0.2 });
  const audioPath = await writeTmp('asr-timeout.wav', wav.buffer);
  const client = createAsrClient({ baseUrl: server.url, apiKey: 'k', model: 'asr-1.0', language: 'zh', maxRetries: 0, timeoutMs: 40 });
  try {
    await assert.rejects(client.transcribeChunk({ audioPath, timeoutMs: 40 }), (e: unknown) => {
      const err = e as AppError;
      assert.equal(err.code, 'ASR_FAILED');
      assert.equal(err.retryable, true);
      return true;
    });
  } finally {
    await server.close();
  }
});

test('asr: 非法时间段的分段被跳过（其余正常）', async () => {
  await withAsrServer(
    ({ res }) =>
      sendJson(res, 200, {
        text: 'a',
        duration: 5,
        n_speakers: 1,
        segments: [
          { start: 1, end: 2, speaker: 'S1', text: '正常' },
          { start: 3, end: 2.5, speaker: 'S1', text: '倒序脏句' },
        ],
        base_resp: { status_code: 0 },
      }),
    async (_server, audioPath, client) => {
      const result = await client.transcribeChunk({ audioPath });
      assert.equal(result.segments.length, 1);
      assert.equal(result.segments[0].text, '正常');
    },
  );
});

test('asr: 缺少 duration → ASR_FAILED', async () => {
  await withAsrServer(
    ({ res }) => sendJson(res, 200, { text: 'x', segments: [], base_resp: { status_code: 0 } }),
    async (_server, audioPath, client) => {
      await assert.rejects(client.transcribeChunk({ audioPath }), (e: unknown) => (e as AppError).code === 'ASR_FAILED');
    },
  );
});

test('asr: 缺少 segments 但含文本 → 合成单段（容错，2026-11-14 实测真实返回）', async () => {
  await withAsrServer(
    ({ res }) => sendJson(res, 200, { text: '你好', duration: 2.5, n_speakers: 1 }),
    async (_server, audioPath, client) => {
      const r = await client.transcribeChunk({ audioPath });
      assert.equal(r.segments.length, 1);
      assert.equal(r.segments[0].text, '你好');
      assert.equal(r.segments[0].endMs, 2500);
    },
  );
});

test('asr: 缺少 segments 且无文本（静音声道）→ 空结果而非失败', async () => {
  await withAsrServer(
    ({ res }) => sendJson(res, 200, { duration: 1.2, n_speakers: 0 }),
    async (_server, audioPath, client) => {
      const r = await client.transcribeChunk({ audioPath });
      assert.equal(r.segments.length, 0);
      assert.equal(r.text, '');
    },
  );
});

// ───────────────────────── DeepSeek 分析 ─────────────────────────

function makeAnalysisInput(overrides: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    callId: 'call_test_001',
    meta: {
      direction: 'outbound',
      durationSec: 123,
      toPhoneMasked: '186****3330',
      fromPhoneMasked: '156****0075',
      customerName: '李总',
      lineName: '电信回拨',
      startedAt: '2026-11-14T10:03:00+08:00',
      asrProvider: 'minimax/asr-1.0',
      speakerMappingMethod: 'asr_diarization',
      speakerConfidence: 0.86,
    },
    segments: [
      { role: 'agent', speakerLabel: 'S1', beginMs: 240, endMs: 3840, text: '喂，你好，我是孚盟的销售，请问是李总吗？' },
      { role: 'customer', speakerLabel: 'S2', beginMs: 4280, endMs: 10080, text: '嗯，我是，有什么事吗？' },
    ],
    maxInputChars: 120000,
    ...overrides,
  };
}

function validAnalysisJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: { short: '客户为外贸公司负责人，对客户管理系统有初步兴趣。', bullets: ['坐席完成自我介绍', '客户询问产品用途', '约定后续跟进'] },
    intent: { label: '中意向', score: 0.6 },
    keywords: ['外贸', '客户管理', '跟进'],
    customer_profile: { contact_name: '李总', company: '某外贸公司', role: '负责人', current_vendor: 'unknown', status: '潜客', engagement: '中' },
    action_items: ['发送产品资料', '三天后回访'],
    risk_flags: [],
    quality: { compliance_issues: [], coaching_points: ['开场可更简洁'] },
    meta: { model: 'deepseek-chat', prompt_version: 'analysis-v1', confidence: 0.72 },
    ...overrides,
  };
}

function chatCompletion(content: string, opts: { finishReason?: string; model?: string; usage?: Record<string, number> } = {}): unknown {
  return {
    id: 'chatcmpl-test',
    model: opts.model ?? 'deepseek-chat',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: opts.finishReason ?? 'stop' }],
    usage: opts.usage ?? { prompt_tokens: 208, completion_tokens: 265, total_tokens: 473 },
  };
}

function createTestAnalysisClient(baseUrl: string, overrides: Partial<Parameters<typeof createAnalysisClient>[0]> = {}) {
  return createAnalysisClient({
    baseUrl,
    apiKey: 'test-deepseek-key',
    model: 'deepseek-chat',
    escalateModel: 'deepseek-v4-pro',
    promptVersion: 'analysis-v1',
    temperature: 0.2,
    maxTokens: 2000,
    escalateMaxTokens: 4096,
    maxRetries: 0,
    retryBaseMs: 5,
    timeoutMs: 5000,
    ...overrides,
  });
}

test('analysis: 请求形状/prompt/输出映射', async () => {
  const server = await startMockServer(({ res }) => sendJson(res, 200, chatCompletion(JSON.stringify(validAnalysisJson()))));
  const client = createTestAnalysisClient(server.url);
  try {
    const output = await client.analyze(makeAnalysisInput());
    assert.equal(server.requests.length, 1);
    const req = server.requests[0];
    assert.equal(req.url, '/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer test-deepseek-key');
    const body = JSON.parse(req.body.toString('utf8')) as Record<string, any>;
    assert.equal(body.model, 'deepseek-chat');
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_tokens, 2000);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, ANALYSIS_SYSTEM_PROMPT);
    assert.equal(body.messages[1].role, 'user');
    assert.match(String(body.messages[1].content), /【元数据】/);
    assert.match(String(body.messages[1].content), /【转写】/);
    assert.match(String(body.messages[1].content), /agent\(S1\)/);
    assert.match(String(body.messages[1].content), /00:00\.24-00:03\.84/);

    assert.equal(output.model, 'deepseek-chat');
    assert.equal(output.promptVersion, 'analysis-v1');
    assert.equal(output.schemaVersion, 'analysis-json-v1');
    assert.equal(output.intent.label, '中意向');
    assert.equal(output.intent.score, 0.6);
    assert.equal(output.summary.bullets.length, 3);
    assert.deepEqual(output.keywords, ['外贸', '客户管理', '跟进']);
    assert.equal(output.actionItems.length, 2);
    assert.deepEqual(output.riskFlags, []);
    assert.deepEqual(output.quality?.complianceIssues, []);
    assert.equal(output.usage.promptTokens, 208);
    assert.equal(output.usage.completionTokens, 265);
    assert.equal(output.usage.totalTokens, 473);
    assert.ok(typeof output.usage.latencyMs === 'number');
  } finally {
    await server.close();
  }
});

test('analysis: JSON 非法 → 附校验错误重试（同模型）后成功', async () => {
  let n = 0;
  const server = await startMockServer(({ res }) => {
    n++;
    if (n === 1) sendJson(res, 200, chatCompletion('这不是 JSON'));
    else sendJson(res, 200, chatCompletion(JSON.stringify(validAnalysisJson())));
  });
  const client = createTestAnalysisClient(server.url);
  try {
    const output = await client.analyze(makeAnalysisInput());
    assert.equal(output.intent.label, '中意向');
    assert.equal(server.requests.length, 2);
    const second = JSON.parse(server.requests[1].body.toString('utf8')) as Record<string, any>;
    assert.equal(second.messages.length, 3);
    assert.match(String(second.messages[2].content), /不合法/);
    assert.equal(second.model, 'deepseek-chat');
  } finally {
    await server.close();
  }
});

test('analysis: schema 校验失败两次 → 升级 escalateModel（max_tokens≥4096）', async () => {
  let n = 0;
  const server = await startMockServer(({ res }) => {
    n++;
    if (n <= 2) sendJson(res, 200, chatCompletion(JSON.stringify(validAnalysisJson({ intent: { label: '超高意向', score: 2 } }))));
    else sendJson(res, 200, chatCompletion(JSON.stringify(validAnalysisJson()), { model: 'deepseek-v4-pro' }));
  });
  const client = createTestAnalysisClient(server.url);
  try {
    const output = await client.analyze(makeAnalysisInput());
    assert.equal(server.requests.length, 3);
    const third = JSON.parse(server.requests[2].body.toString('utf8')) as Record<string, any>;
    assert.equal(third.model, 'deepseek-v4-pro');
    assert.ok(third.max_tokens >= 4096);
    assert.match(String(third.messages[2].content), /intent\.label/);
    assert.equal(output.model, 'deepseek-v4-pro');
  } finally {
    await server.close();
  }
});

test('analysis: 持续非法 → ANALYSIS_FAILED(retryable=true)', async () => {
  const server = await startMockServer(({ res }) => sendJson(res, 200, chatCompletion(JSON.stringify({ summary: {} }))));
  const client = createTestAnalysisClient(server.url);
  try {
    await assert.rejects(client.analyze(makeAnalysisInput()), (e: unknown) => {
      const err = e as AppError;
      assert.equal(err.code, 'ANALYSIS_FAILED');
      assert.equal(err.retryable, true);
      assert.equal((err.details as Record<string, unknown>).attempts, 3);
      return true;
    });
    assert.equal(server.requests.length, 3);
  } finally {
    await server.close();
  }
});

test('analysis: finish_reason=length → 提升 max_tokens 后重试成功', async () => {
  let n = 0;
  const server = await startMockServer(({ res }) => {
    n++;
    if (n === 1) sendJson(res, 200, chatCompletion('{"summary":', { finishReason: 'length', usage: { prompt_tokens: 10, completion_tokens: 2000, total_tokens: 2010 } }));
    else sendJson(res, 200, chatCompletion(JSON.stringify(validAnalysisJson())));
  });
  const client = createTestAnalysisClient(server.url);
  try {
    const output = await client.analyze(makeAnalysisInput());
    assert.equal(output.summary.short.length > 0, true);
    assert.equal(server.requests.length, 2);
    const second = JSON.parse(server.requests[1].body.toString('utf8')) as Record<string, any>;
    assert.ok(second.max_tokens >= 4096);
    assert.match(String(second.messages[2].content), /截断/);
  } finally {
    await server.close();
  }
});

test('analysis: 429 后成功（HTTP 重试）', async () => {
  let n = 0;
  const server = await startMockServer(({ res }) => {
    n++;
    if (n === 1) sendJson(res, 429, { error: { message: 'rate limit' } }, { 'retry-after': '0' });
    else sendJson(res, 200, chatCompletion(JSON.stringify(validAnalysisJson())));
  });
  const client = createTestAnalysisClient(server.url, { maxRetries: 2 });
  try {
    const output = await client.analyze(makeAnalysisInput());
    assert.equal(output.intent.label, '中意向');
    assert.equal(server.requests.length, 2);
  } finally {
    await server.close();
  }
});

test('analysis: 401 → ANALYSIS_FAILED(retryable=false)，不重试', async () => {
  const server = await startMockServer(({ res }) => sendJson(res, 401, { error: { message: 'invalid api key' } }));
  const client = createTestAnalysisClient(server.url, { maxRetries: 3 });
  try {
    await assert.rejects(client.analyze(makeAnalysisInput()), (e: unknown) => {
      const err = e as AppError;
      assert.equal(err.code, 'ANALYSIS_FAILED');
      assert.equal(err.retryable, false);
      return true;
    });
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('analysis: 输入超过 maxInputChars → VALIDATION_FAILED（不发请求）', async () => {
  const server = await startMockServer(({ res }) => sendJson(res, 200, chatCompletion(JSON.stringify(validAnalysisJson()))));
  const client = createTestAnalysisClient(server.url);
  try {
    const input = makeAnalysisInput({ maxInputChars: 20 });
    await assert.rejects(client.analyze(input), (e: unknown) => (e as AppError).code === 'VALIDATION_FAILED');
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('analysis: 超时 → ANALYSIS_FAILED(retryable=true)', async () => {
  const server = await startMockServer(async ({ res }) => {
    await new Promise((r) => setTimeout(r, 300));
    sendJson(res, 200, chatCompletion(JSON.stringify(validAnalysisJson())));
  });
  const client = createTestAnalysisClient(server.url, { timeoutMs: 40 });
  try {
    await assert.rejects(client.analyze(makeAnalysisInput()), (e: unknown) => {
      const err = e as AppError;
      assert.equal(err.code, 'ANALYSIS_FAILED');
      assert.equal(err.retryable, true);
      return true;
    });
  } finally {
    await server.close();
  }
});

test('analysis: buildUserMessage 与 system prompt 文案符合 docs/13', () => {
  assert.match(ANALYSIS_SYSTEM_PROMPT, /电话销售质检与分析助手/);
  assert.match(ANALYSIS_SYSTEM_PROMPT, /intent\.label 只能是/);
  const msg = buildAnalysisUserMessage(makeAnalysisInput());
  assert.match(msg, /callId: call_test_001/);
  assert.match(msg, /坐席号码: 156\*\*\*\*0075/);
  assert.match(msg, /客户号码: 186\*\*\*\*3330/);
  assert.match(msg, /说话人映射: asr_diarization\(confidence 0\.86\)/);
  // schema 校验：合法数据通过、枚举越界拒绝
  assert.equal(ANALYSIS_OUTPUT_SCHEMA.safeParse(validAnalysisJson()).success, true);
  assert.equal(ANALYSIS_OUTPUT_SCHEMA.safeParse(validAnalysisJson({ intent: { label: '超高意向' } })).success, false);
});
