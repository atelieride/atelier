// Find in Files in the editor: a result's file marks every occurrence of the search's query (the one the selection holds
// more strongly) and the scrollbar ruler ticks them, until Esc in the editor, the find card opening with its own query or
// the search's query being emptied. Loaded the first time a result is opened, with what selects the result's match.
import { EditorSelection, Prec, StateEffect, StateField, type ChangeDesc, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { SearchQuery, closeSearchPanel, searchPanelOpen } from '@codemirror/search';
import type { SearchSpec } from '@shared/search';
import { compileSearch } from '@shared/search-match';
import { nearestMatch } from '../search/model';
import { useSearch } from '../search/store';
import { forgetFound, type FoundTarget } from '../store';
import { RESULT_SELECT } from './comments-ext';
import { setTargetLine } from './decorations';
import { rulerMatches } from './ruler';

type Range = { from: number; to: number };

/** Shows a query's occurrences in the editor, or none (null). */
export const setSearchHits = StateEffect.define<SearchSpec | null>();
/** Every occurrence of the query shown, found by the scan below: the ruler ticks them. */
export const setHitRanges = StateEffect.define<readonly Range[]>();

/** `ranges`: every occurrence, once scanned (null until then). */
interface Hits { spec: SearchSpec; query: SearchQuery; ranges: readonly Range[] | null }

/** Ranges moved along with an edit; one whose text went away is dropped. */
function mapRanges(ranges: readonly Range[], changes: ChangeDesc): Range[] {
  const out: Range[] = [];
  for (const r of ranges) {
    const from = changes.mapPos(r.from, 1);
    const to = changes.mapPos(r.to, -1);
    if (to > from) out.push({ from, to });
  }
  return out;
}

const hitsField = StateField.define<Hits | null>({
  create: () => null,
  update(hits, tr) {
    for (const e of tr.effects) {
      if (e.is(setSearchHits)) {
        const query = e.value && new SearchQuery({ search: e.value.query, caseSensitive: e.value.matchCase, wholeWord: e.value.wholeWord, regexp: e.value.regex });
        // The same query again (the next result in this file): its ticks stay, nothing is scanned again (a result on a
        // line too long to scan gets its own tick).
        if (!e.value || !query) hits = null;
        else if (!hits?.query.eq(query)) hits = { spec: e.value, query, ranges: null };
        else if (hits.ranges) {
          const ranges = withOwn(hits.ranges, ownTick(tr.state, hits.query));
          if (ranges !== hits.ranges) hits = { ...hits, ranges };
        }
      } else if (e.is(setHitRanges) && hits) hits = { ...hits, ranges: e.value };
    }
    // The find card opening brings its own query: the marks give way to it.
    if (hits && searchPanelOpen(tr.state) && !searchPanelOpen(tr.startState)) return null;
    // Edits move the ticks along until the next scan has them again.
    return hits?.ranges && tr.docChanged ? { ...hits, ranges: mapRanges(hits.ranges, tr.changes) } : hits;
  },
  provide: (f) => rulerMatches.from(f, (h) => h?.ranges ?? null)
});

/** The query whose occurrences the editor shows, or null. */
export const searchHitsSpec = (state: EditorState): SearchSpec | null => state.field(hitsField, false)?.spec ?? null;

const hit = Decoration.mark({ class: 'cm-fif-hit' });
const strong = Decoration.mark({ class: 'cm-fif-hit-strong' });

/** The marks over `ranges` (what the editor shows): every occurrence, the one the selection holds strongly. */
export function hitDecorations(state: EditorState, ranges: readonly Range[]): DecorationSet {
  const hits = state.field(hitsField, false);
  if (!hits?.query.valid) return Decoration.none;
  const sel = state.selection.main;
  const marks = [];
  for (const r of ranges) {
    const cursor = hits.query.getCursor(state, r.from, r.to);
    for (let m = cursor.next(); !m.done; m = cursor.next()) {
      const { from, to } = m.value;
      marks.push((from === sel.from && to === sel.to ? strong : hit).range(from, to));
    }
  }
  return Decoration.set(marks, true);
}

/** Characters the scan reads at a time, to a line's end (a match never spans lines); the ruler's cap of matches. */
const CHUNK = 64 * 1024;
const MAX_MATCHES = 9999;
/** Lines longer than this (a minified file's) are not scanned for the ruler: one pass over one could hold the page. */
const LONG_LINE = 64 * 1024;

/**
 * Scans for the ruler from `from` on, part after part (each at most CHUNK plus one line of LONG_LINE), adding what it
 * finds to `out`, until `deadline` (a `performance.now()` time: at least one part is always read) or the end; returns
 * where to go on, or null when done (the end of the text, or `cap` matches). Lines past LONG_LINE are passed over.
 */
export function scanMatches(state: EditorState, query: SearchQuery, from: number, out: Range[], deadline: number, cap = MAX_MATCHES): number | null {
  const doc = state.doc;
  let at = from;
  do {
    const first = doc.lineAt(at);
    let to: number;
    if (first.length > LONG_LINE) to = first.to;
    else {
      to = doc.lineAt(Math.min(doc.length, at + CHUNK)).to;
      // The part stops before a long line it would reach.
      const last = doc.lineAt(to);
      if (last.length > LONG_LINE) to = last.from - 1;
      const cursor = query.getCursor(state, at, to);
      for (let m = cursor.next(); !m.done; m = cursor.next()) {
        out.push({ from: m.value.from, to: m.value.to });
        if (out.length >= cap) return null;
      }
    }
    if (to >= doc.length) return null;
    at = to + 1;
  } while (performance.now() < deadline);
  return at;
}

/** The selection when it is a match of `query` on a line too long to scan: the result shown there keeps its tick. */
export function ownTick(state: EditorState, query: SearchQuery): Range | null {
  const sel = state.selection.main;
  if (sel.empty || state.doc.lineAt(sel.from).length <= LONG_LINE) return null;
  const m = query.getCursor(state, sel.from, sel.to).next();
  return !m.done && m.value.from === sel.from && m.value.to === sel.to ? { from: sel.from, to: sel.to } : null;
}

/** `ranges` with `own` in its place, once (the same list when there is nothing to add). */
function withOwn(ranges: readonly Range[], own: Range | null): readonly Range[] {
  if (!own || ranges.some((r) => r.from === own.from && r.to === own.to)) return ranges;
  const i = ranges.findIndex((r) => r.from > own.from);
  return i < 0 ? [...ranges, own] : [...ranges.slice(0, i), own, ...ranges.slice(i)];
}

/** A slice of the scan holds the page this long at most; after edits the scan waits for a pause in typing. */
const SLICE_MS = 8;
const AFTER_EDIT_MS = 300;

/** The editors marking occurrences now: an emptied query clears them all. */
const shown = new Set<EditorView>();

const highlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly view: EditorView) {
    this.decorations = hitDecorations(view.state, view.visibleRanges);
    shown.add(view);
  }
  update(u: ViewUpdate) {
    const hits = u.state.field(hitsField, false);
    const before = u.startState.field(hitsField, false);
    if (hits !== before || (hits && (u.docChanged || u.viewportChanged || u.selectionSet))) {
      this.decorations = hitDecorations(u.state, u.view.visibleRanges);
    }
    if (hits && hits.query !== before?.query) this.scan(0);
    else if (hits && u.docChanged) this.scan(AFTER_EDIT_MS);
  }
  /**
   * Finds every occurrence for the ruler a slice at a time, never holding the page (a 5 MB file takes about 200 ms in
   * all); a newer text or query drops the scan under way.
   */
  private scan(delay: number) {
    clearTimeout(this.timer);
    const { doc } = this.view.state;
    const query = this.view.state.field(hitsField, false)?.query;
    if (!query) return;
    const own = ownTick(this.view.state, query);
    const out: Range[] = [];
    let at = 0;
    const step = () => {
      const state = this.view.state;
      if (state.doc !== doc || state.field(hitsField, false)?.query !== query) return;
      const next = scanMatches(state, query, at, out, performance.now() + SLICE_MS);
      if (next === null) { this.view.dispatch({ effects: setHitRanges.of(withOwn(out, own)) }); return; }
      at = next;
      this.timer = setTimeout(step, 0);
    };
    this.timer = setTimeout(step, delay);
  }
  destroy() {
    clearTimeout(this.timer);
    shown.delete(this.view);
  }
}, { decorations: (p) => p.decorations });

/** Esc takes the marks away first, the selection staying; with none shown it does what it always does. */
const escape = Prec.high(keymap.of([{
  key: 'Escape',
  run: (v) => {
    if (!v.state.field(hitsField, false)) return false;
    v.dispatch({ effects: setSearchHits.of(null) });
    return true;
  }
}]));

// The find card's match colors.
const theme = EditorView.baseTheme({
  '.cm-fif-hit': { backgroundColor: 'var(--hit-bg)', borderRadius: '3px' },
  '.cm-fif-hit-strong': { backgroundColor: 'var(--hit-strong)', boxShadow: '0 0 0 1px var(--hit-edge)', borderRadius: '3px' }
});

export const findInFilesHighlight: Extension = [hitsField, highlighter, escape, theme];

/** Lines either side of a result's own where its match is looked for once the file has changed. */
const NEAR = 5;

/**
 * Where a result's match is in the text as it is now, `line` being the document line it points at: there, else the
 * nearest occurrence within a few lines (the one starting nearest the result's column on a line); null when none is.
 */
export function foundRange(state: EditorState, line: number, found: FoundTarget): Range | null {
  const compiled = compileSearch(found.spec);
  if (compiled.kind !== 'ok') return null;
  const doc = state.doc;
  // Only the lines it can be on are read, not the whole document.
  const lines: string[] = [];
  for (let n = Math.max(1, line - NEAR); n <= Math.min(doc.lines, line + NEAR); n++) lines[n - 1] = doc.line(n).text;
  const m = nearestMatch(lines, compiled.ranges, line, found.from, NEAR);
  if (!m) return null;
  const at = doc.line(m.line).from;
  return { from: at + m.from, to: at + m.to };
}

let watching = false;

/**
 * Shows a result in its editor, `line` being the document line it points at: its match selected and centred (the line
 * alone when the match is gone), every occurrence of the query marked; the keyboard moves there unless the result keeps
 * it where it is. The selection is the result's, not the user's: no "Comment" button for it.
 */
export function showFound(view: EditorView, line: number, found: FoundTarget): void {
  if (!watching) {
    watching = true;
    // The search's query emptied (the field cleared, Clear Results): every editor's marks go with it.
    useSearch.subscribe((s, prev) => {
      if (s.spec.query || !prev.spec.query) return;
      for (const v of shown) if (v.state.field(hitsField, false)) v.dispatch({ effects: setSearchHits.of(null) });
    });
  }
  if (view.state.field(hitsField, false) === undefined) view.dispatch({ effects: StateEffect.appendConfig.of(findInFilesHighlight) });
  // One set of marks at a time: the result's query replaces the card's.
  if (searchPanelOpen(view.state)) closeSearchPanel(view);
  const doc = view.state.doc;
  const n = Math.min(Math.max(1, line), doc.lines);
  const r = foundRange(view.state, n, found);
  const sel = r ? EditorSelection.single(r.from, r.to) : EditorSelection.single(doc.line(n).from);
  // Focus first: an editor gaining focus later reads the page's selection back and would undo the move.
  if (!found.keepFocus) view.focus();
  view.dispatch({
    selection: sel,
    userEvent: RESULT_SELECT,
    effects: [setSearchHits.of(found.spec), setTargetLine.of(doc.lineAt(sel.main.from).number), EditorView.scrollIntoView(sel.main, { y: 'center' })]
  });
  forgetFound(found);
}
