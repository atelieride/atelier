// Find and replace in CodeMirror views: our card as @codemirror/search's panel
// (its query, highlighting and commands stay), ⌘F / ⌥⌘F, and the tab registry the palette uses. Its scrollbar marks
// are drawn by the overview ruler (editor/ruler.ts).
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers, type Panel, type ViewUpdate } from '@codemirror/view';
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, replaceAll, replaceNext,
  search, searchPanelOpen, setSearchQuery
} from '@codemirror/search';
import { undo } from '@codemirror/commands';
import { useApp } from '../../store';
import { t } from '../../i18n/en';
import { searchAllFrom } from '../../search/open';
import { FindCard } from './FindCard';
import { withoutShiftModG } from '../editor-keys';
import { countMatches, initialQuery, matchList, regexError, selectAllMatches, type FindAction, type FindSpec, type MatchCount } from './find-logic';

/** Above this many characters, edits in the code recount after a pause instead of at once. */
const LARGE_DOC = 200_000;

// The last query and whether the replace row was open: one per window, in memory.
let lastSpec: FindSpec | null = null;
let lastReplaceOpen = false;

/** The window's last query, shared with the Markdown preview's card. */
export const lastFindSpec = (): FindSpec | null => lastSpec;
export function rememberFindSpec(spec: FindSpec): void { lastSpec = spec; }
/** A read-only card's query (a terminal's, the preview's): it has no replace field, so the editor's text stays. */
export function rememberFindQuery(spec: FindSpec): void { lastSpec = { ...spec, replace: lastSpec?.replace ?? '' }; }

const specOf = (q: SearchQuery): FindSpec => ({ search: q.search, caseSensitive: q.caseSensitive, wholeWord: q.wholeWord, regexp: q.regexp, replace: q.replace });

const cards = new WeakMap<EditorView, FindPanel>();

class FindPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private readonly root: Root;
  private count: MatchCount = { total: 0, capped: false, index: -1 };
  private query: SearchQuery;
  private quiet = false;
  private replaceOpen: boolean;
  private focus: { field: 'find' | 'replace'; nonce: number } = { field: 'find', nonce: 0 };
  private pending = false;
  private slow: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly view: EditorView, private readonly readOnly: boolean) {
    this.dom = document.createElement('div');
    this.dom.className = 'find-layer';
    this.root = createRoot(this.dom);
    this.query = getSearchQuery(view.state);
    this.replaceOpen = lastReplaceOpen && !readOnly;
    // The card sits outside the scroller: the wheel over it still moves the code underneath.
    this.dom.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return;
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? view.defaultLineHeight : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? view.scrollDOM.clientHeight : 1;
      view.scrollDOM.scrollBy({ top: e.deltaY * unit, left: e.deltaX * unit });
      e.preventDefault();
    }, { passive: false });
    cards.set(view, this);
    this.recount();
  }

  mount() { this.focusField('find'); }

  update(u: ViewUpdate) {
    const q = getSearchQuery(u.state);
    if (!q.eq(this.query)) {
      this.query = q;
      this.quiet = false;
      lastSpec = specOf(q);
    }
    // Typing in a large file waits for a pause before rescanning it; everything else counts right away.
    if (u.docChanged && u.state.doc.length > LARGE_DOC) this.scheduleSlow();
    else if (u.docChanged || u.selectionSet || u.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)))) this.schedule();
  }

  destroy() {
    clearTimeout(this.slow);
    if (cards.get(this.view) === this) cards.delete(this.view);
    // Never unmount while React may be rendering (the editor can update from inside an event handler).
    queueMicrotask(() => this.root.unmount());
  }

  focusField(field: 'find' | 'replace') {
    if (field === 'replace' && !this.readOnly) this.setReplaceOpen(true);
    this.focus = { field, nonce: this.focus.nonce + 1 };
    this.render();
  }

  private setReplaceOpen(open: boolean) {
    this.replaceOpen = open;
    lastReplaceOpen = open;
  }

  /** One count per batch of transactions (typing, ⌘D, a long replace), right after them: not per animation frame,
   *  which a hidden or background window delays or skips. */
  private schedule() {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      if (cards.get(this.view) === this) this.recount();
    });
  }

  private scheduleSlow() {
    clearTimeout(this.slow);
    this.slow = setTimeout(() => { if (cards.get(this.view) === this) this.recount(); }, 150);
  }

  /** Whether the keyboard is in the card (⌘F there selects the field instead of reseeding the query). */
  hasFocus(): boolean {
    return this.dom.contains(this.view.root.activeElement);
  }

  private recount() {
    this.count = this.query.search ? countMatches(this.view.state, this.query) : { total: 0, capped: false, index: -1 };
    this.render();
  }

  private setSpec(patch: Partial<FindSpec>) {
    const next = new SearchQuery({ ...specOf(this.query), ...patch });
    if (!next.eq(this.query)) this.view.dispatch({ effects: setSearchQuery.of(next) });
  }

  private act(a: FindAction) {
    const v = this.view;
    switch (a) {
      case 'next': findNext(v); break;
      case 'prev': findPrevious(v); break;
      case 'selectAll': {
        // Every match becomes a cursor (the views allow multiple selections), up to the counter's cap.
        const sel = selectAllMatches(v.state, this.query);
        if (sel === 'too-many') useApp.getState().showToast(t.find.tooManyToSelect, undefined, 'info');
        else if (sel) {
          v.focus();
          v.dispatch({ selection: sel, effects: EditorView.scrollIntoView(sel.main, { y: 'nearest' }), userEvent: 'select.search.matches' });
        }
        break;
      }
      case 'replace': if (!this.readOnly) replaceNext(v); break;
      case 'replaceAll': this.replaceAll(); break;
      case 'toggleCase': this.setSpec({ caseSensitive: !this.query.caseSensitive }); break;
      case 'toggleWord': this.setSpec({ wholeWord: !this.query.wholeWord }); break;
      case 'toggleRegex': this.setSpec({ regexp: !this.query.regexp }); break;
      case 'close': closeSearchPanel(v); break;
    }
  }

  private replaceAll() {
    const v = this.view;
    if (this.readOnly || !this.query.valid) return;
    const list = matchList(v.state, this.query);
    const n = list.capped ? matchList(v.state, this.query, Infinity).ranges.length : list.ranges.length;
    if (!n || !replaceAll(v)) return;
    this.quiet = true;
    this.recount();
    // Undo from the toast reverts the replacement only while nothing else has been typed since.
    const after = v.state.doc;
    useApp.getState().showToast(t.find.replaced(n), { label: t.comments.undo, run: () => {
      if (v.dom.isConnected && v.state.doc === after) { undo(v); v.focus(); }
    } }, 'info');
  }

  private render() {
    const q = this.query;
    this.root.render(createElement(FindCard, {
      spec: specOf(q),
      valid: q.valid || !q.search,
      regexError: q.regexp && q.search && !q.valid ? regexError(q.search) : null,
      count: this.count,
      quiet: this.quiet,
      readOnly: this.readOnly,
      replaceOpen: this.replaceOpen,
      focus: this.focus,
      onSpec: (patch) => this.setSpec(patch),
      onAction: (a) => this.act(a),
      onToggleReplace: () => {
        this.setReplaceOpen(!this.replaceOpen);
        this.focusField(this.replaceOpen ? 'replace' : 'find');
      },
      onOtherKey: (e) => runScopeHandlers(this.view, e.nativeEvent, 'search-panel'),
      // A pop-out has no sidebar to search in.
      ...(useApp.getState().popout ? {} : { onSearchAll: () => searchAllFrom(specOf(this.query)) })
    }));
  }
}

/** ⌘F (withReplace false) or ⌥⌘F: opens the card, or moves the keyboard into it; a short selection seeds the query. */
export function openFind(view: EditorView, withReplace: boolean): boolean {
  const state = view.state;
  const card = cards.get(view);
  if (!searchPanelOpen(state)) {
    openSearchPanel(view);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery(initialQuery(state, lastSpec))) });
  } else if (!card?.hasFocus()) {
    // From the code: the selection seeds the query. From inside the card the query stays as typed.
    const seeded = initialQuery(state, specOf(getSearchQuery(state)));
    if (seeded.search !== getSearchQuery(state).search) view.dispatch({ effects: setSearchQuery.of(new SearchQuery(seeded)) });
  }
  cards.get(view)?.focusField(withReplace ? 'replace' : 'find');
  return true;
}

/**
 * Find and replace for a CodeMirror view; read-only views get find only. Its scrollbar marks are the overview ruler's
 * (editor/ruler.ts), which every view using this one has.
 */
export function findExtensions({ readOnly }: { readOnly: boolean }): Extension[] {
  return [
    search({ top: true, createPanel: (view) => new FindPanel(view, readOnly) }),
    Prec.high(keymap.of(withoutShiftModG([
      { key: 'Mod-f', run: (v) => openFind(v, false), scope: 'editor search-panel', preventDefault: true },
      { key: 'Mod-Alt-f', run: (v) => openFind(v, !readOnly), scope: 'editor search-panel', preventDefault: true },
      // ⌘G / F3 with the card closed or nothing to find open it with the window's last query (else: next match).
      ...['Mod-g', 'F3'].map((key) => ({ key, run: openUnlessSearching, shift: openUnlessSearching, scope: 'editor search-panel' }))
    ])))
  ];
}

function openUnlessSearching(view: EditorView): boolean {
  if (searchPanelOpen(view.state) && getSearchQuery(view.state).valid) return false;
  return openFind(view, false);
}

// Palette and menu commands reach the view of the tab in front, as Go › Next Change does (change-targets.ts).
// A target can bring its own find (the Markdown preview: `own` returns its opener while it shows instead of the code).
interface FindTarget { view: () => EditorView | null; readOnly: () => boolean; own?: () => (() => void) | null }
const targets = new Map<string, FindTarget>();

export function registerFindTarget(key: string, target: FindTarget): () => void {
  targets.set(key, target);
  return () => { if (targets.get(key) === target) targets.delete(key); };
}

/** What the tab in front offers: find, and replace when editable; null without a text editor. */
export function activeFindTarget(): { readOnly: boolean } | null {
  const key = useApp.getState().activeKey();
  const target = key ? targets.get(key) : undefined;
  if (target?.own?.()) return { readOnly: true };
  return target?.view() ? { readOnly: target.readOnly() } : null;
}

/** Find (or Find and Replace) in the tab in front; false when it has no text editor. */
export function findInActiveTab(withReplace: boolean): boolean {
  const key = useApp.getState().activeKey();
  const target = key ? targets.get(key) : undefined;
  const own = target?.own?.();
  if (own) { own(); return true; }
  const view = target?.view();
  if (!view) return false;
  view.focus();
  return openFind(view, withReplace);
}
