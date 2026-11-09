import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import type { AutomationView } from '@shared/api';
import { useApp } from './store';
import { single } from './split';
import type { TabKey } from './tabs-model';
import { tabMenu } from './menus';
import { saveAutomation } from './automations/actions';

// Automations tabs: one per automation and one for every project's list; a
// sidebar click opens the preview tab; This project / All only filters the sidebar.

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
const view = (id: string): AutomationView => ({ automation: { id, project: '/p', name: id } }) as unknown as AutomationView;

beforeEach(() => {
  useApp.setState({
    project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, poppedOut: [], terminals: [], selectedId: null, activeTab: 'term', tabOrder: [],
    hidden: [], openFiles: [], preview: null, split: single(), ws: null, autoTabs: [], autoPreview: null, autoFilter: 'project',
    automations: { automations: [view('a1'), view('a2')] }, settings: { ...st().settings, previewTabs: true }
  });
});

test('a sidebar click opens the preview tab, and the next click replaces it', () => {
  st().openAutomations('a1', { preview: true });
  st().openAutomations('a2', { preview: true });
  expect(st().tabOrder).toEqual(k('au:a2'));
  expect(st().autoPreview).toBe('au:a2');
});

test('kept tabs stay side by side; every project’s list has its own tab', () => {
  st().openAutomations('a1');
  st().openAutomations(null);
  expect(st().tabOrder).toEqual(k('au:a1', 'au:all'));
  expect(st().autoTabs.map((r) => r.id)).toEqual(['a1', null]);
  expect(st().activeKey()).toBe('au:all');
});

test('opening the preview again kept keeps it', () => {
  st().openAutomations('a1', { preview: true });
  expect(st().autoPreview).toBe('au:a1');
  st().openAutomations('a1');
  expect(st().autoPreview).toBeNull();
});

test('This project / All only filters the sidebar: no tab changes', () => {
  st().openAutomations('a1');
  st().setAutoFilter('all');
  expect(st().autoFilter).toBe('all');
  expect(st().tabOrder).toEqual(k('au:a1'));
});

test('an automation removed closes its tab', () => {
  st().openAutomations('a1');
  st().openAutomations('a2');
  st().setAutomations({ automations: [view('a2')] });
  expect(st().tabOrder).toEqual(k('au:a2'));
  expect(st().autoTabs.map((r) => r.id)).toEqual(['a2']);
});

test('saving a new automation opens its tab; saving an existing one opens nothing', async () => {
  const saved = view('a3');
  (globalThis as { window: { atelier: unknown } }).window.atelier = { automations: { save: async () => ({ automations: [view('a1'), view('a2'), saved] }) } };
  await saveAutomation(saved.automation);
  expect(st().tabOrder).toEqual(k('au:a3'));
  st().closeTab('au:a3');
  await saveAutomation(saved.automation);
  expect(st().tabOrder).toEqual([]);
});

// Keep Open, as on a file's or a table's preview.
test('the tab menu: Keep Open on the automation preview only', () => {
  const ids = (key: TabKey) => tabMenu(key).filter((x): x is Exclude<typeof x, 'sep'> => x !== 'sep').map((x) => x.id);
  st().openAutomations('a1', { preview: true });
  expect(ids('au:a1')).toContain('keep-open');
  tabMenu('au:a1').find((x): x is Exclude<typeof x, 'sep'> => x !== 'sep' && x.id === 'keep-open')!.run();
  expect(st().autoPreview).toBeNull();
  expect(ids('au:a1')).not.toContain('keep-open');
});

test('an Automations tab offers no Move to New Window (it can’t pop out)', () => {
  st().openAutomations('a1');
  const ids = tabMenu('au:a1').filter((x): x is Exclude<typeof x, 'sep'> => x !== 'sep').map((x) => x.id);
  expect(ids).not.toContain('move-window');
});
