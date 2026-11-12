// Find in Files in the editor: a result's file marks every occurrence of the search's query (the one the selection holds
// more strongly) and the scrollbar ruler ticks them, until Esc in the editor, the find card opening with its own query or
// the search's query being emptied. Loaded the first time a result is opened, with what selects the result's match.
import { EditorSelection, Prec, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { SearchQuery, closeSearchPanel, searchPanelOpen } from '@codemirror/search';
import type { SearchSpec } from '@shared/search';
import { compileSearch } from '@shared/search-match';
import { nearestMatch } from '../search/model';
import { useSearch } from '../search/store';
import type { FoundTarget } from '../store';
import { setTargetLine } from './decorations';
import { rulerQuery } from './ruler';

/** Shows a query's occurrences in the editor, or none (null). */
export const setSearchHits = StateEffect.define<SearchSpec | null>();

interface Hits { spec: SearchSpec; query: SearchQuery }

const hitsField = StateField.define<Hits | null>({
  create: () => null,
  update(hits, tr) {
    for (const e of tr.effects) {
      if (e.is(setSearchHits)) hits = e.value && { spec: e.value, query: new SearchQuery({ search: e.value.query, caseSensitive: e.value.matchCase, wholeWord: e.value.wholeWord, regexp: e.value.regex }) };
    }
    // The find card opening brings its own query: the marks give way to it.
    return hits && searchPanelOpen(tr.state) && !searchPanelOpen(tr.startState) ? null : hits;
  },
  provide: (f) => rulerQuery.from(f, (h) => h?.query ?? null)
});

/** The query whose occurrences the editor shows, or null. */
export const searchHitsSpec = (state: EditorState): SearchSpec | null => state.field(hitsField, false)?.spec ?? null;

const hit = Decoration.mark({ class: 'cm-fif-hit' });
const strong = Decoration.mark({ class: 'cm-fif-hit-strong' });

/** The marks over `ranges` (what the editor shows): every occurrence, the one the selection holds strongly. */
export function hitDecorations(state: EditorState, ranges: readonly { from: number; to: number }[]): DecorationSet {
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

/** The editors marking occurrences now: an emptied query clears them all. */
const shown = new Set<EditorView>();

const highlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(readonly view: EditorView) {
    this.decorations = hitDecorations(view.state, view.visibleRanges);
    shown.add(view);
  }
  update(u: ViewUpdate) {
    const hits = u.state.field(hitsField, false);
    if (hits !== u.startState.field(hitsField, false) || (hits && (u.docChanged || u.viewportChanged || u.selectionSet))) {
      this.decorations = hitDecorations(u.state, u.view.visibleRanges);
    }
  }
  destroy() { shown.delete(this.view); }
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
export function foundRange(state: EditorState, line: number, found: FoundTarget): { from: number; to: number } | null {
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
 * it where it is.
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
    effects: [setSearchHits.of(found.spec), setTargetLine.of(doc.lineAt(sel.main.from).number), EditorView.scrollIntoView(sel.main, { y: 'center' })]
  });
}
