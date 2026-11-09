// The value pane: the key's type, TTL ticking, memory, encoding, length, last access; the value
// read by its type (JSON tree, tables, a counter, hex); Set TTL, Edit, Delete; the floating bar to Claude and copy.
import { useEffect, useMemo, useState } from 'react';
import { MASK, displayKey, fmtBytes, fmtTtlLong, maskField, maskTree, type RedisValueReply, type ValueBody } from '@shared/redis';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { sendTarget } from '../docker/actions';
import { askKey, canEdit, cliOf, copyCli, copyValue, copyWithToast, editBlocker, hasMore, loadValue, sendKey } from './actions';
import { useRedis } from './store';
import { jsonLines, tickTtl, typeClass, typeLabel, type JsonLine } from './view';
import { kbd } from '../kbd';

/** The JSON tree: line numbers, folds, colors; a click on a fold toggles it. */
export function JsonView({ value, folds, onToggle }: { value: unknown; folds: ReadonlySet<string>; onToggle: (p: string) => void }) {
  const lines = useMemo(() => jsonLines(value, folds), [value, folds]);
  const v = t.redis.value;
  return (
    <div className="rd-json mono" role="tree">
      {lines.map((l: JsonLine, i) => (
        <div key={l.id} className={`rd-jl ${l.path ? 'is-foldable' : ''}`} role="treeitem" aria-expanded={l.path ? !l.folded : undefined}>
          <span className="rd-jn" aria-hidden="true">{i + 1}</span>
          <span className="rd-ji" style={{ width: `${l.depth * 2}ch` }} />
          {l.more ? <span className="rd-jp">{v.moreItems(l.more)}</span> : (
            <>
              {l.key !== null && <><span className="rd-jk">{JSON.stringify(l.key)}</span><span className="rd-jp">: </span></>}
              {l.path ? (
                <button type="button" className={`rd-jfold rd-j-${l.cls}`} onClick={() => onToggle(l.path!)} aria-label={l.folded ? 'Expand' : 'Collapse'}>
                  {/* Its text in a span: a narrow panel (the Databases inspector) ellipsizes the preview, keeps the chip. */}
                  <span className="rd-jtext">{l.text}</span>{l.folded && <span className="rd-jchip">{l.isArray ? v.itemsFold(l.count ?? 0) : v.keysFold(l.count ?? 0)}</span>}
                </button>
              ) : <span className={`rd-j-${l.cls}`}>{l.text}</span>}
              {l.comma && <span className="rd-jp">,</span>}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function Masked({ id, field, value }: { id: string; field: string; value: string }) {
  const revealed = useRedis((s) => s.revealed.has(id));
  if (!maskField(field) || revealed) {
    return <>{value}{maskField(field) && <button type="button" className="rd-eye" aria-label={t.redis.value.hide} onClick={() => useRedis.getState().toggleReveal(id)}><Icon name="eye" size={12} /></button>}</>;
  }
  return <span className="rd-masked">{MASK} {t.redis.value.masked}<button type="button" className="rd-eye" aria-label={t.redis.value.reveal} onClick={() => useRedis.getState().toggleReveal(id)}><Icon name="eye" size={12} /></button></span>;
}

const isNum = (s: string) => /^-?\d+(\.\d+)?$/.test(s);
const jsonOf = (s: string): unknown => { if (!/^\s*[[{]/.test(s)) return undefined; try { return JSON.parse(s) as unknown; } catch { return undefined; } };

function Cell({ id, field, value }: { id: string; field: string; value: string }) {
  const [open, setOpen] = useState(false);
  const folds = useRedis((s) => s.folds);
  const json = useMemo(() => jsonOf(value), [value]);
  if (json !== undefined) {
    return (
      <>
        <span className="rd-v-json dk-ellipsis">{value}</span>
        <button type="button" className="rd-jtoggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{t.redis.value.jsonToggle}</button>
        {open && <div className="rd-cell-json"><JsonView value={json} folds={folds} onToggle={(p) => useRedis.getState().toggleFold(`${id}${p}`)} /></div>}
      </>
    );
  }
  return <span className={isNum(value) ? 'rd-v-num' : ''}><Masked id={id} field={field} value={value} /></span>;
}

export type RowPick = { kind: 'hash'; field: string; value: string } | { kind: 'list'; index: number; value: string } | { kind: 'zset'; member: string; score: number } | null;

function Table({ body, picked, onPick }: { body: ValueBody; picked: RowPick; onPick: (p: RowPick) => void }) {
  const c = t.redis.value.cols;
  const row = (key: string, sel: boolean, pick: RowPick, cells: React.ReactNode[]) => (
    <tr key={key} className={sel ? 'is-picked' : ''} onClick={() => onPick(pick)}>{cells.map((x, i) => <td key={i}>{x}</td>)}</tr>
  );
  let head: string[] = [];
  let rows: React.ReactNode[] = [];
  if (body.kind === 'hash') {
    head = [c.field, c.value];
    rows = body.fields.map(([f, v]) => row(`h:${f}`, picked?.kind === 'hash' && picked.field === f, { kind: 'hash', field: f, value: v }, [<span className="rd-v-key">{f}</span>, <Cell id={`f:${f}`} field={f} value={v} />]));
  } else if (body.kind === 'list') {
    head = [c.index, c.value];
    rows = body.items.map((v, i) => row(`l:${i}`, picked?.kind === 'list' && picked.index === body.start + i, { kind: 'list', index: body.start + i, value: v }, [<span className="rd-dim">{body.start + i}</span>, <Cell id={`l:${i}`} field="" value={v} />]));
  } else if (body.kind === 'set') {
    head = [c.n, c.member];
    rows = body.members.map((m, i) => row(`s:${m}`, false, null, [<span className="rd-dim">{i + 1}</span>, <span>{m}</span>]));
  } else if (body.kind === 'zset') {
    head = [c.rank, c.member, c.score];
    rows = body.members.map(([m, s], i) => row(`z:${m}`, picked?.kind === 'zset' && picked.member === m, { kind: 'zset', member: m, score: s }, [<span className="rd-dim">{body.start + i + 1}</span>, <span className="rd-v-key">{m}</span>, <span className="rd-v-score">{s.toLocaleString('en-US')}</span>]));
  } else if (body.kind === 'stream') {
    head = [c.entry, c.fields, c.time];
    rows = body.entries.map((e) => row(`x:${e.id}`, false, null, [
      <span className="rd-v-id">{e.id}</span>,
      <span>{e.fields.map(([f, v], i) => <span key={i} className="rd-kvp"><span className="rd-dim">{f}=</span><Masked id={`x:${e.id}:${f}`} field={f} value={v} /></span>)}</span>,
      <span className="rd-dim">{new Date(Number(e.id.split('-')[0])).toLocaleTimeString('en-GB')}</span>
    ]));
  }
  return (
    <table className={`rd-table mono kind-${body.kind}`}>
      <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows}</tbody>
    </table>
  );
}

function Counter({ k, initial, ttl, at, visible }: { k: string; initial: string; ttl: number; at: number; visible: boolean }) {
  const db = useRedis((s) => s.db);
  const [reads, setReads] = useState<{ at: number; v: string }[]>(() => [{ at: Date.now(), v: initial }]);
  const [live, setLive] = useState({ ttl, at });
  useEffect(() => {
    if (!visible) return;
    const h = setInterval(() => {
      void window.atelier.redis.counter({ db, key: k }).then((r) => {
        if (r.value === null) return;
        setReads((cur) => [...cur.slice(-19), { at: Date.now(), v: r.value! }]);
        setLive({ ttl: r.ttl, at: Date.now() });
      }).catch(() => {});
    }, 1000);
    return () => clearInterval(h);
  }, [k, db, visible]);
  const last = reads.at(-1)!.v;
  const now = Date.now();
  const recent = reads.filter((r) => now - r.at <= 10_000);
  const changes = recent.reduce((n, r, i) => n + (i > 0 && r.v !== recent[i - 1]!.v ? 1 : 0), 0);
  const nums = reads.map((r) => Number(r.v));
  const max = Math.max(1, ...nums.map((x) => Math.abs(x)));
  const left = tickTtl(live.ttl, live.at, now);
  return (
    <div className="rd-counter">
      <span className="rd-counter-v mono">{Number(last).toLocaleString('en-US')}</span>
      <span className="rd-counter-text">{t.redis.value.counter(left >= 0 ? fmtTtlLong(left) : null, changes)}</span>
      <div className="rd-counter-bars" aria-hidden="true">{nums.map((x, i) => <span key={i} style={{ height: `${Math.max(6, (Math.abs(x) / max) * 48)}px` }} />)}</div>
    </div>
  );
}

/** Whether a JSON-like value holds a key masking would hide. */
function hasSecret(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasSecret);
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).some(([k, x]) => (maskField(k) && x !== null && x !== '') || hasSecret(x));
  return false;
}

function Body({ k, reply, visible, picked, onPick }: { k: string; reply: RedisValueReply; visible: boolean; picked: RowPick; onPick: (p: RowPick) => void }) {
  const folds = useRedis((s) => s.folds);
  const shown = useRedis((s) => s.revealed.has('json'));
  const view = (v: unknown) => (shown ? v : maskTree(v));
  const b = reply.body;
  const v = t.redis.value;
  if (b.kind === 'missing') return <p className="rd-pane-empty">{v.missing}</p>;
  if (b.kind === 'string') {
    if (b.format === 'int' && b.text) return <Counter key={k} k={k} initial={b.text} ttl={reply.meta.ttl} at={Date.now()} visible={visible} />;
    if (b.value !== undefined) return <JsonView value={view(b.value)} folds={folds} onToggle={(p) => useRedis.getState().toggleFold(p)} />;
    if (b.format === 'binary') return <pre className="rd-hex mono">{(b.hex ?? []).join('\n')}</pre>;
    return <pre className="rd-text mono">{b.text}</pre>;
  }
  if (b.kind === 'json') return <JsonView value={view(b.value)} folds={folds} onToggle={(p) => useRedis.getState().toggleFold(p)} />;
  if (b.kind === 'vector') return <p className="rd-pane-note mono">{v.vector(b.count, b.dim, b.quant)}</p>;
  if (b.kind === 'other') return <p className="rd-pane-empty">{v.other(reply.meta.type)}</p>;
  return (
    <>
      <Table body={b} picked={picked} onPick={onPick} />
      {b.kind === 'stream' && <p className="rd-pane-foot mono">{v.groups(b.total, b.groups.length ? v.groupsN(b.groups.length, b.groups.map((g) => v.group(g.name, g.lag)).join(', ')) : '')}</p>}
    </>
  );
}

export function ValuePane({ k, visible }: { k: string; visible: boolean }) {
  const value = useRedis((s) => (s.value?.key === k ? s.value : null));
  const [now, setNow] = useState(Date.now());
  const [picked, setPicked] = useState<RowPick>(null);
  const edits = useApp((s) => s.settings.redisEdits === 'ask');
  const revealedJson = useRedis((s) => s.revealed.has('json'));
  const target = sendTarget();
  useEffect(() => { setPicked(null); void loadValue(k); }, [k]);
  const reply = value?.reply ?? null;
  const ttl = reply?.meta.ttl ?? -1;
  useEffect(() => {
    if (!visible || ttl < 0) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [visible, ttl]);
  const v = t.redis.value;
  if (!reply) return <div className="rd-pane"><p className="rd-pane-empty">{value?.error ?? v.loading}</p></div>;
  const meta = reply.meta;
  const b = reply.body;
  const fmt = b.kind === 'string' ? b.format : null;
  const tc = typeClass(meta.type, fmt);
  const left = tickTtl(ttl, value!.at, now);
  const hot = left >= 0 && left < 60_000;
  const lenLabel = fmt === 'int' ? v.intValue : v.len[meta.type] ?? 'Length';
  const lenValue = fmt === 'int' && b.kind === 'string' ? b.text ?? '' : meta.length === null ? '—' : meta.type === 'string' ? fmtBytes(meta.length) : meta.length.toLocaleString('en-US');
  const why = editBlocker(reply);
  const edit = () => {
    const st = useRedis.getState();
    if (b.kind === 'hash' || b.kind === 'list' || b.kind === 'zset') {
      if (!picked) { useApp.getState().showToast(t.redis.edits.pickRow, undefined, 'info'); return; }
      st.setSheet({ kind: 'edit', key: k, target: picked });
      return;
    }
    st.setSheet({ kind: 'edit', key: k, target: { kind: b.kind === 'json' ? 'json' : 'string' } });
  };
  return (
    <section className="rd-pane" aria-label={displayKey(k)}>
      <div className="rd-pane-head">
        <div className="rd-pane-title">
          <span className={`rd-ty is-${tc} is-big`}>{typeLabel(tc === 'json' && meta.type === 'string' ? 'string' : meta.type)}</span>
          <span className="mono rd-key dk-ellipsis" data-tip={displayKey(k)}>{displayKey(k)}</span>
          <button type="button" className="icon-btn" aria-label={v.copyKey} data-tip={v.copyKey} onClick={() => copyWithToast(displayKey(k), displayKey(k))}><Icon name="copy" size={13} /></button>
          <span className="grow" />
          {((b.kind === 'string' && b.value !== undefined && hasSecret(b.value)) || (b.kind === 'json' && hasSecret(b.value))) && (
            <button type="button" className="rd-chip-btn rd-reveal" aria-pressed={revealedJson} onClick={() => useRedis.getState().toggleReveal('json')}>
              <Icon name="eye" size={11} />{revealedJson ? v.hide : v.revealAll}
            </button>
          )}
          {b.kind === 'string' && b.gzip && <span className="dk-chip-state tone-off">{v.gzip}</span>}
          {(fmt === 'json' || fmt === 'php' || fmt === 'msgpack') && <span className="rd-chip"><span className="rd-chip-strong">{v.formats[fmt]}</span> {v.detectedTail}</span>}
          {b.kind === 'string' && b.shown < b.total && <span className="rd-chip">{v.preview(fmtBytes(b.shown), fmtBytes(b.total))}</span>}
        </div>
        <div className="rd-meta">
          <div className="rd-meta-cell"><span className="section-label">{v.ttl}</span><span className={`mono ${hot ? 'is-hot' : ''}`}>{fmtTtlLong(left)}</span></div>
          <div className="rd-meta-cell"><span className="section-label">{v.memory}</span><span className="mono">{meta.memory !== null ? fmtBytes(meta.memory) : '—'}</span></div>
          <div className="rd-meta-cell"><span className="section-label">{v.encoding}</span><span className="mono">{meta.encoding ?? '—'}</span></div>
          <div className="rd-meta-cell"><span className="section-label">{lenLabel}</span><span className="mono">{lenValue}</span></div>
          <div className="rd-meta-cell"><span className="section-label">{v.lastAccess}</span><span className="mono">{meta.idle !== null ? v.ago(meta.idle) : '—'}</span></div>
          <span className="grow" />
          {edits && canEdit() && b.kind !== 'missing' && (
            <div className="rd-meta-actions">
              <button type="button" className="btn-ghost sm" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); useRedis.getState().setSheet({ kind: 'ttl', key: k, x: r.left, y: r.bottom + 6 }); }}><Icon name="clock" size={12} />{v.setTtl}</button>
              <button type="button" className="btn-ghost sm" disabled={!!why} data-tip={why ?? undefined} onClick={edit}><Icon name="edit" size={12} />{v.edit}</button>
              <button type="button" className="btn-ghost sm is-danger" onClick={() => useRedis.getState().setSheet({ kind: 'delete', keys: [k] })}><Icon name="trash" size={12} />{v.delete}</button>
            </div>
          )}
        </div>
      </div>
      <div className="rd-pane-body">
        <Body k={k} reply={reply} visible={visible} picked={picked} onPick={setPicked} />
        {hasMore(reply) && <button type="button" className="btn-ghost sm rd-more" disabled={value?.loading} onClick={() => void loadValue(k, true)}>{v.loadMore}</button>}
      </div>
      <div className="rd-selbar" role="toolbar" aria-label={displayKey(k)}>
        <span className="mono rd-selbar-key dk-ellipsis">{displayKey(k)}</span>
        <span className="rd-selbar-sep" aria-hidden="true" />
        <button type="button" className="btn-primary sm sel-send" disabled={!target} data-tip={target ? t.redis.bar.sendTip : t.redis.noSession} onClick={() => sendKey(k)}>
          <span className="dk-ellipsis">{target ? t.redis.bar.sendTo(target.title) : t.redis.bar.sendNone}</span>{target && <span className="kbd-in">{kbd('⌥↩')}</span>}
        </button>
        <button type="button" className="btn-ghost sm" aria-label={t.redis.bar.askNew} data-tip={t.redis.bar.askNew} onClick={() => askKey(k)}><Icon name="sparkle" size={12} /><span className="rd-wide">{t.redis.bar.askNew}</span></button>
        <button type="button" className="btn-ghost sm" onClick={() => copyValue(k)}>{t.redis.bar.copyValue}</button>
        <button type="button" className="btn-ghost sm mono rd-wide" data-tip={cliOf(k, meta.type)} onClick={() => copyCli(k, meta.type)}>{t.redis.bar.copyCli}</button>
      </div>
    </section>
  );
}
