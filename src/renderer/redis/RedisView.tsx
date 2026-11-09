// A Redis tab: one per view — Keys, Queues, Live, Overview; the sidebar picks
// the namespace, the queue or the instance they show.
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { fmtBytes, fmtUptime, frameworkPrefix, groupNamespaces, instanceTitle, NO_NAMESPACE } from '@shared/redis';
import type { QueueInfo } from '@shared/redis-queues';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import type { RedisView as View } from '../store';
import { RedisKeys } from './RedisKeys';
import { RedisQueues } from './RedisQueues';
import { OverviewColumn } from './RedisOverview';
import { RedisLive } from './RedisLive';
import { LimitedNote, ModeNote, RedisStateCard } from './RedisStates';
import { NONE, pickedOf, useRedis } from './store';
import { redisTabTitle } from './tabs';
import { useRedisWatch } from './watch';
import { sendJob, sendKey } from './actions';

function KeysHead() {
  const ns = useRedis((s) => s.ns);
  const scan = useRedis((s) => s.scan);
  const snap = useRedis((s) => s.snap);
  const prefix = useMemo(() => frameworkPrefix((scan?.keys ?? []).map((k) => k.key), pickedOf({ snap })?.prefix ?? null), [scan?.keys, snap]);
  const space = useMemo(() => (ns === null ? null : groupNamespaces(scan?.keys ?? [], prefix).find((x) => x.name === ns) ?? null), [scan?.keys, ns, prefix]);
  if (ns === null) return <h2 className="dk-name">{t.redis.keys}</h2>;
  return (
    <>
      <h2 className="dk-name mono">{ns === NO_NAMESPACE ? t.redis.noNamespace : <>{prefix ?? ''}{ns}<span className="rd-dim">:*</span></>}</h2>
      {space && <span className="mono rd-dim dk-ellipsis">{scan?.done ? t.redis.nsSummary(space.count, fmtBytes(space.bytes), space.withTtl) : t.redis.nsApprox(space.count)}</span>}
    </>
  );
}

function InstanceHead() {
  const snap = useRedis((s) => s.snap);
  const info = useRedis((s) => s.status?.info);
  const pick = pickedOf({ snap });
  if (!pick) return null;
  const where = pick.endpoint.kind === 'tcp' ? `127.0.0.1:${pick.endpoint.port}` : pick.endpoint.path;
  return (
    <>
      <i className="dk-dot is-ok" aria-hidden="true" />
      <h2 className="dk-name rd-iname">{pick.server ? `${pick.server.name[0]!.toUpperCase()}${pick.server.name.slice(1)} ${pick.server.version}` : instanceTitle(pick)}</h2>
      {pick.server && <span className="rd-chip">{t.redis.header.mode[pick.server.mode]}</span>}
      <span className="rd-chip"><Icon name={pick.badge === 'docker' ? 'whale' : pick.badge === 'terminal' ? 'terminal' : 'redis'} size={11} />{pick.label}</span>
      <span className="mono rd-dim dk-ellipsis">{t.redis.header.line(where, info ? fmtUptime(info.uptime) : '…', pick.hint ? pick.hint.replace("this project's ", '') : null)}</span>
    </>
  );
}

function QueuesHead() {
  const queues: readonly QueueInfo[] = useRedis((s) => s.status?.queues) ?? NONE;
  const libs = [...new Set(queues.map((q) => q.lib))];
  const prefixes = [...new Set(queues.filter((q) => q.lib === 'bullmq' || q.lib === 'bull').map((q) => q.prefix))];
  const workers = queues.some((q) => q.workers !== null) ? queues.reduce((n, q) => n + (q.workers ?? 0), 0) : null;
  const label = libs.map((l) => ({ bullmq: 'BullMQ', bull: 'Bull', sidekiq: 'Sidekiq', laravel: 'Laravel', celery: 'Celery', rq: 'RQ', asynq: 'Asynq', resque: 'Resque' } as Record<string, string>)[l] ?? l).join(', ');
  return (
    <>
      <h2 className="dk-name">{t.redis.queues}</h2>
      <span className="mono rd-dim dk-ellipsis">{t.redis.queuesView.header(label, prefixes.length === 1 ? prefixes[0]! : '', queues.length, workers)}</span>
    </>
  );
}

export function RedisView({ view, visible, focused, place }: { view: View; visible: boolean; focused: boolean; place?: CSSProperties }) {
  const snap = useRedis((s) => s.snap);
  const root = useRef<HTMLElement>(null);
  const running = pickedOf({ snap })?.state === 'running';
  useRedisWatch('queues', visible && running && view === 'queues');
  useRedisWatch('overview', visible && running && (view === 'overview' || view === 'live'));
  useRedisWatch('live', visible && running && view === 'live');
  useEffect(() => { if (visible && focused && !root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true }); }, [visible, focused]);
  let head: React.ReactNode;
  let body: React.ReactNode;
  if (!running) body = <div className="dk-center"><RedisStateCard /></div>;
  else if (view === 'queues') { head = <QueuesHead />; body = <RedisQueues visible={visible} />; }
  else if (view === 'overview') { head = <InstanceHead />; body = <div className="rd-overview-wide"><OverviewColumn wide visible={visible} /></div>; }
  else if (view === 'live') { head = <InstanceHead />; body = <div className="rd-live-split"><OverviewColumn wide={false} visible={visible} /><RedisLive visible={visible} /></div>; }
  else { head = <KeysHead />; body = <RedisKeys visible={visible} />; }
  return (
    <section ref={root} tabIndex={-1} className="dk-view rd-view" data-view={view} style={{ display: visible ? 'flex' : 'none', ...place }} aria-label={`${t.redis.tab} · ${redisTabTitle(view)}`}
      onKeyDown={(e) => {
        // ⌥↩: the key (Keys) or the job (Queues) goes to the session, as the bar's Send does.
        if (e.key !== 'Enter' || !e.altKey || e.metaKey || e.ctrlKey || (e.target as HTMLElement).closest('input, textarea')) return;
        const r = useRedis.getState();
        if (view === 'keys' && r.key) { e.preventDefault(); sendKey(r.key); }
        else if (view === 'queues' && r.queue && r.job) { e.preventDefault(); void sendJob(r.queue, r.jobState, r.job.info.id); }
      }}>
      {running && (
        <div className="dk-head rd-head">
          {head}
        </div>
      )}
      {running && <ModeNote />}
      {running && <LimitedNote />}
      <div className="dk-body">{body}</div>
    </section>
  );
}
