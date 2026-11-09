import { afterEach, beforeEach, expect, test } from 'vitest';
import { EMPTY_DB_SNAPSHOT, type DbConnView } from '@shared/databases';
import { DEFAULT_SETTINGS, type ShowDatabases } from '@shared/settings';
import { useDb } from '../databases/store';
import { renderLive } from '../databases/test-render';
import { useApp, type Activity } from '../store';
import { ActivityBar } from './ActivityBar';

// The Databases activity: after Redis, a stroked cylinder, shown per Settings › Databases.

/** The bar with the stores' live state. */
const html = () => renderLive(ActivityBar);
const labels = (out: string) => [...out.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);
const DB = 'Databases (⌃⇧B)';
const set = (show: ShowDatabases, activity: Activity = 'sessions') =>
  useApp.setState({ activity, settings: { ...DEFAULT_SETTINGS, showDatabases: show, showRedis: 'always', automationsEnabled: true } });
/** Each store's initial state as the file found it, field by field. */
const pristine = [useApp, useDb].map((s) => ({ ...s.getInitialState() }) as Record<string, unknown>);

beforeEach(() => {
  useDb.setState({ snap: EMPTY_DB_SNAPSHOT });
  set('auto');
});
afterEach(() => {
  useApp.setState(useApp.getInitialState(), true);
  useDb.setState(useDb.getInitialState(), true);
});

test('a render reads the live state and leaves every store\'s initial state as it was', () => {
  set('always', 'databases');
  expect(labels(html())).toContain(DB);
  [useApp, useDb].forEach((s, i) => {
    const now = s.getInitialState() as unknown as Record<string, unknown>;
    expect(Object.keys(pristine[i]!).filter((k) => !Object.is(now[k], pristine[i]![k]))).toEqual([]);
  });
});

test('Always: the item sits after Redis, before Automations, with its tooltip and shortcut', () => {
  set('always');
  const out = html();
  const l = labels(out);
  expect(l.indexOf(DB)).toBe(l.indexOf('Redis (⌃⇧R)') + 1);
  expect(l[l.indexOf(DB) + 1]).toBe('Automations (⌘⇧A)');
  expect(out).toContain('aria-label="Databases (⌃⇧B)" data-tip="Databases" data-kbd="⌃⇧B"');
});

test('the item draws the cylinder', () => {
  set('always');
  const out = html();
  const button = out.slice(out.indexOf(`aria-label="${DB}"`), out.indexOf('</button>', out.indexOf(`aria-label="${DB}"`)));
  expect(button).toContain('<ellipse cx="10" cy="5.2" rx="6" ry="2.2"');
});

test('Auto: hidden until this window can see a saved connection (nothing is looked for)', () => {
  expect(labels(html())).not.toContain(DB);
  useDb.setState({ snap: { ...EMPTY_DB_SNAPSHOT, connections: [{ conn: { id: 'a' }, state: 'idle' } as unknown as DbConnView] } });
  expect(labels(html())).toContain(DB);
  useDb.setState({ snap: EMPTY_DB_SNAPSHOT });
  expect(labels(html())).not.toContain(DB);
});

test('Auto: the item stays while its view shows (opened with ⌃⇧B), even with no connection saved', () => {
  set('auto', 'databases');
  expect(labels(html())).toContain(DB);
});

test('Never: no item, whatever the project has, even while its view still shows', () => {
  set('never', 'databases');
  useDb.setState({ snap: { ...EMPTY_DB_SNAPSHOT, connections: [{ conn: { id: 'a' }, state: 'idle' } as unknown as DbConnView] } });
  expect(labels(html())).not.toContain(DB);
});

test('selected: the item is the active one', () => {
  set('always', 'databases');
  expect(html()).toMatch(/class="act is-active[^"]*" aria-label="Databases \(⌃⇧B\)"/);
});

// The view in front clicked again hides the sidebar, and then no item is the active one.
test('sidebar hidden: no item is the active one, its view kept for when it shows again', () => {
  set('always', 'databases');
  useApp.setState({ sidebarHidden: true });
  const out = html();
  expect(out).not.toContain('is-active');
  expect(out).not.toContain('aria-pressed="true"');
  expect(labels(out)).toContain(DB);
});

test('the item in front says it is pressed and that a click hides the sidebar; the others say their view', () => {
  set('always', 'databases');
  const out = html();
  expect(out).toContain('aria-label="Databases (⌃⇧B)" data-tip="Hide sidebar" data-kbd="⌘B" aria-pressed="true"');
  expect(out).toContain('aria-label="Sessions (⌘⇧1)" data-tip="Sessions" data-kbd="⌘⇧1" aria-pressed="false"');
});
