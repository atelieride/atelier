// Actions that need the Mac: opening folders, Finder, logs, atelierd, dictation. The bridge
// answers them inertly and tells the demo shell, which shows "This one runs on your Mac. Download Atelier to try it."

export const NOT_IN_DEMO_EVENT = 'atelier-demo:not-in-demo';

/** Tells the page a feature runs on the Mac only (`what`: its name, for the hint). */
export function notInDemo(what: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<{ what: string }>(NOT_IN_DEMO_EVENT, { detail: { what } }));
}
