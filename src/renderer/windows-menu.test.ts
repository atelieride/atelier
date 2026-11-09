import { describe, expect, test } from 'vitest';
import type { KeyLike } from '@shared/accelerators';
import type { WinMenu } from '@shared/windows-menu';
import { CLOSED_BAR, menuBar, menuBindings, menuKeys, pickBinding, reduceBar, titleAnchor, toContextItems } from './windows-menu';
import { placeDropDown } from './menu-model';

// The menu in the window's header on Windows: its drop-downs reuse the app's context
// menu, its shortcuts are matched in the page, and a terminal keeps Ctrl+letter.

const menus: WinMenu[] = [
  { label: 'File', items: [
    { kind: 'item', id: 'command:new-session', label: 'New Claude Session', accel: 'Ctrl+Shift+N', enabled: true },
    { kind: 'item', id: 'command:save', label: 'Save', accel: 'Ctrl+S', enabled: true },
    { kind: 'separator' },
    { kind: 'submenu', label: 'New Terminal with Profile', enabled: true, items: [{ kind: 'item', id: 'command:new-terminal-profile:user', label: 'PowerShell', accel: null, enabled: true }] },
    { kind: 'item', id: 'command:git-undo-commit', label: 'Undo Last Commit', accel: null, enabled: false }
  ] },
  { label: 'Edit', items: [{ kind: 'item', id: 'role:copy', label: 'Copy', accel: 'Ctrl+C', enabled: true, native: true }] },
  { label: 'View', items: [{ kind: 'item', id: 'command:open-palette', label: 'Command Palette', accel: 'F1', enabled: true }, { kind: 'item', id: 'role:togglefullscreen', label: 'Full Screen', accel: 'F11', enabled: true }] }
];

const key = (k: Partial<KeyLike> & { key: string; code: string }): KeyLike =>
  ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...k });

test('drop-downs as context menu items: shortcuts as hints, submenus, disabled items, separators', () => {
  const run: string[] = [];
  const items = toContextItems(menus[0]!.items, (id) => run.push(id));
  expect(items.map((i) => (i === 'sep' ? 'sep' : [i.label, i.hint ?? null, !!i.disabled, i.submenu?.length ?? 0]))).toEqual([
    ['New Claude Session', 'Ctrl+Shift+N', false, 0], ['Save', 'Ctrl+S', false, 0], 'sep', ['New Terminal with Profile', null, false, 1], ['Undo Last Commit', null, true, 0]
  ]);
  const first = items[0]!;
  if (first !== 'sep') first.run();
  const sub = items[3]!;
  if (sub !== 'sep') { const s = sub.submenu![0]!; if (s !== 'sep') s.run(); }
  expect(run).toEqual(['command:new-session', 'command:new-terminal-profile:user']);
});

// Checkable items (View › Word Wrap, Go's workspaces): the check carried over, on or off, so the drop-down announces
// a checkbox or a radio and its state; the ✓ icon while on.
test('checkable items keep their check, on or off, and whether they are a radio', () => {
  const items = toContextItems([
    { kind: 'item', id: 'command:toggle-word-wrap', label: 'Word Wrap', accel: null, enabled: true, checked: false },
    { kind: 'item', id: 'command:workspace-0', label: 'Auth', accel: null, enabled: true, checked: true, radio: true },
    { kind: 'item', id: 'command:save', label: 'Save', accel: null, enabled: true }
  ], () => {});
  expect(items.map((i) => (i === 'sep' ? 'sep' : [i.label, i.checked, i.radio, i.icon]))).toEqual([
    ['Word Wrap', false, undefined, undefined], ['Auth', true, true, 'check'], ['Save', undefined, undefined, undefined]
  ]);
});

test('shortcuts: menu items only — not the native Edit keys, not F1 (the page opens the palette itself)', () => {
  expect(menuBindings(menus).map((b) => b.id)).toEqual(['command:new-session', 'command:save', 'role:togglefullscreen']);
});

test('a terminal keeps Ctrl+letter: Save from an editor, ^S to the terminal; Ctrl+Shift shortcuts work in both', () => {
  const b = menuBindings(menus);
  expect(pickBinding(b, key({ key: 's', code: 'KeyS', ctrlKey: true }), false)).toBe('command:save');
  expect(pickBinding(b, key({ key: 's', code: 'KeyS', ctrlKey: true }), true)).toBe(null);
  expect(pickBinding(b, key({ key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true }), true)).toBe('command:new-session');
  expect(pickBinding(b, key({ key: 'F11', code: 'F11' }), true)).toBe('role:togglefullscreen');
  expect(pickBinding(b, key({ key: 'n', code: 'KeyN', ctrlKey: true }), false)).toBe(null);
});

test('AltGr typing a character is never a shortcut', () => {
  const b = menuBindings([{ label: 'Git', items: [{ kind: 'item', id: 'command:git-write-message', label: 'Write', accel: 'Ctrl+Alt+M', enabled: true }] }]);
  expect(pickBinding(b, key({ key: 'm', code: 'KeyM', ctrlKey: true, altKey: true }), false)).toBe('command:git-write-message');
  expect(pickBinding(b, key({ key: 'µ', code: 'KeyM', ctrlKey: true, altKey: true }), false)).toBe(null);
  expect(pickBinding(b, key({ key: 'm', code: 'KeyM', ctrlKey: true, altKey: true, getModifierState: (k) => k === 'AltGraph' }), false)).toBe(null);
});

test('a key the page already handled (CodeMirror’s Ctrl+Shift+K deletes the line) is not the menu’s: macOS’s order', () => {
  const b = menuBindings([{ label: 'View', items: [{ kind: 'item', id: 'command:open-palette', label: 'Search…', accel: 'Ctrl+Shift+K', enabled: true }] }]);
  const k = key({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true });
  expect(pickBinding(b, k, false)).toBe('command:open-palette');
  expect(pickBinding(b, { ...k, defaultPrevented: true }, false)).toBe(null);
});

test('Alt+F4 is left to Windows (it closes the window itself): no second close', () => {
  const b = menuBindings([{ label: 'File', items: [{ kind: 'item', id: 'role:close', label: 'Close Window', accel: 'Alt+F4', enabled: true }] }]);
  expect(b).toEqual([]);
});

test('a disabled item’s shortcut does nothing', () => {
  const b = menuBindings([{ label: 'Git', items: [{ kind: 'item', id: 'command:git-commit', label: 'Commit', accel: 'Ctrl+Alt+K', enabled: false }] }]);
  expect(pickBinding(b, key({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true }), false)).toBe(null);
});

describe('the keys of the window’s menu', () => {
  type Ev = KeyLike & { preventDefault(): void; stopPropagation(): void; prevented: boolean; stopped: boolean };
  const ev = (k: Partial<KeyLike> & { key: string; code: string }): Ev => {
    const e = { ...key(k), prevented: false, stopped: false } as Ev;
    e.preventDefault = () => { e.prevented = true; e.defaultPrevented = true; };
    e.stopPropagation = () => { e.stopped = true; };
    return e;
  };
  const setup = (terminal: boolean) => {
    const run: string[] = [];
    let opened = 0;
    const keys = menuKeys({ bindings: () => menuBindings(menus), inTerminal: () => terminal, open: () => { opened++; return true; }, invoke: (id) => run.push(id) });
    return { keys, run, opened: () => opened };
  };

  test('a terminal: matched before xterm takes the key (it stops F11 and arrows)', () => {
    const { keys, run } = setup(true);
    const e = ev({ key: 'F11', code: 'F11' });
    keys.capture(e);
    expect(run).toEqual(['role:togglefullscreen']);
    expect([e.prevented, e.stopped]).toEqual([true, true]);
    keys.bubble(e);
    expect(run).toHaveLength(1);
  });

  test('elsewhere: matched after the page, so an editor’s own keymap wins', () => {
    const { keys, run } = setup(false);
    const e = ev({ key: 'S', code: 'KeyS', ctrlKey: true });
    keys.capture(e);
    expect(run).toEqual([]);
    keys.bubble(e);
    expect(run).toEqual(['command:save']);
    const handled = ev({ key: 'S', code: 'KeyS', ctrlKey: true });
    keys.capture(handled);
    handled.preventDefault();
    keys.bubble(handled);
    expect(run).toEqual(['command:save']);
  });

  test('Alt released alone opens the menu; Alt+click, a wheel turn, leaving the window or another key do not', () => {
    const { keys, opened } = setup(false);
    keys.capture(ev({ key: 'Alt', code: 'AltLeft', altKey: true }));
    keys.up(ev({ key: 'Alt', code: 'AltLeft' }));
    expect(opened()).toBe(1);
    for (const interrupt of [() => keys.reset(), () => keys.capture(ev({ key: 'b', code: 'KeyB', altKey: true }))]) {
      keys.capture(ev({ key: 'Alt', code: 'AltLeft', altKey: true }));
      interrupt();
      keys.up(ev({ key: 'Alt', code: 'AltLeft' }));
    }
    expect(opened()).toBe(1);
  });

  test('F10 opens the menu, from a terminal too', () => {
    const { keys, opened } = setup(true);
    const e = ev({ key: 'F10', code: 'F10' });
    keys.capture(e);
    expect(opened()).toBe(1);
    expect(e.prevented).toBe(true);
  });

  test('F10 stays with a full-screen program in the focused terminal (htop, mc); elsewhere it still opens the menu', () => {
    let wants = true;
    let opened = 0;
    const keys = menuKeys({ bindings: () => menuBindings(menus), inTerminal: () => true, terminalTakesF10: () => wants, open: () => { opened++; return true; }, invoke: () => {} });
    const e = ev({ key: 'F10', code: 'F10' });
    keys.capture(e);
    keys.bubble(e);
    expect(opened).toBe(0);
    expect([e.prevented, e.stopped]).toEqual([false, false]);
    wants = false;
    keys.capture(ev({ key: 'F10', code: 'F10' }));
    expect(opened).toBe(1);
    // Outside a terminal the program's wishes do not count.
    const outside = menuKeys({ bindings: () => menuBindings(menus), inTerminal: () => false, terminalTakesF10: () => true, open: () => { opened++; return true; }, invoke: () => {} });
    outside.capture(ev({ key: 'F10', code: 'F10' }));
    expect(opened).toBe(2);
  });
});

describe('the folded menu bar (the hamburger)', () => {
  const N = 3;
  test('the hamburger unfolds the titles with no drop-down, and folds them again', () => {
    const open = reduceBar(CLOSED_BAR, { type: 'toggle' }, N);
    expect(open).toEqual({ expanded: true, open: null });
    expect(reduceBar(open, { type: 'toggle' }, N)).toEqual(CLOSED_BAR);
    expect(reduceBar({ expanded: true, open: 1 }, { type: 'toggle' }, N)).toEqual(CLOSED_BAR);
  });

  test('a title opens its drop-down; the same title again closes it and keeps the titles', () => {
    const s = reduceBar({ expanded: true, open: null }, { type: 'title', index: 2 }, N);
    expect(s).toEqual({ expanded: true, open: 2 });
    expect(reduceBar(s, { type: 'title', index: 2 }, N)).toEqual({ expanded: true, open: null });
  });

  test('hovering another title switches drop-downs only while one is open', () => {
    expect(reduceBar({ expanded: true, open: 0 }, { type: 'hover', index: 1 }, N)).toEqual({ expanded: true, open: 1 });
    const idle = { expanded: true, open: null };
    expect(reduceBar(idle, { type: 'hover', index: 1 }, N)).toBe(idle);
  });

  test('← / → in a drop-down move to the neighbouring menu, wrapping around', () => {
    expect(reduceBar({ expanded: true, open: 0 }, { type: 'step', dir: 1 }, N)).toEqual({ expanded: true, open: 1 });
    expect(reduceBar({ expanded: true, open: 0 }, { type: 'step', dir: -1 }, N)).toEqual({ expanded: true, open: 2 });
    expect(reduceBar({ expanded: true, open: 2 }, { type: 'step', dir: 1 }, N)).toEqual({ expanded: true, open: 0 });
  });

  test('Alt or F10 unfold the titles and open the first menu', () => {
    expect(reduceBar(CLOSED_BAR, { type: 'keys' }, N)).toEqual({ expanded: true, open: 0 });
    expect(reduceBar(CLOSED_BAR, { type: 'keys' }, 0)).toBe(CLOSED_BAR);
    expect(reduceBar({ expanded: true, open: null }, { type: 'keys' }, N)).toEqual({ expanded: true, open: 0 });
  });

  test('Alt or F10 with a drop-down open fold everything away, as Windows menus do', () => {
    expect(reduceBar({ expanded: true, open: 2 }, { type: 'keys' }, N)).toEqual(CLOSED_BAR);
  });

  test('a drop-down that closes folds the bar, unless the pointer is on the titles (a click on the open title)', () => {
    expect(reduceBar({ expanded: true, open: 1 }, { type: 'closed', overTitles: false }, N)).toEqual(CLOSED_BAR);
    expect(reduceBar({ expanded: true, open: 1 }, { type: 'closed', overTitles: true }, N)).toEqual({ expanded: true, open: null });
  });

  test('a drop-down closing on a folded bar never unfolds it (the window left: the bar folds first, the menu after)', () => {
    expect(reduceBar(CLOSED_BAR, { type: 'closed', overTitles: true }, N)).toBe(CLOSED_BAR);
  });

  test('a click elsewhere, Esc or leaving the window fold it', () => {
    expect(reduceBar({ expanded: true, open: null }, { type: 'dismiss' }, N)).toEqual(CLOSED_BAR);
    expect(reduceBar(CLOSED_BAR, { type: 'dismiss' }, N)).toBe(CLOSED_BAR);
  });
});

describe('the folded menu bar and the app’s one context menu', () => {
  // The store as zustand runs it: a subscriber hears each change synchronously, inside openMenu / closeMenu.
  function setup(o: { empty?: number[] } = {}) {
    let menu: { title: number } | null = null;
    let over = false;
    const bar = menuBar<{ title: number }>({
      count: () => 3,
      open: (i) => {
        if (o.empty?.includes(i)) return null;
        menu = { title: i };
        bar.storeChanged(menu);
        return menu;
      },
      close: () => { menu = null; bar.storeChanged(null); },
      current: () => menu,
      overTitles: () => over
    });
    return {
      bar,
      menu: () => menu,
      pointerOnTitles: (v: boolean) => { over = v; },
      /** Another menu takes the store's place, or the drop-down closed itself (an item chosen, Esc, a click outside). */
      storeSets: (m: { title: number } | null) => { menu = m; bar.storeChanged(m); }
    };
  }

  test('a title opens its drop-down; hovering another switches it without folding the bar', () => {
    const t = setup();
    t.bar.dispatch({ type: 'toggle' });
    t.bar.sync();
    expect(t.menu()).toBe(null);
    t.bar.dispatch({ type: 'title', index: 1 });
    t.bar.sync();
    expect(t.menu()).toEqual({ title: 1 });
    t.bar.dispatch({ type: 'hover', index: 2 });
    t.bar.sync();
    expect(t.menu()).toEqual({ title: 2 });
    expect(t.bar.state()).toEqual({ expanded: true, open: 2 });
  });

  test('the drop-down closing by itself folds the bar; with the pointer on the titles they stay', () => {
    const t = setup();
    t.bar.dispatch({ type: 'keys' });
    t.bar.sync();
    t.storeSets(null);
    expect(t.bar.state()).toEqual(CLOSED_BAR);
    t.bar.dispatch({ type: 'keys' });
    t.bar.sync();
    t.pointerOnTitles(true);
    t.storeSets(null);
    expect(t.bar.state()).toEqual({ expanded: true, open: null });
    // Another menu replacing it (a right-click elsewhere) is a close too.
    t.bar.dispatch({ type: 'title', index: 0 });
    t.bar.sync();
    t.pointerOnTitles(false);
    t.storeSets({ title: 99 });
    expect(t.bar.state()).toEqual(CLOSED_BAR);
    t.bar.sync();
    expect(t.menu()).toEqual({ title: 99 });
  });

  test('folding closes the bar’s drop-down, never another menu', () => {
    const t = setup();
    t.bar.dispatch({ type: 'title', index: 1 });
    t.bar.sync();
    t.bar.dispatch({ type: 'toggle' });
    t.bar.sync();
    expect(t.menu()).toBe(null);
    expect(t.bar.state()).toEqual(CLOSED_BAR);
  });

  test('a menu with nothing to show opens no drop-down: the titles stay, nothing points at a missing menu', () => {
    const t = setup({ empty: [2] });
    t.bar.dispatch({ type: 'title', index: 0 });
    t.bar.sync();
    t.bar.dispatch({ type: 'title', index: 2 });
    t.bar.sync();
    expect(t.bar.state()).toEqual({ expanded: true, open: null });
    expect(t.menu()).toBe(null);
  });

  test('the window’s menu changing under an open drop-down closes it (its items, its index are stale)', () => {
    const t = setup();
    t.bar.dispatch({ type: 'title', index: 1 });
    t.bar.sync();
    t.bar.menusChanged();
    t.bar.sync();
    expect(t.bar.state()).toEqual(CLOSED_BAR);
    expect(t.menu()).toBe(null);
    t.bar.dispatch({ type: 'toggle' });
    t.bar.menusChanged();
    expect(t.bar.state()).toEqual({ expanded: true, open: null });
  });

  test('Esc folds the unfolded titles and is the bar’s (a focused terminal never gets it); otherwise it is not', () => {
    const t = setup();
    expect(t.bar.escape()).toBe(false);
    t.bar.dispatch({ type: 'toggle' });
    expect(t.bar.escape()).toBe(true);
    expect(t.bar.state()).toEqual(CLOSED_BAR);
    t.bar.dispatch({ type: 'title', index: 0 });
    t.bar.sync();
    // A drop-down open: Esc is the menu's.
    expect(t.bar.escape()).toBe(false);
  });

  test('leaving the window folds the bar even when the menu closes after it, the pointer on the titles', () => {
    const t = setup();
    t.bar.dispatch({ type: 'title', index: 1 });
    t.bar.sync();
    t.pointerOnTitles(true);
    t.bar.dispatch({ type: 'dismiss' });
    t.storeSets(null);
    t.bar.sync();
    expect(t.bar.state()).toEqual(CLOSED_BAR);
  });
});

test('a title’s drop-down opens 4 px under the bar it sits on (50 px under a 46 px header)', () => {
  const anchor = titleAnchor({ left: 52, right: 94 }, 46);
  expect(anchor).toEqual({ left: 52, right: 94, bottom: 44 });
  expect(placeDropDown(anchor, 290, 300, 1400, 880).top).toBe(50);
});
