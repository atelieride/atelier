// Find in the terminal: the pure parts — the card's counter from the search addon's
// results, the theme's match colors, the key as each platform shows it — and the requests to open a terminal's card
// (its key handler, its context menu and the palette ask; its TerminalView opens it).
import type { ISearchOptions } from '@xterm/addon-search';
import { resolveToken } from '@shared/theme-resolve';
import { acceleratorFor, formatAccelerator } from '@shared/keys';
import { THEME_BLOCKS } from '../theme-source';
import { t } from '../i18n/en';
import type { FindSpec, MatchCount } from '../editor/find/find-logic';

/** Matches the addon highlights and counts (its own default): past it the counter shows "1,000+". */
export const FIND_LIMIT = 1000;

/** The addon's results as the card's counter. Its index is -1 when the current match is past the limit. */
export function findCount(e: { resultIndex: number; resultCount: number }, limit = FIND_LIMIT): MatchCount {
  return { total: e.resultCount, capped: e.resultCount >= limit, index: e.resultIndex };
}

/** The addon's decoration options, every color set. */
export type FindColors = Required<Pick<NonNullable<ISearchOptions['decorations']>, 'matchBackground' | 'activeMatchBackground' | 'matchOverviewRuler' | 'activeMatchColorOverviewRuler' | 'activeMatchBorder'>>;

type Rgba = [number, number, number, number];
function parse(c: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) { const n = parseInt(hex[1]!, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(c);
  if (!m) throw new Error(`not a resolved color: ${c}`);
  return [+m[1]!, +m[2]!, +m[3]!, +m[4]!];
}
/** `top` painted over the opaque `bottom`, as #RRGGBB. */
function over(top: string, bottom: string): string {
  const [r, g, b, a] = parse(top);
  const [R, G, B] = parse(bottom);
  const ch = (x: number, y: number) => Math.round(x * a + y * (1 - a)).toString(16).padStart(2, '0');
  return `#${ch(r, R)}${ch(g, G)}${ch(b, B)}`.toUpperCase();
}

const made = new Map<string, FindColors>();

/**
 * A terminal theme's match colors: the preview find's `--hit-bg` and `--hit-strong` mixed over `--term-bg`
 * (xterm's decorations take opaque #RRGGBB backgrounds), scrollbar ticks in `--hit-edge`, the current one and its
 * outline in `--waiting-mark`. One object per theme.
 */
export function terminalFindColors(theme: string): FindColors {
  let out = made.get(theme);
  if (out) return out;
  const t = (name: string) => resolveToken(THEME_BLOCKS, theme, name);
  const bg = t('--term-bg');
  const mark = t('--waiting-mark');
  out = {
    matchBackground: over(t('--hit-bg'), bg), activeMatchBackground: over(t('--hit-strong'), bg),
    matchOverviewRuler: t('--hit-edge'), activeMatchColorOverviewRuler: mark, activeMatchBorder: mark
  };
  made.set(theme, out);
  return out;
}

/**
 * ⌘F with a selection: a one-line selection of up to 100 characters becomes the query, with the last options.
 * The addon takes a plain query literally (no escapes, unlike the editor's); a regular expression gets it escaped.
 */
export function selectionQuery(selection: string, base: FindSpec): FindSpec | null {
  if (!selection || selection.includes('\n') || selection.length > 100) return null;
  return { ...base, search: base.regexp ? selection.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : selection };
}

/**
 * A query typed on from the last one searched (grown, shortened, the same in another case) keeps the current match in
 * place, as in the editor; any other query starts from the newest match. null: nothing searched yet.
 */
export function continuesQuery(last: string | null, next: string): boolean {
  if (!last) return false;
  const a = last.toLowerCase();
  const b = next.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

/** The line under the field: the alternate screen's limit, else past FIND_LIMIT which matches are marked. */
export function findNote(o: { alt: boolean; capped: boolean }): string | null {
  if (o.alt) return t.find.fullScreenNote;
  return o.capped ? t.find.cappedNote : null;
}

/** A regular expression query compiles as the addon compiles it ('g' or 'gi', no 'u': laxer than the editor's). */
export function regexCompiles(source: string): boolean {
  try { new RegExp(source, 'g'); return true; } catch { return false; }
}

/** The key as this platform shows it: ⌘F; Ctrl+Shift+F on Windows (the terminal-first rule, keys.ts). */
export const terminalFindKeys = (): string => formatAccelerator(acceleratorFor('CmdOrCtrl+F')!);

const listeners = new Map<string, Set<() => void>>();

/** Opens (or brings the keyboard back to) a terminal's find card; false when no view of it is mounted here. */
export function requestTerminalFind(id: string): boolean {
  const set = listeners.get(id);
  if (!set?.size) return false;
  for (const fn of set) fn();
  return true;
}

/** A terminal's view listens for requests to open its card; the returned function stops listening. */
export function onTerminalFind(id: string, fn: () => void): () => void {
  let set = listeners.get(id);
  if (!set) { set = new Set(); listeners.set(id, set); }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) listeners.delete(id);
  };
}
