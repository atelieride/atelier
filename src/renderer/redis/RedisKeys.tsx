// The Keys view: the open namespace's keys (type, TTL, size; virtualized), the scan's progress
// and Delete matching, and the value pane of the picked key.
import { useEffect, useMemo, useRef, useState } from 'react';
import { displayKey, fmtTtl, frameworkPrefix, namespacePattern, NO_NAMESPACE } from '@shared/redis';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { canEdit, keepScanning, keyMenu, keysOf, stopScan } from './actions';
import { ValuePane } from './RedisValue';
import { pickedOf, useRedis } from './store';
import { splitKey, tickTtl, typeClass, typeLabel } from './view';

const ROW = 30;

export function RedisKeys({ visible }: { visible: boolean }) {
  const scan = useRedis((s) => s.scan);
  const ns = useRedis((s) => s.ns);
  const key = useRedis((s) => s.key);
  const noTtl = useRedis((s) => s.noTtl);
  const snap = useRedis((s) => s.snap);
  const edits = useApp((s) => s.settings.redisEdits === 'ask');
  const pick = pickedOf({ snap });
  const prefix = useMemo(() => frameworkPrefix((scan?.keys ?? []).map((k) => k.key), pick?.prefix ?? null), [scan?.keys, pick?.prefix]);
  const keys = useMemo(() => keysOf(scan, ns, prefix, noTtl), [scan, ns, prefix, noTtl]);
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (!visible) return; const h = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(h); }, [visible]);
  // The first key of a namespace opens when none is picked.
  useEffect(() => { if (visible && keys.length && (!key || !keys.some((k) => k.key === key))) useRedis.getState().setKey(keys[0]!.key); }, [visible, keys, key]);
  const first = Math.max(0, Math.floor(top / ROW) - 5);
  const shown = keys.slice(first, first + Math.ceil(height / ROW) + 10);
  const l = t.redis.list;
  const est = scan && !scan.done && scan.scanned > 0 ? Math.round(keys.length * Math.max(1, scan.total / Math.max(1, scan.scanned))) : null;
  const move = (dir: 1 | -1) => {
    const i = keys.findIndex((k) => k.key === key);
    const next = keys[Math.min(keys.length - 1, Math.max(0, i + dir))];
    if (!next) return;
    useRedis.getState().setKey(next.key);
    const y = keys.indexOf(next) * ROW;
    const el = box.current;
    if (el && (y < el.scrollTop || y + ROW > el.scrollTop + el.clientHeight)) el.scrollTop = y - el.clientHeight / 2;
  };
  return (
    <div className="rd-keys">
      <section className="rd-klist" aria-label={l.listLabel}>
        <div className="rd-krow is-head" aria-hidden="true"><span>{l.type}</span><span>{l.key}</span><span className="is-right">{l.ttl}</span><span className="is-right">{l.size}</span></div>
        {noTtl && <div className="rd-filter-chip"><span>{l.noTtl}</span><button type="button" className="link-btn" onClick={() => useRedis.getState().setNoTtl(false)}>{l.clearNoTtl}</button></div>}
        <div ref={box} className="rd-kscroll" tabIndex={0} role="listbox" aria-label={l.listLabel} onScroll={(e) => setTop(e.currentTarget.scrollTop)}
          onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); move(1); } if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); move(-1); } }}>
          <div style={{ height: keys.length * ROW, position: 'relative' }}>
            {shown.map((k, i) => {
              const { pre, rest } = splitKey(k.key, prefix);
              const ttl = tickTtl(k.ttl, scan?.at ?? now, now);
              const tc = typeClass(k.type, null);
              return (
                <button key={k.key} type="button" role="option" aria-selected={k.key === key} className={`rd-krow ${k.key === key ? 'is-selected' : ''}`}
                  style={{ position: 'absolute', top: (first + i) * ROW, left: 0, right: 0 }}
                  onClick={() => useRedis.getState().setKey(k.key)} onContextMenu={(e) => useApp.getState().openMenu(e, keyMenu(k))}>
                  <span className={`rd-ty is-${tc}`}>{typeLabel(k.type)}</span>
                  <span className="rd-kname mono"><span className="rd-dim">{displayKey(pre)}</span>{displayKey(rest)}</span>
                  <span className={`mono is-right ${ttl >= 0 && ttl < 60_000 ? 'is-hot' : ''}`}>{ttl < 0 ? l.none : fmtTtl(ttl)}</span>
                  <span className="mono is-right rd-dim">{k.size !== null ? fmtSize(k.size) : '—'}</span>
                </button>
              );
            })}
          </div>
          {ns === null && <p className="rd-pane-empty">{l.pick}</p>}
          {ns !== null && scan?.done && keys.length === 0 && <p className="rd-pane-empty">{l.empty}</p>}
        </div>
        <div className="rd-kfoot">
          <span className="mono">{est !== null ? l.scanPartial(keys.length, est) : l.scan(keys.length)}</span>
          {scan?.running && <span className="rd-dim">· {l.scanning}</span>}
          {scan?.running && <button type="button" className="link-btn" onClick={stopScan}>{l.stop}</button>}
          {scan?.limited && <><span className="rd-dim">· {l.stopped(scan.keys.length)}</span><button type="button" className="link-btn" onClick={keepScanning}>{l.keep}</button></>}
          <span className="grow" />
          {edits && canEdit() && ns !== null && ns !== NO_NAMESPACE && keys.length > 0 && (
            <button type="button" className="rd-chip-btn" onClick={() => useRedis.getState().setSheet({ kind: 'deleteMatching', pattern: namespacePattern(ns, prefix), label: `${prefix ?? ''}${ns}:*` })}>{l.deleteMatching}</button>
          )}
        </div>
      </section>
      {key && keys.some((k) => k.key === key) ? <ValuePane k={key} visible={visible} /> : <div className="rd-pane"><p className="rd-pane-empty">{t.redis.value.pick}</p></div>}
    </div>
  );
}

const fmtSize = (b: number) => (b < 1000 ? `${b} B` : b < 1024 * 1000 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

