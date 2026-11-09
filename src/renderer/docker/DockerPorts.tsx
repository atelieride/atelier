// Ports in terminal headers: the terminal running docker compose in a compose project's folder
// shows that project's published ports, marked with the whale; a click opens the browser.
import type { TerminalInfo } from '@shared/protocol';
import { portUrl } from '@shared/ports';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { openBelow } from '../menus';
import { afterLeavingApp } from '../pane-focus';
import { useDocker } from './store';
import { dockerShown, terminalPorts } from './view';

const SHOWN = 2;

/** `compact` (sidebar rows, short of room): one whale chip with the count; its menu lists the ports. */
export function DockerPortChips({ term, compact = false }: { term: TerminalInfo; compact?: boolean }) {
  const show = useApp((s) => s.settings.showDocker);
  const project = useApp((s) => s.project);
  // A string: the chips re-render only when what they show changes, not on every snapshot.
  const key = useDocker((s) => (dockerShown(show, s.engine.state) ? terminalPorts(term, s.containers, project ?? undefined).map((p) => `${p.name}:${p.port}`).join(',') : ''));
  if (!key) return null;
  const ports = key.split(',').map((x) => { const i = x.lastIndexOf(':'); return { name: x.slice(0, i), port: Number(x.slice(i + 1)) }; });
  const open = (port: number) => { void window.atelier.openUrl(portUrl(port)); afterLeavingApp(); };
  const menu = (el: HTMLElement, list: typeof ports) => openBelow(el, list.map((p) => ({ id: `dk-port-${p.port}`, label: t.ports.open(p.port, p.name), icon: 'whale' as const, run: () => open(p.port) })));
  const all = ports.map((p) => `${p.name} :${p.port}`).join('\n');
  if (compact) {
    return (
      <span className="port-chips dk-port-chips" role="group" aria-label={t.ports.label}>
        <button type="button" className="port-chip mono" aria-haspopup="menu" aria-label={t.docker.portsTip(ports.length)} data-tip={`${t.docker.portsTip(ports.length)}\n${all}`}
          onClick={(e) => { e.stopPropagation(); menu(e.currentTarget, ports); }} onDoubleClick={(e) => e.stopPropagation()}>
          <Icon name="whale" size={10} />{ports.length}
        </button>
      </span>
    );
  }
  return (
    <span className="port-chips dk-port-chips" role="group" aria-label={t.ports.label}>
      {ports.slice(0, SHOWN).map((p) => (
        <button key={p.port} type="button" className="port-chip mono" aria-label={t.docker.portTip(p.name, p.port)} data-tip={t.docker.portTip(p.name, p.port)}
          onClick={(e) => { e.stopPropagation(); open(p.port); }} onDoubleClick={(e) => e.stopPropagation()}>
          <Icon name="whale" size={10} />:{p.port}
        </button>
      ))}
      {ports.length > SHOWN && (
        <button type="button" className="port-chip mono port-more" aria-haspopup="menu" aria-label={t.ports.more(ports.length - SHOWN)} data-tip={ports.slice(SHOWN).map((p) => `${p.name} :${p.port}`).join('\n')}
          onClick={(e) => { e.stopPropagation(); menu(e.currentTarget, ports.slice(SHOWN)); }} onDoubleClick={(e) => e.stopPropagation()}>
          +{ports.length - SHOWN}
        </button>
      )}
    </span>
  );
}
