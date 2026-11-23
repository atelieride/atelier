import { useRef, useState } from 'react';

/** The script animations' curves, as WAAPI takes them: --ease (theme.css), a soft spring, an elastic one, an in-out. */
export const EASE = 'cubic-bezier(.2,.8,.2,1)';
export const SOFT_SPRING = 'cubic-bezier(.3,1.3,.5,1)';
export const ELASTIC = 'cubic-bezier(.3,1.7,.45,1)';
export const IN_OUT = 'cubic-bezier(.7,0,.2,1)';

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

/** Settings › Reduce motion, or the system's. */
export function reducedMotion(): boolean {
  if (document.documentElement.dataset.motion === 'reduced') return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Every script animation goes through here: none under Reduce motion (null), and nothing held once it ends (fill
 * 'none' unless asked, so an element at rest shows its own style, never a leftover transform).
 */
export function play(el: Element, kf: Keyframe[], o: KeyframeAnimationOptions): Animation | null {
  if (reducedMotion()) return null;
  return el.animate(kf, { fill: 'none', ...o });
}

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

/**
 * A key that moves each time `state` becomes `target` from another state seen before: never the first time a state is
 * seen (a row mounted on a finished session, a reload), never while it stays there.
 */
export function nextArrivalKey(prev: { state: string | null; key: number }, state: string, target: string): { state: string; key: number } {
  return { state, key: state === target && prev.state !== null && prev.state !== state ? prev.key + 1 : prev.key };
}

/**
 * `nextArrivalKey` across renders. No state (a row without its session yet) forgets the one before, so the next state
 * shown is a first sighting.
 */
export function useArrivalKey(state: string | null, target: string): number {
  const last = useRef<{ state: string | null; key: number }>({ state: null, key: 0 });
  last.current = state === null ? { state: null, key: last.current.key } : nextArrivalKey(last.current, state, target);
  return last.current.key;
}

/**
 * A finite CSS cue keyed on `key` (remounted for each arrival): `on` from each rise of the key until `ended` hears the
 * end of the cue's own animation, so nothing of it stays mounted to replay when its row is moved in the list.
 */
export function useCue(key: number): { on: boolean; ended: (e: { target: EventTarget; currentTarget: EventTarget }) => void } {
  const [over, setOver] = useState(0);
  return { on: key > over, ended: (e) => { if (e.target === e.currentTarget) setOver(key); } };
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
