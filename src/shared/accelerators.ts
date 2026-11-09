// Menu accelerators matched in the page: the live demo has no
// native menu behind its page, and Atelier on Windows has none at all (its menu lives in the window's header), so a
// keydown is matched against the menu's accelerators here. Pure: no DOM types beyond the fields read.

/** The fields of a keydown the matcher reads. */
export interface KeyLike {
  key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean;
  getModifierState?(key: string): boolean;
  /** Set when the page already handled the key (CodeMirror's own keymap): the menu then leaves it, as macOS does. */
  defaultPrevented?: boolean;
}

export interface Combo { key: string; code: string | null; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }

const NAMED: Record<string, string> = { Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown', Tab: 'Tab', Enter: 'Enter', Esc: 'Escape', Escape: 'Escape', Space: ' ' };
const PUNCT: Record<string, string> = { ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal', '`': 'Backquote' };

/** An Electron accelerator as a key combination for this platform. */
export function parseAccelerator(accel: string, mac: boolean): Combo {
  const parts = accel.split('+');
  // '\\' and ',' are single keys; a trailing '+' would be "Plus" in Electron (the menu has none).
  const last = parts.pop() ?? '';
  const mods = new Set(parts);
  const cmdOrCtrl = mods.has('CmdOrCtrl') || mods.has('CommandOrControl');
  const meta = mods.has('Cmd') || mods.has('Command') || mods.has('Super') || (cmdOrCtrl && mac);
  const ctrl = mods.has('Ctrl') || mods.has('Control') || (cmdOrCtrl && !mac);
  const alt = mods.has('Alt') || mods.has('Option');
  const shift = mods.has('Shift');
  let key: string;
  let code: string | null;
  if (/^[A-Za-z]$/.test(last)) { key = last.toLowerCase(); code = `Key${last.toUpperCase()}`; }
  else if (/^\d$/.test(last)) { key = last; code = `Digit${last}`; }
  else if (/^F\d{1,2}$/.test(last)) { key = last; code = last; }
  else if (NAMED[last]) { key = NAMED[last]; code = /^Arrow|Tab|Enter|Escape/.test(key) ? key : 'Space'; }
  else { key = last; code = PUNCT[last] ?? null; }
  return { key, code, meta, ctrl, alt, shift };
}

const ALNUM = /^[a-z0-9]$/i;

/** Whether a keydown is this combination. A letter or digit the layout typed decides (an AZERTY Z is Z); otherwise
 *  (⌥ and ⇧ turn B into ∫ and 1 into !) the physical key does. */
export function matches(c: Combo, e: KeyLike): boolean {
  if (e.metaKey !== c.meta || e.ctrlKey !== c.ctrl || e.altKey !== c.alt || e.shiftKey !== c.shift) return false;
  if (c.key.length > 1) return e.key === c.key || (c.code !== null && e.code === c.code && !(e.key.length === 1 && ALNUM.test(e.key)));
  if (e.key.length === 1 && ALNUM.test(e.key)) return e.key.toLowerCase() === c.key;
  if (e.key === c.key) return true;
  return c.code !== null && e.code === c.code;
}

/**
 * Off a Mac, AltGr arrives as Ctrl+Alt: a Polish AltGr+S types ś, and the physical-key fallback above would read it as
 * Ctrl+Alt+S. A key with AltGraph set, or Ctrl+Alt typing a Latin letter or a symbol that is not the binding's, is
 * typing. Never on a Mac: ⌥ is not AltGr there (Firefox reports AltGraph for it), and ⌘⌥B types ∫.
 */
export function typedWithAltGr(c: Combo, e: KeyLike, mac: boolean): boolean {
  if (mac) return false;
  if (e.getModifierState?.('AltGraph')) return true;
  if (!e.ctrlKey || !e.altKey || e.key.length !== 1 || e.key.toLowerCase() === c.key) return false;
  // A Latin letter (ś on a Latin layout) or a symbol (€, @) is AltGr's; a letter of another script (Russian ы on S) is
  // that layout's own letter for the key, which Ctrl+Alt does not change: the physical key decides, as for Ctrl+S.
  // A letter of no script in particular (German AltGr+M types µ, the micro sign) is AltGr's too.
  return /\p{Script=Latin}|\p{Script=Common}/u.test(e.key) || !/\p{L}/u.test(e.key);
}


const US_SHIFTED: Record<string, string> = {
  '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '-': '_', '=': '+', '`': '~',
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')'
};
const PUNCT_BY_CODE: Record<string, string> = Object.fromEntries(Object.entries(PUNCT).map(([k, c]) => [c, k]));
const NUMPAD: Record<string, string> = { NumpadDecimal: '.', NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/' };

/** What a physical key gives on a US layout, plain and with Shift (none for a key that types nothing). */
function usKeys(code: string): string[] {
  const plain = /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase()
    : /^(Digit|Numpad)\d$/.test(code) ? code.slice(-1)
      : code === 'Space' ? ' ' : PUNCT_BY_CODE[code] ?? NUMPAD[code] ?? '';
  return plain ? [plain, US_SHIFTED[plain] ?? plain.toUpperCase()] : [];
}

/**
 * Off a Mac, whether a Ctrl+Alt keydown types a character through AltGr, whatever the bindings: Italian AltGr+è types
 * [, German AltGr+ß \, Polish AltGr+S ś. A key with AltGraph set types; without it (AltGr made of left Ctrl+Alt), a
 * key giving what it gives on a US layout (Ctrl+Alt+[ there types nothing: a shortcut) does not, and otherwise the
 * rule of typedWithAltGr decides. Never on a Mac.
 */
export function typesWithAltGr(e: KeyLike, mac: boolean): boolean {
  if (mac || !e.ctrlKey || !e.altKey || e.metaKey || [...e.key].length !== 1) return false;
  if (e.getModifierState?.('AltGraph')) return true;
  if (usKeys(e.code).includes(e.key)) return false;
  return /\p{Script=Latin}|\p{Script=Common}/u.test(e.key) || !/\p{L}/u.test(e.key);
}
