import { mkdtempSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { GrantWatch, nodeWatch, type WatchEvent } from './grant-watch';

afterEach(() => { vi.useRealTimers(); });

function setup(opts: { missing?: Set<string> } = {}) {
  type Watcher = { file: string; on: (ev: WatchEvent) => void; onError?: () => void; live: boolean };
  const watching = new Map<string, Watcher>();
  const all: Watcher[] = [];
  const armed: string[] = [];
  const attempts: string[] = [];
  const stopped: string[] = [];
  const sent: { root: string; paths: string[] }[] = [];
  const w = new GrantWatch({
    watch: (file, on, onError) => {
      attempts.push(file);
      if (opts.missing?.has(file)) throw new Error('ENOENT');
      armed.push(file);
      const x: Watcher = { file, on, onError, live: true };
      all.push(x);
      watching.set(file, x);
      return () => { x.live = false; stopped.push(file); if (watching.get(file) === x) watching.delete(file); };
    },
    send: (root, paths) => sent.push({ root, paths }),
    debounceMs: 50,
    retryMs: 100,
    retries: 3
  });
  return { w, watching, all, armed, attempts, stopped, sent };
}

test('one watcher per open outside file, never its folder; changes reach their project, debounced', () => {
  vi.useFakeTimers();
  const { w, watching, sent } = setup();
  w.update('/p', ['/h/a.json', '/h/b.json', '/t/c.log']);
  expect([...watching.keys()].sort()).toEqual(['/h/a.json', '/h/b.json', '/t/c.log']);
  watching.get('/h/a.json')!.on('change');
  watching.get('/h/a.json')!.on('change');
  vi.advanceTimersByTime(50);
  expect(sent).toEqual([{ root: '/p', paths: ['/h/a.json'] }]);
});

test('a file replaced by an atomic save is reported and watched again on the same path', () => {
  vi.useFakeTimers();
  const { w, watching, armed, stopped, sent } = setup();
  w.update('/p', ['/h/a.json']);
  const first = watching.get('/h/a.json')!;
  first.on('rename');
  expect(stopped).toEqual(['/h/a.json']);
  vi.advanceTimersByTime(50);
  expect(sent).toEqual([{ root: '/p', paths: ['/h/a.json'] }]);
  expect(armed).toEqual(['/h/a.json', '/h/a.json']);
  // The new watcher reports the next change.
  watching.get('/h/a.json')!.on('change');
  vi.advanceTimersByTime(50);
  expect(sent).toHaveLength(2);
});

test('a file deleted then written again (delete-then-write saves) is re-armed by a retry and reported again', () => {
  vi.useFakeTimers();
  const missing = new Set<string>();
  const { w, watching, armed, sent } = setup({ missing });
  w.update('/p', ['/h/a.json']);
  missing.add('/h/a.json');
  watching.get('/h/a.json')!.on('rename');
  vi.advanceTimersByTime(50);
  expect(sent).toEqual([{ root: '/p', paths: ['/h/a.json'] }]);
  expect(armed).toEqual(['/h/a.json']);
  missing.delete('/h/a.json');
  vi.advanceTimersByTime(100);
  expect(armed).toEqual(['/h/a.json', '/h/a.json']);
  vi.advanceTimersByTime(50);
  expect(sent).toEqual([{ root: '/p', paths: ['/h/a.json'] }, { root: '/p', paths: ['/h/a.json'] }]);
});

test('a file gone for good stops after its retries; the next update arms it again and reports it (it came back)', () => {
  vi.useFakeTimers();
  const missing = new Set<string>();
  const { w, watching, armed, attempts, sent } = setup({ missing });
  w.update('/p', ['/h/a.json']);
  missing.add('/h/a.json');
  watching.get('/h/a.json')!.on('rename');
  vi.advanceTimersByTime(10_000);
  // The first arm, the one at the flush, then exactly `retries` (3) more.
  expect(attempts).toEqual(Array(5).fill('/h/a.json'));
  expect(sent).toHaveLength(1);
  missing.delete('/h/a.json');
  w.update('/p', ['/h/a.json']);
  expect(armed).toEqual(['/h/a.json', '/h/a.json']);
  vi.advanceTimersByTime(50);
  expect(sent).toEqual([{ root: '/p', paths: ['/h/a.json'] }, { root: '/p', paths: ['/h/a.json'] }]);
});

test('a late event from a replaced watcher leaves the new one alone', () => {
  vi.useFakeTimers();
  const { w, watching, all, sent } = setup();
  w.update('/p', ['/h/a.json']);
  const first = watching.get('/h/a.json')!;
  first.on('rename');
  vi.advanceTimersByTime(50);
  expect(all).toHaveLength(2);
  first.on('rename');
  first.onError!();
  first.on('change');
  expect(all[1]!.live).toBe(true);
  vi.advanceTimersByTime(50);
  expect(sent).toHaveLength(1);
});

test('the same file open in two projects: a replacement seen by one does not stop the other', () => {
  vi.useFakeTimers();
  const { w, all, sent } = setup();
  w.update('/p', ['/h/a.json']);
  w.update('/q', ['/h/a.json']);
  const [p, q] = all;
  p!.on('rename');
  expect(q!.live).toBe(true);
  vi.advanceTimersByTime(50);
  expect(sent).toEqual([{ root: '/p', paths: ['/h/a.json'] }]);
  q!.on('change');
  vi.advanceTimersByTime(50);
  expect(sent.at(-1)).toEqual({ root: '/q', paths: ['/h/a.json'] });
});

test('a watcher that errors is treated like a replacement: reported, then armed again', () => {
  vi.useFakeTimers();
  const { w, watching, armed, sent } = setup();
  w.update('/p', ['/h/a.json']);
  watching.get('/h/a.json')!.onError!();
  vi.advanceTimersByTime(50);
  expect(sent).toEqual([{ root: '/p', paths: ['/h/a.json'] }]);
  expect(armed).toEqual(['/h/a.json', '/h/a.json']);
});

test('closing a file stops its watcher and any pending retry; closing the project stops all', () => {
  vi.useFakeTimers();
  const missing = new Set<string>();
  const { w, watching, armed, stopped } = setup({ missing });
  w.update('/p', ['/h/a.json', '/t/c.log']);
  w.update('/p', ['/h/a.json']);
  expect(stopped).toEqual(['/t/c.log']);
  missing.add('/h/a.json');
  watching.get('/h/a.json')!.on('rename');
  w.update('/p', []);
  missing.delete('/h/a.json');
  vi.advanceTimersByTime(10_000);
  expect(armed).toEqual(['/h/a.json', '/t/c.log']);
  w.update('/p', ['/h/a.json']);
  w.update('/q', ['/h/a.json']);
  w.close('/p');
  // /q's own watcher of the same file stays.
  const live = armed.filter((f) => f === '/h/a.json').length - stopped.filter((f) => f === '/h/a.json').length;
  expect(live).toBe(1);
});

test('nodeWatch refuses a folder: watching one reads as access to all of it (a macOS privacy prompt)', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'grant-watch-')));
  expect(() => nodeWatch(dir, () => {})).toThrow();
});

test('nodeWatch refuses a symlink: a path swapped for a link never makes us open what it points to', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'grant-watch-')));
  writeFileSync(join(dir, 'real.txt'), 'x');
  symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt'));
  expect(() => nodeWatch(join(dir, 'link.txt'), () => {})).toThrow();
  nodeWatch(join(dir, 'real.txt'), () => {})();
});

test('a file that cannot be watched is skipped quietly', () => {
  const w = new GrantWatch({ watch: () => { throw new Error('EACCES'); }, send: () => {}, debounceMs: 10 });
  expect(() => w.update('/p', ['/h/a.json'])).not.toThrow();
});

test('real files: a write, an atomic replace, then a write to the new file are all reported', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'grant-watch-')));
  const file = join(dir, 'notes.txt');
  writeFileSync(file, 'one\n');
  let reports = 0;
  const w = new GrantWatch({ watch: nodeWatch, send: () => { reports++; }, debounceMs: 20, retryMs: 50 });
  try {
    w.update('/p', [file]);
    // kqueue registers the watcher on the loop's next turn.
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(file, 'two\n');
    await vi.waitFor(() => expect(reports).toBeGreaterThanOrEqual(1), { timeout: 3000 });
    // Another editor's atomic save: a temp file renamed over it (a new inode).
    writeFileSync(join(dir, '.notes.tmp'), 'three\n');
    renameSync(join(dir, '.notes.tmp'), file);
    const afterReplace = reports;
    await vi.waitFor(() => expect(reports).toBeGreaterThan(afterReplace), { timeout: 3000 });
    // Let the re-arm happen, then the new inode's own change must still come through.
    await new Promise((r) => setTimeout(r, 200));
    const before = reports;
    writeFileSync(file, 'four\n');
    await vi.waitFor(() => expect(reports).toBeGreaterThan(before), { timeout: 3000 });
  } finally {
    w.dispose();
  }
});
