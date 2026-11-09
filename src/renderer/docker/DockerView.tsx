// A Docker tab: a container (Logs · Inspect), a compose stack (its logs
// merged), or the engine overview. One tab per target, opened from the Docker sidebar.
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { dotOf, type DockerContainer, type StatsSample } from '@shared/docker';
import { portUrl } from '@shared/ports';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp, type DockerTabRef, type DockerTarget, type DockerView as View } from '../store';
import { radioNext } from '../radio';
import { useDocker } from './store';
import { useDockerWatch } from './watch';
import { Sparkline } from './Sparkline';
import { DockerLogs } from './DockerLogs';
import { DockerInspect } from './DockerInspect';
import { DockerOverview } from './DockerOverview';
import { EngineCard } from './DockerList';
import { containerMenu } from './actions';
import { fmtBytes, fmtRate, shortImage, stateText } from './view';
import type { TabKey } from '../tabs-model';

/** A tab's name: what it shows (its space says it is Docker's). */
export function dockerTabTitle(target: DockerTarget, containers: readonly DockerContainer[]): string {
  if (target.kind === 'overview') return t.docker.overviewTab;
  if (target.kind === 'stack') return target.project;
  const id = target.id;
  return containers.find((x) => x.id === id)?.name ?? id.slice(0, 12);
}

const TONE = { ok: 'ok', warn: 'warn', err: 'err', off: 'off' } as const;

function Stat({ label, value, sub, spark, tone, floor }: { label: string; value: string; sub: string; spark: number[] | null; tone: 'violet' | 'pink' | 'sky' | 'error' | 'dim'; floor: number }) {
  return (
    <div className="dk-stat">
      <div className="dk-stat-text">
        <span className="section-label">{label}</span>
        <span className="mono dk-stat-v">{value}</span>
        <span className="mono dk-stat-sub">{sub || ' '}</span>
      </div>
      {spark && <Sparkline values={spark} width={84} height={34} floor={floor} tone={tone} />}
    </div>
  );
}

function Stats({ list, title, visible, watchKey }: { list: DockerContainer[]; title: string; visible: boolean; watchKey: string }) {
  const engine = useDocker((s) => s.engine);
  const stats = useDocker((s) => s.stats);
  const running = list.filter((c) => c.state === 'running');
  // Each tab asks for its own (two tabs side by side both watch theirs).
  useDockerWatch('stats', watchKey, visible ? running.map((c) => c.id) : []);
  // One series per metric: the sum over the containers, sample by sample (aligned from the end).
  const series = (pick: (s: StatsSample) => number) => {
    const all = running.map((c) => stats[c.id] ?? []);
    const n = Math.max(0, ...all.map((a) => a.length));
    return Array.from({ length: n }, (_, i) => all.reduce((sum, a) => sum + (a[a.length - n + i] ? pick(a[a.length - n + i]!) : 0), 0));
  };
  const cpu = series((s) => s.cpu);
  const mem = series((s) => s.mem);
  const net = series((s) => s.rx + s.tx);
  const lastOf = (id: string) => stats[id]?.at(-1);
  const rx = running.reduce((n, c) => n + (lastOf(c.id)?.rx ?? 0), 0);
  const tx = running.reduce((n, c) => n + (lastOf(c.id)?.tx ?? 0), 0);
  const limit = running.length === 1 ? lastOf(running[0]!.id)?.memLimit ?? 0 : engine.state === 'running' ? engine.memory : 0;
  const cores = engine.state === 'running' ? engine.cpus : 0;
  const restarts = list.reduce((n, c) => n + c.restarts, 0);
  const off = running.length === 0;
  const policy = list.length === 1 ? list[0]!.restartPolicy : '';
  const vmMem = engine.state === 'running' ? engine.memory : 0;
  return (
    <div className="dk-stats">
      <Stat label={t.docker.stats.cpu} value={off ? '—' : `${Math.round((cpu.at(-1) ?? 0) * 10) / 10}%`} sub={off ? t.docker.stats.notRunning : cores ? t.docker.stats.ofCores(cores) : ''} spark={off ? null : cpu} tone="violet" floor={5} />
      <Stat label={t.docker.stats.memory} value={off ? '—' : fmtBytes(mem.at(-1) ?? 0)} sub={off ? '' : limit && (!vmMem || limit < vmMem * 0.98) ? t.docker.stats.of(fmtBytes(limit)) : t.docker.stats.noLimit} spark={off ? null : mem} tone="pink" floor={1024 * 1024} />
      <Stat label={t.docker.stats.network} value={off ? '—' : fmtRate(rx + tx)} sub={off ? '' : t.docker.stats.inOut(fmtBytes(rx), fmtBytes(tx))} spark={off ? null : net} tone="sky" floor={1024} />
      <Stat label={t.docker.stats.restarts} value={String(restarts)} sub={policy ? t.docker.stats.policy(policy) : ''} spark={null} tone={restarts ? 'error' : 'dim'} floor={1} />
    </div>
  );
}

function Views({ tabKey, view }: { tabKey: TabKey; view: View }) {
  const views: View[] = ['logs', 'inspect'];
  return (
    <div className="dk-views" role="radiogroup" aria-label={t.docker.viewsLabel} onKeyDown={(e) => {
      const next = radioNext(views, view, e.key);
      if (next === null) return;
      e.preventDefault();
      useApp.getState().setDockerView(tabKey, next);
      (e.currentTarget.querySelector(`[data-value="${next}"]`) as HTMLElement | null)?.focus();
    }}>
      {views.map((v) => (
        <button key={v} type="button" role="radio" aria-checked={view === v} tabIndex={view === v ? 0 : -1} data-value={v} className={view === v ? 'is-on' : ''} onClick={() => useApp.getState().setDockerView(tabKey, v)}>
          <Icon name={v === 'logs' ? 'terminal' : 'info'} size={12} stroke={1.8} />{t.docker.views[v]}
        </button>
      ))}
    </div>
  );
}

function Ports({ c }: { c: DockerContainer }) {
  return (
    <>
      {c.ports.filter((p) => p.proto === 'tcp').slice(0, 3).map((p) => (
        <button key={p.host} type="button" className="port-chip mono" data-tip={t.docker.portTip(c.name, p.host)} onClick={() => void window.atelier.openUrl(portUrl(p.host))}>
          :{p.host}<Icon name="externalLink" size={9} stroke={2} />
        </button>
      ))}
    </>
  );
}

export function DockerView({ tab, visible, focused, place }: { tab: DockerTabRef; visible: boolean; focused: boolean; place?: CSSProperties }) {
  const containers = useDocker((s) => s.containers);
  const engine = useDocker((s) => s.engine);
  const root = useRef<HTMLElement>(null);
  useEffect(() => { if (visible && focused && !root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true }); }, [visible, focused]);
  const target = tab.target;
  const c = target.kind === 'container' ? containers.find((x) => x.id === target.id) : undefined;
  const stack = useMemo(() => (target.kind === 'stack' ? containers.filter((x) => x.project === target.project).sort((a, b) => a.name.localeCompare(b.name)) : []), [containers, target]);
  // Seen: a container shown in the tab reads its notification entries.
  useEffect(() => { if (visible && c) useApp.getState().dockerSeen(c.id); }, [visible, c?.id]);
  const now = Date.now();
  // Each tab watches its own logs and stats (two tabs side by side both stream).
  const logsKey = `tab:${tab.key}`;
  const statsKey = `strip:${tab.key}`;

  let head: React.ReactNode = null;
  let body: React.ReactNode;
  if (engine.state !== 'running') body = <div className="dk-center"><EngineCard engine={engine} /></div>;
  else if (target.kind === 'overview') {
    head = (
      <div className="dk-head">
        <span className="dk-head-icon"><Icon name="whale" size={20} /></span>
        <h2 className="dk-name">{t.docker.overview.title}</h2>
      </div>
    );
    body = <DockerOverview visible={visible} />;
  } else if (target.kind === 'stack') {
    if (!stack.length) body = <div className="dk-center"><p className="dk-dim">{t.docker.states.stackGone}</p></div>;
    else {
      const up = stack.filter((x) => x.state === 'running').length;
      const bad = stack.some((x) => dotOf(x) === 'err');
      head = (
        <>
          <div className="dk-head">
            <h2 className="dk-name">{target.project}</h2>
            <span className={`dk-chip-state tone-${bad ? 'warn' : up ? 'ok' : 'off'}`}><i className={`dk-dot is-${bad ? 'warn' : up ? 'ok' : 'off'}`} aria-hidden="true" />{t.docker.stack(stack.length, up)}</span>
            <span className="mono dk-dim dk-ellipsis">{stack[0]!.configFiles.map((f) => f.split('/').at(-1)).join(', ')}</span>
          </div>
          <Stats list={stack} title={target.project} visible={visible} watchKey={statsKey} />
        </>
      );
      body = <DockerLogs key={`stack:${target.project}`} containers={stack} stack viewKey={logsKey} visible={visible} focused={visible && focused} />;
    }
  } else if (!c) body = <div className="dk-center"><p className="dk-dim">{t.docker.states.gone}</p></div>;
  else {
    const dot = dotOf(c);
    head = (
      <>
        <div className="dk-head" onContextMenu={(e) => useApp.getState().openMenu(e, containerMenu(c))}>
          <h2 className="dk-name">{c.name}</h2>
          <span className={`dk-chip-state tone-${TONE[dot]}`}><i className={`dk-dot is-${dot}`} aria-hidden="true" />{stateText(c, now)}</span>
          <span className="mono dk-dim dk-ellipsis">{shortImage(c.image)}</span>
          <Ports c={c} />
          <span className="grow" />
          <Views tabKey={tab.key} view={tab.view} />
          <button type="button" className="icon-btn" aria-label={t.docker.menu.logs} aria-haspopup="menu" data-tip={t.docker.title}
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); useApp.getState().openMenu({ x: r.right - 220, y: r.bottom + 6 }, containerMenu(c)); }}>
            <Icon name="chevronDown" size={14} />
          </button>
        </div>
        <Stats list={[c]} title={c.id} visible={visible} watchKey={statsKey} />
      </>
    );
    body = tab.view === 'inspect' ? <DockerInspect key={c.id} c={c} tabKey={tab.key} /> : <DockerLogs key={c.id} containers={[c]} stack={false} viewKey={logsKey} visible={visible} focused={visible && focused} />;
  }
  return (
    <section ref={root} tabIndex={-1} className="dk-view" data-key={tab.key} style={{ display: visible ? 'flex' : 'none', ...place }} aria-label={dockerTabTitle(target, containers)}>
      {head}
      <div className="dk-body">{body}</div>
    </section>
  );
}
