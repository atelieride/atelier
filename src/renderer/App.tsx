import { lazy, Suspense, useEffect, useMemo, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { ActivityBar } from './components/ActivityBar';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { Tabs } from './components/Tabs';
import { Welcome } from './components/Welcome';
import { TerminalView } from './terminal/TerminalView';
import { FileView } from './editor/FileView';
import { ImageView } from './editor/ImageView';
import { VideoView } from './editor/VideoView';
import { imageMime, videoMime } from '@shared/files';
import { isUntitled } from './untitled';
import { ChangesPanel } from './components/ChangesPanel';
import { ServicesView } from './components/ServicesView';
import { ReviewView } from './components/ReviewView';
import { HistoryView } from './scm/HistoryView';
import { RevFileView } from './scm/RevFileView';
import { BackgroundView } from './components/background/BackgroundView';
import { showBackground } from './background-command';
import { RefPicker } from './scm/RefPicker';
import { reviewSelected, sendSelectedReview } from './menus';
import { openSelectedSessionPanel } from './session-panel';
import { restartSelected } from './restart-actions';
import { openSelectedContextSheet } from './context-actions';
import { commentOnSelection } from './comment-targets';
import { goToChange } from './change-targets';
import { revealActive } from './reveal';
import { findInFilesCommand, installSearchKeys, stepFromPopout } from './search/open';
import { Palette } from './components/Palette';
import { SessionBar, type PaneSlot } from './components/SessionBar';
import { PanePicker } from './components/PanePicker';
import { ContextMenu } from './components/ContextMenu';
import { BackgroundPopover } from './components/BackgroundPopover';
import { SchedulePopover } from './components/SchedulePopover';
import { ScheduleSheet } from './components/ScheduleSheet';
import { ScheduleCountdown } from './components/ScheduleCountdown';
import { installScheduleRouting, scheduleNoticeToast, scheduleSelected } from './schedules';
import { Tooltip } from './components/Tooltip';
import { Toast } from './components/Toast';
import { DropPill } from './components/DropPill';
import { installFileDrop } from './file-drop';
import { applyOpenPaths } from './open-paths';
import { runShellCommand } from './shell-command';
import { openNewMenu } from './menus';
import { cycle, nth, type TabKey } from './tabs-model';
import { fronts, gridColumns, paneCell } from './split';
import { PaneDivider } from './components/PaneDivider';
import { PaneDropLayer } from './components/PaneDropLayer';
import { goToAttention, seenNow } from './attention-nav';
import { viewingNow } from './notes';
import { dirtyPaths, saveMany, saveOne } from './editor/savers';
import { Logo } from './components/Logo';
import { WorkspaceEmpty } from './components/WorkspaceEmpty';
import { SpaceEmpty } from './components/SpaceEmpty';
import { stepWorkspace } from './workspace-menus';
import { NewWorkspaceSheet } from './components/NewWorkspaceSheet';
import { Icon } from './components/Icon';
import { disposeLiveTerminal, redrawTerminal, resetTerminal, writeToTerminal } from './terminal/registry';
import { t } from './i18n/en';
import { NO_TAB, useApp } from './store';
import { treeChanged } from './tree-refresh';
import { sameAsLast } from './same-as-last';
import { usageKey } from '@shared/session';
import { adoptSettings } from './settings-live';
import { Settings } from './components/Settings';
import { NewSession } from './components/NewSession';
import { FolderSheet } from './components/FolderSheet';
import { SaveAsSheet } from './components/SaveAsSheet';
import { LanguageSheet } from './components/LanguageSheet';
import { GitSheets } from './git/GitSheets';
import { CommitAllSheet } from './git/CommitAllSheet';
import { newSessionIn, newTerminalIn, reloadShellEnv } from './launch';
import { useAccountOffers } from './accounts';
import { autoReloadToast } from './shell-env-auto';
import { Resizer } from './components/Resizer';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DictationPill } from './dictation/DictationPill';
import { currentDictationTarget, installDictationKeys, noteSelection } from './dictation/controller';
import { dictationPane } from './dictation/target';
import { blurStrayFocus, installFocusReturn } from './pane-focus';
import { isStarting } from './starting';
import { isWaiting } from '@shared/session-view';
import { loadTaskLists } from './task-session';
import { tasksKey } from './task-view';
import { installScm, loadSearch, withScm } from './scm/data';
import { installGit, openCommitDrawer, undoLastCommit } from './git/actions';
import { writeMessageCommand } from './git/message-run';
import { runGitCommand } from './git/commands';
import { fetchAll, fetchSelected, showHistory } from './scm/actions';
import { installDocker } from './docker/install';
import { DockerView } from './docker/DockerView';
import { installRedis } from './redis/install';
import { installDatabases } from './databases/install';
import { DbSheetsHost } from './databases/DbSheetsHost';
import { RedisView } from './redis/RedisView';
import { redisKey } from './redis/tabs';
import { Confirms } from './confirms/Confirms';
import { saveFromKeys } from './confirms/UnsavedHost';
import { blocksUnload, hasUnsaved, unsavedReporter } from './confirms/unload';
import { RunStrip } from './automations/RunStrip';
import { loadAutomations } from './automations/actions';
import { RedisSheets, UndoPill } from './redis/RedisSheets';
import { installStorageSync } from './storage-sync';
import { setActivePreviewView, toggleMarkdownOutline, togglePreview } from './markdown-commands';
import { PopoutWindow } from './components/PopoutWindow';
import { moveBack } from './popout-actions';
import { dockTargetAt, paneSize } from './dock-target';
import { putHandoff } from './editor/handoff';
import { toggleWordWrap } from './editor/word-wrap';
import { CONNECTOR_IDS } from '@shared/tasks';
import { TitleBar, useWindowsMenu } from './components/MenuBar';
import { currentPlatform } from '@shared/platform';

/** Windows: no system title bar, ours instead. */
const windowsFrame = currentPlatform() === 'win32';
import { kbd } from './kbd';
import { servicesView } from './features';
import { applyAdopt } from './move-window';
import { leftTheList } from './terminal-left';
import type { TerminalInfo } from '@shared/protocol';
import { AskHost } from './components/companion/AskHost';
import { ASK_INSET } from './components/companion/inset';
import { askSelected } from './companion/actions';
import { sheetIn } from './companion/view';
// Change Terminal Font… loads on its first opening: it stays out of the first paint (the live demo's budget).
const FontSheet = lazy(() => import('./components/FontSheet').then((m) => ({ default: m.FontSheet })));
// Context usage: lazy, with its own CSS, out of the first paint (the live demo's budget).
const ContextSheet = lazy(() => import('./components/ContextSheet').then((m) => ({ default: m.ContextSheet })));
// Automations are opt-in (2026-11-02): their view and sheets load on first use, out of the first paint (the live
// demo's budget, tests/integration/demo-build.test.ts).
const AutomationsView = lazy(() => import('./automations/AutomationsView').then((m) => ({ default: m.AutomationsView })));
const AutomationEditor = lazy(() => import('./automations/AutomationEditor').then((m) => ({ default: m.AutomationEditor })));
const TurnOnSheet = lazy(() => import('./automations/TurnOnSheet').then((m) => ({ default: m.TurnOnSheet })));
const CloseRunSheet = lazy(() => import('./automations/CloseRunSheet').then((m) => ({ default: m.CloseRunSheet })));
// What's New brings CHANGELOG.md (34 KB): it loads when it opens, out of the first paint (the live demo's budget; 2026-11-02).
const WhatsNew = lazy(() => import('./components/WhatsNew').then((m) => ({ default: m.WhatsNew })));
// A table tab's view: loads with the first table opened, out of the first paint (the live demo's
// budget) — the table and the overview it shows come with it.
const DbTabView = lazy(() => import('./databases/DbTabView').then((m) => ({ default: m.DbTabView })));
// "Who changed this?" opens from a menu or Changes' "why": it loads then, out of the first paint (the live demo's budget,
// when Changes' sync arrows came in; 2026-11-08).
const OriginSheet = lazy(() => import('./components/OriginSheet').then((m) => ({ default: m.OriginSheet })));
// Change Theme… opens from the menu or the palette: it loads then (the live demo's budget, when hiding the sidebar came
// in; 2026-11-08).
const ThemeSheet = lazy(() => import('./components/ThemeSheet').then((m) => ({ default: m.ThemeSheet })));

/** A divider sits in the columns of the pane on its left, over both rows (header and content), on that pane's right edge. */
const dividerCell = (i: number): CSSProperties => ({ gridColumn: `${i + 1} / ${i + 2}`, gridRow: '1 / 3' });

/** Split view: pointer down anywhere in a pane focuses it, before the terminal, editor or header gets the click (a pane's Close buttons excepted: closing another pane keeps the focus where it is). */
function focusPaneAt(e: ReactPointerEvent<HTMLDivElement>) {
  if ((e.target as HTMLElement).closest?.('[data-pane-keep]')) return;
  for (const el of e.currentTarget.querySelectorAll<HTMLElement>(':scope > .pane-frame')) {
    const r = el.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX < r.right) { useApp.getState().focusPane(Number(el.dataset.pane)); return; }
  }
}

/**
 * A split-view pane's own pieces: what one pane shows under its strip — a Claude session's
 * session bar (no other pane has a bar; their view takes both rows) — the picker when empty, and its frame (focus and
 * waiting glow).
 */
function PaneChrome({ k, index, focused }: { k: TabKey | null; index: number; focused: boolean }) {
  const term = useApp((s) => (k?.startsWith('t:') ? s.terminals.find((x) => x.id === k.slice(2)) : undefined));
  const starting = useApp((s) => !!term && isStarting(term, s.starting));
  const barred = !!term && (!!term.session || starting);
  const pane: PaneSlot = useMemo(() => ({ index, focused, style: paneCell(index, 'head') }), [index, focused]);
  const body = useMemo(() => paneCell(index, barred ? 'body' : 'full'), [index, barred]);
  // A docked Ask: the waiting glow rings the terminal, not the panel beside it.
  const askDocked = useApp((s) => !!term && s.askDock[term.id] === 'dock');
  return (
    <>
      {barred && <SessionBar term={term} pane={pane} />}
      {/* Its Ask, right after its bar in the keyboard's order; also once Claude exited. */}
      {term && <AskHost terminalId={term.id} place={body} />}
      {k === null && <PanePicker index={index} focused={focused} place={body} />}
      <div className={`pane-frame ${focused ? 'is-focused' : ''} ${isWaiting(term?.session) ? 'is-waiting' : ''}`} data-pane={index}
        style={askDocked ? { ...body, ...ASK_INSET } : body} aria-hidden="true" />
    </>
  );
}

export function App() {
  const project = useApp((s) => s.project);
  const projectLoaded = useApp((s) => s.projectLoaded);
  const popoutMode = useApp((s) => s.popout !== null);
  const terminals = useApp((s) => s.terminals);
  const wsOn = useApp((s) => !!s.ws?.on && !s.popout);
  const wsSheet = useApp((s) => s.wsSheet);
  // Workspaces in every project (Settings): applied once this window has its settings, its saved tabs and
  // atelierd's first list (as a hand on the switch would), then whenever the setting changes.
  const wsEverywhere = useApp((s) => s.settings.workspacesEverywhere);
  const wsReady = useApp((s) => s.settingsLoaded && s.tabsRestored && s.daemon.listed && !!s.project && !s.popout);
  useEffect(() => { if (wsReady) useApp.getState().applyWorkspacesEverywhere(); }, [wsReady, wsEverywhere, project?.root]);
  const selectedId = useApp((s) => s.selectedId);
  const openFiles = useApp((s) => s.openFiles);
  const activeTab = useApp((s) => s.activeTab);
  // Changes belongs to Sessions: another space in front hides it, Sessions brings it back.
  const space = useApp((s) => s.space);
  const showChanges = useApp((s) => s.showChanges && s.space === 'sessions');
  // Hidden: its edge goes with it, the work area takes the width.
  const sidebarHidden = useApp((s) => s.sidebarHidden);
  const servicesOpen = useApp((s) => s.servicesOpen);
  const reviewOpen = useApp((s) => s.review !== null);
  const historyOpen = useApp((s) => s.historyTab !== null);
  const backgroundOpen = useApp((s) => s.backgroundTab !== null);
  const dockerTabs = useApp((s) => s.dockerTabs);
  const redisTabs = useApp((s) => s.redisTabs);
  const autoTabs = useApp((s) => s.autoTabs);
  const automationSheet = useApp((s) => s.automationEditor !== null || s.automationConsent !== null || s.closingRun !== null);
  const revFiles = useApp((s) => s.revFiles);
  const dbTabs = useApp((s) => s.dbTabs);
  const refPicker = useApp((s) => s.refPicker !== null);
  const pastedAt = useApp((s) => s.pastedAt);
  const paletteOpen = useApp((s) => s.paletteOpen);
  const scheduleSheet = useApp((s) => s.scheduleSheet);
  const newSessionOpen = useApp((s) => s.newSessionOpen);
  const newSessionAccount = useApp((s) => s.newSessionAccount);
  const folderSheet = useApp((s) => s.folderSheet);
  const saveAsPath = useApp((s) => s.saveAs?.path ?? null);
  const languageSheet = useApp((s) => s.languageSheet);
  const themeSheet = useApp((s) => s.themeSheet);
  const fontSheet = useApp((s) => s.fontSheet);
  const contextSheet = useApp((s) => s.contextSheet);
  const originSheet = useApp((s) => s.originSheet);
  const panels = useApp((s) => s.panels);
  const swapSides = useApp((s) => s.settings.swapSidePanels);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const whatsNew = useApp((s) => s.whatsNew);
  const split = useApp((s) => s.split);
  const current = terminals.find((x) => x.id === selectedId);
  // A session still starting has its (starting) bar already: the terminal never shrinks when Claude arrives.
  const currentStarting = useApp((s) => !!current && isStarting(current, s.starting));
  // Split view: the views stay children of .workspace-body and are only placed in a grid cell
  // (never re-parented: xterm and CodeMirror are not remounted). Each pane shows its tab in front; the focused pane's is
  // the active tab.
  const multi = split.panes.length > 1;
  const panes = multi ? fronts(split) : [];
  const paneOf = (k: TabKey) => panes.indexOf(k);
  // A pane with a bar (a Claude session's, also while it starts) puts its view under it; any other takes both rows.
  const startingNow = useApp((s) => s.starting);
  const barred = (k: TabKey | null | undefined) => {
    const term = k?.startsWith('t:') ? terminals.find((x) => x.id === k.slice(2)) : undefined;
    return !!term && (!!term.session || isStarting(term, startingNow));
  };
  // Ask docked in a session's pane: that cell gives the panel its width (ASK_INSET). The mode is
  // kept from open to close, so a terminal shown again comes back at its docked size at once.
  const askDock = useApp((s) => s.askDock);
  const askOpen = useApp((s) => s.askOpen);
  const docked = (k: TabKey | null | undefined) => !!k?.startsWith('t:') && askDock[k.slice(2)] === 'dock';
  const cell = (i: number): CSSProperties | undefined => {
    if (!multi || i < 0) return undefined;
    const place = paneCell(i, barred(panes[i]) ? 'body' : 'full');
    return docked(panes[i]) ? { ...place, ...ASK_INSET } : place;
  };
  // The paste notice moves left of an Ask sheet in the pane it shows over.
  const pasteLeft = sheetIn({ askOpen, askDock }, multi ? panes[split.focus] ?? null : activeTab === 'term' && selectedId ? `t:${selectedId}` : null);
  const shownIn = (k: TabKey, single: boolean) => (multi ? paneOf(k) >= 0 : single);
  const focusedIn = (k: TabKey, single: boolean) => (multi ? paneOf(k) === split.focus : single);
  useEffect(() => { noteSelection(selectedId); }, [selectedId]);
  // A Claude config dir seen in a session that no account has: offered once.
  useAccountOffers();
  // The keyboard follows the pane focus: after the views had their say (children's effects run first), whatever kept it
  // in a pane that is no longer focused lets go.
  const workspaceBody = useRef<HTMLDivElement>(null);
  const paneState = multi ? `${split.focus}|${panes.join('|')}` : '';
  useEffect(() => { if (multi && workspaceBody.current) blurStrayFocus(workspaceBody.current, split.focus); }, [paneState]);
  useEffect(() => {
    if (!pastedAt) return;
    const timer = setTimeout(() => useApp.getState().setPastedAt(null), 4000);
    return () => clearTimeout(timer);
  }, [pastedAt]);

  // Windows: the menu in the header and its shortcuts.
  useWindowsMenu();

  // F1 opens the palette everywhere: the terminal and the editor would keep it (xterm sends it to the program), before the menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F1' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      const st = useApp.getState();
      // A pop-out has no palette: the project window opens it and comes forward.
      if (st.popout) { void window.atelier.popout.forward('open-palette').catch(() => {}); return; }
      // Like the other commands, it closes Settings instead of opening under the sheet.
      st.setSettingsOpen(null);
      st.setPaletteOpen(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // F4 / ⇧F4: the next / previous Find in Files result, anywhere but in a terminal.
  useEffect(() => installSearchKeys(), []);

  // Shift+F10 or the menu key: the right-click menu of the focused element (tab, row, tree, editor).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu')) return;
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return;
      // In text fields (rename, palette) the key stays theirs; the terminal (xterm's textarea) is not one.
      if (el instanceof HTMLInputElement || (el instanceof HTMLTextAreaElement && !el.closest('.xterm'))) return;
      // Stopped here: otherwise xterm would send the Shift+F10 sequence to the shell.
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + Math.min(24, r.width / 2), clientY: r.bottom - 4 }));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Coming back to the window puts the keyboard back in the pane when a clicked chip or button kept it.
  useEffect(() => installFocusReturn(), []);

  // A session that ends while you are looking at it counts as seen; if the window was behind, it becomes seen when it comes forward.
  useEffect(() => {
    let asked: string | null = null;
    const check = () => {
      const st = useApp.getState();
      // Not before the tabs from before a restart are back: the session shown meanwhile isn't one
      // you chose to look at, and would be marked seen.
      if (st.project && !st.tabsRestored) return;
      const covered = st.settingsOpen !== null || st.paletteOpen || st.whatsNew !== null;
      const id = seenNow(st.terminals, st.selectedId, st.activeTab, document.hasFocus(), covered);
      if (id && id !== asked) { asked = id; void window.atelier.terminals.markSeen(id).catch(() => {}); }
      if (!id) asked = null;
      // The notification center follows the same rule: the session you are looking at is read.
      const viewing = viewingNow(st.selectedId, st.activeTab, document.hasFocus(), covered);
      if (viewing) st.notesSeen(viewing);
      // An open Ask panel whose terminal is on screen has looked at its thread's latest outcome.
      for (const terminalId of Object.keys(st.askOpen)) st.markAskSeen(terminalId);
    };
    const off = useApp.subscribe((s, prev) => { if (s.terminals !== prev.terminals || s.selectedId !== prev.selectedId || s.activeTab !== prev.activeTab || s.settingsOpen !== prev.settingsOpen || s.paletteOpen !== prev.paletteOpen || s.whatsNew !== prev.whatsNew || s.notes !== prev.notes || s.tabsRestored !== prev.tabsRestored || s.askOpen !== prev.askOpen || s.askThreads !== prev.askThreads || s.split !== prev.split) check(); });
    window.addEventListener('focus', check);
    return () => { off(); window.removeEventListener('focus', check); };
  }, []);

  // Unsaved files: closing (window, quit, reload) is blocked and the main process asks what to do.
  useEffect(() => {
    // Let through once the window's own question was answered: main closes it again then.
    const guard = (e: BeforeUnloadEvent) => { if (blocksUnload(dirtyPaths().length)) { e.preventDefault(); (e as { returnValue: unknown }).returnValue = false; } };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);
  // Main hears whether this window has unsaved files: on Windows a sign-out or shutdown waits for its question.
  useEffect(() => {
    const report = unsavedReporter((has) => window.atelier.unsaved(has));
    report(hasUnsaved(useApp.getState()));
    return useApp.subscribe((s) => report(hasUnsaved(s)));
  }, []);

  useEffect(() => {
    const s = useApp.getState();
    // A pop-out knows its tab before anything renders: a file's buffer handed over waits for its
    // editor, then the store holds just that tab. Project-wide things stay the project window's.
    const booted = window.atelier.project().then(async (p) => {
      if (p?.popout) {
        if (p.popout.key.startsWith('f:')) { const h = await window.atelier.popout.handoff().catch(() => null); if (h) putHandoff(h); }
        useApp.getState().enterPopout(p.popout);
      }
      useApp.getState().setProject(p);
      if (p?.popout) return;
      // After an update: the What's new sheet once — main hands it to the first window that asks, so with several windows
      // restored only one shows it.
      void window.atelier.update.whatsNew().then((w) => { if (w) useApp.getState().setWhatsNew({ since: w.since }); }).catch(() => {});
      // Listening now: what main held for this window (a cold launch from Finder) comes in.
      void window.atelier.files.openReady().then((held) => held.forEach(applyOpenPaths)).catch(() => {});
      // The tabs living in pop-outs leave the strip and panes.
      void window.atelier.popout.list().then((keys) => useApp.getState().applyPoppedOut(keys)).catch(() => {});
    });
    void window.atelier.daemonState().then((d) => { if (d) s.setDaemon(d); });
    void window.atelier.usage().then(s.setUsage).catch(() => {});
    void window.atelier.git.status().then(s.setRepos).catch(() => {});
    void window.atelier.attributions().then(s.setAttributions).catch(() => {});
    void window.atelier.resumables().then(s.setResumables).catch(() => {});
    void window.atelier.schedules.list().then(s.setSchedules).catch(() => {});
    // The Claude Code signals notebook: null while atelierd is away or has none,
    // which never replaces a book already held. A book equal to the last (a Clear sends it twice) changes nothing.
    const setSignals = sameAsLast(s.setClaudeSignals);
    void window.atelier.claudeSignals.get().then((b) => { if (b) setSignals(b); }).catch(() => {});
    // Services: buffer read when a pane first arrives, then sequential updates (if something is missing it is re-read).
    const loadBuffer = (id: string) => void window.atelier.services.lines(id).then((b) => useApp.getState().setServiceBuffer(id, b.lines, b.seq, b.live)).catch(() => {});
    const onServices = ({ status, panes }: { status: ReturnType<typeof useApp.getState>['servicesStatus']; panes: ReturnType<typeof useApp.getState>['services'] }) => {
      s.setServices(panes, status);
      const loaded = useApp.getState().serviceSeq;
      for (const p of panes) if (loaded[p.id] === undefined) loadBuffer(p.id);
    };
    void window.atelier.services.list().then(onServices).catch(() => {});
    void window.atelier.terminals.list().then(s.setTerminals).catch(() => {});
    void window.atelier.ports.list().then(s.setPorts).catch(() => {});
    void window.atelier.prs.list().then(s.setPrs).catch(() => {});
    void window.atelier.settings.get().then((x) => { if (x) adoptSettings(x); }).catch(() => {});
    void window.atelier.claude.dirs().then((d) => useApp.setState({ claudeDefaultDir: d.defaultDir, home: d.home })).catch(() => {});
    void window.atelier.terminals.shells().then(s.setShells).catch(() => {});
    void window.atelier.update.state().then(s.setUpdateReady).catch(() => {});
    void window.atelier.update.status().then((x) => { if (x) s.setUpdateStatus(x); }).catch(() => {});
    void window.atelier.dictation.status().then(s.setDictationStatus).catch(() => {});
    // Connectors: every window lists them at start. Main holds the notices (a sign-out found at launch)
    // until a window has listed, and hands the queued ones over in this reply: one toast each (a pop-out too: main sends
    // them to the window in front; their actions open Settings in the project window).
    // After the boot even when it failed (no project yet): the connectors are listed all the same.
    void booted.catch(() => {}).then(() => window.atelier.connectors.list()).then(({ connectors, notices }) => {
      s.setConnectors(connectors);
      for (const n of notices) useApp.getState().connectorNotice(n);
    }).catch(() => {});
    // Their tasks (the palette's Tasks group, the task chips), again whenever a list or status changes.
    loadTaskLists();
    // Every project's automations, then as main broadcasts them.
    loadAutomations();
    void window.atelier.projectWindows.list().then((list) => useApp.getState().setProjectWindows(list)).catch(() => {});
    void window.atelier.claude.mcpAdded().then(s.setMcpAdded, () => {});
    const offTasks = useApp.subscribe((st, prev) => { if (st.connectors !== prev.connectors && tasksKey(st.connectors) !== tasksKey(prev.connectors)) loadTaskLists(); });
    // A terminal gone from the list (ended, or moved to another project's window): its xterm goes, as on exit, so if it
    // comes back it attaches anew.
    const setList = sameAsLast(s.setTerminals);
    let listed: Set<string> | null = null;
    const onTerminalList = (list: TerminalInfo[]) => {
      setList(list);
      const gone = leftTheList(listed, list);
      listed = new Set(list.map((x) => x.id));
      for (const id of gone) disposeLiveTerminal(id);
    };
    const offs = [
      offTasks,
      installStorageSync(),
      window.atelier.on.connectors(s.setConnectors),
      window.atelier.on.automations(s.setAutomations),
      window.atelier.on.connectorNotice((n) => useApp.getState().connectorNotice(n)),
      // Tab pop-out windows. The project window: which tabs live in pop-outs, a tab moved back, a pop-out
      // dragged over it. A pop-out: something to reveal in its tab, and the ask to give its tab back (⌘W, the red light).
      window.atelier.on.popouts((keys) => useApp.getState().applyPoppedOut(keys)),
      // Dragged back: at the place it was released over; from Move Back or ⌘W: after the active tab.
      window.atelier.on.dock((e) => useApp.getState().applyDock(e, e.at ? dockTargetAt(e.at) : null)),
      window.atelier.on.dockHover((p) => useApp.getState().setDockHover(p)),
      // Another project's window: the windows open now, a tab sent here.
      window.atelier.on.projectWindows((list) => useApp.getState().setProjectWindows(list)),
      window.atelier.on.adopt((r) => applyAdopt(r)),
      window.atelier.on.popoutReveal((r) => useApp.getState().revealInPopout(r)),
      window.atelier.on.popoutClose(() => void moveBack()),
      window.atelier.on.shellEnvAuto((e) => { const m = autoReloadToast(e); useApp.getState().showToast(m.text, undefined, m.tone); }),
      // main's questions and notices: asked here once this window says it listens (below).
      window.atelier.on.ask((m) => useApp.getState().receiveAsk(m)),
      window.atelier.on.askWithdrawn((id) => useApp.getState().withdrawAsk(id)),
      window.atelier.on.appNotice(() => useApp.getState().showToast(t.confirm.restartFailed, { label: t.confirm.openLogs, run: () => void window.atelier.openLogs() })),
      // A list or usage equal to the last one changes nothing: no store update, no render.
      window.atelier.on.terminals(onTerminalList),
      window.atelier.on.snapshot(resetTerminal),
      window.atelier.on.data(writeToTerminal),
      window.atelier.on.exit(disposeLiveTerminal),
      window.atelier.on.daemon(s.setDaemon),
      window.atelier.on.usage(sameAsLast(s.setUsage, usageKey)),
      window.atelier.on.git(s.setRepos),
      // Nothing listed yet, or the scan still running: whether it still looks (main tells the windows when it ends).
      window.atelier.on.git((repos) => { const sr = useApp.getState().scmSearch; if (repos.length === 0 || !sr || sr.searching) loadSearch(); }),
      window.atelier.on.attributions(s.setAttributions),
      window.atelier.on.companion((e) => useApp.getState().applyCompanionEvent(e)),
      window.atelier.on.fsChanged(s.filesChanged),
      // Files follows the disk: the folders showing a changed path are listed again.
      window.atelier.on.fsChanged(treeChanged),
      window.atelier.on.services(onServices),
      window.atelier.on.resumables(s.setResumables),
      // New MCP servers: main's list now, then as it changes.
      window.atelier.on.mcpAdded(s.setMcpAdded),
      // Scheduled prompts: every project's list, this project's news, the countdown's routing.
      window.atelier.on.schedules(s.setSchedules),
      window.atelier.on.scheduleNotice(scheduleNoticeToast),
      installScheduleRouting(),
      // Kept quietly: Settings › Claude reads it, nothing announces a new entry (no badge, dot or toast).
      window.atelier.on.claudeSignals(setSignals),
      window.atelier.on.settings(adoptSettings),
      window.atelier.on.update(s.setUpdateReady),
      window.atelier.on.updateStatus(s.setUpdateStatus),
      window.atelier.on.dictation(s.setDictationStatus),
      window.atelier.on.notes((raw) => useApp.getState().receiveNotes(raw)),
      window.atelier.on.ports(s.setPorts),
      window.atelier.on.prs(s.setPrs),
      installDictationKeys(),
      installScm(),
      // Git writes: the ops running now and their results.
      installGit(),
      installDocker(),
      installRedis(),
      installDatabases(),
      // Open any file: Finder drops outside the terminals, Open File…, Open With.
      installFileDrop(),
      window.atelier.on.openPaths(applyOpenPaths),
      // Click on a notification: the Settings sheet closes, so focus really goes to the session and Esc doesn't reach it by mistake.
      window.atelier.on.select((id) => { const st = useApp.getState(); st.setSettingsOpen(null); st.setActivity('sessions', { keepHidden: true }); st.select(id); }),
      window.atelier.on.serviceLines((e) => { if (useApp.getState().appendServiceLines(e.id, e.lines, e.reset, e.seq, e.live) === 'refetch') loadBuffer(e.id); }),
      window.atelier.on.backgroundFeed((f) => useApp.getState().applyBackgroundFeed(f)),
      window.atelier.on.command((cmd, from) => {
        const st = useApp.getState();
        // A pop-out's toast for one connector: its details page here.
        const connector = CONNECTOR_IDS.find((id) => cmd === `open-connector:${id}`);
        if (connector) { st.setSettingsOpen('connectors'); st.openConnector(connector); return; }
        // With Settings open: ⌘W and ⌘, stay on the sheet; any other command closes it and acts on the visible area.
        if (st.settingsOpen) {
          if (cmd === 'close-tab') { st.setSettingsOpen(null); return; }
          if (cmd === 'open-settings') return;
          // Check for Updates… with Settings open: its progress is in About.
          if (cmd === 'open-about') { st.setSettingsOpen('about'); return; }
          if (cmd === 'open-connectors') { st.setSettingsOpen('connectors'); return; }
          // Word wrap is a setting: the sheet stays and shows Editor, where its toggle and preview change in front of you.
          if (cmd === 'toggle-word-wrap') { st.setSettingsOpen('editor'); toggleWordWrap(); return; }
          st.setSettingsOpen(null);
        }
        switch (cmd) {
          case 'close-tab': st.closeTab(); break;
          case 'show-terminal': st.showTerminal(); break;
          case 'redraw-terminal': if (st.selectedId) redrawTerminal(st.selectedId); break;
          case 'view-sessions': st.setActivity('sessions'); break;
          case 'view-files': st.setActivity('files'); break;
          case 'find-in-files': findInFilesCommand(from === 'popout'); break;
          // F4 / ⇧F4 pressed in a pop-out: the results are this window's; the keyboard goes with the result.
          case 'next-search-result': case 'prev-search-result': stepFromPopout(cmd === 'next-search-result' ? 1 : -1); break;
          case 'view-services': if (servicesView(st.settings.showServices)) st.setActivity('services'); break;
          case 'view-scm': st.setActivity('scm'); break;
          case 'view-docker': st.setActivity('docker'); break;
          case 'view-redis': if (st.settings.showRedis !== 'never') st.setActivity('redis'); break;
          case 'view-databases': if (st.settings.showDatabases !== 'never') st.setActivity('databases'); break;
          case 'view-automations': if (st.settings.automationsEnabled) st.setActivity('automations'); break;
          case 'show-history': void withScm(() => showHistory('all')); break;
          case 'show-background': showBackground(); break;
          case 'fetch': fetchSelected(); break;
          case 'fetch-all': void withScm(() => void fetchAll()); break;
          case 'git-commit': openCommitDrawer(); break;
          case 'git-write-message': void writeMessageCommand(); break;
          case 'git-undo-commit': void undoLastCommit(); break;
          // The rest of the Git menu, on Source Control's selected repository.
          case 'git-commit-all': case 'git-push': case 'git-pull': case 'git-sync': case 'git-sync-all':
          case 'git-new-branch': case 'git-switch-branch': case 'git-stash': void runGitCommand(cmd); break;
          case 'new-session': st.setNewSessionOpen(true); break;
          case 'new-session-in-folder': st.setFolderSheet({ kind: 'session' }); break;
          case 'new-terminal-in-folder': st.setFolderSheet({ kind: 'terminal' }); break;
          case 'resume-session': st.setPaletteOpen(true, 'resume:'); break;
          case 'start-from-task': st.setPaletteOpen(true, 'task:'); break;
          // While the unsaved-files question is open, ⌘S answers it.
          case 'save': if (st.unsavedAsk || st.mainAsk?.request.kind === 'unsaved-close') saveFromKeys(); else if (st.openFiles.some((f) => f.path === st.activeTab)) void saveOne(st.activeTab); break;
          case 'save-all': void saveMany(dirtyPaths()); break;
          case 'save-all-and-close': void saveMany(dirtyPaths()).then((ok) => { if (ok && dirtyPaths().length === 0) window.close(); }); break;
          case 'new-file': st.newUntitled(); break;
          case 'open-file': void window.atelier.files.openPicker().catch(() => {}); break;
          case 'install-shell-command': void runShellCommand('install'); break;
          case 'uninstall-shell-command': void runShellCommand('uninstall'); break;
          case 'next-tab': st.activate(cycle(st.focusedStrip(), st.activeKey(), 1)); break;
          case 'prev-tab': st.activate(cycle(st.focusedStrip(), st.activeKey(), -1)); break;
          case 'new-terminal': void newTerminalIn(); break;
          case 'reload-shell-env': void reloadShellEnv(); break;
          case 'toggle-changes': st.toggleChanges(); break;
          case 'toggle-sidebar': st.toggleSidebar(); break;
          case 'swap-side-panels': void window.atelier.settings.set({ swapSidePanels: !st.settings.swapSidePanels }); break;
          case 'change-theme': st.setThemeSheet(true); break;
          case 'change-terminal-font': st.setFontSheet(true); break;
          case 'open-palette': st.setPaletteOpen(true); break;
          case 'next-attention': goToAttention(); break;
          case 'show-notifications': st.setNotesOpen(!st.notesOpen); break;
          case 'toggle-group-by-state': st.toggleGroupByState(); st.setActivity('sessions'); break;
          case 'open-settings': st.setSettingsOpen('appearance'); break;
          case 'open-about': st.setSettingsOpen('about'); break;
          case 'whats-new': st.setWhatsNew({ since: null }); break;
          case 'open-connectors': st.setSettingsOpen('connectors'); break;
          case 'review-all': st.openReview('all'); break;
          case 'review-session': reviewSelected(); break;
          case 'comment-selection': commentOnSelection(); break;
          case 'reveal-in-finder': revealActive(); break;
          case 'next-change': goToChange(1); break;
          case 'prev-change': goToChange(-1); break;
          case 'send-review': sendSelectedReview(); break;
          case 'session-panel': openSelectedSessionPanel(); break;
          case 'ask-session': askSelected(); break;
          case 'restart-session': restartSelected(); break;
          case 'context-usage': openSelectedContextSheet(); break;
          case 'schedule-prompt': scheduleSelected(); break;
          case 'scheduled-prompts': st.setPaletteOpen(true, 'scheduled:'); break;
          case 'md-toggle-preview': togglePreview(); break;
          case 'md-split': setActivePreviewView('split'); break;
          case 'md-outline': toggleMarkdownOutline(); break;
          case 'toggle-word-wrap': toggleWordWrap(); break;
          case 'split-right': st.splitRight(); break;
          case 'focus-next-pane': st.focusNextPane(); break;
          case 'focus-prev-pane': st.focusPrevPane(); break;
          case 'move-tab-left': st.moveTabStep(-1); break;
          case 'move-tab-right': st.moveTabStep(1); break;
          case 'close-pane': st.closePane(); break;
          case 'close-other-panes': st.closeOtherPanes(); break;
          case 'move-tab-window': { const k = st.activeKey(); if (k) void st.popOut(k, 'cascade', paneSize()); break; }
          // A pop-out gives its tab back when main asks (popoutClose); the project window has nothing to move back.
          case 'move-tab-back': break;
          // Workspaces: nothing while the project has them off (the keys reach the page anyway).
          case 'new-workspace': if (st.ws?.on) st.setWsSheet({}); break;
          case 'toggle-workspaces': st.setWorkspacesOn(!st.ws?.on); break;
          case 'next-workspace': case 'prev-workspace': stepWorkspace(cmd === 'next-workspace' ? 1 : -1); break;
          default:
            if (cmd.startsWith('tab-')) { const k = nth(st.focusedStrip(), Number(cmd.slice(4))); if (k) st.activate(k); }
            else if (cmd.startsWith('workspace-')) { const w = st.ws?.on ? st.ws.list[Number(cmd.slice('workspace-'.length))] : undefined; if (w) st.switchWorkspace(w.id); }
            else if (cmd.startsWith('new-terminal-profile:')) void newTerminalIn(undefined, cmd.slice('new-terminal-profile:'.length));
            else if (cmd.startsWith('new-session-account:')) st.setNewSessionOpen(true, cmd.slice('new-session-account:'.length));
            break;
        }
      })
    ];
    // Listening: main may ask this window its questions now.
    void window.atelier.asks.ready().catch(() => {});
    return () => offs.forEach((off) => off());
  }, []);

  const newTerminal = () => newTerminalIn();
  // Every "new Claude session" the user asks for goes through the New Session sheet (⌘N's): the name, and the account
  // when there are two or more. The empty states' buttons show ⌘N, so they open it too.
  const openNewSession = () => useApp.getState().setNewSessionOpen(true);
  const onNewMenu = (el: HTMLElement) => openNewMenu(el, { session: openNewSession, terminal: () => void newTerminal() });

  if (!projectLoaded) return null;
  // The Welcome window may be the first after an update: it takes What's new from main, so it shows it too.
  // Windows: the title bar after the screen (its buttons win over the screen's drag region), its drop-downs the context menu.
  if (!project) return <><Welcome />{windowsFrame && <><TitleBar floating /><ContextMenu /></>}{whatsNew && <Suspense fallback={null}><WhatsNew since={whatsNew.since} /></Suspense>}<DropPill /><Toast /><Confirms /></>;
  if (popoutMode) return <PopoutWindow />;

  return (
    <div className="app">
      <Header onNewMenu={onNewMenu} />
      <div className={`body${swapSides ? ' is-swapped' : ''}`} style={{ ['--sidebar-w' as string]: `${panels.sidebar}px`, ['--changes-w' as string]: `${panels.changes}px` }}>
        <ActivityBar />
        <ErrorBoundary id="sidebar" panel={t.crashPanels.sidebar} frame="sidebar"><Sidebar /></ErrorBoundary>
        {!sidebarHidden && <Resizer panel="sidebar" />}
        <main className="workspace">
          <Tabs onNew={onNewMenu} />
          {!multi && current && (current.session || currentStarting) && activeTab === 'term' && <SessionBar term={current} />}
          {!multi && current && activeTab === 'term' && <RunStrip term={current} />}
          <div ref={workspaceBody} className={`workspace-body ${multi ? 'is-split' : ''} ${!multi && isWaiting(current?.session) && activeTab === 'term' ? 'is-waiting' : ''}`}
            style={multi ? { gridTemplateColumns: gridColumns(split.fractions) } : activeTab === 'term' && docked(selectedId ? `t:${selectedId}` : null) ? ASK_INSET : undefined}
            onPointerDownCapture={multi ? focusPaneAt : undefined}>
            <ErrorBoundary id="terminal" panel={t.crashPanels.terminal} visible={multi ? panes.some((k) => k?.startsWith('t:')) : activeTab === 'term'}>
              {terminals.map((term) => {
                const k: TabKey = `t:${term.id}`;
                const single = activeTab === 'term' && term.id === selectedId;
                return <TerminalView key={term.id} id={term.id} visible={shownIn(k, single)} focused={focusedIn(k, single)} place={cell(paneOf(k))} />;
              })}
            </ErrorBoundary>
            {openFiles.map((f) => {
              const k: TabKey = `f:${f.path}`;
              const single = activeTab === f.path;
              return <ErrorBoundary key={f.path} id="editor" panel={t.crashPanels.editor} visible={shownIn(k, single)}>
                {imageMime(f.path) && !isUntitled(f.path)
                  ? <ImageView file={f} visible={shownIn(k, single)} place={cell(paneOf(k))} />
                  : videoMime(f.path) && !isUntitled(f.path)
                    ? <VideoView file={f} visible={shownIn(k, single)} place={cell(paneOf(k))} />
                    : <FileView file={f} visible={shownIn(k, single)} focused={focusedIn(k, single)} place={cell(paneOf(k))} />}
              </ErrorBoundary>;
            })}
            {servicesOpen && <ErrorBoundary id="services" panel={t.crashPanels.services} visible={shownIn('services', activeTab === 'services')}><ServicesView visible={shownIn('services', activeTab === 'services')} focused={multi && focusedIn('services', false)} place={cell(paneOf('services'))} /></ErrorBoundary>}
            {reviewOpen && <ErrorBoundary id="review" panel={t.crashPanels.review} visible={shownIn('review', activeTab === 'review')}><ReviewView visible={shownIn('review', activeTab === 'review')} focused={focusedIn('review', activeTab === 'review')} place={cell(paneOf('review'))} /></ErrorBoundary>}
            {backgroundOpen && <ErrorBoundary id="background" panel={t.crashPanels.background} visible={shownIn('background', activeTab === 'background')}><BackgroundView visible={shownIn('background', activeTab === 'background')} focused={focusedIn('background', activeTab === 'background')} place={cell(paneOf('background'))} /></ErrorBoundary>}
            {/* Docker tabs: one per target, each in its pane's cell. */}
            {dockerTabs.map((r) => <ErrorBoundary key={r.key} id="docker" panel={t.crashPanels.docker} visible={shownIn(r.key, activeTab === r.key)}><DockerView tab={r} visible={shownIn(r.key, activeTab === r.key)} focused={focusedIn(r.key, activeTab === r.key)} place={cell(paneOf(r.key))} /></ErrorBoundary>)}
            {/* Redis tabs: one per view, each in its pane's cell. */}
            {redisTabs.map((v) => { const k = redisKey(v); return <ErrorBoundary key={k} id="redis" panel={t.crashPanels.redis} visible={shownIn(k, activeTab === k)}><RedisView view={v} visible={shownIn(k, activeTab === k)} focused={focusedIn(k, activeTab === k)} place={cell(paneOf(k))} /></ErrorBoundary>; })}
            {/* Automations tabs: one per automation, and every project's list. */}
            {autoTabs.map((r) => <ErrorBoundary key={r.key} id="automations" panel={t.crashPanels.automations} visible={shownIn(r.key, activeTab === r.key)}><Suspense fallback={null}><AutomationsView id={r.id} visible={shownIn(r.key, activeTab === r.key)} focused={focusedIn(r.key, activeTab === r.key)} place={cell(paneOf(r.key))} /></Suspense></ErrorBoundary>)}
            {historyOpen && <ErrorBoundary id="history" panel={t.crashPanels.history} visible={shownIn('history', activeTab === 'history')}><HistoryView visible={shownIn('history', activeTab === 'history')} focused={focusedIn('history', activeTab === 'history')} place={cell(paneOf('history'))} /></ErrorBoundary>}
            {revFiles.map((f) => <ErrorBoundary key={f.key} id="rev-file" panel={t.crashPanels.revFile} visible={shownIn(f.key, activeTab === f.key)}><RevFileView file={f} visible={shownIn(f.key, activeTab === f.key)} focused={focusedIn(f.key, activeTab === f.key)} place={cell(paneOf(f.key))} /></ErrorBoundary>)}
            {/* Table tabs: every one open, each in its pane's cell (another workspace's stay hidden). */}
            {dbTabs.map((r) => <ErrorBoundary key={r.key} id="databases" panel={t.crashPanels.databases} visible={shownIn(r.key, activeTab === r.key)}><Suspense fallback={null}><DbTabView tab={r} visible={shownIn(r.key, activeTab === r.key)} focused={focusedIn(r.key, activeTab === r.key)} place={cell(paneOf(r.key))} /></Suspense></ErrorBoundary>)}
            {/* One pane: the session in front's Ask (a split's are in their pane's chrome, after its header). */}
            {!multi && activeTab === 'term' && selectedId && <AskHost key={selectedId} terminalId={selectedId} />}
            {multi && panes.map((k, i) => <PaneChrome key={k ?? `empty-${i}`} k={k} index={i} focused={i === split.focus} />)}
            {multi && panes.slice(1).map((_, i) => <PaneDivider key={`divider-${i}`} index={i} style={dividerCell(i)} />)}
            <PaneDropLayer />
            {pastedAt && activeTab === 'term' && <div className={`paste-toast${pasteLeft ? ' is-left' : ''}`} style={cell(split.focus)}><i />{t.pasted}</div>}
            {/* Over the pane of the session the text goes to (the focused pane when that one isn't shown). */}
            <DictationPill place={cell(multi ? dictationPane(split, currentDictationTarget()) : split.focus)} />
            {/* A scheduled prompt's countdown over the session it goes to. */}
            {multi
              ? panes.map((k, i) => (k?.startsWith('t:') ? <ScheduleCountdown key={`sc-${k}`} terminalId={k.slice(2)} place={cell(i)} /> : null))
              : selectedId && activeTab === 'term' && <ScheduleCountdown terminalId={selectedId} />}
            {/* No terminal, or every tab closed (the sessions keep running in the sidebar): the same invitation. */}
            {/* Workspaces on: the workspace's own empty state, with what it can resume. */}
            {!multi && wsOn && selectedId === null && activeTab === 'term' && <WorkspaceEmpty onSession={openNewSession} onTerminal={() => void newTerminal()} />}
            {/* Another space with no tab: its own empty state, never a terminal. */}
            {!multi && space !== 'sessions' && activeTab === NO_TAB && <SpaceEmpty space={space} />}
            {!multi && !wsOn && (terminals.length === 0 || selectedId === null) && activeTab === 'term' && (
              <div className="workspace-empty">
                <div className="ws-empty-card pop">
                  <Logo size={56} />
                  <h2>{t.emptyTitle}</h2>
                  <p>{t.emptyBody}</p>
                  <div className="ws-empty-actions">
                    <button type="button" className="btn-primary btn-lg" onClick={openNewSession}><Icon name="sparkle" size={14} />{t.startSession}<span className="kbd-in">{kbd('⌘N')}</span></button>
                    <button type="button" className="btn-ghost btn-lg" onClick={() => void newTerminal()}><Icon name="terminal" size={14} />{t.openTerminal}<span className="kbd-in">{kbd('⌘T')}</span></button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>
        {showChanges && <Resizer panel="changes" />}
        {showChanges && <ErrorBoundary id="changes" panel={t.crashPanels.changes} frame="changes"><ChangesPanel /></ErrorBoundary>}
      </div>
      <Footer />
      <ContextMenu />
      <BackgroundPopover />
      <SchedulePopover />
      <Tooltip />
      <DropPill />
      <Toast />
      <UndoPill />
      <RedisSheets />
      {settingsOpen && <Settings />}
      {automationSheet && <Suspense fallback={null}><AutomationEditor /><TurnOnSheet /><CloseRunSheet /></Suspense>}
      {whatsNew && !settingsOpen && <Suspense fallback={null}><WhatsNew since={whatsNew.since} /></Suspense>}
      {/* Keyed by the account asked for: New Session with Account while the sheet is open reopens it on that account. */}
      {newSessionOpen && <NewSession key={newSessionAccount ?? ''} onStart={(name, account, noFlags) => { useApp.getState().setNewSessionOpen(false); void newSessionIn(name, undefined, { ...(account ? { account } : {}), ...(noFlags ? { noFlags } : {}) }); }} onClose={() => useApp.getState().setNewSessionOpen(false)} />}
      {folderSheet && <FolderSheet key={`${folderSheet.kind}:${folderSheet.cwd ?? ''}`} sheet={folderSheet} />}
      {/* Mounted when opened: its color starts at the next one no workspace uses, its fields empty. */}
      {wsSheet && <NewWorkspaceSheet />}
      {saveAsPath && <SaveAsSheet key={saveAsPath} path={saveAsPath} />}
      {languageSheet && <LanguageSheet key={languageSheet} path={languageSheet} />}
      {themeSheet && <Suspense fallback={null}><ThemeSheet /></Suspense>}
      {fontSheet && <Suspense fallback={null}><FontSheet /></Suspense>}
      {contextSheet && <Suspense fallback={null}><ContextSheet key={contextSheet} terminalId={contextSheet} /></Suspense>}
      {originSheet && <Suspense fallback={null}><OriginSheet key={originSheet} path={originSheet} /></Suspense>}
      <DbSheetsHost />
      <GitSheets />
      <CommitAllSheet />
      {refPicker && <RefPicker />}
      {scheduleSheet && <ScheduleSheet key={`${scheduleSheet.terminalId}:${scheduleSheet.editId ?? ''}`} />}
      {paletteOpen && <Palette onNewSession={() => useApp.getState().setNewSessionOpen(true)} onNewTerminal={() => void newTerminal()} />}
      {/* Last, on the top layer: a question takes the focus, so it must never be drawn under another sheet. */}
      <Confirms />
    </div>
  );
}
