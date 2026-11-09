import { formatAccelerator, windowsAccelerator } from '@shared/keys';
import { MENU_SPEC, menuItems } from '@shared/menu-spec';
import { currentPlatform, type Platform } from '@shared/platform';

// Shortcut labels are written in the code as macOS shows them (⌘⇧N, ⌥-click): kbd() shows each as this platform has
// it. On Windows a menu shortcut takes the Windows keymap (⌘W → Ctrl+Shift+W), any
// other key — inside a panel, an editor, the palette — takes Ctrl for ⌘ (what isMod and CodeMirror's Mod do there).

/** From an Electron accelerator to macOS symbols, in the order used in the rest of the app (⌘⇧N, ⌘⌥→). */
export const keysOf = (accel: string): string => formatAccelerator(accel, 'darwin');

const MOD: Record<string, string> = { '⌘': 'CmdOrCtrl', '⌥': 'Alt', '⇧': 'Shift', '⌃': 'Ctrl' };
const KEY: Record<string, string> = { '↑': 'Up', '↓': 'Down', '←': 'Left', '→': 'Right', '↩': 'Enter', '⏎': 'Enter', '↵': 'Enter', '⌫': 'Backspace' };
const ORDER = ['CmdOrCtrl', 'Ctrl', 'Alt', 'Shift'];

/** Every accelerator of the menu (written for macOS). */
const MENU_ACCELS = new Set(menuItems(MENU_SPEC).flatMap((i) => ('accelerator' in i && i.accelerator ? [i.accelerator] : [])));

/** A macOS label as an Electron accelerator ('⇧⌘V' → 'CmdOrCtrl+Shift+V'), the key last; a click suffix kept. */
function parse(label: string): { accel: string; click: string | null } {
  const click = /-((?:right-)?click)$/.exec(label)?.[1] ?? null;
  let rest = click ? label.slice(0, -(click.length + 1)) : label;
  const mods = new Set<string>();
  while (rest && MOD[rest[0]!]) { mods.add(MOD[rest[0]!]!); rest = rest.slice(1); }
  // ⌃ with ⌘ is the menu's literal Ctrl+Cmd (⌃⌘N New Window, ⌃⌘←/→ Move Tab to Left/Right Pane).
  const parts = mods.has('Ctrl') && mods.has('CmdOrCtrl') ? ['Ctrl', 'Cmd', ...ORDER.slice(2).filter((m) => mods.has(m))] : ORDER.filter((m) => mods.has(m));
  return { accel: [...parts, ...(rest ? [KEY[rest] ?? rest] : [])].join('+'), click };
}

/** A shortcut label for this platform; '' when Windows has none (Services: hidden there). */
export function kbd(label: string, platform: Platform = currentPlatform()): string {
  if (platform === 'darwin') return label;
  const { accel, click } = parse(label);
  if (click) return `${formatAccelerator(`${accel}+X`, 'win32').replace(/\+X$/, '')}+${click}`;
  if (MENU_ACCELS.has(accel)) {
    const win = windowsAccelerator(accel);
    return win ? formatAccelerator(win, 'win32') : '';
  }
  return formatAccelerator(accel, 'win32');
}

/**
 * One label in running text (⌘⇧1, ⌥-click, ⌘1…9…): what kbd() reads. A bare Return glyph too: "⏎ ⇧⏎" reads
 * "Enter Shift+Enter" on Windows, never half glyph, half words.
 */
const TOKEN = /[⌘⌥⇧⌃]+(?:Space|Tab|F\d+|-click|-right-click|1…9|[A-Za-z0-9]|[↑↓←→↵⏎↩[\],/\\])?|[↵⏎↩]/g;

/** Every label in a text, each as this platform has it. */
export function kbdText(text: string, platform: Platform = currentPlatform()): string {
  return platform === 'darwin' ? text : text.replace(TOKEN, (k) => kbd(k, platform));
}
