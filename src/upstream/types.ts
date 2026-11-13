import type { IsoDateTime } from '../types/common.js';

export interface UpstreamUserDetail {
  userId: string; realName?: string | null; mobile?: string | null; tenantCode?: string | null;
  enterpriseName?: string | null; balance?: number | null; [k: string]: unknown;
}
export interface UpstreamLine { lineId: number | string; lineName: string; mode: number; tbpsId?: string | null; }
export interface UpstreamCallRecord {
  id: string; userId?: string | null; realName?: string | null; phone?: string | null;
  telA?: string | null; telB?: string | null; telX?: string | null;
  interfaceId?: string | number | null; interfaceName?: string | null; lineName?: string | null; mode?: number | null;
  callType?: number | null; callStatus?: number | null; callStatusName?: string | null;
  finishStatus?: number | null; finishStatusName?: string | null; handle?: number | null;
  duration?: number | null; createTime?: number | null; startTime?: number | null; endTime?: number | null; updateTime?: number | null;
  preRecordUrl?: string | null; postage?: number | null; agentCode?: number | null;
  callerAttr?: string | null; calleeAttr?: string | null; sipCodeResult?: string | null;
  tenantCode?: string | null; enterpriseName?: string | null; [k: string]: unknown;
}
export interface UpstreamCallPageQuery {
  page: number; limit: number;
  startTimeBegin?: string | null; startTimeFinish?: string | null;
  callStatus?: number | null; userIds?: string[]; callType?: string;
}
export interface UpstreamCallPageResult { total: number; list: UpstreamCallRecord[]; }
export interface UpstreamDialResult { bindId?: string | null; [k: string]: unknown; }
export interface LoginResult { ok: boolean; jwt?: string; jwtIssuedAt?: IsoDateTime; jwtExpiresAt?: IsoDateTime; reason?: string; errorDetail?: string; }

export interface UpstreamClient {
  request<T>(method: 'GET' | 'POST', path: string, opts?: { query?: Record<string, string | number | undefined>; body?: unknown; timeoutMs?: number }): Promise<T>;
  getUserDetail(): Promise<UpstreamUserDetail>;
  getCallLineList(): Promise<UpstreamLine[]>;
  getExistOther(mobile: string): Promise<number>;
  dialCall(params: { telB: string; interfaceId: string | number; octCustomerId?: string | null }): Promise<UpstreamDialResult>;
  getCallPage(q: UpstreamCallPageQuery): Promise<UpstreamCallPageResult>;
  logout(): Promise<void>;
  setToken(token: string | null): void;
  getToken(): string | null;
}
export interface RealtimeHandle { close(): void; connected: boolean; lastPongAt?: IsoDateTime | null; }
export type RealtimeHandler = (msg: unknown) => void;
