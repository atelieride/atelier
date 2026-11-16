import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ArtifactHub, attachArtifacts, RETRY_MS } from './artifact-hub';
import type { HubFs } from './background-hub';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionState } from '@shared/session';
import type { ToolCallWindow } from '@shared/tool-calls';
import { encodeProjectPath } from '@shared/history';

const SID = '89fcf8ea-a6ad-4f29-a390-922953c50a6c';
const SID2 = '11111111-2222-4333-8444-555555555555';
const UID = 501;
const roots = { tmp: `/tmp/claude-${UID}`, projects: '/fixture/claude-projects', configDir: '/home/.claude' };
const capture = readFileSync(resolve(__dirname, '../../tests/fixtures/transcripts/artifact-publish.jsonl'), 'utf8');
const FIRST = 'https://claude.ai/artifact/Kq3vT8xYzW2mNpR5sLd9Fa';
const SECOND = 'https://claude.ai/artifact/Rt6uY8iOp2aSd4fGh6jKl8';
const enc = (s: string) => new TextEncoder().encode(s);
const path = (cwd = '/w/proj', sid = SID, projects = roots.projects) => `${projects}/${encodeProjectPath(cwd)}/${sid}.jsonl`;

const call = (id: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-11-16T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Artifact', input }] } }) + '\n';
const result = (id: string, out: Record<string, unknown>, ts = '2026-11-16T10:00:01.000Z') =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'ok' }] }, toolUseResult: out }) + '\n';
const publish = (id: string, url: string, title: string, ts?: string) => call(id, { action: 'publish', title }) + result(id, { url, title }, ts);

/** In-memory files: path → bytes and inode; every read recorded. */
function memFs() {
  const files = new Map<string, { data: Uint8Array; ino: number }>();
  const reads: { path: string; start: number; length: number }[] = [];
  const owners = new Map<string, number>();
  const links = new Map<string, string>();
  let ino = 1;
  const fs: Pick<HubFs, 'realpath' | 'stat' | 'owner' | 'read'> = {
    owner: async (p) => owners.get(p) ?? UID,
    realpath: async (p) => links.get(p) ?? (files.has(p) || [...files.keys()].some((f) => f.startsWith(`${p}/`)) || p === roots.projects ? p : null),
    stat: async (p) => { const f = files.get(p); return f ? { size: f.data.length, ino: f.ino } : null; },
    read: async (p, start, length) => { reads.push({ path: p, start, length }); return files.get(p)!.data.slice(start, start + length); }
  };
  const write = (p: string, text: string | Uint8Array, replace = false) => {
    const f = files.get(p);
    const data = typeof text === 'string' ? enc(text) : text;
    if (!f || replace) { files.set(p, { data, ino: ino++ }); return; }
    const next = new Uint8Array(f.data.length + data.length);
    next.set(f.data); next.set(data, f.data.length);
    f.data = next;
  };
  const truncate = (p: string, text: string) => { files.get(p)!.data = enc(text); };
  return { fs, write, truncate, reads, owners, links };
}

const term = (o: { id?: string; sid?: string; state?: SessionState; cwd?: string; configDir?: string; session?: false } = {}): TerminalInfo => ({
  id: o.id ?? 't1', projectRoot: '/w/proj', cwd: o.cwd ?? '/w/proj', title: 't', name: null, color: '#fff', foreground: 'claude', createdAt: 0,
  ...(o.configDir ? { configDir: o.configDir } : {}),
  session: o.session === false ? null : { sessionId: o.sid ?? SID, state: o.state ?? 'running', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, cwd: o.cwd ?? '/w/proj' }
});
const window = (id: string, o: { end?: number | null; agent?: string; sid?: string; terminalId?: string } = {}): ToolCallWindow =>
  ({ id, terminalId: o.terminalId ?? 't1', sessionId: o.sid ?? SID, agent: o.agent ?? 'main', tool: 'Artifact', start: 1, end: o.end === undefined ? 2 : o.end });

const hubs: ArtifactHub[] = [];
function setup(extra: { firstScanBytes?: number; chunkBytes?: number } = {}) {
  const m = memFs();
  const log = vi.fn();
  const hub = new ArtifactHub({ fs: m.fs, roots: () => roots, uid: UID, log, ...extra });
  hubs.push(hub);
  const changes = vi.fn();
  hub.onChange = changes;
  return { hub, changes, log, ...m };
}
/** Lets the hub's queued reads finish. */
const settle = () => vi.advanceTimersByTimeAsync(1);
const titles = (hub: ArtifactHub, id = 't1', sid = SID) => hub.artifacts(id, sid)?.map((a) => a.title);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const h of hubs.splice(0)) h.dispose(); vi.useRealTimers(); });

describe('ArtifactHub', () => {
  test('a session seen for the first time: its transcript is read and its artifacts listed', async () => {
    const { hub, changes, write } = setup();
    write(path(), capture);
    hub.terminals([term()]);
    await settle();
    expect(hub.artifacts('t1', SID)).toEqual([
      { url: SECOND, title: 'Pari · giro UX 1', at: Date.parse('2026-11-16T19:20:03.000Z') },
      { url: FIRST, title: 'Concept board', at: Date.parse('2026-11-15T15:54:24.000Z') }
    ]);
    expect(changes).toHaveBeenCalledTimes(1);
    // Another session id is not this list.
    expect(hub.artifacts('t1', SID2)).toBeUndefined();
  });

  test('an Artifact call that ended: only the bytes written since are read, the new artifact listed', async () => {
    const { hub, write, reads } = setup();
    write(path(), publish('a1', FIRST, 'One'));
    hub.terminals([term()]);
    await settle();
    const size = reads.reduce((n, r) => Math.max(n, r.start + r.length), 0);
    write(path(), publish('a2', SECOND, 'Two', '2026-11-16T11:00:00.000Z'));
    hub.toolCalls([window('a2')]);
    await settle();
    expect(titles(hub)).toEqual(['Two', 'One']);
    expect(reads.at(-1)!.start).toBe(size);
    // The same window again (atelierd resends its list) reads nothing more.
    const n = reads.length;
    hub.toolCalls([window('a2')]);
    await settle();
    expect(reads).toHaveLength(n);
  });

  test('the hook came before the result line: read again shortly after, until it is there', async () => {
    const { hub, write, reads } = setup();
    write(path(), '');
    hub.terminals([term()]);
    await settle();
    write(path(), call('a1', { action: 'publish', title: 'Late' }));
    hub.toolCalls([window('a1')]);
    await settle();
    expect(hub.artifacts('t1', SID)).toBeUndefined();
    write(path(), result('a1', { url: FIRST, title: 'Late' }));
    await vi.advanceTimersByTimeAsync(RETRY_MS[0]!);
    expect(titles(hub)).toEqual(['Late']);
    const n = reads.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(reads).toHaveLength(n);
  });

  test('gives up after its retries when the result never comes', async () => {
    const { hub, write, reads } = setup();
    write(path(), call('a1', { action: 'publish', title: 'Never' }));
    hub.terminals([term()]);
    await settle();
    hub.toolCalls([window('a1')]);
    await vi.advanceTimersByTimeAsync(60_000);
    const n = reads.length;
    write(path(), 'x\n');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toHaveLength(n);
  });

  test('not followed: a call still running, another tool, a subagent\'s call (its own transcript)', async () => {
    const { hub, write, reads } = setup();
    write(path(), '');
    hub.terminals([term()]);
    await settle();
    write(path(), 'x\n');
    const n = reads.length;
    hub.toolCalls([window('a1', { end: null }), { ...window('a2'), tool: 'Bash' }, window('a3', { agent: 'agent:x1' }), window('a4', { terminalId: 't9' })]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toHaveLength(n);
  });

  test('a change of the session\'s state reads what was written since; the same state reads nothing', async () => {
    const { hub, write, reads } = setup();
    write(path(), '');
    hub.terminals([term({ state: 'running' })]);
    await settle();
    write(path(), publish('a1', FIRST, 'One'));
    const n = reads.length;
    hub.terminals([term({ state: 'running' })]);
    await settle();
    expect(reads).toHaveLength(n);
    hub.terminals([term({ state: 'done' })]);
    await settle();
    expect(titles(hub)).toEqual(['One']);
  });

  test('a new session in the terminal starts over; a terminal that left takes its list with it', async () => {
    const { hub, changes, write } = setup();
    write(path(), publish('a1', FIRST, 'One'));
    write(path('/w/proj', SID2), publish('b1', SECOND, 'Other'));
    hub.terminals([term()]);
    await settle();
    expect(titles(hub)).toEqual(['One']);
    hub.terminals([term({ sid: SID2 })]);
    await settle();
    expect(hub.artifacts('t1', SID)).toBeUndefined();
    expect(titles(hub, 't1', SID2)).toEqual(['Other']);
    changes.mockClear();
    hub.terminals([]);
    expect(hub.artifacts('t1', SID2)).toBeUndefined();
    expect(changes).toHaveBeenCalledTimes(1);
  });

  test('a session of another Claude account: read from that account\'s projects, only when its owner is the app\'s user', async () => {
    const other = '/home/.claude-work';
    const { hub, write, owners, reads } = setup();
    write(path('/w/proj', SID, `${other}/projects`), publish('a1', FIRST, 'Work'));
    hub.terminals([term({ configDir: other })]);
    await settle();
    expect(titles(hub)).toEqual(['Work']);

    const s2 = setup();
    s2.write(path('/w/proj', SID, `${other}/projects`), publish('a1', FIRST, 'Work'));
    s2.owners.set(`${other}/projects`, UID + 1);
    s2.hub.terminals([term({ configDir: other })]);
    await settle();
    expect(s2.hub.artifacts('t1', SID)).toBeUndefined();
    expect(s2.reads).toHaveLength(0);
    expect(reads.length).toBeGreaterThan(0);
  });

  test('a transcript that resolves outside the projects root is never read', async () => {
    const { hub, write, links, reads } = setup();
    write('/elsewhere/secret.jsonl', publish('a1', FIRST, 'One'));
    links.set(path(), '/elsewhere/secret.jsonl');
    hub.terminals([term()]);
    await settle();
    expect(reads).toHaveLength(0);
    expect(hub.artifacts('t1', SID)).toBeUndefined();
  });

  test('a transcript rewritten (shorter, or a new file) is read again from its start', async () => {
    const { hub, write, truncate, changes } = setup();
    write(path(), publish('a1', FIRST, 'One') + publish('a2', SECOND, 'Two', '2026-11-16T11:00:00.000Z'));
    hub.terminals([term({ state: 'running' })]);
    await settle();
    expect(titles(hub)).toEqual(['Two', 'One']);
    truncate(path(), publish('a3', FIRST, 'Again'));
    hub.terminals([term({ state: 'done' })]);
    await settle();
    expect(titles(hub)).toEqual(['Again']);
    changes.mockClear();
    write(path(), '', true);
    hub.terminals([term({ state: 'running' })]);
    await settle();
    expect(hub.artifacts('t1', SID)).toBeUndefined();
    expect(changes).toHaveBeenCalledTimes(1);
  });

  test('a long transcript: the first read covers only its last firstScanBytes, in chunks', async () => {
    const { hub, write, reads } = setup({ firstScanBytes: 600, chunkBytes: 256 });
    const filler = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(900) } })}\n`;
    const text = filler + publish('a1', FIRST, 'Kept');
    write(path(), text);
    hub.terminals([term()]);
    await settle();
    const size = enc(text).length;
    expect(reads[0]!.start).toBe(size - 600);
    expect(reads.every((r) => r.length <= 256)).toBe(true);
    expect(titles(hub)).toEqual(['Kept']);
  });

  test('a character cut between two reads keeps its title whole', async () => {
    // Reads of 2 bytes cut every 3-byte "—"; the others cut "·" and "è" somewhere too.
    for (const chunkBytes of [2, 3, 5, 7]) {
      const { hub, write } = setup({ chunkBytes });
      write(path(), publish('a1', FIRST, 'Pari · giro UX 1 — è'));
      hub.terminals([term()]);
      await settle();
      expect(titles(hub), `reads of ${chunkBytes} bytes`).toEqual(['Pari · giro UX 1 — è']);
    }
  });

  test('a session whose transcript doesn\'t exist yet: read once it does', async () => {
    const { hub, write } = setup();
    hub.terminals([term({ state: 'running' })]);
    await settle();
    expect(hub.artifacts('t1', SID)).toBeUndefined();
    write(path(), publish('a1', FIRST, 'One'));
    hub.terminals([term({ state: 'done' })]);
    await settle();
    expect(titles(hub)).toEqual(['One']);
  });
});

describe('attachArtifacts', () => {
  test('each terminal gets its session\'s artifacts, none when it has none', () => {
    const a = [{ url: FIRST, title: 'One', at: 1 }];
    const list = attachArtifacts([term({ id: 't1' }), term({ id: 't2' }), term({ id: 't3', session: false })], (id, sid) => (id === 't1' && sid === SID ? a : undefined));
    expect(list[0]!.artifacts).toEqual(a);
    expect('artifacts' in list[1]!).toBe(false);
    expect('artifacts' in list[2]!).toBe(false);
  });
});
