import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { currentPlatform, type Platform } from '@shared/platform';
import { devEnv } from '../dev-env';

/**
 * Phases of a write op: git prints neither a hook's name nor "signing", but its trace2 event
 * stream does. Every op runs with GIT_TRACE2_EVENT=af_unix:stream:<socket>, a Unix socket main listens on, one per op,
 * in a private 0700 folder; no regular file is written. Without trace2 (old git, socket error) the labels fall back.
 * Windows has no af_unix for git: one file per op in the same private folder (the user's own %TEMP%), tailed while the
 * op runs and removed after.
 */

export type Trace2Signal = { phase: 'hook'; hook: string } | { phase: 'signing' } | { hookFailed: string; code: number };

const SIGNERS = new Set(['gpg', 'gpg2', 'gpgsm', 'ssh-keygen']);

/**
 * Reads trace2 event lines (git 2.54: `child_start` with `child_id`, `child_class`, `hook_name`, `argv`; `child_exit`
 * with `child_id`, `code`; `sid` nests a child git's under its parent's, `A/B`). Children are keyed by sid and id, so a
 * nested git's child 0 is not the op's. Git commands a hook runs (lint-staged, husky) are not the op: inside a running
 * hook, nested events are ignored. A nested git outside any hook (pull's rebase running post-rewrite) is the op's.
 */
export class Trace2Reader {
  private readonly program: string | null;
  /** Hooks running, by `<sid>#<child_id>`. */
  private readonly hooks = new Map<string, { sid: string; hook: string }>();

  constructor(o: { gpgProgram?: string | null } = {}) {
    this.program = o.gpgProgram ? basename(o.gpgProgram) : null;
  }

  /** The hook running now (the last started of those still running), or null: a timeout then is the hook's. */
  running(): string | null {
    return [...this.hooks.values()].at(-1)?.hook ?? null;
  }

  /** One line of the stream: a signal, or null (anything else, malformed lines included). */
  push(line: string): Trace2Signal | null {
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { return null; }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return null;
    const { event, sid, child_id: id, child_class: cls, hook_name: hook, argv, code } = ev as Record<string, unknown>;
    if (typeof sid !== 'string' || typeof id !== 'number') return null;
    const key = `${sid}#${id}`;
    if (event === 'child_start') {
      if ([...this.hooks.values()].some((h) => sid.startsWith(`${h.sid}/`))) return null;
      if (cls === 'hook') {
        if (typeof hook !== 'string' || !hook) return null;
        this.hooks.set(key, { sid, hook });
        return { phase: 'hook', hook };
      }
      const prog = Array.isArray(argv) && typeof argv[0] === 'string' ? basename(argv[0]) : '';
      return prog && (SIGNERS.has(prog) || prog === this.program) ? { phase: 'signing' } : null;
    }
    if (event === 'child_exit') {
      const h = this.hooks.get(key);
      if (!h) return null;
      this.hooks.delete(key);
      return typeof code === 'number' && code !== 0 ? { hookFailed: h.hook, code } : null;
    }
    return null;
  }
}

/** sockaddr_un's sun_path on macOS: 104 bytes with the NUL. */
const MAX_SOCKET_PATH = 103;
/** A line longer than this (no newline yet) is dropped: trace2 lines are short, this is a bound, not a format. */
const MAX_LINE = 256 * 1024;
/** close(): how long open connections get to finish (a detached grandchild may hold one). */
const DRAIN_MS = 250;

let dir: string | null = null;
let seq = 0;
/** Sockets of ops still running, removed by disposeTrace2Dir if an op never closed. */
const live = new Set<string>();

/**
 * The private folder for the sockets: `<tmpdir>/atelier-<pid>` (tests: ATELIER_TEST_TRACE2_DIR, or the run's temp
 * root through TMPDIR). Created lazily once, 0700, and only used when it is a real directory owned by this user.
 * Throws when it can't be (listenTrace2 turns that into "no trace2").
 */
export function trace2Dir(platform: Platform = currentPlatform()): string {
  if (dir) return dir;
  const d = devEnv('ATELIER_TEST_TRACE2_DIR') ?? join(tmpdir(), `atelier-${process.pid}`);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  const st = lstatSync(d);
  // Windows: no uid or mode bits; the folder is in the user's own profile, which only they (and admins) can read.
  if (platform === 'win32') { if (!st.isDirectory()) throw new Error(`trace2: ${d} is not a folder`); dir = d; return d; }
  if (!st.isDirectory() || st.uid !== process.getuid?.()) throw new Error(`trace2: ${d} is not a private folder`);
  if ((st.mode & 0o777) !== 0o700) chmodSync(d, 0o700);
  dir = d;
  return d;
}

export interface Trace2Listener {
  /** The socket (macOS) or the file (Windows), or '' (no trace2: the op runs without it). */
  path: string;
  /** GIT_TRACE2_EVENT's value for the op, or ''. */
  event: string;
  /** Stops listening (open connections get a moment to finish) and removes the socket. Idempotent, never rejects. */
  close(): Promise<void>;
}

const NONE: Trace2Listener = { path: '', event: '', close: () => Promise.resolve() };
/** Windows: how often the file is read while the op runs. */
const TAIL_MS = 100;

/**
 * A Unix socket for one op's trace2 events: `onLine` gets every whole line, from every git process of the op (each
 * connects on its own). Never throws: any failure (folder, path over 103 bytes, listen) resolves with path ''.
 */
export async function listenTrace2(onLine: (line: string) => void, platform: Platform = currentPlatform()): Promise<Trace2Listener> {
  if (platform === 'win32') return listenFile(onLine);
  try {
    const path = join(trace2Dir(), `${++seq}.sock`);
    if (Buffer.byteLength(path) > MAX_SOCKET_PATH) return NONE;
    // A stale socket of an earlier process with this pid (the folder is ours: checked above).
    try { unlinkSync(path); } catch { /* none */ }
    const emit = (line: string) => { try { onLine(line); } catch { /* the reader's problem, not the socket's */ } };
    const conns = new Set<Socket>();
    const server = createServer((c) => {
      conns.add(c);
      c.setEncoding('utf8');
      let buf = '';
      c.on('data', (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) { emit(buf.slice(0, i)); buf = buf.slice(i + 1); }
        if (buf.length > MAX_LINE) buf = '';
      });
      c.on('end', () => { if (buf) emit(buf); buf = ''; });
      c.on('error', () => { /* a git process killed mid-line */ });
      c.on('close', () => conns.delete(c));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => { server.off('error', reject); resolve(); });
    });
    server.on('error', () => { /* after listen: nothing to do, the op runs on */ });
    live.add(path);
    let closing: Promise<void> | null = null;
    const close = () => closing ??= new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        for (const c of conns) c.destroy();
        // Node removes a listening socket's file on close; this covers a version that wouldn't.
        try { unlinkSync(path); } catch { /* removed already */ }
        live.delete(path);
        resolve();
      };
      // server.close's callback waits for every connection to end; the timer bounds that.
      const timer = setTimeout(done, DRAIN_MS);
      server.close(() => done());
    });
    return { path, event: `af_unix:stream:${path}`, close };
  } catch {
    return NONE;
  }
}

/** Windows: git appends its events to a file of the op's own; read as it grows, then once more at close. */
function listenFile(onLine: (line: string) => void): Trace2Listener {
  try {
    const path = join(trace2Dir('win32'), `${++seq}.trace2`);
    writeFileSync(path, '');
    const fd = openSync(path, 'r');
    const chunk = Buffer.alloc(64 * 1024);
    let at = 0;
    let buf = '';
    const emit = (line: string) => { try { onLine(line); } catch { /* the reader's problem */ } };
    const read = () => {
      for (;;) {
        let n = 0;
        try { n = readSync(fd, chunk, 0, chunk.length, at); } catch { return; }
        if (n === 0) return;
        at += n;
        buf += chunk.toString('utf8', 0, n);
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) { emit(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
        if (buf.length > MAX_LINE) buf = '';
      }
    };
    const timer = setInterval(read, TAIL_MS);
    timer.unref?.();
    live.add(path);
    let closing: Promise<void> | null = null;
    const close = () => closing ??= new Promise<void>((resolve) => {
      clearInterval(timer);
      read();
      if (buf) emit(buf);
      buf = '';
      try { closeSync(fd); } catch { /* closed */ }
      // A git still holding it (Windows refuses the removal): kept in `live`, disposeTrace2Dir tries again at quit.
      let removed = true;
      try { unlinkSync(path); } catch (e) { removed = (e as NodeJS.ErrnoException).code === 'ENOENT'; }
      if (removed) live.delete(path);
      resolve();
    });
    return { path, event: path, close };
  } catch {
    return NONE;
  }
}

/** At will-quit: removes the sockets left and the folder (only when empty: nothing else is ever removed). */
export function disposeTrace2Dir(): void {
  for (const p of live) { try { unlinkSync(p); } catch { /* gone */ } }
  live.clear();
  if (dir) { try { rmdirSync(dir); } catch { /* not empty or gone */ } }
  dir = null;
}
