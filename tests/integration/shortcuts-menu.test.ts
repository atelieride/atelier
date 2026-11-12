import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { SHORTCUTS, keysOf } from '../../src/renderer/shortcuts';
import { MENU_SPEC, menuItems, type MenuSpecItem } from '../../src/shared/menu-spec';

// The macOS menu shortcuts, from the menu's definition (src/shared/menu-spec.ts, which src/main/menu.ts builds): the
// list in Settings › Keyboard must not miss any. Hidden items count (their key works), development-only ones too.
const items = menuItems(MENU_SPEC);
const accels = items.flatMap((i) => ('accelerator' in i && i.accelerator ? [i.accelerator] : []));
/** The item with that label, as data ({ label, accelerator?, command | action | role… }). */
const item = (label: string): MenuSpecItem | undefined => items.find((i) => 'label' in i && i.label === label);
/** A menu's labels in order (separators as '-', unlabelled roles as role:<name>). */
const labels = (menu: string) => {
  const m = MENU_SPEC.find((x) => 'label' in x && x.label === menu);
  return (m && 'submenu' in m ? m.submenu : []).map((i) => ('label' in i && i.label ? i.label : 'type' in i ? '-' : `role:${'role' in i ? i.role : ''}`));
};
// ⌘1…⌘9 are nine menu items: a single row in the list.
const TAB_KEYS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `CmdOrCtrl+${n}`));

test('every menu shortcut is in the list', () => {
  const listed = new Set(SHORTCUTS.flatMap((g) => g.items.map((i) => i.keys)));
  const missing = accels.filter((a) => !TAB_KEYS.has(a)).map(keysOf).filter((k) => !listed.has(k));
  expect(accels.length).toBeGreaterThan(15);
  expect(missing).toEqual([]);
  expect(accels.filter((a) => TAB_KEYS.has(a))).toHaveLength(9);
  expect(listed.has('⌘1…9')).toBe(true);
});

test('keysOf: macOS symbols', () => {
  expect(keysOf('CmdOrCtrl+Shift+N')).toBe('⌘⇧N');
  expect(keysOf('CmdOrCtrl+Alt+S')).toBe('⌘⌥S');
  expect(keysOf('Ctrl+Shift+Tab')).toBe('⌃⇧Tab');
  expect(keysOf('F1')).toBe('F1');
  expect(keysOf('CmdOrCtrl+,')).toBe('⌘,');
  expect(keysOf('CmdOrCtrl+Alt+Right')).toBe('⌘⌥→');
  expect(keysOf('CmdOrCtrl+Alt+Left')).toBe('⌘⌥←');
  expect(keysOf('CmdOrCtrl+\\')).toBe('⌘\\');
});

test('split view: the View menu items and their keys, listed in Settings › Keyboard', () => {
  for (const [label, acc] of [['Split Right', 'CmdOrCtrl+\\'], ['Focus Next Pane', 'CmdOrCtrl+Alt+Right'], ['Focus Previous Pane', 'CmdOrCtrl+Alt+Left']] as const) {
    expect(labels('View')).toContain(label);
    expect(item(label)).toMatchObject({ accelerator: acc });
  }
  // "Unsplit" reads as what it does (the tab stays open); "Close Pane" read as closing the tab.
  expect(item('Unsplit')).toEqual({ label: 'Unsplit', command: 'close-pane' });
  expect(item('Unsplit All')).toEqual({ label: 'Unsplit All', command: 'close-other-panes' });
  expect(item('Close Pane')).toBeUndefined();
  const listed = SHORTCUTS.flatMap((g) => g.items.map((i) => i.keys));
  for (const k of ['⌘\\', '⌘⌥→', '⌘⌥←']) expect(listed).toContain(k);
  // Nothing else in the menu on the same keys.
  for (const k of ['⌘\\', '⌘⌥→', '⌘⌥←']) expect(accels.filter((a) => keysOf(a) === k)).toHaveLength(1);
});

test('Comment on Selection is ⌘⌥C: ⌘⇧L stays the editor\'s "select all matches" (no menu item takes it)', () => {
  expect(item('Comment on Selection')).toMatchObject({ accelerator: 'CmdOrCtrl+Alt+C', command: 'comment-selection' });
  expect(accels).not.toContain('CmdOrCtrl+Shift+L');
  // Nothing else in the menu on the same keys.
  expect(accels.filter((a) => keysOf(a) === '⌘⌥C')).toHaveLength(1);
  const listed = SHORTCUTS.flatMap((g) => g.items);
  expect(listed.find((i) => i.keys === '⌘⌥C')?.label).toMatch(/^Comment on the selected lines/);
  expect(listed.find((i) => i.keys === '⌘⇧L')?.label).toMatch(/Select all matches/i);
});

test('Session Panel: in the View menu, no shortcut, opening the selected session\'s panel', () => {
  expect(labels('View')).toContain('Session Panel');
  expect(item('Session Panel')).toEqual({ label: 'Session Panel', command: 'session-panel' });
  const app = readFileSync(join(__dirname, '../../src/renderer/App.tsx'), 'utf8');
  expect(app).toContain("case 'session-panel': openSelectedSessionPanel(); break;");
});

test('Ask About This Session: ⌘I in View right after Session Panel, toggling the focused session\'s Ask, listed in Keyboard', () => {
  const view = labels('View');
  expect(view[view.indexOf('Session Panel') + 1]).toBe('Ask About This Session');
  expect(item('Ask About This Session')).toEqual({ label: 'Ask About This Session', accelerator: 'CmdOrCtrl+I', command: 'ask-session' });
  // Nothing else in the menu on ⌘I (it takes CodeMirror's "select parent syntax").
  expect(accels.filter((a) => keysOf(a) === '⌘I')).toHaveLength(1);
  const app = readFileSync(join(__dirname, '../../src/renderer/App.tsx'), 'utf8');
  expect(app).toContain("case 'ask-session': askSelected(); break;");
  const palette = readFileSync(join(__dirname, '../../src/renderer/components/Palette.tsx'), 'utf8');
  expect(palette).toMatch(/c\('ask-session', t\.companion\.menu/);
  const rows = SHORTCUTS.find((g) => g.title === 'View')!.items;
  expect(rows.find((i) => i.keys === '⌘I')?.label).toBe('Ask about the focused session (read-only)');
});

test('Databases: ⌃⇧B in View right after Redis, opening the view unless Never; the palette and Keyboard list it', () => {
  const view = labels('View');
  expect(view[view.indexOf('Redis') + 1]).toBe('Databases');
  // Always in the menu, like Redis's item: with Never its command does nothing (the view is gone).
  expect(item('Databases')).toEqual({ label: 'Databases', accelerator: 'Ctrl+Shift+B', command: 'view-databases' });
  // Free: ⌃⇧D is Docker's, ⌃⇧R Redis's; nothing else on ⌃⇧B.
  expect(accels.filter((a) => keysOf(a) === '⌃⇧B')).toHaveLength(1);
  const app = readFileSync(join(__dirname, '../../src/renderer/App.tsx'), 'utf8');
  expect(app).toContain("case 'view-databases': if (st.settings.showDatabases !== 'never') st.setActivity('databases'); break;");
  const palette = readFileSync(join(__dirname, '../../src/renderer/components/Palette.tsx'), 'utf8');
  for (const id of ['v-databases', 'db-add', 'db-overview']) expect(palette).toContain(`cmd('${id}'`);
  // One opener for the overview tab: the palette's command and the sidebar's menu (tabs.ts).
  const menus = readFileSync(join(__dirname, '../../src/renderer/databases/menus.ts'), 'utf8');
  for (const [f, s] of [['Palette.tsx', palette], ['menus.ts', menus]] as const) {
    expect(s, f).toContain('openDbOverview(');
    expect(s, f).not.toMatch(/kind: 'overview', view: 'data' \}, \{ preview: false \}/);
  }
  const view2 = SHORTCUTS.find((g) => g.title === 'View')!.items;
  expect(view2[view2.findIndex((i) => i.keys === '⌃⇧R') + 1]).toEqual({ keys: '⌃⇧B', label: 'Databases (read-only PostgreSQL: tables, structure, activity)' });
  // ⌘Enter on a table in the palette keeps its tab (Enter: a preview), in the Databases group.
  const db = SHORTCUTS.find((g) => g.title === 'Databases')!.items;
  expect(db.find((i) => i.keys === '⌘⏎')?.label).toBe('On a table in the palette: open it as a kept tab (⏎: a preview)');
});

test('Find in Files: ⌘⇧F in View after Files, the command, the palette\'s three items, F4 at the window; listed in Keyboard', () => {
  const view = labels('View');
  expect(view[view.indexOf('Files') + 1]).toBe('Find in Files');
  expect(item('Find in Files')).toEqual({ label: 'Find in Files', accelerator: 'CmdOrCtrl+Shift+F', command: 'find-in-files' });
  expect(accels.filter((a) => keysOf(a) === '⌘⇧F')).toHaveLength(1);
  const app = readFileSync(join(__dirname, '../../src/renderer/App.tsx'), 'utf8');
  expect(app).toContain("case 'find-in-files': findInFilesCommand(from === 'popout'); break;");
  // F4 / ⇧F4: the page's own keys, at the window (a pop-out's come here through its forwarded command).
  expect(app).toContain('installSearchKeys()');
  // A pop-out's F4 reaches the project window quietly: handled before Settings would close for a command.
  const listener = app.slice(app.indexOf('window.atelier.on.command('));
  const quiet = listener.indexOf("if (cmd === 'next-search-result' || cmd === 'prev-search-result')");
  expect(quiet).toBeGreaterThan(-1);
  expect(quiet).toBeLessThan(listener.indexOf('if (st.settingsOpen)'));
  const palette = readFileSync(join(__dirname, '../../src/renderer/components/Palette.tsx'), 'utf8');
  for (const id of ['find-in-files', 'next-search-result', 'prev-search-result']) expect(palette).toContain(`c('${id}'`);
  // Written in the accelerator's own order wherever it is shown (kbd() gives Windows its Shift+Alt+F).
  for (const f of ['components/Palette.tsx', 'editor/find/FindCard.tsx', 'search/FindInFiles.tsx', 'i18n/en.ts']) {
    const src = readFileSync(join(__dirname, '../../src/renderer', f), 'utf8');
    expect(src, f).toContain("kbd('⌘⇧F')");
    expect(src, f).not.toContain('⇧⌘F');
  }
  const editor = SHORTCUTS.find((g) => g.title === 'Files & Editor')!.items;
  expect(editor.find((i) => i.label === 'Find in files')?.keys).toBe('⌘⇧F');
  expect(editor.find((i) => i.label === 'Next / previous search result')?.keys).toBe('F4 · ⇧F4');
});

test('Connectors: reachable from the app menu, right after Settings…, opening its Settings section', () => {
  const appMenu = MENU_SPEC[0]!;
  expect('app' in appMenu && appMenu.app).toBe(true);
  const first = labels(appMenu && 'label' in appMenu ? appMenu.label : '');
  expect(first[first.indexOf('Settings…') + 1]).toBe('Connectors…');
  expect(item('Connectors…')).toEqual({ label: 'Connectors…', command: 'open-connectors' });
  const app = readFileSync(join(__dirname, '../../src/renderer/App.tsx'), 'utf8');
  expect(app).toContain("case 'open-connectors': st.setSettingsOpen('connectors'); break;");
});

test('Start Session from Task…: in the File menu after Resume Session…, opening the palette on task:', () => {
  const file = labels('File');
  expect(file[file.indexOf('Resume Session…') + 1]).toBe('Start Session from Task…');
  expect(item('Start Session from Task…')).toEqual({ label: 'Start Session from Task…', command: 'start-from-task' });
  const app = readFileSync(join(__dirname, '../../src/renderer/App.tsx'), 'utf8');
  expect(app).toContain("case 'start-from-task': st.setPaletteOpen(true, 'task:'); break;");
  const palette = readFileSync(join(__dirname, '../../src/renderer/components/Palette.tsx'), 'utf8');
  expect(palette).toMatch(/c\('start-from-task', t\.tasks\.startFromTask/);
  // Settings › Keyboard lists the task: prefix and ⌘Enter on a task, like :n for lines.
  const listed = SHORTCUTS.flatMap((g) => g.items);
  expect(listed.find((i) => i.keys === 'task:')?.label).toMatch(/tasks/i);
  expect(listed.find((i) => i.keys === '⌘⏎')?.label).toMatch(/send/i);
});

test('no duplicates in the list', () => {
  const all = SHORTCUTS.flatMap((g) => g.items.map((i) => `${i.keys}|${i.label}`));
  expect(new Set(all).size).toBe(all.length);
});

test('Markdown preview, JSON tree and CSV table: ⇧⌘V and the View items, the palette commands and Keyboard rows', () => {
  // One item for both: the Markdown preview or the JSON tree of the tab in front.
  expect(item('Toggle Preview')).toEqual({ label: 'Toggle Preview', accelerator: 'CmdOrCtrl+Shift+V', command: 'md-toggle-preview' });
  expect(item('Split Preview')).toEqual({ label: 'Split Preview', command: 'md-split' });
  expect(item('Markdown Outline')).toEqual({ label: 'Markdown Outline', command: 'md-outline' });
  expect(item('Toggle Markdown Preview')).toBeUndefined();
  expect(accels.filter((a) => keysOf(a) === '⌘⇧V')).toHaveLength(1);
  const app = readFileSync(join(__dirname, '../../src/renderer/App.tsx'), 'utf8');
  expect(app).toContain("case 'md-toggle-preview': togglePreview(); break;");
  expect(app).toContain("case 'md-split': setActivePreviewView('split'); break;");
  expect(app).toContain("case 'md-outline': toggleMarkdownOutline(); break;");
  const palette = readFileSync(join(__dirname, '../../src/renderer/components/Palette.tsx'), 'utf8');
  for (const id of ['md-toggle', 'md-split', 'md-source', 'md-outline', 'json-toggle', 'json-split', 'json-source', 'json-fold-all', 'json-unfold-all', 'json-copy-path', 'csv-toggle', 'csv-split', 'csv-source', 'csv-go-to-row', 'csv-options', 'csv-rainbow', 'csv-align', 'csv-summaries']) expect(palette).toContain(`c('${id}'`);
  const rows = SHORTCUTS.flatMap((g) => g.items);
  expect(rows.find((i) => i.keys === '⌘⇧V')?.label).toBe('Toggle Markdown preview, JSON tree or CSV table');
  for (const k of ['⌥⌘[ ⌥⌘]', '⌃⌥[ ⌃⌥]', '⌥⇧⌘C']) expect(rows.map((i) => i.keys)).toContain(k);
  // The JSON tree's own keys, in a group of their own.
  const tree = SHORTCUTS.find((g) => g.title === 'JSON Tree');
  expect(tree?.items.map((i) => i.keys)).toEqual(['↑ ↓', '← →', '⌥← ⌥→', '⏎', '⌥⏎', '⌘C', '⌘F']);
  // The CSV table's keys, in a group of their own.
  const table = SHORTCUTS.find((g) => g.title === 'CSV Table');
  expect(table?.items.map((i) => i.keys)).toEqual(['↑ ↓ ← →', '⌘↑ ⌘↓', '⌘A', '⌘C', '⌥⏎', 'Space', '⌃G', 'F8 ⇧F8', '⌥-click', '⌘F', '⌘L']);
  // Nothing in the menu takes the editor's fold keys, Copy Path, or the table's Go to Row and problem keys.
  for (const k of ['⌥⌘[', '⌥⌘]', '⌃⌥[', '⌃⌥]', '⌥⇧⌘C', '⌃G', 'F8', '⇧F8']) expect(accels.map(keysOf)).not.toContain(k);
});

test('Source Control: ⌃⇧G in View, Show History, the palette commands and a Keyboard group', () => {
  expect(item('Source Control')).toEqual({ label: 'Source Control', accelerator: 'Ctrl+Shift+G', command: 'view-scm' });
  expect(item('Show History')).toEqual({ label: 'Show History', command: 'show-history' });
  expect(accels.filter((a) => keysOf(a) === '⌃⇧G')).toHaveLength(1);
  const app = readFileSync(join(__dirname, '../../src/renderer/App.tsx'), 'utf8');
  expect(app).toContain("case 'view-scm': st.setActivity('scm'); break;");
  expect(app).toContain("case 'show-history': void withScm(() => showHistory('all')); break;");
  const palette = readFileSync(join(__dirname, '../../src/renderer/components/Palette.tsx'), 'utf8');
  for (const id of ['v-scm', 'scm-history', 'scm-switch', 'scm-ref', 'scm-compare']) expect(palette).toContain(`c('${id}'`);
  // Fetch: Git › Fetch and Fetch All Repositories (moved from View), no shortcut,
  // and their palette commands.
  expect(item('Fetch')).toEqual({ label: 'Fetch', command: 'fetch' });
  expect(item('Fetch All Repositories')).toEqual({ label: 'Fetch All Repositories', command: 'fetch-all' });
  expect(labels('Git')).toEqual(expect.arrayContaining(['Fetch', 'Fetch All Repositories']));
  expect(labels('View')).not.toContain('Fetch');
  expect(app).toContain("case 'fetch': fetchSelected(); break;");
  expect(app).toContain("case 'fetch-all': void withScm(() => void fetchAll()); break;");
  for (const id of ['scm-fetch', 'scm-fetch-all']) expect(palette).toContain(`c('${id}'`);
  const group = SHORTCUTS.find((g) => g.title === 'Source Control');
  expect(group?.items.map((i) => i.keys)).toEqual(['⌃⇧G', '⌘F', '↑ ↓', '⏎', 'n p', '⌘C', '⌥-click']);
});

test('Git › Commit…: ⌘⌥K in a Git menu right after View, opening the commit drawer, in a Keyboard group', () => {
  const menus = MENU_SPEC.map((m) => ('label' in m ? m.label : m.role));
  expect(menus.indexOf('Git')).toBe(menus.indexOf('View') + 1);
  expect(labels('Git')[0]).toBe('Commit…');
  expect(item('Commit…')).toEqual({ label: 'Commit…', accelerator: 'CmdOrCtrl+Alt+K', command: 'git-commit', visibleWhen: 'git-writes' });
  // Not ⌥⌘C (Comment on Selection); nothing else on ⌥⌘K.
  expect(accels.filter((a) => keysOf(a) === '⌘⌥K')).toHaveLength(1);
  const app = readFileSync(join(__dirname, '../../src/renderer/App.tsx'), 'utf8');
  expect(app).toContain("case 'git-commit': openCommitDrawer(); break;");
  const group = SHORTCUTS.find((g) => g.title === 'Git');
  expect(group?.items.map((i) => i.keys)).toEqual(['⌘⌥K', '⌘⏎', '⌘⌥M', 'Esc']);
});

test('Git › Write Commit Message with Claude: ⌘⌥M after Commit All, starting ✦ in the drawer', () => {
  expect(labels('Git').slice(0, 3)).toEqual(['Commit…', 'Commit All Repositories…', 'Write Commit Message with Claude']);
  expect(item('Write Commit Message with Claude')).toEqual({ label: 'Write Commit Message with Claude', accelerator: 'CmdOrCtrl+Alt+M', command: 'git-write-message', visibleWhen: 'git-messages' });
  expect(accels.filter((a) => keysOf(a) === '⌘⌥M')).toHaveLength(1);
  const app = readFileSync(join(__dirname, '../../src/renderer/App.tsx'), 'utf8');
  expect(app).toContain("case 'git-write-message': void writeMessageCommand(); break;");
});

test('the Git menu: every command reaches the renderer, which runs it on the selected repository', () => {
  // Shown only for a project with a repository; the visibility follows the window's menu state (src/main/menu.ts).
  expect(MENU_SPEC.find((m) => 'label' in m && m.label === 'Git')).toMatchObject({ visibleWhen: 'git-repos' });
  const app = readFileSync(join(__dirname, '../../src/renderer/App.tsx'), 'utf8');
  for (const c of ['git-commit-all', 'git-push', 'git-pull', 'git-sync', 'git-sync-all', 'git-new-branch', 'git-switch-branch', 'git-stash']) expect(app).toContain(`case '${c}':`);
  expect(app).toMatch(/case 'git-stash': void runGitCommand\(cmd\); break;/);
  // The palette offers the same commands (src/renderer/git/commands.ts builds them).
  const palette = readFileSync(join(__dirname, '../../src/renderer/components/Palette.tsx'), 'utf8');
  expect(palette).toContain('gitPaletteCommands(');
});

// Workspaces: New Workspace… in File, the list in Go (its ⌘⌥1…9 are built with the
// names), Next/Previous Workspace; shown only while the window's project has workspaces on; the toggle always.
test('Workspaces: File › New Workspace… ⌘⌥T, Go lists them, View toggles them; listed in Settings › Keyboard', () => {
  expect(labels('File')).toContain('New Workspace…');
  expect(item('New Workspace…')).toMatchObject({ accelerator: 'CmdOrCtrl+Alt+T', command: 'new-workspace', visibleWhen: 'workspaces' });
  expect(item('Next Workspace')).toMatchObject({ command: 'next-workspace', visibleWhen: 'workspaces' });
  expect(item('Previous Workspace')).toMatchObject({ command: 'prev-workspace', visibleWhen: 'workspaces' });
  expect(labels('View')).toContain('Toggle Workspaces for This Project');
  // Enabled in a project window only (the welcome window and pop-outs have no project of their own).
  expect(item('Toggle Workspaces for This Project')).toEqual({ label: 'Toggle Workspaces for This Project', command: 'toggle-workspaces', enabledWhen: 'ws-toggle' });
  const go = MENU_SPEC.find((m) => 'label' in m && m.label === 'Go');
  const goItems = go && 'submenu' in go ? go.submenu : [];
  expect(goItems.some((i) => 'dynamicItems' in i && i.dynamicItems === 'workspaces')).toBe(true);
  // ⌘⌥T and ⌘⌥1…9 belong to nothing else in the menu.
  expect(accels.filter((a) => a === 'CmdOrCtrl+Alt+T')).toHaveLength(1);
  for (let n = 1; n <= 9; n++) expect(accels).not.toContain(`CmdOrCtrl+Alt+${n}`);
  const listed = SHORTCUTS.flatMap((g) => g.items.map((i) => i.keys));
  expect(listed).toContain(keysOf('CmdOrCtrl+Alt+T'));
  expect(listed).toContain(`${keysOf('CmdOrCtrl+Alt+1').slice(0, -1)}1…9`);
});

// Word wrap: View › Word Wrap in the editor group, no menu key (⌥Z would fire from
// terminals too, where it types a character); ⌥Z is the editors' own, listed under Files & Editor.
test('View › Word Wrap, before Toggle Preview, has no menu key; ⌥Z is listed under Files & Editor', () => {
  const view = labels('View');
  expect(view[view.indexOf('Toggle Preview') - 1]).toBe('Word Wrap');
  expect(item('Word Wrap')).toEqual({ label: 'Word Wrap', command: 'toggle-word-wrap', checkedWhen: 'word-wrap' });
  expect(accels.map(keysOf)).not.toContain('⌥Z');
  const editor = SHORTCUTS.find((g) => g.title === 'Files & Editor')!.items;
  expect(editor.find((i) => i.keys === '⌥Z')?.label).toMatch(/word wrap/i);
});
