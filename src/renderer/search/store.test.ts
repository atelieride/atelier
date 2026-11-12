import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { SearchEvent, SearchFile, SearchLine, SearchRequest } from '@shared/search';

const dirty = vi.hoisted(() => ({ docs: new Map<string, string>() }));
vi.mock('../store', () => ({ useApp: { getState: () => ({ project: { root: '/p' } }) } }));
vi.mock('../editor/savers', () => ({
  dirtyPaths: () => [...dirty.docs.keys()],
  handoffOf: (p: string) => (dirty.docs.has(p) ? { state: { doc: dirty.docs.get(p) } } : undefined)
}));

import { useSearch } from './store';
import { fileKey } from './model';
import { loadRecent } from './recent';

const g = globalThis as { window?: unknown; localStorage?: unknown };
let had: unknown;
let hadStorage: unknown;
let started: SearchRequest[];
let stopped: number[];
let emit: (e: SearchEvent) => void;
let startImpl: (r: SearchRequest) => Promise<void>;

beforeAll(() => {
  had = g.window;
  hadStorage = g.localStorage;
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  g.window = {
    atelier: {
      search: {
        start: (r: SearchRequest) => { started.push(r); return startImpl(r); },
        stop: (id: number) => { stopped.push(id); return Promise.resolve(); },
        onEvent: (cb: (e: SearchEvent) => void) => { emit = cb; return () => {}; }
      }
    }
  };
});
afterAll(() => { g.window = had; g.localStorage = hadStorage; });

const st = () => useSearch.getState();
const ln = (line: number): SearchLine => ({ line, text: 'token', start: 0, ranges: [[0, 5]], cutStart: false, cutEnd: false });
const file = (rel: string, n = 1): SearchFile => ({ path: `/p/${rel}`, rel, size: 5, lines: Array.from({ length: n }, (_, i) => ln(i + 1)) });
const cur = () => st().searchId;
const done = (extra: Partial<Extract<SearchEvent, { kind: 'done' }>> = {}): SearchEvent => ({ kind: 'done', searchId: cur(), searched: 1, total: 1, skipped: [], limitHit: false, fileCap: null, stopped: false, ...extra });
const batch = (files: SearchFile[], id = cur()): SearchEvent => ({ kind: 'batch', searchId: id, files, searched: files.length, total: 10 });

beforeEach(() => {
  vi.useFakeTimers();
  started = [];
  stopped = [];
  dirty.docs.clear();
  startImpl = () => Promise.resolve();
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  useSearch.getState().clear();
  useSearch.getState().setQuery('');
  started = [];
  stopped = [];
  useSearch.setState({ include: '', exclude: '', includeIgnored: false, spec: { query: '', matchCase: false, wholeWord: false, regex: false } });
});
afterEach(() => { vi.useRealTimers(); });

test('typing runs the search 250 ms after the last key, Enter at once', () => {
  st().setQuery('t');
  st().setQuery('to');
  vi.advanceTimersByTime(249);
  expect(started).toHaveLength(0);
  vi.advanceTimersByTime(1);
  expect(started).toHaveLength(1);
  expect(started[0]).toMatchObject({ query: 'to', include: '', exclude: '', includeIgnored: false });
  expect(st().phase).toBe('running');
  st().setQuery('tok');
  st().run();
  expect(started).toHaveLength(2);
  vi.advanceTimersByTime(500);
  expect(started).toHaveLength(2);
});

test('an empty query clears the results and starts nothing', () => {
  st().setQuery('a');
  st().run();
  emit(batch([file('a.ts')]));
  st().setQuery('');
  vi.advanceTimersByTime(500);
  expect(started).toHaveLength(1);
  expect(st().files).toEqual([]);
  expect(st().phase).toBe('idle');
  expect(stopped).toEqual([started[0]!.searchId]);
});

test('a query that cannot match (an invalid regular expression, a line break) starts nothing and stops the search before it', () => {
  st().setQuery('token');
  st().run();
  emit(batch([file('a.ts')]));
  st().setSpec({ regex: true });
  expect(started).toHaveLength(2);
  st().setQuery('readSession(token');
  vi.advanceTimersByTime(500);
  st().run();
  expect(started).toHaveLength(2);
  expect(stopped).toContain(started[1]!.searchId);
  expect(st()).toMatchObject({ searchId: 0, phase: 'idle', files: [] });
  expect(st().spec.query).toBe('readSession(token');
  st().setSpec({ regex: false });
  expect(started).toHaveLength(3);
  st().setQuery('a\\nb');
  vi.advanceTimersByTime(500);
  expect(started).toHaveLength(3);
  expect(st().phase).toBe('idle');
});

test('a batch that collapses nothing keeps the collapsed set, and one with progress alone keeps the files too', () => {
  st().setQuery('token');
  st().run();
  const collapsed = st().collapsed;
  emit(batch([file('a.ts', 3)]));
  expect(st().collapsed).toBe(collapsed);
  const files = st().files;
  emit(batch([]));
  expect(st().files).toBe(files);
  expect(st().collapsed).toBe(collapsed);
  // Past the threshold a new file arrives collapsed: a new set then.
  emit(batch([file('b.ts', 1000), file('c.ts', 1)]));
  expect(st().collapsed).not.toBe(collapsed);
  expect(st().collapsed.has(fileKey('/p/c.ts'))).toBe(true);
});

test('the id is recorded before start, so an error that beats the promise counts', () => {
  startImpl = (r) => { emit({ kind: 'error', searchId: r.searchId, message: 'boom', rel: 'x.ts' }); return Promise.resolve(); };
  st().setQuery('a');
  st().run();
  expect(st().phase).toBe('error');
  expect(st().error).toEqual({ message: 'boom', rel: 'x.ts' });
});

test('a start that rejects ends the search in error', async () => {
  startImpl = () => Promise.reject(new Error('nope'));
  st().setQuery('a');
  st().run();
  await vi.advanceTimersByTimeAsync(0);
  expect(st().phase).toBe('error');
  expect(st().error?.message).toBe('nope');
});

test('ids differ between runs and are not small counters', () => {
  st().setQuery('a'); st().run();
  st().run();
  expect(started[1]!.searchId).toBe(started[0]!.searchId + 1);
  expect(Number.isSafeInteger(started[0]!.searchId)).toBe(true);
});

test('events for an older id, or one this page never started, are ignored', () => {
  st().setQuery('a'); st().run();
  const first = cur();
  st().run();
  emit(batch([file('old.ts')], first));
  emit(done({ searchId: first }));
  emit({ kind: 'stale', searchId: first });
  emit(batch([file('foreign.ts')], 12345));
  emit({ kind: 'error', searchId: 12345, message: 'x', rel: null });
  expect(st().files).toEqual([]);
  expect(st().phase).toBe('running');
  expect(st().stale).toBe(false);
  expect(st().error).toBeNull();
});

test('batches append in order and progress-only batches change progress alone', () => {
  st().setQuery('a'); st().run();
  emit(batch([file('a.ts'), file('b.ts')]));
  expect(st().files.map((f) => f.rel)).toEqual(['a.ts', 'b.ts']);
  emit({ kind: 'batch', searchId: cur(), files: [], searched: 7, total: 10 });
  expect(st().progress).toEqual({ searched: 7, total: 10 });
  expect(st().files).toHaveLength(2);
});

test('done records the summary; stopped phase follows the event', () => {
  st().setQuery('a'); st().run();
  emit(done({ skipped: [{ path: '/p/z', rel: 'z', size: 9, reason: 'too-large' }], limitHit: true, fileCap: 100000, searched: 5, total: 5 }));
  expect(st().phase).toBe('done');
  expect(st().limitHit).toBe(true);
  expect(st().fileCap).toBe(100000);
  expect(st().skipped).toHaveLength(1);
  st().run();
  emit(done({ stopped: true }));
  expect(st().phase).toBe('stopped');
});

test('stale sets stale for the current search only, and a new run clears it with the dismissed rows', () => {
  st().setQuery('a'); st().run();
  emit(batch([file('a.ts')]));
  emit(done());
  emit({ kind: 'stale', searchId: cur() });
  expect(st().stale).toBe(true);
  st().dismiss(fileKey('/p/a.ts'));
  st().select('x');
  expect(st().dismissed.size).toBe(1);
  st().run();
  expect(st().stale).toBe(false);
  expect(st().dismissed.size).toBe(0);
  expect(st().selected).toBeNull();
  expect(st().files).toEqual([]);
});

test('stop keeps what was found and tells main', () => {
  st().setQuery('a'); st().run();
  const id = cur();
  emit(batch([file('a.ts')]));
  st().stop();
  expect(stopped).toEqual([id]);
  expect(st().phase).toBe('stopped');
  expect(st().files).toHaveLength(1);
});

test('clear resets results but keeps the query, and ignores what the cleared search still sends', () => {
  st().setQuery('keep'); st().run();
  const id = cur();
  emit(batch([file('a.ts')]));
  st().clear();
  expect(st().spec.query).toBe('keep');
  expect(st().files).toEqual([]);
  expect(st().phase).toBe('idle');
  expect(stopped).toContain(id);
  emit(batch([file('late.ts')], id));
  expect(st().files).toEqual([]);
});

test('the recent list gets the query on done with results only', () => {
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: () => {} };
  st().setQuery('none'); st().run();
  emit(done());
  expect(loadRecent('/p')).toEqual([]);
  st().setQuery('found'); st().run();
  emit(batch([file('a.ts')]));
  emit(done());
  expect(loadRecent('/p').map((s) => s.query)).toEqual(['found']);
  st().setQuery('stopped'); st().run();
  emit(batch([file('a.ts')]));
  emit(done({ stopped: true }));
  expect(loadRecent('/p').map((s) => s.query)).toEqual(['found']);
});

test('after 1,000 matches new files arrive collapsed', () => {
  st().setQuery('a'); st().run();
  emit(batch([file('a.ts', 1000)]));
  expect(st().collapsed.size).toBe(0);
  emit(batch([file('b.ts', 2)]));
  expect(st().collapsed.has(fileKey('/p/b.ts'))).toBe(true);
});

test('collapse, expand all, dismiss', () => {
  st().setQuery('a'); st().run();
  emit(batch([file('a.ts'), file('b.ts')]));
  st().toggleCollapsed(fileKey('/p/a.ts'));
  expect(st().collapsed.has(fileKey('/p/a.ts'))).toBe(true);
  st().setAllCollapsed(true);
  expect(st().collapsed.size).toBe(2);
  st().setAllCollapsed(false);
  expect(st().collapsed.size).toBe(0);
});

const placeholder = (rel: string): SearchFile => ({ path: `/p/${rel}`, rel, size: 0, lines: [], unsaved: true });

test('the dirty files inside the project go to main as unsaved paths; nothing else', () => {
  dirty.docs.set('/p/b.ts', 'token');
  dirty.docs.set('/p/sub/c.ts', 'x');
  dirty.docs.set('/other/x.ts', 'token');
  st().setQuery('token'); st().run();
  expect(started[0]!.unsaved.sort()).toEqual(['/p/b.ts', '/p/sub/c.ts']);
});

test('a placeholder takes its buffer\'s result in main\'s place; one with no match vanishes', () => {
  dirty.docs.set('/p/b.ts', 'one\nbuffer token\r\nthree');
  dirty.docs.set('/p/c.ts', 'nothing here');
  st().setQuery('token'); st().run();
  emit(batch([file('a.ts'), placeholder('b.ts'), placeholder('c.ts'), file('d.ts')]));
  expect(st().files.map((f) => f.rel)).toEqual(['a.ts', 'b.ts', 'd.ts']);
  const b = st().files[1]!;
  expect(b.unsaved).toBeUndefined();
  expect(b.lines.map((l) => [l.line, l.text, l.cutStart, l.cutEnd])).toEqual([[2, 'buffer token', false, false]]);
});

test('a dirty file main never lists (ignored, hidden, filtered out) never shows', () => {
  dirty.docs.set('/p/node_modules/x.js', 'token');
  dirty.docs.set('/p/ign.txt', 'token');
  st().setQuery('token'); st().run();
  emit(batch([file('a.ts')]));
  emit(done());
  expect(st().files.map((f) => f.rel)).toEqual(['a.ts']);
});

test('a dirty file in an ignored section keeps main\'s order', () => {
  dirty.docs.set('/p/node_modules/x.js', 'token');
  st().setQuery('token'); st().run();
  emit(batch([file('z.ts'), placeholder('node_modules/x.js'), file('node_modules/y.js')]));
  expect(st().files.map((f) => f.rel)).toEqual(['z.ts', 'node_modules/x.js', 'node_modules/y.js']);
});

test('a buffer over the editable size is left to the disk search', () => {
  dirty.docs.set('/p/big.ts', 'token\n'.repeat(1_000_000));
  st().setQuery('token'); st().run();
  expect(started[0]!.unsaved).toEqual([]);
});

test('an empty query through setSpec stops the search like an empty field', () => {
  st().setQuery('a'); st().run();
  const id = cur();
  st().setSpec({ query: '', regex: true });
  expect(stopped).toEqual([id]);
  expect(st().phase).toBe('idle');
});

test('focusField seeds the spec, bumps the nonce and runs', () => {
  const n = st().focusNonce;
  st().focusField({ query: 'seed', matchCase: true, wholeWord: false, regex: false });
  expect(st().focusNonce).toBe(n + 1);
  expect(st().spec.matchCase).toBe(true);
  expect(started[0]).toMatchObject({ query: 'seed', matchCase: true });
  st().focusField();
  expect(st().focusNonce).toBe(n + 2);
});

test('setSpec toggles re-run at once, filters wait for the debounce', () => {
  st().setQuery('a'); st().run();
  st().setSpec({ regex: true });
  expect(started).toHaveLength(2);
  expect(started[1]!.regex).toBe(true);
  st().setFilters({ include: 'src/' });
  expect(started).toHaveLength(2);
  vi.advanceTimersByTime(250);
  expect(started).toHaveLength(3);
  expect(started[2]!.include).toBe('src/');
  st().toggleFilters();
  expect(st().filtersOpen).toBe(true);
});
