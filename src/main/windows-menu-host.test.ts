import { expect, test } from 'vitest';
import type { WinMenu } from '@shared/windows-menu';
import { WindowsMenuHost, menuTargets, runMenuItem } from './windows-menu-host';

// The menu on Windows: main sends each window its own model (the Git menu follows
// that window's project) and runs only the items it sent, as the native menu would.

const model = (label: string): WinMenu[] => [{ label: 'File', items: [{ kind: 'item', id: `command:${label}`, label, accel: null, enabled: true }] }];

test('each window gets its own model, sent again only when it changed; only its items run', () => {
  const sent: [number, WinMenu[]][] = [];
  let label = 'new-session';
  const host = new WindowsMenuHost({ windows: () => [{ id: 1, send: (m) => sent.push([1, m]) }, { id: 2, send: (m) => sent.push([2, m]) }], build: (id) => model(id === 1 ? label : 'save') });
  host.refresh();
  expect(sent.map(([id]) => id)).toEqual([1, 2]);
  host.refresh();
  expect(sent).toHaveLength(2);
  label = 'new-terminal';
  host.refresh();
  expect(sent.map(([id]) => id)).toEqual([1, 2, 1]);
  expect(host.allowed(1, 'command:new-terminal')).toBe(true);
  expect(host.allowed(1, 'command:new-session')).toBe(false);
  expect(host.allowed(2, 'command:new-terminal')).toBe(false);
  expect(host.allowed(3, 'command:save')).toBe(false);
  host.forget(1);
  expect(host.allowed(1, 'command:new-terminal')).toBe(false);
});

test('a disabled item does not run, even from a stale or forged id (a native menu never clicks one)', () => {
  const host = new WindowsMenuHost({ windows: () => [], build: () => [{ label: 'Git', items: [
    { kind: 'item', id: 'command:git-undo-commit', label: 'Undo Last Commit', accel: null, enabled: false },
    { kind: 'submenu', label: 'Push', enabled: false, items: [{ kind: 'item', id: 'command:git-push', label: 'Push', accel: null, enabled: true }] },
    { kind: 'item', id: 'command:git-commit', label: 'Commit', accel: null, enabled: true }
  ] }] });
  host.model(1);
  expect(['command:git-undo-commit', 'command:git-push', 'command:git-commit'].map((id) => host.allowed(1, id))).toEqual([false, false, true]);
});

test('a window is watched once for its end, however often it asks for its model', () => {
  const gone: (() => void)[] = [];
  const host = new WindowsMenuHost({ windows: () => [], build: () => model('save'), watch: (_id, g) => gone.push(g) });
  host.model(1);
  host.model(1);
  expect(gone).toHaveLength(1);
  gone[0]!();
  expect(host.allowed(1, 'command:save')).toBe(false);
  host.model(1);
  expect(gone).toHaveLength(2);
});

test('an item runs the command, the action or the role it names', () => {
  const calls: string[] = [];
  const h = { command: (c: string) => calls.push(`c ${c}`), action: (a: string) => calls.push(`a ${a}`), role: (r: string) => calls.push(`r ${r}`) };
  runMenuItem('command:new-terminal-profile:user', h);
  runMenuItem('action:open-folder', h);
  runMenuItem('role:copy', h);
  runMenuItem('nonsense', h);
  runMenuItem('role:format-disk', h);
  expect(calls).toEqual(['c new-terminal-profile:user', 'a open-folder', 'r copy']);
});

// Found by the packaged smoke on Windows: a closing window's page is destroyed before the window,
// and refreshMenu runs from that page's 'destroyed' event. Reading its URL then threw in main, Electron's error box
// blocked the quit, and closing the last window left Atelier running.
test('menu targets: app pages only, never a window or a page already destroyed', () => {
  const win = (id: number, url: string, o: { win?: boolean; wc?: boolean } = {}) => ({
    isDestroyed: () => !!o.win,
    webContents: { id, isDestroyed: () => !!(o.wc || o.win), getURL: () => { if (o.wc || o.win) throw new TypeError('Object has been destroyed'); return url; } }
  });
  const isApp = (u: string) => u.startsWith('app://');
  const all = [win(1, 'app://main'), win(2, 'app://closing', { wc: true }), win(3, 'app://gone', { win: true }), win(4, 'https://elsewhere')];
  expect(menuTargets(all, isApp).map((w) => w.webContents.id)).toEqual([1]);
});
