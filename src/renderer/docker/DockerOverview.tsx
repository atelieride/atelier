// The engine overview: the engine, every compose stack, live resources, disk usage, events.
import { useEffect, useMemo, useState } from 'react';
import { dotOf, groupContainers, type DfSummary, type DockerContainer, type DockerEventEntry } from '@shared/docker';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { copyText } from '../clipboard';
import { useDocker } from './store';
import { useDockerWatch } from './watch';
import { fmtBytes, fmtRate, fmtUptime, tildePath } from './view';
import { openContainer, openStack } from './actions';

type Sort = 'cpu' | 'mem' | 'name';
/** Since when the stack has been up: its oldest running container's start (none running, or unknown: null). */
const upSince = (cs: readonly DockerContainer[]): number | null => {
  const starts = cs.filter((c) => c.state === 'running' && c.startedAt).map((c) => c.startedAt!);
  return starts.length ? Math.min(...starts) : null;
};
const EV_TONE: Record<string, string> = { die: 'err', oom: 'err', destroy: 'off', stop: 'off', restart: 'warn', start: 'ok', create: 'info', health: 'info', pull: 'info' };

function Copy({ cmd }: { cmd: string }) {
  return (
    <button type="button" className="btn-ghost sm dk-cmd" onClick={() => void copyText(cmd).then(() => useApp.getState().showToast(t.docker.copied(cmd), undefined, 'info'))}>
      <Icon name="copy" size={12} /><span className="mono">{cmd}</span>
    </button>
  );
}

function EventRow({ e }: { e: DockerEventEntry }) {
  const tone = e.action === 'health' ? (e.detail === 'unhealthy' ? 'err' : e.detail === 'healthy' ? 'ok' : 'info') : EV_TONE[e.action] ?? 'info';
  const d = new Date(e.at);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  return (
    <div className="dk-ev">
      <span className="mono dk-dim">{time}</span>
      <i className={`dk-dot is-${tone === 'info' ? 'info' : tone}`} aria-hidden="true" />
      <span className={`mono dk-ev-action tone-${tone}`}>{e.action}</span>
      <span className="dk-ev-what"><span>{e.name}</span>{e.detail && <span className="mono dk-dim"> {e.detail}</span>}</span>
    </div>
  );
}

export function DockerOverview({ visible }: { visible: boolean }) {
  const engine = useDocker((s) => s.engine);
  const containers = useDocker((s) => s.containers);
  const stats = useDocker((s) => s.stats);
  const events = useDocker((s) => s.events);
  const project = useApp((s) => s.project);
  const [df, setDf] = useState<DfSummary | null | 'loading'>('loading');
  const [sort, setSort] = useState<Sort>('cpu');
  const running = containers.filter((c) => c.state === 'running');
  useDockerWatch('stats', 'overview', visible ? running.map((c) => c.id).slice(0, 24) : []);
  useEffect(() => { void window.atelier.docker.events().then((l) => useDocker.getState().setEvents(l)).catch(() => {}); }, []);
  useEffect(() => {
    if (!visible) return;
    const load = () => void window.atelier.docker.df().then(setDf).catch(() => setDf(null));
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [visible]);

  const g = useMemo(() => groupContainers(containers, project ?? { root: '', realRoot: '' }, true), [containers, project]);
  const stacks = [...g.mine.map((x) => ({ ...x, mine: true })), ...g.others.map((x) => ({ ...x, mine: false }))];
  const last = (id: string) => stats[id]?.at(-1);
  const rows = running.map((c) => ({ c, s: last(c.id) })).sort((a, b) => (sort === 'name' ? a.c.name.localeCompare(b.c.name) : sort === 'mem' ? (b.s?.mem ?? 0) - (a.s?.mem ?? 0) : (b.s?.cpu ?? 0) - (a.s?.cpu ?? 0)));
  const totCpu = rows.reduce((n, r) => n + (r.s?.cpu ?? 0), 0);
  const totMem = rows.reduce((n, r) => n + (r.s?.mem ?? 0), 0);
  // Bars compare the containers with each other (against the busiest), not with the whole VM: 12% of 4 cores would
  // otherwise be a sliver.
  const cpuScale = Math.max(10, ...rows.map((r) => r.s?.cpu ?? 0));
  const memScale = Math.max(1, ...rows.map((r) => r.s?.mem ?? 0));
  const now = Date.now();
  if (engine.state !== 'running') return null;
  const disk = df && df !== 'loading' ? df : null;
  const total = disk ? disk.images.size + disk.buildCache.size + disk.volumes.size + disk.containers.size : 0;
  const reclaim = disk ? disk.images.reclaimable + disk.buildCache.reclaimable + disk.volumes.reclaimable + disk.containers.reclaimable : 0;
  const head = (k: Sort, label: string) => (
    <button type="button" className={sort === k ? 'is-on' : ''} aria-pressed={sort === k} aria-label={t.docker.overview.sortBy(label)} onClick={() => setSort(k)}>
      {label}{sort === k && <Icon name="chevronDown" size={10} stroke={2} />}
    </button>
  );
  return (
    <div className="dk-overview">
      <div className="dk-ov-engine">
        <span className="dk-chip-state tone-ok"><i className="dk-dot is-ok" aria-hidden="true" />{t.docker.overview.running}</span>
        <span className="mono dk-dim dk-ov-info">{engine.name} · Engine {engine.version} · {engine.os}/{engine.arch}{engine.cpus ? ` · ${engine.cpus} CPU` : ''}{engine.memory ? ` · ${fmtBytes(engine.memory)}` : ''}</span>
        <span className="mono dk-dim dk-ov-socket" data-tip={engine.socket}>{tildePath(engine.socket)}</span>
      </div>
      {stacks.length > 0 && (
        <div className="dk-stacks">
          {stacks.map((s) => (
            <button key={s.project} type="button" className="dk-stack-card" onClick={() => openStack(s.project)}>
              <span className="dk-stack-top">
                <i className={`dk-dot is-${s.containers.some((c) => dotOf(c) === 'err') ? 'err' : s.running ? 'ok' : 'off'}`} aria-hidden="true" />
                <span className="dk-stack-name">{s.project}</span>
                {s.mine && <span className="dk-mine">{t.docker.thisProject}</span>}
                <span className="grow" />
                <span className="mono dk-dim">{s.running} / {s.total}</span>
              </span>
              <span className="dk-pips">{s.containers.map((c) => <i key={c.id} className={`is-${dotOf(c)}`} />)}</span>
              <span className="mono dk-dim dk-ellipsis">{s.workingDir ? tildePath(s.workingDir) : ''}{upSince(s.containers) ? ` · up ${fmtUptime(now - upSince(s.containers)!)}` : ''}</span>
            </button>
          ))}
        </div>
      )}
      <div className="dk-ov-grid">
        <div className="dk-ov-col">
          <section className="dk-card" aria-label={t.docker.overview.resources}>
            <div className="dk-card-h">
              <span className="section-label">{t.docker.overview.resources}</span>
              <span className="dk-live-note"><i className="pulse-live" aria-hidden="true" />{t.docker.overview.liveVisible}</span>
              <span className="grow" />
              <span className="dk-dim">{t.docker.overview.summary(rows.length, fmtBytes(totMem), `${Math.round(totCpu * 10) / 10}%`)}</span>
            </div>
            {rows.length > 0 ? (
              <div className="dk-table">
                <div className="dk-tr dk-th">{head('name', t.docker.overview.container)}{head('cpu', t.docker.overview.cpu)}{head('mem', t.docker.overview.memory)}<span>{t.docker.overview.net}</span><span>{t.docker.overview.pids}</span></div>
                {rows.map(({ c, s }) => (
                  <button key={c.id} type="button" className="dk-tr" aria-label={`${c.name}: ${s ? `${s.cpu}% CPU, ${fmtBytes(s.mem)}` : t.docker.stats.notRunning}`} onClick={() => openContainer(c.id)}>
                    <span className="dk-td-name"><i className={`dk-dot is-${dotOf(c)}`} aria-hidden="true" /><span>{c.name}</span><span className="mono dk-dim dk-ellipsis">{c.project ?? t.docker.standalone}</span></span>
                    <span className="dk-bar-cell"><span className="dk-bar"><i className="tone-violet" style={{ width: `${Math.min(100, Math.max(2, ((s?.cpu ?? 0) / cpuScale) * 100))}%` }} /></span><span className="mono">{s ? `${s.cpu}%` : '—'}</span></span>
                    <span className="dk-bar-cell"><span className="dk-bar"><i className="tone-pink" style={{ width: `${Math.min(100, Math.max(2, ((s?.mem ?? 0) / memScale) * 100))}%` }} /></span><span className="mono">{s ? fmtBytes(s.mem) : '—'}</span></span>
                    <span className="mono dk-dim">{s ? fmtRate(s.rx + s.tx) : '—'}</span>
                    <span className="mono dk-dim">{s ? s.pids : '—'}</span>
                  </button>
                ))}
              </div>
            ) : <p className="dk-dim dk-pad">{t.docker.overview.noRunning}</p>}
          </section>
          <section className="dk-card" aria-label={t.docker.overview.disk}>
            <div className="dk-card-h">
              <span className="section-label">{t.docker.overview.disk}</span>
              <span className="grow" />
              {disk && <span className="dk-dim"><span className="mono dk-strong">{fmtBytes(total)}</span> {t.docker.overview.used} · <span className="mono dk-warn">{fmtBytes(reclaim)}</span> {t.docker.overview.reclaimable}</span>}
            </div>
            {df === 'loading' ? <p className="dk-dim dk-pad">{t.docker.overview.diskLoading}</p> : !disk ? <p className="dk-dim dk-pad">{t.docker.overview.diskFailed}</p> : (
              <div className="dk-disk">
                <div className="dk-disk-bar" role="img" aria-label={`${t.docker.overview.images} ${fmtBytes(disk.images.size)}, ${t.docker.overview.buildCache} ${fmtBytes(disk.buildCache.size)}, ${t.docker.overview.volumes} ${fmtBytes(disk.volumes.size)}, ${t.docker.overview.containers} ${fmtBytes(disk.containers.size)}`}>
                  {[['img', disk.images.size], ['cache', disk.buildCache.size], ['vol', disk.volumes.size], ['ctr', disk.containers.size]].map(([k, v]) => (v as number) > 0 && <i key={k as string} className={`k-${k}`} style={{ flexGrow: v as number }} />)}
                </div>
                <div className="dk-disk-legend">
                  <div><span className="dk-legend k-img">{t.docker.overview.images}</span><span className="mono dk-big">{fmtBytes(disk.images.size)}</span><span className="mono dk-dim">{disk.images.count} · {t.docker.overview.dangling(disk.images.dangling)}</span></div>
                  <div><span className="dk-legend k-cache">{t.docker.overview.buildCache}</span><span className="mono dk-big">{fmtBytes(disk.buildCache.size)}</span><span className="mono dk-dim">{fmtBytes(disk.buildCache.reclaimable)} {t.docker.overview.reclaimable}</span></div>
                  <div><span className="dk-legend k-vol">{t.docker.overview.volumes}</span><span className="mono dk-big">{fmtBytes(disk.volumes.size)}</span><span className="mono dk-dim">{disk.volumes.count} · {t.docker.overview.unused(disk.volumes.unused)}</span></div>
                  <div><span className="dk-legend k-ctr">{t.docker.overview.containers}</span><span className="mono dk-big">{fmtBytes(disk.containers.size)}</span><span className="mono dk-dim">{disk.containers.count} · {t.docker.overview.stopped(disk.containers.stopped)}</span></div>
                </div>
                <div className="dk-cleanup"><span className="dk-dim">{t.docker.overview.cleanup}</span><Copy cmd="docker builder prune" /><Copy cmd="docker image prune" /></div>
              </div>
            )}
          </section>
        </div>
        <section className="dk-card dk-events" aria-label={t.docker.overview.events}>
          <div className="dk-card-h">
            <span className="section-label">{t.docker.overview.events}</span>
            <span className="dk-live-note"><i className="pulse-live" aria-hidden="true" />{t.docker.logs.live}</span>
            <span className="grow" />
            <span className="mono dk-dim">{t.docker.overview.thisRun}</span>
          </div>
          <div className="dk-ev-list">
            {events.map((e, i) => <EventRow key={`${e.at}-${e.id}-${e.action}-${i}`} e={e} />)}
            {events.length === 0 && <p className="dk-dim dk-pad">{t.docker.overview.noEvents}</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
