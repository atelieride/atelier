/** How long a keyboard selection must stay still before it counts as finished. */
export const SETTLE_MS = 150;

export interface SelectionSettle {
  /** A mouse button went down in the editor: a drag may follow. */
  pointerDown(): void;
  /** The mouse button was released (anywhere). */
  pointerUp(): void;
  /** The selection changed (by mouse, keyboard or code). */
  selectionChanged(): void;
  keyUp(key: string): void;
  /** The selection was set for the user (a search result's match): nothing waits to settle. */
  reset(): void;
  dispose(): void;
}

/**
 * Tells when a selection is finished, so what belongs to it (the "Comment" button) shows once instead of following
 * every step: a mouse selection on mouse up, a keyboard one when Shift is released or after SETTLE_MS without changes.
 * `onSettled` is called once per finished change.
 */
export function selectionSettle(onSettled: () => void): SelectionSettle {
  let dragging = false;
  let unsettled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const settle = () => {
    cancel();
    if (!unsettled) return;
    unsettled = false;
    onSettled();
  };
  const reset = () => { cancel(); unsettled = false; };
  return {
    pointerDown() { dragging = true; cancel(); },
    pointerUp() { if (!dragging) return; dragging = false; settle(); },
    selectionChanged() {
      unsettled = true;
      cancel();
      if (!dragging) timer = setTimeout(settle, SETTLE_MS);
    },
    keyUp(key) { if (key === 'Shift' && !dragging) settle(); },
    reset,
    dispose: reset
  };
}
