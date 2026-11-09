// The write path: the only caller of the client's unsafeWrite. Every write the renderer can
// ask for is one of these operations; each but emptying a database keeps what it needs to be undone for 30 s (a DUMP
// with the remaining TTL, the previous TTL, a job's old state). Main refuses all of them when Edits is Read-only
// (hub.ts checks before calling run).
import { randomUUID } from 'node:crypto';
import { keyFromWire, type KeyWriteOp, type Preview, type UndoResult, type WriteResult } from '@shared/redis';
import type { QueueRef } from '@shared/redis-queues';
import { ServerError, Unknown, type RedisClient } from './client';
import { QUEUE_SCRIPTS, scriptSha, type QueueScript } from './queue-scripts';
import { bullActions, sidekiqFailedEntry } from './queues';
import { RespError, text, type Arg, type Reply } from './resp';

export type WriteOp = KeyWriteOp | { op: 'retry'; queue: QueueRef; id: string } | { op: 'remove'; queue: QueueRef; id: string };
export type { Preview, UndoResult, WriteResult };

export const LIMITS = { matchCap: 100_000, undoKeys: 10_000, undoBytes: 64 * 1024 * 1024, batch: 500, dumpMax: 12 * 1024 * 1024, editMax: 256 * 1024 };

const kb = (k: string): Buffer => Buffer.from(keyFromWire(k));
const num = (r: Reply | undefined) => (typeof r === 'number' ? r : Number(text(r ?? null)) || 0);

/** A key as it was: its serialized value and when it would have expired (null: never). */
interface Dumped { key: Buffer; deadline: number | null; dump: Buffer }

export class RedisWriter {
  private undos = new Map<string, { at: number; run: () => Promise<UndoResult> }>();

  constructor(private client: () => RedisClient | null, private o: { now?: () => number; undoMs?: number } = {}) {}

  private now(): number { return this.o.now?.() ?? Date.now(); }

  private c(): RedisClient {
    const c = this.client();
    if (!c) throw new Error('not connected');
    return c;
  }

  private keep(run: () => Promise<UndoResult>): string {
    const now = this.now();
    for (const [id, u] of this.undos) if (now - u.at > (this.o.undoMs ?? 30_000)) this.undos.delete(id);
    const id = randomUUID();
    this.undos.set(id, { at: now, run });
    return id;
  }

  async undo(id: string): Promise<UndoResult> {
    const u = this.undos.get(id);
    this.undos.delete(id);
    if (!u || this.now() - u.at > (this.o.undoMs ?? 30_000)) return { ok: false, reason: 'expired' };
    try { return await u.run(); } catch (e) { return { ok: false, reason: 'error', message: (e as Error).message }; }
  }

  /** How many keys a pattern deletes, three of their names, and whether undo is possible. */
  async preview(db: number, pattern: string): Promise<Preview> {
    const keys = await this.scanAll(db, pattern, LIMITS.matchCap + 1);
    const capped = keys.length > LIMITS.matchCap;
    return { count: Math.min(keys.length, LIMITS.matchCap), sample: keys.slice(0, 3).map((k) => k.toString('utf8')), capped, undo: !capped && keys.length <= LIMITS.undoKeys };
  }

  async run(db: number, op: WriteOp): Promise<WriteResult> {
    try {
      switch (op.op) {
        case 'delete': return await this.del(db, op.keys.map(kb));
        case 'deleteMatching': {
          const keys = await this.scanAll(db, op.pattern, LIMITS.matchCap + 1);
          if (keys.length > LIMITS.matchCap) return { ok: false, reason: 'too-many' };
          return await this.del(db, keys);
        }
        case 'ttl': return await this.ttl(db, kb(op.key), op.ms);
        case 'setString': return await this.edit(db, kb(op.key), ['string', 'none'], ['SET', kb(op.key), op.value, 'KEEPTTL']);
        case 'hset': return await this.edit(db, kb(op.key), ['hash', 'none'], ['HSET', kb(op.key), op.field, op.value]);
        case 'lset': return await this.edit(db, kb(op.key), ['list'], ['LSET', kb(op.key), op.index, op.value]);
        case 'zscore': return await this.edit(db, kb(op.key), ['zset'], ['ZADD', kb(op.key), 'XX', op.score, op.member]);
        case 'jsonSet': return await this.edit(db, kb(op.key), ['ReJSON-RL', 'none'], ['JSON.SET', kb(op.key), '$', op.value]);
        case 'flushdb': await this.c().unsafeWrite(['FLUSHDB', 'ASYNC'], db); return { ok: true, count: 1, undo: null };
        case 'retry': return await this.retry(db, op.queue, op.id);
        case 'remove': return await this.remove(db, op.queue, op.id);
      }
    } catch (e) {
      return { ok: false, reason: 'error', message: (e as Error).message };
    }
  }

  // —— keys ——

  private async scanAll(db: number, pattern: string, cap: number): Promise<Buffer[]> {
    // SCAN may return a key twice: each once.
    const out = new Map<string, Buffer>();
    let cursor = '0';
    do {
      const [r] = await this.c().pipeline([['SCAN', cursor, 'MATCH', pattern, 'COUNT', 1000]], db);
      const a = Array.isArray(r) ? r : [];
      cursor = text(a[0] ?? '0');
      for (const k of Array.isArray(a[1]) ? a[1] : []) if (Buffer.isBuffer(k)) out.set(k.toString('latin1'), k);
    } while (cursor !== '0' && out.size < cap);
    return [...out.values()];
  }

  /**
   * DUMP of these keys with their deadlines, or null when undo isn't possible (no DUMP, too many, too big). A key whose
   * dump would pass the client's reply cap is never dumped: the delete goes on without undo.
   */
  private async dump(db: number, keys: Buffer[]): Promise<Dumped[] | null> {
    if (keys.length > LIMITS.undoKeys) return null;
    const out: Dumped[] = [];
    let bytes = 0;
    for (let i = 0; i < keys.length; i += LIMITS.batch) {
      const part = keys.slice(i, i + LIMITS.batch);
      const sizes = await this.c().pipeline(part.map((k) => ['MEMORY', 'USAGE', k]), db, 30_000);
      if (sizes.some((s) => typeof s === 'number' && s > LIMITS.dumpMax)) return null;
      const at = this.now();
      const rs = await this.c().pipeline(part.flatMap((k) => [['DUMP', k], ['PTTL', k]] as Arg[][]), db, 30_000);
      for (let j = 0; j < part.length; j++) {
        const d = rs[j * 2];
        if (d instanceof RespError) return null;
        if (!Buffer.isBuffer(d)) continue;
        bytes += d.length;
        if (bytes > LIMITS.undoBytes) return null;
        const ttl = num(rs[j * 2 + 1]);
        out.push({ key: part[j]!, deadline: ttl > 0 ? at + ttl : null, dump: d });
      }
    }
    return out;
  }

  /**
   * Puts dumped keys back as they were, with the TTL they had left (one that would have expired meanwhile stays gone);
   * a key written again meanwhile is kept. Returns the kept keys.
   */
  private async restore(db: number, list: Dumped[], replace: boolean): Promise<Set<string>> {
    const kept = new Set<string>();
    const now = this.now();
    const live = list.filter((d) => d.deadline === null || d.deadline > now);
    for (let i = 0; i < live.length; i += LIMITS.batch) {
      const part = live.slice(i, i + LIMITS.batch);
      const rs = await this.c().unsafeWritePipeline(part.map((d) => ['RESTORE', d.key, d.deadline === null ? 0 : Math.max(1, d.deadline - now), d.dump, ...(replace ? ['REPLACE'] : [])]), db, 30_000);
      rs.forEach((r, j) => { if (r instanceof RespError && /^BUSYKEY/.test(r.message)) kept.add(part[j]!.key.toString('latin1')); });
    }
    return kept;
  }

  private async del(db: number, keys: Buffer[]): Promise<WriteResult> {
    if (!keys.length) return { ok: true, count: 0, undo: null };
    const dumped = await this.dump(db, keys);
    let count = 0;
    for (let i = 0; i < keys.length; i += LIMITS.batch) {
      const part = keys.slice(i, i + LIMITS.batch);
      try { count += num(await this.c().unsafeWrite(['UNLINK', ...part], db)); } catch (e) {
        if (!(e instanceof Unknown)) throw e;
        count += num(await this.c().unsafeWrite(['DEL', ...part], db));
      }
    }
    return { ok: true, count, undo: dumped ? this.keep(async () => ({ ok: true, kept: (await this.restore(db, dumped, false)).size })) : null };
  }

  private async ttl(db: number, key: Buffer, ms: number | null): Promise<WriteResult> {
    const [prev] = await this.c().pipeline([['PTTL', key]], db);
    const before = num(prev);
    if (before === -2) return { ok: false, reason: 'gone' };
    const deadline = before >= 0 ? this.now() + before : null;
    if (ms === null) await this.c().unsafeWrite(['PERSIST', key], db);
    else await this.c().unsafeWrite(['PEXPIRE', key, Math.max(1, Math.round(ms))], db);
    return {
      ok: true, count: 1, undo: this.keep(async () => {
        if (deadline === null) await this.c().unsafeWrite(['PERSIST', key], db);
        else await this.c().unsafeWrite(['PEXPIRE', key, Math.max(1, deadline - this.now())], db);
        return { ok: true, kept: 0 };
      })
    };
  }

  /** An edit only on a key of the type it is for (SET must never replace a hash), strings within the preview. */
  private async edit(db: number, key: Buffer, types: string[], cmd: Arg[]): Promise<WriteResult> {
    const [type, len] = await this.c().pipeline([['TYPE', key], ['STRLEN', key]], db);
    if (!types.includes(text(type ?? null) || 'none')) return { ok: false, reason: 'wrong-type' };
    if (text(type ?? null) === 'string' && num(len) > LIMITS.editMax) return { ok: false, reason: 'too-big' };
    const dumped = await this.dump(db, [key]);
    await this.c().unsafeWrite(cmd, db);
    return { ok: true, count: 1, undo: dumped?.length ? this.keep(async () => ({ ok: true, kept: (await this.restore(db, dumped, true)).size })) : null };
  }

  // —— queues ——

  private async script(db: number, name: QueueScript, keys: Arg[], args: Arg[]): Promise<number> {
    const s = QUEUE_SCRIPTS[name];
    try {
      return num(await this.c().unsafeWrite(['EVALSHA', scriptSha(s), keys.length, ...keys, ...args], db));
    } catch (e) {
      if (!(e instanceof ServerError) || !/^NOSCRIPT/.test(e.message)) throw e;
      return num(await this.c().unsafeWrite(['EVAL', s, keys.length, ...keys, ...args], db));
    }
  }

  private static reason(code: number): WriteResult {
    return code === -1 ? { ok: false, reason: 'gone' } : code === -3 ? { ok: false, reason: 'not-failed' } : code === -4 ? { ok: false, reason: 'paused' } : code === -6 ? { ok: false, reason: 'flow' } : { ok: false, reason: 'error' };
  }

  private async retry(db: number, q: QueueRef, id: string): Promise<WriteResult> {
    if (bullActions(q)) {
      const b = `${q.prefix}:${q.name}`;
      const job = `${b}:${id}`;
      const [score, fields, opts] = await this.c().pipeline([['ZSCORE', `${b}:failed`, id], ['HMGET', job, 'finishedOn', 'processedOn', 'failedReason'], ['HGET', job, 'opts']], db);
      let lifo = false;
      try { lifo = !!(JSON.parse(text(opts ?? null) || '{}') as { lifo?: unknown }).lifo; } catch { lifo = false; }
      const code = await this.script(db, 'bullmqRetry', [job, `${b}:failed`, `${b}:wait`, `${b}:meta`, `${b}:active`, `${b}:marker`, `${b}:events`], [id, lifo ? 'RPUSH' : 'LPUSH']);
      if (code !== 1) return RedisWriter.reason(code);
      const old = (Array.isArray(fields) ? fields : []).map((f) => text(f ?? null));
      return {
        ok: true, count: 1, undo: this.keep(async () => {
          const r = await this.script(db, 'bullmqUnretry', [job, `${b}:failed`, `${b}:wait`], [id, text(score ?? null), old[0] ?? '', old[1] ?? '', old[2] ?? '']);
          return r === 1 ? { ok: true, kept: 0 } : { ok: false, reason: 'picked' };
        })
      };
    }
    if (q.lib === 'sidekiq') {
      const e = await sidekiqFailedEntry(q, (cmds) => this.c().pipeline(cmds, db), id);
      if (!e) return { ok: false, reason: 'not-failed' };
      // Sidekiq's own retry: one retry fewer counted, enqueued now. Numbers JSON can't keep exactly are refused.
      if (/(?<![\w."])-?\d{16,}(?![\w."])/.test(e.raw)) return { ok: false, reason: 'big-numbers' };
      const msg = JSON.parse(e.raw) as Record<string, unknown>;
      if (typeof msg.retry_count === 'number') msg.retry_count -= 1;
      msg.enqueued_at = this.now() / 1000;
      const next = JSON.stringify(msg);
      const set = `${q.prefix}${e.set}`;
      // Its own queue (the entry says which), as Sidekiq's retry pushes it.
      const queue = e.queue || q.name;
      const list = `${q.prefix}queue:${queue}`;
      const code = await this.script(db, 'sidekiqRetry', [set, list, `${q.prefix}queues`], [e.raw, next, queue]);
      if (code !== 1) return RedisWriter.reason(code);
      return {
        ok: true, count: 1, undo: this.keep(async () => {
          const r = await this.script(db, 'sidekiqUnretry', [set, list], [e.raw, String(e.score), next]);
          return r === 1 ? { ok: true, kept: 0 } : { ok: false, reason: 'picked' };
        })
      };
    }
    return { ok: false, reason: 'refused' };
  }

  private async remove(db: number, q: QueueRef, id: string): Promise<WriteResult> {
    if (bullActions(q)) {
      const b = `${q.prefix}:${q.name}`;
      const job = `${b}:${id}`;
      const [score] = await this.c().pipeline([['ZSCORE', `${b}:failed`, id]], db);
      const dumped = await this.dump(db, [Buffer.from(job), Buffer.from(`${job}:logs`)]);
      const code = await this.script(db, 'bullmqRemove', [job, `${b}:failed`, `${b}:events`, `${b}:meta`, `${job}:logs`, `${job}:dependencies`, `${job}:processed`, `${job}:failed`, `${job}:unsuccessful`], [id]);
      if (code !== 1) return RedisWriter.reason(code);
      return {
        ok: true, count: 1, undo: dumped ? this.keep(async () => {
          const kept = await this.restore(db, dumped, false);
          // A new job took the id meanwhile: it stays as it is, and is not put in failed.
          if (!kept.has(job)) await this.c().unsafeWrite(['ZADD', `${b}:failed`, text(score ?? null) || String(this.now()), id], db);
          return { ok: true, kept: kept.size };
        }) : null
      };
    }
    if (q.lib === 'sidekiq') {
      const e = await sidekiqFailedEntry(q, (cmds) => this.c().pipeline(cmds, db), id);
      if (!e) return { ok: false, reason: 'not-failed' };
      const set = `${q.prefix}${e.set}`;
      if (num(await this.c().unsafeWrite(['ZREM', set, e.raw], db)) !== 1) return { ok: false, reason: 'not-failed' };
      return { ok: true, count: 1, undo: this.keep(async () => { await this.c().unsafeWrite(['ZADD', set, e.score, e.raw], db); return { ok: true, kept: 0 }; }) };
    }
    return { ok: false, reason: 'refused' };
  }
}
