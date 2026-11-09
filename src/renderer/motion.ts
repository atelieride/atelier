import { useRef } from 'react';

// Idle motion budget: at rest nothing moves. Attention cues are finite
// (--cue-cycles in theme.css); these are the only animations allowed to loop, each bounded by a visible operation or
// an open surface. They stop (animation: none, their rest state) while the window is inactive (layout.css).
export const LASTING_MOTION: readonly { selector: string; reason: string }[] = [
  { selector: '.hv-fetch.is-running .hv-fetch-icon', reason: 'a Source Control fetch in progress' },
  { selector: '.scm-fetch-btn.is-running svg', reason: 'a Source Control fetch in progress' },
  { selector: '.is-listening .dp-mic', reason: 'an open dictation' },
  { selector: '.dp-spinner', reason: 'a transcription in progress' },
  { selector: '.git-spin', reason: 'a git write (commit, push…) in progress' },
  { selector: '.tp-cursor.is-blink', reason: 'Settings is open (cursor preview)' },
  { selector: '.upd-card.tone-busy .upd-dot', reason: 'an update download in progress' },
  { selector: '.conn-details.tone-busy .conn-dot', reason: 'a connector connecting' },
  { selector: '.bgv-line.is-live .log-text::after', reason: 'a live log open in the Background view' },
  { selector: '.dk-spin', reason: 'the Docker or Redis view open, waiting for the engine or its first probe' },
  { selector: '.confirm-progress i', reason: 'quitting asked while a git write runs' },
  { selector: '.cxu-spin', reason: 'a Context usage analysis in progress' }
];

/** A key that moves only when `count` rises: a cue keyed on it replays for each arrival, never for a departure. */
export function nextRisingKey(prev: { count: number; key: number }, count: number): { count: number; key: number } {
  return { count, key: count > prev.count ? prev.key + 1 : prev.key };
}

/** `nextRisingKey` across renders (the footer's and the activity bar's waiting dots). */
export function useRisingKey(count: number): number {
  const last = useRef({ count: 0, key: 0 });
  last.current = nextRisingKey(last.current, count);
  return last.current.key;
}

export type WindowActivity = 'active' | 'inactive';
interface WinLike {
  addEventListener(type: 'focus' | 'blur', fn: () => void): void;
  removeEventListener(type: 'focus' | 'blur', fn: () => void): void;
}
interface RootLike { dataset: Record<string, string | undefined> }

/** Keeps `data-window` on the root in step with the window's focus (lasting motion stops while inactive). */
export function trackWindowActivity(win: WinLike, root: RootLike, focused: boolean): () => void {
  const set = (a: WindowActivity) => { root.dataset.window = a; };
  const on = () => set('active');
  const off = () => set('inactive');
  set(focused ? 'active' : 'inactive');
  win.addEventListener('focus', on);
  win.addEventListener('blur', off);
  return () => { win.removeEventListener('focus', on); win.removeEventListener('blur', off); };
}
