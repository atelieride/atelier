import { describe, expect, test } from 'vitest';
import {
  agoText, cacheNoTtl, dbOfPick, doneRate, hitSeries, JsonNum, jsonLines, keyspaceBar, liveMatches, peakOps, queueDepth, queueDot, redisShown, relTime, splitKey, tickTtl,
  typeClass
} from './view';
import type { QueueInfo } from '@shared/redis-queues';

const q = (c: Partial<QueueInfo['counts']>, extra: Partial<QueueInfo> = {}): QueueInfo => ({
  id: 'bullmq|bull|q', lib: 'bullmq', prefix: 'bull', name: 'q', version: '5.0.0', counts: { waiting: 0, active: 0, delayed: 0, failed: 0, paused: false, ...c }, workers: 1, done: null, actions: true, ...extra
});

describe('visibility', () => {
  test('Auto: an instance listed or the project mentions Redis; Always; Never', () => {
    const none = { instances: [], pick: null, mentions: false, brew: false, probed: true };
    expect(redisShown('auto', none)).toBe(false);
    expect(redisShown('auto', { ...none, mentions: true })).toBe(true);
    expect(redisShown('auto', { ...none, instances: [{ key: 'tcp:6379' } as never] })).toBe(true);
    expect(redisShown('always', none)).toBe(true);
    expect(redisShown('never', { ...none, mentions: true })).toBe(false);
    expect(redisShown('auto', null)).toBe(false);
  });
});

describe('queues', () => {
  test('dot: failed rose, paused amber, active sky, else green', () => {
    expect(queueDot(q({ failed: 3 }))).toBe('err');
    expect(queueDot(q({ paused: true, waiting: 4 }))).toBe('warn');
    expect(queueDot(q({ active: 1 }))).toBe('work');
    expect(queueDot(q({}))).toBe('ok');
  });
  test('depth and rate', () => {
    expect(queueDepth(q({ waiting: 12, active: 1 }))).toBe('12');
    expect(queueDepth(q({ active: 1 }))).toBe('1 active');
    expect(queueDepth(q({}))).toBe('0');
    expect(doneRate(null)).toBe('—');
    expect(doneRate(new Array(26).fill(0))).toBe('idle');
    expect(doneRate([...new Array(16).fill(0), 3, 5, 4, 6, 2, 4, 5, 7, 3, 4])).toBe('4.3');
  });
});

describe('keys', () => {
  test('splitKey: the namespace part dimmed (after a framework prefix)', () => {
    expect(splitKey('cache:products:page:1', null)).toEqual({ pre: 'cache:', rest: 'products:page:1' });
    expect(splitKey('shop_database_cache:x', 'shop_database_')).toEqual({ pre: 'shop_database_cache:', rest: 'x' });
    expect(splitKey('plain', null)).toEqual({ pre: '', rest: 'plain' });
  });
  test('typeClass: JSON strings show as json; module types', () => {
    expect(typeClass('string', null)).toBe('string');
    expect(typeClass('string', 'json')).toBe('json');
    expect(typeClass('ReJSON-RL', null)).toBe('json');
    expect(typeClass('vectorset', null)).toBe('vector');
  });
  test('tickTtl counts down from when it was read', () => {
    expect(tickTtl(54_000, 1000, 11_000)).toBe(44_000);
    expect(tickTtl(5000, 0, 9000)).toBe(0);
    expect(tickTtl(-1, 0, 9000)).toBe(-1);
  });
  test('cacheNoTtl: a cache-looking namespace with keys that never expire', () => {
    const keys = [{ key: 'cache:a', type: 'string', ttl: -1, size: 1 }, { key: 'cache:b', type: 'string', ttl: 5, size: 1 }, { key: 'sess:1', type: 'hash', ttl: -1, size: 1 }];
    expect(cacheNoTtl(keys, null)).toEqual({ ns: 'cache', count: 1 });
    expect(cacheNoTtl(keys.slice(1), null)).toBeNull();
  });
  test('keyspaceBar: the top three namespaces and other', () => {
    expect(keyspaceBar([{ name: 'cache', count: 63, bytes: 0, withTtl: 0 }, { name: 'sess', count: 17, bytes: 0, withTtl: 0 }, { name: 'bull', count: 15, bytes: 0, withTtl: 0 }, { name: 'a', count: 3, bytes: 0, withTtl: 0 }, { name: 'b', count: 2, bytes: 0, withTtl: 0 }]))
      .toEqual([{ name: 'cache', pct: 63 }, { name: 'sess', pct: 17 }, { name: 'bull', pct: 15 }, { name: 'other', pct: 5 }]);
  });
});

describe('JSON lines', () => {
  const v = { page: 1, items: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], deep: { a: { b: { c: 1 } } }, ok: true, none: null };
  test('objects open to depth 2; arrays of objects open the first item; deeper folds', () => {
    const lines = jsonLines(v, new Set());
    const text = lines.map((l) => `${'  '.repeat(l.depth)}${l.key !== null ? `"${l.key}": ` : ''}${l.text}${l.comma ? ',' : ''}`);
    expect(text).toEqual([
      '{',
      '  "page": 1,',
      '  "items": [',
      '    {',
      '      "id": 1,',
      '      "name": "a"',
      '    },',
      '    { "id": 2, "name": "b" }',
      '  ],',
      '  "deep": {',
      '    "a": {',
      '      "b": {…}',
      '    }',
      '  },',
      '  "ok": true,',
      '  "none": null',
      '}'
    ]);
  });
  test('a fold’s line keeps its id folded or open: React keeps its button, and the keyboard on it', () => {
    const line = (folds: ReadonlySet<string>) => jsonLines(v, folds).find((l) => l.path === '$.items');
    const open = line(new Set());
    const folded = line(new Set(['$.items']));
    expect(open?.folded).toBe(false);
    expect(folded?.folded).toBe(true);
    expect(folded?.id).toBe(open?.id);
    // Still one id per line.
    const ids = jsonLines(v, new Set()).map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test('a fold toggles open; long arrays show 50 and the rest as a count', () => {
    const open = jsonLines(v, new Set(['$.deep.a.b']));
    expect(open.some((l) => l.key === 'c')).toBe(true);
    const big = jsonLines(Array.from({ length: 60 }, (_, i) => i), new Set());
    expect(big.filter((l) => l.cls === 'num')).toHaveLength(50);
    expect(big.some((l) => l.more === 10)).toBe(true);
  });
  test('classes per value kind', () => {
    const l = jsonLines({ s: 'x', n: 2, b: false, z: null }, new Set());
    expect(l.slice(1, 5).map((x) => x.cls)).toEqual(['str', 'num', 'bool', 'bool']);
  });
  test('a number kept as its source text (the Databases inspector\'s lossless trees): its digits, a number, a leaf', () => {
    const big = new JsonNum('12345678901234567890');
    const lines = jsonLines({ id: big, price: new JsonNum('248.00'), e: new JsonNum('-1.5E+400') }, new Set());
    expect(lines.slice(1, 4).map((x) => [x.text, x.cls, x.path])).toEqual([['12345678901234567890', 'num', null], ['248.00', 'num', null], ['-1.5E+400', 'num', null]]);
    // An array of them is an array of numbers: every item shown, none folded as if it were an object.
    const arr = jsonLines([new JsonNum('9007199254740993'), new JsonNum('2')], new Set());
    expect(arr.map((x) => x.text)).toEqual(['[', '9007199254740993', '2', ']']);
    // Folded objects in an array preview their numbers as written.
    const items = jsonLines([{ id: new JsonNum('1') }, { id: new JsonNum('12345678901234567891') }], new Set());
    expect(items.find((x) => x.folded)?.text).toBe('{ "id": 12345678901234567891 }');
  });
});

describe('time and series', () => {
  test('relTime, agoText', () => {
    expect(relTime(1000, 121_000)).toBe('2m ago');
    expect(relTime(200_000, 80_000)).toBe('in 2m');
    expect(relTime(110_000, 120_000)).toBe('10s ago');
    expect(agoText(240_000)).toBe('4 min ago');
  });
  test('hitSeries from counter deltas; peak ops', () => {
    const s = [{ at: 0, usedMemory: 1, ops: 10, hits: 0, misses: 0, expired: 0, evicted: 0 }, { at: 2000, usedMemory: 1, ops: 312, hits: 9, misses: 1, expired: 0, evicted: 0 }, { at: 4000, usedMemory: 1, ops: 41, hits: 10, misses: 2, expired: 0, evicted: 0 }];
    expect(hitSeries(s)).toEqual([90, 50]);
    expect(peakOps(s)).toEqual({ ops: 312, at: 2000 });
  });
  test('liveMatches: a key glob over the first argument', () => {
    expect(liveMatches('cache:product*', ['cache:product:1'])).toBe(true);
    expect(liveMatches('cache:product*', ['sess:1'])).toBe(false);
    expect(liveMatches('', ['x'])).toBe(true);
    expect(liveMatches('4021', ['sess:u:4021:x'])).toBe(true);
  });
});

describe('dbOfPick', () => {
  test('the database the picked instance’s project config names (REDIS_DB, /2 in a URL), else 0', () => {
    const snap = { instances: [{ key: 'tcp:6379', db: 2 }, { key: 'tcp:6380', db: 0 }] as never[], pick: 'tcp:6379', mentions: true, brew: false, probed: true };
    expect(dbOfPick(snap)).toBe(2);
    expect(dbOfPick({ ...snap, pick: 'tcp:6380' })).toBe(0);
    expect(dbOfPick({ ...snap, pick: null })).toBe(0);
  });
});
