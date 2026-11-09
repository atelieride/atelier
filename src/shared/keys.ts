// Key labels and the main modifier for both platforms. macOS keeps the glyphs the app has
// always shown, in the accelerator's own order (⌘⇧N, ⌘⌥S, ⌃⌘N: the rest of the app writes them that way); Windows
// and Linux get Ctrl+Shift+N text. Pure: no DOM types (it compiles for main and the renderer alike).
import { currentPlatform, type Platform } from './platform';

const MAC_MOD: Record<string, string> = { CmdOrCtrl: '⌘', Cmd: '⌘', Ctrl: '⌃', Shift: '⇧', Alt: '⌥', Option: '⌥' };
const MAC_KEY: Record<string, string> = { Left: '←', Right: '→', Up: '↑', Down: '↓', Enter: '⏎', Return: '⏎' };
const PC_MOD: Record<string, string> = { CmdOrCtrl: 'Ctrl', Cmd: 'Win', Ctrl: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Option: 'Alt' };
const PC_KEY: Record<string, string> = { ...MAC_KEY, Enter: 'Enter', Return: 'Enter' };

/** An Electron accelerator as the platform shows it. `+` as a key (CmdOrCtrl+Plus) is not in the menu; `,` is. */
export function formatAccelerator(accel: string, platform: Platform = currentPlatform()): string {
  const parts = accel.split('+');
  const last = parts.length - 1;
  if (platform === 'darwin') return parts.map((p, i) => (i < last ? MAC_MOD[p] ?? p : MAC_KEY[p] ?? p)).join('');
  return parts.map((p, i) => (i < last ? PC_MOD[p] ?? p : PC_KEY[p] ?? p)).join('+');
}

/**
 * Windows conventions and macOS-only keys. null: no shortcut
 * on Windows (New Window: menu only; Services: hidden there).
 */
const WINDOWS_OVERRIDES: Record<string, string | null> = {
  'Ctrl+Cmd+N': null,
  // Move Tab to Left/Right Pane: Ctrl+Win+arrows switch virtual desktops.
  'Ctrl+Cmd+Left': 'Ctrl+Alt+Shift+Left',
  'Ctrl+Cmd+Right': 'Ctrl+Alt+Shift+Right',
  'CmdOrCtrl+Shift+3': null,
  'CmdOrCtrl+Shift+W': 'Alt+F4',
  'CmdOrCtrl+Shift+P': 'Ctrl+Shift+P',
  'CmdOrCtrl+Alt+R': 'Shift+Alt+R',
  // Saves where it saves (an editor, a preview); in a terminal the terminal-first rule leaves Ctrl+S to it.
  'CmdOrCtrl+S': 'Ctrl+S',
  // Sidebar: Ctrl+Shift+B, where the rule puts ⌘B, is Databases' (⌃⇧B).
  'CmdOrCtrl+B': 'Shift+Alt+B'
};

/**
 * A macOS accelerator as Windows has it. In a terminal Ctrl+letter belongs to the program (Claude Code, the shell), so
 * ⌘X → Ctrl+Shift+X, ⌘⌥X → Ctrl+Alt+X, ⌘⇧X → Shift+Alt+X; keys no terminal program receives keep Ctrl alone (digits,
 * comma); literal Ctrl, Alt and F-key shortcuts stay as they are.
 */
export function windowsAccelerator(mac: string): string | null {
  if (mac in WINDOWS_OVERRIDES) return WINDOWS_OVERRIDES[mac]!;
  const parts = mac.split('+');
  const key = parts.pop()!;
  const mods = new Set(parts);
  if (!mods.has('CmdOrCtrl') && !mods.has('Cmd')) return mac;
  const alt = mods.has('Alt');
  const shift = mods.has('Shift');
  if (/^\d$/.test(key) || key === ',') return ['Ctrl', ...(alt ? ['Alt'] : []), ...(shift ? ['Shift'] : []), key].join('+');
  if (alt && shift) return `Ctrl+Alt+Shift+${key}`;
  if (alt) return `Ctrl+Alt+${key}`;
  if (shift) return `Shift+Alt+${key}`;
  return `Ctrl+Shift+${key}`;
}

/** A menu accelerator (written for macOS) on a platform; null: none there. */
export function acceleratorFor(mac: string, platform: Platform = currentPlatform()): string | null {
  return platform === 'win32' ? windowsAccelerator(mac) : mac;
}

/** The app's main modifier is down: ⌘ on macOS, Ctrl elsewhere. */
export function isMod(e: { metaKey: boolean; ctrlKey: boolean }, platform: Platform = currentPlatform()): boolean {
  return platform === 'darwin' ? e.metaKey : e.ctrlKey;
}

/** The other one is down: Ctrl on macOS, the Windows key elsewhere (shortcuts with the main modifier refuse it). */
export function isOtherMod(e: { metaKey: boolean; ctrlKey: boolean }, platform: Platform = currentPlatform()): boolean {
  return platform === 'darwin' ? e.ctrlKey : e.metaKey;
}

/**
 * Ctrl+Shift+G, the menu's Source Control on every platform (⌃⇧G on macOS): a pane's own G keys (find next and
 * previous, Go to row) leave it to the menu, which matches it after the page. ⌘⇧G stays theirs on macOS.
 */
export function isSourceControlKey(e: { key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key.toLowerCase() === 'g' || e.code === 'KeyG');
}

/** A key the input method is composing with (Enter picks a candidate, Esc drops it): never a command of the page. */
export function isImeComposing(e: { isComposing: boolean; keyCode: number }): boolean {
  return e.isComposing || e.keyCode === 229;
}
