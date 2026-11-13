import type { IsoDateTime } from '../types/common.js';

export interface WavInfo {
  path: string;
  sampleRate: number; channels: number; bitsPerSample: number;
  durationMs: number; dataOffset: number; dataLength: number;
}
export interface ChunkPlan { index: number; beginMs: number; endMs: number; forcedCut: boolean; }
export interface AsrSegmentRaw { beginMs: number; endMs: number; speakerLabel: string; text: string; }
export interface AsrChunkResult {
  text: string; durationMs: number; nSpeakers: number;
  segments: AsrSegmentRaw[]; traceId?: string | null;
}
export interface AsrChunkRequest { audioPath: string; language?: string; timeoutMs?: number; }
export interface AsrClient { transcribeChunk(req: AsrChunkRequest): Promise<AsrChunkResult>; }

export interface AnalysisInputSegment { role: 'agent'|'customer'|'unknown'; speakerLabel?: string | null; beginMs: number; endMs: number; text: string; }
export interface AnalysisInput {
  callId: string;
  meta: { direction: 'outbound'; durationSec?: number | null; toPhoneMasked: string; fromPhoneMasked?: string | null; customerName?: string | null; lineName?: string | null; startedAt?: IsoDateTime | null; asrProvider: string; speakerMappingMethod: string; speakerConfidence?: number | null };
  segments: AnalysisInputSegment[];
  maxInputChars: number;
}
export interface AnalysisOutput {
  model: string; promptVersion: string; schemaVersion: string;
  raw: Record<string, unknown>;
  summary: { short: string; bullets: string[] };
  intent: { label: string; score?: number | null };
  keywords: string[]; customerProfile?: Record<string, unknown> | null;
  actionItems: string[]; riskFlags: string[];
  quality?: { complianceIssues: string[]; coachingPoints: string[] } | null;
  usage: { promptTokens?: number | null; completionTokens?: number | null; totalTokens?: number | null; latencyMs?: number | null };
}
export interface AnalysisClient { analyze(input: AnalysisInput): Promise<AnalysisOutput>; }
