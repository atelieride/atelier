import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// The Windows title bar's drop-downs are the app's context menu: every window that shows the title bar draws it too.
// The Welcome window had none, so File opened an invisible menu and the bar stayed stuck.
const app = readFileSync(join(__dirname, '../../src/renderer/App.tsx'), 'utf8');

test('the Welcome window, with its floating title bar, also mounts the context menu', () => {
  const welcome = app.split('\n').find((l) => l.includes('<TitleBar floating />'));
  expect(welcome).toBeDefined();
  expect(welcome).toContain('<ContextMenu />');
});

test('the floating title bar comes after the Welcome screen: its buttons win over the screen’s drag region', () => {
  // Chromium takes app regions in document order, the later ones over the earlier: before Welcome, the whole-window
  // drag of `.welcome` swallowed the hamburger's clicks.
  const welcome = app.split('\n').find((l) => l.includes('<TitleBar floating />'))!;
  expect(welcome.indexOf('<Welcome />')).toBeGreaterThan(-1);
  expect(welcome.indexOf('<TitleBar floating />')).toBeGreaterThan(welcome.indexOf('<Welcome />'));
});

// One bar: on Windows the header is the window's top row and holds the menu; New is the project
// chip's +, which keeps the class every e2e clicks.
const header = readFileSync(join(__dirname, '../../src/renderer/components/Header.tsx'), 'utf8');

test('a project window has no title bar row above the header: the header holds the window menu', () => {
  expect(app.match(/<TitleBar\b[^>]*\/>/g)).toEqual(['<TitleBar floating />']);
  expect(header).toMatch(/<WindowMenu \/>/);
});

test('the header has no New text button: the project chip ends with the + (class btn-new)', () => {
  expect(header).not.toContain('t.newLabel');
  expect(header).toMatch(/className=\{?[`"][^`"]*\bchip-new btn-new\b/);
});
