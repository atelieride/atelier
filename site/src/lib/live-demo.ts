// The live demo's pure parts, unit-tested; scripts/live-demo*.ts do the DOM.
// Imported by the page's first script, so it imports nothing: the protocol's validators load with the stage, on intent.

/** Who gets the demo: wide desktop screens with a real pointer. The same query gates the controls in CSS
 *  (site.css › .demo-gate), so a phone or tablet never shows them and the script does nothing there. */
export const DEMO_GATE = '(min-width: 1100px) and (hover: hover) and (pointer: fine)';

/** How long the demo may take to say `ready` before the page gives up (spec: 10 s, of visible time). The component's
 *  data-demo-timeout carries it, so e2e tests can shorten it with no test-only switch in production code. */
export function readyTimeout(attr: string | null | undefined): number {
  const n = Number.parseInt(attr ?? '', 10);
  return Number.isFinite(n) ? Math.min(60000, Math.max(100, n)) : 10000;
}
