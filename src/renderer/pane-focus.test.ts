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
  const body = { name: 'body' };
  // The result row the open came from, an element of the file's own view, a field the user went to meanwhile.
  const row = { name: 'row' };
  const own = { name: 'editor' };
  const field = { name: 'field' };
  let active: unknown = body;
  let overlay: unknown = null;
  g.document = { body, get activeElement() { return active; }, querySelector: () => overlay };
  const view = { contains: (el: unknown) => el === own };
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
