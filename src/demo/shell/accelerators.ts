import { menuItems, type MenuSpecMenu } from '@shared/menu-spec';
import { matches, parseAccelerator, typedWithAltGr, type Combo, type KeyLike } from '@shared/accelerators';
import { keysOf } from '../../renderer/kbd';
import { plainLabel, type MenuEffect } from './effects';

export { matches, parseAccelerator, type Combo, type KeyLike };

// The menu's accelerators in the browser. In the app they are native-only
// (src/main/menu.ts), and the page sees a key first: Chromium hands a keydown to the renderer, and only a key the page
// did not preventDefault goes on to the menu's key equivalents (App.tsx's F1 relies on that). The demo has no native
// menu behind the page, so it puts the menu in front instead: one capture-phase keydown on its window, installed before
// the renderer's, turns each accelerator of the menu definition into the effect the menu item has, and stops the key.
// For every accelerator the outcome is the app's: none of them is a key the renderer handles and prevents, except the
// ones listed in RENDERER_OWNED (left to the renderer) and ⌘S, which an editable CodeMirror saves itself (FileView's
// Mod-s) and the menu's Save saves as the active tab: the same file, since the focused editor is the active tab. xterm
// lets ⌘ and Ctrl+Shift combinations through to the menu in the app, so taking them first changes nothing.

export interface Binding { accel: string; combo: Combo; effect: MenuEffect; reserved: boolean }

/**
 * Accelerators of the menu the renderer already handles itself: binding them too would run them twice. Each with the
 * reason (a test keeps the list honest).
 */
export const RENDERER_OWNED: readonly { accel: string; why: string }[] = [
  { accel: 'F1', why: 'App.tsx opens the palette on F1 in its own capture keydown (before xterm and the editor)' }
];

/**
 * Shortcuts browsers keep for themselves (tabs, windows, quit): a page never receives them. In the menus they carry a
 * tooltip; pressed, they may trigger the "your browser keeps it" hint. CmdOrCtrl is ⌘ on a Mac, Ctrl elsewhere.
 */
const RESERVED = ['CmdOrCtrl+W', 'CmdOrCtrl+T', 'CmdOrCtrl+N', 'CmdOrCtrl+Shift+N', 'CmdOrCtrl+Shift+W', 'CmdOrCtrl+Q',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `CmdOrCtrl+${n}`), 'Ctrl+Tab', 'Ctrl+Shift+Tab'];

export const isReservedAccel = (accel: string): boolean => RESERVED.includes(accel);

/** The reserved shortcuts as the app labels them (⌘T, ⌃Tab): the hint names one of these. */
export const reservedKeys = (_mac: boolean): string[] => RESERVED.map(keysOf);

/** Every accelerator of the menu definition this demo binds: commands and Mac-only actions, not the platform roles. */
export function acceleratorMap(spec: readonly MenuSpecMenu[], mac: boolean): Binding[] {
  const out: Binding[] = [];
  for (const i of menuItems(spec)) {
    // Go's workspaces, filled at build time in the app: ⌘⌥1…9 to the workspace at that place.
    // With workspaces off the page ignores them (App.tsx), as in the app where main binds them only while they are on.
    if ('dynamicItems' in i) {
      for (let n = 1; n <= 9; n++) {
        const accel = `CmdOrCtrl+Alt+${n}`;
        out.push({ accel, combo: parseAccelerator(accel, mac), effect: { kind: 'command', command: `workspace-${n - 1}` }, reserved: isReservedAccel(accel) });
      }
      continue;
    }
    if (i.when === 'development' || !('accelerator' in i) || !i.accelerator) continue;
    if (RENDERER_OWNED.some((o) => o.accel === i.accelerator)) continue;
    let effect: MenuEffect | null = null;
    if ('command' in i) effect = { kind: 'command', command: i.command };
    else if ('action' in i) effect = { kind: 'not-in-demo', what: plainLabel(i.label) };
    if (!effect) continue;
    out.push({ accel: i.accelerator, combo: parseAccelerator(i.accelerator, mac), effect, reserved: isReservedAccel(i.accelerator) });
  }
  return out;
}

export function matchBinding(bindings: readonly Binding[], e: KeyLike, mac: boolean): Binding | null {
  if (e.isComposing) return null;
  return bindings.find((b) => matches(b.combo, e) && !typedWithAltGr(b.combo, e, mac)) ?? null;
}

/** A Mac (Ctrl stays Ctrl, ⌘ is CmdOrCtrl) or not (Ctrl acts as ⌘). */
export function isMacPlatform(nav: { userAgentData?: { platform?: string }; platform?: string }): boolean {
  const p = nav.userAgentData?.platform;
  if (p) return p === 'macOS';
  return /^Mac|iPhone|iPad/.test(nav.platform ?? '');
}
