// The Docker Engine client: the only module that talks to the engine. GET only, over the Unix
// socket only, to nine read endpoints (built by pathOf, checked again by assertAllowed before a socket opens). Whoever
// can write to that socket is root-equivalent on the engine: Atelier must not be able to start, stop, exec or remove
// anything, even by mistake. tests/integration/docker-readonly.test.ts keeps it that way.
import { request, type IncomingMessage } from 'node:http';
import { CONTAINER_ID } from '@shared/docker';

export type DockerRequest =
  | { kind: 'ping' } | { kind: 'version' } | { kind: 'info' } | { kind: 'containers' } | { kind: 'df' } | { kind: 'events' }
  | { kind: 'inspect'; id: string }
  | { kind: 'logs'; id: string; follow: boolean; tail: number; since?: number }
  | { kind: 'stats'; id: string; stream: boolean };

/** The read endpoints, nothing else (`{id}`: 12–64 lowercase hex). */
export const ALLOWED_PATHS = [
  '/_ping', '/version', '/info', '/containers/json', '/containers/{id}/json', '/containers/{id}/logs', '/containers/{id}/stats', '/events', '/system/df'
] as const;

const EVENT_FILTERS = JSON.stringify({ type: ['container', 'image', 'volume', 'network'] });
const MAX_TAIL = 100_000;

function id(v: string): string {
  if (!CONTAINER_ID.test(v)) throw new Error('bad container id');
  return v;
}
function int(v: number, min: number, max: number): number {
  if (!Number.isInteger(v) || v < min || v > max) throw new Error('bad number');
  return v;
}

export function pathOf(r: DockerRequest): string {
  switch (r.kind) {
    case 'ping': return '/_ping';
    case 'version': return '/version';
    case 'info': return '/info';
    case 'df': return '/system/df';
    case 'containers': return '/containers/json?all=1';
    case 'events': return `/events?filters=${encodeURIComponent(EVENT_FILTERS)}`;
    case 'inspect': return `/containers/${id(r.id)}/json`;
    case 'stats': return `/containers/${id(r.id)}/stats?stream=${r.stream ? 1 : 0}`;
    case 'logs': {
      const since = r.since === undefined ? '' : `&since=${int(r.since, 0, 2 ** 40)}`;
      return `/containers/${id(r.id)}/logs?follow=${r.follow ? 1 : 0}&stdout=1&stderr=1&timestamps=1&tail=${int(r.tail, 0, MAX_TAIL)}${since}`;
    }
  }
}

const SHAPES: { path: RegExp; query: RegExp }[] = [
  { path: /^\/_ping$/, query: /^$/ },
  { path: /^\/version$/, query: /^$/ },
  { path: /^\/info$/, query: /^$/ },
  { path: /^\/system\/df$/, query: /^$/ },
  { path: /^\/containers\/json$/, query: /^all=1$/ },
  { path: /^\/events$/, query: new RegExp(`^filters=${encodeURIComponent(EVENT_FILTERS).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) },
  { path: /^\/containers\/[0-9a-f]{12,64}\/json$/, query: /^$/ },
  { path: /^\/containers\/[0-9a-f]{12,64}\/stats$/, query: /^stream=[01]$/ },
  { path: /^\/containers\/[0-9a-f]{12,64}\/logs$/, query: /^follow=[01]&stdout=1&stderr=1&timestamps=1&tail=\d{1,6}(&since=\d{1,13})?$/ }
];

/** Throws unless the path is one of the read endpoints with the query pathOf builds. */
export function assertAllowed(path: string): void {
  const q = path.indexOf('?');
  const p = q < 0 ? path : path.slice(0, q);
  const query = q < 0 ? '' : path.slice(q + 1);
  if (!SHAPES.some((s) => s.path.test(p) && s.query.test(query))) throw new Error('docker path not allowed');
}

export class EngineGone extends Error { constructor() { super('Docker engine not reachable'); } }
export class Denied extends Error { constructor() { super('Permission denied on the Docker socket'); } }
export class NotFound extends Error { constructor() { super('Not found'); } }
export class TooLarge extends Error { constructor() { super('Reply too large'); } }
export class EngineError extends Error { constructor(readonly status: number) { super(`Docker engine error ${status}`); } }

function mapError(e: NodeJS.ErrnoException): Error {
  return e.code === 'EACCES' || e.code === 'EPERM' ? new Denied() : new EngineGone();
}

function open(socket: string, path: string, signal: AbortSignal): Promise<IncomingMessage> {
  assertAllowed(path);
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path, method: 'GET', headers: { Host: 'docker', Accept: 'application/json' }, agent: false, signal }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 200 && status < 300) { resolve(res); return; }
      res.resume();
      reject(status === 404 ? new NotFound() : new EngineError(status));
    });
    req.on('error', (e: NodeJS.ErrnoException) => reject(signal.aborted ? new EngineGone() : mapError(e)));
    req.end();
  });
}

export interface ReadOptions { timeoutMs?: number; maxBytes?: number }

/** A whole reply, as text (`/_ping`) or parsed JSON. Errors: EngineGone, Denied, NotFound, EngineError, TooLarge. */
export async function getText(socket: string, req: DockerRequest, o: ReadOptions = {}): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 5000);
  const max = o.maxBytes ?? 8 * 1024 * 1024;
  try {
    const res = await open(socket, pathOf(req), ctl.signal);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of res as AsyncIterable<Buffer>) {
      size += c.length;
      if (size > max) { ctl.abort(); throw new TooLarge(); }
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (e) {
    if (e instanceof TooLarge || e instanceof Denied || e instanceof NotFound || e instanceof EngineError) throw e;
    throw new EngineGone();
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson(socket: string, req: DockerRequest, o: ReadOptions = {}): Promise<unknown> {
  const text = await getText(socket, req, o);
  try { return JSON.parse(text) as unknown; } catch { throw new EngineError(0); }
}

export interface Stream { close(): void }

/**
 * A long reply (logs, stats, events) chunk by chunk. `onEnd` is called once: with no error when the engine ended it,
 * with one when it failed; never after close().
 */
export function openStream(socket: string, req: DockerRequest, on: { data(chunk: Buffer): void; end(err?: Error): void }): Stream {
  const ctl = new AbortController();
  let done = false;
  const finish = (err?: Error) => { if (done) return; done = true; if (!ctl.signal.aborted) on.end(err); };
  open(socket, pathOf(req), ctl.signal).then((res) => {
    res.on('data', (c: Buffer) => { if (!done) on.data(c); });
    res.on('end', () => finish());
    res.on('error', () => finish(new EngineGone()));
    res.on('close', () => finish());
  }, (e: Error) => finish(e));
  return { close: () => { done = true; ctl.abort(); } };
}
