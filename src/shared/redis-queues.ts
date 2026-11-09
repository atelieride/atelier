// Queues in Redis: which libraries a keyspace holds (from key names and their registry sets),
// and their jobs read into one shape — BullMQ/Bull hashes, Sidekiq/Resque/Laravel/Celery JSON, RQ hashes, Asynq's
// protobuf. Pure; main reads the keys (adapters in src/main/redis/queues/) and inflates what is compressed.
import { MASK, maskEmails, maskTree } from './redis';
import { redactSecrets } from './session';
import { unserializePhp } from './redis-values';

export type QueueLib = 'bullmq' | 'bull' | 'sidekiq' | 'laravel' | 'celery' | 'rq' | 'asynq' | 'resque';
export const LIB_LABEL: Record<QueueLib, string> = { bullmq: 'BullMQ', bull: 'Bull', sidekiq: 'Sidekiq', laravel: 'Laravel', celery: 'Celery', rq: 'RQ', asynq: 'Asynq', resque: 'Resque' };
const LIB_ORDER: QueueLib[] = ['bullmq', 'bull', 'sidekiq', 'laravel', 'celery', 'rq', 'asynq', 'resque'];

export interface QueueRef {
  /** `<lib>|<prefix>|<name>` */
  id: string;
  lib: QueueLib;
  prefix: string;
  name: string;
  /** BullMQ's own version from its meta (`bullmq:5.81.3` → `5.81.3`). */
  version: string | null;
  /** Laravel Horizon's prefix when its failed jobs live here. */
  horizon?: string;
}

export type JobState = 'waiting' | 'active' | 'delayed' | 'failed';
/** null: the library keeps that state elsewhere (a database, a global schedule) or doesn't say. */
export interface QueueCounts { waiting: number; active: number | null; delayed: number | null; failed: number | null; paused: boolean }

export interface QueueInfo extends QueueRef {
  counts: QueueCounts;
  /** Connected workers; null when the library doesn't say. */
  workers: number | null;
  /** Jobs done per minute, oldest first (26 minutes); null when unknown. */
  done: number[] | null;
  /** Retry and Remove can be done here (BullMQ 5, Sidekiq). */
  actions: boolean;
  /** Reading this queue failed (permissions, a renamed command): what is shown is partial. */
  error?: string;
}

export interface JobInfo {
  id: string;
  name: string;
  reason: string;
  attempts: number | null;
  maxAttempts: number | null;
  /** When it happened for its state: failed at, queued at, started at, due at. */
  at: number | null;
  queuedAt: number | null;
  processedOn: number | null;
  finishedOn: number | null;
  /** One stack per attempt, oldest first, each as its lines. */
  stacks: string[][];
  data: unknown;
  opts: Record<string, unknown> | null;
  backoff: string | null;
  /** The Redis key that holds it (opens in Keys). */
  key: string | null;
  /** Part of a flow (BullMQ parent/children): Remove is refused. */
  flow: boolean;
  /** The job as stored, for Copy job JSON (masked when copied). */
  raw: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const parse = (s: string | undefined): unknown => { if (s === undefined) return undefined; try { return JSON.parse(s) as unknown; } catch { return undefined; } };
const num = (v: unknown): number | null => { const x = typeof v === 'string' && v !== '' ? Number(v) : v; return typeof x === 'number' && Number.isFinite(x) ? x : null; };
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function job(p: Partial<JobInfo> & { id: string; raw: string }): JobInfo {
  return { name: '', reason: '', attempts: null, maxAttempts: null, at: null, queuedAt: null, processedOn: null, finishedOn: null, stacks: [], data: null, opts: null, backoff: null, key: null, flow: false, ...p };
}

/** What the list needs (no data, first stack only), to keep a page small. */
export function summarize(j: JobInfo): JobInfo {
  return { ...j, data: null, stacks: j.stacks.length ? [j.stacks.at(-1)!.slice(0, 3)] : [], raw: '' };
}

// —— detection ——

const SET_KEY = /^(?:.+:)?queues$|^_kombu\.binding\./;
const META_KEY = /^(.+):([^:]+):meta$/;

/** The registry sets and BullMQ metas to read, from the key names a detection scan found. */
export function detectionReads(keys: readonly string[]): { sets: string[]; metas: string[] } {
  return { sets: keys.filter((k) => SET_KEY.test(k)), metas: keys.filter((k) => META_KEY.test(k)) };
}

const ref = (lib: QueueLib, prefix: string, name: string, version: string | null = null, extra: Partial<QueueRef> = {}): QueueRef => ({ id: `${lib}|${prefix}|${name}`, lib, prefix, name, version, ...extra });
const SPECIAL_SETS = new Set(['rq:', 'asynq:', 'resque:']);

export function detectQueues(keys: readonly string[], reads: { sets: Record<string, string[]>; metas: Record<string, Record<string, string>> }): QueueRef[] {
  const has = new Set(keys);
  const out = new Map<string, QueueRef>();
  const add = (q: QueueRef) => { if (!out.has(q.id)) out.set(q.id, q); };
  const bullmq = new Set<string>();
  for (const [k, meta] of Object.entries(reads.metas)) {
    const m = META_KEY.exec(k);
    if (!m) continue;
    const version = str(meta.version).startsWith('bullmq:') ? str(meta.version).slice('bullmq:'.length) : null;
    if (version || has.has(`${m[1]}:${m[2]}:id`) || has.has(`${m[1]}:${m[2]}:events`) || Object.keys(meta).some((x) => x.startsWith('opts.'))) {
      add(ref('bullmq', m[1]!, m[2]!, version));
      bullmq.add(`${m[1]}:${m[2]}`);
    }
  }
  for (const k of keys) {
    const m = /^(.+):([^:]+):id$/.exec(k);
    if (!m || bullmq.has(`${m[1]}:${m[2]}`)) continue;
    const base = `${m[1]}:${m[2]}`;
    if (['wait', 'active', 'failed', 'completed', 'delayed', 'paused'].some((s) => has.has(`${base}:${s}`))) add(ref('bull', m[1]!, m[2]!));
  }
  for (const [k, members] of Object.entries(reads.sets)) {
    const m = /^(.*?)queues$/.exec(k);
    if (!m || SPECIAL_SETS.has(m[1]!)) continue;
    const ns = m[1]!;
    const marker = ['stat:processed', 'processes', 'retry', 'dead', 'schedule'].some((s) => has.has(`${ns}${s}`));
    for (const q of members) if (marker || has.has(`${ns}queue:${q}`)) add(ref('sidekiq', ns, q));
  }
  const horizon = keys.map((k) => /^(.*horizon:)failed_jobs$/.exec(k)?.[1]).find(Boolean);
  for (const k of keys) {
    const m = /^(.*?)queues:([^:]+)(?::(reserved|delayed|notify))?$/.exec(k);
    if (m && !m[1]!.endsWith(':')) add(ref('laravel', m[1]!, m[2]!, null, horizon ? { horizon } : {}));
  }
  for (const k of Object.keys(reads.sets)) {
    if (!k.startsWith('_kombu.binding.')) continue;
    const name = k.slice('_kombu.binding.'.length);
    if (!name || /pidbox|celeryev|\.reply\./.test(name)) continue;
    add(ref('celery', '', name));
  }
  for (const m of reads.sets['rq:queues'] ?? []) if (m.startsWith('rq:queue:')) add(ref('rq', 'rq:', m.slice('rq:queue:'.length)));
  for (const m of reads.sets['asynq:queues'] ?? []) add(ref('asynq', 'asynq:', m));
  for (const m of reads.sets['resque:queues'] ?? []) add(ref('resque', 'resque:', m));
  return [...out.values()].sort((a, b) => LIB_ORDER.indexOf(a.lib) - LIB_ORDER.indexOf(b.lib) || a.prefix.localeCompare(b.prefix) || a.name.localeCompare(b.name));
}

/** Key namespaces a queue library owns (after the framework prefix): shown dimmed, "shown in Queues". */
export function queueNamespaces(refs: readonly QueueRef[], fw: string | null): string[] {
  const out: string[] = [];
  const push = (s: string) => { const k = fw && s.startsWith(fw) ? s.slice(fw.length) : s; const ns = k.split(':')[0]!; if (ns && !out.includes(ns)) out.push(ns); };
  for (const q of refs) {
    if (q.lib === 'bullmq' || q.lib === 'bull') push(q.prefix);
    else if (q.lib === 'laravel') { push(`${q.prefix}queues`); if (q.horizon) push(q.horizon); }
    else if (q.lib === 'sidekiq') push(q.prefix ? q.prefix : 'queue');
    else if (q.lib === 'rq' || q.lib === 'asynq' || q.lib === 'resque') push(q.prefix);
  }
  return out;
}

/** Whether a key belongs to a detected queue (queue polling skews the hit ratio). */
export function queueKeyTest(refs: readonly QueueRef[]): (key: string) => boolean {
  const starts: string[] = [];
  const exact = new Set<string>();
  for (const q of refs) {
    if (q.lib === 'bullmq' || q.lib === 'bull') starts.push(`${q.prefix}:${q.name}:`);
    else if (q.lib === 'laravel') starts.push(`${q.prefix}queues:${q.name}`);
    else if (q.lib === 'sidekiq') starts.push(`${q.prefix}queue:`);
    else if (q.lib === 'celery') { exact.add(q.name); starts.push('_kombu.', 'unacked'); }
    else starts.push(q.prefix);
  }
  return (key) => exact.has(key) || starts.some((s) => key.startsWith(s));
}

// —— jobs ——

const lines = (s: string) => s.split(/\r?\n/).filter((l) => l.length);

function backoffOf(b: unknown): string | null {
  if (typeof b === 'number') return `fixed, ${b / 1000} s`;
  if (isObj(b)) {
    const d = num(b.delay);
    return `${str(b.type) || 'fixed'}${d !== null ? `, ${d / 1000} s` : ''}`;
  }
  return null;
}

/** A BullMQ or Bull job hash. */
export function bullJob(id: string, h: Record<string, string>, key: string): JobInfo {
  const opts = parse(h.opts);
  const o = isObj(opts) ? opts : null;
  const stacks = parse(h.stacktrace);
  const data = parse(h.data);
  return job({
    id, key, raw: JSON.stringify(h),
    name: h.name && h.name !== '__default__' ? h.name : 'job',
    reason: h.failedReason ?? '',
    attempts: num(h.atm) ?? num(h.attemptsMade) ?? 0,
    maxAttempts: num(o?.attempts) ?? 1,
    queuedAt: num(h.timestamp), processedOn: num(h.processedOn), finishedOn: num(h.finishedOn),
    at: num(h.finishedOn) ?? num(h.processedOn) ?? (num(h.timestamp) !== null ? num(h.timestamp)! + (num(h.delay) ?? 0) : null),
    stacks: Array.isArray(stacks) ? stacks.filter((s): s is string => typeof s === 'string').map(lines) : [],
    data: data === undefined ? h.data ?? null : data,
    opts: o,
    backoff: backoffOf(o?.backoff),
    flow: !!(h.parentKey || h.parent)
  });
}

/** A Sidekiq queue/retry/dead/schedule entry (JSON). `backtrace`: Sidekiq 6+'s compressed one, inflated by main. */
export function sidekiqEntry(json: string, backtrace?: string[]): JobInfo {
  const j = parse(json);
  const e = isObj(j) ? j : {};
  const retryCount = num(e.retry_count);
  const retry = e.retry === true ? 25 : num(e.retry);
  const bt = backtrace ?? (Array.isArray(e.error_backtrace) ? e.error_backtrace.filter((x): x is string => typeof x === 'string') : []);
  const reason = [str(e.error_class), str(e.error_message)].filter(Boolean).join(': ');
  const at = num(e.failed_at) ?? num(e.retried_at) ?? num(e.at) ?? num(e.enqueued_at);
  return job({
    id: str(e.jid), raw: json, name: str(e.wrapped) || str(e.class) || 'job', reason,
    attempts: retryCount !== null ? retryCount + 1 : reason ? 1 : 0, maxAttempts: retry !== null ? retry + 1 : null,
    at: at !== null ? Math.round(at * 1000) : null, queuedAt: num(e.enqueued_at) !== null ? Math.round(num(e.enqueued_at)! * 1000) : null,
    stacks: bt.length ? [bt] : [], data: e.args ?? null
  });
}

/** A Laravel queue payload (JSON); the job's serialized command decoded when it is PHP. */
export function laravelPayload(json: string): JobInfo {
  const j = parse(json);
  const e = isObj(j) ? j : {};
  const d = isObj(e.data) ? e.data : {};
  const cmd = typeof d.command === 'string' ? unserializePhp(new TextEncoder().encode(d.command)) : undefined;
  return job({
    id: str(e.uuid) || str(e.id), raw: json, name: str(e.displayName) || str(d.commandName) || str(e.job) || 'job',
    attempts: num(e.attempts) ?? 0, maxAttempts: num(e.maxTries), queuedAt: num(e.pushedAt) !== null ? Math.round(num(e.pushedAt)! * 1000) : null,
    data: cmd !== undefined ? cmd : e.data ?? null, backoff: num(e.backoff) !== null ? `fixed, ${num(e.backoff)} s` : null
  });
}

/** A Horizon failed job hash. */
export function horizonFailed(id: string, h: Record<string, string>): JobInfo {
  const p = laravelPayload(h.payload ?? '{}');
  const ex = h.exception ?? '';
  return { ...p, id, raw: JSON.stringify(h), reason: lines(ex)[0] ?? '', stacks: ex ? [lines(ex)] : [], at: num(h.failed_at) !== null ? Math.round(num(h.failed_at)! * 1000) : null, key: null };
}

/** A Celery message waiting in its queue list. */
export function celeryMessage(json: string): JobInfo {
  const j = parse(json);
  const e = isObj(j) ? j : {};
  const h = isObj(e.headers) ? e.headers : {};
  let body: unknown = null;
  try { body = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(str(e.body)), (c) => c.charCodeAt(0)))) as unknown; } catch { body = null; }
  const data = Array.isArray(body) ? { args: body[0], kwargs: body[1] } : body ?? (str(h.argsrepr) || null);
  return job({ id: str(h.id), raw: json, name: str(h.task) || 'task', attempts: num(h.retries) ?? 0, data });
}

/** A Celery result (`celery-task-meta-<id>`), failed ones carrying the traceback. */
export function celeryResult(json: string): JobInfo {
  const j = parse(json);
  const e = isObj(j) ? j : {};
  const r = isObj(e.result) ? e.result : {};
  const msg = Array.isArray(r.exc_message) ? r.exc_message.map(String).join(', ') : str(r.exc_message);
  const tb = str(e.traceback);
  const done = str(e.date_done);
  return job({
    id: str(e.task_id), raw: json, name: str(e.name) || 'task', reason: [str(r.exc_type), msg].filter(Boolean).join(': ') || str(e.status),
    at: done ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(done) ? done : `${done}Z`) : null, stacks: tb ? [lines(tb)] : [], data: e.result ?? null
  });
}

/** An RQ job hash (`rq:job:<id>`); `exc_info` inflated by main when compressed. */
export function rqJob(id: string, h: Record<string, string>): JobInfo {
  const exc = h.exc_info ?? '';
  const t = (s: string | undefined) => (s ? Date.parse(/[zZ]$/.test(s) ? s : `${s}Z`) : null);
  return job({
    id, raw: JSON.stringify({ ...h, data: h.data ? '<pickled>' : undefined }), key: `rq:job:${id}`, name: h.description || h.func_name || 'job',
    reason: lines(exc).at(-1) ?? (h.status === 'failed' ? 'failed' : ''), stacks: exc ? [lines(exc)] : [],
    at: t(h.ended_at) ?? t(h.started_at) ?? t(h.enqueued_at), queuedAt: t(h.enqueued_at), processedOn: t(h.started_at), finishedOn: t(h.ended_at),
    data: h.description ?? null, attempts: null, maxAttempts: null
  });
}

/** Protobuf fields of an Asynq TaskMessage we show: type 1, payload 2, id 3, retry 5, retried 6, error_msg 7, last_failed_at 11. */
function protoFields(b: Uint8Array): Map<number, (number | Uint8Array)[]> {
  const out = new Map<number, (number | Uint8Array)[]>();
  let i = 0;
  const varint = () => { let x = 0; let s = 1; for (let k = 0; k < 10; k++) { const c = b[i++]!; x += (c & 0x7f) * s; if (!(c & 0x80)) return x; s *= 128; } throw new Error('varint'); };
  while (i < b.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    let v: number | Uint8Array;
    if (wire === 0) v = varint();
    else if (wire === 2) { const n = varint(); if (i + n > b.length) throw new Error('short'); v = b.subarray(i, i + n); i += n; }
    else if (wire === 1) { i += 8; continue; }
    else if (wire === 5) { i += 4; continue; }
    else throw new Error('wire');
    out.set(field, [...(out.get(field) ?? []), v]);
  }
  return out;
}

/** An Asynq task hash: `msg` is a protobuf TaskMessage (as latin1 text). */
export function asynqTask(id: string, h: Record<string, string>): JobInfo {
  let f = new Map<number, (number | Uint8Array)[]>();
  try { f = protoFields(Uint8Array.from(h.msg ?? '', (c) => c.charCodeAt(0))); } catch { /* unreadable message */ }
  const s = (n: number) => { const v = f.get(n)?.[0]; return v instanceof Uint8Array ? new TextDecoder().decode(v) : ''; };
  const n = (k: number) => { const v = f.get(k)?.[0]; return typeof v === 'number' ? v : null; };
  const payload = s(2);
  const failed = n(11);
  return job({
    id: s(3) || id, raw: JSON.stringify({ ...h, msg: '<protobuf>', type: s(1), payload }), name: s(1) || 'task', reason: s(7),
    attempts: n(6) ?? 0, maxAttempts: n(5), at: failed ? failed * 1000 : num(h.pending_since) !== null ? Math.round(num(h.pending_since)! / 1e6) : null,
    data: parse(payload) ?? (payload || null)
  });
}

/** A Resque failed entry (`resque:failed` list item at `index`). */
export function resqueFailed(json: string, index: number): JobInfo {
  const j = parse(json);
  const e = isObj(j) ? j : {};
  const p = isObj(e.payload) ? e.payload : {};
  const bt = Array.isArray(e.backtrace) ? e.backtrace.filter((x): x is string => typeof x === 'string') : [];
  const at = str(e.failed_at);
  return job({
    id: String(index), raw: json, name: str(p.class) || 'job', reason: [str(e.exception), str(e.error)].filter(Boolean).join(': '),
    at: at ? Date.parse(at.replace(/^(\d{4})\/(\d\d)\/(\d\d)/, '$1-$2-$3').replace(' UTC', 'Z').replace(' ', 'T')) || null : null, stacks: bt.length ? [bt] : [], data: p.args ?? null
  });
}

/** A Resque or Sidekiq-like queue item ({class, args}). */
export function resqueItem(json: string, index: number): JobInfo {
  const j = parse(json);
  const e = isObj(j) ? j : {};
  return job({ id: String(index), raw: json, name: str(e.class) || 'job', data: e.args ?? null });
}

// —— workers, throughput ——

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** BullMQ workers: connections named `<prefix>:<base64 name>` (or `…:w:<worker>`). */
export function workerCount(prefix: string, name: string, clientNames: readonly string[]): number {
  const base = `${prefix}:${b64(name)}`;
  return clientNames.filter((c) => c === base || c.startsWith(`${base}:w:`)).length;
}

/** Completed events per minute over the last `minutes`, oldest first (stream ids are millisecond times). */
export function doneSeries(events: readonly { id: string; event: string }[], now: number, minutes = 26): number[] {
  const out = new Array<number>(minutes).fill(0);
  for (const e of events) {
    if (e.event !== 'completed') continue;
    const ms = Number(e.id.split('-')[0]);
    const ago = Math.floor((now - ms) / 60_000);
    if (ago >= 0 && ago < minutes) out[minutes - 1 - ago]!++;
  }
  return out;
}

// —— prompts ——

const fence = (s: string) => { const t = s.includes('```') ? '````' : '```'; return `${t}\n${s}\n${t}`; };

function jobBlock(j: JobInfo): string {
  const data = JSON.stringify(maskTree(j.data, true), null, 2) ?? 'null';
  const stack = j.stacks.at(-1) ?? [];
  return [
    `Job #${j.id} ${j.name}${j.attempts !== null ? ` · attempts ${j.attempts}${j.maxAttempts !== null ? `/${j.maxAttempts}` : ''}` : ''}${j.backoff ? ` · backoff ${j.backoff}` : ''}`,
    j.reason ? `Error: ${maskEmails(j.reason)}` : '',
    stack.length ? fence(stack.slice(0, 40).map(maskEmails).join('\n')) : '',
    j.opts ? `Options: ${JSON.stringify(maskTree(j.opts))}` : '',
    `Data:\n${fence(data.slice(0, 16 * 1024))}`
  ].filter(Boolean).join('\n');
}

export interface QueueContext { lib: QueueLib; queue: string; instance: string }

export function jobPrompt(c: QueueContext, j: JobInfo): string {
  return redactSecrets([
    `A ${LIB_LABEL[c.lib]} job failed in queue "${c.queue}" on my local ${c.instance}. Find why in this project's code and suggest a fix. Secrets and emails are masked (${MASK}).`,
    '',
    jobBlock(j)
  ].join('\n'));
}

export function jobsPrompt(c: QueueContext, jobs: readonly JobInfo[]): string {
  return redactSecrets([
    `${jobs.length} failed jobs in ${LIB_LABEL[c.lib]} queue "${c.queue}" on my local ${c.instance}. Find what they have in common in this project's code and suggest a fix. Secrets and emails are masked (${MASK}).`,
    '',
    ...jobs.slice(0, 20).map(jobBlock)
  ].join('\n\n'));
}
