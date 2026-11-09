import { keysOf } from '../../renderer/kbd';
import { isReservedAccel } from './accelerators';

// "Your browser keeps ⌘T". Browsers never hand a page their own shortcuts (⌘T, ⌘W, ⌘N,
// ⌘1–9…): the page cannot catch them, only notice what follows. A heuristic: a ⌘ (Ctrl off a Mac) keydown, then the
// tab hidden within 600 ms (a new tab, another tab) or the window blurred after a key known to be reserved (a new
// window), and the hint shows when the visitor comes back. Chromium often delivers only the modifier, so the key is
// named when the page saw it, "that shortcut" otherwise. A blur after a lone ⌘ says nothing: that is ⌘Tab to
// another app far more often than a browser shortcut. Shown once per visit.

const WINDOW_MS = 600;
const MODIFIERS = new Set(['Meta', 'Control', 'Shift', 'Alt', 'OS']);

type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

export function reservedMessage(keys: string | null, chromium: boolean): string {
  return `Your browser keeps ${keys ?? 'that shortcut'}. Use the menu${chromium ? ', or go full screen (green light)' : ''}.`;
}

/** The accelerator a keydown is (null: a lone modifier), in the menu definition's notation. */
function accelOf(e: KeyLike, mac: boolean): string | null {
  if (MODIFIERS.has(e.key)) return null;
  const main = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const cmd = mac ? e.metaKey : e.ctrlKey;
  return [cmd && 'CmdOrCtrl', mac && e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', main].filter(Boolean).join('+');
}

/** How the visitor reads the shortcut: the app's symbols on a Mac, Ctrl+W elsewhere. */
const label = (accel: string, mac: boolean) => (mac ? keysOf(accel) : accel.replace('CmdOrCtrl', 'Ctrl'));

export interface ReservedWatcher {
  keydown(e: KeyLike): void;
  /** The page lost the visitor: the tab hidden, or the window blurred. */
  left(how: 'hidden' | 'blur'): void;
  /** Back: the hint to show, or null. */
  back(): string | null;
}

export function createReservedWatcher(o: { mac: boolean; chromium: boolean; now: () => number }): ReservedWatcher {
  let last: { at: number; accel: string | null } | null = null;
  let pending: { keys: string | null } | null = null;
  let shown = false;
  return {
    keydown(e) {
      const mod = o.mac ? e.metaKey : e.ctrlKey;
      // ⌃Tab / ⌃⇧Tab switch tabs on a Mac as well.
      const ctrlTab = e.ctrlKey && e.key === 'Tab';
      if (!mod && !ctrlTab) { last = null; return; }
      last = { at: o.now(), accel: accelOf(e, o.mac) };
    },
    left(how) {
      if (!last || shown || o.now() - last.at > WINDOW_MS) return;
      const known = last.accel !== null;
      if (known && !isReservedAccel(last.accel!)) return;
      if (how === 'blur' && !known) return;
      pending = { keys: known ? label(last.accel!, o.mac) : null };
      last = null;
    },
    back() {
      if (!pending || shown) return null;
      shown = true;
      const msg = reservedMessage(pending.keys, o.chromium);
      pending = null;
      return msg;
    }
  };
}
