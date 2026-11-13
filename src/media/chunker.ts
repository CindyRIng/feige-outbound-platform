// 本地媒体预处理：WAV 解析 / 静音检测 / 分块计划 / WAV 切片
//
// 设计依据：docs/13 §2.3（≤480s 整段；>480s 按 420s 窗口切分，切点落在静音区间；
// 窗口尾部找不到静音点可延长到 480s 并标记 forcedCut=true）；docs/09 §10.3（ChunkPlanner 契约）。
// 纯 Node 实现，不依赖 ffmpeg/ffprobe：只处理 RIFF/WAVE PCM（v1 上游录音实测为 16bit PCM）。
import { open, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WavInfo, ChunkPlan } from './types.js';
import { AppError } from '../errors.js';

/** 供应商单请求硬上限 500s，本平台计划保证每块 ≤480s（留 20s 余量）。 */
export const CHUNK_HARD_MAX_MS = 480_000;
/** 静音判定最小持续时间（docs/13 §2.3：≥300ms）。 */
export const DEFAULT_MIN_SILENCE_MS = 300;
/** 静音检测帧长（能量统计窗口）。 */
export const DEFAULT_SILENCE_FRAME_MS = 20;
/** 静音能量阈值（dBFS）；电话录音底噪下 -40dBFS 可区分语音/静音。 */
export const DEFAULT_SILENCE_THRESHOLD_DB = -40;

const WAV_HEADER_MIN = 12;

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new AppError('VALIDATION_FAILED', message, { details });
}

/** 读取 RIFF/WAVE 头，返回 PCM data 的位置与格式信息。支持 16bit PCM、1–2 声道。 */
export async function probeWav(path: string): Promise<WavInfo> {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch (err) {
    throw new AppError('AUDIO_NOT_AVAILABLE', `无法打开音频文件: ${(err as Error).message}`, { details: { path } });
  }
  try {
    const stat = await fh.stat();
    if (stat.size < WAV_HEADER_MIN) invalid('WAV 文件过短，不是合法 RIFF/WAVE', { size: stat.size });

    const head = Buffer.alloc(12);
    const { bytesRead } = await fh.read(head, 0, 12, 0);
    if (bytesRead < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      invalid('不是合法 RIFF/WAVE 文件', { magic: head.toString('ascii', 0, 12) });
    }

    let offset = 12;
    let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
    let dataOffset = -1;
    let dataLength = -1;

    while (offset + 8 <= stat.size) {
      const chunkHead = Buffer.alloc(8);
      const r = await fh.read(chunkHead, 0, 8, offset);
      if (r.bytesRead < 8) break;
      const id = chunkHead.toString('ascii', 0, 4);
      const size = chunkHead.readUInt32LE(4);
      const bodyOffset = offset + 8;
      if (bodyOffset + size > stat.size) {
        invalid('WAV 块长度越界（文件可能被截断）', { chunk: id, size, fileSize: stat.size, bodyOffset });
      }
      if (id === 'fmt ') {
        const fmtBuf = Buffer.alloc(Math.min(size, 40));
        const fr = await fh.read(fmtBuf, 0, fmtBuf.length, bodyOffset);
        if (fr.bytesRead < 16) invalid('WAV fmt 块过短');
        fmt = {
          audioFormat: fmtBuf.readUInt16LE(0),
          channels: fmtBuf.readUInt16LE(2),
          sampleRate: fmtBuf.readUInt32LE(4),
          bitsPerSample: fmtBuf.readUInt16LE(14),
        };
      } else if (id === 'data') {
        dataOffset = bodyOffset;
        dataLength = size;
        break; // data 之后的块（如 LIST）与音频无关
      }
      offset = bodyOffset + size + (size % 2); // RIFF 块按 2 字节对齐
    }

    if (!fmt) invalid('WAV 缺少 fmt 块');
    if (dataOffset < 0 || dataLength <= 0) invalid('WAV 缺少 data 块或数据为空');
    if (fmt.audioFormat !== 1) invalid('仅支持 PCM（audioFormat=1）WAV', { audioFormat: fmt.audioFormat });
    if (fmt.bitsPerSample !== 16) invalid('仅支持 16bit PCM WAV', { bitsPerSample: fmt.bitsPerSample });
    if (fmt.channels < 1 || fmt.channels > 2) invalid('仅支持 1–2 声道 WAV', { channels: fmt.channels });
    if (!fmt.sampleRate || fmt.sampleRate < 8000) invalid('非法采样率', { sampleRate: fmt.sampleRate });
    const bytesPerFrame = fmt.channels * (fmt.bitsPerSample / 8);
    const byteRate = fmt.sampleRate * bytesPerFrame;
    const durationMs = Math.round((dataLength / byteRate) * 1000);

    return {
      path,
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      bitsPerSample: fmt.bitsPerSample,
      durationMs,
      dataOffset,
      dataLength,
    };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

export interface SilenceOptions {
  /** 静音能量阈值（dBFS），默认 -40。 */
  thresholdDb?: number;
  /** 最小静音时长（ms），默认 300。 */
  minSilenceMs?: number;
  /** 静音检测帧长（ms），默认 20。 */
  frameMs?: number;
}

export interface SilenceRange {
  beginMs: number;
  endMs: number;
}

/**
 * 能量法静音检测（流式读取，不整段入内存）。
 * 兼容 STUB 签名：`detectSilences(info, minSilenceMs?)`；也可传 options 对象。
 * 返回按时间升序、互不重叠的静音区间（ms，相对音频起点）。
 */
export async function detectSilences(info: WavInfo, minSilenceMs?: number): Promise<SilenceRange[]>;
export async function detectSilences(info: WavInfo, opts?: number | SilenceOptions): Promise<SilenceRange[]>;
export async function detectSilences(info: WavInfo, opts?: number | SilenceOptions): Promise<SilenceRange[]> {
  const minSilenceMs = Math.max(0, typeof opts === 'number' ? opts : opts?.minSilenceMs ?? DEFAULT_MIN_SILENCE_MS);
  const thresholdDb = typeof opts === 'object' && opts ? opts.thresholdDb ?? DEFAULT_SILENCE_THRESHOLD_DB : DEFAULT_SILENCE_THRESHOLD_DB;
  const frameMs = Math.max(5, Math.round(typeof opts === 'object' && opts ? opts.frameMs ?? DEFAULT_SILENCE_FRAME_MS : DEFAULT_SILENCE_FRAME_MS));

  const bytesPerSample = info.bitsPerSample / 8;
  const bytesPerFrame = info.channels * bytesPerSample;
  const framesPerWindow = Math.max(1, Math.round((info.sampleRate * frameMs) / 1000));
  const windowBytes = framesPerWindow * bytesPerFrame;
  const readSize = Math.max(windowBytes * 64, 1 << 20);
  const blockBytes = readSize - (readSize % windowBytes);

  const ranges: SilenceRange[] = [];
  let silenceStartFrame: number | null = null;
  let frameIndex = 0;
  const flush = (endFrame: number): void => {
    if (silenceStartFrame === null) return;
    const beginMs = silenceStartFrame * frameMs;
    const endMs = Math.min(endFrame * frameMs, info.durationMs);
    if (endMs - beginMs >= minSilenceMs) ranges.push({ beginMs: Math.max(0, beginMs), endMs });
    silenceStartFrame = null;
  };
  const analyzeWindow = (buf: Buffer, base: number): void => {
    let sumSquares = 0;
    const sampleCount = windowBytes / bytesPerSample;
    for (let s = 0; s < sampleCount; s++) {
      const v = buf.readInt16LE(base + s * bytesPerSample);
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / sampleCount) / 32768;
    const db = rms <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms);
    if (db <= thresholdDb) {
      if (silenceStartFrame === null) silenceStartFrame = frameIndex;
    } else {
      flush(frameIndex);
    }
    frameIndex++;
  };

  const fh = await open(info.path, 'r');
  try {
    let pos = info.dataOffset;
    let remaining = info.dataLength;
    let leftover: Buffer = Buffer.alloc(0);
    while (remaining > 0) {
      const toRead = Math.min(blockBytes, remaining);
      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await fh.read(buf, 0, toRead, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      remaining -= bytesRead;
      const data = leftover.length > 0 ? Buffer.concat([leftover, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const windows = Math.floor(data.length / windowBytes);
      for (let w = 0; w < windows; w++) analyzeWindow(data, w * windowBytes);
      leftover = Buffer.from(data.subarray(windows * windowBytes));
    }
    if (leftover.length >= bytesPerFrame) {
      // 末尾不足一个统计窗口的残余：按可用样本单独判定（保守）
      let sumSquares = 0;
      const sampleCount = Math.floor(leftover.length / bytesPerSample);
      for (let s = 0; s < sampleCount; s++) {
        const v = leftover.readInt16LE(s * bytesPerSample);
        sumSquares += v * v;
      }
      const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) / 32768 : 0;
      const db = rms <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms);
      if (db <= thresholdDb) {
        if (silenceStartFrame === null) silenceStartFrame = frameIndex;
      } else {
        flush(frameIndex);
      }
      frameIndex++;
    }
    flush(frameIndex);
  } finally {
    await fh.close().catch(() => undefined);
  }
  return ranges;
}

/** 合并/裁剪静音区间，保证升序、互不重叠、位于 [0, durationMs]。 */
function normalizeSilences(durationMs: number, silences: { beginMs: number; endMs: number }[] | undefined): SilenceRange[] {
  if (!silences || silences.length === 0) return [];
  const sorted = silences
    .map((s) => ({
      beginMs: Math.max(0, Math.min(Number(s.beginMs), durationMs)),
      endMs: Math.max(0, Math.min(Number(s.endMs), durationMs)),
    }))
    .filter((s) => Number.isFinite(s.beginMs) && Number.isFinite(s.endMs) && s.endMs > s.beginMs)
    .sort((a, b) => a.beginMs - b.beginMs);
  const out: SilenceRange[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.beginMs <= last.endMs) last.endMs = Math.max(last.endMs, s.endMs);
    else out.push({ ...s });
  }
  return out;
}

/**
 * 分块计划（纯函数；docs/13 §2.3）：
 * - duration ≤ 480s：整段一块；
 * - duration > 480s：以 chunkSeconds（默认 420s）为窗口，切点取落在 [窗口尾, +480s] 内静音区间的
 *   最晚可行点；找不到静音点时延长到 480s 强制切分并标 forcedCut=true；
 * - 末尾剩余 ≤480s 时作为最后一块（forcedCut=false）。
 */
export function planChunks(durationMs: number, chunkSeconds: number, silencesMs: { beginMs: number; endMs: number }[] = []): ChunkPlan[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) invalid('durationMs 必须为正数', { durationMs });
  if (!Number.isFinite(chunkSeconds) || chunkSeconds <= 0) invalid('chunkSeconds 必须为正数', { chunkSeconds });
  const total = Math.round(durationMs);
  if (total <= CHUNK_HARD_MAX_MS) {
    return [{ index: 0, beginMs: 0, endMs: total, forcedCut: false }];
  }
  const target = Math.min(Math.round(chunkSeconds * 1000), CHUNK_HARD_MAX_MS);
  const silences = normalizeSilences(total, silencesMs);

  const plans: ChunkPlan[] = [];
  let cursor = 0;
  let index = 0;
  const maxIterations = Math.ceil(total / Math.max(target, 1)) + 4;
  for (let i = 0; i < maxIterations && cursor < total; i++) {
    const remaining = total - cursor;
    if (remaining <= CHUNK_HARD_MAX_MS) {
      plans.push({ index: index++, beginMs: cursor, endMs: total, forcedCut: false });
      break;
    }
    const desired = cursor + target;
    const hardEnd = Math.min(cursor + CHUNK_HARD_MAX_MS, total);
    let cut: number | null = null;
    for (const s of silences) {
      const lo = Math.max(s.beginMs, desired);
      const hi = Math.min(s.endMs, hardEnd);
      if (hi > lo) cut = Math.max(cut ?? -1, hi);
    }
    if (cut !== null && cut > cursor) {
      plans.push({ index: index++, beginMs: cursor, endMs: cut, forcedCut: false });
      cursor = cut;
    } else {
      plans.push({ index: index++, beginMs: cursor, endMs: hardEnd, forcedCut: true });
      cursor = hardEnd;
    }
  }
  if (plans.length === 0) return [{ index: 0, beginMs: 0, endMs: total, forcedCut: false }];
  if (plans[plans.length - 1].endMs < total) {
    plans.push({ index: plans.length, beginMs: plans[plans.length - 1].endMs, endMs: total, forcedCut: false });
  }
  return plans;
}

/**
 * 按分块计划切出合法的独立 WAV 文件（重写 RIFF 头 + 精确 PCM 数据切片）。
 * plan 坐标相对原音频起点；切片按帧对齐后写入 outPath（0600）。
 */
export async function sliceWav(info: WavInfo, plan: ChunkPlan, outPath: string): Promise<void> {
  if (info.bitsPerSample !== 16) invalid('仅支持 16bit PCM 切片', { bitsPerSample: info.bitsPerSample });
  const bytesPerFrame = info.channels * (info.bitsPerSample / 8);
  const totalFrames = Math.floor(info.dataLength / bytesPerFrame);
  const beginMs = Math.max(0, Math.min(plan.beginMs, info.durationMs));
  const endMs = Math.max(0, Math.min(plan.endMs, info.durationMs));
  if (endMs <= beginMs) invalid('切片区间非法', { beginMs, endMs });
  const startFrame = Math.floor((beginMs / 1000) * info.sampleRate);
  const endFrame = Math.min(Math.ceil((endMs / 1000) * info.sampleRate), totalFrames);
  if (startFrame < 0 || endFrame <= startFrame || endFrame > totalFrames) {
    invalid('切片帧范围越界', { startFrame, endFrame, totalFrames });
  }
  const byteOffset = info.dataOffset + startFrame * bytesPerFrame;
  const dataLength = (endFrame - startFrame) * bytesPerFrame;

  const fh = await open(info.path, 'r');
  let pcm: Buffer;
  try {
    pcm = Buffer.alloc(dataLength);
    let read = 0;
    while (read < dataLength) {
      const r = await fh.read(pcm, read, dataLength - read, byteOffset + read);
      if (r.bytesRead <= 0) break;
      read += r.bytesRead;
    }
    if (read !== dataLength) invalid('读取 PCM 数据不足（文件可能被截断）', { expected: dataLength, read });
  } finally {
    await fh.close().catch(() => undefined);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(info.channels, 22);
  header.writeUInt32LE(info.sampleRate, 24);
  const byteRate = info.sampleRate * bytesPerFrame;
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(bytesPerFrame, 32);
  header.writeUInt16LE(info.bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);

  await mkdir(dirname(outPath), { recursive: true, mode: 0o700 });
  await writeFile(outPath, Buffer.concat([header, pcm]), { mode: 0o600 });
}

/**
 * 双声道音频按声道切片：从交织 PCM 中提取指定声道并写出单声道 WAV。
 * v1 约定：通话录音为 8kHz/16bit/2ch（A/B 分声道），用于完美说话人分离（docs/13 §4.2 路径 A）。
 */
export async function sliceChannelWav(info: WavInfo, plan: ChunkPlan, outPath: string, channel: 0 | 1): Promise<void> {
  if (info.bitsPerSample !== 16) throw new AppError('ASR_FAILED', '仅支持 16bit PCM 声道切片', { details: { bitsPerSample: info.bitsPerSample } });
  if (info.channels !== 2) throw new AppError('ASR_FAILED', '文件不是双声道', { details: { channels: info.channels } });
  const bytesPerSample = info.bitsPerSample / 8;
  const bytesPerFrame = info.channels * bytesPerSample;
  const totalFrames = Math.floor(info.dataLength / bytesPerFrame);
  const beginMs = Math.max(0, Math.min(plan.beginMs, info.durationMs));
  const endMs = Math.max(0, Math.min(plan.endMs, info.durationMs));
  const startFrame = Math.floor((beginMs / 1000) * info.sampleRate);
  const endFrame = Math.min(Math.ceil((endMs / 1000) * info.sampleRate), totalFrames);
  const byteOffset = info.dataOffset + startFrame * bytesPerFrame;
  const dataLength = (endFrame - startFrame) * bytesPerFrame;
  if (endFrame <= startFrame || dataLength <= 0) throw new AppError('ASR_FAILED', '声道切片区间非法', { details: { beginMs, endMs } });
  const fh = await open(info.path, 'r');
  let interleaved: Buffer;
  try {
    interleaved = Buffer.alloc(dataLength);
    let read = 0;
    while (read < dataLength) {
      const r = await fh.read(interleaved, read, dataLength - read, byteOffset + read);
      if (r.bytesRead <= 0) break;
      read += r.bytesRead;
    }
  } finally { await fh.close().catch(() => undefined); }
  const frames = Math.floor(dataLength / bytesPerFrame);
  const mono = Buffer.alloc(frames * bytesPerSample);
  for (let f = 0; f < frames; f++) {
    const src = f * bytesPerFrame + channel * bytesPerSample;
    interleaved.copy(mono, f * bytesPerSample, src, src + bytesPerSample);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + mono.length, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(info.sampleRate, 24);
  header.writeUInt32LE(info.sampleRate * bytesPerSample, 28); header.writeUInt16LE(bytesPerSample, 32);
  header.writeUInt16LE(info.bitsPerSample, 34); header.write('data', 36, 'ascii'); header.writeUInt32LE(mono.length, 40);
  const out = Buffer.concat([header, mono]);
  await writeFile(outPath, out, { mode: 0o600 });
}
