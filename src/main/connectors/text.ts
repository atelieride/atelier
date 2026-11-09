// Untrusted text from a connector's replies, as it reaches TaskSummary / TaskDetail: one shape for every
// connector (ClickUp's map.ts, Notion's map.ts), on top of the shared cleaner (src/shared/clean-text.ts) the renderer
// uses too. Titles become one clean line; bodies are capped in UTF-8 bytes on a character boundary.
import { cleanLine } from '@shared/clean-text';

export const MAX_TITLE_CHARS = 500;

const clip = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
};

/**
 * One line (the shared cleaner, src/shared/clean-text.ts: no control or invisible characters, whitespace collapsed,
 * trimmed), at most `max` characters.
 */
export function oneLine(s: string | null | undefined, max = MAX_TITLE_CHARS): string {
  if (!s) return '';
  return clip(cleanLine(s), max);
}

/** At most `maxBytes` of UTF-8, cut on a character boundary. */
export function capUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // back off continuation bytes to a character start
  return buf.subarray(0, end).toString('utf8');
}
