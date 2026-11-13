export interface Config {
  server: { host: string; port: number; allowRemote: boolean; apiTokenFile?: string | null };
  storage: { dataDir: string; dbFile: string; audioDir: string; asrDir: string };
  browser: { headless: boolean; profileRoot: string; executablePath?: string | null };
  dial: { windowStart: string; windowEnd: string; timezone: string; scheduleOutsideWindow: boolean };
  limits: { perAccountConcurrency: number; globalConcurrency: number; upstreamReadQps: number; dialCooldownMs: number; apiQps: number };
  sync: { intervalMs: number; pageSize: number; lookbackDays: number };
  pipeline: {
    asr: { provider: string; baseUrl: string; model: string; language: string; responseFormat: string; timestampLevel: string; chunkSeconds: number; concurrency: number; timeoutMs: number; maxRetries: number };
    analysis: { provider: string; baseUrl: string; model: string; escalateModel: string; promptVersion: string; temperature: number; maxTokens: number; escalateMaxTokens: number; concurrency: number; maxRetries: number; redactPhones: boolean; redactNames: boolean; maxInputChars: number };
    roleMapping: { method: string; llmVerify: boolean; lowConfidenceReview: boolean };
    rawDump: { enabled: boolean };
  };
  events: { sseHeartbeatMs: number; webhooks: { url: string; eventTypes: string[]; enabled: boolean; timeoutMs?: number | null }[] };
  logging: { level: 'debug'|'info'|'warn'|'error' };
  backup: { includeAsrChunks: boolean };
  runtime: { keepAliveMs: number; jobLeaseMs: number };
}
export interface Secrets {
  apiToken?: string;
  minimaxApiKey?: string;
  deepseekApiKey?: string;
  accounts: Record<string, { username: string; password: string; browserProfile?: string }>;
  webhookSecrets?: Record<string, string>;
}
