// The git sheets' keys, pure: SheetFrame uses them.

/** An Enter this soon after a sheet appears was meant for what came before it (a field, a button, a menu). */
export const ENTER_GRACE_MS = 250;

/**
 * An Enter that must not answer the sheet: held down from before (a repeat), or pressed as it appeared. A sheet opened
 * by an op's answer (Push rejected, a diverged pull) can come up under a typing hand. ⌘↵ (a chord, pressed on purpose)
 * only when held down. `typed`: text went into one of the sheet's fields since it appeared (typedText), so the hand is
 * on the sheet and its Enter is the answer, however soon: a URL put in Add Connection's field (a snippet, dictation), then Enter.
 */
export function swallowEnter(e: { key: string; repeat: boolean; metaKey?: boolean; ctrlKey?: boolean }, mountedAt: number, now: number, typed = false): boolean {
  return e.key === 'Enter' && (e.repeat || (!typed && !e.metaKey && !e.ctrlKey && now - mountedAt < ENTER_GRACE_MS));
}

/**
 * An input event that put text in a field (typing, a paste, a deletion, dictation): an InputEvent names its inputType.
 * A checkbox toggled sends a plain Event, so a Space under a typing hand never ends the grace.
 */
export function typedText(e: { inputType?: string }): boolean {
  return !!e.inputType;
}

/**
 * Tab inside a sheet of `n` focusable controls, focus on control `at` (-1: the sheet itself): the index to focus when
 * it would leave the sheet, else null (the browser moves it).
 */
export function trapTab(n: number, at: number, back: boolean): number | null {
  if (n === 0) return null;
  if (at < 0) return back ? n - 1 : 0;
  if (!back && at === n - 1) return 0;
  if (back && at === 0) return n - 1;
  return null;
}

/**
 * Where the focus goes back when a sheet closes: what had it as the sheet first rendered (`rendered`: read then, since a
 * child's mount effect runs before the frame's). Gone by the time the sheet mounted — a context menu's item, whose menu
 * closed in the same commit and gave the focus back to its own opener — what has it then (`mounted`), unless inside.
 */
export function openerOf<E extends { isConnected: boolean }>(rendered: E | null, mounted: E | null, inside: (e: E) => boolean): E | null {
  if (rendered?.isConnected) return rendered;
  return mounted && !inside(mounted) ? mounted : null;
}
