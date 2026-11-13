import { expect, test } from 'vitest';
import { isPaneContent, mayFocusLate, shouldReturnFocus, type FocusFacts } from './pane-focus';
import { useApp } from './store';

// Coming back to the window puts the keyboard back in the pane — only from a control the mouse focused.
const f = (o: Partial<FocusFacts>): FocusFacts => ({ tag: 'BUTTON', role: null, inPane: true, focusVisible: false, overlayOpen: false, ...o });

test('a button, chip, tab or link focused by the mouse gives the keyboard back', () => {
  expect(shouldReturnFocus(f({}))).toBe(true);
  expect(shouldReturnFocus(f({ tag: 'A' }))).toBe(true);
  expect(shouldReturnFocus(f({ tag: 'DIV', role: 'tab' }))).toBe(true);
  expect(shouldReturnFocus(f({ tag: 'SPAN', role: 'button' }))).toBe(true);
});

test('nothing focused (the page itself) gives it back too', () => {
  expect(shouldReturnFocus(null)).toBe(true);
  expect(shouldReturnFocus(f({ tag: 'BODY' }))).toBe(true);
});

test('keyboard focus, a field, the terminal, the editor, or an open sheet/menu/dialog keep it', () => {
  expect(shouldReturnFocus(f({ focusVisible: true }))).toBe(false);
  expect(shouldReturnFocus(f({ tag: 'INPUT' }))).toBe(false);
  expect(shouldReturnFocus(f({ tag: 'TEXTAREA' }))).toBe(false);
  expect(shouldReturnFocus(f({ tag: 'DIV', role: 'textbox' }))).toBe(false);
  expect(shouldReturnFocus(f({ overlayOpen: true }))).toBe(false);
  expect(shouldReturnFocus(f({ tag: 'BODY', overlayOpen: true }))).toBe(false);
  // A view's own root (tabindex=-1: Services, Review…) is content, not a control.
  expect(shouldReturnFocus(f({ tag: 'SECTION' }))).toBe(false);
});

test('what counts as pane content to come back to: fields, editors, view roots — not controls', () => {
  expect(isPaneContent(f({ tag: 'TEXTAREA' }))).toBe(true);
  expect(isPaneContent(f({ tag: 'DIV', role: 'textbox' }))).toBe(true);
  expect(isPaneContent(f({ tag: 'SECTION' }))).toBe(true);
  expect(isPaneContent(f({}))).toBe(false);
  expect(isPaneContent(f({ tag: 'DIV', role: 'menuitem' }))).toBe(false);
  expect(isPaneContent(f({ tag: 'BODY' }))).toBe(false);
  expect(isPaneContent(f({ tag: 'TEXTAREA', overlayOpen: true }))).toBe(false);
});

test('only a pane\'s own content is come back to: never a field outside the panes, never a rename input (review fix)', () => {
  // The sidebar, the tree, a comment box outside the workspace: not a pane.
  expect(isPaneContent(f({ tag: 'TEXTAREA', inPane: false }))).toBe(false);
  // Rename inputs (session bar, tabs) live and die in a moment; the terminal or the editor is what to come back to.
  expect(isPaneContent(f({ tag: 'INPUT' }))).toBe(false);
});

test('a focus that comes late takes the keyboard only from where the open left it, and never from what is open over the window', () => {
  const g = globalThis as { document?: unknown };
  const had = g.document;
  const body = el();
  // The result row the open came from, an element of the file's own view, a field the user went to meanwhile.
  const row = el(['.sidebar']);
  const own = el(['.workspace-body']);
  const field = el(['.sidebar']);
  let active: unknown = body;
  let overlay: unknown = null;
  g.document = { body, get activeElement() { return active; }, querySelector: () => overlay };
  const view = { contains: (x: unknown) => x === own };
  const ok = () => mayFocusLate(row as unknown as Element, view as unknown as Element);
  try {
    expect(ok()).toBe(true);
    active = null;
    expect(ok()).toBe(true);
    active = row;
    expect(ok()).toBe(true);
    active = own;
    expect(ok()).toBe(true);
    // The user went on elsewhere: the keyboard stays there.
    active = field;
    expect(ok()).toBe(false);
    // A sheet, a menu or a dialog open: never, wherever the keyboard is.
    active = row;
    overlay = {};
    expect(ok()).toBe(false);
    overlay = null;
    // The palette or Settings asked for, not drawn yet.
    useApp.setState({ paletteOpen: true });
    expect(ok()).toBe(false);
    useApp.setState({ paletteOpen: false, settingsOpen: 'general' as never });
    expect(ok()).toBe(false);
    useApp.setState({ settingsOpen: null });
    expect(ok()).toBe(true);
  } finally {
    g.document = had;
    useApp.setState({ paletteOpen: false, settingsOpen: null });
  }
});

/** An element of a fake page: inside the parts named by `within` (selectors), still in the page or not. */
const el = (within: string[] = [], isConnected = true) => ({
  isConnected,
  closest: (sel: string) => (sel.split(',').map((s) => s.trim()).some((s) => within.includes(s)) ? {} : null)
});

test('a late focus: only what is modal stops it (a sheet, a menu, the palette, Settings), or a panel the keyboard is in; a panel merely open beside the work does not', () => {
  const g = globalThis as { document?: unknown };
  const had = g.document;
  const body = el();
  // What is open in the page, by the selector that finds it.
  let open: string[] = [];
  let active: unknown = body;
  g.document = { body, get activeElement() { return active; }, querySelector: (sel: string) => (sel.split(',').map((s) => s.trim()).some((s) => open.includes(s)) ? {} : null) };
  const row = el(['.sidebar']);
  const view = { contains: () => false };
  const ok = () => mayFocusLate(row as unknown as Element, view as unknown as Element);
  try {
    active = row;
    // A session's panel, the notifications, a file's compare view (in a tab behind): dialogs, not modal.
    open = ['[role="dialog"]'];
    expect(ok()).toBe(true);
    // The keyboard in one of them: the user is there; even one inside the file's own view (its compare view).
    active = el(['[role="dialog"]']);
    expect(ok()).toBe(false);
    expect(mayFocusLate(row as unknown as Element, { contains: () => true } as unknown as Element)).toBe(false);
    active = row;
    for (const modal of ['[aria-modal="true"]', '[role="menu"]', '.ctx-menu', '.palette', '.settings']) {
      open = ['[role="dialog"]', modal];
      expect(ok(), modal).toBe(false);
    }
  } finally {
    g.document = had;
  }
});

test('a late focus whose open came from what has closed since (the palette): the keyboard the app put back in a pane is taken, a field outside the panes is not', () => {
  const g = globalThis as { document?: unknown };
  const had = g.document;
  const body = el();
  let active: unknown = body;
  g.document = { body, get activeElement() { return active; }, querySelector: () => null };
  const paletteInput = el(['.palette'], false);
  const view = { contains: () => false };
  const ok = () => mayFocusLate(paletteInput as unknown as Element, view as unknown as Element);
  try {
    expect(ok()).toBe(true);
    // The terminal of the pane, or another editor: where the app left the keyboard once the palette went.
    active = el(['.workspace-body']);
    expect(ok()).toBe(true);
    // The sidebar's field: somewhere the user went.
    active = el(['.sidebar']);
    expect(ok()).toBe(false);
    // The open's place still there: only it, as before.
    const kept = el(['.sidebar']);
    active = el(['.workspace-body']);
    expect(mayFocusLate(kept as unknown as Element, view as unknown as Element)).toBe(false);
  } finally {
    g.document = had;
  }
});
