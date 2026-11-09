import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { backgroundSections, backgroundSummary, commandOf, exitedIds, exitsKey, inspectorTarget, parseExits, type BgRow } from '../background-view';
import { placePopover } from '../popover-place';
import { useApp } from '../store';
import { t } from '../i18n/en';
import { Icon } from './Icon';
import { BG_GLYPH, bgOpener, focusableFor, scrollClosesPopover, skipFocusReturn, takeSkipFocusReturn } from './bg-shared';
import { copyText } from '../clipboard';
import { kbd } from '../kbd';

const WIDTH = 400;

/** Focus back to the chip, or (the sidebar chip is not focusable) to its row's button, if still in the page. */
function returnFocus() {
  const chip = bgOpener();
  if (!chip?.isConnected) return;
  focusableFor(chip)?.focus();
}

/**
 * The Background popover: what a session runs, from its chips. Rows open the
 * Background tab beside the session (⌥: here). Reads only the terminal list: no file is read for it.
 */
export function BackgroundPopover() {
  const pop = useApp((s) => s.bgPopover);
  const term = useApp((s) => (pop ? s.terminals.find((x) => x.id === pop.terminalId) : undefined));
  // Items whose exit code a followed output already gave (no file is read for this: the store has it).
  const exitedKey = useApp((s) => (pop ? exitsKey(exitedIds(s.bgFeeds, pop.terminalId)) : ''));
  const [now, setNow] = useState(Date.now());
  const [recentOpen, setRecentOpen] = useState(false);
  const [view, setView] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const focusInside = useRef(false);
  // The clock is set again at every opening, before the paint: the times never show the last opening's (or the mount's).
  useLayoutEffect(() => {
    if (!pop) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pop]);
  useEffect(() => { if (pop && !term?.session) useApp.getState().closeBgPopover(); }, [pop, term]);
  // Recent starts collapsed at every opening.
  useEffect(() => { setRecentOpen(false); }, [pop]);

  const exited = parseExits(exitedKey);
  const sections = pop && term ? backgroundSections(term, now, exited) : [];
  const rowCount = sections.reduce((n, s) => n + (s.key === 'recent' && !recentOpen ? 0 : s.rows.length), 0) + sections.length;

  // Placement: measured without the previous maxHeight and written straight to the element (visible), so the
  // focus below lands on a visible element; again when the window resizes or the rows change.
  useLayoutEffect(() => {
    const el = box.current;
    if (!pop || !el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    el.style.maxHeight = '';
    el.style.width = `${Math.min(WIDTH, vw - 16)}px`;
    const p = placePopover(pop.anchor, pop.side, { width: WIDTH, height: el.scrollHeight }, { width: vw, height: vh });
    el.style.left = `${p.left}px`;
    el.style.top = `${p.top}px`;
    el.style.width = `${p.width}px`;
    el.style.maxHeight = `${p.maxHeight}px`;
    el.style.visibility = 'visible';
  }, [pop, rowCount, view]);
  useEffect(() => {
    const first = pop?.section === 'scheduled' ? box.current?.querySelector<HTMLElement>('[data-section="scheduled"] .bgp-row') : box.current?.querySelector<HTMLElement>('.bgp-row');
    (first ?? box.current?.querySelector<HTMLElement>('.bgp-open'))?.focus();
  }, [pop]);
  useEffect(() => {
    if (!pop) return;
    const resize = () => setView((n) => n + 1);
    const scroll = (e: Event) => {
      if (box.current?.contains(e.target as Node)) return;
      if (scrollClosesPopover(e.target, bgOpener(), e.target === document)) useApp.getState().closeBgPopover();
    };
    const down = (e: MouseEvent) => {
      const target = e.target as Node;
      // The chip toggles it itself; the context menu of a row belongs to the popover.
      const chip = bgOpener();
      if (box.current && !box.current.contains(target) && !(chip && chip.contains(target)) && !(target as Element).closest?.('.ctx-menu')) useApp.getState().closeBgPopover();
    };
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('mousedown', down, true);
    return () => { window.removeEventListener('resize', resize); window.removeEventListener('scroll', scroll, true); window.removeEventListener('mousedown', down, true); };
  }, [pop]);
  // Closed (outside click, a row opening the tab…) with the focus inside: it goes back to its chip, if still there.
  useEffect(() => {
    if (pop) return;
    // Not when a row or the inspector button opened the tab: the new tab keeps the focus.
    const skip = takeSkipFocusReturn();
    if (!focusInside.current) return;
    focusInside.current = false;
    if (!skip) returnFocus();
  }, [pop]);
  if (!pop || !term) return null;
  const close = () => { useApp.getState().closeBgPopover(); };
  const open = (row: BgRow, here: boolean) => { skipFocusReturn(); useApp.getState().openBackground({ terminalId: term.id, itemId: row.id, here }); };
  const onKey = (e: KeyboardEvent) => {
    const rows = [...(box.current?.querySelectorAll<HTMLElement>('.bgp-row') ?? [])];
    const i = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); rows[Math.min(rows.length - 1, i + 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); rows[Math.max(0, i - 1)]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); returnFocus(); }
    else if (e.key === 'Tab') {
      // The popover is a dialog: Tab wraps inside it.
      const all = [...(box.current?.querySelectorAll<HTMLElement>('button') ?? [])];
      const at = all.indexOf(document.activeElement as HTMLElement);
      if (all.length === 0) return;
      if (!e.shiftKey && at === all.length - 1) { e.preventDefault(); all[0]!.focus(); }
      else if (e.shiftKey && at <= 0) { e.preventDefault(); all[all.length - 1]!.focus(); }
    }
  };
  return createPortal(
    <div ref={box} className="bg-popover" role="dialog" aria-label={t.bg.title} style={{ visibility: 'hidden' }} onKeyDown={onKey}
      onFocus={() => { focusInside.current = true; }}
      onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node | null)) focusInside.current = false; }}>
      <div className="bgp-head">
        <span className="bgp-title">{t.bg.title}</span>
        <span className="bgp-summary">{backgroundSummary(term, exited) ?? ''}</span>
        <span className="bgp-grow" />
        <button type="button" className="bgp-open" onClick={() => { skipFocusReturn(); useApp.getState().openBackground({ terminalId: term.id, itemId: inspectorTarget(term, exited) }); }}>
          {t.bg.openInspector} <span className="mono">{kbd('⌘⌥B')}</span>
        </button>
      </div>
      <div className="bgp-body">
        {sections.length === 0 && <div className="bgp-empty">{t.bg.empty}</div>}
        {sections.map((s) => {
          const folded = s.key === 'recent' && !recentOpen;
          return (
            <div key={s.key} data-section={s.key} className={`bgp-section ${s.key === 'recent' ? 'is-recent' : ''}`}>
              {s.key === 'recent' ? (
                <button type="button" className="bgp-label bgp-fold" aria-expanded={!folded} onClick={() => setRecentOpen((v) => !v)}>
                  <Icon name={folded ? 'chevron' : 'chevronDown'} size={11} stroke={2} />{s.title}<span className="bgp-count mono">{s.rows.length}</span>
                </button>
              ) : <div className="bgp-label">{s.title}</div>}
              {!folded && s.rows.map((r) => (
                <button key={r.id} type="button" className={`bgp-row st-${r.state} depth-${r.depth}`}
                  onClick={(e) => open(r, e.altKey)}
                  onContextMenu={(e) => {
                    // Copy Command only when there is one (a recent shell keeps its own; a monitor may have none).
                    const display = commandOf(term, r.id);
                    useApp.getState().openMenu(e, [
                      { id: 'beside', label: t.bg.openBeside, run: () => open(r, false) },
                      { id: 'here', label: t.bg.openHere, run: () => open(r, true) },
                      ...(display ? [{ id: 'copy', label: t.bg.copyCommand, run: () => void copyText(display) }] : [])
                    ]);
                  }}>
                  {r.depth === 1 && <span className="bgp-nest mono" aria-hidden="true">└</span>}
                  <span className={`bgp-icon k-${r.kind}`}><Icon name={BG_GLYPH[r.kind]} size={14} stroke={1.8} /></span>
                  <span className="bgp-main">
                    <span className="bgp-line">
                      <span className="bgp-name">{r.label}</span>
                      {r.ports?.map((p) => <span key={p} className="bgp-port mono">:{p}</span>)}
                      {r.state === 'server' && <span className="bgp-note">{t.bg.server}</span>}
                      {r.state === 'watcher' && <span className="bgp-note">{t.bg.watcher}</span>}
                      <span className="bgp-grow" />
                      <span className="bgp-time mono">{r.elapsed}</span>
                    </span>
                    {r.sub && <span className={`bgp-sub ${r.kind === 'shell' || r.kind === 'monitor' ? 'mono' : ''}`}>{r.sub}</span>}
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div className="bgp-foot">
        <span><span className="mono">↑↓</span> {t.bg.hintMove}</span><span><span className="mono">↵</span> {t.bg.hintOpen}</span><span><span className="mono">esc</span> {t.bg.hintClose}</span>
      </div>
    </div>,
    document.body
  );
}
