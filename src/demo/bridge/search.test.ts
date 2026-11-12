import { describe, expect, test, vi } from 'vitest';
import type { SearchEvent, SearchRequest } from '@shared/search';
import { compileWorld } from '../compile/index';
import { createClock } from '../engine/clock';
import { createDemo } from './index';
import { createSearch } from './search';

// search.* in the demo: Find in Files over the fictional project's files with the app's own matcher and path filter,
// its events as main sends them (batches in path order, then done; stale once a file changes after a search).

const compiled = compileWorld();
const root = compiled.project.root;
const make = () => createDemo(compiled, { version: '0.0.0-test', clock: createClock() });

function req(searchId: number, query: string, over: Partial<SearchRequest> = {}): SearchRequest {
  return { searchId, query, matchCase: false, wholeWord: false, regex: false, include: '', exclude: '', includeIgnored: false, ...over };
}

/** Every event the page would get, and a wait for the end of a search. */
function listen(api: { onEvent(cb: (e: SearchEvent) => void): () => void }) {
  const events: SearchEvent[] = [];
  const off = api.onEvent((e) => events.push(e));
  const ended = (searchId: number) => vi.waitFor(() => {
    const end = events.find((e) => e.searchId === searchId && (e.kind === 'done' || e.kind === 'error'));
    if (!end) throw new Error('not yet');
    return end;
  });
  return { events, off, ended };
}

const filesOf = (events: SearchEvent[]) => events.flatMap((e) => (e.kind === 'batch' ? e.files : []));

describe('demo Find in Files', () => {
  test('TokenStore: found in src/auth/session.ts then src/auth/tokens.ts, every file searched, then done', async () => {
    const { api, context } = make();
    const { events, ended } = listen(api.search);
    await api.search.start(req(1, 'TokenStore'));
    // Nothing during the call: the events come afterwards, as over IPC.
    expect(events).toEqual([]);
    const end = await ended(1);
    const total = Object.keys(context.state.files).length;
    expect(end).toEqual({ kind: 'done', searchId: 1, searched: total, total, skipped: [], limitHit: false, fileCap: null, stopped: false });
    expect(events.at(-1)).toBe(end);
    const found = filesOf(events);
    expect(found.map((f) => f.rel)).toEqual(['src/auth/session.ts', 'src/auth/tokens.ts']);
    expect(found[0]).toMatchObject({ path: `${root}/src/auth/session.ts`, size: new TextEncoder().encode(context.state.files['src/auth/session.ts']!).length });
    expect(found[0]!.lines.map((l) => [l.line, l.text, l.ranges])).toEqual([
      [1, "import { TokenStore } from './tokens';", [[9, 19]]],
      [8, 'const store = new TokenStore();', [[18, 28]]]
    ]);
    expect(found[1]!.lines.map((l) => [l.line, l.ranges])).toEqual([[1, [[13, 23]]]]);
    // The last batch says how far the search got.
    const batches = events.filter((e) => e.kind === 'batch');
    expect(batches.at(-1)).toMatchObject({ searched: total, total });
  });

  test("the editor find's options and the path filters, as in the app", async () => {
    const { api, context } = make();
    /** The 1-based lines of a file of the world that `re` matches. */
    const linesOf = (rel: string, re: RegExp) => context.state.files[rel]!.split('\n').flatMap((l, i) => (re.test(l) ? [i + 1] : []));
    const { events, ended } = listen(api.search);
    await api.search.start(req(1, 'tokenstore', { matchCase: true }));
    await ended(1);
    expect(filesOf(events)).toEqual([]);
    await api.search.start(req(2, 'Token\\w+', { regex: true, exclude: 'src/auth/session.ts' }));
    await ended(2);
    expect(filesOf(events.filter((e) => e.searchId === 2)).map((f) => f.rel)).toEqual(['src/auth/tokens.ts']);
    await api.search.start(req(3, 'token', { wholeWord: true, include: 'src/auth' }));
    const end = await ended(3);
    // `token` alone, never inside TokenStore or tokens.
    const word = /\btoken\b/i;
    expect(linesOf('src/auth/tokens.ts', word)).toEqual([4, 5, 8, 9]);
    expect(filesOf(events.filter((e) => e.searchId === 3)).map((f) => [f.rel, f.lines.map((l) => l.line)])).toEqual([
      ['src/auth/session.ts', linesOf('src/auth/session.ts', word)], ['src/auth/tokens.ts', [4, 5, 8, 9]]
    ]);
    expect(end).toMatchObject({ kind: 'done', searched: 2, total: 2 });
  });

  test('files in the hidden folders count as ignored: searched only when asked, after all the others', async () => {
    const { api, context } = make();
    context.worktree.write('dist/app.js', 'new TokenStore();\n');
    const { events, ended } = listen(api.search);
    await api.search.start(req(1, 'TokenStore'));
    await ended(1);
    expect(filesOf(events).map((f) => f.rel)).toEqual(['src/auth/session.ts', 'src/auth/tokens.ts']);
    await api.search.start(req(2, 'TokenStore', { includeIgnored: true }));
    await ended(2);
    expect(filesOf(events.filter((e) => e.searchId === 2)).map((f) => f.rel)).toEqual(['src/auth/session.ts', 'src/auth/tokens.ts', 'dist/app.js']);
  });

  test('a query that cannot run (an invalid regular expression) ends at once with nothing found', async () => {
    const { api, context } = make();
    const { events, ended } = listen(api.search);
    await api.search.start(req(1, '(', { regex: true }));
    expect(await ended(1)).toEqual({ kind: 'done', searchId: 1, searched: 0, total: Object.keys(context.state.files).length, skipped: [], limitHit: false, fileCap: null, stopped: false });
    expect(events.filter((e) => e.kind === 'batch')).toEqual([]);
  });

  test('stopped before it ran: done says stopped, nothing found; a newer search replaces an older one silently', async () => {
    const { api } = make();
    const { events, ended } = listen(api.search);
    await api.search.start(req(1, 'TokenStore'));
    await api.search.stop(1);
    expect(await ended(1)).toEqual({ kind: 'done', searchId: 1, searched: 0, total: 0, skipped: [], limitHit: false, fileCap: null, stopped: true });
    await api.search.start(req(2, 'TokenStore'));
    await api.search.start(req(3, 'invoice'));
    await ended(3);
    expect(events.filter((e) => e.searchId === 2)).toEqual([]);
    expect(events.filter((e) => e.searchId === 1)).toHaveLength(1);
    // A stop for a search already over, or another one, changes nothing.
    await api.search.stop(3);
    await api.search.stop(9);
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.searchId === 3 && e.kind === 'done')).toHaveLength(1);
  });

  test('the limits: the result cap cuts the search where the app would, the file cap says how many files were listed', async () => {
    const { context } = make();
    const search = createSearch(context, { maxResults: 1 });
    const { events, ended } = listen(search);
    await search.start(req(1, 'TokenStore'));
    // Every file before session.ts in path order was searched, then session.ts, where the second match is cut.
    const searched = Object.keys(context.state.files).sort().indexOf('src/auth/session.ts') + 1;
    expect(await ended(1)).toMatchObject({ kind: 'done', limitHit: true, searched });
    expect(filesOf(events).map((f) => [f.rel, f.lines.map((l) => l.line)])).toEqual([['src/auth/session.ts', [1]]]);

    const capped = createSearch(context, { maxFiles: 2 });
    const c = listen(capped);
    await capped.start(req(1, 'e'));
    expect(await c.ended(1)).toMatchObject({ kind: 'done', fileCap: 2, total: 2, searched: 2 });
  });

  test('a file changed after a search: stale once for that search, again for the next one', async () => {
    const { api, context } = make();
    const { events, ended } = listen(api.search);
    // No search yet: nothing to tell.
    context.worktree.write('README.md', '# acme\n');
    await api.search.start(req(1, 'TokenStore'));
    await ended(1);
    context.worktree.write('README.md', '# acme store\n');
    context.worktree.write('src/new.ts', 'export const TokenStore2 = 1;\n');
    expect(events.filter((e) => e.kind === 'stale')).toEqual([{ kind: 'stale', searchId: 1 }]);
    await api.search.start(req(2, 'TokenStore'));
    await ended(2);
    expect(filesOf(events.filter((e) => e.searchId === 2)).map((f) => f.rel)).toEqual(['src/auth/session.ts', 'src/auth/tokens.ts', 'src/new.ts']);
    context.worktree.write('src/new.ts', null);
    expect(events.filter((e) => e.kind === 'stale')).toEqual([{ kind: 'stale', searchId: 1 }, { kind: 'stale', searchId: 2 }]);
  });

  test('the engine does not load (the visitor went offline): the search ends with an error, as one the app could not start', async () => {
    vi.resetModules();
    vi.doMock('./search-run', () => { throw new Error('offline'); });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { createSearch: fresh } = await import('./search');
      const search = fresh(make().context);
      const { ended } = listen(search);
      await search.start(req(1, 'TokenStore'));
      expect(await ended(1)).toEqual({ kind: 'error', searchId: 1, message: 'The search stopped: it could not be started.', rel: null });
    } finally {
      quiet.mockRestore();
      vi.doUnmock('./search-run');
    }
  });

  test('a listener that unsubscribes hears nothing more', async () => {
    const { api } = make();
    const { events, off, ended } = listen(api.search);
    const other = listen(api.search);
    off();
    await api.search.start(req(1, 'TokenStore'));
    await other.ended(1);
    expect(events).toEqual([]);
    void ended;
  });
});
