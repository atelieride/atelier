// src/main/background-hub.test.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BackgroundHub, probeEndedExits, probeExit, EXIT_RETRY_MS, FEED_MS, LOOP_TAIL_BYTES, MAX_WATCHED, MISSING_GIVE_UP_MS, MISSING_RETRY_MS, POLL_MS, TAIL_BYTES, TRANSCRIPT_BYTES, type HubFs } from './background-hub';
import type { BackgroundFeed, OutputFeed, TimelineFeed } from '@shared/background-feed';
import type { TerminalInfo } from '@shared/protocol';
import { encodeProjectPath } from '@shared/history';
import { BUFFER_LINES } from '@shared/output-tail';

const SID = '89fcf8ea-a6ad-4f29-a390-922953c50a6c';
const SID2 = '11111111-2222-4333-8444-555555555555';
const UID = 501;
// The default config dir's projects root is elsewhere on purpose (as tests point it at a fixture).
const roots = { tmp: `/tmp/claude-${UID}`, projects: '/fixture/claude-projects', configDir: '/home/.claude' };
const enc = (s: string) => new TextEncoder().encode(s);
const out = (cwd: string, id: string, sid = SID) => `${roots.tmp}/${encodeProjectPath(cwd)}/${sid}/tasks/${id}.output`;
const transcript = (cwd: string, id: string) => `${roots.projects}/${encodeProjectPath(cwd)}/${SID}/subagents/agent-${id}.jsonl`;

/** In-memory files: path → bytes and inode; watchers fire on writes. */
function memFs() {
  const files = new Map<string, { data: Uint8Array; ino: number }>();
  const watchers = new Map<string, Set<() => void>>();
  let ino = 1;
  const fs: HubFs = {
    owner: async () => UID,
    // Files, the two roots, and any folder that holds a file (another config dir's projects root).
    realpath: async (p) => (files.has(p) || p === roots.tmp || p === roots.projects || [...files.keys()].some((f) => f.startsWith(`${p}/`)) ? p : null),
    stat: async (p) => { const f = files.get(p); return f ? { size: f.data.length, ino: f.ino } : null; },
    read: async (p, start, length) => files.get(p)!.data.slice(start, start + length),
    watch: (p, cb) => { const s = watchers.get(p) ?? new Set(); s.add(cb); watchers.set(p, s); return () => s.delete(cb); }
  };
  const write = (p: string, text: string, replace = false, notify = true) => {
    const f = files.get(p);
    const data = enc(text);
    if (!f || replace) files.set(p, { data, ino: replace && f ? ++ino + 1000 : ino++ });
    else { const next = new Uint8Array(f.data.length + data.length); next.set(f.data); next.set(data, f.data.length); f.data = next; }
    if (notify) for (const cb of watchers.get(p) ?? []) cb();
  };
  const truncate = (p: string, text: string) => { files.get(p)!.data = enc(text); for (const cb of watchers.get(p) ?? []) cb(); };
  return { fs, write, truncate, watchers };
}

const term = (over: { cwd?: string; sessionCwd?: string; sid?: string; entries?: { id: string; kind: 'shell' | 'agent' | 'monitor' }[]; id?: string } = {}) => ({
  id: over.id ?? 't1', cwd: over.cwd ?? '/w/proj',
  session: { sessionId: over.sid ?? SID, ...(over.sessionCwd ? { cwd: over.sessionCwd } : {}) },
  work: { entries: (over.entries ?? [{ id: 'b1', kind: 'shell' }]).map((e) => ({ ...e, label: e.id, since: 0, counted: true })) }
} as unknown as TerminalInfo);

const hubs: BackgroundHub[] = [];
/** Lets pending reads finish and one feed window pass (a change held back since the last feed goes out). */
const flush = () => vi.advanceTimersByTimeAsync(FEED_MS);
function setup(list: TerminalInfo[] = [term()], extra: { missingGiveUpMs?: number } = {}) {
  const m = memFs();
  const log = vi.fn();
  const hub = new BackgroundHub({ fs: m.fs, roots: () => roots, log, uid: UID, ...extra });
  hubs.push(hub);
  const feeds: { wcId: number; feed: BackgroundFeed }[] = [];
  hub.onFeed = (wcId, feed) => feeds.push({ wcId, feed });
  hub.terminals(list);
  const outputs = () => feeds.map((f) => f.feed).filter((f): f is OutputFeed => f.kind === 'output');
  return { hub, log, feeds, outputs, ...m };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const h of hubs.splice(0)) h.dispose(); vi.useRealTimers(); });

describe('BackgroundHub', () => {
  test('follows a shell: the tail first, then appended lines (watch and poll)', async () => {
    const { hub, write, outputs } = setup();
    write(out('/w/proj', 'b1'), 'one\ntwo\n');
    expect(await hub.watch(1, 't1', 'b1')).toEqual({ ok: true });
    await flush();
    expect(outputs().at(-1)).toMatchObject({ key: 't1:b1', reset: true, lines: ['one', 'two'] });
    write(out('/w/proj', 'b1'), 'three\npart');
    await flush();
    expect(outputs().at(-1)).toMatchObject({ reset: false, lines: ['three'], live: 'part' });
  });
  test('the 1 s poll picks up a write the watcher missed', async () => {
    const { hub, write, outputs } = setup();
    const p = out('/w/proj', 'b1');
    write(p, 'one\n');
    await hub.watch(1, 't1', 'b1');
    await flush();
    write(p, 'two\n', false, false);
    await flush();
    expect(outputs().at(-1)).toMatchObject({ lines: ['one'] });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(outputs().at(-1)).toMatchObject({ reset: false, lines: ['two'] });
  });
  test('uses the session cwd before the terminal cwd', async () => {
    const { hub, write, outputs } = setup([term({ cwd: '/w/proj', sessionCwd: '/w/proj/sub' })]);
    write(out('/w/proj/sub', 'b1'), 'here\n');
    await hub.watch(1, 't1', 'b1');
    await flush();
    expect(outputs().at(-1)).toMatchObject({ lines: ['here'] });
  });
  test('a missing file is retried for 10 s, then unavailable and nothing is left running', async () => {
    const { hub, write, outputs, feeds } = setup();
    await hub.watch(1, 't1', 'b1');
    await flush();
    expect(feeds).toEqual([]);
    await vi.advanceTimersByTimeAsync(MISSING_RETRY_MS);
    write(out('/w/proj', 'b1'), 'late\n');
    await vi.advanceTimersByTimeAsync(MISSING_RETRY_MS);
    expect(outputs().at(-1)).toMatchObject({ lines: ['late'] });
    const other = setup();
    await other.hub.watch(1, 't1', 'b1');
    await vi.advanceTimersByTimeAsync(MISSING_GIVE_UP_MS + MISSING_RETRY_MS);
    expect(other.outputs().at(-1)).toMatchObject({ unavailable: 'missing' });
    expect(other.outputs()).toHaveLength(1);
    hub.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  // The e2e give up sooner (ATELIER_TEST_BG_MISSING_MS); the app keeps MISSING_GIVE_UP_MS.
  test('the missing give-up can be shorter (a test timing)', async () => {
    const { outputs, hub } = setup([term()], { missingGiveUpMs: 1000 });
    await hub.watch(1, 't1', 'b1');
    await vi.advanceTimersByTimeAsync(1000 + MISSING_RETRY_MS);
    expect(outputs().at(-1)).toMatchObject({ unavailable: 'missing' });
  });
  test('a bad session cwd is refused as outside at once', async () => {
    const { hub, feeds } = setup([term({ cwd: 'relative/dir' })]);
    expect(await hub.watch(1, 't1', 'b1')).toEqual({ ok: false, reason: 'outside' });
    expect(feeds).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  test('a truncated or replaced file restarts', async () => {
    const { hub, write, truncate, outputs } = setup();
    const p = out('/w/proj', 'b1');
    write(p, 'a\nb\n');
    await hub.watch(1, 't1', 'b1');
    await flush();
    truncate(p, 'x\n');
    await flush();
    expect(outputs().at(-1)).toMatchObject({ reset: true, lines: ['x'] });
    write(p, 'fresh\n', true);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(outputs().at(-1)).toMatchObject({ reset: true, lines: ['fresh'] });
  });
  test('a path outside the roots is never read or stat-ed', async () => {
    const { hub, fs, outputs } = setup();
    fs.realpath = async (p) => (p === roots.tmp ? '/real/tmp' : '/etc/passwd');
    const stat = vi.fn(fs.stat); const read = vi.fn(fs.read);
    fs.stat = stat; fs.read = read;
    await hub.watch(1, 't1', 'b1');
    await flush();
    expect(outputs().at(-1)).toMatchObject({ unavailable: 'outside', lines: [] });
    expect(stat).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  test('a temp root owned by another user is refused: outputs are never read, exit codes never probed', async () => {
    const { hub, write, fs, outputs, feeds } = setup([term({ entries: [{ id: 'b1', kind: 'shell' }, { id: 'a1', kind: 'agent' }] })]);
    write(out('/w/proj', 'b1'), 'planted\n\n[exited with code 0]\n');
    write(transcript('/w/proj', 'a1'), `${JSON.stringify({ type: 'user', message: { content: 'Find it' } })}\n`);
    // /tmp is shared: someone else made /tmp/claude-<our uid> first.
    fs.owner = async (p) => (p === roots.tmp ? 0 : UID);
    const read = vi.fn(fs.read);
    fs.read = read;
    await hub.watch(1, 't1', 'b1');
    await flush();
    expect(outputs().at(-1)).toMatchObject({ unavailable: 'outside', lines: [] });
    expect(await hub.exitOf('t1', 'b1')).toBeNull();
    expect(read).not.toHaveBeenCalled();
    // The projects root lives in the user's home: not concerned.
    await hub.watch(1, 't1', 'a1');
    await flush();
    expect(feeds.at(-1)!.feed).toMatchObject({ kind: 'timeline', meta: { task: 'Find it' } });
    // An owner that cannot be read is no proof either.
    fs.owner = async () => null;
    expect(await hub.exitOf('t1', 'b1')).toBeNull();
  });
  test('a file that resolves to the root itself is outside', async () => {
    const { hub, fs, outputs } = setup();
    fs.realpath = async () => '/etc/passwd';
    await hub.watch(1, 't1', 'b1');
    await flush();
    expect(outputs().at(-1)).toMatchObject({ unavailable: 'outside', lines: [] });
  });
  test('unknown terminals and items get no follower; a hostile id is refused', async () => {
    const { hub } = setup();
    expect(await hub.watch(1, 'nope', 'b1')).toEqual({ ok: false, reason: 'missing' });
    expect(await hub.watch(1, 't1', 'zz')).toEqual({ ok: false, reason: 'missing' });
    expect(await hub.watch(1, 't1', '../x')).toEqual({ ok: false, reason: 'outside' });
  });
  test('at most MAX_WATCHED per window: the oldest is dropped', async () => {
    const ids = Array.from({ length: MAX_WATCHED + 1 }, (_, i) => `b${i}`);
    const { hub, write, watchers } = setup([term({ entries: ids.map((id) => ({ id, kind: 'shell' })) })]);
    for (const id of ids) write(out('/w/proj', id), `${id}\n`);
    for (const id of ids) await hub.watch(1, 't1', id);
    await flush();
    expect(watchers.get(out('/w/proj', 'b0'))?.size ?? 0).toBe(0);
    expect(watchers.get(out('/w/proj', `b${MAX_WATCHED}`))!.size).toBe(1);
  });
  test('re-watching refreshes the order: the least recently subscribed is the one dropped', async () => {
    const ids = Array.from({ length: MAX_WATCHED + 1 }, (_, i) => `b${i}`);
    const { hub, write, watchers } = setup([term({ entries: ids.map((id) => ({ id, kind: 'shell' })) })]);
    for (const id of ids) write(out('/w/proj', id), `${id}\n`);
    for (const id of ids.slice(0, MAX_WATCHED)) await hub.watch(1, 't1', id);
    await hub.watch(1, 't1', 'b0');
    await hub.watch(1, 't1', `b${MAX_WATCHED}`);
    await flush();
    expect(watchers.get(out('/w/proj', 'b0'))!.size).toBe(1);
    expect(watchers.get(out('/w/proj', 'b1'))?.size ?? 0).toBe(0);
  });
  test('unwatch, a closed window and a new session in the same terminal close followers', async () => {
    const { hub, write, watchers } = setup();
    const p = out('/w/proj', 'b1');
    write(p, 'a\n');
    await hub.watch(1, 't1', 'b1');
    await hub.watch(2, 't1', 'b1');
    await flush();
    expect(watchers.get(p)!.size).toBe(2);
    hub.unwatch(1, 't1', 'b1');
    expect(watchers.get(p)!.size).toBe(1);
    hub.windowGone(2);
    expect(watchers.get(p)!.size).toBe(0);
    await hub.watch(3, 't1', 'b1');
    await flush();
    hub.terminals([term({ sid: SID2 })]);
    expect(watchers.get(p)!.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  test('an unwatch while the root is being resolved leaves no watcher, timer or feed', async () => {
    const { hub, write, fs, watchers, feeds } = setup();
    const p = out('/w/proj', 'b1');
    write(p, 'a\n');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const real = fs.realpath;
    fs.realpath = async (x) => { if (x === roots.tmp) await gate; return real(x); };
    await hub.watch(1, 't1', 'b1');
    await flush();
    hub.unwatch(1, 't1', 'b1');
    release();
    await flush();
    expect(watchers.get(p)?.size ?? 0).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(feeds).toEqual([]);
  });
  test('an unwatch while the root is resolved to somewhere outside emits nothing', async () => {
    const { hub, write, fs, feeds } = setup();
    write(out('/w/proj', 'b1'), 'a\n');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    fs.realpath = async (x) => { if (x === roots.tmp) { await gate; return '/elsewhere'; } return x; };
    await hub.watch(1, 't1', 'b1');
    await flush();
    hub.unwatch(1, 't1', 'b1');
    release();
    await flush();
    expect(feeds).toEqual([]);
  });
  test('re-watching during a pending read neither duplicates nor reorders lines', async () => {
    const { hub, write, fs, feeds, outputs } = setup();
    write(out('/w/proj', 'b1'), 'a\nb\n');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const read = fs.read;
    let first = true;
    fs.read = async (...args) => { if (first) { first = false; await gate; } return read(...args); };
    await hub.watch(1, 't1', 'b1');
    await flush();
    await hub.watch(1, 't1', 'b1');
    release();
    await flush();
    expect(feeds).toHaveLength(1);
    expect(outputs()[0]).toMatchObject({ reset: true, lines: ['a', 'b'] });
  });
  test('re-watching after unavailable resumes following', async () => {
    const { hub, write, outputs } = setup();
    await hub.watch(1, 't1', 'b1');
    await vi.advanceTimersByTimeAsync(MISSING_GIVE_UP_MS + MISSING_RETRY_MS);
    expect(outputs().at(-1)).toMatchObject({ unavailable: 'missing' });
    const p = out('/w/proj', 'b1');
    write(p, 'back\n');
    await hub.watch(1, 't1', 'b1');
    await flush();
    expect(outputs().at(-1)).toMatchObject({ reset: true, lines: ['back'] });
    write(p, 'more\n');
    await flush();
    expect(outputs().at(-1)).toMatchObject({ reset: false, lines: ['more'] });
  });
  test('re-watching during a missing-file wait leaves one retry chain', async () => {
    const { hub } = setup();
    await hub.watch(1, 't1', 'b1');
    await flush();
    await hub.watch(1, 't1', 'b1');
    await flush();
    expect(vi.getTimerCount()).toBe(1);
  });
  test("an agent of a session with another Claude config dir: its transcript from that dir's projects", async () => {
    const ops = '/home/.claude_ops';
    const { hub, write, feeds } = setup([{ ...term({ entries: [{ id: 'a1', kind: 'agent' }] }), configDir: ops } as TerminalInfo]);
    write(`${ops}/projects/${encodeProjectPath('/w/proj')}/${SID}/subagents/agent-a1.jsonl`, `${JSON.stringify({ type: 'user', message: { content: 'Find it' } })}\n`);
    await hub.watch(1, 't1', 'a1');
    await flush();
    expect(feeds.at(-1)!.feed).toMatchObject({ kind: 'timeline', meta: { task: 'Find it' } });
  });
  test('a session of the default config dir reads the default projects root (which tests point elsewhere), not <dir>/projects', async () => {
    const { hub, write, feeds } = setup([{ ...term({ entries: [{ id: 'a1', kind: 'agent' }] }), configDir: roots.configDir } as TerminalInfo]);
    write(transcript('/w/proj', 'a1'), `${JSON.stringify({ type: 'user', message: { content: 'Find it' } })}\n`);
    await hub.watch(1, 't1', 'a1');
    await flush();
    expect(feeds.at(-1)!.feed).toMatchObject({ kind: 'timeline', meta: { task: 'Find it' } });
  });
  test("another config dir's projects root owned by another user is refused; a bad config dir falls back to the default", async () => {
    const ops = '/home/.claude_ops';
    const { hub, write, fs, feeds } = setup([{ ...term({ entries: [{ id: 'a1', kind: 'agent' }] }), configDir: ops } as TerminalInfo]);
    write(`${ops}/projects/${encodeProjectPath('/w/proj')}/${SID}/subagents/agent-a1.jsonl`, `${JSON.stringify({ type: 'user', message: { content: 'Planted' } })}\n`);
    fs.owner = async (p) => (p === `${ops}/projects` ? 0 : UID);
    await hub.watch(1, 't1', 'a1');
    await flush();
    expect(feeds.at(-1)!.feed).toMatchObject({ unavailable: 'outside' });
    const bad = setup([{ ...term({ entries: [{ id: 'a1', kind: 'agent' }] }), configDir: '/home/../etc' } as TerminalInfo]);
    bad.write(transcript('/w/proj', 'a1'), `${JSON.stringify({ type: 'user', message: { content: 'Find it' } })}\n`);
    await bad.hub.watch(1, 't1', 'a1');
    await flush();
    expect(bad.feeds.at(-1)!.feed).toMatchObject({ kind: 'timeline', meta: { task: 'Find it' } });
  });
  test('an agent: its transcript as a timeline', async () => {
    const { hub, write, feeds } = setup([term({ entries: [{ id: 'a1', kind: 'agent' }] })]);
    write(transcript('/w/proj', 'a1'), `${JSON.stringify({ type: 'user', message: { content: 'Find it' } })}\n${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: { file_path: '/w/proj/a.ts' } }] } })}\n`);
    await hub.watch(1, 't1', 'a1');
    await flush();
    const f = feeds.at(-1)!.feed as TimelineFeed;
    expect(f).toMatchObject({ kind: 'timeline', meta: { task: 'Find it', tools: 1 } });
    expect(f.entries[0]).toMatchObject({ tool: 'Read', target: 'a.ts' });
  });
  test('a huge transcript is read from its last 4 MiB at a line boundary', async () => {
    const { hub, write, feeds } = setup([term({ entries: [{ id: 'a1', kind: 'agent' }] })]);
    const filler = `${JSON.stringify({ type: 'system', pad: 'x'.repeat(1000) })}\n`;
    write(transcript('/w/proj', 'a1'), filler.repeat(Math.ceil(TRANSCRIPT_BYTES / filler.length) + 50)
      + `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'z', name: 'Grep', input: { pattern: 'p' } }] } })}\n`);
    await hub.watch(1, 't1', 'a1');
    await flush();
    const f = feeds.at(-1)!.feed as TimelineFeed;
    expect(f.unavailable).toBeUndefined();
    expect(f.entries.at(-1)).toMatchObject({ tool: 'Grep' });
  });
  test('a transcript read from mid-file does not take a later user line for the task', async () => {
    const { hub, write, feeds } = setup([term({ entries: [{ id: 'a1', kind: 'agent' }] })]);
    const filler = `${JSON.stringify({ type: 'system', pad: 'x'.repeat(1000) })}\n`;
    write(transcript('/w/proj', 'a1'), filler.repeat(Math.ceil(TRANSCRIPT_BYTES / filler.length) + 50)
      + `${JSON.stringify({ type: 'user', message: { content: 'A follow-up, not the task' } })}\n`);
    await hub.watch(1, 't1', 'a1');
    await flush();
    const f = feeds.at(-1)!.feed as TimelineFeed;
    expect(f.meta.task).toBeUndefined();
  });
  test('a window that starts exactly at a line start keeps that line', async () => {
    const { hub, write, outputs } = setup();
    const line = (i: number) => `${String(i).padStart(15, '0')}\n`; // 16 bytes: 65536 is a multiple
    write(out('/w/proj', 'b1'), Array.from({ length: 6000 }, (_, i) => line(i)).join(''));
    await hub.watch(1, 't1', 'b1');
    await flush();
    const first = (6000 * 16 - TAIL_BYTES) / 16;
    expect(outputs().at(-1)!.lines[0]).toBe(String(first).padStart(15, '0'));
  });
  test('a window without any newline (a progress bar) keeps its latest segment', async () => {
    const { hub, write, outputs } = setup();
    write(out('/w/proj', 'b1'), `${'step\r'.repeat(30000)}last`);
    await hub.watch(1, 't1', 'b1');
    await flush();
    expect(outputs().at(-1)).toMatchObject({ reset: true, live: 'last' });
  });
  test('the exit code reaches the feed when the trailer is appended', async () => {
    const { hub, write, outputs } = setup();
    const p = out('/w/proj', 'b1');
    write(p, 'x\n');
    await hub.watch(1, 't1', 'b1');
    await flush();
    write(p, '\n[exited with code 3]\n');
    await flush();
    expect(outputs().at(-1)).toMatchObject({ exit: 3 });
  });
  test('a burst of short lines is a healthy reset snapshot, not an unreadable file', async () => {
    const { hub, write, outputs, log } = setup();
    const p = out('/w/proj', 'b1');
    write(p, 'first\n');
    await hub.watch(1, 't1', 'b1');
    await flush();
    write(p, `${'a\n'.repeat(600_000)}last\n`);
    await flush();
    const f = outputs().at(-1)!;
    expect(f.unavailable).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    expect(f.reset).toBe(true);
    expect(f.lines.length).toBeLessThanOrEqual(BUFFER_LINES);
    expect(f.lines.at(-1)).toBe('last');
  });
  test('an unreadable file logs once, reports once and is never read again', async () => {
    const { hub, write, fs, log, outputs } = setup();
    write(out('/w/proj', 'b1'), 'a\n');
    const read = vi.fn(async () => { throw new Error('EIO'); });
    fs.read = read;
    await hub.watch(1, 't1', 'b1');
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(log).toHaveBeenCalledTimes(1);
    expect(outputs().filter((f) => f.unavailable === 'unreadable')).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  test('an onFeed that throws is not a file error', async () => {
    const { hub, write, log } = setup();
    const feedsSeen: BackgroundFeed[] = [];
    hub.onFeed = (_w, f) => { feedsSeen.push(f); throw new Error('Object has been destroyed'); };
    const p = out('/w/proj', 'b1');
    write(p, 'a\n');
    await hub.watch(1, 't1', 'b1');
    await flush();
    write(p, 'b\n');
    await flush();
    expect(feedsSeen.map((f) => f.kind === 'output' && f.unavailable)).not.toContain('unreadable');
    expect(feedsSeen.at(-1)).toMatchObject({ lines: ['b'] });
    expect(log).toHaveBeenCalledTimes(1);
  });
  test('dispose leaves no watcher and no timer', async () => {
    const { hub, write, watchers } = setup();
    const p = out('/w/proj', 'b1');
    write(p, 'a\n');
    await hub.watch(1, 't1', 'b1');
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    hub.dispose();
    expect(watchers.get(p)!.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  test('a chatty output is coalesced: at most one feed per FEED_MS, every line in order', async () => {
    const { hub, write, outputs } = setup();
    const p = out('/w/proj', 'b1');
    write(p, 'start\n');
    await hub.watch(1, 't1', 'b1');
    await vi.advanceTimersByTimeAsync(0);
    const before = outputs().length;
    expect(before).toBe(1);
    // 1,000 appends, each read as it lands, all within the same 100 ms.
    for (let i = 0; i < 1000; i++) { write(p, `l${i}\n`); await vi.advanceTimersByTimeAsync(0); }
    await vi.advanceTimersByTimeAsync(FEED_MS);
    const after = outputs().slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThanOrEqual(2);
    expect(after.every((f) => !f.reset)).toBe(true);
    expect(after.flatMap((f) => f.lines)).toEqual(Array.from({ length: 1000 }, (_, i) => `l${i}`));
    // The window over, the next line goes out at once.
    await vi.advanceTimersByTimeAsync(FEED_MS);
    write(p, 'next\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(outputs().at(-1)).toMatchObject({ lines: ['next'] });
  });
  test('a reset within the window wins and carries the whole snapshot; the latest live line and exit go out', async () => {
    const { hub, write, truncate, outputs } = setup();
    const p = out('/w/proj', 'b1');
    write(p, 'a\n');
    await hub.watch(1, 't1', 'b1');
    await vi.advanceTimersByTimeAsync(0);
    const before = outputs().length;
    write(p, 'b\n');
    await vi.advanceTimersByTimeAsync(0);
    truncate(p, 'x\n');
    await vi.advanceTimersByTimeAsync(0);
    write(p, 'z\npart');
    await vi.advanceTimersByTimeAsync(0);
    expect(outputs()).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(FEED_MS);
    expect(outputs().slice(before)).toEqual([expect.objectContaining({ reset: true, lines: ['x', 'z'], live: 'part' })]);
  });
  test('a flush timer firing mid-tick waits for the tick: nothing partial goes out between two chunk reads', async () => {
    const m = memFs();
    const gates: (() => void)[] = [];
    let gated = false;
    const fs: HubFs = { ...m.fs, read: async (p, start, length) => { if (gated) await new Promise<void>((r) => gates.push(r)); return m.fs.read(p, start, length); } };
    const hub = new BackgroundHub({ fs, roots: () => roots, log: vi.fn(), uid: UID });
    hubs.push(hub);
    const feeds: TimelineFeed[] = [];
    hub.onFeed = (_w, f) => { if (f.kind === 'timeline') feeds.push(f); };
    hub.terminals([term({ entries: [{ id: 'a1', kind: 'agent' }] })]);
    const p = transcript('/w/proj', 'a1');
    const step = (id: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Grep', input: { pattern: `${id}${'x'.repeat(900)}` } }] } });
    m.write(p, `${JSON.stringify({ type: 'user', message: { content: 'Find it' } })}\n`);
    await hub.watch(1, 't1', 'a1');
    await vi.advanceTimersByTimeAsync(0);
    // A small change inside the window: its feed is held back behind the timer.
    m.write(p, `${step('first')}\n`);
    await vi.advanceTimersByTimeAsync(0);
    expect(feeds).toHaveLength(1);
    // A two-chunk append (over 1 MiB): the first read lands, the second is held while the timer's moment passes.
    gated = true;
    m.write(p, Array.from({ length: 1300 }, (_, i) => `${step(`s${i}`)}\n`).join(''));
    await vi.advanceTimersByTimeAsync(0);
    gates.shift()!(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(FEED_MS * 2);
    expect(feeds).toHaveLength(1);
    gated = false;
    while (gates.length) { gates.shift()!(); await vi.advanceTimersByTimeAsync(0); }
    await vi.advanceTimersByTimeAsync(FEED_MS * 2);
    expect(feeds.length).toBeGreaterThan(1);
    expect(feeds.at(-1)!.entries.at(-1)).toMatchObject({ target: expect.stringContaining('s1299') });
  });
  test('a closed follower sends nothing it held back', async () => {
    const { hub, write, outputs } = setup();
    const p = out('/w/proj', 'b1');
    write(p, 'a\n');
    await hub.watch(1, 't1', 'b1');
    await vi.advanceTimersByTimeAsync(0);
    write(p, 'b\n');
    await vi.advanceTimersByTimeAsync(0);
    hub.unwatch(1, 't1', 'b1');
    await vi.advanceTimersByTimeAsync(FEED_MS);
    expect(outputs().flatMap((f) => f.lines)).toEqual(['a']);
    expect(vi.getTimerCount()).toBe(0);
  });
  test('a timeline goes out only when a line completed, and at most once per FEED_MS', async () => {
    const { hub, write, feeds } = setup([term({ entries: [{ id: 'a1', kind: 'agent' }] })]);
    const p = transcript('/w/proj', 'a1');
    const step = (id: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Grep', input: { pattern: id } }] } });
    write(p, `${JSON.stringify({ type: 'user', message: { content: 'Find it' } })}\n`);
    await hub.watch(1, 't1', 'a1');
    await vi.advanceTimersByTimeAsync(FEED_MS);
    expect(feeds).toHaveLength(1);
    // Half a line: nothing new to show.
    const line = step('g1');
    write(p, line.slice(0, 20));
    await vi.advanceTimersByTimeAsync(FEED_MS);
    expect(feeds).toHaveLength(1);
    write(p, `${line.slice(20)}\n`);
    await vi.advanceTimersByTimeAsync(0);
    expect(feeds).toHaveLength(2);
    expect((feeds.at(-1)!.feed as TimelineFeed).entries.at(-1)).toMatchObject({ target: 'g1' });
    for (let i = 0; i < 50; i++) { write(p, `${step(`s${i}`)}\n`); await vi.advanceTimersByTimeAsync(0); }
    await vi.advanceTimersByTimeAsync(FEED_MS);
    expect(feeds.length).toBeLessThanOrEqual(3);
    expect((feeds.at(-1)!.feed as TimelineFeed).entries.at(-1)).toMatchObject({ target: 's49' });
  });
  test('exitOf reads the trailer of an ended shell', async () => {
    const { hub, write } = setup();
    write(out('/w/proj', 'b1'), 'x\n\n[exited with code 3]\n');
    expect(await hub.exitOf('t1', 'b1')).toBe(3);
    expect(await hub.exitOf('t1', 'nope')).toBeNull();
  });
  test('exitOf refuses an output that is a symlink out of the temp root, without reading it', async () => {
    const { hub, write, fs } = setup();
    const p = out('/w/proj', 'b1');
    write(p, '\n[exited with code 3]\n');
    const real = fs.realpath;
    fs.realpath = async (x) => (x === p ? '/etc/elsewhere.output' : real(x));
    const read = vi.fn(fs.read);
    const stat = vi.fn(fs.stat);
    fs.read = read; fs.stat = stat;
    expect(await hub.exitOf('t1', 'b1')).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });
  test('watch a recent item after the session ended: found from its own session and folder', async () => {
    const { hub, write, watchers, feeds, outputs } = setup();
    const p = out('/w/proj', 'b1');
    write(p, 'one\n');
    await hub.watch(1, 't1', 'b1');
    await flush();
    // SessionEnd: the terminal has no session and no work, its shell is a recent item (the shell's cwd moved on).
    const ended = { id: 't1', cwd: '/w/else', recent: [{ id: 'b1', kind: 'shell', label: 'b1', since: 0, endedAt: 1, exit: null, sessionId: SID, cwd: '/w/proj' }] } as unknown as TerminalInfo;
    hub.terminals([ended]);
    expect(watchers.get(p)!.size).toBe(1);
    write(p, 'two\n');
    await flush();
    expect(outputs().at(-1)).toMatchObject({ lines: ['two'] });
    // A new watch (the tab shown again) and the exit probe still find the file.
    expect(await hub.watch(2, 't1', 'b1')).toEqual({ ok: true });
    await flush();
    expect(feeds.filter((f) => f.wcId === 2).at(-1)!.feed).toMatchObject({ reset: true, lines: ['one', 'two'] });
    write(p, '\n[exited with code 4]\n');
    expect(await hub.exitOf('t1', 'b1')).toBe(4);
    // A different session in the terminal: its recent items are gone, and so are their followers.
    hub.terminals([term({ sid: SID2, entries: [] })]);
    expect(watchers.get(p)!.size).toBe(0);
    expect(await hub.watch(1, 't1', 'b1')).toEqual({ ok: false, reason: 'missing' });
  });
  test('a recent item of a live session is read from the session it ran in', async () => {
    const { hub, write, outputs } = setup([{ ...term({ entries: [] }), recent: [{ id: 'b0', kind: 'shell', label: 'b0', since: 0, endedAt: 1, exit: null, sessionId: SID, cwd: '/w/proj/sub' }] } as unknown as TerminalInfo]);
    write(out('/w/proj/sub', 'b0'), 'old\n');
    expect(await hub.watch(1, 't1', 'b0')).toEqual({ ok: true });
    await flush();
    expect(outputs().at(-1)).toMatchObject({ lines: ['old'] });
  });
});

describe('probeEndedExits', () => {
  test('shells and monitors are probed (agents never); a code found is attached and published once', async () => {
    const exitOf = vi.fn(async (_t: string, id: string) => (id === 'b1' ? 2 : id === 'm1' ? 0 : null));
    const setExit = vi.fn((_t: string, id: string) => id !== 'm1');
    const publish = vi.fn();
    const waits: number[] = [];
    await Promise.all(probeEndedExits([
      { terminalId: 't1', id: 'b1', kind: 'shell' }, { terminalId: 't1', id: 'a1', kind: 'agent' },
      { terminalId: 't1', id: 'm1', kind: 'monitor' }, { terminalId: 't1', id: 'b2', kind: 'shell' }
    ], { exitOf, setExit, publish, wait: async (ms) => { waits.push(ms); }, live: () => true, log: vi.fn() }));
    expect(exitOf.mock.calls.map((c) => c[1])).toEqual(['b1', 'm1', 'b2', 'b2']);
    expect(waits).toEqual([EXIT_RETRY_MS]);
    expect(setExit.mock.calls).toEqual([['t1', 'b1', 2], ['t1', 'm1', 0]]);
    // m1's recent item was gone by then (setExit false): nothing new to publish for it.
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('probeEndedExits failures', () => {
  test('a probe that throws is logged, never an unhandled rejection', async () => {
    const log = vi.fn();
    await Promise.all(probeEndedExits([{ terminalId: 't1', id: 'b1', kind: 'shell' }], {
      exitOf: async () => { throw new Error('boom'); }, setExit: () => true, publish: vi.fn(), wait: async () => {}, live: () => true, log
    }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('probeExit', () => {
  test('a found code is returned at once; a null is retried once after the delay', async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => { waits.push(ms); };
    const first = vi.fn().mockResolvedValue(0);
    expect(await probeExit(first, wait)).toBe(0);
    expect(waits).toEqual([]);
    const second = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(2);
    expect(await probeExit(second, wait)).toBe(2);
    expect(waits).toEqual([EXIT_RETRY_MS]);
    const never = vi.fn().mockResolvedValue(null);
    expect(await probeExit(never, wait)).toBeNull();
    expect(never).toHaveBeenCalledTimes(2);
  });
  test('no retry when the app is no longer live after the wait', async () => {
    const read = vi.fn().mockResolvedValue(null);
    expect(await probeExit(read, async () => {}, () => false)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('BackgroundHub.loop', () => {
  const capture = readFileSync(resolve(__dirname, '../../tests/fixtures/transcripts/loop-wakeup.jsonl'), 'utf8');
  const scheduleAt = (ms: number) => { const d = new Date(ms); return `${d.getMinutes()} ${d.getHours()} * * *`; };
  const LABEL = '/loop check whether a file named done.txt exists in this…';
  const session = (cwd: string, sid = SID) => `${roots.projects}/${encodeProjectPath(cwd)}/${sid}.jsonl`;
  const loopTerm = (over: { configDir?: string; schedule?: string; sessionCwd?: string } = {}) => ({
    ...term({ entries: [], ...(over.sessionCwd ? { sessionCwd: over.sessionCwd } : {}) }),
    ...(over.configDir ? { configDir: over.configDir } : {}),
    work: { entries: [], crons: [{ id: 'w2', label: LABEL, schedule: over.schedule ?? scheduleAt(1792225920000), recurring: false, next: null }] }
  } as unknown as TerminalInfo);

  // A few minutes before the second wake-up of the capture (matching wants it within an hour of now).
  beforeEach(() => { vi.setSystemTime(1792225920000 - 3 * 60_000); });

  test('no wake-up in a tail that already reaches further back than any wake-up can be: no wider read (a retry stays cheap)', async () => {
    const { hub, write, fs } = setup([loopTerm()]);
    const old = new Date(1792225920000 - 3 * 3600_000).toISOString();
    const line = `${JSON.stringify({ type: 'assistant', timestamp: old, message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000) }] } })}\n`;
    write(session('/w/proj'), line.repeat(700));
    const read = vi.spyOn(fs, 'read');
    expect(await hub.loop('t1', 'w2')).toEqual({ ok: false, reason: 'missing' });
    expect(read).toHaveBeenCalledTimes(1);
  });
  test('an ordinary cron is no loop: nothing is read', async () => {
    const plain = { ...loopTerm(), work: { entries: [], crons: [{ id: 'w2', label: 'check the deploy', schedule: '*/5 * * * *', recurring: true, next: null }] } } as unknown as TerminalInfo;
    const { hub, write, fs } = setup([plain]);
    write(session('/w/proj'), capture);
    const read = vi.spyOn(fs, 'read');
    expect(await hub.loop('t1', 'w2')).toEqual({ ok: false, reason: 'missing' });
    expect(read).not.toHaveBeenCalled();
  });
  test('a run that reaches the start of the tail is read again from further back, so its start and count are whole', async () => {
    const { hub, write, fs } = setup([loopTerm()]);
    const lines = capture.split('\n');
    const filler = `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000) }] } })}\n`;
    // The first wake-up, ~600 KB of turns, then the second: the tail holds only the second.
    write(session('/w/proj'), `${lines.slice(0, 4).join('\n')}\n${filler.repeat(600)}${lines.slice(4).join('\n')}`);
    const read = vi.spyOn(fs, 'read');
    expect(await hub.loop('t1', 'w2')).toMatchObject({ ok: true, detail: { checks: 2, startedAt: Date.parse('2026-10-17T08:24:14.444Z') } });
    expect(read).toHaveBeenCalledTimes(2);
  });
  test("the cron's wake-up from the session's own transcript", async () => {
    const { hub, write } = setup([loopTerm()]);
    write(session('/w/proj'), capture);
    expect(await hub.loop('t1', 'w2')).toMatchObject({ ok: true, detail: { scheduledFor: 1792225920000, checks: 2, complete: true, reason: "File appearance can't be pushed to me; keep polling for done.txt." } });
  });
  test("another config dir: that dir's projects root, refused when it is not the user's", async () => {
    const ops = '/home/.claude_ops';
    const { hub, write, fs } = setup([loopTerm({ configDir: ops })]);
    write(`${ops}/projects/${encodeProjectPath('/w/proj')}/${SID}.jsonl`, capture);
    expect(await hub.loop('t1', 'w2')).toMatchObject({ ok: true });
    fs.owner = async (p) => (p === `${ops}/projects` ? 0 : UID);
    expect(await hub.loop('t1', 'w2')).toEqual({ ok: false, reason: 'outside' });
  });
  test('unknown terminal or cron, a missing file, an unmatched cron: missing; garbage: format; bad ids: outside', async () => {
    const { hub, write } = setup([loopTerm()]);
    expect(await hub.loop('t9', 'w2')).toEqual({ ok: false, reason: 'missing' });
    expect(await hub.loop('t1', 'zz')).toEqual({ ok: false, reason: 'missing' });
    expect(await hub.loop('t1', '../x')).toEqual({ ok: false, reason: 'outside' });
    expect(await hub.loop('t1', 'w2')).toEqual({ ok: false, reason: 'missing' });
    write(session('/w/proj'), Array.from({ length: 30 }, () => 'not json').join('\n'));
    expect(await hub.loop('t1', 'w2')).toEqual({ ok: false, reason: 'format' });
    const other = setup([loopTerm({ schedule: '0 3 * * *' })]);
    other.write(session('/w/proj'), capture);
    expect(await other.hub.loop('t1', 'w2')).toEqual({ ok: false, reason: 'missing' });
    const bad = setup([loopTerm({ sessionCwd: 'relative' })]);
    expect(await bad.hub.loop('t1', 'w2')).toEqual({ ok: false, reason: 'outside' });
  });
  test('a symlink out of the projects root is outside, never read', async () => {
    const { hub, write, fs } = setup([loopTerm()]);
    write(session('/w/proj'), capture);
    const read = vi.spyOn(fs, 'read');
    const real = fs.realpath;
    fs.realpath = async (p) => (p === session('/w/proj') ? '/etc/elsewhere.jsonl' : real(p));
    expect(await hub.loop('t1', 'w2')).toEqual({ ok: false, reason: 'outside' });
    expect(read).not.toHaveBeenCalled();
  });
  test('reads the tail only, once more up to TRANSCRIPT_BYTES when it holds no wake-up', async () => {
    const { hub, write, fs } = setup([loopTerm()]);
    const filler = `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000) }] } })}\n`;
    write(session('/w/proj'), capture + filler.repeat(600));
    const read = vi.spyOn(fs, 'read');
    expect(await hub.loop('t1', 'w2')).toMatchObject({ ok: true, detail: { checks: 2 } });
    const sizes = read.mock.calls.map((c) => c[2]);
    expect(sizes[0]).toBe(LOOP_TAIL_BYTES);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(TRANSCRIPT_BYTES);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
