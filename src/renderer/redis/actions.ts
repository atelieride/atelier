// What the Redis view does: open views, scan keys, read values, ask before writing and offer
// the undo, send keys and jobs to Claude, copy commands, context menus.
import {
  MASK, cliCommand, displayKey, fmtTtl, globOf, instanceTitle, keyPrompt, maskField, maskTree, namespacePattern, slowlogPrompt, NO_NAMESPACE,
  type KeyEntry, type KeyWriteOp, type RedisInstance, type RedisValueReply, type RedisWriteOp, type WriteResult
} from '@shared/redis';
import { jobPrompt, jobsPrompt, LIB_LABEL, type JobInfo, type JobState, type QueueInfo } from '@shared/redis-queues';
import { redactSecrets } from '@shared/session';
import type { MenuItem } from '../menu-model';
import { t } from '../i18n/en';
import { useApp, type RedisView } from '../store';
import { copyText } from '../clipboard';
import { askInSession, sendToSession } from '../docker/actions';
import { pickedOf, useRedis, type ScanState } from './store';
import { redisTabTitle, redisViewsShown } from './tabs';
import type { IconName } from '../components/Icon';

// —— opening ——

/** A Redis view in its tab, in the Redis space (the store's openRedis brings it forward). */
export function openRedis(view?: RedisView): void {
  useApp.getState().openRedis(view);
}

export function openNamespace(ns: string): void {
  useRedis.getState().setNs(ns);
  openRedis('keys');
}

export function openQueue(id: string, state?: JobState): void {
  const r = useRedis.getState();
  const q = r.status?.queues?.find((x) => x.id === id);
  r.pickQueue(id, state ?? ((q?.counts.failed ?? 0) > 0 ? 'failed' : 'waiting'));
  openRedis('queues');
  window.atelier.redis.seen(id);
}

const picked = () => pickedOf(useRedis.getState());
export const instanceLabel = (i: RedisInstance | null) => (i ? instanceTitle(i) : 'Redis');

// —— scanning ——

const scanId = () => { const r = useRedis.getState(); return `${r.snap?.pick ?? ''}|${r.db}|${globOf(r.filter)}`; };

/** Scans from the start when the instance, database or filter changed (or when asked). */
export function ensureScan(force = false): void {
  const r = useRedis.getState();
  if (!r.snap?.pick || picked()?.state !== 'running') return;
  const id = scanId();
  if (!force && r.scan?.id === id) return;
  r.setScan({ id, keys: [], cursor: '0', total: 0, scanned: 0, done: false, running: true, limited: false, at: Date.now(), error: null });
  void runScan(id);
}

export function keepScanning(): void {
  const s = useRedis.getState().scan;
  if (!s || s.done || s.running) return;
  useRedis.getState().setScan({ ...s, running: true, limited: false });
  void runScan(s.id, s.keys.length + useApp.getState().settings.redisScanKeys);
}

export function stopScan(): void {
  const s = useRedis.getState().scan;
  if (s?.running) useRedis.getState().setScan({ ...s, running: false, limited: !s.done });
}

async function runScan(id: string, cap = useApp.getState().settings.redisScanKeys): Promise<void> {
  const db = useRedis.getState().db;
  const match = globOf(useRedis.getState().filter);
  for (;;) {
    const s = useRedis.getState().scan;
    if (!s || s.id !== id || !s.running) return;
    try {
      const page = await window.atelier.redis.scan({ db, match, cursor: s.cursor });
      const cur = useRedis.getState().scan;
      if (!cur || cur.id !== id || !cur.running) return;
      const seen = new Set(cur.keys.map((k) => k.key));
      const keys = [...cur.keys, ...page.keys.filter((k) => !seen.has(k.key))];
      const done = page.cursor === '0';
      const limited = !done && keys.length >= cap;
      useRedis.getState().setScan({ ...cur, keys, cursor: page.cursor, total: page.total, scanned: cur.scanned + Math.max(page.keys.length, 1000), done, running: !done && !limited, limited, at: Date.now() });
      if (done || limited) return;
      // A breath between batches: a big keyspace never hogs Redis or the window.
      await new Promise((r) => setTimeout(r, 15));
    } catch (e) {
      const cur = useRedis.getState().scan;
      if (cur?.id === id) useRedis.getState().setScan({ ...cur, running: false, error: (e as Error).message });
      return;
    }
  }
}

/** Keys of the open namespace (and the No TTL chip). */
export function keysOf(scan: ScanState | null, ns: string | null, prefix: string | null, noTtl: boolean): KeyEntry[] {
  if (!scan || ns === null) return [];
  return scan.keys.filter((k) => nsOfKey(k.key, prefix) === ns && (!noTtl || k.ttl < 0)).sort((a, b) => a.key.localeCompare(b.key));
}

function nsOfKey(key: string, prefix: string | null): string {
  const k = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
  const i = k.indexOf(':');
  return i > 0 ? k.slice(0, i) : NO_NAMESPACE;
}

// —— values ——

let valueSeq = 0;

export async function loadValue(key: string, more = false): Promise<void> {
  const r = useRedis.getState();
  const n = ++valueSeq;
  const prev = r.value?.key === key ? r.value : null;
  if (!more) r.setValue({ key, reply: prev?.reply ?? null, at: Date.now(), loading: true, error: null, more: false });
  const body = prev?.reply?.body;
  const page = !more || !body ? {} : body.kind === 'hash' || body.kind === 'set' ? { cursor: body.cursor } : body.kind === 'list' || body.kind === 'zset' ? { start: body.start + (body.kind === 'list' ? body.items.length : body.members.length) } : body.kind === 'stream' ? { cursor: `(${body.entries.at(-1)?.id ?? '+'}` } : {};
  try {
    const reply = await window.atelier.redis.value({ db: r.db, key, page });
    if (n !== valueSeq && !more) return;
    if (more && prev?.reply) {
      // Another key was picked meanwhile: its pane is not this one's.
      if (useRedis.getState().value?.key !== key) return;
      useRedis.getState().setValue({ ...prev, reply: merge(prev.reply, reply), loading: false, more: false });
      return;
    }
    useRedis.getState().setValue({ key, reply, at: Date.now(), loading: false, error: null, more: false });
  } catch (e) {
    if (n === valueSeq) useRedis.getState().setValue({ key, reply: prev?.reply ?? null, at: Date.now(), loading: false, error: (e as Error).message, more: false });
  }
}

function merge(a: RedisValueReply, b: RedisValueReply): RedisValueReply {
  const x = a.body;
  const y = b.body;
  if (x.kind === 'hash' && y.kind === 'hash') return { meta: b.meta, body: { ...y, fields: [...x.fields, ...y.fields] } };
  if (x.kind === 'set' && y.kind === 'set') return { meta: b.meta, body: { ...y, members: [...x.members, ...y.members] } };
  if (x.kind === 'list' && y.kind === 'list') return { meta: b.meta, body: { ...y, start: x.start, items: [...x.items, ...y.items] } };
  if (x.kind === 'zset' && y.kind === 'zset') return { meta: b.meta, body: { ...y, start: x.start, members: [...x.members, ...y.members] } };
  if (x.kind === 'stream' && y.kind === 'stream') return { meta: b.meta, body: { ...y, entries: [...x.entries, ...y.entries] } };
  return b;
}

/** Whether a page more can be read. */
export function hasMore(reply: RedisValueReply | null): boolean {
  const b = reply?.body;
  if (!b) return false;
  if (b.kind === 'hash' || b.kind === 'set') return b.cursor !== '0';
  if (b.kind === 'list') return b.start + b.items.length < b.total;
  if (b.kind === 'zset') return b.start + b.members.length < b.total;
  if (b.kind === 'stream') return b.entries.length < b.total;
  return false;
}

/** The value as text (masked where the screen masks, unless revealed): Copy value and what goes to Claude. */
export function valueText(reply: RedisValueReply, revealed: ReadonlySet<string> = new Set()): string {
  const b = reply.body;
  const mask = (f: string, v: string) => (maskField(f) && !revealed.has(`f:${f}`) ? MASK : v);
  switch (b.kind) {
    case 'string': return b.value !== undefined ? JSON.stringify(revealed.has('json') ? b.value : maskTree(b.value), null, 2) : b.text ?? (b.hex ?? []).join('\n');
    case 'hash': return b.fields.map(([f, v]) => `${f}: ${mask(f, v)}`).join('\n');
    case 'list': return b.items.map((v, i) => `${b.start + i}: ${v}`).join('\n');
    case 'set': return b.members.join('\n');
    case 'zset': return b.members.map(([m, s]) => `${m} ${s}`).join('\n');
    case 'stream': return b.entries.map((e) => `${e.id}  ${e.fields.map(([f, v]) => `${f}=${mask(f, v)}`).join('  ')}`).join('\n');
    case 'json': return JSON.stringify(revealed.has('json') ? b.value : maskTree(b.value), null, 2);
    case 'vector': return `vector set: ${b.count} vectors, ${b.dim} dimensions${b.quant ? `, ${b.quant}` : ''}`;
    default: return '';
  }
}

// —— Claude ——

function promptOf(key: string): string | null {
  const r = useRedis.getState();
  const v = r.value?.key === key ? r.value.reply : null;
  if (!v) return null;
  return keyPrompt({ instance: instanceLabel(picked()), db: r.db, key, type: v.meta.type, ttl: v.meta.ttl, value: valueText(v) });
}

/** The key's prompt, reading its value first when it hasn't arrived yet (⌥↩ right after picking the key). */
function withPrompt(key: string, run: (prompt: string) => void): void {
  const p = promptOf(key);
  if (p) { run(p); return; }
  void loadValue(key).then(() => { const q = promptOf(key); if (q) run(q); });
}

export function sendKey(key: string): void {
  withPrompt(key, sendToSession);
}

const askNew = (name: string, prompt: string): Promise<void> => askInSession(t.redis.sessionName(name), prompt, t.redis.typed(name));

export function askKey(key: string): void {
  withPrompt(key, (p) => void askNew(displayKey(key).split(':').slice(-2).join(':'), p));
}

const ctx = (q: QueueInfo) => ({ lib: q.lib, queue: q.name, instance: instanceLabel(picked()) });
const queueOf = (id: string) => useRedis.getState().status?.queues?.find((x) => x.id === id) ?? null;

async function fullJob(queue: string, state: JobState, id: string): Promise<JobInfo | null> {
  const cur = useRedis.getState().job;
  if (cur?.info.id === id && cur.info.stacks.length) return cur.info;
  return (await window.atelier.redis.job({ db: useRedis.getState().db, queue, state, id }).catch(() => null))?.job ?? null;
}

export async function askJob(queueId: string, state: JobState, id: string): Promise<void> {
  const q = queueOf(queueId);
  const j = await fullJob(queueId, state, id);
  if (q && j) await askNew(`${q.name} #${j.id}`, jobPrompt(ctx(q), j));
}

export async function sendJob(queueId: string, state: JobState, id: string): Promise<void> {
  const q = queueOf(queueId);
  const j = await fullJob(queueId, state, id);
  if (q && j) void sendToSession(jobPrompt(ctx(q), j));
}

export async function askJobs(queueId: string): Promise<void> {
  const q = queueOf(queueId);
  if (!q) return;
  const list = await window.atelier.redis.jobs({ db: useRedis.getState().db, queue: queueId, state: 'failed', start: 0, count: 20 }).catch(() => []);
  const full = (await Promise.all(list.map((j) => fullJob(queueId, 'failed', j.id)))).filter((j): j is JobInfo => !!j);
  if (full.length) await askNew(`${q.name} failures`, jobsPrompt(ctx(q), full));
}

export async function askSlowlog(): Promise<void> {
  const s = useRedis.getState().slow;
  if (s?.entries.length) await askNew('slow log', slowlogPrompt(instanceLabel(picked()), s.entries));
}

// —— copying ——

const copy = (text: string, what: string) => void copyText(text).then((ok) => { if (ok) useApp.getState().showToast(t.redis.copied(what), undefined, 'info'); });

export function copyValue(key: string): void {
  const r = useRedis.getState();
  if (r.value?.key === key && r.value.reply) copy(valueText(r.value.reply, r.revealed), displayKey(key));
}

export function cliOf(key: string, type: string): string {
  const i = picked();
  return i ? cliCommand(i.endpoint, useRedis.getState().db, key, type, i.hasPassword) : '';
}

export function copyCli(key: string, type: string): void {
  const c = cliOf(key, type);
  if (c) copy(c, c);
}

export function copyJobJson(job: JobInfo): void {
  let raw: unknown = job.raw;
  try { raw = JSON.parse(job.raw); } catch { /* text as stored */ }
  copy(redactSecrets(JSON.stringify(maskTree(raw, true), null, 2)), `#${job.id}`);
}

export { copy as copyWithToast };

// —— writes ——

function failText(r: Extract<WriteResult, { ok: false }>): string {
  if (r.reason === 'refused') return t.redis.edits.refused;
  if (r.reason === 'gone') return t.redis.edits.gone;
  if (r.reason === 'moved') return t.redis.edits.moved;
  if (r.reason === 'wrong-type') return t.redis.edits.wrongType;
  if (r.reason === 'too-big') return t.redis.edits.cantEdit.big!;
  return t.redis.edits.failed(t.redis.queuesView.reasons[r.reason] ?? r.message ?? r.reason);
}

/** Runs a write main will check again; an undoable one leaves the countdown pill. */
export async function write(op: RedisWriteOp, done: (r: Extract<WriteResult, { ok: true }>) => string, db = useRedis.getState().db): Promise<boolean> {
  const instance = useRedis.getState().snap?.pick;
  if (!instance) return false;
  const r = await window.atelier.redis.write({ db, op, instance }).catch((e: Error) => ({ ok: false as const, reason: 'error' as const, message: e.message }));
  if (!r.ok) { useApp.getState().showToast(failText(r)); return false; }
  const text = done(r);
  const undoable = op.op === 'delete' || op.op === 'ttl' || op.op === 'setString' || op.op === 'hset' || op.op === 'lset' || op.op === 'zscore' || op.op === 'jsonSet' || (op.op === 'deleteMatching' && r.count <= 10_000);
  if (r.undo) useRedis.getState().setUndo({ id: r.undo, text, at: Date.now(), ms: 30_000 });
  else useApp.getState().showToast(undoable && r.count > 0 ? `${text} · ${t.redis.edits.noUndoServer}` : text, undefined, 'info');
  afterWrite(op);
  return true;
}

/** Keys gone or changed are refreshed in the list and the value pane. */
function afterWrite(op: RedisWriteOp): void {
  const r = useRedis.getState();
  if (op.op === 'delete' && r.scan) r.setScan({ ...r.scan, keys: r.scan.keys.filter((k) => !op.keys.includes(k.key)) });
  if (op.op === 'deleteMatching' || op.op === 'flushdb') ensureScan(true);
  if (op.op === 'ttl' && r.scan) r.setScan({ ...r.scan, keys: r.scan.keys.map((k) => (k.key === op.key ? { ...k, ttl: op.ms ?? -1 } : k)) });
  const key = (op as { key?: string }).key;
  if (r.key && (key === r.key || (op.op === 'delete' && op.keys.includes(r.key)))) void loadValue(r.key);
  if (op.op === 'retry' || op.op === 'remove') void reloadJobs();
}

export async function undo(): Promise<void> {
  const u = useRedis.getState().undo;
  if (!u) return;
  useRedis.getState().setUndo(null);
  const r = await window.atelier.redis.undo(u.id).catch((): { ok: false; reason: 'error'; message?: string } => ({ ok: false, reason: 'error' }));
  const e = t.redis.edits;
  useApp.getState().showToast(r.ok ? (r.kept ? e.restoredKept(r.kept) : e.restored) : r.reason === 'picked' ? e.picked : r.reason === 'expired' ? e.expired : e.failed(r.message ?? ''), undefined, 'info');
  ensureScan(true);
  const key = useRedis.getState().key;
  if (key) void loadValue(key);
  void reloadJobs();
}

export function keyWrite(op: KeyWriteOp, done: (r: Extract<WriteResult, { ok: true }>) => string): Promise<boolean> {
  return write(op, done);
}

export const canEdit = () => useApp.getState().settings.redisEdits === 'ask';

export function setTtl(key: string, ms: number | null): void {
  void write({ op: 'ttl', key, ms }, () => (ms === null ? t.redis.edits.ttlPersisted(displayKey(key)) : t.redis.edits.ttlSet(displayKey(key), fmtTtl(ms))));
}

// —— queues ——

let jobsSeq = 0;

export async function reloadJobs(): Promise<void> {
  const r = useRedis.getState();
  if (!r.queue) return;
  const n = ++jobsSeq;
  r.setJobs(r.jobs, true);
  const list = await window.atelier.redis.jobs({ db: r.db, queue: r.queue, state: r.jobState, start: 0, count: 50 }).catch(() => []);
  if (n !== jobsSeq) return;
  useRedis.getState().setJobs(list, false);
  const cur = useRedis.getState();
  const id = cur.jobId && list.some((j) => j.id === cur.jobId) ? cur.jobId : list[0]?.id ?? null;
  if (id) void loadJob(id); else cur.setJob(null, null);
}

let jobSeq = 0;

export async function loadJob(id: string): Promise<void> {
  const r = useRedis.getState();
  if (!r.queue) return;
  const n = ++jobSeq;
  r.setJob(r.job?.info.id === id ? r.job : null, id);
  const got = await window.atelier.redis.job({ db: r.db, queue: r.queue, state: r.jobState, id }).catch(() => null);
  if (n === jobSeq) useRedis.getState().setJob(got ? { info: got.job, command: got.command } : null);
}

// —— menus ——

export function keyMenu(k: KeyEntry): MenuItem[] {
  const edits = canEdit();
  const loaded = () => { const r = useRedis.getState(); if (r.key !== k.key) { r.setKey(k.key); void loadValue(k.key); } };
  return [
    { id: 'copy-key', label: t.redis.menu.copyKey, icon: 'copy', run: () => copy(displayKey(k.key), displayKey(k.key)) },
    { id: 'copy-value', label: t.redis.menu.copyValue, icon: 'copy', run: () => { loaded(); void loadValue(k.key).then(() => copyValue(k.key)); } },
    { id: 'copy-cli', label: t.redis.menu.copyCli, icon: 'terminal', hint: cliOf(k.key, k.type), run: () => copyCli(k.key, k.type) },
    'sep',
    { id: 'send', label: t.redis.menu.send, icon: 'send', run: () => { loaded(); void loadValue(k.key).then(() => sendKey(k.key)); } },
    { id: 'ask', label: t.redis.menu.ask, icon: 'sparkle', run: () => { loaded(); void loadValue(k.key).then(() => askKey(k.key)); } },
    ...(edits ? ['sep' as const,
      { id: 'ttl', label: t.redis.menu.setTtl, icon: 'clock' as const, run: () => useRedis.getState().setSheet({ kind: 'ttl', key: k.key, x: 0, y: 0 }) },
      { id: 'edit', label: t.redis.menu.edit, icon: 'edit' as const, run: () => void editFromMenu(k) },
      { id: 'delete', label: t.redis.menu.delete, icon: 'trash' as const, danger: true, run: () => useRedis.getState().setSheet({ kind: 'delete', keys: [k.key] }) }] : [])
  ];
}

/** Edit from a key's menu: the value is read first and the same rules as the pane's Edit apply. */
async function editFromMenu(k: KeyEntry): Promise<void> {
  const r = useRedis.getState();
  if (r.key !== k.key) r.setKey(k.key);
  await loadValue(k.key);
  const reply = useRedis.getState().value?.key === k.key ? useRedis.getState().value!.reply : null;
  if (!reply) return;
  const why = editBlocker(reply);
  if (why) { useApp.getState().showToast(why, undefined, 'info'); return; }
  const b = reply.body;
  if (b.kind === 'hash' || b.kind === 'list' || b.kind === 'zset') { useApp.getState().showToast(t.redis.edits.pickRow, undefined, 'info'); return; }
  useRedis.getState().setSheet({ kind: 'edit', key: k.key, target: { kind: b.kind === 'json' ? 'json' : 'string' } });
}

/** Why a value can't be edited here (null: it can). */
export function editBlocker(reply: RedisValueReply): string | null {
  const b = reply.body;
  const c = t.redis.edits.cantEdit;
  if (b.kind === 'set') return c.set!;
  if (b.kind === 'stream') return c.stream!;
  if (b.kind === 'vector') return c.vectorset!;
  if (b.kind === 'other' || b.kind === 'missing') return c.other!;
  if (b.kind === 'string' && (b.format === 'binary' || b.format === 'msgpack')) return c.binary!;
  if (b.kind === 'string' && (b.shown < b.total || b.gzip)) return c.big!;
  return null;
}

export function nsMenu(ns: string, prefix: string | null): MenuItem[] {
  const pattern = namespacePattern(ns, prefix);
  return [
    { id: 'show', label: t.redis.menu.showKeys, icon: 'redis', run: () => openNamespace(ns) },
    { id: 'copy-pattern', label: t.redis.menu.copyPattern, icon: 'copy', hint: pattern, run: () => copy(pattern, pattern) },
    ...(canEdit() && ns !== NO_NAMESPACE ? ['sep' as const, { id: 'delete', label: t.redis.menu.deleteMatching, icon: 'trash' as const, danger: true, run: () => useRedis.getState().setSheet({ kind: 'deleteMatching', pattern, label: pattern }) }] : [])
  ];
}

export function queueMenu(q: QueueInfo): MenuItem[] {
  return [
    { id: 'show', label: t.redis.menu.showQueue, icon: 'list', run: () => openQueue(q.id) },
    ...((q.counts.failed ?? 0) > 0 ? [{ id: 'ask', label: t.redis.menu.askFailures, icon: 'sparkle' as const, run: () => void askJobs(q.id) }] : []),
    'sep',
    { id: 'copy', label: t.redis.copied(q.name).replace('Copied ', 'Copy '), icon: 'copy', run: () => copy(q.name, q.name) }
  ];
}

const VIEW_ICON: Record<RedisView, IconName> = { keys: 'key', queues: 'list', live: 'pulse', overview: 'info' };

/** The Redis strip's +: the views the instance offers, the open ones checked; one picked opens. */
export function redisViewsMenu(): MenuItem[] {
  const open = useApp.getState().redisTabs;
  return redisViewsShown(useRedis.getState().status).map((v) => ({ id: `rd-${v}`, label: redisTabTitle(v), icon: VIEW_ICON[v], ...(open.includes(v) ? { checked: true } : {}), run: () => openRedis(v) }));
}

export function instanceMenu(i: RedisInstance): MenuItem[] {
  const url = i.endpoint.kind === 'tcp' ? `redis://127.0.0.1:${i.endpoint.port}${useRedis.getState().db ? `/${useRedis.getState().db}` : ''}` : i.endpoint.path;
  return [
    { id: 'overview', label: t.redis.menu.overview, icon: 'info', run: () => openRedis('overview') },
    { id: 'live', label: t.redis.menu.live, icon: 'pulse', run: () => openRedis('live') },
    'sep',
    { id: 'copy-url', label: t.redis.menu.copyUrl, icon: 'copy', hint: url, run: () => copy(url, url) }
  ];
}

export const libLabel = (lib: string) => LIB_LABEL[lib as keyof typeof LIB_LABEL] ?? lib;
