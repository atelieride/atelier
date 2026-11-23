import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { RemoteLayout } from '@shared/remote';
import { LayoutStore, MAX_LAYOUTS } from './layouts';

const layout = (o: Partial<RemoteLayout> = {}): RemoteLayout => ({ groupByState: true, pins: ['t1'], order: { sessions: ['t2', 't1'], terminals: [] }, ...o });
const home = () => mkdtempSync(join(tmpdir(), 'atl-layouts-'));

test('a project\'s last layout, kept across restarts in ATELIER_HOME/remote/layouts.json, 0600 in a 0700 folder', () => {
  const h = home();
  const a = new LayoutStore(h);
  expect(a.get('/p')).toBeNull();
  expect(a.set('/p', layout())).toBe(true);
  // The same again changes nothing (and writes nothing).
  expect(a.set('/p', layout())).toBe(false);
  expect(a.get('/p')).toEqual(layout());
  const file = join(h, 'remote', 'layouts.json');
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(h, 'remote')).mode & 0o777).toBe(0o700);
  const b = new LayoutStore(h);
  expect(b.get('/p')).toEqual(layout());
  expect(b.get('/other')).toBeNull();
});

test('workspaces and activities with their places and members, as the window sent them', () => {
  const a = new LayoutStore(home());
  const ws = layout({ workspaces: { active: 'w2', activities: true, places: [{ id: 'w1', name: 'Main', color: 1, open: true }, { id: 'w2', name: 'SSO', color: 3, parent: 'w1', folder: 'okta', open: false }], members: { t1: 'w2' } } });
  a.set('/p', ws);
  expect(a.get('/p')).toEqual(ws);
});

test('a file this version can\'t read: no layouts until windows send them again', () => {
  const h = home();
  new LayoutStore(h).set('/p', layout());
  writeFileSync(join(h, 'remote', 'layouts.json'), '{"v":1,"projects":{"/p":{"groupByState":"yes"}}}');
  expect(new LayoutStore(h).get('/p')).toBeNull();
});

test('at most MAX_LAYOUTS projects: the one changed longest ago goes', () => {
  const h = home();
  const a = new LayoutStore(h);
  for (let i = 0; i <= MAX_LAYOUTS; i++) a.set(`/p${i}`, layout({ pins: [`t${i}`] }));
  expect(a.get('/p0')).toBeNull();
  expect(a.get(`/p${MAX_LAYOUTS}`)).toEqual(layout({ pins: [`t${MAX_LAYOUTS}`] }));
  const saved = JSON.parse(readFileSync(join(h, 'remote', 'layouts.json'), 'utf8')) as { projects: Record<string, unknown> };
  expect(Object.keys(saved.projects)).toHaveLength(MAX_LAYOUTS);
});
