/**
 * The terminal's font: the family a terminal draws with, the stack built from it, and
 * which installed families the pickers offer.
 */

/** The font that comes with Atelier (fonts.ts registers it), and the terminal's default. */
export const BUNDLED_FONT = 'JetBrains Mono';

const FALLBACK = "'JetBrains Mono', ui-monospace, Menlo, monospace";

/**
 * A family name the setting keeps: 1–100 characters, no space at either end, no `"` or `\` (the stack puts the name in
 * double quotes as is), no control characters.
 */
export function isFontFamily(v: unknown): v is string {
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' && v.length > 0 && v.length <= 100 && v.trim() === v && !/["\\\u0000-\u001f\u007f-\u009f]/.test(v);
}

/** What xterm and CSS draw with: the family, then Atelier's font for the glyphs it lacks, then the system's. */
export function fontStack(family: string): string {
  return family === BUNDLED_FONT || !isFontFamily(family) ? FALLBACK : `"${family}", ${FALLBACK}`;
}

/** The glyphs measured to tell a monospaced font: narrow, wide and punctuation. */
export const MONO_PROBE = ['i', 'W', 'm', '.', '0', 'l'] as const;

/** Monospaced when every probe glyph is as wide as the first (within 0.05 px at the measuring size). */
export function isMonospaced(width: (ch: string) => number): boolean {
  const first = width(MONO_PROBE[0]);
  return first > 0 && MONO_PROBE.every((ch) => Math.abs(width(ch) - first) < 0.05);
}

/**
 * The installed families a picker lists: monospaced, without macOS's hidden faces (a leading dot), the bundled font
 * (listed on its own) or names the setting couldn't keep, once each, sorted ignoring case.
 */
export function installedMonospace(families: readonly string[], monospaced: (family: string) => boolean): string[] {
  const out = [...new Set(families)].filter((f) => !f.startsWith('.') && f !== BUNDLED_FONT && isFontFamily(f) && monospaced(f));
  return out.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

/** A saved font the machine doesn't have: only known once the installed list was read (null: it couldn't be). */
export function fontMissing(family: string, installed: readonly string[] | null): boolean {
  if (family === BUNDLED_FONT || !installed) return false;
  const name = family.toLowerCase();
  return !installed.some((f) => f.toLowerCase() === name);
}
