import type { Settings } from '@shared/settings';

// Hold / tap / Esc (Wispr Flow style): holding the shortcut records until it is released; a short tap
// (< 300 ms) switches to hands-free, until the next tap. Esc cancels. If the window loses focus while the key
// is held, the release would never arrive: it stops there. Enter while listening stops and transcribes (the message
// is not there yet: it is sent with Enter afterwards).

export type KeyState = 'idle' | 'holding' | 'handsfree' | 'busy';
export type KeyEventKind = { type: 'down' | 'up' | 'escape' | 'blur' | 'click' | 'limit' | 'enter'; at: number; downAt?: number };
export type KeyAction = 'start' | 'stop' | 'cancel' | null;

export const TAP_MS = 300;

export function onKey(s: KeyState, ev: KeyEventKind): { state: KeyState; action: KeyAction } {
  switch (s) {
    case 'idle':
      if (ev.type === 'down') return { state: 'holding', action: 'start' };
      if (ev.type === 'click') return { state: 'handsfree', action: 'start' };
      return { state: s, action: null };
    case 'holding':
      if (ev.type === 'up') return ev.at - (ev.downAt ?? ev.at) < TAP_MS ? { state: 'handsfree', action: null } : { state: 'busy', action: 'stop' };
      if (ev.type === 'escape') return { state: 'idle', action: 'cancel' };
      if (ev.type === 'blur' || ev.type === 'limit' || ev.type === 'enter') return { state: 'busy', action: 'stop' };
      return { state: s, action: null };
    case 'handsfree':
      if (ev.type === 'down' || ev.type === 'click' || ev.type === 'limit' || ev.type === 'enter') return { state: 'busy', action: 'stop' };
      if (ev.type === 'escape') return { state: 'idle', action: 'cancel' };
      return { state: s, action: null };
    case 'busy':
      return { state: s, action: null };
  }
}

/** The chosen shortcut (an extra ⇧ is allowed: it asks for the raw text). */
export function matchesShortcut(e: KeyboardEvent, shortcut: Settings['dictationShortcut']): boolean {
  if (e.metaKey) return false;
  switch (shortcut) {
    case 'alt-space': return e.code === 'Space' && e.altKey && !e.ctrlKey;
    case 'ctrl-alt-space': return e.code === 'Space' && e.altKey && e.ctrlKey;
    case 'f5': return e.code === 'F5' && !e.altKey && !e.ctrlKey;
  }
}
