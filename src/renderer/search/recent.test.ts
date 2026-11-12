import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { loadRecent, pushRecent } from './recent';

const g = globalThis as { localStorage?: unknown };
let hadStorage: unknown;
let data: Map<string, string>;
beforeAll(() => { hadStorage = g.localStorage; });
afterAll(() => { g.localStorage = hadStorage; });
beforeEach(() => {
  data = new Map();
  g.localStorage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
});

const s = (query: string, over: Partial<{ matchCase: boolean; wholeWord: boolean; regex: boolean }> = {}) => ({ query, matchCase: false, wholeWord: false, regex: false, ...over });

test('newest first, deduped by query and options, ten per project, per project', () => {
  for (let i = 0; i < 12; i++) pushRecent('/p', s(`q${i}`));
  expect(loadRecent('/p')).toHaveLength(10);
  expect(loadRecent('/p')[0]!.query).toBe('q11');
  pushRecent('/p', s('q5'));
  expect(loadRecent('/p')[0]!.query).toBe('q5');
  expect(loadRecent('/p').filter((x) => x.query === 'q5')).toHaveLength(1);
  pushRecent('/p', s('q5', { regex: true }));
  expect(loadRecent('/p').filter((x) => x.query === 'q5')).toHaveLength(2);
  expect(loadRecent('/other')).toEqual([]);
});

test('an empty query is not kept, and broken storage reads as empty', () => {
  pushRecent('/p', s(''));
  expect(loadRecent('/p')).toEqual([]);
  data.set('atelier.search.recent', '{nope');
  expect(loadRecent('/p')).toEqual([]);
  data.set('atelier.search.recent', JSON.stringify({ '/p': [{ query: 1 }, s('ok')] }));
  expect(loadRecent('/p').map((x) => x.query)).toEqual(['ok']);
  g.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  expect(loadRecent('/p')).toEqual([]);
  expect(pushRecent('/p', s('x')).map((x) => x.query)).toEqual(['x']);
});
