import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ServicePane } from '@shared/services';
import { pasteText } from '@shared/logline';
import { Icon } from './Icon';
import { LogLineView, type PasteTarget } from './LogLineView';
import { LIVE_KEY, carryLive, serviceMenu, toggleLine } from '../log-expand';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { bracketedPaste } from '../terminal/registry';
import { sendInput } from '../terminal/drafts';

const SHOWN = 1500;

/** Key of a shown line: its absolute number among all those received (stable while the buffer scrolls). */
export function lineKey(seq: number, bufferLength: number, shown: number, i: number): number {
  return seq - Math.min(bufferLength, shown) + i;
}

function Card({ pane, onPaste, paste }: { pane: ServicePane; onPaste: (text: string) => void; paste: PasteTarget | null }) {
  const lines = useApp((s) => s.serviceLines[pane.id]) ?? [];
  const live = useApp((s) => s.serviceLive[pane.id]) ?? '';
  const seq = useApp((s) => s.serviceSeq[pane.id]) ?? lines.length;
  const maximized = useApp((s) => s.maximized);
  const setMaximized = useApp((s) => s.setMaximized);
  const wrap = useApp((s) => !!s.serviceWrap[pane.id]);
  // Lines shown whole, by line key, while the card lives.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  // An expanded live line stays expanded once committed; the next live line starts folded.
  const liveBefore = useRef(live);
  useEffect(() => {
    const was = liveBefore.current;
    liveBefore.current = live;
    if (was !== live) setExpanded((x) => carryLive(x, was, live, lines, seq));
  }, [live, lines, seq]);
  // Keyboard focus coming into the card measures its lines at once, so the cut ones' chevrons can be tabbed to
  // (the mouse measures one line on hover).
  const [measureAll, setMeasureAll] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Stay at the bottom only if we were already there: someone reading further up is not dragged down.
  useLayoutEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, live, wrap, expanded]);
  const isMax = maximized === pane.id;
  const health = pane.errors > 0 ? 'is-err' : pane.running ? 'is-ok' : 'is-off';
  return (
    <div className={`svc-card ${pane.errors > 0 ? 'has-errors' : ''} ${wrap ? 'is-wrap' : ''}`}
      onFocus={(e) => { if ((e.target as HTMLElement).matches(':focus-visible') && !e.currentTarget.contains(e.relatedTarget as Node | null)) setMeasureAll((n) => n + 1); }}>
      <div className="svc-head" onContextMenu={(e) => useApp.getState().openMenu(e, serviceMenu({ wrap, maximized: isMax,
        toggleWrap: () => useApp.getState().toggleServiceWrap(pane.id), toggleMax: () => setMaximized(isMax ? null : pane.id) }))}>
        <i className={`svc-dot ${health}`} />
        <span className="svc-name">{pane.name}</span>
        {pane.port && <span className="mono svc-port">:{pane.port}</span>}
        {!pane.running && <span className="svc-stopped">{t.stopped}</span>}
        {pane.errors > 0 && <span className="svc-errors">{t.errorsCount(pane.errors)}</span>}
        {pane.stale && <span className="svc-stopped" title={t.staleHint}>{t.stale}</span>}
        <span className="grow" />
        <button type="button" className="icon-btn svc-wrap" aria-pressed={wrap} aria-label={t.logs.wrap} data-tip={t.logs.wrap}
          onClick={() => useApp.getState().toggleServiceWrap(pane.id)}><Icon name="wrap" size={13} /></button>
        <button type="button" className="icon-btn" onClick={() => setMaximized(isMax ? null : pane.id)} aria-label={isMax ? t.restore : t.maximize} title={isMax ? t.restore : t.maximize}>
          <Icon name="maximize" size={13} />
        </button>
      </div>
      <div ref={body} className="svc-body mono" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
        {lines.slice(-SHOWN).map((raw, i) => {
          const key = lineKey(seq, lines.length, SHOWN, i);
          return <LogLineView key={key} raw={raw} paste={paste} onPaste={onPaste} expanded={!wrap && expanded.has(key)} measure={measureAll} onToggle={wrap ? undefined : () => setExpanded((x) => toggleLine(x, key))} />;
        })}
        {/* The live line (the capture's last, still growing) expands too, under its own key. */}
        {live && <LogLineView key="live" raw={live} paste={paste} onPaste={onPaste} expanded={!wrap && expanded.has(LIVE_KEY)} measure={measureAll} onToggle={wrap ? undefined : () => setExpanded((x) => toggleLine(x, LIVE_KEY))} />}
      </div>
    </div>
  );
}

/**
 * focused / place: as TerminalView's (split view). The focused view takes the keyboard (as ReviewView):
 * the terminal that had it must not keep receiving what is typed while Services is the focused pane.
 */
export function ServicesView({ visible, focused = visible, place }: { visible: boolean; focused?: boolean; place?: CSSProperties }) {
  const root = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (visible && focused) root.current?.focus({ preventScroll: true });
  }, [visible, focused]);
  const services = useApp((s) => s.services);
  const maximized = useApp((s) => s.maximized);
  const selectedId = useApp((s) => s.selectedId);
  const terminals = useApp((s) => s.terminals);
  const target = terminals.find((x) => x.id === selectedId && x.session) ?? terminals.find((x) => x.session);
  const shown = maximized ? services.filter((p) => p.id === maximized) : services;

  // Shown panes are captured every second; the others every five.
  const ids = visible ? shown.map((p) => p.id).join(',') : '';
  useEffect(() => {
    window.atelier.services.watch(ids ? ids.split(',') : []);
    return () => window.atelier.services.watch([]);
  }, [ids]);

  const paste = (text: string) => {
    if (!target) return;
    // Pasted as a bracketed paste and without Enter: the line can be reread before sending it.
    sendInput(target.id, pasteText(text, bracketedPaste(target.id)));
    const st = useApp.getState();
    st.select(target.id);
    st.setPastedAt(Date.now());
  };

  const status = useApp((s) => s.servicesStatus);
  if (services.length === 0) return <div ref={(el) => { root.current = el; }} tabIndex={-1} className="services-empty" style={{ display: visible ? 'flex' : 'none', ...place }}><p>{t.servicesEmpty[status]}</p></div>;
  return (
    <section ref={(el) => { root.current = el; }} tabIndex={-1} className="services-grid" style={{ display: visible ? 'grid' : 'none', gridTemplateColumns: shown.length > 1 ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)', ...place }} aria-label={t.servicesTab}>
      {shown.map((p) => <Card key={p.id} pane={p} onPaste={paste} paste={target ? { title: target.title, color: target.color } : null} />)}
    </section>
  );
}
