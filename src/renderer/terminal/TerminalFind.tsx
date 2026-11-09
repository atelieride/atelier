// Find in the terminal: the editor's find card (read-only, ↵ going up) over xterm's
// search addon. The addon searches the active buffer (screen and scrollback), highlights up to FIND_LIMIT matches,
// selects the current one and searches again by itself 200 ms after output; this card owns the query and the counter,
// and the addon itself: made on first use, released when the card closes, while its tab is hidden and while the user
// works with a selection of their own in the terminal (the addon's next search would take it back).
import { useEffect, useLayoutEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import type { IBufferRange } from '@xterm/xterm';
import { FindCard } from '../editor/find/FindCard';
import { lastFindSpec, rememberFindQuery } from '../editor/find/find-ext';
import { regexError, type FindAction, type FindSpec, type MatchCount } from '../editor/find/find-logic';
import { isMod, isSourceControlKey } from '@shared/keys';
import { terminalTheme } from '@shared/themes';
import { useApp } from '../store';
import { t } from '../i18n/en';
import { peekLiveTerminal, type LiveTerminal } from './registry';
import { FIND_LIMIT, continuesQuery, findCount, findNote, regexCompiles, selectionQuery, terminalFindColors } from './find';
import { wheelLines } from './wheel';

const EMPTY: FindSpec = { search: '', caseSensitive: false, wholeWord: false, regexp: false, replace: '' };
const NONE: MatchCount = { total: 0, capped: false, index: -1 };

const samePlace = (a: IBufferRange | undefined, b: IBufferRange | undefined) =>
  !!a && !!b && a.start.x === b.start.x && a.start.y === b.start.y && a.end.x === b.end.x && a.end.y === b.end.y;

/** A selection of the user's as the query; the match Find left selected (lt.findMatch) is never one. */
function userSelectionQuery(lt: LiveTerminal, base: FindSpec): FindSpec | null {
  if (!lt.term.hasSelection() || samePlace(lt.term.getSelectionPosition(), lt.findMatch)) return null;
  return selectionQuery(lt.term.getSelection(), base);
}

interface Props {
  id: string;
  /** Bumped by every request to open it (⌘F, the context menu, the palette): the keyboard goes back to the field. */
  nonce: number;
  /** Its terminal is on screen: a hidden one's search rests. */
  visible: boolean;
  onClose: () => void;
}

/** Nothing for a terminal that has just ended (its view goes with the next list); never makes it a new xterm. */
export function TerminalFind(p: Props) {
  const lt = peekLiveTerminal(p.id);
  return lt ? <Card lt={lt} {...p} /> : null;
}

function Card({ lt, nonce, visible, onClose }: Props & { lt: LiveTerminal }) {
  const { term } = lt;
  const theme = useApp((s) => terminalTheme(s.settings.theme, s.settings.terminalColors));
  const colors = terminalFindColors(theme);
  // The first query is there before the first search, so that search starts at the very occurrence the user selected.
  const [spec, setSpec] = useState<FindSpec>(() => {
    const base = { ...EMPTY, ...lastFindSpec(), replace: '' };
    return userSelectionQuery(lt, base) ?? base;
  });
  const [focus, setFocus] = useState({ field: 'find' as const, nonce: 0 });
  const [count, setCount] = useState<MatchCount>(NONE);
  const [alt, setAlt] = useState(() => term.buffer.active.type === 'alternate');
  // The user made a selection in the terminal with the card open: the search rests until the card is used again.
  const [resting, setResting] = useState(false);
  const opened = useRef(nonce);
  // The query last searched: one typed on from it keeps the current match in place, any other starts from the newest.
  const searched = useRef<string | null>(spec.search || null);
  const addon = useRef<SearchAddon | null>(null);
  const wheelRest = useRef(0);
  // As the addon compiles it (laxer than the editor's check); a pattern it can't compile is never handed to it.
  const invalid = spec.regexp && !!spec.search && !regexCompiles(spec.search);
  const active = visible && !resting;

  const ensure = (): SearchAddon => {
    if (!addon.current) {
      const a = new SearchAddon({ highlightLimit: FIND_LIMIT });
      term.loadAddon(a);
      a.onDidChangeResults((e) => {
        setCount(findCount(e));
        lt.findMatch = term.getSelectionPosition();
      });
      addon.current = a;
    }
    return addon.current;
  };
  // Disposing (not only clearing) also cancels the addon's pending search, which would clear the selection.
  const release = () => {
    addon.current?.dispose();
    addon.current = null;
  };

  // A later request: a selection of the user's becomes the query (the first one is read by useState above).
  useLayoutEffect(() => {
    if (nonce !== opened.current) {
      const q = userSelectionQuery(lt, spec);
      if (q) setSpec(q);
    }
    setResting(false);
    setFocus((f) => ({ field: 'find', nonce: f.nonce + 1 }));
  }, [nonce]);

  const options = (): ISearchOptions => ({ caseSensitive: spec.caseSensitive, wholeWord: spec.wholeWord, regex: spec.regexp, decorations: colors });

  useEffect(() => {
    const screen = term.buffer.onBufferChange((b) => setAlt(b.type === 'alternate'));
    // A press in the terminal that leaves a selection of the user's (a drag, a double-click): the search rests.
    const down = (e: MouseEvent) => {
      if (e.button !== 0) return;
      window.addEventListener('mouseup', () => setTimeout(() => {
        if (term.hasSelection() && !samePlace(term.getSelectionPosition(), lt.findMatch)) setResting(true);
      }, 0), { once: true, capture: true });
    };
    lt.host.addEventListener('mousedown', down, true);
    return () => {
      screen.dispose();
      lt.host.removeEventListener('mousedown', down, true);
      release();
    };
  }, [lt]);

  // A new query, new options, another screen or theme, the card back in use: searched again, newest first. The addon's
  // cache cleared, it keeps a match in place when that still matches; Find's own match is let go for a new query.
  useEffect(() => {
    if (!active || !spec.search || invalid) {
      release();
      if (active) { setCount(NONE); searched.current = null; }
      return;
    }
    const search = ensure();
    const sel = term.hasSelection() ? term.getSelectionPosition() : undefined;
    if (sel && samePlace(sel, lt.findMatch) && !continuesQuery(searched.current, spec.search)) term.clearSelection();
    search.clearDecorations();
    search.findPrevious(spec.search, options());
    searched.current = spec.search;
    rememberFindQuery(spec);
  }, [spec, alt, colors, active]);

  const act = (a: FindAction) => {
    if (a === 'close') { release(); onClose(); term.focus(); return; }
    if (a === 'prev' || a === 'next') {
      if (!spec.search || invalid) return;
      setResting(false);
      // Up is older output, down is newer.
      const search = ensure();
      if (a === 'prev') search.findPrevious(spec.search, options()); else search.findNext(spec.search, options());
      return;
    }
    if (a === 'toggleCase') setSpec((s) => ({ ...s, caseSensitive: !s.caseSensitive }));
    if (a === 'toggleWord') setSpec((s) => ({ ...s, wholeWord: !s.wholeWord }));
    if (a === 'toggleRegex') setSpec((s) => ({ ...s, regexp: !s.regexp }));
  };

  // The card sits over the terminal: the wheel over it still scrolls what is underneath (a full-screen program gets
  // its wheel events, one per line, as from the terminal itself: wheel.ts).
  const onWheel = (e: ReactWheelEvent) => {
    if (e.ctrlKey) return;
    const screen = term.element?.querySelector('.xterm-screen');
    const cell = screen && term.rows ? screen.clientHeight / term.rows : 0;
    const r = wheelLines(wheelRest.current, e.deltaY, e.deltaMode, cell, term.rows);
    wheelRest.current = r.rest;
    if (!r.lines) return;
    if (term.modes.mouseTrackingMode === 'none') { term.scrollLines(r.lines); return; }
    for (let i = 0; i < Math.abs(r.lines); i++) {
      screen?.dispatchEvent(new WheelEvent('wheel', { deltaY: Math.sign(r.lines), deltaMode: 1, clientX: e.clientX, clientY: e.clientY, bubbles: true, cancelable: true }));
    }
  };

  return (
    <div className="term-find-layer" onFocus={() => setResting(false)} onWheel={onWheel}>
      <FindCard
        spec={spec}
        valid={!invalid}
        regexError={invalid ? regexError(spec.search) ?? t.find.invalid : null}
        count={count}
        quiet={false}
        readOnly
        replaceOpen={false}
        focus={focus}
        enterUp
        note={findNote({ alt, capped: count.capped })}
        onSpec={(patch) => setSpec((s) => ({ ...s, ...patch }))}
        onAction={act}
        onToggleReplace={() => {}}
        onOtherKey={(e) => {
          if (!isMod(e) || e.altKey) return false;
          const key = e.key.toLowerCase();
          // ⌘F (Ctrl+F or Ctrl+Shift+F on Windows) again: the field's text selected.
          if (key === 'f') { setFocus((f) => ({ field: 'find', nonce: f.nonce + 1 })); return true; }
          // ⌘G is ↵ (up), ⇧⌘G is ⇧↵ (down).
          if (key === 'g' && !isSourceControlKey(e)) { act(e.shiftKey ? 'next' : 'prev'); return true; }
          return false;
        }}
      />
    </div>
  );
}
