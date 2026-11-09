import { beforeEach, expect, test } from 'vitest';
import { CSV_OPTIONS_KEY, MAX_CSV_OPTIONS, dropCsvOptions, loadCsvOptions, optionsOf, parseCsvOptions, renameCsvOptions, saveCsvOptions, withOptions } from './options';
import { AUTO_OPTIONS } from './types';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }
  };
});

test('parsing keeps absolute paths with valid options only, filling what is missing with auto', () => {
  const raw = JSON.stringify({
    '/p/a.csv': { delimiter: ';', header: false, decimal: ',', skip: 2 },
    '/p/b.csv': { delimiter: 'x', header: 'maybe', decimal: '!', skip: -4 },
    '/p/c.csv': { skip: 99 },
    'relative.csv': { delimiter: ';' },
    '/p/d.csv': 'nope'
  });
  expect(parseCsvOptions(raw)).toEqual({
    '/p/a.csv': { delimiter: ';', header: false, decimal: ',', skip: 2 },
    '/p/b.csv': AUTO_OPTIONS,
    '/p/c.csv': { ...AUTO_OPTIONS, skip: 20 }
  });
  expect(parseCsvOptions('{broken')).toEqual({});
  expect(parseCsvOptions(null)).toEqual({});
  expect(parseCsvOptions('[1]')).toEqual({});
});

test('a file without an entry is auto; auto options remove the entry; the map is bounded', () => {
  expect(optionsOf({}, '/p/a.csv')).toEqual(AUTO_OPTIONS);
  let all = withOptions({}, '/p/a.csv', { ...AUTO_OPTIONS, delimiter: '\t' });
  expect(optionsOf(all, '/p/a.csv').delimiter).toBe('\t');
  all = withOptions(all, '/p/a.csv', AUTO_OPTIONS);
  expect(all).toEqual({});
  for (let i = 0; i < MAX_CSV_OPTIONS + 5; i++) all = withOptions(all, `/p/${i}.csv`, { ...AUTO_OPTIONS, skip: 1 });
  expect(Object.keys(all)).toHaveLength(MAX_CSV_OPTIONS);
  expect(all['/p/0.csv']).toBeUndefined();
  expect(all[`/p/${MAX_CSV_OPTIONS + 4}.csv`]).toBeDefined();
});

test('renames and the Trash follow the file; folders carry their files', () => {
  const all = { '/p/a.csv': { ...AUTO_OPTIONS, skip: 1 }, '/p/dir/b.csv': { ...AUTO_OPTIONS, header: false } };
  expect(Object.keys(renameCsvOptions(all, '/p/a.csv', '/p/z.csv'))).toEqual(['/p/z.csv', '/p/dir/b.csv']);
  expect(Object.keys(renameCsvOptions(all, '/p/dir', '/p/out'))).toContain('/p/out/b.csv');
  expect(Object.keys(dropCsvOptions(all, '/p/a.csv'))).toEqual(['/p/dir/b.csv']);
});

test('saved and loaded through localStorage, untitled tabs left out', () => {
  saveCsvOptions({ '/p/a.csv': { ...AUTO_OPTIONS, skip: 3 }, 'untitled:1': { ...AUTO_OPTIONS, skip: 1 } });
  expect(JSON.parse(store.get(CSV_OPTIONS_KEY)!)).toEqual({ '/p/a.csv': { ...AUTO_OPTIONS, skip: 3 } });
  expect(loadCsvOptions()).toEqual({ '/p/a.csv': { ...AUTO_OPTIONS, skip: 3 } });
});
