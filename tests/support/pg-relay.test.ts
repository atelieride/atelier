// The test Postgres's front proxy forwards with backpressure (./pg-relay.mjs, used by ./pg-worker.mjs): a destination
// whose buffer is full pauses the source until it drains, in both directions.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { relay } from './pg-relay.mjs';

/** A destination that holds each write until `release()`: its buffer fills past 4 bytes. */
function slowSink(): { to: Writable; release: () => void } {
  let pending: (() => void) | null = null;
  const to = new Writable({ highWaterMark: 4, write(_chunk, _enc, cb) { pending = cb; } });
  return { to, release: () => { const cb = pending; pending = null; cb?.(); } };
}

describe('relay', () => {
  test('a full destination pauses the source; it flows again once the destination drains', async () => {
    const from = new PassThrough();
    from.on('data', () => {}); // flowing, as a socket with a data listener is
    const { to, release } = slowSink();
    relay(Buffer.from('ab'), from, to);
    expect(from.isPaused()).toBe(false); // under the mark: the source flows on
    relay(Buffer.from('cdef'), from, to);
    expect(from.isPaused()).toBe(true); // over it: the source waits
    // Still full: another chunk (one already on its way) adds no second wait.
    relay(Buffer.from('g'), from, to);
    expect(to.listenerCount('drain')).toBe(1);
    release();
    release();
    release();
    await new Promise((r) => setImmediate(r));
    expect(from.isPaused()).toBe(false);
    expect(to.listenerCount('drain')).toBe(0);
  });

  test('the worker relays both directions through it', () => {
    const worker = readFileSync(join(__dirname, 'pg-worker.mjs'), 'utf8');
    expect(worker).toMatch(/relay\(chunk, sock, upstream\)/); // client → PGlite
    expect(worker).toMatch(/relay\(d, upstream, sock\)/); // PGlite → client
    expect(worker).not.toMatch(/upstream\.write\(chunk\)|sock\.write\(d\)/);
  });
});
