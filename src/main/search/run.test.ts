import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { SEARCH_LIMITS, type SearchEvent, type SearchFile, type SearchSpec } from '@shared/search';
import { useMachinePlatform } from '../../../tests/support/platform';
import type { ListedFile } from './list';
import { runSearch, type RunInput, type WorkerMsg } from './run';

// scanFile as it is, with two hooks: a file can be held back before it is read, and the order reads finish is noted.
const hooks = vi.hoisted(() => ({
  gates: new Map<string, Promise<void>>(),
  finished: [] as string[],
  onFinish: null as null | (() => void),
}));
vi.mock('./scan', async (importOriginal) => {
  const real = await importOriginal<typeof import('./scan')>();
  return {
    ...real,
    scanFile: async (...args: Parameters<typeof real.scanFile>) => {
      const gate = hooks.gates.get(args[0]);
      if (gate) await gate;
      const r = await real.scanFile(...args);
      hooks.finished.push(args[0]);
      hooks.onFinish?.();
      return r;
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

  test('a beat comes at least every 250 ms of work, naming the file being matched', async () => {
    // One long file read whole (under 5 MB): 300,000 lines, a single match at the end. It waits for the small one.
    const body = 'nothing here\n'.repeat(300_000) + 'token\n';
    const { root, listed } = project({ 'small.txt': 'token\n', 'long.txt': body });
    let release!: () => void;
    hooks.gates.set(listed[1]!.path, new Promise<void>((r) => { release = r; }));
    hooks.onFinish = () => { if (hooks.finished.includes(listed[0]!.path)) release(); };
    let t = 0;
    const now = () => (t += 5);
    const stamped: { m: WorkerMsg; at: number }[] = [];
    try {
      await runSearch(input(root, listed), (m) => stamped.push({ m, at: t }), never, now);
    } finally {
      hooks.gates.clear();
      hooks.onFinish = null;
    }
    for (let k = 1; k < stamped.length; k++) expect(stamped[k]!.at - stamped[k - 1]!.at).toBeLessThanOrEqual(250);
    const beats = stamped.map((s) => s.m).filter((m) => m.kind === 'beat');
    expect(beats[0]).toEqual({ kind: 'beat', searchId: 42, rel: null });
    // Matching moved to each file: a beat says so at once.
    expect(beats.map((b) => b.rel).filter((r, k, all) => r !== all[k - 1])).toEqual([null, 'small.txt', 'long.txt']);
    // The long file kept the clock running: several beats while it was matched.
    expect(beats.filter((b) => b.rel === 'long.txt').length).toBeGreaterThan(5);
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
    // 2,500 files, 8 KB each (20 MB), the term in one file of fifty: every byte is read and matched.
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
          writeFileSync(path, f === 0 ? withTerm : plain);
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
          if (m.kind !== 'batch') return;
          first = Math.min(first, performance.now() - t0);
          matches += m.files.length;
        }, never);
        expect(matches).toBe(50);
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
