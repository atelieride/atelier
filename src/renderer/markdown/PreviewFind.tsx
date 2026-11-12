// ⌘F in the Markdown preview: the editor's find card (read-only variant) over the rendered
// text; matches are painted with the CSS Highlight API, so the page itself never re-renders for them.
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { FindCard } from '../editor/find/FindCard';
import { lastFindSpec, rememberFindQuery } from '../editor/find/find-ext';
import { regexError, type FindAction, type FindSpec } from '../editor/find/find-logic';
import { findInText, nextIndex } from './find-text';
import { isSourceControlKey } from '@shared/keys';
import { searchAllFrom } from '../search/open';
import { useApp } from '../store';

const EMPTY: FindSpec = { search: '', caseSensitive: false, wholeWord: false, regexp: false, replace: '' };
const ALL = 'md-find';
const CURRENT = 'md-find-current';

interface TextMap { text: string; nodes: Text[]; starts: number[] }

/** The page's text nodes (code-block headers, heading anchors and link arrows left out), end to end. */
function textMap(root: HTMLElement): TextMap {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('[data-nofind]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  });
  const nodes: Text[] = []; const starts: number[] = []; let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { starts.push(text.length); nodes.push(n as Text); text += (n as Text).data; }
  return { text, nodes, starts };
}

function point(map: TextMap, offset: number): [Text, number] {
  let lo = 0; let hi = map.starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (map.starts[mid]! <= offset) lo = mid; else hi = mid - 1; }
  return [map.nodes[lo]!, offset - map.starts[lo]!];
}

function rangeOf(map: TextMap, from: number, to: number): Range {
  const r = document.createRange();
  const [a, ao] = point(map, from);
  const [b, bo] = point(map, to - 1);
  r.setStart(a, ao);
  r.setEnd(b, bo + 1);
  return r;
}

const highlights = () => (typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null);
function clearPaint() { highlights()?.delete(ALL); highlights()?.delete(CURRENT); }

export function PreviewFind({ page, scroller, version, nonce, onClose }: {
  page: RefObject<HTMLElement | null>;
  scroller: RefObject<HTMLElement | null>;
  /** Bumped when the rendered page changes: matches are found again. */
  version: unknown;
  /** Bumped by ⌘F: the keyboard goes back to the field. */
  nonce: number;
  onClose: () => void;
}) {
  const [spec, setSpec] = useState<FindSpec>(() => ({ ...EMPTY, ...lastFindSpec(), replace: '' }));
  const popout = useApp((s) => s.popout !== null);
  const [focus, setFocus] = useState({ field: 'find' as const, nonce: 0 });
  const [found, setFound] = useState<{ ranges: Range[]; capped: boolean; valid: boolean }>({ ranges: [], capped: false, valid: true });
  const [index, setIndex] = useState(-1);
  // ⌘F with a short selection in the page: it becomes the query (as in the editor).
  useLayoutEffect(() => {
    const sel = window.getSelection();
    const text = sel?.toString() ?? '';
    if (text && !text.includes('\n') && text.length <= 100 && sel?.anchorNode && page.current?.contains(sel.anchorNode)) setSpec((s) => ({ ...s, search: text }));
    setFocus((f) => ({ field: 'find', nonce: f.nonce + 1 }));
  }, [nonce]);

  useEffect(() => {
    const root = page.current;
    if (!root) return;
    const map = textMap(root);
    const r = findInText(map.text, spec);
    const ranges = r.ranges.map((m) => rangeOf(map, m.from, m.to));
    setFound({ ranges, capped: r.capped, valid: r.valid });
    // The first match at or after the top of the view.
    const top = scroller.current?.getBoundingClientRect().top ?? 0;
    const at = ranges.findIndex((x) => x.getBoundingClientRect().top >= top);
    setIndex(ranges.length ? Math.max(0, at) : -1);
    rememberFindQuery(spec);
  }, [spec, version]);

  useEffect(() => {
    const h = highlights();
    if (!h) return;
    h.set(ALL, new Highlight(...found.ranges));
    const cur = found.ranges[index];
    if (cur) h.set(CURRENT, new Highlight(cur)); else h.delete(CURRENT);
  }, [found, index]);
  useEffect(() => clearPaint, []);

  const reveal = (i: number) => {
    const r = found.ranges[i];
    const box = scroller.current;
    if (!r || !box) return;
    const rect = r.getBoundingClientRect();
    const view = box.getBoundingClientRect();
    if (rect.top < view.top + 60 || rect.bottom > view.bottom - 20) box.scrollTop += rect.top - view.top - view.height / 2;
  };

  const act = (a: FindAction) => {
    if (a === 'close') { clearPaint(); onClose(); return; }
    if (a === 'next' || a === 'prev') { const i = nextIndex(index, found.ranges.length, a === 'next' ? 1 : -1); setIndex(i); reveal(i); return; }
    if (a === 'toggleCase') setSpec((s) => ({ ...s, caseSensitive: !s.caseSensitive }));
    if (a === 'toggleWord') setSpec((s) => ({ ...s, wholeWord: !s.wholeWord }));
    if (a === 'toggleRegex') setSpec((s) => ({ ...s, regexp: !s.regexp }));
  };

  return (
    <div className="md-find-layer">
      <FindCard
        spec={spec}
        valid={found.valid || !spec.search}
        regexError={spec.regexp && spec.search && !found.valid ? regexError(spec.search) : null}
        count={{ total: found.ranges.length, capped: found.capped, index }}
        quiet={false}
        readOnly
        replaceOpen={false}
        focus={focus}
        onSpec={(patch) => setSpec((s) => ({ ...s, ...patch }))}
        onAction={act}
        onToggleReplace={() => {}}
        onOtherKey={(e) => {
          // ⇧⌘F is Find in Files' (the menu's), with this card's query.
          if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'f') { setFocus((f) => ({ field: 'find', nonce: f.nonce + 1 })); return true; }
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g' && !isSourceControlKey(e)) { act(e.shiftKey ? 'prev' : 'next'); return true; }
          return false;
        }}
        // A pop-out has no sidebar to search in.
        onSearchAll={popout ? undefined : () => searchAllFrom(spec)}
      />
    </div>
  );
}
