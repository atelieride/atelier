// Overview: memory, ops, hit ratio, expired/evicted with their sparklines; hints that read the
// numbers honestly; keyspace and persistence; the clients matched to terminals and containers. Wide in the Overview
// tab, a column beside the monitor in Live.
import { useEffect, useMemo, useState } from 'react';
import { fmtBytes, fmtCount, frameworkPrefix, groupNamespaces, hints, shortCount, type Hint } from '@shared/redis';
import { cacheOnlyRatio } from '@shared/redis-monitor';
import { queueKeyTest } from '@shared/redis-queues';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useDocker } from '../docker/store';
import { Sparkline } from '../docker/Sparkline';
import { openNamespace } from './actions';
import { pickedOf, useRedis } from './store';
import { agoText, cacheNoTtl, deltaSeries, hitSeries, keyspaceBar, peakOps } from './view';

function Tile({ label, value, sub, spark, tone, floor }: { label: string; value: string; sub: string; spark: number[]; tone: 'violet' | 'pink' | 'sky' | 'done' | 'error' | 'dim'; floor: number }) {
  return (
    <div className="rd-tile">
      <span className="section-label">{label}</span>
      <div className="rd-tile-row">
        <span className="mono rd-tile-v">{value}</span>
        <span className="mono rd-tile-sub dk-ellipsis">{sub}</span>
        <span className="grow" />
        <Sparkline values={spark} width={110} height={28} floor={floor} tone={tone} />
      </div>
    </div>
  );
}

function HintNote({ h }: { h: Hint }) {
  const o = t.redis.overview;
  if (h.id === 'queue-polling') {
    return <div className="rd-note is-info" role="note"><Icon name="info" size={14} /><span>{o.queuePolling} {h.cacheOnly !== null && h.cacheOnly !== undefined ? <b>{o.cacheOnly(Math.round(h.cacheOnly * 100))}</b> : o.openLive}</span></div>;
  }
  if (h.id === 'no-ttl') {
    return (
      <div className="rd-note is-amber" role="note"><Icon name="warning" size={14} />
        <span>{o.noTtl(h.count ?? 0, `${h.ns}:`)} <button type="button" className="link-btn" onClick={() => { useRedis.getState().setNs(h.ns!); useRedis.getState().setNoTtl(true); openNamespace(h.ns!); useRedis.getState().setNoTtl(true); }}>{o.showThem}</button></span>
      </div>
    );
  }
  return <div className="rd-note is-amber" role="note"><Icon name="warning" size={14} /><span>{h.id === 'evicting' ? o.evicting(h.count ?? 0) : o.rdbFailing}</span></div>;
}

function Clients({ visible }: { visible: boolean }) {
  const clients = useRedis((s) => s.clients);
  const denied = useRedis((s) => s.status?.denied.includes('clients') ?? false);
  useEffect(() => {
    if (!visible) return;
    const load = () => void window.atelier.redis.clients().then((c) => useRedis.getState().setClients(c)).catch(() => {});
    load();
    const h = setInterval(load, 2000);
    return () => clearInterval(h);
  }, [visible]);
  const o = t.redis.overview;
  return (
    <div className="rd-clients">
      <div className="rd-card-head"><span className="section-label">{o.clients}</span><span className="mono rd-dim">{clients.length}</span><span className="grow" /><span className="rd-dim rd-small-text">{o.clientsNote}</span></div>
      {denied ? <p className="rd-pane-note">{o.noClients}</p> : (
        <div className="rd-table-box">
          <table className="rd-table mono">
            <thead><tr><th>{o.cols.client}</th><th>{o.cols.from}</th><th>{o.cols.cmd}</th><th className="is-right">{o.cols.idle}</th></tr></thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id}>
                  <td><span className={`rd-tag is-${c.kind}`}>{c.name}</span></td>
                  <td className="rd-from">{c.from}</td>
                  <td className={`rd-cmd is-${cmdClass(c.cmd)} dk-ellipsis`}>{c.cmd}</td>
                  <td className="is-right rd-dim">{c.idle} s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const cmdClass = (cmd: string) => {
  const c = cmd.split(' ')[0]!.toUpperCase();
  return /^(GET|MGET|HGET|HGETALL|LRANGE|SMEMBERS|ZRANGE|XRANGE|SCAN|EXISTS|TTL|TYPE)$/.test(c) ? 'read' : /^(EVAL|EVALSHA|FCALL)/.test(c) ? 'script' : /^(DEL|UNLINK|HDEL|SREM|ZREM)$/.test(c) ? 'del' : /^(SET|HSET|LPUSH|RPUSH|SADD|ZADD|INCR|EXPIRE|XADD)/.test(c) ? 'write' : 'other';
};

const DATA_DIRS = ['/data', '/var/lib/redis', '/bitnami/redis/data', '/bitnami/valkey/data', '/var/lib/valkey'];

/** The volume or folder a Redis container keeps its data in: a name, null when none (lost with the container), undefined while reading. */
function useDataMount(id: string | null): string | null | undefined {
  const [mount, setMount] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!id) { setMount(undefined); return; }
    let live = true;
    void window.atelier.docker.inspect(id).then((r) => {
      if (!live) return;
      const m = r?.detail.mounts.find((x) => DATA_DIRS.includes(x.target));
      setMount(m ? m.name ?? m.source : r ? null : undefined);
    }).catch(() => { if (live) setMount(undefined); });
    return () => { live = false; };
  }, [id]);
  return mount;
}

export function OverviewColumn({ wide, visible }: { wide: boolean; visible: boolean }) {
  const status = useRedis((s) => s.status);
  const scan = useRedis((s) => s.scan);
  const snap = useRedis((s) => s.snap);
  const lines = useRedis((s) => s.lines);
  const db = useRedis((s) => s.db);
  const containers = useDocker((s) => s.containers);
  const info = status?.info ?? null;
  const samples = status?.samples ?? [];
  const pick = pickedOf({ snap });
  const prefix = useMemo(() => frameworkPrefix((scan?.keys ?? []).map((k) => k.key), pick?.prefix ?? null), [scan?.keys, pick?.prefix]);
  const queues = status?.queues ?? [];
  const isQueueKey = useMemo(() => queueKeyTest(queues), [queues]);
  const cacheOnly = useMemo(() => cacheOnlyRatio(lines, Date.now(), isQueueKey), [lines, isQueueKey]);
  const noTtl = useMemo(() => cacheNoTtl(scan?.keys ?? [], prefix), [scan?.keys, prefix]);
  const o = t.redis.overview;
  if (!info) return <div className={`rd-ov ${wide ? 'is-wide' : ''}`}><p className="rd-pane-note">{status?.denied.includes('info') ? o.noInfo : t.redis.value.loading}</p></div>;
  const tl = o.tiles;
  const peak = peakOps(samples);
  const total = info.hits + info.misses;
  const ratio = total ? Math.round((info.hits / total) * 100) : 0;
  const hs = hints(info, { queues: queues.length > 0, cacheOnly, cacheNoTtl: noTtl });
  const spaces = groupNamespaces(scan?.keys ?? [], prefix);
  const bar = keyspaceBar(spaces);
  const tones = ['violet', 'pink', 'sky', 'done'] as const;
  const mount = useDataMount(pick?.container?.id ?? null);
  void containers;
  return (
    <div className={`rd-ov ${wide ? 'is-wide' : ''}`}>
      <div className="rd-tiles">
        <Tile label={tl.memory} value={fmtBytes(info.usedMemory)} sub={info.maxmemory ? o.ofMax(fmtBytes(info.maxmemory)) : o.noLimit(fmtBytes(info.peakMemory))} spark={samples.map((s) => s.usedMemory)} tone="pink" floor={1024 * 1024} />
        <Tile label={tl.ops} value={fmtCount(info.ops)} sub={peak ? o.peakAt(peak.ops, new Date(peak.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })) : ''} spark={samples.map((s) => s.ops)} tone="violet" floor={5} />
        <Tile label={tl.hit} value={`${ratio}%`} sub={o.hits(shortCount(info.hits), shortCount(info.misses))} spark={hitSeries(samples)} tone={ratio < 50 ? 'dim' : 'done'} floor={100} />
        <Tile label={tl.expired} value={fmtCount(info.expired)} sub={o.evicted(info.evicted)} spark={deltaSeries(samples, (s) => s.expired)} tone={info.evicted ? 'error' : 'sky'} floor={1} />
      </div>
      {hs.length > 0 && <div className="rd-notes">{hs.map((h) => <HintNote key={h.id} h={h} />)}</div>}
      <div className="rd-cards2">
        <div className="rd-card">
          <span className="section-label">{o.keyspace}</span>
          {info.keyspace.map((k) => (
            <div key={k.db} className={`rd-card-line mono ${k.db === db ? 'is-current' : ''}`}><span>db{k.db}</span><span className="rd-dim">{o.dbLine(k.keys, k.expires)}</span></div>
          ))}
          {bar.length > 0 && (
            <>
              <div className="rd-stack-bar" aria-hidden="true">{bar.map((b, i) => <i key={b.name} className={`tone-${tones[i] ?? 'dim'}`} style={{ width: `${b.pct}%` }} />)}</div>
              <div className="rd-legend">{bar.map((b) => <span key={b.name}>{b.name === 'other' ? o.other : b.name} {b.pct}%</span>)}</div>
            </>
          )}
        </div>
        <div className="rd-card">
          <span className="section-label">{o.persistence}</span>
          <div className="rd-card-line mono"><span>{o.rdb}</span><span className="rd-dim">{info.rdbLastSave ? o.saved(agoText(Date.now() - info.rdbLastSave), info.rdbChanges) : o.neverSaved}</span></div>
          <div className="rd-card-line mono"><span>{o.aof}</span><span className="rd-dim">{info.aof ? o.onRewrite(info.aofStatus) : o.off}</span></div>
          {pick?.container ? (
            mount === undefined ? null : mount ? (
              <>
                <div className="rd-card-line mono"><span>{o.volume}</span><span className="rd-dim dk-ellipsis">{mount}</span></div>
                <span className="rd-small-text rd-dim">{o.survives}</span>
              </>
            ) : <span className="rd-small-text is-amber">{o.ephemeral}</span>
          ) : status?.dir ? <div className="rd-card-line mono"><span>{o.dir}</span><span className="rd-dim" data-tip={status.dir}>{status.dir}</span></div> : null}
        </div>
      </div>
      <Clients visible={visible} />
    </div>
  );
}
