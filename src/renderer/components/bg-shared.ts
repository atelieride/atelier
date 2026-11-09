import type { BackgroundKind } from '@shared/session';
import type { IconName } from './Icon';

/** One glyph per kind of background work (agent, shell, monitor, other) and for a scheduled wake-up: chips and popover. */
export const BG_GLYPH: Record<BackgroundKind | 'cron' | 'loop', IconName> = { agent: 'sparkle', shell: 'terminal', monitor: 'eye', other: 'bolt', cron: 'clock', loop: 'sync' };

// The chip that opened the Background popover: Escape (and a close that leaves the focus inside it) gives it back.
let opener: HTMLElement | null = null;
export function rememberBgOpener(el: HTMLElement | null) { opener = el; }
export function bgOpener(): HTMLElement | null { return opener; }

type Focusable = { matches(sel: string): boolean; closest(sel: string): Focusable | null; focus?(): void };
const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Where the focus goes back to: the opener if it takes focus, else its closest focusable ancestor (the sidebar chip is a plain span inside the row's button). */
export function focusableFor<T extends Focusable>(el: T | null): T | null {
  if (!el) return null;
  return el.matches(FOCUSABLE) ? el : ((el.closest(FOCUSABLE) as T | null) ?? null);
}

/** A scroll (seen in the capture phase) closes the popover only when the scrolled thing moves its opener: the page, or a container holding it. */
export function scrollClosesPopover(target: EventTarget | null, chip: { } | null, isDocument: boolean): boolean {
  if (isDocument) return true;
  const node = target as { contains?: (n: unknown) => boolean } | null;
  return !!chip && !!node?.contains?.(chip);
}

// A close caused by opening the tab or the inspector keeps the focus where the new tab put it.
let skipReturn = false;
export function skipFocusReturn() { skipReturn = true; }
export function takeSkipFocusReturn(): boolean { const v = skipReturn; skipReturn = false; return v; }
