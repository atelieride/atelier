// A startup timeout that counts only the time the page is visible, shared by the demo
// (its first-frame watchdog, shell/index.ts) and the site (its wait for `ready`, live-demo-stage.ts). A page opened into
// a background tab (⌘-click /demo), or left for another tab while the demo loads, has its animation frames stalled by
// the browser: a plain timer would call that a failure. Pure TypeScript, no DOM: the caller hands it the document's
// visibility.

export interface Visibility {
  hidden(): boolean;
  /** Calls `cb` on every visibility change; returns the unsubscribe. */
  subscribe(cb: () => void): () => void;
}

/** A document's visibility (`visibilitychange`). */
export const documentVisibility = (doc: Document): Visibility => ({
  hidden: () => doc.hidden,
  subscribe(cb) {
    doc.addEventListener('visibilitychange', cb);
    return () => doc.removeEventListener('visibilitychange', cb);
  }
});

/** Runs `fn` once `ms` of visible time has passed; returns the cancel. */
export function visibleTimeout(ms: number, fn: () => void, vis: Visibility): () => void {
  let left = ms;
  let armedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  const stop = () => {
    done = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    unsubscribe();
  };
  const arm = () => {
    armedAt = Date.now();
    timer = setTimeout(() => { stop(); fn(); }, left);
  };
  const unsubscribe = vis.subscribe(() => {
    if (done) return;
    if (vis.hidden()) {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      left = Math.max(0, left - (Date.now() - armedAt));
    } else if (timer === null) arm();
  });
  if (!vis.hidden()) arm();
  return stop;
}
