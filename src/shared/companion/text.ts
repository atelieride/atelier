// Ask companion: the small text helpers chat.md (chat.ts) and facts.md (facts.ts) share. Pure.

export const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
export const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

const pad2 = (n: number) => String(n).padStart(2, '0');
/** Local time, 24 h: "12:38". */
export const hhmm = (t: number) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
/** Local date: "2026-10-31". */
export const ymd = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

// Control characters (newline and tab aside) and format characters (zero-width, bidi overrides, BOM).
const INVISIBLE = /(?![\n\t])[\p{Cc}\p{Cf}]/gu;

/**
 * Text kept on several lines: line breaks as "\n", invisible characters gone (one never hides a key from redaction:
 * tidy before redacting), at most one blank line in a row, trimmed.
 */
export const tidy = (s: string) => s.replace(/\r\n?|[\p{Zl}\p{Zp}]/gu, '\n').replace(INVISIBLE, '').replace(/\n{3,}/g, '\n\n').trim();

// Control characters that aren't whitespace or a line break (tab, LF, VT, FF, CR and NEL are).
const NON_SPACE_CONTROL = /(?![\t\n\v\f\r\x85])\p{Cc}/gu;

/**
 * One line: format characters and other invisible controls gone (a key split by one is whole again for redaction),
 * line breaks and tabs as spaces, whitespace collapsed.
 */
export const oneLine = (s: string) => s.replace(/\p{Cf}/gu, '').replace(NON_SPACE_CONTROL, '').replace(/[\s\x85\p{Zl}\p{Zp}]+/gu, ' ').trim();

/** At most `max` characters, the end replaced by "…"; never half a character. */
export const cutEnd = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, isHighSurrogate(s.charCodeAt(max - 2)) ? max - 2 : max - 1)}…`);

/** At most `max` characters, the start replaced by "…" (a path keeps its file name); never half a character. */
export const cutFront = (s: string, max: number) =>
  (s.length <= max ? s : `…${s.slice(s.length - (isLowSurrogate(s.charCodeAt(s.length - max + 1)) ? max - 2 : max - 1))}`);

/**
 * At most `max` characters: the head and the tail around a note of how much was cut (`extra`: characters already cut
 * before); never half a character.
 */
export function middleCut(s: string, max: number, extra = 0): string {
  if (s.length <= max && extra === 0) return s;
  const note = (n: number) => `\n[… ${n} characters cut …]\n`;
  const room = Math.max(0, Math.min(s.length, max - note(s.length + extra).length));
  let head = Math.ceil(room / 2);
  let tail = room - head;
  if (head > 0 && isHighSurrogate(s.charCodeAt(head - 1))) head--;
  if (tail > 0 && isLowSurrogate(s.charCodeAt(s.length - tail))) tail--;
  return s.slice(0, head) + note(s.length - head - tail + extra) + s.slice(s.length - tail);
}
