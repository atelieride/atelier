// The Markdown preview: the buffer rendered as React elements from a sanitized tree, with the
// outline, git change bars, find, the context menu and scroll sync with the editor (Split).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime, type Components } from 'hast-util-to-jsx-runtime';
import { MAX_PREVIEW_CHARS, outlineOf, plainText, renderMarkdown } from './render';
import { blockMarks, currentHeading, lineAtOffset, offsetOfLine, parseSrc, spanOf, type BlockGeo, type BlockMark } from './blocks';
import { readingStats, statusTone } from './text';
import { gutterMarks } from '../editor/linediff';
import { changePosition, stepChange } from '../editor/change-nav';
import { Ctx, MdCode, MdDiv, MdImage, MdInput, MdLink, MdTable, heading, type PreviewCtx } from './parts';
import { PreviewFind } from './PreviewFind';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { mentionInSession, previewMenu } from '../menus';
import { copyText } from '../clipboard';
import { sizeLabel } from '../scm/detail';
import { isUntitled } from '../untitled';
import { isSourceControlKey } from '@shared/keys';
import type { LineRange } from '../mention';

/** What the file view asks of its preview (scroll sync, Go › Next Change, find, ⌘⌥C). */
export interface PreviewHandle {
  openFind(): void;
  goChange(dir: 1 | -1): boolean;
  changes(): { count: number; at: number };
  scrollToLine(line: number): void;
  selection(): LineRange | null;
  focus(): void;
}

const COMPONENTS = {
  a: MdLink, img: MdImage, pre: MdCode, div: MdDiv, input: MdInput, table: MdTable,
  h1: heading('h1'), h2: heading('h2'), h3: heading('h3'), h4: heading('h4'), h5: heading('h5'), h6: heading('h6')
} as unknown as Partial<Components>;

/** The reading line sits this far below the top of the page (outline, change navigation). */
const READ_OFFSET = 80;
const ROW = 28;

type Geo = BlockGeo & { el: HTMLElement };
interface Bar { top: number; height: number; mark: BlockMark }

const reducedMotion = () => document.documentElement.dataset.motion === 'reduced' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function MarkdownPreview(p: {
  path: string;
  text: string;
  split: boolean;
  visible: boolean;
  nonce: number;
  /** The HEAD text the margin marks compare against (null: no marks). */
  base: string | null;
  /** Split: the editor's cursor line, tinted here. */
  cursorLine: number | null;
  handle: MutableRefObject<PreviewHandle | null>;
  onShowSource: (line: number) => void;
  onComment: (range: LineRange) => void;
  /** Split: the page scrolled by the user (the editor follows). */
  onScrollLine: (line: number) => void;
  /** The change counter may have moved. */
  onNav: () => void;
  /** Words and reading minutes of the page, for the footer. */
  onStats: (s: { words: number; minutes: number }) => void;
  onTogglePreview: () => void;
  onSourceView: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const geoRef = useRef<Geo[]>([]);
  const marksRef = useRef<BlockMark[]>([]);
  const headEls = useRef<HTMLElement[]>([]);
  const quietUntil = useRef(0);
  // The scrollTop we set ourselves: its scroll event is ours, whenever it arrives (a time window alone loses under load).
  const ownTop = useRef<number | null>(null);
  const setTop = (box: HTMLElement, top: number) => { quietUntil.current = Date.now() + 120; box.scrollTop = top; ownTop.current = box.scrollTop; };
  const followEnd = useRef(false);
  const lastCursor = useRef<number | null>(null);
  const cursorMovedAt = useRef(0);
  const [bars, setBars] = useState<Bar[]>([]);
  const [active, setActive] = useState(0);
  const [progress, setProgress] = useState(0);
  const [find, setFind] = useState<{ nonce: number } | null>(null);
  const outlineOn = useApp((s) => s.settings.markdownOutline);
  const root = useApp((s) => s.project?.root ?? '/');

  const tooLarge = p.text.length > MAX_PREVIEW_CHARS;
  const rendered = useMemo(() => (tooLarge ? null : renderMarkdown(p.text)), [p.text, tooLarge]);
  const content = useMemo(() => (rendered ? toJsxRuntime(rendered.tree, { Fragment, jsx, jsxs, components: COMPONENTS, passNode: true }) : null), [rendered]);
  const outline = useMemo(() => (rendered ? outlineOf(rendered.tree) : []), [rendered]);
  const stats = useMemo(() => readingStats(rendered ? plainText(rendered.tree) : ''), [rendered]);
  useEffect(() => { p.onStats(stats); }, [stats]);
  const marks = useMemo(() => (p.base !== null && p.base !== p.text ? gutterMarks(p.base, p.text) : null), [p.base, p.text]);
  const sub = outline.some((h) => h.level === 2) ? 3 : 0;
  const showOutline = outlineOn && !p.split && outline.length >= 2;

  const scrollToAnchor = (id: string) => {
    const page = pageRef.current;
    const box = scrollRef.current;
    if (!page || !box) return;
    const q = (sel: string) => { try { return page.querySelector<HTMLElement>(sel); } catch { return null; } };
    const el = q(`[data-slug="${CSS.escape(id)}"]`) ?? q(`[id="${CSS.escape(`user-content-${id}`)}"]`) ?? q(`[id="${CSS.escape(id)}"]`);
    if (!el) return;
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 16;
    box.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' });
  };
  const ctx = useMemo<PreviewCtx>(() => ({ path: p.path, root, nonce: p.nonce, scrollToAnchor }), [p.path, root, p.nonce]);

  // Blocks, their boxes and the change bars: after every render of the page and when its size changes.
  const measure = () => {
    const page = pageRef.current;
    const box = scrollRef.current;
    if (!page || !box) return;
    const origin = box.getBoundingClientRect().top - box.scrollTop;
    const geo: Geo[] = [];
    for (const el of page.querySelectorAll<HTMLElement>('[data-src]')) {
      if (el.querySelector('[data-src]')) continue;
      const r = parseSrc(el.dataset.src);
      if (!r) continue;
      const b = el.getBoundingClientRect();
      geo.push({ ...r, top: b.top - origin, height: b.height, el });
    }
    geoRef.current = geo;
    marksRef.current = blockMarks(geo, marks);
    const pageTop = page.getBoundingClientRect().top - origin;
    setBars(geo.flatMap((g, i) => { const m = marksRef.current[i]!; return m.bar || m.removedBefore ? [{ top: g.top - pageTop, height: g.height, mark: m }] : []; }));
    headEls.current = outline.map((h) => page.querySelector<HTMLElement>(`[data-slug="${CSS.escape(h.slug)}"]`)).filter((e): e is HTMLElement => !!e);
    if (p.split && followEnd.current) setTop(box, box.scrollHeight);
    onScroll(true);
  };
  const measureRef = useRef(measure);
  measureRef.current = measure;
  useLayoutEffect(() => { if (p.visible) measure(); }, [content, marks, p.visible, showOutline]);
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    let frame = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => measureRef.current()); });
    ro.observe(page);
    return () => { ro.disconnect(); cancelAnimationFrame(frame); };
  }, [tooLarge]);

  // One frame for the user's scroll, one for re-measuring: a resize in the same frame doesn't swallow a scroll.
  const frames = useRef({ user: 0, measure: 0 });
  function onScroll(fromMeasure = false) {
    // Scrolled by hand away from the end: stop following it now, before a re-measure in the next frame snaps back.
    const el = scrollRef.current;
    if (!fromMeasure && el && (ownTop.current === null || Math.abs(el.scrollTop - ownTop.current) >= 2) && el.scrollTop < el.scrollHeight - el.clientHeight - 2) followEnd.current = false;
    const which = fromMeasure ? 'measure' : 'user';
    cancelAnimationFrame(frames.current[which]);
    frames.current[which] = requestAnimationFrame(() => {
      const box = scrollRef.current;
      if (!box) return;
      const origin = box.getBoundingClientRect().top - box.scrollTop;
      const tops = headEls.current.map((el) => el.getBoundingClientRect().top - origin);
      const room = box.scrollHeight - box.clientHeight;
      // At the bottom the last headings can't reach the reading line: the last one in view is the current one.
      const atEnd = room > 0 && box.scrollTop >= room - 2;
      const inView = tops.reduce((at, top, i) => (top < box.scrollTop + box.clientHeight - 40 ? i : at), -1);
      setActive(Math.max(0, atEnd ? inView : currentHeading(tops, box.scrollTop, READ_OFFSET)));
      setProgress(room > 0 ? Math.round((box.scrollTop / room) * 100) : 100);
      // At the end, the editor goes to its end too (the two can't be the same height); scrolled up by hand, the page
      // stops following the end.
      const ours = ownTop.current !== null && Math.abs(box.scrollTop - ownTop.current) < 2;
      if (!fromMeasure && ours) ownTop.current = null;
      if (!fromMeasure && p.split && !ours && Date.now() > quietUntil.current) {
        if (!atEnd) followEnd.current = false;
        p.onScrollLine(atEnd ? Infinity : lineAtOffset(geoRef.current, box.scrollTop));
      }
      p.onNav();
    });
  }

  // Split: the block under the editor's cursor is tinted.
  useEffect(() => {
    const geo = geoRef.current;
    for (const g of geo) g.el.classList.remove('is-cursor');
    if (!p.split || p.cursorLine === null) return;
    const line = p.cursorLine;
    const hit = geo.find((g) => line >= g.start && line <= g.end);
    hit?.el.classList.add('is-cursor');
    // Typing or moving the cursor keeps its block (or the one just above a blank line) in view; a page that changed
    // without the cursor moving (Claude wrote the file) stays where the reader is.
    const moved = line !== lastCursor.current;
    if (moved) { lastCursor.current = line; cursorMovedAt.current = Date.now(); }
    if (!moved && Date.now() - cursorMovedAt.current > 1000) return;
    const near = hit ?? [...geo].reverse().find((g) => g.start <= line);
    const box = scrollRef.current;
    if (!near || !box) return;
    const r = near.el.getBoundingClientRect();
    const view = box.getBoundingClientRect();
    if (r.bottom > view.bottom - 16 || r.top < view.top) {
      setTop(box, box.scrollTop + (r.bottom > view.bottom - 16 ? r.bottom - view.bottom + 48 : r.top - view.top - 48));
    }
  }, [p.cursorLine, p.split, content]);

  const changeStarts = () => [...new Set(geoRef.current.filter((_, i) => marksRef.current[i]?.bar || marksRef.current[i]?.removedBefore).map((g) => g.start))];
  const readingLine = () => Math.floor(lineAtOffset(geoRef.current, (scrollRef.current?.scrollTop ?? 0) + 24));

  const selection = (): LineRange | null => {
    const sel = window.getSelection();
    const page = pageRef.current;
    if (!sel || sel.isCollapsed || !sel.rangeCount || !page || !sel.anchorNode || !sel.focusNode || !page.contains(sel.anchorNode) || !page.contains(sel.focusNode)) return null;
    // The blocks the selection really covers: a triple-click ends at the very start of the next block, which isn't in.
    const r = sel.getRangeAt(0);
    const covered = geoRef.current.filter((g) => {
      const inner = document.createRange();
      inner.selectNodeContents(g.el);
      return r.compareBoundaryPoints(Range.START_TO_END, inner) > 0 && r.compareBoundaryPoints(Range.END_TO_START, inner) < 0;
    });
    if (covered.length) return spanOf(covered);
    const blockOf = (n: Node) => parseSrc((n instanceof HTMLElement ? n : n.parentElement)?.closest<HTMLElement>('[data-src]')?.dataset.src);
    return spanOf([blockOf(sel.anchorNode), blockOf(sel.focusNode)]);
  };
  const selectAll = () => { const page = pageRef.current; if (page) window.getSelection()?.selectAllChildren(page); };
  const openFind = () => setFind((f) => ({ nonce: (f?.nonce ?? 0) + 1 }));
  const mention = () => { if (!isUntitled(p.path)) mentionInSession(p.path, selection()); else useApp.getState().showToast(t.untitledMention, undefined, 'info'); };

  p.handle.current = {
    openFind,
    goChange: (dir) => {
      const starts = changeStarts();
      const n = stepChange(starts, readingLine(), dir);
      const g = n === null ? undefined : geoRef.current.find((x) => x.start === n);
      const box = scrollRef.current;
      if (!g || !box) return false;
      box.scrollTo({ top: g.top - 24, behavior: 'auto' });
      g.el.classList.remove('md-flash');
      void g.el.offsetWidth;
      g.el.classList.add('md-flash');
      return true;
    },
    changes: () => {
      const starts = changeStarts();
      return { count: starts.length, at: changePosition(starts, readingLine()) };
    },
    scrollToLine: (line) => {
      const box = scrollRef.current;
      if (!box) return;
      // Infinity: the editor is at its end, so is the page (and stays there as typing at the end makes it grow).
      followEnd.current = !Number.isFinite(line);
      setTop(box, followEnd.current ? box.scrollHeight : offsetOfLine(geoRef.current, line));
    },
    selection,
    focus: () => scrollRef.current?.focus({ preventScroll: true })
  };

  const fm = rendered?.frontMatter ?? null;
  const fill: CSSProperties = { height: Math.max(0, active) * ROW };
  return (
    <section className={`md-preview${p.split ? ' is-split' : ''}${find ? ' has-find' : ''}`} aria-label={t.md.preview}>
      {tooLarge && (
        <div className="md-band" role="status">
          <span className="md-band-dot" />
          <span>{t.md.tooLarge(sizeLabel(new Blob([p.text]).size))}</span>
          <span className="grow" />
          <button type="button" className="btn-primary sm" onClick={p.onSourceView}>{t.md.showSource}</button>
        </div>
      )}
      <div ref={scrollRef} className="md-scroll" tabIndex={0} onScroll={() => onScroll()}
        onKeyDown={(e) => {
          const mod = e.metaKey || e.ctrlKey;
          const k = e.key.toLowerCase();
          if (mod && !e.altKey && k === 'f') { e.preventDefault(); openFind(); }
          else if (mod && !e.altKey && !e.shiftKey && k === 'l') { e.preventDefault(); mention(); }
          else if (mod && !e.altKey && !e.shiftKey && k === 'a') { e.preventDefault(); selectAll(); }
          else if (mod && !e.altKey && k === 'g' && !find && !isSourceControlKey(e)) { e.preventDefault(); openFind(); }
        }}
        onDoubleClick={(e) => {
          if (!e.altKey) return;
          const at = parseSrc((e.target as HTMLElement).closest<HTMLElement>('[data-src]')?.dataset.src);
          if (at) { window.getSelection()?.removeAllRanges(); p.onShowSource(at.start); }
        }}
        onContextMenu={(e) => {
          const at = parseSrc((e.target as HTMLElement).closest<HTMLElement>('[data-src]')?.dataset.src);
          const sel = selection();
          const selText = window.getSelection()?.toString() ?? '';
          const untitled = isUntitled(p.path);
          useApp.getState().openMenu(e, previewMenu(p.path, {
            copy: selText ? () => void copyText(selText) : null,
            copyMarkdown: sel ? () => void copyText(p.text.split('\n').slice(sel.start - 1, sel.end).join('\n')).then((ok) => { if (ok) useApp.getState().showToast(t.md.copiedMarkdown, undefined, 'info'); }) : null,
            selectAll,
            find: openFind,
            showSource: at ? { line: at.start, run: () => p.onShowSource(at.start) } : null,
            mentionLines: sel && !untitled ? () => mentionInSession(p.path, sel) : null,
            commentLines: sel && !untitled ? () => p.onComment(sel) : null,
            togglePreview: p.onTogglePreview
          }));
        }}>
        {rendered && (
          <div className={`md-page${showOutline ? ' has-outline' : ''}`}>
            <Ctx.Provider value={ctx}>
              <article ref={pageRef} className="md-article">
                {fm && (fm.pairs ? (
                  <div className="md-front" data-src={`${fm.start}-${fm.end}`}>
                    {fm.pairs.map((x, i) => {
                      const tone = statusTone(x.key, x.value);
                      return <span key={i} className={`md-pill${tone ? ` is-${tone}` : ''}`}><span className="md-pill-key">{x.key}</span><span className="md-pill-value">{x.value}</span></span>;
                    })}
                  </div>
                ) : (
                  <details className="md-front-raw" data-src={`${fm.start}-${fm.end}`}>
                    <summary>{t.md.frontMatter}</summary>
                    <pre className="mono">{fm.raw}</pre>
                  </details>
                ))}
                {content}
                {!p.text.trim() && <p className="md-empty">{t.md.empty}</p>}
                {rendered.dropped.length > 0 && (
                  <div className="md-dropped" data-nofind=""><Icon name="code" size={12} />{t.md.dropped(rendered.droppedCount, rendered.dropped.join(', '))}</div>
                )}
                <div className="md-bars" aria-hidden="true">
                  {bars.map((b, i) => (
                    <span key={i} className="md-bar-slot" style={{ top: b.top, height: b.height }}>
                      {b.mark.bar && <i className={`md-bar is-${b.mark.bar}`} />}
                      {b.mark.removedBefore && <i className="md-wedge" />}
                    </span>
                  ))}
                </div>
              </article>
            </Ctx.Provider>
            {showOutline && (
              <aside className="md-outline" aria-label={t.md.outline}>
                <nav className="md-toc">
                  <div className="md-toc-head">
                    <Icon name="outline" size={13} stroke={1.7} />
                    <span className="md-toc-title">{t.md.outline}</span>
                    <span className="grow" />
                    <span className="mono md-toc-pct" aria-label={t.md.progress(progress)}>{progress}%</span>
                  </div>
                  <div className="md-toc-progress" aria-hidden="true"><i style={{ width: `${progress}%` }} /></div>
                  <div className="md-toc-list">
                    <div className="md-toc-rows">
                    <i className="md-toc-track" aria-hidden="true" />
                    <i className="md-toc-fill" style={fill} aria-hidden="true" />
                    {outline.map((h, i) => (
                      <button key={`${h.slug}-${i}`} type="button" aria-current={i === active ? 'location' : undefined}
                        className={`md-toc-row${h.level === sub ? ' is-sub' : ''}${i === active ? ' is-on' : i < active ? ' is-read' : ''}`}
                        onClick={() => { setActive(i); scrollToAnchor(h.slug); }}>
                        <span className="md-toc-dot-box"><span className="md-toc-dot" /></span>
                        <span className="md-toc-text">{h.text}</span>
                      </button>
                    ))}
                    </div>
                  </div>
                  <div className="md-toc-foot">
                    <span className="mono">{t.md.words(stats.words, stats.minutes)}</span>
                    <button type="button" className="md-toc-top" onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' })}>
                      <Icon name="arrowUp" size={11} stroke={1.9} />{t.md.top}
                    </button>
                  </div>
                </nav>
              </aside>
            )}
          </div>
        )}
      </div>
      {find && <PreviewFind page={pageRef} scroller={scrollRef} version={content} nonce={find.nonce} onClose={() => { setFind(null); scrollRef.current?.focus({ preventScroll: true }); }} />}
    </section>
  );
}
