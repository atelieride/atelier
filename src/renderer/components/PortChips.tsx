import { chipPorts, type PortInfo } from '@shared/ports';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { openBelow } from '../menus';
import { afterLeavingApp } from '../pane-focus';

/**
 * The ports a terminal (or the dev server it started) listens on: `:3000` chips, the first two, then a
 * `+N` chip listing the rest. A chip opens localhost in the browser through main, which opens only ports it listed.
 * `compact` (sidebar rows): the first port and `+N`; on the narrowest
 * session rows, or a terminal row whose name needs the room, a single chip — the live dot and how many — whose tooltip
 * and menu list them all (the row's container query or data-tight picks it).
 */
export function PortChips({ id, compact = false }: { id: string; compact?: boolean }) {
  const ports = useApp((s) => (s.settings.showPorts ? s.ports[id] : undefined));
  if (!ports?.length) return null;
  const { shown, rest } = chipPorts(ports, compact ? 1 : undefined);
  // The browser comes forward: coming back finds the keyboard in the pane, not on the chip.
  const open = (port: number) => { void window.atelier.ports.open(id, port); afterLeavingApp(); };
  const menu = (el: HTMLElement, list: PortInfo[]) => openBelow(el, list.map((p) => ({ id: `port-${p.port}`, label: t.ports.open(p.port, p.name), run: () => open(p.port) })));
  const allTip = ports.length === 1 ? t.ports.open(ports[0]!.port, ports[0]!.name) : t.ports.allTip(ports);
  return (
    <span className={`port-chips${compact ? ' is-compact' : ''}`} role="group" aria-label={t.ports.label}>
      {shown.map((p, i) => (
        // In rows the first chip also names the others: on mid-width rows it stands alone, without +N.
        <button key={p.port} type="button" className="port-chip mono" aria-label={t.ports.open(p.port, p.name)}
          data-tip={compact && rest.length > 0 ? `${t.ports.open(p.port, p.name)}\n${t.ports.moreTip(rest)}` : t.ports.open(p.port, p.name)}
          onClick={(e) => { e.stopPropagation(); open(p.port); }} onDoubleClick={(e) => e.stopPropagation()}>
          {/* Rows are short of room: the live dot only on the narrowest rows' single chip. */}
          {i === 0 && !compact && <i className="port-dot" aria-hidden />}:{p.port}
        </button>
      ))}
      {rest.length > 0 && (
        <button type="button" className="port-chip port-more mono" aria-label={t.ports.more(rest.length)} aria-haspopup="menu" data-tip={t.ports.moreTip(rest)}
          onClick={(e) => { e.stopPropagation(); menu(e.currentTarget, rest); }}
          onDoubleClick={(e) => e.stopPropagation()}>
          +{rest.length}
        </button>
      )}
      {compact && (
        // The narrowest rows: the live dot (a terminal row adds how many); one port opens directly, more open the menu.
        <button type="button" className="port-chip port-all" aria-label={allTip} aria-haspopup={ports.length > 1 ? 'menu' : undefined} data-tip={allTip}
          onClick={(e) => { e.stopPropagation(); if (ports.length === 1) open(ports[0]!.port); else menu(e.currentTarget, ports); }}
          onDoubleClick={(e) => e.stopPropagation()}>
          <i className="port-dot" aria-hidden />{ports.length > 1 && <span className="port-n">{ports.length}</span>}
        </button>
      )}
    </span>
  );
}
