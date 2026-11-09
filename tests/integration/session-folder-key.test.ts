import { describe, expect, test } from 'vitest';
import type { KeyBinding } from '@codemirror/view';
import { defaultKeymap, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { foldKeymap } from '@codemirror/language';
import { closeBracketsKeymap } from '@codemirror/autocomplete';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { acceleratorFor, formatAccelerator, windowsAccelerator } from '@shared/keys';
import { MENU_SPEC, NO_MENU_STATE, menuItems } from '@shared/menu-spec';
import { windowsMenu, type WinMenuItem } from '@shared/windows-menu';
import { parseAccelerator, typedWithAltGr, type Combo } from '@shared/accelerators';
import type { Platform } from '@shared/platform';
import { buildShortcuts } from '../../src/renderer/shortcuts';

// New Session in Folder…: ⌘⌥⇧N on macOS, Ctrl+Alt+Shift+N on Windows, a key
// nothing else uses — not the app's menu, not Settings › Keyboard, not the editor, not the system.

const MAC_KEY = 'CmdOrCtrl+Alt+Shift+N';
const same = (a: Combo, b: Combo) => a.key === b.key && a.meta === b.meta && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift;

/**
 * Keys the system keeps for itself (they never reach an app, or do something system-wide first). macOS: Apple's
 * "Mac keyboard shortcuts" (support.apple.com/102650) and the defaults of System Settings › Keyboard › Shortcuts, plus
 * the menu roles Electron fills in (Hide, Quit, Minimize, Edit, Full Screen). Windows: "Keyboard shortcuts in Windows"
 * (support.microsoft.com/12445) — any Win key combination (the Office key is Ctrl+Alt+Shift+Win) is the system's.
 */
const RESERVED: Record<Platform, string[]> = {
  darwin: [
    'Cmd+Shift+3', 'Cmd+Shift+4', 'Cmd+Shift+5', 'Cmd+Space', 'Cmd+Alt+Space', 'Ctrl+Space', 'Ctrl+Alt+Space',
    'Cmd+Alt+Esc', 'Cmd+Alt+Shift+Esc', 'Ctrl+Cmd+Q', 'Cmd+Shift+Q', 'Cmd+Alt+Shift+Q', 'Ctrl+Cmd+Space', 'Cmd+Alt+D',
    'Cmd+Tab', 'Cmd+Shift+Tab', 'Cmd+`', 'Cmd+H', 'Cmd+Alt+H', 'Cmd+M', 'Cmd+Alt+M', 'Cmd+Q', 'Ctrl+Cmd+F', 'Cmd+Shift+/',
    'Ctrl+Up', 'Ctrl+Down', 'Ctrl+Left', 'Ctrl+Right', 'Ctrl+F2', 'Ctrl+F3', 'Ctrl+Cmd+D', 'Cmd+Alt+F5',
    'Cmd+Z', 'Cmd+Shift+Z', 'Cmd+X', 'Cmd+C', 'Cmd+V', 'Cmd+A', 'Cmd+Alt+Shift+V'
  ],
  win32: [
    'Ctrl+Alt+Delete', 'Ctrl+Shift+Esc', 'Ctrl+Esc', 'Alt+Tab', 'Alt+Shift+Tab', 'Ctrl+Alt+Tab', 'Alt+Esc', 'Alt+F4',
    'Alt+Space', 'Ctrl+Alt+Up', 'Ctrl+Alt+Down', 'Ctrl+Alt+Left', 'Ctrl+Alt+Right', 'Alt+PrintScreen', 'PrintScreen',
    'Ctrl+Shift+Space'
  ],
  linux: []
};

/** Every keyed item of the menu on this platform, with what it does. */
function menuKeys(p: Platform): { id: string; accel: string }[] {
  if (p === 'darwin') {
    return menuItems(MENU_SPEC).flatMap((i) => ('accelerator' in i && i.accelerator
      ? [{ id: 'command' in i ? `command:${i.command}` : 'action' in i ? `action:${i.action}` : `role:${i.role}`, accel: i.accelerator }]
      : []));
  }
  const every = Object.fromEntries(Object.keys(NO_MENU_STATE).map((k) => [k, true])) as unknown as typeof NO_MENU_STATE;
  const out: { id: string; accel: string }[] = [];
  const walk = (items: readonly WinMenuItem[]) => {
    for (const i of items) {
      if (i.kind === 'item' && i.accel) out.push({ id: i.id, accel: i.accel });
      else if (i.kind === 'submenu') walk(i.items);
    }
  };
  for (const m of windowsMenu(MENU_SPEC, { profiles: [], accounts: [], state: every, isPackaged: false })) walk(m.items);
  return out;
}

/** A CodeMirror binding's keys on this platform as combos (its `shift` variant too). */
function bindingCombos(b: KeyBinding, mac: boolean): Combo[] {
  const name = (mac ? b.mac : b.win) ?? b.key;
  if (!name) return [];
  const one = (n: string): Combo => {
    const parts = n.split(/-(?!$)/);
    const key = parts.pop()!.toLowerCase();
    const c: Combo = { key, code: null, meta: false, ctrl: false, alt: false, shift: false };
    for (const m of parts) {
      if (m === 'Mod') { if (mac) c.meta = true; else c.ctrl = true; }
      else if (/^(Cmd|Meta|m)$/.test(m)) c.meta = true;
      else if (/^(Ctrl|Control|c)$/.test(m)) c.ctrl = true;
      else if (/^(Alt|a)$/.test(m)) c.alt = true;
      else if (/^(Shift|s)$/.test(m)) c.shift = true;
    }
    return c;
  };
  const base = one(name);
  return b.shift ? [base, { ...base, shift: true }] : [base];
}

/** Every renderer source file, for keys bound inline (a `keymap.of([{ key: 'Mod-…' }])` in a component). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

describe.each(['darwin', 'win32'] as const)('New Session in Folder… on %s', (p) => {
  const mac = p === 'darwin';
  const accel = acceleratorFor(MAC_KEY, p)!;
  const combo = parseAccelerator(accel, mac);

  test('the menu: exactly one item takes it, and no key is on two items', () => {
    const keys = menuKeys(p);
    const on = keys.filter((k) => same(parseAccelerator(k.accel, mac), combo));
    expect(on.map((k) => k.id)).toEqual(['command:new-session-in-folder']);
    const seen = new Map<string, string>();
    for (const k of keys) {
      const c = parseAccelerator(k.accel, mac);
      const id = `${c.meta}${c.ctrl}${c.alt}${c.shift}:${c.key}`;
      expect(seen.get(id), `${k.accel}: ${k.id} and ${seen.get(id)}`).toBeUndefined();
      seen.set(id, k.id);
    }
  });

  test('Settings › Keyboard: one row shows it', () => {
    const rows = buildShortcuts(p).flatMap((g) => g.items);
    const shown = formatAccelerator(accel, p);
    expect(rows.filter((r) => r.keys === shown || r.keys.split(' ').includes(shown))).toEqual([{ keys: shown, label: 'New session in a folder' }]);
  });

  test('the editor binds nothing on it', () => {
    const maps: readonly KeyBinding[][] = [[...defaultKeymap], [...historyKeymap], [...searchKeymap], [...foldKeymap], [...closeBracketsKeymap]];
    for (const b of maps.flat()) for (const c of bindingCombos(b, mac)) expect(same(c, combo), `${b.key ?? b.mac ?? b.win}`).toBe(false);
    // Atelier's own bindings, written inline across the renderer.
    for (const file of sources('src/renderer')) {
      // `key`, `mac` or `win`, quoted either way.
      for (const m of readFileSync(file, 'utf8').matchAll(/\b(key|mac|win):\s*['"]([^'"]+)['"]/g)) {
        if (!/^(Mod|Cmd|Ctrl|Alt|Shift|Meta)-/.test(m[2]!)) continue;
        expect(same(bindingCombos({ key: m[2]! }, mac)[0]!, combo), `${file}: ${m[2]}`).toBe(false);
      }
    }
  });

  test('not a key the system keeps', () => {
    for (const r of RESERVED[p]) expect(same(parseAccelerator(r, mac), combo), r).toBe(false);
    // Any Win key combination is Windows' own; ours has none.
    expect(accel).not.toMatch(/Super|Meta|Win/);
  });

  test.runIf(p === 'win32')('Windows terminals hand it to the app; AltGr typing is never the shortcut', () => {
    expect(windowsAccelerator(MAC_KEY)).toBe('Ctrl+Alt+Shift+N');
    // The terminal-first rule: Ctrl+letter and Ctrl+Shift+C/V belong to the terminal.
    expect(/^Ctrl\+[A-Z]$/.test(accel)).toBe(false);
    expect(['Ctrl+Shift+C', 'Ctrl+Shift+V']).not.toContain(accel);
    // Polish AltGr+Shift+N types Ń: typing, not the shortcut (the known limit); AltGraph set: typing too.
    const keydown = { key: 'Ń', code: 'KeyN', metaKey: false, ctrlKey: true, altKey: true, shiftKey: true, isComposing: false };
    expect(typedWithAltGr(combo, keydown, false)).toBe(true);
    expect(typedWithAltGr(combo, { ...keydown, key: 'N', getModifierState: (k: string) => k === 'AltGraph' }, false)).toBe(true);
    // The real key, on a layout where AltGr+Shift+N types nothing: the shortcut.
    expect(typedWithAltGr(combo, { ...keydown, key: 'N' }, false)).toBe(false);
  });
});
