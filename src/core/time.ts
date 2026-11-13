import type { Config } from '../types/config.js';
import type { DialWindow } from '../types/domain.js';

function tzNowParts(tz: string, now: Date) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const parts = Object.fromEntries(fmt.formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), hh: Number(parts.hour), mm: Number(parts.minute), ss: Number(parts.second) };
}
function tzOffsetMinutes(tz: string, now: Date): number {
  const parts = tzNowParts(tz, now);
  const asUtc = Date.UTC(parts.y, parts.m - 1, parts.d, parts.hh, parts.mm, parts.ss);
  return Math.round((asUtc - now.getTime()) / 60000);
}
export function dialWindow(cfg: Config, now: Date = new Date()): DialWindow {
  const { windowStart, windowEnd, timezone } = cfg.dial;
  const p = tzNowParts(timezone, now);
  const cur = p.hh * 60 + p.mm;
  const [sh, sm] = windowStart.split(':').map(Number);
  const [eh, em] = windowEnd.split(':').map(Number);
  const start = sh * 60 + sm, end = eh * 60 + em;
  const open = cur >= start && cur < end;
  let nextOpenAt: string | undefined;
  if (!open) {
    const offsetMin = tzOffsetMinutes(timezone, now);
    const base = new Date(now.getTime() + offsetMin * 60000);
    const y = base.getUTCFullYear(), mo = base.getUTCMonth(), d0 = base.getUTCDate();
    let target = Date.UTC(y, mo, d0, sh, sm, 0) - offsetMin * 60000;
    if (cur >= end) target += 24 * 3600 * 1000;
    nextOpenAt = new Date(target).toISOString();
  }
  return { open, windowStart, windowEnd, timezone, nextOpenAt: nextOpenAt ?? null };
}
export function withinDialWindow(cfg: Config, at: Date = new Date()): boolean { return dialWindow(cfg, at).open; }
