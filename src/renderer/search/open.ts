// Find in Files from anywhere in the window: View › Find in Files (⌘⇧F), the palette, a find card's "Search in all
// files", the selection a search starts from, and F4 / ⇧F4 through the results. On the first paint, so kept small: the
// view, its store and what opening a result takes load on first use.
import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { SearchSpec } from '@shared/search';
import { resultSelection } from '../editor/result-select';
import { initialQuery, seedText, type FindSpec } from '../editor/find/find-logic';
import { insideOverlay } from '../pane-focus';
import { useApp } from '../store';

/** What the first paint reaches of the search store once it has loaded, without loading it (`step`: the file it opened). */
export interface LoadedSearch { hasResults(): boolean; spec(): SearchSpec; step(dir: 1 | -1, keepFocus: boolean): string | null }

const PLAIN: SearchSpec = { query: '', matchCase: false, wholeWord: false, regex: false };
let loaded: LoadedSearch | null = null;
/** The search store, as it loads. */
export function searchLoaded(l: LoadedSearch): void { loaded = l; }
/** Results F4 can walk: none before the store has loaded (nothing was searched). */
export const hasSearchResults = (): boolean => loaded?.hasResults() ?? false;
/** The field's query and options (a store not loaded yet starts plain). */
const currentSpec = (): SearchSpec => loaded?.spec() ?? PLAIN;

/** Where a selection comes from: an editor's state, or text (a terminal's, a preview's). */
export type SeedSource = { state: EditorState } | { text: string };

let terminalSelection: (el: Element) => string | null = () => null;
/** The terminals' registry tells which terminal holds an element and what is selected there (it owns the xterms). */
export function setTerminalSelection(read: (el: Element) => string | null): void { terminalSelection = read; }

/** The selection where the keyboard is: a terminal's, an editor's, else the page's (a preview); none in a field. */
function focusedSelection(): SeedSource | null {
  const el = document.activeElement;
  if (el?.closest('.xterm')) return { text: terminalSelection(el) ?? '' };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return null;
  const cm = el?.closest<HTMLElement>('.cm-editor');
  const view = cm ? EditorView.findFromDOM(cm) : null;
  return view ? { state: view.state } : { text: window.getSelection()?.toString() ?? '' };
}

/**
 * The query a search starts from: the selection when it is one line of at most 100 characters, escaped as the find
 * card escapes it for the options it is searched with (backslashes doubled, or the text escaped for a regular
 * expression); else null.
 */
export function selectionSeed(source: SeedSource | null = focusedSelection(), regex: boolean = currentSpec().regex): string | null {
  if (!source) return null;
  if (!('state' in source)) return seedText(source.text, regex);
  // The match a result selected is not the user's selection: the query that found it stays (a regular expression too).
  if (source.state.field(resultSelection, false)?.eq(source.state.selection.main)) return null;
  return initialQuery(source.state, { search: '', caseSensitive: false, wholeWord: false, regexp: regex, replace: '' }).search || null;
}

/** Find in Files in front (the sidebar shown), the keyboard in its field with the text selected; a seed is searched. */
export function openFindInFiles(seed?: SearchSpec): void {
  useApp.getState().setActivity('search');
  void import('./store').then((m) => m.useSearch.getState().focusField(seed));
}

/** Find cards that hand their query over: ⌘⇧F with the keyboard in one does what its "Search in all files" does. */
const cards = new WeakMap<Element, () => void>();
export function cardHandsOver(card: Element, go: () => void): () => void {
  cards.set(card, go);
  return () => { cards.delete(card); };
}

/**
 * View › Find in Files (⌘⇧F): with the keyboard in a find card, its query and options; else the selection, if short.
 * Given in a pop-out, or reaching a window without the keyboard, nothing of this window's (a selection left in an
 * editor here) is the query.
 */
export function findInFilesCommand(fromPopout = false): void {
  if (fromPopout || !document.hasFocus()) { openFindInFiles(); return; }
  const card = document.activeElement?.closest('.find-card');
  const go = card ? cards.get(card) : undefined;
  if (go) { go(); return; }
  const query = selectionSeed();
  openFindInFiles(query === null ? undefined : { ...currentSpec(), query });
}

/** A find card's query and options, searched in every file; an empty card leaves the field as it was. */
export function searchAllFrom(s: FindSpec): void {
  openFindInFiles(s.search ? { query: s.search, matchCase: s.caseSensitive, wholeWord: s.wholeWord, regex: s.regexp } : undefined);
}

type F4Key = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'>;

/**
 * F4: the next result, ⇧F4: the previous one. Nothing with another modifier, without results, or in a terminal: there
 * F4 is the program's (mc, htop).
 */
export function f4Action(e: F4Key, inTerminal: boolean, hasResults: boolean): 1 | -1 | null {
  if (e.key !== 'F4' || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || inTerminal || !hasResults) return null;
  return e.shiftKey ? -1 : 1;
}

/**
 * The result after (before) the selected one, opened: the keyboard stays where it is with `keepFocus`, else it goes
 * there. Nothing before the store has loaded: there are no results yet.
 */
export function stepSearchResult(dir: 1 | -1, keepFocus: boolean): void {
  loaded?.step(dir, keepFocus);
}

/**
 * F4 / ⇧F4 sent from a pop-out: the results are this window's. A result in a popped-out file shows in that pop-out,
 * which comes forward with it; one that opens here brings this window forward.
 */
export function stepFromPopout(dir: 1 | -1): void {
  const path = loaded?.step(dir, false);
  if (path && !useApp.getState().poppedOut.includes(`f:${path}`)) void window.atelier.popout.front().catch(() => {});
}

/**
 * F4 / ⇧F4 at the window, before an editor or a field has them. From the list or the field the keyboard stays there
 * to walk on; from anywhere else it follows the result into its editor. The palette, Settings, a sheet or a menu in
 * front keeps the key (the results behind it stay put). A pop-out holds no results: its project window walks them, and
 * a match in the pop-out's file comes back to it, selected and marked.
 */
export function installSearchKeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'F4') return;
    const el = document.activeElement;
    const st = useApp.getState();
    if (st.paletteOpen || st.settingsOpen || insideOverlay(el)) return;
    const dir = f4Action(e, !!el?.closest('.xterm'), !!st.popout || hasSearchResults());
    if (dir === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (st.popout) void window.atelier.popout.forward(dir === 1 ? 'next-search-result' : 'prev-search-result').catch(() => {});
    else stepSearchResult(dir, !!el?.closest('.sidebar.is-search'));
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
