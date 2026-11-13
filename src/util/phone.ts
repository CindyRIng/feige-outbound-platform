const MOBILE = /^1[3-9]\d{9}$/;
const LANDLINE = /^0\d{2,3}-?\d{7,8}$/;
export function normalizePhone(input: string): string {
  const s = String(input ?? '').replace(/[\s-]/g, '');
  if (MOBILE.test(s)) return s;
  if (LANDLINE.test(s)) return s.includes('-') ? s : s.replace(/^(0\d{2,3})(\d{7,8})$/, '$1-$2');
  return s;
}
export function isValidPhone(input: string): boolean { const s = normalizePhone(input); return MOBILE.test(s) || LANDLINE.test(s); }
export function maskPhone(input: string | null | undefined): string {
  const s = String(input ?? ''); if (!s) return '';
  if (/^1[3-9]\d{9}$/.test(s)) return s.slice(0,3) + '****' + s.slice(-4);
  return s.replace(/\d{4,}/g, m => m.slice(0,3) + '****');
}
export function maskPhonesInText(text: string): string { return text.replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, m => m.slice(0,3) + '****' + m.slice(-4)); }
export function maskName(name: string | null | undefined, enabled: boolean): string | null {
  if (!name) return name ?? null;
  if (!enabled) return name;
  return name.length <= 1 ? '*' : name[0] + '*'.repeat(Math.max(1, name.length - 1));
}
