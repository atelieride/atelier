// Live: the MONITOR stream while this pane is on screen — colored by what each command does,
// filtered by key, reads/writes/queue scripts, pausable, misses marked — and the slow log.
import { useEffect, useMemo, useRef } from 'react';
import { classifyCommand, displayArgs } from '@shared/redis-monitor';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { askSlowlog } from './actions';
import { useRedis } from './store';
import { liveMatches } from './view';

function Slowlog({ visible }: { visible: boolean }) {
  const slow = useRedis((s) => s.slow);
  const denied = useRedis((s) => s.status?.denied.includes('slowlog') ?? false);
  useEffect(() => {
    if (!visible) return;
    const load = () => void window.atelier.redis.slowlog().then((x) => useRedis.getState().setSlow(x)).catch(() => {});
    load();
    const h = setInterval(load, 5000);
    return () => clearInterval(h);
  }, [visible]);
  const l = t.redis.live;
  const ms = slow?.threshold !== null && slow?.threshold !== undefined ? Math.round(slow.threshold / 1000) : null;
  return (
    <div className="rd-slow">
      <div className="rd-card-head">
        <span className="section-label">{l.slowlog}</span>
        <span className="mono rd-dim">{l.over(ms, slow?.entries.length ?? 0)}</span>
        <span className="grow" />
        {!!slow?.entries.length && <button type="button" className="dk-engine-chip" onClick={() => void askSlowlog()}><Icon name="sparkle" size={11} />{l.ask}</button>}
      </div>
      {denied ? <p className="rd-pane-note">{l.slowDenied}</p> : !slow?.entries.length ? <p className="rd-pane-note">{l.noSlow}</p> : slow.entries.slice(0, 5).map((e) => (
        <div key={e.id} className="rd-slow-row mono">
          <span className="rd-dim">{new Date(e.at).toLocaleTimeString('en-GB')}</span>
          <span className="is-warn">{(e.micros / 1000).toFixed(e.micros < 10_000 ? 1 : 0)} ms</span>
          <span className="dk-ellipsis">{e.command}{e.client && <span className="rd-dim"> · {e.client}</span>}</span>
        </div>
      ))}
    </div>
  );
}

export function RedisLive({ visible }: { visible: boolean }) {
  const lines = useRedis((s) => s.lines);
  const paused = useRedis((s) => s.paused);
  const misses = useRedis((s) => s.misses);
  const reads = useRedis((s) => s.showReads);
  const writes = useRedis((s) => s.showWrites);
  const scripts = useRedis((s) => s.showScripts);
  const filter = useRedis((s) => s.liveFilter);
  const clients = useRedis((s) => s.clients);
  const denied = useRedis((s) => s.status?.denied.includes('monitor') ?? false);
  const on = useApp((s) => s.settings.redisMonitor);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const names = useMemo(() => new Map(clients.map((c) => [c.addr, { name: c.name, kind: c.kind }])), [clients]);
  const shown = useMemo(() => (paused ?? lines).filter((l) => {
    const k = classifyCommand(l.cmd);
    if (k === 'script' ? !scripts : k === 'read' || k === 'other' ? !reads : !writes) return false;
    return liveMatches(filter, l.cmd === 'EVALSHA' || l.cmd === 'EVAL' ? l.args.slice(2) : l.args);
  }).slice(-600), [lines, paused, reads, writes, scripts, filter]);
  useEffect(() => { if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight; }, [shown]);
  const l = t.redis.live;
  const toggle = (k: 'showReads' | 'showWrites' | 'showScripts', v: boolean) => useRedis.getState().setLiveToggle(k, v);
  return (
    <section className="rd-live" aria-label={l.monitor}>
      <div className="rd-live-bar">
        <span className="rd-live-title"><i className={`rd-dot is-ok ${paused || !on || denied ? '' : 'is-live'}`} aria-hidden="true" />{l.monitor}</span>
        <label className="dk-filter rd-live-filter">
          <Icon name="search" size={13} />
          <input value={filter} onChange={(e) => useRedis.getState().setLiveFilter(e.target.value)} placeholder={l.filter} aria-label={l.filterLabel} spellCheck={false} />
        </label>
        <button type="button" className={`chip ${reads ? 'is-on' : ''}`} aria-pressed={reads} onClick={() => toggle('showReads', !reads)}>{l.reads}</button>
        <button type="button" className={`chip ${writes ? 'is-on' : ''}`} aria-pressed={writes} onClick={() => toggle('showWrites', !writes)}>{l.writes}</button>
        <button type="button" className={`chip ${scripts ? 'is-on' : ''}`} aria-pressed={scripts} onClick={() => toggle('showScripts', !scripts)}>{l.scripts}</button>
        <span className="grow" />
        <button type="button" className="btn-ghost sm" onClick={() => useRedis.getState().setPaused(!paused)}>{paused ? l.resume : l.pause}</button>
      </div>
      <div className="rd-live-strip">{!on ? l.off : denied ? l.denied : l.strip}</div>
      <div ref={box} className="rd-live-lines mono" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24; }}>
        {shown.length === 0 && on && !denied && <p className="rd-pane-note">{l.waiting}</p>}
        {shown.map((x) => {
          const who = names.get(x.addr);
          const kind = classifyCommand(x.cmd);
          return (
            <div key={x.seq} className="rd-ml">
              <span className="rd-dim">{new Date(x.at).toLocaleTimeString('en-GB', { hour12: false })}.{String(x.at % 1000).padStart(3, '0')}</span>
              <span className={`rd-tag is-${who?.kind ?? (x.addr === 'lua' ? 'queue' : 'unnamed')} dk-ellipsis`}>{who ? who.name : x.addr}</span>
              <span className="rd-dim">{x.db}</span>
              <span className={`rd-cmd is-${kind}`}>{x.cmd}</span>
              <span className="dk-ellipsis">{displayArgs(x.cmd, x.args)}{misses.has(x.seq) && <span className="rd-miss"> {l.miss}</span>}</span>
            </div>
          );
        })}
      </div>
      <Slowlog visible={visible} />
    </section>
  );
}
