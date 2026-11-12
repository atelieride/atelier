// Split view: the keyboard follows the pane focus.
import { useApp } from './store';
import { focusTerminal } from './terminal/focus';

/**
 * After the pane focus moved: an element of another pane that still has the keyboard (the terminal that was focused,
 * when the newly focused pane's view has nothing to focus) gives it up, so typing never reaches a pane that isn't
 * focused. A view's pane is its `.workspace-body` child's grid column; pane controls (`data-pane-keep`: dividers, the
 * Close buttons) keep it.
 */
export function blurStrayFocus(body: HTMLElement, focus: number): void {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !body.contains(el) || el.closest('[data-pane-keep]')) return;
  let child: HTMLElement = el;
  while (child.parentElement && child.parentElement !== body) child = child.parentElement;
  const col = Number(child.style.gridColumnStart);
  if (col >= 1 && col - 1 !== focus) el.blur();
}

/** What in a pane header takes a click (or the keyboard) of its own. */
const INTERACTIVE = 'button, input, textarea, select, a[href], [tabindex], [contenteditable=""], [contenteditable="true"]';

/**
 * Mouse down on a pane header: on its blank parts (title text, icons, gaps) the press must not move the keyboard out of
 * the pane's terminal or editor (a mousedown on something unfocusable blurs whatever had it).
 */
export function keepPaneKeyboard(e: { target: EventTarget | null; preventDefault(): void }): void {
  const el = e.target as { closest?: (selector: string) => unknown } | null;
  if (el?.closest?.(INTERACTIVE)) return;
  e.preventDefault();
}

// Coming back to the window. macOS's first click on an inactive window only activates it and never
// reaches the page, so the keyboard stays where it was: often a chip just clicked (a port that opened the browser).

/** What the decision needs to know about the focused element (pure, so it is tested without a DOM). */
export interface FocusFacts {
  tag: string;
  role: string | null;
  /** Inside a pane's own content (.workspace-body, outside its header and session bar). */
  inPane: boolean;
  /** Focused from the keyboard (:focus-visible). */
  focusVisible: boolean;
  /** A sheet, menu, popover or dialog is open (or the element is inside one). */
  overlayOpen: boolean;
}

const CONTROL_TAGS = new Set(['BUTTON', 'A', 'SELECT', 'SUMMARY']);
const CONTROL_ROLES = new Set(['button', 'tab', 'link', 'menuitem', 'option', 'switch', 'checkbox', 'radio', 'treeitem']);
const isControl = (x: FocusFacts) => CONTROL_TAGS.has(x.tag) || (x.role !== null && CONTROL_ROLES.has(x.role));

/**
 * Whether the keyboard goes back to the pane: nothing focused, or a control the mouse focused, with no overlay open.
 * Keyboard focus (someone who tabbed there), fields, the terminal and the editor keep it.
 */
export function shouldReturnFocus(active: FocusFacts | null): boolean {
  if (!active) return true;
  if (active.overlayOpen) return false;
  if (active.tag === 'BODY' || active.tag === 'HTML') return true;
  return isControl(active) && !active.focusVisible;
}

/**
 * What the keyboard comes back to: a pane's own content (the terminal, the editor, a view's root, a comment box in a
 * review); never a control, a rename input (it is gone a moment later), anything outside the panes or in an overlay.
 */
export function isPaneContent(x: FocusFacts): boolean {
  return x.inPane && !x.overlayOpen && !isControl(x) && x.tag !== 'INPUT' && x.tag !== 'BODY' && x.tag !== 'HTML';
}

const OVERLAY = '[role="dialog"], [role="menu"], [aria-modal="true"], .palette, .settings';
/** The element is in a sheet, menu, popover or dialog (the palette and Settings included). */
export const insideOverlay = (el: Element | null | undefined): boolean => !!el?.closest(OVERLAY);
/** A pane's own chrome, not its content: its header, its session bar, the tabs. */
const PANE_CHROME = '.session-bar, .pane-head, .tabs';

function factsOf(el: Element | null): FocusFacts | null {
  if (!(el instanceof HTMLElement)) return null;
  return {
    tag: el.tagName, role: el.getAttribute('role'), inPane: !!el.closest('.workspace-body') && !el.closest(PANE_CHROME),
    focusVisible: el.matches(':focus-visible'), overlayOpen: !!el.closest(OVERLAY) || document.querySelector(OVERLAY) !== null
  };
}

let lastContent: HTMLElement | null = null;

/**
 * Puts the keyboard back on the pane content that last had it (the terminal, the editor…), if it is still on screen;
 * otherwise on the selected session's terminal when it is the tab in front.
 */
export function restorePaneFocus(): void {
  if (document.querySelector(OVERLAY)) return;
  const el = lastContent;
  if (el && el.isConnected && el.getClientRects().length > 0) {
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    return;
  }
  const st = useApp.getState();
  if (st.selectedId && st.activeTab === 'term') focusTerminal(st.selectedId);
}

/** Controls that open something outside the app (a port, a PR, a task): the keyboard goes back to the pane at once. */
export function afterLeavingApp(): void {
  setTimeout(restorePaneFocus, 0);
}

/** Remembers the pane content that has the keyboard and gives it back when the window comes forward. Returns its undo. */
export function installFocusReturn(): () => void {
  const onFocusIn = (e: FocusEvent) => {
    const el = e.target;
    if (el instanceof HTMLElement) { const x = factsOf(el); if (x && isPaneContent({ ...x, overlayOpen: !!el.closest(OVERLAY) })) lastContent = el; }
  };
  const onWindowFocus = () => { if (shouldReturnFocus(factsOf(document.activeElement))) restorePaneFocus(); };
  document.addEventListener('focusin', onFocusIn);
  window.addEventListener('focus', onWindowFocus);
  return () => { document.removeEventListener('focusin', onFocusIn); window.removeEventListener('focus', onWindowFocus); };
}
