// The window's unload guard: unsaved files block closing, quitting and reloading, until the
// window's own question said Save or Don't Save. Then main does again what was stopped, and this once it goes through.

/** How long an answer lets the unload through: main repeats the close (or quit, or reload) at once. */
export const ALLOW_MS = 3000;

let allowedUntil = 0;

export function allowUnload(now = performance.now()): void { allowedUntil = now + ALLOW_MS; }

/** Whether beforeunload must stop the page: dirty files, and no answer just given. */
export function blocksUnload(dirty: number, now = performance.now()): boolean {
  return dirty > 0 && now >= allowedUntil;
}

/** Unsaved files in the window, by the store's marks: only tabs still open count. */
export function hasUnsaved(s: { openFiles: readonly { path: string }[]; dirty: Readonly<Record<string, boolean>> }): boolean {
  return s.openFiles.some((f) => s.dirty[f.path]);
}

/**
 * Tells main whether the window has unsaved files, once per change (main assumes none): on Windows they hold a sign-out,
 * restart or shutdown until each window's question is answered.
 */
export function unsavedReporter(send: (has: boolean) => void): (has: boolean) => void {
  let last = false;
  return (has) => {
    if (has === last) return;
    last = has;
    try { send(has); } catch { /* the window going away */ }
  };
}
