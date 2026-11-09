import { isMod } from '@shared/keys';

/**
 * Whether the platform modifier (⌘; Ctrl on Windows) is held now: a terminal path outside the project and Claude's temp
 * folder is a link only while it is, since checking it touches the disk.
 */
export class ModKey {
  held = false;
  private readonly subs = new Set<(held: boolean) => void>();

  set(held: boolean): void {
    if (held === this.held) return;
    this.held = held;
    for (const s of [...this.subs]) s(held);
  }

  /** Told at every change; the returned function stops it. */
  on(fn: (held: boolean) => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }
}

/**
 * Keys and mouse moves say it (capture phase, before anything can stop them: a move over the window catches ⌘ pressed
 * while another app was in front); a blur lets go (⌘-Tab away never sends the keyup).
 */
export function trackModKey(target: Pick<EventTarget, 'addEventListener'>, mod: ModKey): void {
  // Keyboard and mouse events both carry metaKey and ctrlKey.
  const follow = (e: Event) => mod.set(isMod(e as KeyboardEvent));
  for (const type of ['keydown', 'keyup', 'mousemove', 'mousedown']) target.addEventListener(type, follow, true);
  target.addEventListener('blur', () => mod.set(false), true);
}

let shared: ModKey | null = null;

/** The window's modifier, tracked from the first terminal that asks. */
export function windowModKey(): ModKey {
  if (!shared) {
    shared = new ModKey();
    trackModKey(window, shared);
  }
  return shared;
}
