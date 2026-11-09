import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { useApp } from './store';
import { single } from './split';
import type { TabKey } from './tabs-model';
import { tabMenu } from './menus';

// Docker tabs: one per target; a sidebar click opens the one preview tab.

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
const A = { kind: 'container', id: 'aaaaaaaaaaaa' } as const;
const B = { kind: 'container', id: 'bbbbbbbbbbbb' } as const;

beforeEach(() => {
  useApp.setState({
    project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, poppedOut: [], terminals: [], selectedId: null, activeTab: 'term', tabOrder: [],
    hidden: [], openFiles: [], preview: null, split: single(), ws: null, dockerTabs: [], dockerPreview: null,
    settings: { ...st().settings, previewTabs: true }
  });
});

test('a sidebar click opens the preview tab, and the next click replaces it', () => {
  st().openDocker(A, 'logs', { preview: true });
  st().openDocker(B, 'logs', { preview: true });
  expect(st().tabOrder).toEqual(k('dk:c:bbbbbbbbbbbb'));
  expect(st().dockerTabs.map((r) => r.key)).toEqual(k('dk:c:bbbbbbbbbbbb'));
  expect(st().dockerPreview).toBe('dk:c:bbbbbbbbbbbb');
  expect(st().activeKey()).toBe('dk:c:bbbbbbbbbbbb');
});

// Keep Open, as on a file's or a table's preview.
test('the tab menu: Keep Open on the Docker preview only', () => {
  const items = (key: TabKey) => tabMenu(key).filter((x): x is Exclude<typeof x, 'sep'> => x !== 'sep');
  st().openDocker(A, 'logs', { preview: true });
  const keep = items('dk:c:aaaaaaaaaaaa').find((x) => x.id === 'keep-open');
  expect(keep).toBeDefined();
  keep!.run();
  expect(st().dockerPreview).toBeNull();
  expect(items('dk:c:aaaaaaaaaaaa').map((x) => x.id)).not.toContain('keep-open');
});

test('tabs opened kept stay side by side', () => {
  st().openDocker(A);
  st().openDocker({ kind: 'stack', project: 'acme' });
  expect(st().tabOrder).toEqual(k('dk:c:aaaaaaaaaaaa', 'dk:s:acme'));
  expect(st().dockerPreview).toBeNull();
});

test('switching the preview’s view keeps it', () => {
  st().openDocker(A, 'logs', { preview: true });
  st().setDockerView('dk:c:aaaaaaaaaaaa', 'inspect');
  expect(st().dockerTabs[0]).toMatchObject({ view: 'inspect' });
  expect(st().dockerPreview).toBeNull();
  st().openDocker(B, 'logs', { preview: true });
  expect(st().tabOrder).toEqual(k('dk:c:aaaaaaaaaaaa', 'dk:c:bbbbbbbbbbbb'));
});

test('an open target comes to the front and nothing else changes', () => {
  st().openDocker(A);
  st().openDocker(B);
  st().openDocker(A, 'logs', { preview: true });
  expect(st().tabOrder).toEqual(k('dk:c:aaaaaaaaaaaa', 'dk:c:bbbbbbbbbbbb'));
  expect(st().activeKey()).toBe('dk:c:aaaaaaaaaaaa');
  expect(st().dockerPreview).toBeNull();
});

test('closing a tab drops its target, and the neighbour comes to the front', () => {
  st().openDocker(A);
  st().openDocker(B);
  st().closeTab('dk:c:bbbbbbbbbbbb');
  expect(st().dockerTabs.map((r) => r.key)).toEqual(k('dk:c:aaaaaaaaaaaa'));
  expect(st().activeKey()).toBe('dk:c:aaaaaaaaaaaa');
});
