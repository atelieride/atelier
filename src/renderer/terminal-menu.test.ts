import { expect, test, vi } from 'vitest';
import { terminalMenu } from './menus';
import type { MenuItem } from './menu-model';
import { initPlatform, resetPlatformForTests } from '@shared/platform';

const base = { copy: null, paste: () => {}, selectAll: () => {}, clear: () => {} };
const ids = (items: MenuItem[]) => items.map((i) => (i === 'sep' ? 'sep' : i.id));
const item = (items: MenuItem[], id: string) => items.find((i): i is Exclude<MenuItem, 'sep'> => i !== 'sep' && i.id === id)!;

test('a selection can run in a new terminal or go to one picked in the palette, above Copy', () => {
  const run = vi.fn();
  const pick = vi.fn();
  const items = terminalMenu({ ...base, send: { run, pick } });
  expect(ids(items).slice(0, 3)).toEqual(['run-in-new-terminal', 'send-to-terminal', 'sep']);
  expect([item(items, 'run-in-new-terminal').label, item(items, 'send-to-terminal').label]).toEqual(['Run in New Terminal', 'Send to…']);
  item(items, 'run-in-new-terminal').run();
  item(items, 'send-to-terminal').run();
  expect(run).toHaveBeenCalledOnce();
  expect(pick).toHaveBeenCalledOnce();
});

test('no selection: both items stay, disabled, and say how to get one', () => {
  const items = terminalMenu({ ...base, send: null });
  for (const id of ['run-in-new-terminal', 'send-to-terminal']) {
    expect(item(items, id).disabled).toBe(true);
    expect(item(items, id).tip).toBe('Select text first');
  }
});

test('Find: after Select All, with the terminal’s key per platform; absent without a view to open it', () => {
  const find = vi.fn();
  try {
    initPlatform('darwin');
    let items = terminalMenu({ ...base, find });
    expect(ids(items)).toEqual(['copy', 'paste', 'select-all', 'sep', 'find', 'sep', 'clear']);
    expect([item(items, 'find').label, item(items, 'find').hint]).toEqual(['Find', '⌘F']);
    item(items, 'find').run();
    expect(find).toHaveBeenCalledOnce();
    initPlatform('win32');
    items = terminalMenu({ ...base, find });
    expect(item(items, 'find').hint).toBe('Ctrl+Shift+F');
    expect(ids(terminalMenu(base))).toEqual(['copy', 'paste', 'select-all', 'sep', 'clear']);
  } finally { resetPlatformForTests(); }
});
