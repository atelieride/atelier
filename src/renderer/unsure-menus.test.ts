import { beforeEach, expect, test } from 'vitest';
import { changeMenu, treeMenu } from './menus';
import type { MenuItem } from './menu-model';
import { useApp } from './store';

// The keyboard way to "Why unsure": Who Changed This… in the row menus, only when the
// file's origin is unsure.

type Entry = Exclude<MenuItem, 'sep'>;
const item = (items: MenuItem[], id: string) => items.find((i): i is Entry => i !== 'sep' && i.id === id);

beforeEach(() => useApp.setState({ originSheet: null, terminals: [] }));

test('Changes rows: Who Changed This… opens the sheet for that file, only when unsure', () => {
  expect(item(changeMenu({ path: '/p/a.ts', rel: 'a.ts', deleted: false }), 'who-changed')).toBeUndefined();
  const who = item(changeMenu({ path: '/p/a.ts', rel: 'a.ts', deleted: false, unsure: true }), 'who-changed');
  expect(who?.label).toBe('Who Changed This…');
  who!.run();
  expect(useApp.getState().originSheet).toBe('/p/a.ts');
});

test('the file tree: the same item on an unsure file, never on a folder or a sure file', () => {
  expect(item(treeMenu({ path: '/p/a.ts', rel: 'a.ts', dir: false }, () => {}), 'who-changed')).toBeUndefined();
  expect(item(treeMenu({ path: '/p/src', rel: 'src', dir: true, unsure: true }, () => {}), 'who-changed')).toBeUndefined();
  item(treeMenu({ path: '/p/a.ts', rel: 'a.ts', dir: false, unsure: true }, () => {}), 'who-changed')!.run();
  expect(useApp.getState().originSheet).toBe('/p/a.ts');
});
