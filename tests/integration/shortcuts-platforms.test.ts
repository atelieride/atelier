import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { buildShortcuts } from '../../src/renderer/shortcuts';

// Settings › Keyboard: rows backed by a menu accelerator are generated from it. On macOS the
// list must stay exactly what it was: tests/fixtures/shortcuts-darwin.json is the list as it was before generating.

test('macOS: the list is byte for byte the one the app had', () => {
  const before = JSON.parse(readFileSync('tests/fixtures/shortcuts-darwin.json', 'utf8')) as unknown;
  expect(buildShortcuts('darwin')).toEqual(before);
});

test('Windows: the Windows keymap, never a Mac glyph; rows Windows has no use for are gone', () => {
  const win = buildShortcuts('win32').flatMap((g) => g.items);
  const find = (label: string) => win.find((i) => i.label === label)?.keys;
  expect(find('New Claude session')).toBe('Ctrl+Shift+N');
  expect(find('Resume a session')).toBe('Shift+Alt+N');
  expect(find('Find in file')).toBe('Ctrl+F');
  // Find in the terminal: the terminal-first rule, Ctrl+F stays ^F for the program.
  expect(find('Find in the terminal (Enter older match, Shift+Enter newer)')).toBe('Ctrl+Shift+F');
  expect(find('Previous or next command (Atelier-profile terminals, command blocks on)')).toBe('Ctrl+↑ Ctrl+↓');
  expect(find('Go to tab (⌘9: last)') ?? find('Go to tab (Ctrl+9: last)')).toBe('Ctrl+1…9');
  // macOS-only: ⌘←/⌘→ to the line's ends (Home and End on Windows), the Services view (hidden there).
  expect(win.some((i) => /Start or end of the line/.test(i.label))).toBe(false);
  expect(win.some((i) => /Services/.test(i.label))).toBe(false);
  // Ask: Ctrl+Shift+I, as in the menu.
  expect(find('Ask about the focused session (read-only)')).toBe('Ctrl+Shift+I');
  // Databases: Ctrl+Shift+B as on macOS, like Docker's and Redis's; the palette's ⌘⏎ is
  // Ctrl+Enter.
  expect(find('Databases (read-only PostgreSQL: tables, structure, activity)')).toBe('Ctrl+Shift+B');
  expect(find('On a table in the palette: open it as a kept tab (Enter: a preview)')).toBe('Ctrl+Enter');
  // The sidebar: Ctrl+B is the terminal's, Ctrl+Shift+B Databases'.
  expect(find('Sidebar (also: click the view in front in the activity bar)')).toBe('Shift+Alt+B');
  for (const i of win) expect(`${i.keys} ${i.label}`, i.label).not.toMatch(/[⌘⌥⇧⌃⏎↵↩]/);
  // Windows' own places, as in the menu.
  expect(find('Reveal in File Explorer (a terminal: the folder it is in now)')).toBe('Shift+Alt+R');
  for (const i of win) expect(i.label).not.toMatch(/\b(Finder|Trash|Dock|macOS)\b/);
});
