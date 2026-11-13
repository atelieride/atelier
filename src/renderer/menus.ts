import type { TerminalInfo } from '@shared/protocol';
import type { RepoStatus } from '@shared/git';
import { pasteText } from '@shared/logline';
import { canPopOut, closingKeys, type TabKey } from './tabs-model';
import type { MenuItem } from './menu-model';
import type { CloseAt } from './confirms/slice';
import { bracketedPaste } from './terminal/registry';
import { t } from './i18n/en';
import { showHistory } from './scm/actions';
import { mentionPath, mentionTarget, type LineRange } from './mention';
import { useApp } from './store';
import type { Band } from './row-order';
import { newTerminalIn } from './launch';
import { profileSubmenu } from './profiles';
import { isUntitled } from './untitled';
import { isExternal } from './external';
import { shelvable, type ShelfItem } from './shelf';
import { hasSomethingToResume, refreshHistory } from './history';
import { continueOnPhone, remoteAvailability, remoteReason } from './remote';
import { pendingFor, sendReason, sendReview } from './review-send';
import { openSessionPanel, panelAvailability } from './session-panel';
import { restartFromMenu } from './restart-actions';
import { openContextSheet } from './context-actions';
import { copyText } from './clipboard';
import { MAX_PANES, canMoveToNewPane, isSplit, paneOf, stripKeys } from './split';
import { CONNECTOR_ICONS, CONNECTOR_NAMES } from './connectors-view';
import { fallbackUrl, taskLinkUrl, type TaskLink } from './task-links';
import { sendInput } from './terminal/drafts';
import { terminalFindKeys } from './terminal/find';
import { paneSize } from './dock-target';
import { moveBack } from './popout-actions';
import { fileGitItems, repoGitItems, tabGitItems } from './git/menu-items';
import type { StageRow } from './git/staging';
import { isBelow, toNative } from '@shared/paths';
import { kbd } from './kbd';
import { openScheduleSheet, scheduleBlock } from './schedules';
import { rememberScheduleOpener } from './components/SchedulePopover';
import { openAskFor } from './companion/actions';
import { moveToWorkspaceItems } from './workspace-menus';
import { moveToWindowItems } from './move-window';
import { memberOf } from './workspaces';

// Right-click menu entries, by context. None writes to the project (those arrive with file editing).
const m = t.menu;
const st = () => useApp.getState();
const copy = (text: string) => void copyText(text);
/** A path as the user pastes it elsewhere: native (C:\… on Windows), never the app's canonical C:/…. */
const copyPath = (path: string) => copy(toNative(path));
const relOf = (path: string) => { const root = st().project?.root; return root && isBelow(root, path) ? path.slice(root.length + 1) : path; };
const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

/** Writes "@path " (with lines: "@path#L10-24 ") into the prompt of the selected session (or the first), without Enter. */
export function mentionInSession(path: string, lines?: LineRange | null) {
  const s = st();
  const target = s.terminals.find((x) => x.id === s.selectedId && x.session) ?? s.terminals.find((x) => x.session);
  if (!target) { s.showToast(t.noSessionToMention); return; }
  const cwd = target.session?.cwd ?? target.cwd ?? s.project?.root ?? null;
  const root = s.project?.root ?? '/';
  const file = mentionTarget(path, root, s.project?.realRoot ?? root);
  sendInput(target.id, pasteText(mentionPath(file, cwd, root, lines), bracketedPaste(target.id)));
  s.select(target.id);
  s.setPastedAt(Date.now());
}

/** Review › Review Selected Session: the selected session's review (a plain terminal or none: every change). */
export function reviewSelected() {
  const s = st();
  const term = s.terminals.find((x) => x.id === s.selectedId);
  s.openReview(term?.session ? term.id : 'all');
}

/** Review › Send Review to Session: the review tab's session, else the selected one, else the last one selected. */
export function sendSelectedReview() {
  const s = st();
  const scope = s.activeTab === 'review' && s.review && s.review.scope !== 'all' ? s.review.scope : null;
  const selected = s.terminals.find((x) => x.id === s.selectedId && x.session)?.id ?? null;
  const id = scope ?? selected ?? s.lastSession;
  if (id) sendReview(id); else s.showToast(t.comments.closed);
}

function showChangesBySession() {
  const s = st();
  s.setChangesGroup('session');
  if (!s.showChanges) s.toggleChanges();
}

function closeGroup(key: TabKey, mode: 'others' | 'right' | 'all' | 'files'): MenuItem {
  // Split view: the tab's own strip; one pane: the whole strip.
  const s = st();
  const keys = closingKeys(stripKeys(s.split, s.tabOrder, Math.max(paneOf(s.split, key), 0)), key, mode);
  const label = { others: m.closeOthers, right: m.closeRight, all: m.closeAll, files: m.closeFiles }[mode];
  return { id: `close-${mode}`, label, disabled: keys.length === 0, run: () => void st().closeTabs(keys) };
}

/**
 * The deepest working tree of the project a folder is in, with its branch: Source Control's entries (hidden-folder
 * worktrees included) when known, else the repos Changes watches.
 */
function repoAt(cwd: string): { root: string; branch: string | null } | null {
  const trees = st().scmRepos?.map((e) => ({ root: e.root, branch: e.status && !e.status.detached ? e.status.branch : null }))
    ?? st().repos.map((r) => ({ root: r.root, branch: r.detached ? null : r.branch }));
  let best: { root: string; branch: string | null } | null = null;
  for (const r of trees) if ((cwd === r.root || isBelow(r.root, cwd)) && (!best || r.root.length > best.root.length)) best = r;
  return best;
}

function terminalItems(term: TerminalInfo, withClose: boolean): MenuItem[] {
  const items: MenuItem[] = [
    // Where it was asked: the row's menu renames in the row, the tab's in the tab.
    { id: 'rename', label: m.rename, icon: 'sparkle', run: () => st().setRenaming({ id: term.id, at: withClose ? 'row' : 'tab' }) }
  ];
  // Pinning orders the sidebar rows, not the tabs: only in the row's menu.
  if (withClose) items.push({ id: 'pin', label: st().pins.includes(term.id) ? m.unpin : m.pin, icon: 'pin', run: () => st().togglePinned(term.id) });
  if (term.session) {
    const why = remoteReason(remoteAvailability(term));
    items.push({ id: 'session-panel', label: t.panel.open, icon: 'sliders', run: () => openSessionPanel(term.id) });
    // Ask; a tab in a window of its own has its Ask there.
    if (!st().poppedOut.includes(`t:${term.id}`)) items.push(askItem(term.id));
    items.push({ id: 'review-session', label: m.reviewSession, icon: 'review', run: () => st().openReview(term.id) });
    const pending = pendingFor(term.id);
    if (pending > 0) {
      const blocked = sendReason(term.id);
      items.push({ id: 'send-review', label: m.sendReview(pending), icon: 'send', disabled: blocked !== null, tip: blocked ?? undefined, run: () => sendReview(term.id) });
    }
    items.push({ id: 'continue-on-phone', label: m.continueOnPhone, icon: 'phone', disabled: why !== null, tip: why ?? undefined, run: () => continueOnPhone(term.id) });
    items.push(restartItem(term));
    // Context usage: what fills this session's context.
    items.push({ id: 'context-usage', label: t.context.menu, icon: 'pie', run: () => openContextSheet(term.id) });
    items.push(...scheduleItems(term, withClose));
    items.push({ id: 'copy-id', label: m.copySessionId, run: () => copy(term.session!.sessionId) });
    items.push({ id: 'changes', label: m.showChanges, icon: 'git', run: showChangesBySession });
    // Source Control: the history of the branch the session works on.
    const repo = repoAt(term.cwd || term.session.cwd || '');
    if (repo?.branch) items.push({ id: 'show-branch-history', label: t.scm.menu.showHistoryOf(repo.branch), icon: 'git', run: () => showHistory(`refs/heads/${repo.branch}`, repo.root) });
  }
  items.push(...taskMenuItems(term.id));
  items.push({ id: 'term-here', label: m.openTerminalHere, icon: 'terminal', run: () => void newTerminalIn(term.session?.cwd ?? term.cwd) });
  items.push({ id: 'open-in-finder', label: m.openInFinder, icon: 'folderOpen', run: () => void window.atelier.terminals.openFolder(term.id).catch(() => {}) });
  if (withClose) items.push('sep', closeForReal(term, 'close', 'row'));
  return items;
}

/** Ask About This Session: that session's Ask, shown and open, its composer ready. */
function askItem(terminalId: string): MenuItem {
  return { id: 'ask-session', label: t.companion.menu, icon: 'ask', hint: kbd('⌘I'), run: () => openAskFor(terminalId) };
}

/**
 * Restart Session: Restart Session (Restart When Done while Claude is busy), Don't Restart
 * while armed, disabled while restarting. With new MCP servers the hint names them.
 */
function restartItem(term: TerminalInfo): MenuItem {
  const r = st().restarts[term.id];
  if (r?.armed) return { id: 'dont-restart', label: t.restart.dontRestart, icon: 'restart', run: () => st().cancelRestart(term.id) };
  if (r) return { id: 'restart-session', label: t.restart.restarting, icon: 'restart', disabled: true, run: () => {} };
  const free = panelAvailability(term) === 'ok';
  const added = st().mcpAdded[term.id];
  return { id: 'restart-session', label: free ? t.restart.action : t.restart.whenDone, icon: 'restart', hint: added?.length ? added.join(', ') : undefined, tip: t.restart.tip, run: () => restartFromMenu(term.id) };
}

/**
 * Scheduled prompts: Schedule Prompt… (disabled with the reason when atelierd lacks the
 * feature), and Scheduled Prompts (n) when the session has some — the keyboard's way to the chip's popover.
 */
function scheduleItems(term: TerminalInfo, row: boolean): MenuItem[] {
  const why = scheduleBlock(term);
  const items: MenuItem[] = [{ id: 'schedule-prompt', label: t.sched.action, icon: 'sendLater', hint: kbd('⌘⌥↵'), disabled: why !== null, tip: why ?? undefined, run: () => openScheduleSheet(term.id) }];
  const n = st().schedules.filter((x) => x.terminalId === term.id && (x.status === 'pending' || x.status === 'armed' || x.status === 'missed')).length;
  if (n > 0) {
    items.push({ id: 'scheduled-prompts', label: t.sched.listCount(n), icon: 'clock', run: () => {
      // Beside the row (or under the tab) it was asked from, as from the chip.
      const el = document.querySelector<HTMLElement>(row ? `[data-term-row="${CSS.escape(term.id)}"]` : `[role="tab"][data-key="${CSS.escape(`t:${term.id}`)}"]`) ?? document.querySelector<HTMLElement>('.session-bar');
      const a = (el ?? document.body).getBoundingClientRect();
      rememberScheduleOpener(el);
      st().openSchedulePopover({ terminalId: term.id, anchor: { left: a.left, top: a.top, right: a.right, bottom: a.bottom }, side: row ? 'right' : 'below' });
    } });
  }
  return items;
}

/**
 * A session started from a task: open the task (main opens the task's own page, also while the
 * connector is disconnected), copy its link, or forget the link. None when the terminal has no task.
 */
export function taskMenuItems(id: string): MenuItem[] {
  const link = st().taskLinks[id];
  if (!link) return [];
  return [
    { id: 'task-open', label: t.tasks.open(CONNECTOR_NAMES[link.source]), icon: CONNECTOR_ICONS[link.source], run: () => openLinkedTask(link) },
    { id: 'task-copy', label: t.tasks.copyLink, run: () => copy(taskLinkUrl(link)) },
    { id: 'task-unlink', label: t.tasks.unlink, run: () => st().unlinkTask(id) }
  ];
}

/** Opens a linked task in the browser: main picks the URL (its cached one, or the task's short link), never the renderer. */
export function openLinkedTask(link: TaskLink): void {
  void window.atelier.connectors.openTask(link.source, link.taskId).catch(() => false).then((opened) => {
    // Jira disconnected: main has no site to build the link from; the chip's own saved page (validated) instead.
    const fallback = opened ? null : fallbackUrl(link);
    if (fallback) void window.atelier.openUrl(fallback).catch(() => {});
  });
}

/**
 * Really closes the session or terminal, asked where the menu was opened when something is running (the row, the tab,
 * the pop-out's bar); a tab's Close only hides it.
 */
function closeForReal(term: TerminalInfo, id: string, at: CloseAt): MenuItem {
  // Its close already sent: nothing to ask, it says so.
  const shutting = !!st().closing[term.id];
  return { id, label: term.session ? m.closeSession : m.closeTerminal, icon: 'x', danger: true, ...(shutting ? { disabled: true, tip: t.closingRow } : {}), run: () => st().askClose(term.id, at) };
}

export function tabMenu(key: TabKey): MenuItem[] {
  const s = st();
  const head: MenuItem[] = [];
  const tail: MenuItem[] = [];
  if (key.startsWith('t:')) {
    const term = s.terminals.find((x) => x.id === key.slice(2));
    if (term) { head.push(...terminalItems(term, false), 'sep'); tail.push('sep', closeForReal(term, 'close-terminal', 'tab')); }
  } else if (key === 'review') {
    head.push({ id: 'review-all', label: m.reviewAll, icon: 'review', disabled: s.review?.scope === 'all', run: () => s.openReview('all') }, 'sep');
  } else if (key.startsWith('f:')) {
    if (s.preview === key.slice(2)) head.push({ id: 'keep-open', label: m.keepOpen, run: () => s.keepOpen(key.slice(2)) }, 'sep');
    // An untitled tab has no path to copy or reveal yet.
    if (!isUntitled(key.slice(2))) head.push(...fileRefItems(key.slice(2)), ...shelfToggle(key.slice(2), s.openFiles.find((f) => f.path === key.slice(2))?.rel), 'sep');
    // A file with changes: Discard Changes…, last.
    const git = tabGitItems(key.slice(2));
    if (git.length) tail.push('sep', ...git);
  } else if (key.startsWith('db:')) {
    // The table preview: kept like a file's.
    if (s.dbPreview === key) head.push({ id: 'keep-open', label: m.keepOpen, run: () => s.keepDbTab(key) }, 'sep');
  } else if (s.dockerPreview === key || s.autoPreview === key) {
    // Docker's and Automations' previews: kept the same way.
    head.push({ id: 'keep-open', label: m.keepOpen, run: () => (key.startsWith('dk:') ? s.keepDockerTab(key) : s.keepAutoTab(key)) }, 'sep');
  }
  // Split view with tab groups: the tab moves to the pane on either side, or to a new pane
  // on the right while there is room and it has company in its pane; the last pane's carries ⌃⌘→ (it makes one there).
  const at = isSplit(s.split) ? paneOf(s.split, key) : 0;
  const n = s.split.panes.length;
  const moves: MenuItem[] = [
    ...(at > 0 ? [{ id: 'move-left', label: m.moveLeftPane, hint: kbd('⌃⌘←'), run: () => st().moveTabSide(key, -1) }] : []),
    ...(at >= 0 && at < n - 1 ? [{ id: 'move-right', label: m.moveRightPane, hint: kbd('⌃⌘→'), run: () => st().moveTabSide(key, 1) }] : []),
    ...(at >= 0 && canMoveToNewPane(s.split, s.tabOrder, key)
      ? [{ id: 'move-new-right', label: m.moveNewPaneRight, icon: 'split' as const, ...(at === n - 1 ? { hint: kbd('⌃⌘→') } : {}), run: () => st().moveTabToNewPane(key, at, 'right') }]
      : [])
  ];
  return [
    ...moves,
    // Only a tab that can live in a window of its own (Automations tabs can't).
    ...(canPopOut(key) ? [moveItem(key, kbd('⌘⇧O'))] : []),
    ...moveToWindowItems(key),
    ...moveToWorkspaceItems(key),
    'sep',
    ...head,
    { id: 'close', label: m.closeTab, hint: kbd('⌘W'), run: () => s.closeTab(key.startsWith('f:') ? key.slice(2) : key) },
    closeGroup(key, 'others'), closeGroup(key, 'right'), closeGroup(key, 'files'), closeGroup(key, 'all'),
    ...tail
  ];
}

/**
 * A tab's items that are about the strip, its panes or the main window's panels (Changes, the Files tree): none of them
 * in a pop-out.
 */
const NOT_IN_POPOUT = new Set(['shelf', 'open-to-side', 'move-window', 'move-workspace', 'unsplit', 'keep-open', 'close', 'close-others', 'close-right', 'close-files', 'close-all', 'changes', 'reveal-tree', 'git-discard']);

/**
 * The pop-out's bar, right-click or Shift+F10: Move Back, then its tab's own items that apply in a
 * window of its own (Copy Path, Reveal in Finder, a session's Rename in its bar…). A plain terminal has no name field
 * here (its tab renames it): no Rename.
 */
export function popoutBarMenu(key: TabKey): MenuItem[] {
  const term = key.startsWith('t:') ? st().terminals.find((x) => x.id === key.slice(2)) : undefined;
  const own = tabMenu(key).flatMap((i): MenuItem[] => {
    if (i === 'sep') return [i];
    if (NOT_IN_POPOUT.has(i.id)) return [];
    if (i.id === 'rename') return term?.session ? [{ ...i, run: () => st().setRenaming({ id: term.id, at: 'bar' }) }] : [];
    if (i.id === 'close-terminal' && term) return [{ ...i, run: () => st().askClose(term.id, 'popout') }];
    return [i];
  });
  const items: MenuItem[] = [{ id: 'move-back', label: t.popout.back, icon: 'dock', hint: kbd('⌘W'), run: () => void moveBack() }, 'sep', ...own];
  // No separator first, last or twice in a row.
  return items.filter((i, n) => i !== 'sep' || (n > 0 && n < items.length - 1 && items[n - 1] !== 'sep' && items.slice(n + 1).some((x) => x !== 'sep')));
}

/** Entries shared by an already known file: copy the path and where to find it. */
function fileRefItems(path: string): MenuItem[] {
  // A file outside the project has no relative path and no place in the Files tree.
  const inProject = !isExternal(path, st().project?.realRoot ?? null);
  return [
    { id: 'copy-path', label: m.copyPath, run: () => copyPath(path) },
    ...(inProject ? [
      { id: 'copy-rel', label: m.copyRelPath, run: () => copyPath(relOf(path)) },
      { id: 'reveal-tree', label: m.revealInFiles, icon: 'files' as const, run: () => st().revealInTree(path) }
    ] : []),
    { id: 'reveal-finder', label: m.revealInFinder, icon: 'folderOpen', run: () => void window.atelier.reveal(path) }
  ];
}

/** Add to Shelf / Remove from Shelf: any real file, in the main window only. */
function shelfToggle(path: string, rel: string | undefined): MenuItem[] {
  const s = st();
  if (s.popout || !rel || !shelvable(path, s.project?.realRoot ?? null)) return [];
  const on = s.shelf.some((x) => x.path === path);
  return [{ id: 'shelf', label: on ? t.shelf.menuRemove : t.shelf.menuAdd, icon: 'shelf', run: () => (on ? st().removeFromShelf(path) : st().addToShelf(path, rel)) }];
}

/** A row of the Shelf: open it, its path, off the shelf. */
export function shelfRowMenu(item: ShelfItem, open: () => void): MenuItem[] {
  const shelf = st().shelf;
  const i = shelf.findIndex((x) => x.path === item.path);
  return [
    { id: 'open', label: m.open, run: open },
    sideItem(() => st().openFileToSide(item.path, item.rel)),
    'sep',
    ...fileRefItems(item.path),
    'sep',
    { id: 'shelf-up', label: t.shelf.moveUp, disabled: i <= 0, run: () => st().nudgeShelf(item.path, -1) },
    { id: 'shelf-down', label: t.shelf.moveDown, disabled: i < 0 || i >= shelf.length - 1, run: () => st().nudgeShelf(item.path, 1) },
    'sep',
    { id: 'shelf-remove', label: t.shelf.menuRemove, icon: 'x', run: () => st().removeFromShelf(item.path) },
    shelfClear()
  ];
}

/** The Shelf's head: show or hide its rows, empty it. */
export function shelfHeadMenu(): MenuItem[] {
  const collapsed = st().shelfCollapsed;
  return [{ id: 'shelf-toggle', label: collapsed ? t.shelf.menuExpand : t.shelf.menuCollapse, run: () => st().toggleShelfCollapsed() }, 'sep', shelfClear()];
}

/** The palette's Add / Remove Current File: the project file in front, if any. */
export function shelfCommand(): { label: string; run: () => void } | null {
  const s = st();
  const front = s.activeKey();
  if (!front?.startsWith('f:')) return null;
  const item = shelfToggle(front.slice(2), s.openFiles.find((f) => `f:${f.path}` === front)?.rel)[0];
  if (!item || item === 'sep') return null;
  const label = s.shelf.some((x) => `f:${x.path}` === front) ? t.shelf.cmdRemove : t.shelf.cmdAdd;
  return { label, run: item.run };
}

function shelfClear(): MenuItem {
  return { id: 'shelf-clear', label: t.shelf.menuClear, run: () => st().clearShelf() };
}

/**
 * Move Up / Move Down for a sidebar row inside its band (the rows it can be put among): the keyboard's way to the order
 * a drag gives. None without a band.
 */
function orderItems(id: string, band: Band | undefined): MenuItem[] {
  if (!band) return [];
  const i = band.ids.indexOf(id);
  return [
    { id: 'row-up', label: m.moveUp, icon: 'arrowUp', disabled: i <= 0, run: () => st().moveRowStep(band, id, -1) },
    { id: 'row-down', label: m.moveDown, icon: 'arrowDown', disabled: i < 0 || i >= band.ids.length - 1, run: () => st().moveRowStep(band, id, 1) }
  ];
}

/** A sidebar row's menu; `band`: the rows it can be moved among, for Move Up / Move Down. */
export function sessionRowMenu(term: TerminalInfo, band?: Band): MenuItem[] {
  // The chips' popover is mouse-only; this is the keyboard way in (Shift+F10 on the row).
  const background: MenuItem[] = term.session ? [{ id: 'show-background', label: t.bg.showBackground, run: () => st().openBackground({ terminalId: term.id }) }] : [];
  const key: TabKey = `t:${term.id}`;
  // In a window of its own: bring it forward or move it back; no pane here to show it in.
  if (st().poppedOut.includes(key)) {
    return [
      { id: 'show-window', label: t.popout.show, icon: 'window', run: () => void window.atelier.popout.focus(key).catch(() => {}) },
      { id: 'move-back', label: t.popout.back, icon: 'dock', run: () => void window.atelier.popout.recall(key).catch(() => {}) },
      'sep', ...background, ...(background.length ? ['sep' as const] : []), ...terminalItems(term, true)
    ];
  }
  return [sideItem(() => st().openToSide(key)), moveItem(key), ...moveToWindowItems(key), ...moveToWorkspaceItems(key), ...orderItems(term.id, band), ...background, 'sep', ...terminalItems(term, true)];
}

/** Split view: shows the tab, row or file in the pane right of the focused one (⌥-click does the same). */
function sideItem(run: () => void): MenuItem {
  return { id: 'open-to-side', label: m.openToSide, icon: 'split', hint: kbd('⌥-click'), run };
}

/** Tab pop-out windows: the tab in a window of its own, as big as it is shown now. */
function moveItem(key: TabKey, hint?: string): MenuItem {
  return { id: 'move-window', label: t.popout.move, icon: 'window', ...(hint ? { hint } : {}), run: () => void st().popOut(key, 'cascade', paneSize()) };
}

/**
 * The menu of a split-view pane (its strip's empty part, a session's bar under it): its tab in front's Rename
 * (terminals) and Ask (sessions), the pane commands.
 */
export function paneMenu(index: number): MenuItem[] {
  const s = st();
  const key = s.split.panes.length > 1 ? s.split.panes[index]?.front ?? null : null;
  const term = key?.startsWith('t:') ? s.terminals.find((x) => x.id === key.slice(2)) : undefined;
  const full = s.split.panes.length >= MAX_PANES;
  const focusThen = (fn: () => void) => () => { if (st().split.focus !== index) st().focusPane(index); fn(); };
  return [
    // Renamed in its tab, right above (a pane's session bar has no name).
    ...(term ? [{ id: 'rename', label: m.rename, icon: 'sparkle' as const, run: () => st().setRenaming({ id: term.id, at: 'tab' }) }] : []),
    // A session's pane: its Ask.
    ...(term?.session ? [askItem(term.id)] : []),
    ...(term ? ['sep' as const] : []),
    { id: 'split-right', label: m.splitRight, icon: 'split', hint: kbd('⌘\\'), disabled: full, tip: full ? t.split.max : undefined, run: focusThen(() => st().splitRight()) },
    { id: 'equalize', label: m.equalizePanes, run: () => st().equalizePanes() },
    'sep',
    { id: 'close-pane', label: m.closePane, icon: 'unsplit', run: () => st().closePane(index) },
    { id: 'close-other-panes', label: m.closeOtherPanes, run: focusThen(() => st().closeOtherPanes()) }
  ];
}

export function resumeMenu(id: string, resume: () => void): MenuItem[] {
  const s = st();
  // With activities on, the all-items act on the row's own place (its activity, or its workspace's own rows).
  const place = s.settings.wsActivities && s.ws?.on && !s.popout ? memberOf(s.ws, id) : undefined;
  const waiting = (s.project ? s.resumables.filter((r) => r.projectRoot === s.project!.root) : []).filter((r) => !place || memberOf(s.ws!, r.id) === place);
  const busy = s.bulkResume !== null;
  return [
    { id: 'resume', label: t.resume, icon: 'resume', disabled: busy, run: resume },
    // Pinned while waiting: it comes back pinned.
    { id: 'pin', label: s.pins.includes(id) ? m.unpin : m.pin, icon: 'pin', run: () => st().togglePinned(id) },
    { id: 'dismiss', label: t.dismiss, icon: 'x', danger: true, disabled: busy, run: () => void window.atelier.terminals.dismiss(id) },
    'sep',
    { id: 'resume-all', label: t.resumeAllItem, icon: 'resume', disabled: busy, run: () => void st().resumeAll('all', place) },
    ...(waiting.some((r) => s.pins.includes(r.id)) ? [{ id: 'resume-pinned', label: t.resumePinnedItem, icon: 'pin' as const, disabled: busy, run: () => void st().resumeAll('pinned', place) }] : []),
    { id: 'dismiss-all', label: t.dismissAllItem, icon: 'x', danger: true, disabled: busy, run: () => st().askDismissAll(place) }
  ];
}

export function treeMenu(entry: { path: string; rel: string; dir: boolean; unsure?: boolean }, open: () => void): MenuItem[] {
  const hasSession = st().terminals.some((x) => x.session);
  const dir = entry.dir ? entry.path : dirOf(entry.path);
  return [
    { id: 'open', label: entry.dir ? m.toggleFolder : m.open, run: open },
    ...(entry.dir ? [] : [sideItem(() => st().openFileToSide(entry.path, entry.rel)), ...shelfToggle(entry.path, entry.rel)]),
    'sep',
    { id: 'new-file', label: m.newFile, icon: 'plus', run: () => st().startTreeEdit({ mode: 'new-file', dir }) },
    { id: 'new-folder', label: m.newFolder, icon: 'files', run: () => st().startTreeEdit({ mode: 'new-folder', dir }) },
    { id: 'rename', label: m.rename, run: () => st().startTreeEdit({ mode: 'rename', path: entry.path }) },
    { id: 'duplicate', label: m.duplicate, disabled: entry.dir, run: () => void duplicate(entry.path) },
    'sep',
    { id: 'copy-path', label: m.copyPath, run: () => copyPath(entry.path) },
    { id: 'copy-rel', label: m.copyRelPath, run: () => copyPath(entry.rel) },
    { id: 'reveal-finder', label: m.revealInFinder, icon: 'folderOpen', run: () => void window.atelier.reveal(entry.path) },
    'sep',
    ...hereItems(dir),
    { id: 'mention', label: m.mention, icon: 'sessions', disabled: !hasSession, run: () => mentionInSession(entry.path) },
    ...(entry.unsure && !entry.dir ? [whoChanged(entry.path)] : []),
    'sep',
    { id: 'trash', label: m.trash, icon: 'x', danger: true, run: () => void trash(entry.path) }
  ];
}

/** Sessions and terminals started in a folder of the tree (a file: its folder). */
function hereItems(dir: string): MenuItem[] {
  return [
    { id: 'session-here', label: m.newSessionHere, icon: 'sparkle', run: () => st().setFolderSheet({ kind: 'session', cwd: dir }) },
    { id: 'term-here', label: m.newTerminalHere, icon: 'terminal', run: () => void newTerminalIn(dir) }
  ];
}

/** Right-click on the tree's empty area: the project root. */
export function treeRootMenu(root: string): MenuItem[] {
  return [
    { id: 'new-file', label: m.newFile, icon: 'plus', run: () => st().startTreeEdit({ mode: 'new-file', dir: root }) },
    { id: 'new-folder', label: m.newFolder, icon: 'files', run: () => st().startTreeEdit({ mode: 'new-folder', dir: root }) },
    'sep',
    ...hereItems(root),
    'sep',
    { id: 'copy-path', label: m.copyPath, run: () => copyPath(root) },
    { id: 'reveal-finder', label: m.revealInFinder, icon: 'folderOpen', run: () => void window.atelier.reveal(root) }
  ];
}

async function duplicate(path: string) {
  const r = await window.atelier.files.duplicate(path);
  if ('error' in r) st().showToast(t.fileOpFailed(t.fileErrors[r.error] ?? r.error));
  else st().bumpTree();
}

/** Asked in the tree row, after any unsaved files under it. */
async function trash(path: string) {
  await st().askTrash(path);
}

/** A Changes row; `git`: its index state, for Stage/Unstage and Discard first. */
export function changeMenu(row: { path: string; rel: string; deleted: boolean; unsure?: boolean; git?: StageRow }): MenuItem[] {
  const hasSession = st().terminals.some((x) => x.session);
  // Like a click on the row: into the preview tab.
  const open = (mode: 'margin' | 'diff') => st().openFile(row.path, row.rel, null, mode, { preview: true });
  return [
    ...(row.git ? fileGitItems(row.git) : []),
    { id: 'open', label: m.open, disabled: row.deleted, run: () => open('margin') },
    { id: 'open-diff', label: m.openDiff, icon: 'git', run: () => open(row.deleted ? 'margin' : 'diff') },
    'sep',
    { id: 'copy-path', label: m.copyPath, run: () => copyPath(row.path) },
    { id: 'reveal-tree', label: m.revealInFiles, icon: 'files', disabled: row.deleted, run: () => st().revealInTree(row.path) },
    { id: 'reveal-finder', label: m.revealInFinder, icon: 'folderOpen', disabled: row.deleted, run: () => void window.atelier.reveal(row.path) },
    { id: 'mention', label: m.mention, icon: 'sessions', disabled: !hasSession, run: () => mentionInSession(row.path) },
    ...(row.unsure ? ['sep' as const, whoChanged(row.path)] : [])
  ];
}

/** Unsure who changed a file: the keyboard way to "Why unsure". */
function whoChanged(path: string): MenuItem {
  return { id: 'who-changed', label: t.unsure.menu, icon: 'question', run: () => st().setOriginSheet(path) };
}

export function editorMenu(path: string, actions: { copy: (() => void) | null; selectAll: () => void; find: () => void; findReplace?: (() => void) | null; gotoLine: () => void; mentionLines: (() => void) | null; commentLines?: (() => void) | null; changeLanguage?: () => void; togglePreview?: (() => void) | null; jsonTree?: (() => void) | null; copyJsonPath?: (() => void) | null; csvTable?: (() => void) | null; copyCsvCell?: (() => void) | null }): MenuItem[] {
  const lineItems: MenuItem[] = [
    ...(actions.commentLines ? [{ id: 'comment-lines', label: m.commentLines, icon: 'comment' as const, hint: kbd('⌘⌥C'), run: actions.commentLines }] : []),
    ...(actions.mentionLines ? [{ id: 'mention-lines', label: m.mentionLines, icon: 'sessions' as const, hint: kbd('⌘L'), run: actions.mentionLines }] : [])
  ];
  return [
    ...(lineItems.length ? [...lineItems, 'sep' as const] : []),
    { id: 'copy', label: m.copy, hint: kbd('⌘C'), disabled: !actions.copy, run: () => actions.copy?.() },
    { id: 'select-all', label: m.selectAll, hint: kbd('⌘A'), run: actions.selectAll },
    'sep',
    { id: 'find', label: m.find, icon: 'search', hint: kbd('⌘F'), run: actions.find },
    ...(actions.findReplace ? [{ id: 'find-replace', label: m.findReplace, icon: 'swap' as const, hint: kbd('⌥⌘F'), run: actions.findReplace }] : []),
    { id: 'goto', label: m.gotoLine, hint: kbd('⌃G'), run: actions.gotoLine },
    ...(actions.changeLanguage ? [{ id: 'change-language', label: m.changeLanguage, icon: 'code' as const, run: actions.changeLanguage }] : []),
    ...(actions.togglePreview ? [previewToggleItem(actions.togglePreview)] : []),
    // JSON navigation.
    ...(actions.jsonTree ? [{ id: 'json-tree', label: t.json.toggle, icon: 'tree' as const, hint: kbd('⇧⌘V'), run: actions.jsonTree }] : []),
    ...(actions.copyJsonPath ? [{ id: 'copy-json-path', label: t.json.menu.copyJsonPath, icon: 'path' as const, hint: kbd('⌥⇧⌘C'), run: actions.copyJsonPath }] : []),
    // CSV viewer.
    ...(actions.csvTable ? [{ id: 'csv-table', label: t.csv.toggle, icon: 'table' as const, hint: kbd('⇧⌘V'), run: actions.csvTable }] : []),
    ...(actions.copyCsvCell ? [{ id: 'copy-csv-cell', label: t.csv.menu.copyCell, icon: 'copy' as const, run: actions.copyCsvCell }] : []),
    ...(isUntitled(path) ? [] : ['sep' as const, ...fileRefItems(path)])
  ];
}

type PathFormat = 'jq' | 'js' | 'pointer';

/** Right-click on a JSON tree row: copies, Copy Path As in the three formats, Show in
 * Source, the filter, the subtree, the session. Null actions show disabled. */
export function jsonNodeMenu(node: { box: boolean; paths: Record<PathFormat, string>; format: PathFormat }, a: {
  copyValue: () => void; copyKey: (() => void) | null; copyPath: () => void; copyPathAs: (f: PathFormat) => void; openFormatSetting: () => void;
  showSource: () => void; filterByKey: (() => void) | null; expandChildren: (() => void) | null; collapseChildren: (() => void) | null; mention: (() => void) | null;
}): MenuItem[] {
  const j = t.json.menu;
  const formats = (['jq', 'js', 'pointer'] as const).map((f): MenuItem => ({ id: `path-${f}`, label: j.formats[f], detail: node.paths[f] || '(root)', run: () => a.copyPathAs(f) }));
  return [
    { id: 'copy-value', label: node.box ? j.copyValueJson : j.copyValue, hint: kbd('⌘C'), run: a.copyValue },
    { id: 'copy-key', label: j.copyKey, disabled: !a.copyKey, run: () => a.copyKey?.() },
    { id: 'copy-path', label: j.copyPath, hint: kbd('⌥⇧⌘C'), run: a.copyPath },
    { id: 'copy-path-as', label: j.copyPathAs, run: () => {}, submenu: [...formats, 'sep', { id: 'path-default', label: j.defaultFormat(j.formats[node.format]), run: a.openFormatSetting }] },
    'sep',
    { id: 'show-source', label: j.showInSource, hint: kbd('⌥⏎'), run: a.showSource },
    { id: 'filter-key', label: j.filterByKey, disabled: !a.filterByKey, run: () => a.filterByKey?.() },
    'sep',
    { id: 'expand-children', label: j.expandChildren, hint: kbd('⌥→'), disabled: !a.expandChildren, run: () => a.expandChildren?.() },
    { id: 'collapse-children', label: j.collapseChildren, hint: kbd('⌥←'), disabled: !a.collapseChildren, run: () => a.collapseChildren?.() },
    'sep',
    { id: 'mention', label: j.mention, accent: true, disabled: !a.mention, run: () => a.mention?.() }
  ];
}

type CsvCopyFormat = 'tsv' | 'csv' | 'markdown' | 'json' | 'sql';
const cut = (s: string, n = 24) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Right-click on a CSV table cell: copies, Copy As (each format with a sample), filters, sort,
 * the source, the session. Null actions show disabled. */
export function csvCellMenu(c: { value: string; column: string; rows: string; block: string; samples: Record<CsvCopyFormat, string>; delimiter: string; header: boolean }, a: {
  copy: () => void; copyAs: (f: CsvCopyFormat) => void; toggleHeader: () => void; copyNames: () => void; filterBy: () => void; exclude: () => void;
  sortAsc: () => void; sortDesc: () => void; showSource: () => void; comment: (() => void) | null; mention: (() => void) | null;
}): MenuItem[] {
  const m = t.csv.menu;
  const notes: Partial<Record<CsvCopyFormat, string>> = { tsv: m.formatNotes.tsv, csv: m.formatNotes.csv(c.delimiter === '\t' ? '⇥' : c.delimiter), json: m.formatNotes.json };
  const formats = (['tsv', 'csv', 'markdown', 'json', 'sql'] as const).map((f): MenuItem => ({ id: `as-${f}`, label: m.formats[f], detail: c.samples[f], ...(notes[f] ? { hint: notes[f] } : {}), run: () => a.copyAs(f) }));
  const value = cut(c.value || '(empty)');
  return [
    { id: 'copy', label: m.copy, hint: kbd('⌘C'), run: a.copy },
    { id: 'copy-as', label: m.copyAs, tip: c.block, run: () => {}, submenu: [...formats, 'sep', { id: 'as-header', label: m.includeHeader, ...(c.header ? { icon: 'check' as const } : {}), run: a.toggleHeader }] },
    { id: 'copy-names', label: m.copyNames, run: a.copyNames },
    'sep',
    { id: 'filter-by', label: m.filterBy(value), run: a.filterBy },
    { id: 'exclude', label: m.exclude(value), run: a.exclude },
    { id: 'sort-asc', label: m.sortBy(cut(c.column), '↑'), run: a.sortAsc },
    { id: 'sort-desc', label: m.sortBy(cut(c.column), '↓'), run: a.sortDesc },
    'sep',
    { id: 'show-source', label: m.showInSource, hint: kbd('⌥⏎'), run: a.showSource },
    { id: 'comment', label: m.comment(c.rows), hint: kbd('⌥⌘C'), disabled: !a.comment, run: () => a.comment?.() },
    { id: 'mention', label: m.mention(c.rows), hint: kbd('⌘L'), accent: true, disabled: !a.mention, run: () => a.mention?.() }
  ];
}

const previewToggleItem = (run: () => void): MenuItem =>({ id: 'md-preview', label: t.md.toggle, icon: 'eye', hint: kbd('⇧⌘V'), run });

/** Right-click in the Markdown preview: the lines behind the selection, copies, find, the
 * block under the pointer in the source. */
export function previewMenu(path: string, actions: {
  copy: (() => void) | null; copyMarkdown: (() => void) | null; selectAll: () => void; find: () => void;
  showSource: { line: number; run: () => void } | null; mentionLines: (() => void) | null; commentLines: (() => void) | null; togglePreview: () => void;
}): MenuItem[] {
  const lineItems: MenuItem[] = [
    ...(actions.commentLines ? [{ id: 'comment-lines', label: m.commentLines, icon: 'comment' as const, hint: kbd('⌘⌥C'), run: actions.commentLines }] : []),
    ...(actions.mentionLines ? [{ id: 'mention-lines', label: m.mentionLines, icon: 'sessions' as const, hint: kbd('⌘L'), run: actions.mentionLines }] : [])
  ];
  const show = actions.showSource;
  return [
    ...(lineItems.length ? [...lineItems, 'sep' as const] : []),
    { id: 'copy', label: m.copy, hint: kbd('⌘C'), disabled: !actions.copy, run: () => actions.copy?.() },
    { id: 'copy-markdown', label: t.md.copyMarkdown, disabled: !actions.copyMarkdown, run: () => actions.copyMarkdown?.() },
    { id: 'select-all', label: m.selectAll, hint: kbd('⌘A'), run: actions.selectAll },
    'sep',
    { id: 'find', label: m.find, icon: 'search', hint: kbd('⌘F'), run: actions.find },
    'sep',
    ...(show ? [{ id: 'show-source', label: t.md.showInSource, icon: 'code' as const, hint: t.md.lineHint(show.line), run: show.run }] : []),
    previewToggleItem(actions.togglePreview),
    ...(isUntitled(path) ? [] : ['sep' as const, ...fileRefItems(path)])
  ];
}

export function terminalMenu(actions: {
  copy: (() => void) | null; paste: () => void; selectAll: () => void; clear: () => void;
  /** Open in Finder: the folder the terminal is in now (its last name in the label). */
  finder?: { name: string | null; run: () => void } | null;
  /** The command block under the pointer (command blocks on): its copy actions, null when it has nothing to copy. */
  block?: { copyCommand: (() => void) | null; copyOutput: (() => void) | null } | null;
  /** The selection to another terminal: null without one; absent, no items. */
  send?: { run: () => void; pick: () => void } | null;
  /** The selection as a scheduled prompt: its text, null without one; absent, no item. */
  later?: string | null;
  /** Find in the terminal: opens its card. */
  find?: () => void;
}): MenuItem[] {
  const b = actions.block;
  const s = actions.send;
  const sendItems: MenuItem[] = s !== undefined ? [
    { id: 'run-in-new-terminal', label: t.send.runInNew, icon: 'terminal', disabled: !s, tip: s ? undefined : t.send.selectFirst, run: () => s?.run() },
    { id: 'send-to-terminal', label: t.send.sendTo, icon: 'send', disabled: !s, tip: s ? undefined : t.send.selectFirst, run: () => s?.pick() },
    ...(actions.later !== undefined ? [sendLaterItem(actions.later)] : []),
    'sep'
  ] : [];
  const blockItems: MenuItem[] = b ? [
    { id: 'copy-command', label: t.blocks.menuCopyCommand, disabled: !b.copyCommand, run: () => b.copyCommand?.() },
    { id: 'copy-output', label: t.blocks.menuCopyOutput, disabled: !b.copyOutput, run: () => b.copyOutput?.() },
    'sep'
  ] : [];
  return [
    ...sendItems,
    ...blockItems,
    { id: 'copy', label: m.copy, hint: kbd('⌘C'), disabled: !actions.copy, run: () => actions.copy?.() },
    { id: 'paste', label: m.paste, hint: kbd('⌘V'), run: actions.paste },
    { id: 'select-all', label: m.selectAll, hint: kbd('⌘A'), run: actions.selectAll },
    'sep',
    ...(actions.find ? [{ id: 'find', label: m.find, icon: 'search' as const, hint: terminalFindKeys(), run: actions.find }, 'sep' as const] : []),
    ...(actions.finder ? [{ id: 'open-in-finder', label: actions.finder.name ? m.openNamedInFinder(actions.finder.name) : m.openInFinder, icon: 'folderOpen' as const, hint: kbd('⌘⌥R'), run: actions.finder.run }, 'sep' as const] : []),
    { id: 'clear', label: m.clear, run: actions.clear }
  ];
}

/** Send Later to ▸ <session>: the composer for that session with the selection as the prompt. */
function sendLaterItem(text: string | null): MenuItem {
  const sessions = st().terminals.filter((x) => x.session);
  const why = !text ? t.send.selectFirst : !st().daemon.schedulesAvailable ? t.sched.unavailable : sessions.length === 0 ? t.sched.notClaude : null;
  return {
    id: 'send-later', label: t.sched.sendLater, icon: 'sendLater', disabled: why !== null, tip: why ?? undefined, run: () => {},
    submenu: why ? undefined : sessions.map((x) => ({ id: `send-later:${x.id}`, label: x.title, run: () => openScheduleSheet(x.id, text!) }))
  };
}

/** "+ New": a single place to create sessions and terminals (top bar and the tabs' "+"). */
export function newMenu(actions: { session: () => void; terminal: () => void }): MenuItem[] {
  const hasResumable = hasSomethingToResume();
  return [
    { id: 'new-session', label: m.newSession, icon: 'sparkle', hint: kbd('⌘N'), run: actions.session },
    { id: 'new-terminal', label: m.newTerminal, icon: 'terminal', hint: kbd('⌘T'), run: actions.terminal },
    profileSubmenu(st().shells, st().daemon.profilesAvailable, st().settings.terminalProfile, (key) => void newTerminalIn(undefined, key)),
    { id: 'session-in-folder', label: m.sessionInFolder, icon: 'files', run: () => st().setFolderSheet({ kind: 'session' }) },
    { id: 'terminal-in-folder', label: m.terminalInFolder, icon: 'files', run: () => st().setFolderSheet({ kind: 'terminal' }) },
    'sep',
    { id: 'resume', label: m.resumeSession, icon: 'resume', hint: kbd('⌘⇧N'), disabled: !hasResumable, run: () => st().setPaletteOpen(true, 'resume:') },
    'sep',
    { id: 'new-file', label: m.newUntitled, icon: 'plus', hint: kbd('⌘⌥N'), disabled: !st().project, run: () => st().newUntitled() },
    'sep',
    // Split view: an empty pane on the right of the focused one (at three panes it says why not).
    { id: 'split-right', label: m.splitRight, icon: 'split', hint: kbd('⌘\\'), disabled: st().split.panes.length >= MAX_PANES, tip: st().split.panes.length >= MAX_PANES ? t.split.max : undefined, run: () => st().splitRight() }
  ];
}

/** Sessions' "+": the two ways to start a session, below the button. */
export function sessionPlusMenu(o: { session: () => void; folder: () => void; terminal?: () => void; activity?: { run: () => void; disabled?: string } }): MenuItem[] {
  // With activities: New Terminal (a workspace's and an activity's "+"), and New Activity… (a workspace's).
  return [
    { id: 'new-session', label: m.newClaudeSession, icon: 'sparkle', hint: kbd('⌘N'), run: o.session },
    { id: 'session-in-folder', label: m.sessionInFolder, icon: 'files', hint: kbd('⌘⌥⇧N'), run: o.folder },
    ...(o.terminal ? [{ id: 'new-terminal', label: t.wsAct.newTerminal, icon: 'terminal' as const, hint: kbd('⌘T'), run: o.terminal }] : []),
    ...(o.activity ? ['sep' as const, {
      id: 'new-ws-activity', label: t.wsAct.newActivity, icon: 'wsActivity' as const, run: o.activity.run,
      ...(o.activity.disabled ? { disabled: true, tip: o.activity.disabled } : {})
    }] : [])
  ];
}

/**
 * The New menu below a button. "Resume Session…" depends on Claude's history, read now (cached by the main process
 * after the first time); a slow first read doesn't hold the menu: it opens with what is already known.
 */
export async function openNewMenu(el: HTMLElement, actions: { session: () => void; terminal: () => void }): Promise<void> {
  await Promise.race([refreshHistory(), new Promise((r) => setTimeout(r, 250))]);
  if (el.isConnected) openBelow(el, newMenu(actions));
}

/** Opens a menu below a button, aligned to its left edge. */
export function openBelow(el: HTMLElement, items: MenuItem[]) {
  const r = el.getBoundingClientRect();
  st().openMenu({ x: r.left, y: r.bottom + 6, anchor: { left: r.left, right: r.right, bottom: r.bottom } }, items);
}

/** A linked worktree's group in Changes: review it, compare it, its history, open it. */
export function worktreeMenu(wt: RepoStatus): MenuItem[] {
  const root = wt.root;
  const base = wt.merge?.base ?? 'main';
  return [
    ...repoGitItems(root),
    { id: 'review-worktree', label: m.reviewWorktree, icon: 'review', run: () => st().openReview(`repo:${root}`) },
    { id: 'compare-default', label: t.wt.compareWith(base), icon: 'compare', disabled: !wt.merge, run: () => st().openReview(`repo:${root}`, { againstMain: true }) },
    ...(wt.branch && !wt.detached ? [{ id: 'show-branch-history', label: t.scm.menu.showHistoryOf(wt.branch), icon: 'git' as const, run: () => showHistory(`refs/heads/${wt.branch}`, root) }] : []),
    'sep',
    { id: 'term-here', label: m.openTerminalHere, icon: 'terminal', run: () => void newTerminalIn(root) },
    { id: 'reveal-finder', label: m.revealInFinder, icon: 'folderOpen', run: () => void window.atelier.reveal(root) }
  ];
}
