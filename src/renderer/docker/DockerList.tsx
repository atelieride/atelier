// The Docker sidebar: the engine, this project's containers first, the others under Elsewhere.
import { useMemo, useState } from 'react';
import { dotOf, groupContainers, type ContainerGroup, type DockerContainer, type EngineState } from '@shared/docker';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp, type DockerTarget } from '../store';
import { useDocker } from './store';
import { useDockerWatch } from './watch';
import { Sparkline } from './Sparkline';
import { containerMenu, openOverview } from './actions';
import { subline, tildePath } from './view';

const shortVersion = (v: string) => v.split('.').slice(0, 2).join('.');

/** The engine's state when it isn't running: a card that says what to do (sidebar and tab). */
export function EngineCard({ engine, compact = false }: { engine: EngineState; compact?: boolean }) {
  const s = t.docker.states;
  const [title, hint, extra] = engine.state === 'stopped' ? [s.stoppedTitle, s.stoppedHint, s.waiting(tildePath(engine.socket))]
    : engine.state === 'denied' ? [s.deniedTitle, s.deniedHint(tildePath(engine.socket)), null]
      : engine.state === 'unsupported' ? [s.unsupportedTitle, s.unsupportedHint(engine.version), null]
        : [s.absentTitle, s.absentHint, null];
  return (
    <div className={`dk-state ${compact ? 'is-compact' : ''} st-${engine.state}`} role="status">
      <span className="dk-state-icon"><Icon name="whale" size={compact ? 24 : 30} /></span>
      <p className="dk-state-title">{title}</p>
      <p className="dk-state-hint">{hint}</p>
      {extra && <p className="dk-state-wait mono" data-tip={engine.state === 'stopped' ? engine.socket : undefined}><span className="dk-spin" aria-hidden="true" /><span className="dk-ellipsis">{extra}</span></p>}
    </div>
  );
}

const same = (a: DockerTarget | undefined, b: DockerTarget) => !!a && a.kind === b.kind && (a.kind !== 'container' || (b.kind === 'container' && a.id === b.id)) && (a.kind !== 'stack' || (b.kind === 'stack' && a.project === b.project));

function Row({ c, selected, cpu, now }: { c: DockerContainer; selected: boolean; cpu: number[] | null; now: number }) {
  const dot = dotOf(c);
  return (
    // A click opens its tab as the preview, a double click keeps it.
    <button type="button" className={`dk-row ${selected ? 'is-selected' : ''} ${c.state !== 'running' ? 'is-down' : ''}`} aria-current={selected || undefined}
      onClick={() => { const st = useApp.getState(); st.openDocker({ kind: 'container', id: c.id }, undefined, { preview: true }); st.dockerSeen(c.id); }}
      onDoubleClick={() => useApp.getState().openDocker({ kind: 'container', id: c.id })}
      onContextMenu={(e) => useApp.getState().openMenu(e, containerMenu(c))}>
      <i className={`dk-dot is-${dot}`} aria-hidden="true" />
      <span className="dk-row-main">
        <span className="dk-row-name">
          <span className="dk-row-title">{c.name}</span>
          {c.restarts > 0 && <span className={`dk-restarts mono ${dot === 'err' ? 'is-err' : ''}`} data-tip={t.docker.restarts(c.restarts)}>↻ {c.restarts}</span>}
        </span>
        <span className="dk-row-sub mono">{subline(c, now)}</span>
      </span>
      {cpu && <Sparkline values={cpu} width={44} height={18} floor={5} tone={dot === 'err' ? 'error' : 'violet'} />}
    </button>
  );
}

function Group({ g, mine, target, cpuOf, now, open, onToggle }: { g: ContainerGroup; mine: boolean; target: DockerTarget | undefined; cpuOf: (id: string) => number[] | null; now: number; open: boolean; onToggle: () => void }) {
  const stack: DockerTarget = { kind: 'stack', project: g.project };
  return (
    <div className={`dk-group ${mine ? 'is-mine' : ''}`} role="group" aria-label={g.project}>
      <button type="button" className="dk-group-head" aria-expanded={open} onClick={onToggle}>
        <Icon name={open ? 'chevronDown' : 'chevron'} size={12} stroke={1.9} />
        <span className="dk-group-name">{g.project}</span>
        {mine && <span className="dk-mine">{t.docker.thisProject}</span>}
        <span className="grow" />
        <span className="mono dk-group-count">{g.running}/{g.total}</span>
      </button>
      {open && (
        <div className="dk-group-rows">
          <button type="button" className={`dk-row is-stack ${same(target, stack) ? 'is-selected' : ''}`} aria-current={same(target, stack) || undefined}
            onClick={() => useApp.getState().openDocker(stack, undefined, { preview: true })} onDoubleClick={() => useApp.getState().openDocker(stack)}>
            <Icon name="compact" size={14} />
            <span className="dk-row-main"><span className="dk-row-title">{t.docker.wholeStack}</span></span>
            <span className="mono dk-row-sub">{g.containers[0]?.configFiles[0]?.split('/').at(-1) ?? ''}</span>
          </button>
          {g.containers.map((c) => <Row key={c.id} c={c} selected={same(target, { kind: 'container', id: c.id })} cpu={cpuOf(c.id)} now={now} />)}
        </div>
      )}
    </div>
  );
}

export function DockerList() {
  const engine = useDocker((s) => s.engine);
  const containers = useDocker((s) => s.containers);
  const stats = useDocker((s) => s.stats);
  const project = useApp((s) => s.project);
  const others = useApp((s) => s.settings.dockerOthers);
  // The row of the Docker tab in front is lit.
  const target = useApp((s) => (s.activeTab.startsWith('dk:') ? s.dockerTabs.find((r) => r.key === s.activeTab)?.target : undefined));
  const [query, setQuery] = useState('');
  // Elsewhere's compose projects start folded; this project's start open.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const now = Date.now();

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? containers.filter((c) => [c.name, c.containerName, c.image, c.project ?? ''].some((v) => v.toLowerCase().includes(q))) : containers;
  }, [containers, query]);
  const g = useMemo(() => groupContainers(shown, project ?? { root: '', realRoot: '' }, others), [shown, project, others]);
  const mineRunning = g.mine.flatMap((x) => x.containers).filter((c) => c.state === 'running').map((c) => c.id);
  useDockerWatch('stats', 'sidebar', mineRunning);
  const cpuOf = (id: string) => (mineRunning.includes(id) ? (stats[id] ?? []).slice(-16).map((x) => x.cpu) : null);
  const toggle = (key: string) => setToggled((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const isOpen = (key: string, mine: boolean) => (mine ? !toggled.has(key) : toggled.has(key) || !!query.trim());
  const othersCount = g.others.reduce((n, x) => n + x.total, 0) + g.standalone.length;
  const othersUp = g.others.reduce((n, x) => n + x.running, 0) + g.standalone.filter((c) => c.state === 'running').length;
  const running = engine.state === 'running';

  return (
    <>
      <div className="sidebar-head">
        <span className="section-label">{t.docker.title}</span>
        <span className="grow" />
        {running && (
          <button type="button" className={`dk-engine-chip ${target?.kind === 'overview' ? 'is-on' : ''}`} data-tip={t.docker.engineTip} onClick={openOverview}>
            <i className="dk-dot is-ok" aria-hidden="true" /><span className="mono">{engine.name} · {shortVersion(engine.version)}</span>
          </button>
        )}
      </div>
      {!running ? <EngineCard engine={engine} compact /> : (
        <>
          {containers.length > 0 && (
            <label className="dk-filter">
              <Icon name="search" size={13} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.docker.filter} aria-label={t.docker.filter} spellCheck={false}
                onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }} />
            </label>
          )}
          <div className="dk-list">
            {g.mine.map((x) => <Group key={x.project} g={x} mine target={target} cpuOf={cpuOf} now={now} open={isOpen(x.project, true)} onToggle={() => toggle(x.project)} />)}
            {g.mine.length === 0 && !query.trim() && project && containers.length > 0 && (
              <div className="dk-none">
                <p className="dk-none-title">{t.docker.states.projectTitle(project.name)}</p>
                <p className="dk-none-hint">{t.docker.states.projectHint}</p>
              </div>
            )}
            {(g.others.length > 0 || g.standalone.length > 0) && (
              <div className="dk-elsewhere">
                <span className="section-label">{t.docker.elsewhere}</span>
                <span className="grow" />
                <span className="mono dk-group-count">{othersUp}/{othersCount}</span>
              </div>
            )}
            {g.others.map((x) => <Group key={x.project} g={x} mine={false} target={target} cpuOf={cpuOf} now={now} open={isOpen(x.project, false)} onToggle={() => toggle(x.project)} />)}
            {g.standalone.map((c) => <Row key={c.id} c={c} selected={same(target, { kind: 'container', id: c.id })} cpu={null} now={now} />)}
            {query.trim() && shown.length === 0 && <p className="empty">{t.docker.states.noMatch}</p>}
            {!query.trim() && containers.length === 0 && (
              <div className="dk-none">
                <p className="dk-none-title">{t.docker.states.noneTitle}</p>
                <p className="dk-none-hint">{t.docker.states.noneHint}</p>
              </div>
            )}
          </div>
        </>
      )}
      <span className="grow" />
      <div className="services-foot">{t.docker.foot}</div>
    </>
  );
}
