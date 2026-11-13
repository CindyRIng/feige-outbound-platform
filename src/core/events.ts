import type { Repo } from '../db/repo.js';
import { newEventId } from './ids.js';
import type { EventType } from '../types/common.js';
import type { EventRecord } from '../types/domain.js';
import type { Logger } from '../logger.js';

export interface EventInput {
  type: EventType;
  accountId?: string | null;
  callId?: string | null;
  jobId?: string | null;
  data?: Record<string, unknown>;
}
export type EventListener = (e: EventRecord) => void;

export class EventBus {
  private listeners = new Set<EventListener>();
  constructor(private repo: Repo, private log: Logger) {}
  subscribe(fn: EventListener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  get subscribers(): number { return this.listeners.size; }
  async emit(input: EventInput): Promise<EventRecord> {
    const rec: EventRecord = {
      eventId: newEventId(), type: input.type, occurredAt: new Date().toISOString(),
      accountId: input.accountId ?? null, callId: input.callId ?? null, data: input.data ?? {},
    };
    const row = {
      eventId: rec.eventId, type: rec.type, occurredAt: rec.occurredAt,
      accountId: rec.accountId, callId: rec.callId, jobId: input.jobId ?? null,
      dataJson: JSON.stringify(rec.data ?? {}), createdAt: rec.occurredAt,
    };
    try { await this.repo.insertEvent(row as any); } catch (e) { this.log.warn('event persist failed', { err: (e as Error).message, type: rec.type }); }
    for (const fn of this.listeners) { try { fn(rec); } catch { /* ignore */ } }
    return rec;
  }
}
