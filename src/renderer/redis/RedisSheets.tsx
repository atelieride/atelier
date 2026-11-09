// Writes ask first: delete one key or a pattern, empty a database (typed confirmation), set a
// TTL, edit a value, retry or remove a job; then the 30-second Undo pill. Plus Settings › Redis › Instances.
import { useEffect, useRef, useState } from 'react';
import { displayKey, instanceTitle, normalizeCustom, type Preview } from '@shared/redis';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { instanceLabel, setTtl, undo as undoWrite, write } from './actions';
import { pickedOf, useRedis, type Sheet } from './store';
import { kbd } from '../kbd';

const e = () => t.redis.edits;

/** A centered sheet over the window: Esc or a click outside cancels; focus starts inside. */
function Modal({ label, danger, onClose, children }: { label: string; danger?: boolean; onClose: () => void; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector<HTMLElement>('[data-autofocus], input, button.is-default')?.focus(); }, []);
  return (
    <div className="rd-modal-layer" onMouseDown={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <div ref={box} className={`rd-modal ${danger ? 'is-danger' : ''}`} role="dialog" aria-modal="true" aria-label={label} data-own-esc=""
        onKeyDown={(ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); onClose(); } }}>
        {children}
      </div>
    </div>
  );
}

function DeleteSheet({ s }: { s: Extract<Sheet, { kind: 'delete' | 'deleteMatching' }> }) {
  const db = useRedis((x) => x.db);
  const pick = useRedis((x) => pickedOf(x));
  const [preview, setPreview] = useState<Preview | null>(s.kind === 'delete' ? { count: s.keys.length, sample: s.keys.slice(0, 3), capped: false, undo: true } : null);
  const [busy, setBusy] = useState(false);
  const close = () => useRedis.getState().setSheet(null);
  useEffect(() => {
    if (s.kind !== 'deleteMatching') return;
    const instance = useRedis.getState().snap?.pick ?? '';
    void window.atelier.redis.preview({ db, pattern: s.pattern, instance }).then(setPreview).catch(() => setPreview({ count: 0, sample: [], capped: false, undo: false }));
  }, [s, db]);
  const one = s.kind === 'delete' && s.keys.length === 1;
  const title = one ? e().deleteOne(displayKey(s.keys[0]!)) : e().deleteMany(preview?.count ?? 0);
  const run = async () => {
    if (!preview || preview.capped || !preview.count) return;
    setBusy(true);
    const op = s.kind === 'delete' ? { op: 'delete' as const, keys: s.keys } : { op: 'deleteMatching' as const, pattern: s.pattern };
    const ok = await write(op, (r) => (one ? e().deleted(displayKey(s.keys[0]!)) : e().deletedN(r.count)));
    setBusy(false);
    if (ok) close();
  };
  return (
    <Modal label={title} onClose={close}>
      <h3 className="rd-modal-title">{preview ? title : e().counting}</h3>
      {s.kind === 'deleteMatching' && <span className="mono rd-modal-where">{e().where(s.label, db, instanceLabel(pick))}</span>}
      {preview && preview.count > 0 && !one && (
        <div className="rd-modal-sample mono">
          {preview.sample.map((k) => <div key={k}>{displayKey(k)}</div>)}
          {preview.count > preview.sample.length && <div className="rd-dim">{e().more(preview.count - preview.sample.length)}</div>}
        </div>
      )}
      <p className="rd-modal-hint">{!preview ? '' : preview.capped ? e().tooMany : !preview.count ? e().noMatch : one ? e().oneHint : preview.undo ? e().batches : e().noUndoMany}</p>
      <div className="rd-modal-actions">
        <button type="button" className="btn-ghost" onClick={close}>{e().cancel}</button>
        <button type="button" className="btn-danger is-default" disabled={busy || !preview || preview.capped || !preview.count} onClick={() => void run()}>{e().deleteN(preview?.count ?? 0)}</button>
      </div>
    </Modal>
  );
}

function EmptySheet({ s }: { s: Extract<Sheet, { kind: 'empty' }> }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const close = () => useRedis.getState().setSheet(null);
  const ok = typed.trim() === `db${s.db}`;
  const run = async () => {
    if (!ok || busy) return;
    setBusy(true);
    if (await write({ op: 'flushdb' }, () => e().emptied(s.db), s.db)) close();
    setBusy(false);
  };
  return (
    <Modal label={e().emptyTitle(s.db)} danger onClose={close}>
      <h3 className="rd-modal-title">{e().emptyTitle(s.db)}</h3>
      <p className="rd-modal-hint">{e().emptyHint(s.keys, s.db)}</p>
      <form onSubmit={(ev) => { ev.preventDefault(); void run(); }}>
        <label className="rd-field"><input value={typed} onChange={(ev) => setTyped(ev.target.value)} placeholder={`db${s.db}`} aria-label={e().emptyHint(s.keys, s.db)} spellCheck={false} autoComplete="off" /></label>
        <div className="rd-modal-actions">
          <button type="button" className="btn-ghost" onClick={close}>{e().cancel}</button>
          <button type="submit" className="btn-danger" disabled={!ok || busy}>{e().emptyBtn(s.db)}</button>
        </div>
      </form>
    </Modal>
  );
}

function TtlPopover({ s }: { s: Extract<Sheet, { kind: 'ttl' }> }) {
  const [secs, setSecs] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const close = () => useRedis.getState().setSheet(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button')?.focus();
    const down = (ev: MouseEvent) => { if (!box.current?.contains(ev.target as Node)) close(); };
    window.addEventListener('mousedown', down, true);
    return () => window.removeEventListener('mousedown', down, true);
  }, []);
  const n = Number(secs);
  const valid = secs.trim() !== '' && Number.isInteger(n) && n > 0 && n <= 10 * 365 * 86400;
  const apply = (ms: number | null) => { setTtl(s.key, ms); close(); };
  const pos = s.x || s.y ? { left: Math.min(s.x, window.innerWidth - 260), top: Math.min(s.y, window.innerHeight - 220) } : { left: '50%', top: '30%', transform: 'translateX(-50%)' };
  return (
    <div ref={box} className="rd-ttl-pop" style={pos} role="dialog" aria-label={e().ttlTitle} data-own-esc="" onKeyDown={(ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); } }}>
      <span className="section-label">{e().ttlTitle}</span>
      <div className="rd-ttl-presets">
        {Object.entries(e().ttlPresets).map(([ms, label]) => <button key={ms} type="button" className="chip" onClick={() => apply(Number(ms))}>{label}</button>)}
      </div>
      <form className="rd-ttl-custom" onSubmit={(ev) => { ev.preventDefault(); if (valid) apply(n * 1000); }}>
        <input className="mono" value={secs} onChange={(ev) => setSecs(ev.target.value.replace(/[^\d]/g, ''))} placeholder={e().ttlSeconds} aria-label={e().ttlSeconds} inputMode="numeric" />
        <button type="submit" className="btn-ghost sm" disabled={!valid}>{e().apply}</button>
      </form>
      <button type="button" className="link-btn" onClick={() => apply(null)}>{e().ttlNone}</button>
    </div>
  );
}

function EditSheet({ s }: { s: Extract<Sheet, { kind: 'edit' }> }) {
  const value = useRedis((x) => (x.value?.key === s.key ? x.value.reply : null));
  const tg = s.target;
  const initial = (() => {
    if (tg.kind === 'hash' || tg.kind === 'list') return tg.value;
    if (tg.kind === 'zset') return String(tg.score);
    const b = value?.body;
    if (b?.kind === 'json') return JSON.stringify(b.value, null, 2);
    if (b?.kind === 'string') return b.format === 'json' && b.value !== undefined ? JSON.stringify(b.value, null, 2) : b.text ?? '';
    return '';
  })();
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const close = () => useRedis.getState().setSheet(null);
  const isJson = tg.kind === 'json' || (tg.kind === 'string' && value?.body.kind === 'string' && value.body.format === 'json');
  const bad = (() => {
    if (tg.kind === 'zset') return Number.isFinite(Number(text)) && text.trim() !== '' ? null : e().badNumber;
    if (isJson) { try { JSON.parse(text); return null; } catch { return e().badJson; } }
    return null;
  })();
  const title = tg.kind === 'hash' ? e().editField(tg.field) : tg.kind === 'list' ? e().editItem(tg.index) : tg.kind === 'zset' ? e().editScore(tg.member) : e().editTitle(displayKey(s.key));
  const save = async () => {
    if (bad || busy) return;
    setBusy(true);
    // JSON is stored compact, as an app would write it.
    const v = isJson ? JSON.stringify(JSON.parse(text)) : text;
    const op = tg.kind === 'hash' ? { op: 'hset' as const, key: s.key, field: tg.field, value: v }
      : tg.kind === 'list' ? { op: 'lset' as const, key: s.key, index: tg.index, value: v }
      : tg.kind === 'zset' ? { op: 'zscore' as const, key: s.key, member: tg.member, score: Number(text) }
      : tg.kind === 'json' ? { op: 'jsonSet' as const, key: s.key, value: v }
      : { op: 'setString' as const, key: s.key, value: v };
    if (await write(op, () => e().saved(displayKey(s.key)))) close();
    setBusy(false);
  };
  return (
    <Modal label={title} onClose={close}>
      <h3 className="rd-modal-title">{title}</h3>
      {tg.kind !== 'string' && tg.kind !== 'json' && <span className="mono rd-modal-where">{displayKey(s.key)}</span>}
      <textarea className="rd-edit mono" value={text} onChange={(ev) => setText(ev.target.value)} spellCheck={false} rows={tg.kind === 'zset' ? 1 : 14} data-autofocus=""
        onKeyDown={(ev) => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); void save(); } }} />
      {bad && <p className="rd-error" role="alert">{bad}</p>}
      <p className="rd-modal-hint">{value?.meta.ttl !== undefined && value.meta.ttl >= 0 ? e().editHintTtl : e().editHint}</p>
      <div className="rd-modal-actions">
        <button type="button" className="btn-ghost" onClick={close}>{e().cancel}</button>
        <button type="button" className="btn-primary" disabled={!!bad || busy} onClick={() => void save()}>{e().save}<span className="kbd-in">{kbd('⌘↩')}</span></button>
      </div>
    </Modal>
  );
}

function JobSheet({ s }: { s: Extract<Sheet, { kind: 'job' }> }) {
  const [busy, setBusy] = useState(false);
  const v = t.redis.queuesView;
  const close = () => useRedis.getState().setSheet(null);
  const retry = s.action === 'retry';
  const title = retry ? v.retryTitle(s.job.name, s.job.id) : v.removeTitle(s.job.name, s.job.id);
  const run = async () => {
    setBusy(true);
    if (await write({ op: s.action, queue: { id: s.queue }, id: s.job.id }, () => (retry ? v.retried(s.job.id) : v.removed(s.job.id)))) close();
    setBusy(false);
  };
  return (
    <Modal label={title} danger={!retry} onClose={close}>
      <h3 className="rd-modal-title">{title}</h3>
      {s.job.reason && <span className="mono rd-modal-where is-err">{s.job.reason}</span>}
      <p className="rd-modal-hint">{retry ? v.retryHint : v.removeHint}</p>
      <div className="rd-modal-actions">
        <button type="button" className="btn-ghost" onClick={close}>{e().cancel}</button>
        <button type="button" className={`${retry ? 'btn-primary' : 'btn-danger'} is-default`} disabled={busy} onClick={() => void run()}>{retry ? v.retry : v.remove}</button>
      </div>
    </Modal>
  );
}

/** Settings › Redis › Instances: what was found, your own (add a URL or socket), forget a password. */
export function InstancesSheet() {
  const snap = useRedis((x) => x.snap);
  const custom = useApp((x) => x.settings.redisInstances);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const i = t.redis.instances;
  const close = () => useRedis.getState().setSheet(null);
  const add = async () => {
    const n = normalizeCustom(draft);
    if (!n) { setError(i.bad); return; }
    // A password typed in the URL goes to the Keychain (main tries it), never into Settings.
    const pw = /^redis:\/\/([^:@/]*):([^@/]+)@/.exec(draft.trim());
    await window.atelier.settings.set({ redisInstances: [...new Set([...custom, n])] });
    if (pw) {
      const key = n.startsWith('/') ? `unix:${n}` : `tcp:${/:(\d+)/.exec(n.slice('redis://'.length))?.[1] ?? '6379'}`;
      setTimeout(() => void window.atelier.redis.auth({ key, password: decodeURIComponent(pw[2]!), ...(pw[1] ? { user: decodeURIComponent(pw[1]) } : {}) }).catch(() => {}), 1500);
    }
    setDraft('');
    setError(null);
    useApp.getState().showToast(i.added, undefined, 'info');
  };
  const remove = (url: string) => void window.atelier.settings.set({ redisInstances: custom.filter((x) => x !== url) });
  const detected = snap?.instances.filter((x) => x.badge !== 'custom') ?? [];
  return (
    <Modal label={i.title} onClose={close}>
      <h3 className="rd-modal-title">{i.title}</h3>
      <span className="section-label">{i.detected}</span>
      <div className="rd-inst-list">
        {detected.length ? detected.map((x) => (
          <div key={x.key} className="rd-inst-row">
            <i className={`rd-dot is-${x.state === 'running' ? 'ok' : x.state === 'auth' ? 'warn' : 'off'}`} aria-hidden="true" />
            <span className="mono">{instanceTitle(x)}</span>
            <span className={`rd-badge is-${x.badge}`}>{x.badge}</span>
            <span className="rd-dim dk-ellipsis">{x.hint ?? x.label}</span>
            <span className="grow" />
            {x.hasPassword && <button type="button" className="link-btn" onClick={() => { void window.atelier.redis.forget(x.key); useApp.getState().showToast(i.forgot, undefined, 'info'); }}>{i.forget}</button>}
          </div>
        )) : <p className="rd-dim">{i.none}</p>}
      </div>
      <span className="section-label">{i.custom}</span>
      <div className="rd-inst-list">
        {custom.length ? custom.map((url) => (
          <div key={url} className="rd-inst-row">
            <span className="mono">{url}</span>
            <span className="grow" />
            <button type="button" className="link-btn" onClick={() => remove(url)}>{i.remove}</button>
          </div>
        )) : <p className="rd-dim">{i.none}</p>}
      </div>
      <form className="rd-inst-add" onSubmit={(ev) => { ev.preventDefault(); void add(); }}>
        <input className="mono" value={draft} onChange={(ev) => { setDraft(ev.target.value); setError(null); }} placeholder={i.placeholder} aria-label={i.placeholder} spellCheck={false} autoComplete="off" data-autofocus="" />
        <button type="submit" className="btn-ghost sm" disabled={!draft.trim()}>{i.add}</button>
      </form>
      {error ? <p className="rd-error" role="alert">{error}</p> : <p className="rd-modal-hint">{i.passwordHint}</p>}
      <div className="rd-modal-actions"><button type="button" className="btn-primary is-default" onClick={close}>{i.done}</button></div>
    </Modal>
  );
}

/** The 30-second Undo after a write (bottom of the window). */
export function UndoPill() {
  const u = useRedis((x) => x.undo);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!u) return;
    const h = setInterval(() => {
      tick((n) => n + 1);
      if (Date.now() - u.at >= u.ms) useRedis.getState().setUndo(null);
    }, 250);
    return () => clearInterval(h);
  }, [u]);
  if (!u) return null;
  const left = Math.max(0, Math.min(Math.round(u.ms / 1000), Math.ceil((u.ms - (Date.now() - u.at)) / 1000)));
  return (
    <div className="rd-undo" role="status">
      <i className="rd-dot is-ok" aria-hidden="true" />
      <span className="dk-ellipsis">{u.text}</span>
      <button type="button" className="btn-ghost sm" onClick={() => void undoWrite()}>{e().undo}</button>
      <span className="mono rd-dim">{left} s</span>
      <button type="button" className="icon-btn" aria-label={e().dismiss} onClick={() => useRedis.getState().setUndo(null)}><Icon name="x" size={12} /></button>
    </div>
  );
}

export function RedisSheets() {
  const sheet = useRedis((x) => x.sheet);
  if (!sheet) return null;
  if (sheet.kind === 'delete' || sheet.kind === 'deleteMatching') return <DeleteSheet s={sheet} />;
  if (sheet.kind === 'empty') return <EmptySheet s={sheet} />;
  if (sheet.kind === 'ttl') return <TtlPopover s={sheet} />;
  if (sheet.kind === 'edit') return <EditSheet s={sheet} />;
  if (sheet.kind === 'job') return <JobSheet s={sheet} />;
  return <InstancesSheet />;
}

