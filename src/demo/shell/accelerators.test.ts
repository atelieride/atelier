import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeBracketsKeymap } from '@codemirror/autocomplete';
import { historyKeymap } from '@codemirror/commands';
import { defaultKeys } from '../../renderer/editor/editor-keys';
import { searchKeymap } from '@codemirror/search';
import { describe, expect, test } from 'vitest';
import { MENU_SPEC, menuItems } from '@shared/menu-spec';
import { RENDERER_OWNED, acceleratorMap, isMacPlatform, matchBinding, parseAccelerator, reservedKeys, type KeyLike } from './accelerators';

const key = (k: Partial<KeyLike> & { key: string }): KeyLike =>
  ({ code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...k });

describe('parseAccelerator', () => {
  test('CmdOrCtrl is ⌘ on a Mac and Ctrl elsewhere; Cmd is always Meta; Ctrl always Control', () => {
    expect(parseAccelerator('CmdOrCtrl+K', true)).toMatchObject({ key: 'k', code: 'KeyK', meta: true, ctrl: false });
    expect(parseAccelerator('CmdOrCtrl+K', false)).toMatchObject({ key: 'k', code: 'KeyK', meta: false, ctrl: true });
    expect(parseAccelerator('Ctrl+Cmd+N', true)).toMatchObject({ key: 'n', meta: true, ctrl: true });
    expect(parseAccelerator('Ctrl+Cmd+N', false)).toMatchObject({ key: 'n', meta: true, ctrl: true });
    expect(parseAccelerator('Ctrl+Shift+G', true)).toMatchObject({ key: 'g', meta: false, ctrl: true, shift: true });
  });

  test('digits, punctuation and named keys get their physical code', () => {
    expect(parseAccelerator('CmdOrCtrl+Shift+1', true)).toMatchObject({ key: '1', code: 'Digit1', shift: true });
    expect(parseAccelerator('CmdOrCtrl+,', true)).toMatchObject({ key: ',', code: 'Comma' });
    expect(parseAccelerator('CmdOrCtrl+\\', true)).toMatchObject({ key: '\\', code: 'Backslash' });
    expect(parseAccelerator('CmdOrCtrl+Alt+Right', true)).toMatchObject({ key: 'ArrowRight', code: 'ArrowRight', alt: true });
    expect(parseAccelerator('Alt+Shift+F5', true)).toMatchObject({ key: 'F5', alt: true, shift: true, meta: false });
    expect(parseAccelerator('Ctrl+Tab', true)).toMatchObject({ key: 'Tab', ctrl: true });
  });
});

describe('acceleratorMap', () => {
  const mac = acceleratorMap(MENU_SPEC, true);
  const other = acceleratorMap(MENU_SPEC, false);
  const effectOf = (accel: string) => mac.find((b) => b.accel === accel)?.effect;

  test('every accelerated command and action of the menu is bound (hidden ones included), F1 excepted', () => {
    const expected = menuItems(MENU_SPEC).flatMap((i) => ('accelerator' in i && i.accelerator && !('role' in i) && i.when !== 'development' ? [i.accelerator] : []))
      .filter((a) => !RENDERER_OWNED.some((o) => o.accel === a));
    // Go's workspaces, filled at build time in the app: their nine keys (workspaces.ts below).
    const workspaces = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `CmdOrCtrl+Alt+${n}`);
    expect(mac.map((b) => b.accel).sort()).toEqual([...expected, ...workspaces].sort());
    expect(effectOf('CmdOrCtrl+J')).toEqual({ kind: 'command', command: 'next-attention' });
    expect(effectOf('CmdOrCtrl+Shift+P')).toEqual({ kind: 'command', command: 'open-palette' });
    expect(effectOf('CmdOrCtrl+O')).toEqual({ kind: 'not-in-demo', what: 'Open Folder' });
    expect(effectOf('Ctrl+Cmd+N')).toEqual({ kind: 'not-in-demo', what: 'New Window' });
  });

  // Workspaces: ⌘⌥1…9 go to the workspace at that place; with workspaces off the page
  // ignores them (App.tsx), as in the app, where main binds them only while they are on.
  test('Go\u2019s workspaces are bound: ⌘⌥1…9 send workspace-0…8', () => {
    for (let n = 1; n <= 9; n++) expect(effectOf(`CmdOrCtrl+Alt+${n}`)).toEqual({ kind: 'command', command: `workspace-${n - 1}` });
  });

  test('platform roles (Edit menu, Close Window) keep their keys: they stay with the browser and the focused widget', () => {
    for (const a of ['CmdOrCtrl+C', 'CmdOrCtrl+V', 'CmdOrCtrl+X', 'CmdOrCtrl+Z', 'CmdOrCtrl+A', 'CmdOrCtrl+Shift+W']) expect(effectOf(a)).toBeUndefined();
  });

  test('keys the renderer handles itself are excluded, each with its reason', () => {
    expect(RENDERER_OWNED.map((o) => o.accel)).toEqual(['F1']);
    for (const o of RENDERER_OWNED) expect(o.why).toMatch(/App\.tsx/);
    expect(effectOf('F1')).toBeUndefined();
  });

  // accelerators.ts explains why taking the menu's keys before the renderer gives the app's outcome: the renderer's
  // editor keys meet them only at ⌘S (the editor's save and the menu's Save save the same file). A new collision must
  // be decided there (RENDERER_OWNED, or a reason), not discovered in the demo.
  test("the editor's keys (CodeMirror's keymaps, the renderer's own) meet the menu's accelerators only at ⌘S", () => {
    // CodeMirror's 'Mod-Shift-z' and Electron's 'CmdOrCtrl+Shift+Z' as the same sorted key list.
    const norm = (k: string) => k.split(/-(?!$)/).map((p) => (p === 'Mod' ? 'CmdOrCtrl' : p.length === 1 ? p.toUpperCase() : p.replace(/^Arrow/, ''))).sort().join('+');
    const dir = 'src/renderer';
    const own = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
      .flatMap((f) => [...readFileSync(join(dir, f), 'utf8').matchAll(/key: '((?:Mod|Alt|Shift|Ctrl)-[^']+)'/g)].map((m) => m[1]!));
    expect(own).toContain('Mod-s');
    // The editors' default keymap as the renderer has it on a Mac, whose ⌘ keys these are: without Mod-i, the menu's ⌘I
    // (Ask About This Session). Elsewhere the app's Ask is Ctrl+Shift+I and the editor keeps Ctrl+I.
    const editor = new Set([...own, ...[...defaultKeys(true), ...historyKeymap, ...searchKeymap, ...closeBracketsKeymap].flatMap((b) => [b.key, b.mac].filter((k): k is string => !!k))].map(norm));
    const accels = menuItems(MENU_SPEC).flatMap((i) => ('accelerator' in i && i.accelerator && !('role' in i) ? [i.accelerator] : []));
    expect(accels.filter((a) => editor.has(a.split('+').sort().join('+')))).toEqual(['CmdOrCtrl+S']);
  });

  test('no two bindings share a key combination, on a Mac or elsewhere', () => {
    for (const map of [mac, other]) {
      const sig = map.map((b) => JSON.stringify(b.combo));
      expect(new Set(sig).size).toBe(sig.length);
    }
  });

  test('the browser-reserved shortcuts are marked', () => {
    const reserved = mac.filter((b) => b.reserved).map((b) => b.accel).sort();
    expect(reserved).toEqual(['Ctrl+Shift+Tab', 'Ctrl+Tab', 'CmdOrCtrl+Shift+N', 'CmdOrCtrl+N', 'CmdOrCtrl+T', 'CmdOrCtrl+W', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `CmdOrCtrl+${n}`)].sort());
    expect(reservedKeys(true)).toEqual(expect.arrayContaining(['⌘W', '⌘T', '⌘N', '⌘⇧N', '⌘⇧W', '⌘Q', '⌘1', '⌘9', '⌃Tab']));
  });
});

describe('matchBinding', () => {
  const mac = acceleratorMap(MENU_SPEC, true);
  const other = acceleratorMap(MENU_SPEC, false);
  const cmd = (m: typeof mac, k: KeyLike) => { const e = matchBinding(m, k, m === mac)?.effect; return e?.kind === 'command' ? e.command : e?.kind ?? null; };

  test('⌘J, ⌘K, ⌘\\ and ⌘⇧M on a Mac; Ctrl elsewhere', () => {
    expect(cmd(mac, key({ key: 'j', code: 'KeyJ', metaKey: true }))).toBe('next-attention');
    expect(cmd(mac, key({ key: 'k', code: 'KeyK', metaKey: true }))).toBe('open-palette');
    expect(cmd(mac, key({ key: '\\', code: 'Backslash', metaKey: true }))).toBe('split-right');
    expect(cmd(mac, key({ key: 'M', code: 'KeyM', metaKey: true, shiftKey: true }))).toBe('toggle-changes');
    expect(cmd(other, key({ key: 'j', code: 'KeyJ', ctrlKey: true }))).toBe('next-attention');
    expect(cmd(other, key({ key: 'j', code: 'KeyJ', metaKey: true }))).toBeNull();
    expect(cmd(mac, key({ key: 'j', code: 'KeyJ', ctrlKey: true }))).toBeNull();
  });

  // Ask: ⌘I is the menu's Ask About This Session, a key no browser keeps from a page.
  test('⌘I asks about the session (Ctrl+I elsewhere); not a browser-reserved key; ⌘⇧I is not it', () => {
    expect(cmd(mac, key({ key: 'i', code: 'KeyI', metaKey: true }))).toBe('ask-session');
    expect(cmd(other, key({ key: 'i', code: 'KeyI', ctrlKey: true }))).toBe('ask-session');
    expect(cmd(mac, key({ key: 'I', code: 'KeyI', metaKey: true, shiftKey: true }))).toBeNull();
    expect(mac.find((b) => b.accel === 'CmdOrCtrl+I')).toMatchObject({ reserved: false, effect: { kind: 'command', command: 'ask-session' } });
  });

  test('⌥ and ⇧ change e.key (∫, !): the physical key decides then', () => {
    expect(cmd(mac, key({ key: '∫', code: 'KeyB', metaKey: true, altKey: true }))).toBe('show-background');
    expect(cmd(mac, key({ key: '!', code: 'Digit1', metaKey: true, shiftKey: true }))).toBe('view-sessions');
    expect(cmd(mac, key({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }))).toBe('view-docker');
    expect(cmd(mac, key({ key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true }))).toBe('view-redis');
    expect(cmd(mac, key({ key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true }))).toBe('view-databases');
    expect(cmd(mac, key({ key: 'ArrowRight', code: 'ArrowRight', metaKey: true, altKey: true }))).toBe('focus-next-pane');
    expect(cmd(mac, key({ key: 'F5', code: 'F5', altKey: true }))).toBe('next-change');
  });

  test('a letter typed on another layout follows the letter, not the position (AZERTY: Z where QWERTY has W)', () => {
    expect(cmd(mac, key({ key: 'z', code: 'KeyW', metaKey: true }))).toBeNull();
    expect(cmd(mac, key({ key: 'w', code: 'KeyZ', metaKey: true }))).toBe('close-tab');
  });

  test('modifiers must match exactly; F1, plain keys and composition never match', () => {
    expect(cmd(mac, key({ key: 'k', code: 'KeyK', metaKey: true, shiftKey: true }))).toBeNull();
    expect(cmd(mac, key({ key: 'F1', code: 'F1' }))).toBeNull();
    expect(cmd(mac, key({ key: 'j', code: 'KeyJ' }))).toBeNull();
    expect(cmd(mac, key({ key: 'j', code: 'KeyJ', metaKey: true, isComposing: true }))).toBeNull();
    expect(cmd(mac, key({ key: 'c', code: 'KeyC', metaKey: true }))).toBeNull();
  });
});

// Off-Mac, AltGr arrives as Ctrl+Alt (Windows) with AltGraph set: on a Polish layout AltGr+S types ś, AltGr+C ć,
// AltGr+N ń, AltGr+O ó. Those are characters, never the menu's Ctrl+Alt accelerators (Save All, Comment on Selection,
// New File, Open File).
describe('matchBinding off-Mac: AltGr types characters', () => {
  const other = acceleratorMap(MENU_SPEC, false);
  const mac = acceleratorMap(MENU_SPEC, true);
  const altGr = (k: string, code: string, altGraph = true): KeyLike =>
    ({ ...key({ key: k, code, ctrlKey: true, altKey: true }), getModifierState: (m: string) => altGraph && m === 'AltGraph' });

  test.each([['ś', 'KeyS'], ['ć', 'KeyC'], ['ń', 'KeyN'], ['ó', 'KeyO'], ['ł', 'KeyL'], ['ż', 'KeyZ']])('Polish AltGr %s (%s) is typed, not a command', (k, code) => {
    expect(matchBinding(other, altGr(k, code), false)).toBeNull();
    // Even when the browser does not report AltGraph: Ctrl+Alt printing another character is AltGr.
    expect(matchBinding(other, altGr(k, code, false), false)).toBeNull();
  });

  test('a real Ctrl+Alt accelerator still works off-Mac (the key typed is the binding\'s, or a named key)', () => {
    const cmd = (k: KeyLike) => { const e = matchBinding(other, k, false)?.effect; return e?.kind === 'command' ? e.command : null; };
    expect(cmd(key({ key: 's', code: 'KeyS', ctrlKey: true, altKey: true }))).toBe('save-all');
    expect(cmd(key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, altKey: true }))).toBe('focus-next-pane');
    // A layout of another script types its own letter on the key with Ctrl+Alt (Russian: ы on S): no AltGr, the
    // physical key decides, as for Ctrl+S.
    expect(cmd(key({ key: 'ы', code: 'KeyS', ctrlKey: true, altKey: true }))).toBe('save-all');
    // AltGr symbols are typed too (German AltGr+Q: @, AltGr+E: €).
    expect(cmd(key({ key: '€', code: 'KeyE', ctrlKey: true, altKey: true }))).toBeNull();
  });

  test('on a Mac, ⌥ is never AltGr (Firefox reports AltGraph for ⌥): ⌘⌥B and ⌘⌥S still match', () => {
    const cmd = (k: KeyLike) => { const e = matchBinding(mac, k, true)?.effect; return e?.kind === 'command' ? e.command : null; };
    const opt = (k: string, code: string): KeyLike => ({ ...key({ key: k, code, metaKey: true, altKey: true }), getModifierState: (m: string) => m === 'AltGraph' });
    expect(cmd(opt('∫', 'KeyB'))).toBe('show-background');
    expect(cmd(opt('ß', 'KeyS'))).toBe('save-all');
  });
});

describe('isMacPlatform', () => {
  test('userAgentData first, then navigator.platform', () => {
    expect(isMacPlatform({ userAgentData: { platform: 'macOS' }, platform: '' })).toBe(true);
    expect(isMacPlatform({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })).toBe(false);
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isMacPlatform({ platform: 'Win32' })).toBe(false);
    expect(isMacPlatform({ platform: 'Linux x86_64' })).toBe(false);
  });
});
