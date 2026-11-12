import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { SEARCH_LIMITS, type SearchEvent, type SearchFile, type SearchSpec } from '@shared/search';
import { useMachinePlatform } from '../../../tests/support/platform';
import type { ListedFile } from './list';
import { runSearch, SHARED_FILE, SHARED_STOP, sharedSlots, type RunInput, type WorkerMsg } from './run';

// scanFile as it is, with hooks: a file can be held back before it is read, the order reads finish is noted, and each
// line matched can be seen (a test can make it cost time on a fake clock).
const hooks = vi.hoisted(() => ({
  gates: new Map<string, Promise<void>>(),
  finished: [] as string[],
  onFinish: null as null | (() => void),
  onLine: null as null | ((line: string) => void),
  /** A file whose opening takes `ms`, whether it is opened synchronously (blocking the thread) or not. */
  slow: null as null | { path: string; ms: number },
  /** Whole-file reads held until their promise settles, and the reads that have begun. */
  readGates: new Map<string, Promise<void>>(),
  readStarted: new Set<string>(),
  /** Every line a compiled query really evaluates, with that query. */
  onMatch: null as null | ((query: string) => void),
}));
vi.mock('@shared/search-match', async (importOriginal) => {
  const real = await importOriginal<typeof import('@shared/search-match')>();
  return {
    ...real,
    compileSearch: (spec: Parameters<typeof real.compileSearch>[0]) => {
      const c = real.compileSearch(spec);
      if (c.kind !== 'ok') return c;
      return { kind: 'ok' as const, ranges: (line: string) => { hooks.onMatch?.(spec.query); return c.ranges(line); } };
    },
  };
});
vi.mock('./scan', async (importOriginal) => {
  const real = await importOriginal<typeof import('./scan')>();
  return {
    ...real,
    scanFile: async (...args: Parameters<typeof real.scanFile>) => {
      const [path, ranges, ...rest] = args;
      const gate = hooks.gates.get(path);
      if (gate) await gate;
      const r = await real.scanFile(path, (line) => { hooks.onLine?.(line); return ranges(line); }, ...rest);
      hooks.finished.push(path);
      hooks.onFinish?.();
      return r;
    },
  };
});
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => {
      if (hooks.slow && args[0] === hooks.slow.path) {
        const end = performance.now() + hooks.slow.ms;
        while (performance.now() < end) { /* a read that blocks the thread */ }
      }
      return real.openSync(...args);
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      if (hooks.slow && args[0] === hooks.slow.path) await new Promise((r) => setTimeout(r, hooks.slow!.ms));
      return real.open(...args);
    },
    readFile: async (...args: Parameters<typeof real.readFile>) => {
      const path = String(args[0]);
      hooks.readStarted.add(path);
      const gate = hooks.readGates.get(path);
      if (gate) await gate;
      return real.readFile(...args);
    },
  };
});

useMachinePlatform();

const never = () => false;
const spec = (query: string, regex = false): SearchSpec => ({ query, matchCase: true, wholeWord: false, regex });

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'atl-run-')));
}

/** A project of files named by their relative path; listed in the order given. */
function project(files: Record<string, string | Buffer>): { root: string; listed: ListedFile[] } {
  const root = tmp();
  const listed: ListedFile[] = [];
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    listed.push({ path, rel, ignored: false });
  }
  return { root, listed };
}

function input(root: string, files: ListedFile[], query = 'token', over: Partial<RunInput> = {}, limits: Partial<RunInput['limits']> = {}): RunInput {
  return {
    searchId: 42,
    spec: spec(query),
    files,
    fileCap: null,
    unsaved: [],
    realRoot: root,
    limits: { maxResults: SEARCH_LIMITS.maxResults, wholeReadBytes: SEARCH_LIMITS.wholeReadBytes, maxBytes: SEARCH_LIMITS.maxBytes, keptLineChars: SEARCH_LIMITS.keptLineChars, ...limits },
    ...over,
  };
}

async function collect(i: RunInput, cancelled: () => boolean = never, now?: () => number): Promise<WorkerMsg[]> {
  const out: WorkerMsg[] = [];
  await runSearch(i, (m) => out.push(m), cancelled, now);
  return out;
}

const batches = (ms: WorkerMsg[]) => ms.filter((m): m is Extract<SearchEvent, { kind: 'batch' }> => m.kind === 'batch');
const doneOf = (ms: WorkerMsg[]) => {
  const d = ms.filter((m) => m.kind === 'done');
  expect(d).toHaveLength(1);
  expect(ms.at(-1)).toBe(d[0]);
  return d[0] as Extract<SearchEvent, { kind: 'done' }>;
};
const filesOf = (ms: WorkerMsg[]): SearchFile[] => batches(ms).flatMap((b) => b.files);
const matchCount = (ms: WorkerMsg[]) => filesOf(ms).reduce((n, f) => n + f.lines.reduce((k, l) => k + l.ranges.length, 0), 0);

describe('runSearch', () => {
  test('results come in the list order even when later files finish reading first', async () => {
    const names = Array.from({ length: 10 }, (_, i) => `f${i}.txt`);
    const { root, listed } = project(Object.fromEntries(names.map((n) => [n, `a token in ${n}\n`])));
    // The first file is held until three later ones are read.
    let release!: () => void;
    hooks.gates.set(listed[0]!.path, new Promise<void>((r) => { release = r; }));
    hooks.finished.length = 0;
    hooks.onFinish = () => { if (hooks.finished.length >= 3) release(); };
    try {
      const ms = await collect(input(root, listed));
      expect(hooks.finished.indexOf(listed[0]!.path)).toBeGreaterThanOrEqual(3);
      expect(filesOf(ms).map((f) => [f.rel, f.lines[0]!.text])).toEqual(names.map((n) => [n, `a token in ${n}`]));
    } finally {
      hooks.gates.clear();
      hooks.onFinish = null;
    }
  });

  test('a file the page searches itself is not read: a placeholder takes its place in the order and counts no result', async () => {
    const { root, listed } = project({ 'a.txt': 'token\n', 'b.txt': 'token\n', 'c.txt': 'token\n' });
    hooks.finished.length = 0;
    const ms = await collect(input(root, listed, 'token', { unsaved: [listed[1]!.path] }, { maxResults: 2 }));
    expect(hooks.finished).not.toContain(listed[1]!.path);
    expect(filesOf(ms).map((f) => [f.rel, f.unsaved === true, f.lines.length])).toEqual([['a.txt', false, 1], ['b.txt', true, 0], ['c.txt', false, 1]]);
    const d = doneOf(ms);
    expect(d.limitHit).toBe(false);
    expect(d.searched).toBe(3);
  });

  test('a file not in the list never gets a placeholder', async () => {
    const { root, listed } = project({ 'a.txt': 'token\n' });
    const ms = await collect(input(root, listed, 'token', { unsaved: [join(root, 'node_modules/x.js')] }));
    expect(filesOf(ms).map((f) => f.rel)).toEqual(['a.txt']);
  });

  test('every message carries the search id', async () => {
    const { root, listed } = project({ 'a.txt': 'token\n', 'b.txt': 'token token\n' });
    const ms = await collect(input(root, listed));
    expect(ms.length).toBeGreaterThan(2);
    for (const m of ms) expect(m.searchId).toBe(42);
  });

  test('done counts the files searched and lists the ones too large to search', async () => {
    const big = 'token\n'.repeat(100);
    const { root, listed } = project({
      'a.txt': 'one token\n',
      'b.bin': Buffer.from('token\0token'),
      'c.txt': big,
      'd.txt': 'nothing here\n',
      'e.txt': 'token at the end',
    });
    const ms = await collect(input(root, listed, 'token', { fileCap: 5 }, { wholeReadBytes: 64, maxBytes: 128 }));
    const d = doneOf(ms);
    expect(d).toMatchObject({ searched: 5, total: 5, limitHit: false, fileCap: 5, stopped: false });
    expect(d.skipped).toEqual([{ path: listed[2]!.path, rel: 'c.txt', size: big.length, reason: 'too-large' }]);
    expect(filesOf(ms).map((f) => [f.rel, f.size, f.lines.map((l) => l.line)])).toEqual([['a.txt', 10, [1]], ['e.txt', 16, [1]]]);
    for (const b of batches(ms)) expect(b.total).toBe(5);
  });

  test('a query that cannot match searches nothing', async () => {
    const { root, listed } = project({ 'a.txt': 'token\n' });
    for (const s of [spec(''), spec('(', true), spec('a\\nb')]) {
      const ms = await collect(input(root, listed, '', { spec: s }));
      expect(batches(ms)).toEqual([]);
      expect(doneOf(ms)).toMatchObject({ searched: 0, total: 1, limitHit: false, stopped: false });
    }
  });

  test('the result cap stops the search with exactly that many matches', async () => {
    const names = Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
    const { root, listed } = project(Object.fromEntries(names.map((n) => [n, 'token token\ntoken\n'])));
    const ms = await collect(input(root, listed, 'token', {}, { maxResults: 5 }));
    expect(matchCount(ms)).toBe(5);
    // Two files of three matches: the second is cut after its second match.
    expect(filesOf(ms).map((f) => f.lines.map((l) => l.ranges.length))).toEqual([[2, 1], [2]]);
    expect(doneOf(ms)).toMatchObject({ limitHit: true, stopped: false, searched: 2, total: 20 });
  });

  test('a cap reached across files read at the same time still keeps exactly that many', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
    const { root, listed } = project(Object.fromEntries(names.map((n) => [n, 'token\n'.repeat(4)])));
    const ms = await collect(input(root, listed, 'token', {}, { maxResults: 10 }));
    expect(matchCount(ms)).toBe(10);
    expect(filesOf(ms).map((f) => f.rel)).toEqual(['f00.txt', 'f01.txt', 'f02.txt']);
    expect(doneOf(ms)).toMatchObject({ limitHit: true, searched: 3 });
  });

  test('exactly as many matches as the cap: all kept, and no limit reported until one more is found', async () => {
    const names = Array.from({ length: 5 }, (_, i) => `f${i}.txt`);
    const exact = project(Object.fromEntries(names.map((n) => [n, 'one token\n'])));
    const ms = await collect(input(exact.root, exact.listed, 'token', {}, { maxResults: 5 }));
    expect(matchCount(ms)).toBe(5);
    expect(doneOf(ms)).toMatchObject({ limitHit: false, searched: 5, total: 5 });

    // A sixth match, after a file with none: now the cap did cut something.
    const more = project({ ...Object.fromEntries(names.map((n) => [n, 'one token\n'])), 'g.txt': 'nothing\n', 'h.txt': 'token\n' });
    const ms2 = await collect(input(more.root, more.listed, 'token', {}, { maxResults: 5 }));
    expect(matchCount(ms2)).toBe(5);
    expect(filesOf(ms2).map((f) => f.rel)).toEqual(names);
    expect(doneOf(ms2)).toMatchObject({ limitHit: true, total: 7 });
  });

  test('a cancelled search ends with stopped and what it found so far', async () => {
    const names = Array.from({ length: 60 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
    const { root, listed } = project(Object.fromEntries(names.map((n) => [n, 'token\n'])));
    let stop = false;
    const out: WorkerMsg[] = [];
    await runSearch(input(root, listed), (m) => { out.push(m); if (m.kind === 'batch') stop = true; }, () => stop);
    const d = doneOf(out);
    expect(d.stopped).toBe(true);
    expect(d.limitHit).toBe(false);
    expect(d.searched).toBeLessThan(60);
    expect(filesOf(out)).toHaveLength(d.searched);
  });

  test('a beat comes at least every 250 ms of work, and the shared slot names the file being matched', async () => {
    // One long file read whole (under 5 MB): 300,000 lines, a single match at the end. It waits for the small one.
    const body = 'nothing here\n'.repeat(300_000) + 'token\n';
    const { root, listed } = project({ 'small.txt': 'token\n', 'long.txt': body });
    let release!: () => void;
    hooks.gates.set(listed[1]!.path, new Promise<void>((r) => { release = r; }));
    hooks.onFinish = () => { if (hooks.finished.includes(listed[0]!.path)) release(); };
    const shared = sharedSlots();
    let t = 0;
    const now = () => (t += 5);
    const stamped: { m: WorkerMsg; at: number; file: number }[] = [];
    try {
      await runSearch(input(root, listed, 'token', { shared }), (m) => stamped.push({ m, at: t, file: Atomics.load(shared, SHARED_FILE) }), never, now);
    } finally {
      hooks.gates.clear();
      hooks.onFinish = null;
    }
    for (let k = 1; k < stamped.length; k++) expect(stamped[k]!.at - stamped[k - 1]!.at).toBeLessThanOrEqual(250);
    const beats = stamped.filter((s) => s.m.kind === 'beat');
    expect(beats[0]).toEqual({ m: { kind: 'beat', searchId: 42 }, at: expect.any(Number), file: 0 });
    // The long file kept the clock running: several beats while it was matched, the slot naming it (index + 1).
    expect(beats.filter((b) => b.file === 2).length).toBeGreaterThan(5);
  });

  test('beats come on time only, not one per file', async () => {
    const names = Array.from({ length: 200 }, (_, i) => `f${String(i).padStart(3, '0')}.txt`);
    const { root, listed } = project(Object.fromEntries(names.map((n) => [n, 'token\n'])));
    const shared = sharedSlots();
    // A clock that never moves: no silence ever calls for a beat after the first one.
    const ms = await collect(input(root, listed, 'token', { shared }), never, () => 0);
    expect(ms.filter((m) => m.kind === 'beat')).toEqual([{ kind: 'beat', searchId: 42 }]);
    // The slot still followed the matching to the end: the last file matched is one of the last eight read.
    expect(Atomics.load(shared, SHARED_FILE)).toBeGreaterThan(200 - 8);
  });

  test('long lines with a slow regular expression still beat at least every 250 ms', async () => {
    // 300 lines of 10,000 characters, each costing 20 ms of matching on the fake clock.
    const body = `${'x'.repeat(9_999)}\n`.repeat(300) + 'token\n';
    const { root, listed } = project({ 'long-lines.txt': body });
    let t = 0;
    hooks.onLine = (line) => { t += line.length / 500; };
    const stamped: { m: WorkerMsg; at: number }[] = [];
    try {
      await runSearch(input(root, listed), (m) => stamped.push({ m, at: t }), never, () => t);
    } finally {
      hooks.onLine = null;
    }
    expect(t).toBeGreaterThan(5_000);
    for (let k = 1; k < stamped.length; k++) expect(stamped[k]!.at - stamped[k - 1]!.at).toBeLessThanOrEqual(250);
    expect(stamped.filter((s) => s.m.kind === 'beat').length).toBeGreaterThan(20);
  });

  test('a slow read never silences the worker: beats keep coming while a file is opened', async () => {
    const { root, listed } = project({ 'a.txt': 'token\n', 'slow.txt': 'token\n', 'c.txt': 'token\n' });
    hooks.slow = { path: listed[1]!.path, ms: 1_000 };
    const t0 = performance.now();
    const at: number[] = [];
    try {
      await runSearch(input(root, listed), () => at.push(performance.now()), never);
    } finally {
      hooks.slow = null;
    }
    expect(performance.now() - t0).toBeGreaterThanOrEqual(1_000);
    const gaps = at.map((t, k) => t - (k === 0 ? t0 : at[k - 1]!));
    // Beats every 200 ms or so; a read that blocked the thread would leave a gap of a whole second.
    expect(Math.max(...gaps)).toBeLessThan(600);
  });

  test('a search with no matches still reports its progress', async () => {
    const names = Array.from({ length: 200 }, (_, i) => `f${String(i).padStart(3, '0')}.txt`);
    const { root, listed } = project(Object.fromEntries(names.map((n) => [n, 'nothing here\n'])));
    let t = 0;
    const ms = await collect(input(root, listed), never, () => (t += 3));
    const bs = batches(ms);
    expect(bs.length).toBeGreaterThan(2);
    for (const b of bs) expect(b).toMatchObject({ files: [], total: 200 });
    const searched = bs.map((b) => b.searched);
    for (let k = 1; k < searched.length; k++) expect(searched[k]!).toBeGreaterThan(searched[k - 1]!);
    expect(doneOf(ms)).toMatchObject({ searched: 200, total: 200 });
  });

  test('a stop written to the shared slot is seen inside a file being matched, not only between files', async () => {
    // One file read whole: matching it is a single synchronous run, which no message can interrupt.
    const { root, listed } = project({ 'big.txt': 'nothing here\n'.repeat(200_000) });
    const shared = sharedSlots();
    let lines = 0;
    hooks.onLine = () => { if (++lines === 10_000) Atomics.store(shared, SHARED_STOP, 1); };
    let ms: WorkerMsg[];
    try {
      ms = await collect(input(root, listed, 'token', { shared }));
    } finally {
      hooks.onLine = null;
    }
    expect(lines).toBeLessThan(20_000);
    expect(doneOf(ms)).toMatchObject({ stopped: true, searched: 0 });
  });

  test('a whole-file read that finishes after done never runs the old query, and the next search is unaffected', async () => {
    const { root, listed } = project({ 'big.txt': 'oldterm here\n'.repeat(5_000) });
    const big = listed[0]!.path;
    let release!: () => void;
    hooks.readGates.set(big, new Promise<void>((r) => { release = r; }));
    const evaluated: string[] = [];
    try {
      // The search stops while its file is being read whole: `done` does not wait for that read.
      let stop = false;
      const ms: WorkerMsg[] = [];
      const first = runSearch(input(root, listed, 'oldterm'), (m) => ms.push(m), () => stop);
      await vi.waitFor(() => expect(hooks.readStarted.has(big)).toBe(true));
      stop = true;
      await first;
      expect(doneOf(ms)).toMatchObject({ stopped: true, searched: 0 });

      // The next search runs while the old read ends and its text arrives.
      hooks.onMatch = (q) => { evaluated.push(q); };
      const other = project({ 'b.txt': 'a newterm\n' });
      const second = collect(input(other.root, other.listed, 'newterm'));
      release();
      const ms2 = await second;
      await vi.waitFor(() => expect(hooks.finished).toContain(big));
      expect(evaluated.filter((q) => q === 'oldterm')).toEqual([]);
      expect(filesOf(ms2).map((f) => [f.rel, f.lines[0]!.text])).toEqual([['b.txt', 'a newterm']]);
      expect(doneOf(ms2)).toMatchObject({ stopped: false, searched: 1 });
    } finally {
      release();
      hooks.readGates.clear();
      hooks.onMatch = null;
    }
  });

  test('batches come at most every 50 ms; the first result goes out at once', async () => {
    const names = Array.from({ length: 200 }, (_, i) => `f${String(i).padStart(3, '0')}.txt`);
    const { root, listed } = project(Object.fromEntries(names.map((n) => [n, 'token\n'])));
    let t = 0;
    const now = () => (t += 3);
    const stamped: { m: WorkerMsg; at: number }[] = [];
    await runSearch(input(root, listed), (m) => stamped.push({ m, at: t }), never, now);
    const bs = stamped.filter((s) => s.m.kind === 'batch');
    expect(bs.length).toBeGreaterThan(3);
    expect((bs[0]!.m as Extract<SearchEvent, { kind: 'batch' }>).files).toHaveLength(1);
    // The last batch goes out with done, whatever the time.
    for (let k = 1; k < bs.length - 1; k++) expect(bs[k]!.at - bs[k - 1]!.at).toBeGreaterThanOrEqual(50);
    expect(stamped.at(-2)!.m).toBe(bs.at(-1)!.m);
    expect(filesOf(stamped.map((s) => s.m)).map((f) => f.rel)).toEqual(names);
  });

  describe('speed', () => {
    // 2,500 files, 8 KB each (20 MB), the term in the first file of each folder from the 26th on: every byte is read
    // and matched, and the first result comes only after half of the files.
    let root = '';
    let listed: ListedFile[] = [];
    beforeAll(() => {
      root = tmp();
      const line = 'export const value = compute(alpha, beta, gamma); // a line of ordinary code\n';
      const plain = line.repeat(Math.ceil(8192 / line.length)).slice(0, 8192);
      const withTerm = plain.slice(0, 4096) + 'const needle = 1;\n' + plain.slice(4096 + 18);
      for (let d = 0; d < 50; d++) {
        mkdirSync(join(root, `dir${String(d).padStart(2, '0')}`));
        for (let f = 0; f < 50; f++) {
          const rel = `dir${String(d).padStart(2, '0')}/file${String(f).padStart(2, '0')}.ts`;
          const path = join(root, rel);
          writeFileSync(path, f === 0 && d >= 25 ? withTerm : plain);
          listed.push({ path, rel, ignored: false });
        }
      }
    });

    test('2,500 files (20 MB): the whole search under 3 s, its first batch under 500 ms', async () => {
      expect(listed).toHaveLength(2500);
      const once = async () => {
        const t0 = performance.now();
        let first = Infinity;
        let matches = 0;
        await runSearch(input(root, listed, 'needle'), (m) => {
          if (m.kind !== 'batch' || m.files.length === 0) return;
          if (first === Infinity) {
            first = performance.now() - t0;
            // Progress batches went out before it: the first result really came after half of the files.
            expect(m.searched).toBeGreaterThan(1250);
          }
          matches += m.files.length;
        }, never);
        expect(matches).toBe(25);
        return { total: performance.now() - t0, first };
      };
      // One untimed warm-up, then the best of five (a busy runner can stall any single run).
      await once();
      let best = { total: Infinity, first: Infinity };
      for (let k = 0; k < 5; k++) {
        const r = await once();
        best = { total: Math.min(best.total, r.total), first: Math.min(best.first, r.first) };
      }
      expect(best.total).toBeLessThan(3000);
      expect(best.first).toBeLessThan(500);
    }, 60_000);
  });
});
