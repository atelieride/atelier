import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { Binding } from '@shared/companion/types';
import { useApp } from '../../store';
import { dockMode } from '../../companion/model';
import { firstEntrance, placement } from '../../companion/view';
import { t } from '../../i18n/en';
import { ErrorBoundary } from '../ErrorBoundary';
import { AskPanel } from './AskPanel';

/**
 * Ask inside a session's pane: over the pane's whole body (`place`: its grid cell in a split),
 * it measures the pane and shows the panel docked at its right, the terminal's cell inset by the panel's width (the
 * store's askDock, read by the App: xterm is never moved or remounted, its ResizeObserver refits it), or as a sheet over
 * the dimmed terminal when docking would leave it under its minimum. Hosted by the pane, not the session bar, so it stays
 * after Claude exits.
 *
 * The mode lives in the store from open to close, so a host mounted again (its tab shown again, a split or unsplit)
 * starts from it and the terminal never takes another size on the way. Layout itself never insets a cell too narrow to
 * dock (layout.css, --ask-room), so a pane that just narrowed doesn't squeeze the terminal before this host says "sheet".
 */
export function AskHost({ terminalId, place }: { terminalId: string; place?: CSSProperties }) {
  const binding = useApp((s) => s.askOpen[terminalId] ?? null);
  return binding ? <OpenHost binding={binding} place={place} /> : null;
}

function OpenHost({ binding, place }: { binding: Binding; place?: CSSProperties }) {
  const id = binding.terminalId;
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  // Once a sheet (too narrow), a sheet until its dock button: room coming back never resizes the terminal by itself.
  const [held, setHeld] = useState(() => useApp.getState().askDock[id] === 'sheet');
  const measure = useRef<() => void>(() => {});
  measure.current = () => {
    const el = host.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    // A pane hidden for a moment measures 0: never a reason to turn into a sheet.
    if (w <= 0) return;
    setWidth(w);
    if (dockMode(w) === 'sheet') setHeld(true);
  };
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measure.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Its cell moved or changed (a split, an unsplit, panes reordered): measured again before the browser paints.
  const cell = `${place?.gridColumn ?? ''}|${place?.gridRow ?? ''}`;
  useLayoutEffect(() => measure.current(), [cell]);
  const p = width === null ? null : placement(width, held);
  const mode = p?.mode ?? null;
  useLayoutEffect(() => { if (mode) useApp.getState().setAskDock(id, mode); }, [id, mode]);
  // Shown again (its tab back in front, a split, an unsplit): already there, so its entrance (the slide, the dim, each
  // item's) is finished before the first paint. What arrives later still enters; what loops (a caret) goes on.
  const settled = useRef(false);
  useLayoutEffect(() => {
    if (!mode || settled.current) return;
    settled.current = true;
    if (firstEntrance(id)) return;
    for (const a of host.current?.getAnimations({ subtree: true }) ?? []) {
      if (a.effect?.getComputedTiming().iterations === Infinity) continue;
      try { a.finish(); } catch { /* an animation that can't end stays as it is */ }
    }
  }, [mode]);
  return (
    <div ref={host} className={`ask-host${mode ? ` is-${mode}` : ''}`} style={place}>
      {mode === 'sheet' && <div className="ask-dim" aria-hidden="true" />}
      {/* A render error stays in the panel's place: the terminal beside it keeps working. */}
      {p && (
        <ErrorBoundary id="ask" panel={t.crashPanels.ask} frame={`ask is-${p.mode}`}>
          <AskPanel binding={binding} mode={p.mode} onDock={p.canDock ? () => setHeld(false) : null} />
        </ErrorBoundary>
      )}
    </div>
  );
}
