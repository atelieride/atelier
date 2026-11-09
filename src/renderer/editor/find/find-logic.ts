// Find and replace card: what the card shows and what a key means, without DOM.
import { EditorSelection, type EditorState, type Text } from '@codemirror/state';
import type { SearchQuery } from '@codemirror/search';
import { t } from '../../i18n/en';
import { isMod, isOtherMod } from '@shared/keys';

/** The query fields the card edits and a new card starts from. */
export interface FindSpec { search: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean; replace: string }

export interface MatchCount { total: number; capped: boolean; index: number }
export interface MatchList { ranges: { from: number; to: number }[]; capped: boolean }

// The last list per document (documents are immutable): a 5 MB file takes ~170 ms to scan, so moving the cursor,
// pressing Enter or redrawing the scrollbar marks must not scan it again.
const lists = new WeakMap<Text, { query: SearchQuery; cap: number; list: MatchList }>();

/** The matches of the query (up to `cap`), scanned once per document and query. */
export function matchList(state: EditorState, query: SearchQuery, cap = 9999): MatchList {
  if (!query.valid) return { ranges: [], capped: false };
  const hit = lists.get(state.doc);
  if (hit && hit.cap === cap && hit.query.eq(query)) return hit.list;
  const ranges: { from: number; to: number }[] = [];
  let capped = false;
  const cursor = query.getCursor(state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    if (ranges.length === cap) { capped = true; break; }
    ranges.push({ from: next.value.from, to: next.value.to });
  }
  const list = { ranges, capped };
  lists.set(state.doc, { query, cap, list });
  return list;
}

/** Counts the matches (up to `cap`) and finds the main selection among them (-1 when it isn't one). */
export function countMatches(state: EditorState, query: SearchQuery, cap = 9999): MatchCount {
  const { ranges, capped } = matchList(state, query, cap);
  const sel = state.selection.main;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid]!;
    if (r.from < sel.from) lo = mid + 1;
    else if (r.from > sel.from) hi = mid - 1;
    else return { total: ranges.length, capped, index: r.to === sel.to ? mid : -1 };
  }
  return { total: ranges.length, capped, index: -1 };
}

/** ⌥↵: a cursor on every match, from the cached list; CodeMirror's own command silently gives up past 1000.
 *  'too-many' past the cap (the counter's): never a partial selection that looks like all of them. */
export function selectAllMatches(state: EditorState, query: SearchQuery, cap = 9999): EditorSelection | 'too-many' | null {
  const { ranges, capped } = matchList(state, query, cap);
  if (capped) return 'too-many';
  if (!ranges.length) return null;
  return EditorSelection.create(ranges.map((r) => EditorSelection.range(r.from, r.to)));
}

export interface CounterInput extends MatchCount { empty: boolean; valid: boolean; quiet: boolean }
export type CounterTone = 'normal' | 'error' | 'quiet';

/** "3 of 14", "14 results", "No results", "Invalid"…; `narrow` for a card in a split pane ("3/14"). */
export function counterText(c: CounterInput, narrow: boolean): { text: string; tone: CounterTone } {
  if (c.empty) return { text: '', tone: 'normal' };
  if (!c.valid) return { text: t.find.invalid, tone: 'error' };
  if (c.total === 0) return { text: narrow ? t.find.noResultsShort : t.find.noResults, tone: c.quiet ? 'quiet' : 'error' };
  const shown = c.total.toLocaleString('en-US') + (c.capped ? '+' : '');
  if (c.index >= 0) return { text: (narrow ? t.find.ofShort : t.find.of)(String(c.index + 1), shown), tone: 'normal' };
  return { text: narrow ? shown : t.find.results(c.total, shown), tone: 'normal' };
}

/** The flags `@codemirror/search` compiles regular expressions with. */
const FLAGS = 'gmu';

/** Why a regular expression doesn't compile, in plain words; null when it does. */
export function regexError(source: string): string | null {
  try {
    new RegExp(source, FLAGS);
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const why = msg.replace(/^Invalid regular expression: \/[\s\S]*\/[a-z]*: /, '');
    if (/^Unterminated group/i.test(why)) return t.find.regex.unclosedGroup;
    if (/^Unmatched '\)'/i.test(why)) return t.find.regex.unmatchedParen;
    if (/^Nothing to repeat/i.test(why)) return t.find.regex.nothingToRepeat;
    if (/^Unterminated character class/i.test(why)) return t.find.regex.unclosedClass;
    if (/^\\ at end of pattern/i.test(why)) return t.find.regex.trailingBackslash;
    return why;
  }
}

export interface Tick { y: number; selected: boolean }

/** Scrollbar marks: line tops mapped onto the track, marks closer than 2 px merged, at most `max` (the selected kept). */
export function tickPositions(lines: { top: number; selected: boolean }[], docHeight: number, trackHeight: number, max = 2000): Tick[] {
  if (docHeight <= 0 || trackHeight <= 0) return [];
  const merged: Tick[] = [];
  for (const l of [...lines].sort((a, b) => a.top - b.top)) {
    const y = Math.min(trackHeight - 2, Math.max(0, Math.round((l.top / docHeight) * trackHeight)));
    const last = merged.at(-1);
    if (last && y - last.y < 3) last.selected ||= l.selected;
    else merged.push({ y, selected: l.selected });
  }
  if (merged.length <= max) return merged;
  const step = merged.length / max;
  const out = Array.from({ length: max }, (_, i) => merged[Math.floor(i * step)]!);
  const sel = merged.find((m) => m.selected);
  if (sel && !out.includes(sel)) out[Math.min(max - 1, Math.floor(merged.indexOf(sel) / step))] = sel;
  return out;
}

export type FindAction = 'next' | 'prev' | 'selectAll' | 'replace' | 'replaceAll' | 'toggleCase' | 'toggleWord' | 'toggleRegex' | 'close';
type Keys = Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'metaKey' | 'shiftKey' | 'ctrlKey' | 'isComposing'>;

/** What a key pressed inside the card means. ⌥C/⌥W/⌥R go by the physical key: on a Mac ⌥C types "ç" or "©". */
export function shortcutAction(e: Keys, field: 'find' | 'replace' | 'other', readOnly: boolean): FindAction | null {
  // Enter and Esc during an IME composition confirm or cancel it.
  if (e.isComposing) return null;
  if (e.key === 'Escape') return 'close';
  if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    if (e.code === 'KeyC') return 'toggleCase';
    if (e.code === 'KeyW') return 'toggleWord';
    if (e.code === 'KeyR') return 'toggleRegex';
  }
  // The main modifier: ⌘ on macOS, Ctrl on Windows; the other one is never part of these keys.
  const mod = isMod(e);
  if (e.key !== 'Enter' || isOtherMod(e)) return null;
  if (field === 'find') {
    if (mod) return null;
    if (e.altKey) return 'selectAll';
    return e.shiftKey ? 'prev' : 'next';
  }
  if (field === 'replace' && !readOnly && !e.altKey && !e.shiftKey) return mod ? 'replaceAll' : 'replace';
  return null;
}

/** A card whose ↵ goes up (a terminal's): ↵ and ⇧↵ trade places; next/prev stay down/up. */
export function swapEnter(a: FindAction, enterUp: boolean): FindAction {
  if (!enterUp) return a;
  return a === 'next' ? 'prev' : a === 'prev' ? 'next' : a;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A new card's query: a short one-line selection (with the last options), else the last query. */
export function initialQuery(state: EditorState, last: FindSpec | null): FindSpec {
  const base = last ?? { search: '', caseSensitive: false, wholeWord: false, regexp: false, replace: '' };
  const sel = state.selection.main;
  if (sel.empty || sel.to - sel.from > 100) return base;
  const text = state.sliceDoc(sel.from, sel.to);
  if (text.includes('\n')) return base;
  // A plain query still reads \n, \t and \\ as escapes: a selected backslash is doubled to find itself.
  return { ...base, search: base.regexp ? escapeRegExp(text) : text.replace(/\\/g, '\\\\') };
}
