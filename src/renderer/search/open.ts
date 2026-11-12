// Find in Files from anywhere in the window: View › Find in Files (⇧⌘F), the palette, a find card's "Search in all
// files", the selection a search starts from, and F4 / ⇧F4 through the results. On the first paint, so kept small: the
// view, its store and what opening a result takes load on first use.
import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { SearchSpec } from '@shared/search';
import { initialQuery, seedText, type FindSpec } from '../editor/find/find-logic';
import { useApp } from '../store';

/** What the first paint reaches of the search store once it has loaded, without loading it. */
export interface LoadedSearch { hasResults(): boolean; spec(): SearchSpec; step(dir: 1 | -1, keepFocus: boolean): void }

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
  if ('state' in source) return initialQuery(source.state, { search: '', caseSensitive: false, wholeWord: false, regexp: regex, replace: '' }).search || null;
  return seedText(source.text, regex);
}

/** Find in Files in front (the sidebar shown), the keyboard in its field with the text selected; a seed is searched. */
export function openFindInFiles(seed?: SearchSpec): void {
  useApp.getState().setActivity('search');
  void import('./store').then((m) => m.useSearch.getState().focusField(seed));
}

/** Find cards that hand their query over: ⇧⌘F with the keyboard in one does what its "Search in all files" does. */
const cards = new WeakMap<Element, () => void>();
export function cardHandsOver(card: Element, go: () => void): () => void {
  cards.set(card, go);
  return () => { cards.delete(card); };
}

/** View › Find in Files (⇧⌘F): with the keyboard in a find card, its query and options; else the selection, if short. */
export function findInFilesCommand(): void {
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
 * F4 / ⇧F4 at the window, before an editor or a field has them. From the list or the field the keyboard stays there
 * to walk on; from anywhere else it follows the result into its editor. A pop-out holds no results: once one was shown
 * in it, its project window walks on, and a match in the pop-out's file comes back to it, selected and marked.
 */
export function installSearchKeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const el = document.activeElement;
    const { popout, mdVisit } = useApp.getState();
    const dir = f4Action(e, !!el?.closest('.xterm'), popout ? !!mdVisit[popout.key.slice(2)] : hasSearchResults());
    if (dir === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (popout) void window.atelier.popout.forward(dir === 1 ? 'next-search-result' : 'prev-search-result').catch(() => {});
    else stepSearchResult(dir, !!el?.closest('.sidebar.is-search'));
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
