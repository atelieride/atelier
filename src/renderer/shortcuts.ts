// Shortcuts shown in Settings › Keyboard (read-only). A test checks that all the menu ones are present. Loaded with the
// Keyboard section (components/SettingsKeyboard.tsx), never the first paint.
import { acceleratorFor, formatAccelerator } from '@shared/keys';
import { kbdText } from './kbd';
import { windowsWords } from '@shared/windows-words';
import { currentPlatform, type Platform } from '@shared/platform';

export interface Shortcut { keys: string; label: string }
export interface ShortcutGroup { title: string; items: Shortcut[] }

/** kbd.ts's (the first paint labels keys with it, without this list); here too for the list's tests. */
export { keysOf } from './kbd';

/**
 * A row: `accel` when it is a menu accelerator (its label follows the platform), else the
 * keys as written (macOS text; the Windows keymap rewrites these).
 */
/** macOnly: a key Windows has natively otherwise (⌘←/⌘→: Home and End), left out there. */
type Row = { label: string; macOnly?: true } & ({ accel: string } | { keys: string });

const ROWS: { title: string; items: Row[] }[] = [
  { title: 'Sessions & Terminals', items: [
    { accel: 'CmdOrCtrl+N', label: 'New Claude session' },
    { keys: '⌥⏎', label: 'In New Session: start without your launch flags' },
    { accel: 'CmdOrCtrl+T', label: 'New terminal' },
    { accel: 'CmdOrCtrl+Alt+Shift+N', label: 'New session in a folder' },
    { accel: 'CmdOrCtrl+Shift+N', label: 'Resume a session' },
    { accel: 'CmdOrCtrl+Alt+Enter', label: 'Schedule a prompt for the session in front' },
    { keys: 'task:', label: 'Your tasks (in the palette, when connected): Enter starts a session with the task typed in' },
    { keys: '⌘⏎', label: 'On a task in the palette: start the session and send the task' },
    { accel: 'CmdOrCtrl+J', label: 'Next session needing attention (needs you, then ready for review)' },
    { accel: 'CmdOrCtrl+Shift+J', label: 'Notifications' },
    { keys: '⌥Space', label: 'Dictate (hold to talk, tap for hands-free; when enabled)' },
    { keys: '⌥⇧Space', label: 'Dictate without polishing' },
    { accel: 'CmdOrCtrl+0', label: 'Back to the terminal' },
    { keys: '⌘← ⌘→', label: 'Start or end of the line (in terminals)', macOnly: true },
    { keys: '⌘↑ ⌘↓', label: 'Previous or next command (Atelier-profile terminals, command blocks on)' },
    // By accelerator, so Windows shows the terminal-first rule's Ctrl+Shift+F.
    { accel: 'CmdOrCtrl+F', label: 'Find in the terminal (⏎ older match, ⇧⏎ newer)' },
    { keys: '⇧-right-click', label: 'Atelier’s terminal menu when a program uses the mouse (tmux, vim): a plain right-click is the program’s' }
  ] },
  { title: 'Tabs', items: [
    { accel: 'Ctrl+Tab', label: 'Next tab' },
    { accel: 'Ctrl+Shift+Tab', label: 'Previous tab' },
    { keys: '⌘1…9', label: 'Go to tab (⌘9: last)' },
    { accel: 'CmdOrCtrl+W', label: 'Close tab' },
    { accel: 'Ctrl+Cmd+N', label: 'New window (another project)' },
    { accel: 'CmdOrCtrl+Shift+W', label: 'Close window' }
  ] },
  // Workspaces: when the project uses them.
  { title: 'Workspaces', items: [
    { keys: '⌘⌥1…9', label: 'Go to workspace (in the sidebar’s order)' },
    { accel: 'CmdOrCtrl+Alt+T', label: 'New workspace' },
    { keys: '#', label: 'Workspaces in the palette: ⏎ goes there, ⌥⏎ moves the tab in front there, ⌘⏎ starts a session in it' }
  ] },
  { title: 'Files & Editor', items: [
    { accel: 'CmdOrCtrl+Alt+N', label: 'New file' },
    { accel: 'CmdOrCtrl+S', label: 'Save' },
    { accel: 'CmdOrCtrl+Alt+S', label: 'Save all' },
    { accel: 'CmdOrCtrl+O', label: 'Open folder' },
    { accel: 'CmdOrCtrl+Alt+O', label: 'Open file' },
    { accel: 'CmdOrCtrl+Alt+R', label: 'Reveal in Finder (a terminal: the folder it is in now)' },
    { keys: '⌘F', label: 'Find in file' },
    { keys: '⌥⌘F', label: 'Find and replace' },
    { keys: '⏎ ⇧⏎', label: 'Next or previous match (in Find)' },
    { keys: '⌥⏎', label: 'Select all matches (in Find)' },
    { keys: '⌘⏎', label: 'Replace all (in Replace)' },
    { keys: '⌥C ⌥W ⌥R', label: 'Match case, whole word, regular expression (in Find)' },
    { keys: '⌥Z', label: 'Word wrap on or off (in the editor and diffs; also View › Word Wrap)' },
    { keys: '⌘/', label: 'Toggle comment' },
    { keys: '⌘D', label: 'Select next occurrence' },
    { keys: '⌘⇧L', label: 'Select all matches' },
    { keys: '⌘L', label: 'Mention the selected lines in the Claude session' },
    { accel: 'CmdOrCtrl+Alt+C', label: 'Comment on the selected lines (editor, diff and review)' },
    { accel: 'Alt+F5', label: 'Next change in the file (Diff view or margin marks)' },
    { accel: 'Alt+Shift+F5', label: 'Previous change in the file' },
    { accel: 'CmdOrCtrl+Shift+V', label: 'Toggle Markdown preview, JSON tree or CSV table' },
    { keys: '⌥⌘[ ⌥⌘]', label: 'Fold or unfold the block at the cursor (JSON)' },
    { keys: '⌃⌥[ ⌃⌥]', label: 'Fold or unfold everything (JSON)' },
    { keys: '⌥⇧⌘C', label: 'Copy the JSON path of the value at the cursor or selected in the tree' },
    { keys: ':n', label: 'Go to line (in the palette)' }
  ] },
  { title: 'JSON Tree', items: [
    { keys: '↑ ↓', label: 'Previous or next row' },
    { keys: '← →', label: 'Collapse or go to the parent, expand or go to the first child' },
    { keys: '⌥← ⌥→', label: 'Collapse or expand everything inside (also ⌥-click)' },
    { keys: '⏎', label: 'Collapse or expand (also double-click)' },
    { keys: '⌥⏎', label: 'Show in Source' },
    { keys: '⌘C', label: 'Copy the value' },
    { keys: '⌘F', label: 'Filter keys and values' }
  ] },
  { title: 'CSV Table', items: [
    { keys: '↑ ↓ ← →', label: 'Move the selected cell (⇧ extends the range)' },
    { keys: '⌘↑ ⌘↓', label: 'First or last row' },
    { keys: '⌘A', label: 'Select every cell' },
    { keys: '⌘C', label: 'Copy the cells (as TSV: they paste as cells)' },
    { keys: '⌥⏎', label: 'Show in Source (also double-click)' },
    { keys: 'Space', label: 'Peek at the whole value of the cell' },
    { keys: '⌃G', label: 'Go to a row or a cell' },
    { keys: 'F8 ⇧F8', label: 'Next or previous row that doesn\'t match the header' },
    { keys: '⌥-click', label: 'Add a column to the sort (on its header)' },
    { keys: '⌘F', label: 'Filter rows' },
    { keys: '⌘L', label: 'Mention the selected rows in the Claude session' }
  ] },
  { title: 'Databases', items: [
    { keys: '⌘R', label: 'Refresh a table tab (its rows again, from the top)' },
    { keys: '↑ ↓', label: 'Previous or next row (more rows load at the end)' },
    { keys: '⇧↑ ⇧↓', label: 'Extend the selected rows (also ⇧-click; ⌘-click adds or removes one)' },
    { keys: '⌘A', label: 'Select every row loaded' },
    { keys: 'Esc', label: 'Clear the selected rows' },
    { keys: '⏎', label: 'Show or hide the row inspector (also double-click)' },
    { keys: '⇥', label: 'Open the row as a record (there ↑ ↓ move the rows); Tab or Esc returns' },
    { keys: '⌘C', label: 'Copy the cell’s value (one row selected), or the rows as TSV' },
    { keys: '⌥↩', label: 'Send the selected rows (or the focused one) to the session, typed into its prompt' },
    { keys: '⌥Z', label: 'Wrap cells on or off (six lines a row)' },
    { keys: '⇧-click', label: 'Add a column to the sort (on its header; a click sorts by it alone)' },
    { keys: '⌘⏎', label: 'On a table in the palette: open it as a kept tab (⏎: a preview)' }
  ] },
  { title: 'Review', items: [
    { keys: '↑ ↓', label: 'Previous or next hunk (also k and j)' },
    { keys: 'n p', label: 'Next or previous file' },
    { keys: '⏎', label: 'Open the file at that change' },
    { keys: '⌥-click', label: 'Collapse or expand every file' }
  ] },
  { title: 'View', items: [
    { accel: 'CmdOrCtrl+K', label: 'Search sessions, files and commands' },
    { accel: 'F1', label: 'Command palette' },
    { accel: 'CmdOrCtrl+Shift+P', label: 'Command palette' },
    { accel: 'CmdOrCtrl+Shift+1', label: 'Sessions' },
    { accel: 'CmdOrCtrl+Shift+2', label: 'Files' },
    { accel: 'CmdOrCtrl+Shift+3', label: 'Services' },
    { accel: 'Ctrl+Shift+G', label: 'Source Control' },
    { accel: 'Ctrl+Shift+D', label: 'Docker (read-only containers, logs and engine)' },
    { accel: 'Ctrl+Shift+R', label: 'Redis (keys, queues, live monitor of local instances)' },
    { accel: 'Ctrl+Shift+B', label: 'Databases (read-only PostgreSQL: tables, structure, activity)' },
    { accel: 'CmdOrCtrl+Shift+A', label: 'Automations (start Claude from new tasks)' },
    { keys: '⌥↩', label: 'Redis: send the open key or job to the session' },
    { accel: 'CmdOrCtrl+Shift+M', label: 'Changes panel' },
    { accel: 'CmdOrCtrl+B', label: 'Sidebar (also: click the view in front in the activity bar)' },
    { accel: 'CmdOrCtrl+Alt+B', label: 'Background of the session (agents, shells, monitors, scheduled)' },
    { accel: 'CmdOrCtrl+I', label: 'Ask about the focused session (read-only)' },
    { accel: 'CmdOrCtrl+\\', label: 'Split right (up to three panes)' },
    { accel: 'CmdOrCtrl+Shift+O', label: 'Move the tab to a window of its own (in that window: move it back)' },
    { accel: 'CmdOrCtrl+Alt+Right', label: 'Focus next pane' },
    { accel: 'CmdOrCtrl+Alt+Left', label: 'Focus previous pane' },
    { accel: 'Ctrl+Cmd+Left', label: 'Move the tab to the left pane (from the first pane: a new pane)' },
    { accel: 'Ctrl+Cmd+Right', label: 'Move the tab to the right pane (from the last pane: a new pane)' },
    { keys: '⇧F10', label: 'Context menu of the focused item' }
  ] },
  { title: 'Source Control', items: [
    { accel: 'Ctrl+Shift+G', label: 'Source Control (history, branches, sync)' },
    { keys: '⌘F', label: 'Filter commits (History tab focused)' },
    { keys: '↑ ↓', label: 'Move between commits (also j and k)' },
    { keys: '⏎', label: 'To the changed files' },
    { keys: 'n p', label: 'Next or previous changed file of the commit' },
    { keys: '⌘C', label: 'Copy the commit SHA (list focused)' },
    { keys: '⌥-click', label: 'On a branch: compare with the default branch' }
  ] },
  { title: 'Git', items: [
    { accel: 'CmdOrCtrl+Alt+K', label: 'Commit (opens the commit drawer in Changes)' },
    { keys: '⌘⏎', label: 'Commit (in the commit drawer)' },
    { accel: 'CmdOrCtrl+Alt+M', label: 'Write the commit message with Claude (Esc stops it)' },
    { keys: 'Esc', label: 'Close the commit drawer (the message is kept)' }
  ] },
  { title: 'App', items: [
    { accel: 'CmdOrCtrl+,', label: 'Settings' },
    { keys: '⌘[', label: 'Settings › Connectors: from a connector’s details, back to the list' }
  ] }
];

export function buildShortcuts(platform: Platform): ShortcutGroup[] {
  // Windows: the menu rows take its keymap (none: no row), the written rows and the
  // labels have their glyphs and places converted, macOS-only rows go. macOS: the list as it always was.
  const text = (s: string) => (platform === 'win32' ? windowsWords(kbdText(s, platform)) : kbdText(s, platform));
  return ROWS.map((g) => ({
    title: g.title,
    items: g.items.flatMap((r) => {
      if (r.macOnly && platform !== 'darwin') return [];
      if ('accel' in r) {
        const a = acceleratorFor(r.accel, platform);
        return a ? [{ keys: formatAccelerator(a, platform), label: text(r.label) }] : [];
      }
      return [{ keys: text(r.keys), label: text(r.label) }];
    })
  })).filter((g) => g.items.length > 0);
}

export const SHORTCUTS: ShortcutGroup[] = buildShortcuts(currentPlatform());
