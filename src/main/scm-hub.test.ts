import { expect, test } from 'vitest';
import { CallQueue, checkRoot, knownRevs } from './scm-hub';
import type { ScmRefs, ScmRepoEntry } from '@shared/scm';

const refs = (names: string[], head: string | null = 'a'.repeat(40)): ScmRefs => ({ root: '/p', head: { branch: 'main', oid: head, detached: false }, refs: names.map((name) => ({ name, short: name, kind: 'head', oid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0, gone: false, current: false, date: 0 })), defaultBranch: null, shallow: false, fetchedAt: null, remotes: [], hasRemote: false, emptyTree: '' });

test('checkRoot: only an entry main listed for the project', () => {
  const entries = [{ root: '/p' }, { root: '/p/apps/web' }];
  expect(checkRoot(entries, '/p/apps/web')).toBe(true);
  expect(checkRoot(entries, '/p/apps')).toBe(false);
  expect(checkRoot(entries, '/etc')).toBe(false);
});

test('knownRevs: listed refnames, HEAD with commits, full oids', () => {
  const r = refs(['refs/heads/main']);
  expect(knownRevs(r, ['refs/heads/main', 'HEAD', 'b'.repeat(40)])).toBe(true);
  expect(knownRevs(r, ['refs/heads/other'])).toBe(false);
  expect(knownRevs(refs([], null), ['HEAD'])).toBe(false);
});

test('CallQueue: two at a time, the rest wait; a newer call for the same view aborts the older', async () => {
  const q = new CallQueue(2);
  const started: string[] = [];
  const gates: Record<string, () => void> = {};
  const job = (id: string) => (signal: AbortSignal) => new Promise<string>((res, rej) => {
    started.push(id);
    gates[id] = () => res(id);
    signal.addEventListener('abort', () => rej(new Error('aborted')));
  });
  const a = q.run('a', job('a'));
  const b = q.run('b', job('b'));
  const c = q.run('c', job('c'));
  await Promise.resolve();
  expect(started).toEqual(['a', 'b']);
  gates.a!();
  expect(await a).toBe('a');
  await new Promise((r) => setTimeout(r, 0));
  expect(started).toEqual(['a', 'b', 'c']);
  const b2 = q.run('b', job('b2'));
  await expect(b).rejects.toThrow(/aborted/);
  gates.c!();
  await c;
  await new Promise((r) => setTimeout(r, 0));
  expect(started).toContain('b2');
  gates.b2!();
  expect(await b2).toBe('b2');
});

test('CallQueue: a call waiting in the queue that is superseded never starts', async () => {
  const q = new CallQueue(1);
  const started: string[] = [];
  const gates: Record<string, () => void> = {};
  const job = (id: string) => (signal: AbortSignal) => new Promise<string>((res, rej) => { started.push(id); gates[id] = () => res(id); signal.addEventListener('abort', () => rej(new Error('aborted'))); });
  const x = q.run('x', job('x'));
  const y1 = q.run('y', job('y1'));
  const y2 = q.run('y', job('y2'));
  await expect(y1).rejects.toThrow(/aborted/);
  gates.x!();
  await x;
  await new Promise((r) => setTimeout(r, 0));
  expect(started).toEqual(['x', 'y2']);
  gates.y2!();
  expect(await y2).toBe('y2');
});

import { vi } from 'vitest';
import { ScmHub } from './scm-hub';
import * as scmRepos from './git/scm-repos';
import { join as nativeJoin } from 'node:path';
import { WriteQueue } from './git/write-queue';

/** The working trees GitHub listed (what the hub reads through git.info), given as the entries they make. */
let listedTrees: { root: string; common: string; gitDir: null; worktreeOf: string | null; hidden: boolean }[] | undefined;
function listed(entries: ScmRepoEntry[]) {
  listedTrees = entries.map((e) => ({ root: e.root, common: e.common, gitDir: null, worktreeOf: e.worktreeOf, hidden: !!e.worktreeOf }));
  return { mockRestore: () => { listedTrees = undefined; } };
}

test('ScmHub does no git work for a project whose windows never used Source Control, and lets it go when it closes', async () => {
  vi.useFakeTimers();
  const list = vi.spyOn(scmRepos, 'listScmRepos');
  const sent: unknown[] = [];
  const wc = { isDestroyed: () => false, send: (...a: unknown[]) => sent.push(a) };
  const git = { onScm: (_k: string, _e: unknown, _w?: boolean) => {}, onProjectClosed: (_k: string) => {}, info: () => ({ root: '/p', repos: ['/p'], discovered: ['/p'], status: new Map(), windows: new Set([wc]), ...(listedTrees ? { trees: listedTrees } : {}) }) };
  const hub = new ScmHub(git as never);
  git.onScm('/p', { common: '/p/.git', what: 'head' }, false);
  git.onScm('/p', { common: '/p/.git', what: 'refs' }, false);
  await vi.advanceTimersByTimeAsync(400);
  expect(list).not.toHaveBeenCalled();
  // The event still reaches the windows (a History tab may follow it).
  expect(sent).toHaveLength(2);
  git.onProjectClosed('/p');
  expect((hub as unknown as { projects: Map<string, unknown> }).projects.size).toBe(0);
  list.mockRestore();
  vi.useRealTimers();
});

import * as history from './git/history';

test('before GitHub\'s first listing, the entries are the repositories found so far, read without git and never kept', async () => {
  const list = vi.spyOn(scmRepos, 'listScmRepos');
  const info = { root: '/p', repos: [] as string[], discovered: [] as string[], status: new Map(), windows: new Set(), capped: false, searching: true, maxFolders: 20_000 };
  const git = { onScm: () => {}, onProjectClosed: () => {}, info: () => info };
  const hub = new ScmHub(git as never);
  const handlers = new Map<string, (e: unknown, a: unknown) => Promise<unknown>>();
  hub.installIpc(() => '/p', () => true, (ch, fn) => { handlers.set(ch, fn as never); });
  const e = { sender: { id: 1, once: () => {} } };
  // Asked while the scan runs: nothing yet, and nothing kept for later.
  expect(await handlers.get('scm:repos')!(e, undefined)).toEqual([]);
  info.discovered = ['/p/api', '/p/web'];
  const entries = await handlers.get('scm:repos')!(e, undefined) as { root: string; common: string }[];
  // The tests run as macOS: on a Windows host the common dir is node:path's win32 join, hence the native separator.
  expect(entries.map((x) => [x.root, x.common])).toEqual([['/p/api', nativeJoin('/p/api', '.git')], ['/p/web', nativeJoin('/p/web', '.git')]]);
  expect(list).not.toHaveBeenCalled();
  list.mockRestore();
});

test('scm:search answers how the project\'s folder scan went', async () => {
  const info = { root: '/p', repos: [], discovered: [], status: new Map(), windows: new Set(), capped: true, searching: false, maxFolders: 20_000 };
  const git = { onScm: () => {}, onProjectClosed: () => {}, info: () => info };
  const hub = new ScmHub(git as never);
  const handlers = new Map<string, (e: unknown, a: unknown) => Promise<unknown>>();
  hub.installIpc(() => '/p', () => true, (ch, fn) => { handlers.set(ch, fn as never); });
  const e = { sender: { id: 1, once: () => {} } };
  expect(await handlers.get('scm:search')!(e, undefined)).toEqual({ capped: true, searching: false, maxFolders: 20_000 });
  info.capped = false;
  info.searching = true;
  expect(await handlers.get('scm:search')!(e, undefined)).toEqual({ capped: false, searching: true, maxFolders: 20_000 });
});

test('every git call of the scm IPC goes through the window\'s queue: at most two at a time', async () => {
  const list = listed([{ root: '/p', rel: '', name: 'p', worktreeOf: null, nestedIn: null, common: '/p/.git', status: null }]);
  let running = 0; let peak = 0;
  const gates: (() => void)[] = [];
  const slow = <T,>(v: T) => async () => { running++; peak = Math.max(peak, running); await new Promise<void>((r) => gates.push(r)); running--; return v; };
  const spies = [
    vi.spyOn(history, 'readBlob').mockImplementation(slow({ kind: 'missing' } as const)),
    vi.spyOn(history, 'readStashes').mockImplementation(slow([])),
    vi.spyOn(history, 'readWorktrees').mockImplementation(slow([])),
    vi.spyOn(history, 'resolveCommit').mockImplementation(slow(null))
  ];
  const git = { onScm: () => {}, onProjectClosed: () => {}, info: () => ({ root: '/p', repos: ['/p'], discovered: ['/p'], status: new Map(), windows: new Set() }) };
  const hub = new ScmHub(git as never);
  const handlers = new Map<string, (e: unknown, a: unknown) => Promise<unknown>>();
  hub.installIpc(() => '/p', () => true, (ch, fn) => { handlers.set(ch, fn as never); });
  const e = { sender: { id: 1, once: () => {} } };
  const O = 'a'.repeat(40);
  const calls = [
    handlers.get('scm:file')!(e, { root: '/p', oid: O, rel: 'a.ts' }),
    handlers.get('scm:stashes')!(e, { root: '/p' }),
    handlers.get('scm:worktrees')!(e, { root: '/p' }),
    handlers.get('scm:resolve')!(e, { root: '/p', prefix: 'abcd' })
  ];
  for (let i = 0; i < 20 && gates.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
  expect(peak).toBe(2);
  while (gates.length || running) { gates.shift()?.(); await new Promise((r) => setTimeout(r, 5)); }
  await Promise.all(calls);
  expect(peak).toBe(2);
  for (const s of spies) s.mockRestore();
  list.mockRestore();
});

test('scm:fetch: only a listed root, by its common dir; fetch-all once per common dir; states and events', async () => {
  const list = listed([
    { root: '/p', rel: '', name: 'p', worktreeOf: null, nestedIn: null, common: '/p/.git', status: null },
    { root: '/p/.wt/x', rel: '.wt/x', name: 'x', worktreeOf: '/p', nestedIn: null, common: '/p/.git', status: null },
    { root: '/p/lib', rel: 'lib', name: 'lib', worktreeOf: null, nestedIn: null, common: '/p/lib/.git', status: null }
  ]);
  const sent: unknown[][] = [];
  const wc = { isDestroyed: () => false, send: (...a: unknown[]) => sent.push(a) };
  const git = { onScm: () => {}, onProjectClosed: () => {}, info: () => ({ root: '/p', repos: ['/p'], discovered: ['/p'], status: new Map(), windows: new Set([wc]), ...(listedTrees ? { trees: listedTrees } : {}) }) };
  const ran: string[] = [];
  const hub = new ScmHub(git as never, { setting: () => 'off', online: () => true, projects: () => ['/p'], run: async (root) => { ran.push(root); return { outcome: 'ok' }; }, hasRemote: async () => true });
  const handlers = new Map<string, (e: unknown, a?: unknown) => Promise<unknown>>();
  hub.installIpc(() => '/p', () => true, (ch, fn) => { handlers.set(ch, fn as never); });
  const e = { sender: { id: 1, once: () => {} } };
  await expect(handlers.get('scm:fetch')!(e, { root: '/elsewhere', reason: 'manual' })).rejects.toThrow(/unknown repository/);
  await expect(handlers.get('scm:fetch')!(e, { root: '/p', reason: 'manual', extra: 1 })).rejects.toThrow();
  const a = await handlers.get('scm:fetch')!(e, { root: '/p/.wt/x', reason: 'manual' }) as { outcome: string; state: { common: string } };
  expect(a).toMatchObject({ outcome: 'ok', state: { common: '/p/.git', running: false, last: { outcome: 'ok' } } });
  expect(ran).toEqual(['/p/.wt/x']);
  // "When viewing" off: a view request runs nothing.
  expect(await handlers.get('scm:fetch')!(e, { root: '/p/lib', reason: 'view' })).toMatchObject({ outcome: null });
  ran.length = 0;
  expect(await handlers.get('scm:fetch-all')!(e)).toEqual(['ok', 'ok']);
  expect(ran.sort()).toEqual(['/p', '/p/lib']);
  const states = await handlers.get('scm:fetch-states')!(e) as { common: string }[];
  expect(states.map((s) => s.common).sort()).toEqual(['/p/.git', '/p/lib/.git']);
  expect(sent.filter((x) => x[0] === 'ev:scm-fetch').length).toBeGreaterThan(0);
  hub.dispose();
  list.mockRestore();
});

// A fetch moves remote-tracking refs: the Sync button's ↓N must show without waiting for the watcher's spacing.
test('a fetch that went through asks for a fresh status of every working tree of its common dir; a failed one asks nothing', async () => {
  const list = listed([
    { root: '/p', rel: '', name: 'p', worktreeOf: null, nestedIn: null, common: '/p/.git', status: null },
    { root: '/p/.wt/x', rel: '.wt/x', name: 'x', worktreeOf: '/p', nestedIn: null, common: '/p/.git', status: null },
    { root: '/p/lib', rel: 'lib', name: 'lib', worktreeOf: null, nestedIn: null, common: '/p/lib/.git', status: null }
  ]);
  const asked: string[] = [];
  const wc = { isDestroyed: () => false, send: () => {} };
  const git = { onScm: () => {}, onProjectClosed: () => {}, requestStatus: (root: string) => { asked.push(root); }, info: () => ({ root: '/p', repos: ['/p'], discovered: ['/p'], status: new Map(), windows: new Set([wc]), ...(listedTrees ? { trees: listedTrees } : {}) }) };
  let outcome: 'ok' | 'network' = 'ok';
  const hub = new ScmHub(git as never, { setting: () => 'off', online: () => true, projects: () => ['/p'], run: async () => ({ outcome }), hasRemote: async () => true });
  const handlers = new Map<string, (e: unknown, a?: unknown) => Promise<unknown>>();
  hub.installIpc(() => '/p', () => true, (ch, fn) => { handlers.set(ch, fn as never); });
  const e = { sender: { id: 1, once: () => {} } };
  await handlers.get('scm:fetch')!(e, { root: '/p/.wt/x', reason: 'manual' });
  await vi.waitFor(() => expect(asked.sort()).toEqual(['/p', '/p/.wt/x']));
  asked.length = 0;
  outcome = 'network';
  await handlers.get('scm:fetch')!(e, { root: '/p/lib', reason: 'manual' });
  await new Promise((r) => setTimeout(r, 0));
  expect(asked).toEqual([]);
  hub.dispose();

  // Asking for the statuses can't turn a fetch that went through into a failed one.
  const broken = new ScmHub(git as never, { setting: () => 'off', online: () => true, projects: () => { throw new Error('closing'); }, run: async () => ({ outcome: 'ok' }), hasRemote: async () => true });
  const h2 = new Map<string, (e: unknown, a?: unknown) => Promise<unknown>>();
  broken.installIpc(() => '/p', () => true, (ch, fn) => { h2.set(ch, fn as never); });
  expect(await h2.get('scm:fetch')!(e, { root: '/p', reason: 'manual' })).toMatchObject({ outcome: 'ok' });
  broken.dispose();
  list.mockRestore();
});

/**
 * The write queue, bounded: a scheduler that retook its slot in a loop without waiting for the writes would spin on
 * microtasks (no timer fires, the test would hang); past 1000 checks it fails instead.
 */
function boundedQueue(): WriteQueue {
  let checks = 0;
  return new (class extends WriteQueue {
    override busy(common: string): boolean {
      if (++checks > 1000) throw new Error('fetch scheduler spins on a busy common dir');
      return super.busy(common);
    }
  })();
}

test('fetches waiting behind writes hold no fetch slot: with writes on two common dirs, a third repo fetches at once', async () => {
  const list = listed([
    { root: '/p', rel: '', name: 'p', worktreeOf: null, nestedIn: null, common: '/p/.git', status: null },
    { root: '/p/lib', rel: 'lib', name: 'lib', worktreeOf: null, nestedIn: null, common: '/p/lib/.git', status: null },
    { root: '/p/docs', rel: 'docs', name: 'docs', worktreeOf: null, nestedIn: null, common: '/p/docs/.git', status: null }
  ]);
  const wc = { isDestroyed: () => false, send: () => {} };
  const git = { onScm: () => {}, onProjectClosed: () => {}, info: () => ({ root: '/p', repos: ['/p'], discovered: ['/p'], status: new Map(), windows: new Set([wc]), ...(listedTrees ? { trees: listedTrees } : {}) }) };
  const ran: string[] = [];
  const hub = new ScmHub(git as never, { setting: () => 'off', online: () => true, projects: () => ['/p'], run: async (root) => { ran.push(root); return { outcome: 'ok' }; }, hasRemote: async () => true }, boundedQueue());
  const handlers = new Map<string, (e: unknown, a?: unknown) => Promise<unknown>>();
  hub.installIpc(() => '/p', () => true, (ch, fn) => { handlers.set(ch, fn as never); });
  const e = { sender: { id: 1, once: () => {} } };
  // Two commits with slow hooks, in two repositories.
  const ends: (() => void)[] = [];
  const writes = ['/p/.git', '/p/lib/.git'].map((c) => hub.writes.run(c, () => new Promise<void>((r) => { ends.push(r); })));
  const fetchP = handlers.get('scm:fetch')!(e, { root: '/p', reason: 'manual' });
  const fetchLib = handlers.get('scm:fetch')!(e, { root: '/p/lib', reason: 'manual' });
  await new Promise((r) => setTimeout(r, 10));
  const fetchDocs = handlers.get('scm:fetch')!(e, { root: '/p/docs', reason: 'manual' });
  await new Promise((r) => setTimeout(r, 10));
  expect(ran).toEqual(['/p/docs']);
  expect(await fetchDocs).toMatchObject({ outcome: 'ok' });
  for (const end of ends) end();
  await Promise.all(writes);
  expect([await fetchP, await fetchLib]).toMatchObject([{ outcome: 'ok' }, { outcome: 'ok' }]);
  expect(ran.sort()).toEqual(['/p', '/p/docs', '/p/lib']);
  hub.dispose();
  list.mockRestore();
});

test('a fetch waits behind a write on the same common dir, not behind one on another', async () => {
  const list = listed([
    { root: '/p', rel: '', name: 'p', worktreeOf: null, nestedIn: null, common: '/p/.git', status: null },
    { root: '/p/.wt/x', rel: '.wt/x', name: 'x', worktreeOf: '/p', nestedIn: null, common: '/p/.git', status: null },
    { root: '/p/lib', rel: 'lib', name: 'lib', worktreeOf: null, nestedIn: null, common: '/p/lib/.git', status: null }
  ]);
  const wc = { isDestroyed: () => false, send: () => {} };
  const git = { onScm: () => {}, onProjectClosed: () => {}, info: () => ({ root: '/p', repos: ['/p'], discovered: ['/p'], status: new Map(), windows: new Set([wc]), ...(listedTrees ? { trees: listedTrees } : {}) }) };
  const ran: string[] = [];
  const hub = new ScmHub(git as never, { setting: () => 'off', online: () => true, projects: () => ['/p'], run: async (root) => { ran.push(root); return { outcome: 'ok' }; }, hasRemote: async () => true }, boundedQueue());
  const handlers = new Map<string, (e: unknown, a?: unknown) => Promise<unknown>>();
  hub.installIpc(() => '/p', () => true, (ch, fn) => { handlers.set(ch, fn as never); });
  const e = { sender: { id: 1, once: () => {} } };
  let done!: () => void;
  // A commit in the main checkout: a fetch from its linked worktree shares the object store.
  const write = hub.writes.run('/p/.git', () => new Promise<void>((r) => { done = r; }));
  const fetchWt = handlers.get('scm:fetch')!(e, { root: '/p/.wt/x', reason: 'manual' });
  const fetchLib = handlers.get('scm:fetch')!(e, { root: '/p/lib', reason: 'manual' });
  await fetchLib;
  await new Promise((r) => setTimeout(r, 10));
  expect(ran).toEqual(['/p/lib']);
  done();
  await write;
  expect(await fetchWt).toMatchObject({ outcome: 'ok' });
  expect(ran).toEqual(['/p/lib', '/p/.wt/x']);
  hub.dispose();
  list.mockRestore();
});

test('refs read before an event never go back in the cache after it (they would be stale)', async () => {
  let release!: () => void;
  const reads = vi.spyOn(history, 'readRefs')
    .mockImplementationOnce(async () => { await new Promise<void>((r) => { release = r; }); return refs(['refs/heads/old']); })
    .mockImplementation(async () => refs(['refs/heads/new']));
  const git = { onScm: (_k: string, _e: unknown, _w?: boolean) => {}, onProjectClosed: () => {}, info: () => ({ root: '/p', repos: ['/p'], discovered: ['/p'], status: new Map(), windows: new Set() }) };
  const hub = new ScmHub(git as never);
  const first = hub.refs('/p', '/p');
  await Promise.resolve();
  git.onScm('/p', { common: '/p/.git', what: 'refs' }, false);
  release();
  expect((await first).refs[0]!.name).toBe('refs/heads/old');
  expect((await hub.refs('/p', '/p')).refs[0]!.name).toBe('refs/heads/new');
  hub.dispose();
  reads.mockRestore();
});

test('the switcher’s entries are the working trees Changes listed, every time (a worktree come or gone shows at once)', async () => {
  const list = vi.spyOn(scmRepos, 'listScmRepos');
  const tree = (root: string, o: Partial<{ worktreeOf: string; hidden: boolean }> = {}) => ({ root, common: '/elsewhere/.git', gitDir: null, worktreeOf: o.worktreeOf ?? null, hidden: o.hidden ?? false });
  let trees = [tree('/p')];
  const status = new Map([['/p', { root: '/p', name: 'p', branch: 'feat', detached: false, ahead: 1, behind: 0, upstream: 'origin/feat', changes: [], oid: 'a'.repeat(40), checkedAt: 0, truncated: 0 }]]);
  const git = { onScm: () => {}, onProjectClosed: () => {}, info: () => ({ root: '/p', repos: trees.map((t) => t.root), discovered: ['/p'], status, windows: new Set(), trees }) };
  const hub = new ScmHub(git as never);
  expect(await hub.entries('/p')).toEqual([{ root: '/p', rel: '', name: 'p', worktreeOf: null, nestedIn: null, common: '/elsewhere/.git', status: expect.objectContaining({ ahead: 1, upstream: 'origin/feat' }) }]);
  trees = [tree('/p'), tree('/p/.claude/worktrees/a', { worktreeOf: '/p', hidden: true })];
  // The tests run as macOS: on a Windows host that is node:path's win32 relative, hence the native separator.
  expect((await hub.entries('/p')).map((e) => [e.rel, e.worktreeOf])).toEqual([['', null], [nativeJoin('.claude', 'worktrees', 'a'), '/p']]);
  // Never listed again here: GitHub's listing is the one (kept through a git timeout).
  expect(list).not.toHaveBeenCalled();
  hub.dispose();
  list.mockRestore();
});
