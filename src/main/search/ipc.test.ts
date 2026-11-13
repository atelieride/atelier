import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (e: unknown, ...args: unknown[]) => unknown>());
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn) } }));

import { IPC } from '@shared/api';
import type { SearchEvent, SearchRequest } from '@shared/search';
import { git } from '../../../tests/support/git-fixture';
import { posixTest, useMachinePlatform } from '../../../tests/support/platform';
import { installSearchIpc, type SearchProject, type WindowServiceDeps } from './ipc';
import type { SearchListing } from './service';

useMachinePlatform();

const APP = 'app://atelier/index.html';

/** A window's page as main sees it: what it was sent, whether it is gone, its `destroyed` listeners. */
class FakeContents {
  readonly events: SearchEvent[] = [];
  /** Sends that reached a destroyed page (Electron throws on those). */
  lateSends = 0;
  private destroyed = false;
  private readonly gone: (() => void)[] = [];
  private readonly navigations: ((d: { isMainFrame: boolean; isSameDocument: boolean }) => void)[] = [];
  constructor(readonly id: number) {}
  on(ev: string, cb: (d: { isMainFrame: boolean; isSameDocument: boolean }) => void): void {
    if (ev === 'did-start-navigation') this.navigations.push(cb);
  }
  /** A navigation starts in the page: a reload is its main frame, a new document. */
  navigate(d: { isMainFrame: boolean; isSameDocument: boolean }): void {
    for (const cb of this.navigations) cb(d);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(channel: string, e: SearchEvent): void {
    if (this.destroyed) { this.lateSends++; throw new Error('Object has been destroyed'); }
    if (channel === IPC.evSearch) this.events.push(e);
  }
  once(ev: string, cb: () => void): void {
    if (ev === 'destroyed') this.gone.push(cb);
  }
  /** The window closes: Electron marks the contents destroyed, then emits `destroyed`. */
  destroy(fire = true): void {
    this.destroyed = true;
    if (fire) for (const cb of this.gone.splice(0)) cb();
  }
}

/** A search service that records what it is asked and emits what the test says. */
class FakeService {
  readonly starts: { req: SearchRequest; emit: (e: SearchEvent) => void }[] = [];
  readonly stops: number[] = [];
  disposed = false;
  constructor(readonly deps: WindowServiceDeps) {}
  start(req: SearchRequest, emit: (e: SearchEvent) => void): void {
    this.starts.push({ req, emit });
  }
  stop(searchId: number): void {
    this.stops.push(searchId);
  }
  dispose(): void {
    this.disposed = true;
  }
  /** An event of the search it was last asked for. */
  emit(e: SearchEvent): void {
    this.starts.at(-1)!.emit(e);
  }
}

function req(searchId: number, over: Partial<SearchRequest> = {}): SearchRequest {
  return { searchId, query: 'token', matchCase: false, wholeWord: false, regex: false, include: '', exclude: '', includeIgnored: false, unsaved: [], ...over };
}

const batch = (searchId: number): SearchEvent => ({ kind: 'batch', searchId, files: [], searched: 1, total: 2 });
const done = (searchId: number): SearchEvent => ({ kind: 'done', searchId, searched: 2, total: 2, skipped: [], limitHit: false, fileCap: null, stopped: false });

function setup() {
  handlers.clear();
  const projects = new Map<number, SearchProject | null>();
  const services: FakeService[] = [];
  const ipc = installSearchIpc({
    projectOf: (e) => projects.get(e.sender.id) ?? null,
    isTrusted: (e) => e.senderFrame?.url === APP,
    workerPath: '/nowhere/search-worker.js',
    createService: (deps) => { const s = new FakeService(deps); services.push(s); return s; }
  });
  const ev = (wc: FakeContents, url = APP) => ({ sender: wc, senderFrame: { url } });
  const start = (wc: FakeContents, r: unknown, url?: string) => handlers.get(IPC.searchStart)!(ev(wc, url), r);
  const stop = (wc: FakeContents, id: unknown, url?: string) => handlers.get(IPC.searchStop)!(ev(wc, url), id);
  /** A window of `root` (null: the welcome window). */
  const win = (id: number, root: string | null): FakeContents => {
    projects.set(id, root === null ? null : { root, discovered: [root] });
    return new FakeContents(id);
  };
  return { ipc, projects, services, start, stop, win };
}

describe('Find in Files IPC', () => {
  beforeEach(() => handlers.clear());

  test('only a trusted app page of a project: anything else throws and starts nothing', () => {
    const { services, start, stop, win } = setup();
    const a = win(1, '/p/a');
    const welcome = win(2, null);
    expect(() => start(a, req(1), 'https://evil.example/')).toThrow('unauthorized sender');
    expect(() => stop(a, 1, 'https://evil.example/')).toThrow('unauthorized sender');
    expect(() => start(welcome, req(1))).toThrow('unauthorized sender');
    expect(() => stop(welcome, 1)).toThrow('unauthorized sender');
    expect(services).toEqual([]);
  });

  test('input is parsed strictly before anything starts', () => {
    const { services, start, stop, win } = setup();
    const a = win(1, '/p/a');
    expect(() => start(a, { ...req(1), root: '/elsewhere' })).toThrow();
    expect(() => start(a, req(1, { query: 'q'.repeat(1_001) }))).toThrow();
    expect(() => start(a, req(-1))).toThrow();
    expect(() => stop(a, 1.5)).toThrow();
    expect(services).toEqual([]);
  });

  test('a service may list as soon as it is made: the window and its project are there already', async () => {
    handlers.clear();
    const listed: Promise<SearchListing>[] = [];
    installSearchIpc({
      projectOf: () => ({ root: '/nowhere/p', discovered: [] }),
      isTrusted: () => true,
      workerPath: '/nowhere/search-worker.js',
      createService: (deps) => { listed.push(deps.list(req(0))); return new FakeService(deps); }
    });
    expect(() => handlers.get(IPC.searchStart)!({ sender: new FakeContents(1), senderFrame: { url: APP } }, req(1))).not.toThrow();
    // A folder that does not exist: the listing fails, as the service expects it may.
    await expect(listed[0]).rejects.toThrow();
  });

  test('ATELIER_TEST_SEARCH_MAX_BYTES (tests only) lowers the size past which a file is listed as not searched', () => {
    const had = process.env.ATELIER_TEST_SEARCH_MAX_BYTES;
    try {
      delete process.env.ATELIER_TEST_SEARCH_MAX_BYTES;
      const plain = setup();
      plain.start(plain.win(1, '/p/a'), req(1));
      expect(plain.services[0]!.deps.limits).toBeUndefined();
      process.env.ATELIER_TEST_SEARCH_MAX_BYTES = '1024';
      const lowered = setup();
      lowered.start(lowered.win(1, '/p/a'), req(1));
      expect(lowered.services[0]!.deps.limits).toEqual({ maxBytes: 1024 });
      // Anything but a positive number: the app's own limit.
      process.env.ATELIER_TEST_SEARCH_MAX_BYTES = 'big';
      const junk = setup();
      junk.start(junk.win(1, '/p/a'), req(1));
      expect(junk.services[0]!.deps.limits).toBeUndefined();
    } finally {
      if (had === undefined) delete process.env.ATELIER_TEST_SEARCH_MAX_BYTES; else process.env.ATELIER_TEST_SEARCH_MAX_BYTES = had;
    }
  });

  test('one service per window, its events to that window only; stop reaches the same service', () => {
    const { services, start, stop, win } = setup();
    const a = win(1, '/p/a');
    const b = win(2, '/p/a');
    start(a, req(1));
    start(b, req(1));
    start(a, req(2, { query: 'tokens' }));
    expect(services).toHaveLength(2);
    const [sa, sb] = services as [FakeService, FakeService];
    expect(sa.starts.map((s) => s.req)).toEqual([req(1), req(2, { query: 'tokens' })]);
    sa.emit(batch(2));
    sb.emit(done(1));
    expect(a.events).toEqual([batch(2)]);
    expect(b.events).toEqual([done(1)]);
    stop(a, 2);
    expect(sa.stops).toEqual([2]);
    expect(sb.stops).toEqual([]);
  });

  test('files changed: the last search of each window on that root is told once, other projects nothing', () => {
    const { ipc, services, start, win } = setup();
    const a = win(1, '/p/a');
    const b = win(2, '/p/a');
    const other = win(3, '/p/b');
    // A window of the project that never searched.
    const never = win(4, '/p/a');
    start(a, req(3));
    start(b, req(5));
    start(other, req(1));
    // a's search has finished; b's still runs.
    services[0]!.emit(done(3));
    ipc.filesChanged('/p/a');
    ipc.filesChanged('/p/a');
    expect(a.events).toEqual([done(3), { kind: 'stale', searchId: 3 }]);
    expect(b.events).toEqual([{ kind: 'stale', searchId: 5 }]);
    expect(other.events).toEqual([]);
    expect(never.events).toEqual([]);
    // A new search is told again, once.
    start(a, req(4));
    ipc.filesChanged('/p/a');
    ipc.filesChanged('/p/a');
    expect(a.events).toEqual([done(3), { kind: 'stale', searchId: 3 }, { kind: 'stale', searchId: 4 }]);
    expect(b.events).toEqual([{ kind: 'stale', searchId: 5 }]);
  });

  test('changes noticed before a search started are not news to it, even when the watcher passes them on after; one since is', () => {
    const { ipc, start, win } = setup();
    const a = win(1, '/p/a');
    start(a, req(1));
    // The watcher waits for a quiet moment before it passes changes on: these came a second before the search.
    ipc.filesChanged('/p/a', false, Date.now() - 1_000);
    expect(a.events).toEqual([]);
    ipc.filesChanged('/p/a', false, Date.now());
    expect(a.events).toEqual([{ kind: 'stale', searchId: 1 }]);
  });

  test('a change only to files the search leaves out (ignored ones) tells only searches that include them', () => {
    const { ipc, start, win } = setup();
    const a = win(1, '/p/a');
    const b = win(2, '/p/a');
    start(a, req(1));
    start(b, req(1, { includeIgnored: true }));
    ipc.filesChanged('/p/a', true);
    expect(a.events).toEqual([]);
    expect(b.events).toEqual([{ kind: 'stale', searchId: 1 }]);
    ipc.filesChanged('/p/a');
    expect(a.events).toEqual([{ kind: 'stale', searchId: 1 }]);
    expect(b.events).toEqual([{ kind: 'stale', searchId: 1 }]);
  });

  test('a window that goes: its service is disposed, and nothing is ever sent to it again', () => {
    const { ipc, services, start, win } = setup();
    const a = win(1, '/p/a');
    start(a, req(1));
    const s = services[0]!;
    a.destroy();
    expect(s.disposed).toBe(true);
    s.emit(done(1));
    ipc.filesChanged('/p/a');
    expect(a.lateSends).toBe(0);
    expect(a.events).toEqual([]);
  });

  test('a window already destroyed, its event not fired yet: no send, no new search', () => {
    const { ipc, services, start, win } = setup();
    const a = win(1, '/p/a');
    start(a, req(1));
    a.destroy(false);
    services[0]!.emit(batch(1));
    ipc.filesChanged('/p/a');
    start(a, req(2));
    expect(services[0]!.starts).toHaveLength(1);
    expect(a.lateSends).toBe(0);
  });

  test('the page loads anew (a reload): its search stops and nothing of it reaches the new page; in-page navigations change nothing', () => {
    const { ipc, services, start, win } = setup();
    const a = win(1, '/p/a');
    start(a, req(1));
    const s = services[0]!;
    // An iframe loading, or a same-document navigation: the page is the same one.
    a.navigate({ isMainFrame: false, isSameDocument: false });
    a.navigate({ isMainFrame: true, isSameDocument: true });
    expect(s.disposed).toBe(false);
    a.navigate({ isMainFrame: true, isSameDocument: false });
    expect(s.disposed).toBe(true);
    // The old run's late events and the old search's stale notice never reach the new page (its ids start over).
    s.emit(batch(1));
    ipc.filesChanged('/p/a');
    expect(a.events).toEqual([]);
    // The new page's first search gets a fresh service, and is told about changes after it.
    start(a, req(1));
    expect(services).toHaveLength(2);
    services[1]!.emit(done(1));
    ipc.filesChanged('/p/a');
    expect(a.events).toEqual([done(1), { kind: 'stale', searchId: 1 }]);
    // A later reload stops the new page's search as well.
    a.navigate({ isMainFrame: true, isSameDocument: false });
    expect(services[1]!.disposed).toBe(true);
  });

  test("the window's project changes: the old service is disposed, the new project's search gets a fresh one", () => {
    const { ipc, projects, services, start, stop, win } = setup();
    const a = win(1, '/p/a');
    start(a, req(1));
    projects.set(1, { root: '/p/b', discovered: ['/p/b'] });
    start(a, req(2));
    expect(services).toHaveLength(2);
    expect(services[0]!.disposed).toBe(true);
    expect(services[1]!.starts.map((x) => x.req.searchId)).toEqual([2]);
    // The old project's changes no longer concern it; the new one's do.
    ipc.filesChanged('/p/a');
    expect(a.events).toEqual([]);
    ipc.filesChanged('/p/b');
    expect(a.events).toEqual([{ kind: 'stale', searchId: 2 }]);
    // A stop after another change of project disposes too (the search it names was the old project's).
    projects.set(1, { root: '/p/c', discovered: ['/p/c'] });
    stop(a, 2);
    expect(services[1]!.disposed).toBe(true);
    expect(services[1]!.stops).toEqual([]);
  });

  // POSIX: POSIX path fixtures.
  posixTest("the listing: the window's project through its repositories, filtered, sorted, the real root; shared while it runs", async () => {
    const { ipc, projects, services, start, win } = setup();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-search-ipc-')));
    git(root, 'init', '-q');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
    for (const rel of ['b.ts', 'a.ts', 'notes.md', 'sub/c.ts', 'ignored.ts']) writeFileSync(join(root, rel), 'token\n');
    const a = win(1, root);
    // Listed through the discovered repository: what git ignores stays out (a plain walk would list ignored.ts).
    projects.set(1, { root, discovered: [root] });
    start(a, req(1));
    const { list } = services[0]!.deps;
    const r = req(1, { include: '*.ts' });
    const first = list(r);
    // Typing: the next search with the same filters takes the listing still running.
    expect(list(req(2, { query: 'other', include: '*.ts' }))).toBe(first);
    expect(list(req(3, { include: '*.md' }))).not.toBe(first);
    const listing: SearchListing = await first;
    expect(listing.files.map((f) => f.rel)).toEqual(['a.ts', 'b.ts', 'sub/c.ts']);
    expect(listing.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'sub/c.ts'].map((rel) => join(root, rel)));
    expect(listing.capped).toBe(false);
    expect(listing.realRoot).toBe(root);
    // Finished: the next search lists again.
    const again = list(r);
    expect(again).not.toBe(first);
    // A change on disk while a listing runs: the next search does not take it.
    ipc.filesChanged(root);
    expect(list(r)).not.toBe(again);
    await again;
  });
});
