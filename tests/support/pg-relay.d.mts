import type { Readable, Writable } from 'node:stream';

/** Writes `chunk` on to `to`; when `to`'s buffer is full, `from` pauses until `to` drains (./pg-relay.mjs). */
export function relay(chunk: Uint8Array, from: Readable, to: Writable): void;
