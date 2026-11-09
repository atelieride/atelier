import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { useApp } from './store';
import { useRedis } from './redis/store';
import { redisViewsMenu } from './redis/actions';
import { single } from './split';
import type { TabKey } from './tabs-model';

// Redis tabs: one per view — Keys, Queues, Live, Overview.

const g = globalThis as { window?: unknown; localStorage?: unknown };
let had: unknown;
let hadStorage: unknown;
beforeAll(() => {
  had = g.window;
  hadStorage = g.localStorage;
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  g.window = { addEventListener: () => {}, atelier: {} };
});
afterAll(() => { g.window = had; g.localStorage = hadStorage; });

const st = () => useApp.getState();
const k = (...keys: string[]) => keys as TabKey[];

beforeEach(() => {
  useRedis.setState({ status: null });
  useApp.setState({
    project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, poppedOut: [], terminals: [], selectedId: null, activeTab: 'term', tabOrder: [],
    hidden: [], openFiles: [], preview: null, split: single(), ws: null, redisTabs: []
  });
});

test('each view opens its own tab after the one in front', () => {
  st().openRedis('live');
  st().openRedis('keys');
  expect(st().tabOrder).toEqual(k('rd:live', 'rd:keys'));
  expect(st().redisTabs).toEqual(['live', 'keys']);
  expect(st().activeKey()).toBe('rd:keys');
});

test('an open view only comes to the front', () => {
  st().openRedis('live');
  st().openRedis('keys');
  st().openRedis('live');
  expect(st().tabOrder).toEqual(k('rd:live', 'rd:keys'));
  expect(st().activeKey()).toBe('rd:live');
});

test('no view asked for: Keys', () => {
  st().openRedis();
  expect(st().tabOrder).toEqual(k('rd:keys'));
});

test('a view the instance doesn’t offer opens nothing', () => {
  useRedis.setState({ status: { queues: [], denied: ['info'] } as never });
  st().openRedis('queues');
  st().openRedis('live');
  expect(st().tabOrder).toEqual([]);
  st().openRedis('keys');
  expect(st().tabOrder).toEqual(k('rd:keys'));
});

test('the Redis strip’s + lists the views the instance offers, the open ones checked; one picked opens', () => {
  useRedis.setState({ status: { queues: [], denied: [] } as never });
  st().openRedis('live');
  const items = redisViewsMenu().filter((x): x is Exclude<typeof x, 'sep'> => x !== 'sep');
  expect(items.map((x) => x.label)).toEqual(['Keys', 'Live', 'Overview']);
  expect(items.map((x) => !!x.checked)).toEqual([false, true, false]);
  items[0]!.run();
  expect(st().activeKey()).toBe('rd:keys');
});

test('closing a view’s tab leaves the others', () => {
  st().openRedis('live');
  st().openRedis('keys');
  st().closeTab('rd:live');
  expect(st().redisTabs).toEqual(['keys']);
  expect(st().tabOrder).toEqual(k('rd:keys'));
});
