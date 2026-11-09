// The Redis sidebar: the picked instance and its database, the key filter, the queues found and
// the key namespaces; a state card when the instance can't be read.
import { useEffect, useMemo, useRef, useState } from 'react';
import { NO_NAMESPACE, fmtCount, frameworkPrefix, groupNamespaces, instanceTitle, type RedisInstance } from '@shared/redis';
import { queueNamespaces } from '@shared/redis-queues';
import { Icon, type IconName } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { canEdit, ensureScan, instanceMenu, libLabel, nsMenu, openNamespace, openQueue, openRedis, queueMenu } from './actions';
import { RedisStateCard } from './RedisStates';
import { NONE, pickedOf, useRedis } from './store';
import { parseRedisKey } from './tabs';
import { useRedisWatch } from './watch';
import { queueDepth, queueDot } from './view';

const BADGE_ICON: Record<RedisInstance['badge'], IconName> = { docker: 'whale', terminal: 'terminal', custom: 'plug', brew: 'redis', local: 'redis' };

/** A small popover list under its button (instance and database pickers): arrows, Enter, Esc, a click outside. */
function Popover({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[aria-selected="true"], button')?.focus();
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener('mousedown', down, true);
    return () => window.removeEventListener('mousedown', down, true);
  }, [onClose]);
  return (
    <div ref={box} className="rd-pop" role="listbox" aria-label={label} data-own-esc=""
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const items = [...(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }}>
      {children}
    </div>
  );
}

function InstancePicker({ instances, pick }: { instances: RedisInstance[]; pick: RedisInstance }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div className="rd-picker-wrap">
      <button type="button" className={`rd-picker ${open ? 'is-open' : ''}`} aria-haspopup="listbox" aria-expanded={open} data-tip={t.redis.pickerTip} onClick={() => setOpen((o) => !o)}>
        <Icon name={BADGE_ICON[pick.badge]} size={12} stroke={1.8} />
        <span className="dk-ellipsis">{pick.label}</span>
        <Icon name="chevronDown" size={10} stroke={2} />
      </button>
      {open && (
        <Popover label={t.redis.picker} onClose={close}>
          <span className="section-label rd-pop-label">{t.redis.picker}</span>
          {instances.map((i) => (
            <button key={i.key} type="button" role="option" aria-selected={i.key === pick.key} className={`rd-pop-item ${i.key === pick.key ? 'is-on' : ''}`}
              onClick={() => { close(); void window.atelier.redis.pick(i.key); }}>
              <span className="rd-pop-row">
                <i className={`rd-dot is-${i.state === 'running' ? 'ok' : i.state === 'auth' ? 'warn' : 'off'}`} aria-hidden="true" />
                <span className="rd-pop-title">{instanceTitle(i)}</span>
                <span className={`rd-badge is-${i.badge}`}>{t.redis.badgeName(i.badge)}</span>
              </span>
              {i.hint && <span className="rd-pop-hint">{i.hint}</span>}
            </button>
          ))}
          <button type="button" className="rd-pop-add" onClick={() => { close(); useRedis.getState().setSheet({ kind: 'instances' }); }}>
            <Icon name="plus" size={12} />{t.redis.addInstance}
          </button>
        </Popover>
      )}
    </div>
  );
}

function DbPicker() {
  const db = useRedis((s) => s.db);
  const keyspace = useRedis((s) => s.status?.info?.keyspace) ?? NONE;
  const [open, setOpen] = useState(false);
  const dbs = useMemo(() => [...new Set([0, db, ...keyspace.map((k) => k.db)])].sort((a, b) => a - b), [keyspace, db]);
  const keysOf = (n: number) => keyspace.find((k) => k.db === n)?.keys ?? 0;
  const close = () => setOpen(false);
  return (
    <div className="rd-picker-wrap">
      <button type="button" className={`rd-picker rd-db mono ${open ? 'is-open' : ''}`} aria-haspopup="listbox" aria-expanded={open} aria-label={t.redis.db} onClick={() => setOpen((o) => !o)}>
        db{db}<Icon name="chevronDown" size={10} stroke={2} />
      </button>
      {open && (
        <Popover label={t.redis.db} onClose={close}>
          <span className="section-label rd-pop-label">{t.redis.db}</span>
          {dbs.map((n) => (
            <button key={n} type="button" role="option" aria-selected={n === db} className={`rd-pop-item is-db ${n === db ? 'is-on' : ''}`} onClick={() => { close(); useRedis.getState().setDb(n); }}>
              <span className="rd-pop-row"><span className="mono rd-pop-title">db{n}</span><span className="grow" /><span className="mono rd-dim">{t.redis.dbKeys(keysOf(n))}</span></span>
            </button>
          ))}
          {canEdit() && keysOf(db) > 0 && (
            <button type="button" className="rd-pop-add is-danger" onClick={() => { close(); useRedis.getState().setSheet({ kind: 'empty', db, keys: keysOf(db) }); }}>
              <Icon name="trash" size={12} />{t.redis.emptyDb(db)}
            </button>
          )}
        </Popover>
      )}
    </div>
  );
}

export function RedisList() {
  const snap = useRedis((s) => s.snap);
  const status = useRedis((s) => s.status);
  const scan = useRedis((s) => s.scan);
  const ns = useRedis((s) => s.ns);
  const filter = useRedis((s) => s.filter);
  const db = useRedis((s) => s.db);
  const edits = useApp((s) => s.settings.redisEdits);
  // The Redis tab in front lights its sidebar row.
  const activeView = useApp((s) => parseRedisKey(s.activeTab));
  const queueSel = useRedis((s) => s.queue);
  const [draft, setDraft] = useState(filter);
  const pick = pickedOf({ snap });
  const running = pick?.state === 'running';
  useRedisWatch('sidebar', true);
  useEffect(() => { const h = setTimeout(() => useRedis.getState().setFilter(draft), 300); return () => clearTimeout(h); }, [draft]);
  useEffect(() => { if (running) ensureScan(); }, [running, snap?.pick, db, filter]);

  const keys = scan?.keys ?? [];
  const prefix = useMemo(() => frameworkPrefix(keys.map((k) => k.key), pick?.prefix ?? null), [keys, pick?.prefix]);
  const queues = status?.queues ?? [];
  const owned = useMemo(() => new Set(queueNamespaces(queues, prefix)), [queues, prefix]);
  const spaces = useMemo(() => groupNamespaces(keys, prefix), [keys, prefix]);
  const mine = spaces.filter((s) => !owned.has(s.name));
  const theirs = spaces.filter((s) => owned.has(s.name));
  const max = Math.max(1, ...mine.map((s) => s.count));
  const libs = [...new Set(queues.map((q) => libLabel(q.lib)))];
  const partial = !!scan && !scan.done;

  return (
    <>
      <div className="sidebar-head">
        <span className="section-label">{t.redis.title}</span>
        <span className="grow" />
        {running && pick && (
          <button type="button" className={`dk-engine-chip ${activeView === 'overview' || activeView === 'live' ? 'is-on' : ''}`} data-tip={t.redis.instanceTip}
            onClick={() => openRedis('overview')} onContextMenu={(e) => useApp.getState().openMenu(e, instanceMenu(pick))}>
            <i className="dk-dot is-ok" aria-hidden="true" /><span className="mono">{instanceTitle(pick)}</span>
          </button>
        )}
      </div>
      {snap && snap.instances.length > 0 && pick && (
        <div className="rd-pickers">
          <InstancePicker instances={snap.instances} pick={pick} />
          {running && <DbPicker />}
        </div>
      )}
      {!running ? <div className="rd-side-state"><RedisStateCard compact /></div> : (
        <>
          <label className="dk-filter">
            <Icon name="search" size={13} />
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t.redis.filter} aria-label={t.redis.filter} spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Escape' && draft) { e.stopPropagation(); setDraft(''); } }} />
          </label>
          <div className="rd-list">
            {queues.length > 0 && (
              <>
                <div className="rd-section">
                  <span className="section-label">{t.redis.queues}</span>
                  {libs.map((l) => <span key={l} className="rd-lib">{l}</span>)}
                  <span className="grow" />
                  <span className="mono rd-count">{queues.length}</span>
                </div>
                {queues.map((q) => {
                  const dot = queueDot(q);
                  const failed = q.counts.failed ?? 0;
                  return (
                    <button key={q.id} type="button" className={`rd-row ${activeView === 'queues' && queueSel === q.id ? 'is-selected' : ''}`}
                      onClick={() => openQueue(q.id)} onContextMenu={(e) => useApp.getState().openMenu(e, queueMenu(q))}>
                      <i className={`rd-dot is-${dot}`} aria-hidden="true" />
                      <span className="rd-row-name dk-ellipsis">{q.name}</span>
                      {failed > 0 && <span className="rd-pill is-err mono">{t.redis.queuesView.failedBadge(failed)}</span>}
                      {q.counts.paused && <span className="rd-pill is-warn mono">{t.redis.queuesView.paused}</span>}
                      <span className="mono rd-count">{queueDepth(q)}</span>
                    </button>
                  );
                })}
              </>
            )}
            <div className="rd-section">
              <span className="section-label">{t.redis.keys}</span>
              {prefix && <span className="rd-lib mono" data-tip={t.redis.prefix(prefix)}>{prefix}</span>}
              <span className="grow" />
              <span className="mono rd-count">{partial ? '~' : ''}{fmtCount(keys.length)}</span>
            </div>
            {scan && (scan.limited || (scan.running && scan.total > 20_000)) && (
              <div className="rd-scan-note" role="status">
                <div className="rd-scan-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.round((scan.keys.length / Math.max(1, scan.total)) * 100))}%` }} /></div>
                <p>{t.redis.states.big(scan.keys.length)}</p>
              </div>
            )}
            {mine.map((s) => {
              const on = ns === s.name && activeView === 'keys';
              return (
                <button key={s.name || '∅'} type="button" className={`rd-row is-ns ${on ? 'is-selected' : ''}`} aria-current={on || undefined}
                  onClick={() => openNamespace(s.name)} onContextMenu={(e) => useApp.getState().openMenu(e, nsMenu(s.name, prefix))}>
                  <Icon name="chevron" size={12} stroke={1.9} />
                  <span className="rd-row-name mono dk-ellipsis">{s.name === NO_NAMESPACE ? t.redis.noNamespace : <>{s.name}<span className="rd-dim">:</span></>}</span>
                  <span className="rd-bar" aria-hidden="true"><i style={{ width: `${Math.max(4, (s.count / max) * 100)}%` }} /></span>
                  <span className="mono rd-count">{partial ? '~' : ''}{fmtCount(s.count)}</span>
                </button>
              );
            })}
            {theirs.map((s) => (
              <button key={`q:${s.name}`} type="button" className="rd-row is-ns is-owned" onClick={() => openRedis('queues')}>
                <Icon name="list" size={12} stroke={1.9} />
                <span className="rd-row-name mono">{s.name}<span className="rd-dim">:</span></span>
                <span className="rd-owned">{t.redis.shownInQueues}</span>
                <span className="mono rd-count">{fmtCount(s.count)}</span>
              </button>
            ))}
            {scan?.done && keys.length === 0 && <p className="empty">{filter.trim() ? t.redis.list.emptyFiltered : t.redis.list.empty}</p>}
          </div>
        </>
      )}
      {/* The list fills the sidebar itself; a state card leaves the space to this one. */}
      {!running && <span className="grow" />}
      <div className="services-foot rd-foot"><Icon name="lock" size={13} />{edits === 'ask' ? t.redis.foot : t.redis.footReadOnly}</div>
    </>
  );
}
