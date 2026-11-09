// The test Postgres's front proxy (./pg-worker.mjs) forwards through this, in both directions. Plain JS: the worker
// thread imports it (vitest's and Playwright's TypeScript transforms don't reach a `new Worker(path)`).

/**
 * Writes `chunk` on to `to`. When `to`'s buffer is full (its write returned false), `from` pauses until `to` drains:
 * a fast sender never piles its data up in the proxy (backpressure). One wait at a time.
 * @param {Uint8Array} chunk
 * @param {import('node:stream').Readable} from
 * @param {import('node:stream').Writable} to
 */
export function relay(chunk, from, to) {
  if (to.write(chunk) || from.isPaused()) return;
  from.pause();
  to.once('drain', () => from.resume());
}
