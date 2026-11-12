import type { MenuCommand, MenuState } from './api';

// The application menu as data: labels, Electron accelerators, the MenuCommand each item sends
// to the renderer, separators and platform roles. src/main/menu.ts builds the native menu from it; the website's
// demo builds its menu bar and accelerator map from it, so a new item reaches both. Pure data, no Electron: it
// compiles for the main process and the renderer alike.

/** Items macOS (Electron) supplies: label, key and behavior are the platform's; the demo draws or skips them. */
export type MenuItemRole = 'about' | 'services' | 'hide' | 'hideOthers' | 'unhide' | 'quit' | 'close' | 'reload' | 'toggleDevTools' | 'togglefullscreen';
/** Whole menus the platform supplies. */
export type MenuRole = 'editMenu' | 'windowMenu';
/** Clicks handled in the main process instead of a MenuCommand to the window: menu.ts maps each to its handler. */
export type MenuAction = 'check-for-updates' | 'new-window' | 'open-folder' | 'restart-daemon';
/**
 * State the menu is built with. 'profiles': the running atelierd supports terminal profiles (an older one doesn't).
 * The front window's (MenuState): 'git-undo', its project has a commit main still offers an Undo
 * for; 'git-repos', its project has a repository; 'git-writes', Git actions are on (not Read-only);
 * 'git-messages', Git actions on and messages with Claude on. 'word-wrap': the editors wrap long lines (main's settings).
 */
export type MenuCondition = 'profiles' | 'git-undo' | 'git-repos' | 'git-writes' | 'git-messages' | 'workspaces' | 'project' | 'services' | 'automations' | 'ws-toggle' | 'word-wrap';

/** The menu state before any window said anything (and for a window that never does): no repository, no Git menu. */
export const NO_MENU_STATE: MenuState = { gitUndo: false, hasRepos: false, gitWrites: false, messages: false };

/**
 * when 'development': only in unpackaged builds (the app's dev runs); the demo is a release, so it skips them.
 * visibleWhen: hidden (no row; the item stays in the menu, so its key still reaches the renderer) without it.
 */
interface Common { when?: 'development'; visibleWhen?: MenuCondition }
export type MenuSpecItem = Common & (
  | { type: 'separator' }
  | { role: MenuItemRole; label?: string; accelerator?: string }
  /**
   * visible false: no row, the key still works. enabledWhen: disabled (still shown, discoverable) without it.
   * checkedWhen: a checkbox, checked while it holds; the command switches what it shows (View › Word Wrap).
   */
  | { label: string; accelerator?: string; command: MenuCommand; id?: string; visible?: false; enabledWhen?: MenuCondition; checkedWhen?: MenuCondition }
  | { label: string; accelerator?: string; action: MenuAction; id?: string }
  /**
   * A submenu filled at build time: 'profiles' = one item per terminal profile, sending new-terminal-profile:<key>;
   * 'accounts' = one per Claude account, sending new-session-account:<id>, shown only with two or more accounts.
   */
  | { label: string; dynamicSubmenu: 'profiles' | 'accounts'; enabledWhen?: MenuCondition }
  /** Items filled at build time in place: 'workspaces' = one per workspace of the front window,
   *  sending workspace-<index>, ⌘⌥1…9 on the first nine, the active one checked; none while workspaces are off. */
  | { dynamicItems: 'workspaces' }
);
/** app: the application menu, titled with the app's name (app.name natively). visibleWhen: the whole menu. */
export type MenuSpecMenu = { label: string; app?: true; visibleWhen?: MenuCondition; submenu: readonly MenuSpecItem[] } | { role: MenuRole };

const sep = { type: 'separator' } as const;

// Typed, not inferred: a command outside MenuCommand, a typo in a role or an item doing two things fails to compile.
export const MENU_SPEC: readonly MenuSpecMenu[] = [
  { label: 'Atelier', app: true, submenu: [
    { role: 'about' },
    { id: 'check-for-updates', label: 'Check for Updates…', action: 'check-for-updates' },
    { label: "What's New…", command: 'whats-new' },
    sep,
    { label: 'Settings…', accelerator: 'CmdOrCtrl+,', command: 'open-settings' },
    { label: 'Connectors…', command: 'open-connectors' },
    sep,
    // The `atelier` shell command.
    { label: "Install 'atelier' Command", command: 'install-shell-command' },
    { label: "Uninstall 'atelier' Command", command: 'uninstall-shell-command' },
    sep,
    { role: 'services' },
    sep,
    { role: 'hide' },
    { role: 'hideOthers' },
    { role: 'unhide' },
    sep,
    { role: 'quit' }
  ] },
  { label: 'File', submenu: [
    { label: 'New Claude Session', accelerator: 'CmdOrCtrl+N', command: 'new-session' },
    // Claude accounts: hidden while there is only the default account.
    { label: 'New Session with Account', dynamicSubmenu: 'accounts' },
    { label: 'New Terminal', accelerator: 'CmdOrCtrl+T', command: 'new-terminal' },
    // In the "N starts something" family, whose two-modifier keys are all taken.
    { label: 'New Session in Folder…', accelerator: 'CmdOrCtrl+Alt+Shift+N', command: 'new-session-in-folder' },
    { label: 'New Terminal in Folder…', command: 'new-terminal-in-folder' },
    // Without profile support the entries stay visible (discoverable) but disabled; Settings › Terminal explains.
    { label: 'New Terminal with Profile', dynamicSubmenu: 'profiles', enabledWhen: 'profiles' },
    { label: 'Resume Session…', accelerator: 'CmdOrCtrl+Shift+N', command: 'resume-session' },
    { label: 'Start Session from Task…', command: 'start-from-task' },
    // Scheduled prompts: the session in front; ⌘⌥↵ = "send, but later".
    { label: 'Schedule Prompt…', accelerator: 'CmdOrCtrl+Alt+Enter', command: 'schedule-prompt' },
    // The selected session quits and resumes in its own terminal (no default shortcut).
    { label: 'Restart Session', command: 'restart-session' },
    // What fills the selected session's context (no default shortcut).
    { label: 'Context Usage…', command: 'context-usage' },
    { label: 'New File', accelerator: 'CmdOrCtrl+Alt+N', command: 'new-file' },
    // Workspaces: shown while the window's project has them on (its key reaches the page
    // either way, which ignores it then).
    { label: 'New Workspace…', accelerator: 'CmdOrCtrl+Alt+T', command: 'new-workspace', visibleWhen: 'workspaces' },
    sep,
    { label: 'Save', accelerator: 'CmdOrCtrl+S', command: 'save' },
    { label: 'Save All', accelerator: 'CmdOrCtrl+Alt+S', command: 'save-all' },
    sep,
    { id: 'new-window', label: 'New Window', accelerator: 'Ctrl+Cmd+N', action: 'new-window' },
    { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', action: 'open-folder' },
    // Any file of the Mac: ⌘O stays the folder.
    { label: 'Open File…', accelerator: 'CmdOrCtrl+Alt+O', command: 'open-file' },
    // The tab in front in Finder (a terminal: the folder it is in now; a file: the file selected).
    { label: 'Reveal in Finder', accelerator: 'CmdOrCtrl+Alt+R', command: 'reveal-in-finder' },
    sep,
    { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', command: 'close-tab' },
    sep,
    { label: 'Reload Shell Environment', command: 'reload-shell-env', enabledWhen: 'profiles' },
    { label: 'Restart atelierd (closes all sessions)…', action: 'restart-daemon' },
    { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' }
  ] },
  { role: 'editMenu' },
  { label: 'View', submenu: [
    { label: 'Search…', accelerator: 'CmdOrCtrl+K', command: 'open-palette' },
    // The palette also opens with F1 and ⌘⇧P.
    { label: 'Command Palette', accelerator: 'F1', command: 'open-palette' },
    { label: 'Command Palette', accelerator: 'CmdOrCtrl+Shift+P', command: 'open-palette', visible: false },
    sep,
    { label: 'Sessions', accelerator: 'CmdOrCtrl+Shift+1', command: 'view-sessions' },
    { label: 'Files', accelerator: 'CmdOrCtrl+Shift+2', command: 'view-files' },
    // ⇧⌘F, Shift+Alt+F on Windows (its keymap: Ctrl+Shift+F is a terminal's find). F4 / ⇧F4 through the results are the
    // page's own keys (App.tsx), never the menu's: a terminal keeps them.
    { label: 'Find in Files', accelerator: 'CmdOrCtrl+Shift+F', command: 'find-in-files' },
    // Services and Automations (2026-11-02): only once turned on in Settings (main adds them to the window's state).
    { label: 'Services', accelerator: 'CmdOrCtrl+Shift+3', command: 'view-services', visibleWhen: 'services' },
    // Source Control: ⌃⇧G, not ⌘⇧4 (macOS's screenshot shortcut never reaches the app).
    { label: 'Source Control', accelerator: 'Ctrl+Shift+G', command: 'view-scm' },
    // Docker: ⌃⇧D like Source Control's ⌃⇧G (⌘⇧4 and ⌘⇧5 are macOS screenshots).
    { label: 'Docker', accelerator: 'Ctrl+Shift+D', command: 'view-docker' },
    // Redis: ⌃⇧R, next to Docker's ⌃⇧D (no menu or window shortcut uses it; xterm sends ⌃R for it).
    { label: 'Redis', accelerator: 'Ctrl+Shift+R', command: 'view-redis' },
    // Databases: ⌃⇧B, free (⌃⇧D is Docker's); like ⌃⇧R, a terminal loses that chord's ^B.
    { label: 'Databases', accelerator: 'Ctrl+Shift+B', command: 'view-databases' },
    { label: 'Automations', accelerator: 'CmdOrCtrl+Shift+A', command: 'view-automations', visibleWhen: 'automations' },
    { label: 'Show History', command: 'show-history' },
    { label: 'Background', accelerator: 'CmdOrCtrl+Alt+B', command: 'show-background' },
    { label: 'Back to Terminal', accelerator: 'CmdOrCtrl+0', command: 'show-terminal' },
    // The selected terminal's screen again from atelierd: a view out of step (Claude's box over stale rows) without a restart.
    { label: 'Redraw Terminal', command: 'redraw-terminal' },
    { label: 'Changes', accelerator: 'CmdOrCtrl+Shift+M', command: 'toggle-changes' },
    // Shows or hides the sidebar, ⌘B; Windows: Shift+Alt+B (keys.ts).
    { label: 'Sidebar', accelerator: 'CmdOrCtrl+B', command: 'toggle-sidebar' },
    { label: 'Swap Side Panels', command: 'swap-side-panels' },
    { label: 'Change Theme…', command: 'change-theme' },
    { label: 'Change Terminal Font…', command: 'change-terminal-font' },
    { label: 'Group Sessions by State', command: 'toggle-group-by-state' },
    // Workspaces: on or off for this window's project, as in Settings › Appearance;
    // disabled while Settings turns them on in every project (2026-11-02).
    { label: 'Toggle Workspaces for This Project', command: 'toggle-workspaces', enabledWhen: 'ws-toggle' },
    { label: 'Notifications', accelerator: 'CmdOrCtrl+Shift+J', command: 'show-notifications' },
    // Session panel: the selected session's model, mode and quick actions (no shortcut).
    { label: 'Session Panel', command: 'session-panel' },
    // Ask: toggles the focused session's read-only companion; ⌘I takes CodeMirror's "select
    // parent syntax". Windows: Ctrl+Shift+I, so the development-only DevTools role moves to F12.
    { label: 'Ask About This Session', accelerator: 'CmdOrCtrl+I', command: 'ask-session' },
    { label: 'Scheduled Prompts', command: 'scheduled-prompts' },
    sep,
    // Word wrap in every editor: the setting, ✓ while on. No key here: ⌥Z is the
    // editors' own (a menu key would fire from terminals too, where ⌥Z types a character).
    { label: 'Word Wrap', command: 'toggle-word-wrap', checkedWhen: 'word-wrap' },
    // Markdown preview and JSON tree: the tab in front; ⇧⌘V.
    { label: 'Toggle Preview', accelerator: 'CmdOrCtrl+Shift+V', command: 'md-toggle-preview' },
    { label: 'Split Preview', command: 'md-split' },
    { label: 'Markdown Outline', command: 'md-outline' },
    sep,
    // Split view with tab groups: up to three panes side by side, each with its own tabs.
    { label: 'Split Right', accelerator: 'CmdOrCtrl+\\', command: 'split-right' },
    { label: 'Focus Next Pane', accelerator: 'CmdOrCtrl+Alt+Right', command: 'focus-next-pane' },
    { label: 'Focus Previous Pane', accelerator: 'CmdOrCtrl+Alt+Left', command: 'focus-prev-pane' },
    // The focused pane's tab in front to the next pane on that side (a new pane from the edge pane).
    { label: 'Move Tab to Left Pane', accelerator: 'Ctrl+Cmd+Left', command: 'move-tab-left' },
    { label: 'Move Tab to Right Pane', accelerator: 'Ctrl+Cmd+Right', command: 'move-tab-right' },
    // "Unsplit": the pane goes, its tab stays open (the old "close" wording read as closing the tab).
    { label: 'Unsplit', command: 'close-pane' },
    { label: 'Unsplit All', command: 'close-other-panes' },
    sep,
    // Tab pop-out windows: ⇧⌘O toggles — in a pop-out it moves the tab back.
    { label: 'Move Tab to New Window', accelerator: 'CmdOrCtrl+Shift+O', command: 'move-tab-window' },
    { label: 'Move Tab Back to Main Window', command: 'move-tab-back' },
    sep,
    // Reload and developer tools only in development: an accidental ⌘R must not throw away work.
    { role: 'reload', when: 'development' },
    { role: 'toggleDevTools', when: 'development' },
    { type: 'separator', when: 'development' },
    { role: 'togglefullscreen' }
  ] },
  // Git writes: only for a project with a repository. ⌥⌘K, not ⌥⌘C (Comment on Selection). In
  // Read-only only Fetch and Fetch All show, as before. The commands act on Source Control's selected repository.
  { label: 'Git', visibleWhen: 'git-repos', submenu: [
    { label: 'Commit…', accelerator: 'CmdOrCtrl+Alt+K', command: 'git-commit', visibleWhen: 'git-writes' },
    // Commit all: every repository with staged files, in one sheet.
    { label: 'Commit All Repositories…', command: 'git-commit-all', visibleWhen: 'git-writes' },
    // ✦: opens the drawer if needed and writes its target's message; again while it writes stops it.
    { label: 'Write Commit Message with Claude', accelerator: 'CmdOrCtrl+Alt+M', command: 'git-write-message', visibleWhen: 'git-messages' },
    // Shown (discoverable), enabled only while main offers the Undo: the commit just made, still HEAD, not pushed.
    { id: 'git-undo-commit', label: 'Undo Last Commit', command: 'git-undo-commit', enabledWhen: 'git-undo', visibleWhen: 'git-writes' },
    { type: 'separator', visibleWhen: 'git-writes' },
    // Sync: as the sidebar's split button.
    { label: 'Push', command: 'git-push', visibleWhen: 'git-writes' },
    { label: 'Pull', command: 'git-pull', visibleWhen: 'git-writes' },
    { label: 'Sync', command: 'git-sync', visibleWhen: 'git-writes' },
    { label: 'Sync All Repositories', command: 'git-sync-all', visibleWhen: 'git-writes' },
    { type: 'separator', visibleWhen: 'git-writes' },
    // Fetch (moved from View): the selected repository, or every one of the project with a remote.
    { label: 'Fetch', command: 'fetch' },
    { label: 'Fetch All Repositories', command: 'fetch-all' },
    { type: 'separator', visibleWhen: 'git-writes' },
    // Branches and stashes.
    { label: 'New Branch…', command: 'git-new-branch', visibleWhen: 'git-writes' },
    { label: 'Switch to Branch…', command: 'git-switch-branch', visibleWhen: 'git-writes' },
    { label: 'Stash Changes…', command: 'git-stash', visibleWhen: 'git-writes' }
  ] },
  { label: 'Go', submenu: [
    { label: 'Next Session Needing Attention', accelerator: 'CmdOrCtrl+J', command: 'next-attention' },
    // Workspaces: the front window's, while its project has them on.
    { type: 'separator', visibleWhen: 'workspaces' },
    { dynamicItems: 'workspaces' },
    { label: 'Next Workspace', command: 'next-workspace', visibleWhen: 'workspaces' },
    { label: 'Previous Workspace', command: 'prev-workspace', visibleWhen: 'workspaces' },
    sep,
    // The changes of the file in front (Diff view or margin marks).
    { label: 'Next Change', accelerator: 'Alt+F5', command: 'next-change' },
    { label: 'Previous Change', accelerator: 'Alt+Shift+F5', command: 'prev-change' },
    sep,
    { label: 'Next Tab', accelerator: 'Ctrl+Tab', command: 'next-tab' },
    { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', command: 'prev-tab' },
    sep,
    ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => ({ label: n === 9 ? 'Last Tab' : `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`, command: `tab-${n}` as const }))
  ] },
  // Review loop: read what the sessions changed.
  { label: 'Review', submenu: [
    { label: 'Review Selected Session', command: 'review-session' },
    { label: 'Review All Changes', command: 'review-all' },
    sep,
    // ⌘L stays "mention the lines" and ⌘⇧L the editor's "select all matches"; ⌘⌥C writes a comment on them.
    { label: 'Comment on Selection', accelerator: 'CmdOrCtrl+Alt+C', command: 'comment-selection' },
    { label: 'Send Review to Session', command: 'send-review' }
  ] },
  { role: 'windowMenu' }
];

/** Every item of every menu, flat and in order (hidden and development-only ones included). */
export function menuItems(spec: readonly MenuSpecMenu[]): MenuSpecItem[] {
  return spec.flatMap((m) => ('submenu' in m ? [...m.submenu] : []));
}
