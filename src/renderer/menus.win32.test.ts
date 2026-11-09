import { afterEach, beforeEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { editorMenu } from './menus';
import type { MenuItem } from './menu-model';
import { useApp } from './store';

// Windows: paths are canonical (C:/…) inside the app; what the user copies is the native
// spelling every Windows tool takes (C:\…), as a file dropped on a terminal already is.

const g = globalThis as { window?: unknown };
let copied: string[];

beforeEach(() => {
  initPlatform('win32');
  copied = [];
  g.window = { atelier: { clipboard: { write: async (s: string) => { copied.push(s); return true; } } } };
  useApp.setState({ project: { root: 'C:/Users/me/acme', name: 'acme', realRoot: 'C:/Users/me/acme' } });
});
afterEach(() => { resetPlatformForTests(); delete g.window; });

const run = (items: MenuItem[], id: string) => { const i = items.find((x) => x !== 'sep' && x.id === id); if (i && i !== 'sep') i.run(); };

test('Copy Path and Copy Relative Path copy the native spelling', async () => {
  const items = editorMenu('C:/Users/me/acme/src/app/main.ts', { copy: null, selectAll: () => {}, find: () => {}, gotoLine: () => {}, mentionLines: null });
  run(items, 'copy-path');
  run(items, 'copy-rel');
  await new Promise((r) => setTimeout(r, 0));
  expect(copied).toEqual(['C:\\Users\\me\\acme\\src\\app\\main.ts', 'src\\app\\main.ts']);
});
