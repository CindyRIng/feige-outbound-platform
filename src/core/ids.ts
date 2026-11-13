import { randomBytes } from 'node:crypto';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(): string {
  let time = Date.now(); let out = '';
  for (let i = 0; i < 10; i++) { out = ALPHABET[time % 32] + out; time = Math.floor(time / 32); }
  const rand = randomBytes(16);
  for (let i = 0; i < 16; i++) out += ALPHABET[rand[i] % 32];
  return out;
}
export const newCallId = () => `call_${ulid()}`;
export const newJobId = () => `job_${ulid()}`;
export const newEventId = () => `evt_${ulid()}`;
export const newAudioId = () => `aud_${ulid()}`;
export const newTranscriptId = () => `tr_${ulid()}`;
export const newAnalysisId = () => `ana_${ulid()}`;
export const newSegmentId = () => `seg_${ulid()}`;
export const newTermId = () => `term_${ulid()}`;
export const newChunkId = () => `chk_${ulid()}`;
export const newAuditId = () => `audit_${ulid()}`;
export const newRequestId = () => `req_${ulid()}`;
