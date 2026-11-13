import { create } from 'zustand';
import type { AutomationsState, DaemonState, ProjectInfo } from '@shared/api';
import type { Automation } from '@shared/automations';
import type { TerminalInfo } from '@shared/protocol';
import type { UsageEntry } from '@shared/session';
import type { ContextReport } from '@shared/context-usage';
import { cronRowId } from '@shared/loop';
import type { RepoStatus } from '@shared/git';
import type { Attribution } from '@shared/attribution';
import type { ServicePane, ServicesStatus } from '@shared/services';
import type { PortsMap } from '@shared/ports';
import { EMPTY_PRS, type PrsState } from '@shared/pr';
import type { Resumable } from '@shared/protocol';
import type { ScheduledPrompt } from '@shared/scheduled-prompts';
import type { SignalBookView } from '@shared/claude-signals';
import type { ClaudeConversation } from '@shared/history';
import { MAX_FILE_BYTES } from '@shared/files';
import type { SearchFile, SearchLine, SearchSpec, SearchTarget } from '@shared/search';
import { feedKey, type BackgroundFeed, type Unavailable, type WatchResult } from '@shared/background-feed';
import type { TimelineEntry, TimelineMeta } from '@shared/transcript';
import { BUFFER_LINES } from '@shared/output-tail';
import { firstItemId } from './background-view';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import type { ShellOption } from '@shared/profiles';
import type { MenuItem } from './menu-model';
import { isDirtyNow, saveMany } from './editor/savers';
import { putHandoff } from './editor/handoff';
import { afterClose, canPopOut, moveTab as moveKey, noteActive, openTab, syncTerminals, type TabKey } from './tabs-model';
import { dropRecent, pushRecent, renameRecent, type RecentFile } from './recent';
import { clampPanel, loadLayout, saveLayout, type Panel, type PanelWidths } from './panels';
import { loadChangesPrefs, saveChangesPrefs, toggleAllGroups, toggleGroup } from './changes-prefs';
import { loadPins, pinnedFirst, prunePins, relinkPin, savePins, togglePin } from './pins';
import { resumablesFor } from './selectors';
import { loadShelf, loadShelfCollapsed, nudgeInShelf, outsideOf, placeInShelf, removeFromShelf, saveShelf, saveShelfCollapsed, shelvable, touchesShelf, ungranted, type ShelfItem } from './shelf';
import { hideIds, loadHidden, saveHidden, showId } from './hidden-tabs';
import { loadGroupByState, saveGroupByState } from './inbox';
import { addNotes, dockerSubject, markAllRead, markEntryRead, markSessionSeen, parseNotes, pruneUnseen, triggerNote, type NoteEntry } from '@shared/notifications';
import { loadNotes, saveNotes, viewingNow } from './notes';
import { chimeFor, playChime } from './chime';
import { loadComments, saveComments, snippetFields, type LineComment } from './comments';
import { t } from './i18n/en';
import { isUntitled, nextUntitled } from './untitled';
import { mergeOrder, restoredActive, snapshotTabs } from './tabs-restore';
import type { RestoredTabs } from '@shared/tabs-state';
import { STARTING_MS, markStarting, pruneStarting, type Starting } from './starting';
import type { DictationStatus } from '@shared/dictation';
import type { UpdateStatus } from '@shared/update-feed';
import type { ConnectorId, ConnectorInfo, ConnectorNotice, TaskList } from '@shared/tasks';
import { loadTaskLinks, pruneTaskLinks, saveTaskLinks, type TaskLink, type TaskLinks } from './task-links';
import { CONNECTOR_NAMES, noticeView } from './connectors-view';
import { withTerminal } from '@shared/terminal-list';
import { languageFor, type LanguageId } from '@shared/languages';
import { defaultView, dropMdViews, loadMdViews, mdViewOf, renameMdViews, saveMdViews, withMdView, type MdView, type MdViews } from './markdown-views';
import { dropCsvOptions, loadCsvOptions, renameCsvOptions, saveCsvOptions, withOptions, type CsvOptionsMap } from './csv/options';
import type { CsvOptions } from './csv/types';
import { dropOverrides, loadOverrides, renameOverrides, saveOverrides, withOverride, type LangOverrides } from './lang-overrides';
import {
  flatten, focusPane as focusAt, focusStep, isSplit, lift, moveStep, moveTab as moveToPane, moveToNewPane, openToSide as toSide, paneOf,
  placeOpened, reconcile, removeKeys, renameKeys, restoreLayout, savedKeys, serializeLayout, single, splitRight as addPane, stripKeys, unsplit, unsplitAll, visibleKeys, type DropZone, type SavedLayout, type Split
} from './split';
import { loadLayout as loadSplitLayout, saveLayout as saveSplitLayout } from './layout-store';
import { adoptTerminals, pruneDrafts, setDialogProbe } from './terminal/drafts';
import { isWaiting } from '@shared/session-view';
import type { RepoSearch, ScmFetchState, ScmRefs, ScmRepoEntry, ScmScope } from '@shared/scm';
import { loadScmPrefs, saveScmPrefs } from './scm/prefs';
import { healAfterOpen } from './terminal-heal';
import type { DockEvent, Point, PopoutBoot, PopoutOpenResult, PopoutReveal, ProjectWindowInfo } from '@shared/popout';
import { applyPayload, payloadOf } from './popout-payload';
import { createGitSlice, type GitSlice } from './git/slice';
import { freshEntries } from './git/sync-intents';
import { createConfirmsSlice, staleConfirms, type ConfirmsSlice } from './confirms/slice';
import { createRestartSlice, restartStarting, type RestartSlice } from './session-restart';
import { createCompanionSlice, type CompanionSlice } from './companion/slice';
import { pruneThreads } from './companion/model';
import { forgetEntrance } from './companion/view';
import { onScreen } from './on-screen';
import { tabMove } from './popout-move';
import {
  absorb as wsAbsorb, assign as wsAssign, create as wsCreate, forget as wsForget, initial as wsInitial, isProjectKey, workspaceKey, memberOf, moveKey as wsMove, newWorkspaceId,
  projectLast, prune as wsPrune, recolor as wsRecolor, relink as wsRelink, remove as wsRemove, rename as wsRename, renameKeys as wsRenameKeys, reorder as wsReorder,
  toFront as wsToFront, toggleOpen as wsToggleOpen, union as wsUnion, viewOf, withView, placeOnReturn, workspacesOf, activitiesOf, workspaceOf,
  createWsActivity as wsCreateAct, moveWsActivity as wsMoveAct, removeWsActivity as wsRemoveAct, type WorkspacesState
} from './workspaces';
import { revTitle } from './scm/titles';
import { loadWorkspaces, saveWorkspaces } from './workspaces-save';
import { isBelow } from '@shared/paths';
import { isShell } from '@shared/shells';
import { dbRefOfKey, dbTabKey, parseDbTabKey, type DbTabRef, type DbTabView } from './databases/tabs';
import { dockerKey } from './docker/tabs';
import { redisKey, redisViewsShown } from './redis/tabs';
import { autoKey } from './automations/tabs';
import { emptyViews, forgetInViews, renameInViews, SPACE_ACTIVITY, spaceOf, spaceOfActivity, type Activity, type SpaceId, type SpaceView, type SpaceViews } from './spaces';
import { useRedis } from './redis/store';
import type { DbFilter } from '@shared/databases-filters';
import { useDb } from './databases/store';
import { keyboardInSidebar, keyboardToWork, readSidebarHidden, writeSidebarHidden } from './sidebar-hidden';

export type { Activity } from './spaces';
/** What the Redis tab shows. */
export type RedisView = 'keys' | 'queues' | 'live' | 'overview';
/** An Automations tab: one automation, or every project's list (id null), keyed `au:`. */
export interface AutoTabRef { key: TabKey; id: string | null }
/** What the Docker tab shows: a container, a compose project's whole stack, or the engine. */
export type DockerTarget = { kind: 'container'; id: string } | { kind: 'stack'; project: string } | { kind: 'overview' };
export type DockerView = 'logs' | 'inspect';
/** A Docker tab: one per target, keyed by it (docker/tabs.ts), each with its own view. */
export interface DockerTabRef { key: TabKey; target: DockerTarget; view: DockerView; nonce: number }
/** What the Background tab shows of one followed item. */
export interface BgFeedState {
  kind: 'output' | 'timeline';
  /** Output lines with the time they arrived (null: already in the file when the inspector opened). */
  lines: { text: string; at: number | null }[];
  live: string;
  dropped: number;
  exit: number | null;
  entries: TimelineEntry[];
  meta: TimelineMeta | null;
  unavailable?: Unavailable;
}
/** The History tab: which repository and what of it. */
export interface HistoryTab { repo: string; scope: ScmScope; nonce: number }
/** A file at a commit, open read-only. */
export interface RevFile { key: `rev:${string}`; root: string; oid: string; rel: string }
export type NotesFilter = 'all' | 'triggers';
/**
 * A selection on its way to another terminal: the text and the folder its terminal is in now (null: unknown).
 * `newSession`: the text is context for Claude, so only Claude sessions are offered, and a new one started this way.
 */
export interface PaletteSend { text: string; cwd: string | null; newSession?: (send: boolean) => void }
export type FileMode = 'margin' | 'diff';
export type TreeEdit = { mode: 'new-file' | 'new-folder'; dir: string } | { mode: 'rename'; path: string };
export type FolderSheet = { kind: 'session' | 'terminal'; cwd?: string };
/** A Find in Files result for its file's tab to show (it carries it until shown). */
export type FoundTarget = SearchTarget;
/** What a search result adds to opening its file: the match to show, and the large view for a file past 5 MB. */
interface FileOpening { found?: FoundTarget; large?: true }
/** large: text past 5 MB opened with Open Anyway (or from a search result), read through files.readLarge. */
export interface OpenFile { path: string; rel: string; line: number | null; nonce: number; mode: FileMode; large?: true; found?: FoundTarget }
/** Where a tab dragged back from its pop-out lands: before a strip tab (null: at the end), or on a pane's zone. */
export type DockTarget = { kind: 'strip'; pane: number; before: TabKey | null } | { kind: 'pane'; pane: number; zone: DropZone };
/** Where a tab dragged inside the window lands: as a pop-out dragged back, or on the Shelf, before a file. */
export type TabDropTarget = DockTarget | { kind: 'shelf'; before: string | null } | { kind: 'workspace'; id: string };
/** A pop-out window's default size. */
export const POPOUT_SIZE = { width: 900, height: 620 } as const;

/** Resume all running: `done` = resumed or starting; `queue` = still to come. */
export interface BulkResume { total: number; done: number; queue: string[]; stopped: boolean }

export interface AppState extends GitSlice, ConfirmsSlice, RestartSlice, CompanionSlice {
  /**
   * Tab pop-out windows. Set in a pop-out window (before the project): the one tab it holds. Its store
   * keeps just that tab and never saves tabs, layout or hidden tabs.
   */
  popout: PopoutBoot | null;
  /** The pop-out window's mode: its tab alone, active, in one pane (the payload gives it what it shows). */
  enterPopout(boot: PopoutBoot): void;
  /** Main window: the keys living in pop-outs now. They leave the strip and panes like closed tabs, nothing hidden. */
  poppedOut: TabKey[];
  applyPoppedOut(keys: string[]): void;
  /** Move to New Window: a key already popped out only brings its window forward. */
  popOut(key: TabKey, at: 'cursor' | 'cascade', size?: { width: number; height: number }): Promise<void>;
  /** A pop-out's tab back in the main window: after the active tab and active, or at the place it was dropped. */
  applyDock(e: DockEvent, target?: DockTarget | null): void;
  /** In a pop-out: come forward for a line (files) or a newer payload (special tabs). */
  revealInPopout(r: PopoutReveal): void;
  /**
   * A pop-out dragged over this window (drag back): the client point under the pointer, null when it left; its key
   * (its own project's window: where it lands depends on its space) or `across` (another's).
   */
  dockHover: (Point & { across?: boolean; key?: string }) | null;
  setDockHover(p: (Point & { across?: boolean; key?: string }) | null): void;
  /** The open project windows, this one included: Move to Window ›. */
  projectWindows: ProjectWindowInfo[];
  setProjectWindows(list: ProjectWindowInfo[]): void;
  /** A tab that went to another project's window: gone from here, nothing unsaved left behind (its buffer went along). */
  dropMovedTab(key: TabKey): void;
  project: ProjectInfo | null;
  projectLoaded: boolean;
  terminals: TerminalInfo[];
  selectedId: string | null;
  activity: Activity;
  /**
   * The sidebar hidden: the work area takes its width and no activity is shown in front;
   * `activity` keeps the view it shows again on. Remembered for the next window (sidebar-hidden.ts).
   */
  sidebarHidden: boolean;
  /** View › Sidebar (⌘B): hides it, or shows it on the view it had. Nothing in a pop-out (it has none). */
  toggleSidebar(): void;
  /** The activity bar: the view in front clicked again hides the sidebar; any other click shows it. */
  clickActivity(a: Activity): void;
  daemon: DaemonState;
  size: { cols: number; rows: number };
  /** Limits per Claude config dir; the meter picks the selected session's. */
  usage: UsageEntry[];
  /** Files open as tabs next to the terminal. */
  openFiles: OpenFile[];
  /** 'term' = the selected terminal, otherwise the file path. */
  activeTab: 'term' | string;
  /** The preview tab (italic, replaced by the next file opened with a single click): at most one, by path. */
  preview: string | null;
  /** The preview tab becomes a normal tab (double click on it, Keep Open, typing, saving, dragging). */
  keepOpen(path: string): void;
  /** File › New File: an "Untitled-N" editor tab with no file on disk. */
  newUntitled(): void;
  /** Open "Save as" sheet for an untitled tab (text: its current buffer; done: the pending save's answer). */
  saveAs: { path: string; text: () => string; done: (ok: boolean) => void } | null;
  /** Saving an untitled tab: opens the sheet; true once written, false if cancelled. */
  requestSaveAs(path: string, text: () => string): Promise<boolean>;
  /** Writes the buffer at the path typed in the sheet; on success the tab becomes that file. */
  submitSaveAs(rel: string): Promise<{ path: string } | { error: string }>;
  /**
   * Save Outside the Project…: main's save panel, its name field holding `name`; once
   * written the tab becomes that file, as main labels it. Canceled in the panel: nothing changes, the sheet stays.
   */
  submitSaveAsOutside(name: string): Promise<{ path: string; rel: string } | { error: string } | { canceled: true }>;
  cancelSaveAs(): void;
  /** Change Language Mode: the language chosen per tab path (real files saved between launches, untitled tabs in memory). */
  langOverrides: LangOverrides;
  /** Sets the tab's language; null (Auto) goes back to what its name says. */
  setLanguage(path: string, lang: LanguageId | null): void;
  /** Markdown preview: the view chosen per file (real files saved between launches). */
  mdViews: MdViews;
  /**
   * Files a Find in Files result opened: their source shows for this visit (the match is selected there), whatever view
   * is saved for them; choosing a view or opening the file any other way ends it. In memory only.
   */
  mdVisit: Record<string, true>;
  /** The view a Markdown or JSON tab shows (`preview`: JSON's Tree): its own choice, otherwise Settings › Editor's default. */
  mdViewOf(path: string): MdView;
  /** Chooses a Markdown tab's view; Split and Preview take a tab out of the Diff view. */
  setMdView(path: string, view: MdView): void;
  /** CSV viewer: each file's parse options (real files saved between launches). */
  csvOptions: CsvOptionsMap;
  setCsvOptions(path: string, o: CsvOptions): void;
  /** The tab whose language is being picked (the sheet is open), null otherwise. */
  languageSheet: string | null;
  setLanguageSheet(path: string | null): void;
  /** Change Theme…. */
  themeSheet: boolean;
  setThemeSheet(open: boolean): void;
  /** Change Terminal Font…. */
  fontSheet: boolean;
  setFontSheet(open: boolean): void;
  /** The terminal font a picker is showing without saving it, null otherwise. */
  fontPreview: string | null;
  setFontPreview(family: string | null): void;
  /** The file whose "Why unsure" sheet is open, null otherwise. */
  originSheet: string | null;
  setOriginSheet(path: string | null): void;
  /** By session: the Maybe sub-groups the user opened ('session:<id>'); closed by default, for the window's life. */
  changesMaybeOpen: string[];
  toggleMaybe(id: string): void;
  /** Settles unsure files (a candidate's terminal id, or null: outside Claude), then a toast with Undo. */
  resolveUnsure(paths: string[], terminalId: string | null, name: string): Promise<void>;
  newSessionOpen: boolean;
  /** The Claude account the New Session sheet opens on ("New Session as …"); null: the one set for new sessions. */
  newSessionAccount: string | null;
  /** The default Claude account's config dir, from main (null until known): how its sessions are told apart. */
  claudeDefaultDir: string | null;
  /** The user's home, from main (null until known): a `~/…` folder typed in Settings › Claude › Accounts. */
  home: string | null;
  /** The settings came from main (until then they are the defaults: no Claude account but the default one). */
  settingsLoaded: boolean;
  /** "New Session/Terminal in Folder…": the folder picker (with cwd: the folder is already chosen, only the name is asked). */
  folderSheet: FolderSheet | null;
  repos: RepoStatus[];
  attributions: Attribution[];
  showChanges: boolean;
  changesGroup: 'repo' | 'session';
  /** Collapsed Changes groups ('repo:<root>' / 'session:<id>'), saved between launches. */
  changesCollapsed: string[];
  /** Expanded Changes rows: two lines per file with its folder (compact, one line, by default); saved between launches. */
  changesExpanded: boolean;
  /** Collapses or expands one group; with `all` (⌥-click) every group in it follows the clicked one. */
  toggleChangesGroup(key: string, all?: string[]): void;
  toggleChangesExpanded(): void;
  /** Pinned terminal ids of this project, in pin order (their rows go to the top of their list); saved between launches. */
  pins: string[];
  togglePinned(id: string): void;
  /** The Shelf: project files kept at hand in the Sessions sidebar, in order; saved per project. */
  shelf: ShelfItem[];
  /** The Shelf section shows only its head (saved between launches, the same for every project). */
  shelfCollapsed: boolean;
  /** Puts a project file on the shelf before `before` (default: last); one already there moves. Opens a collapsed shelf. */
  addToShelf(path: string, rel: string, before?: string | null): void;
  removeFromShelf(path: string): void;
  /** Moves a file one place up (-1) or down (1). */
  nudgeShelf(path: string, by: -1 | 1): void;
  /** Empties the shelf; a toast offers Undo. */
  clearShelf(): void;
  toggleShelfCollapsed(): void;
  /** Bumped when main reports a disk change under a shelved file: the shelf checks again what is missing. */
  shelfNonce: number;
  /** The shelf's outside files main did not grant again at launch (gone, or swapped for a link): shown as missing. */
  shelfUngranted: string[];
  /**
   * Terminals of this project whose tab was closed: they keep running and stay in the sidebar, selecting one shows its
   * tab again. Saved between launches like the pins.
   */
  hidden: string[];
  /** Incremented when the file changes on disk: open views re-read it. */
  diskNonce: Record<string, number>;
  /** Image tabs whose last read found them in Claude's temp folder: their tab says so. */
  claudeTemp: Record<string, true>;
  services: ServicePane[];
  servicesStatus: ServicesStatus;
  /** Listening ports of this project's terminals, from main. */
  ports: PortsMap;
  /** Pull requests of this project's sessions and the GitHub CLI status, from main. */
  prs: PrsState;
  serviceLines: Record<string, string[]>;
  serviceSeq: Record<string, number>;
  /** Last line of the capture, which may still be rewritten (prompt, progress, last line of a log). */
  serviceLive: Record<string, string>;
  /** Service cards whose lines wrap, for the window's life. */
  serviceWrap: Record<string, true>;
  toggleServiceWrap(id: string): void;
  servicesOpen: boolean;
  /** The review tab: 'all' or a terminal id; null when it isn't open. */
  /** againstMain: this opening's choice (Compare with main), leaving the saved preference alone. */
  review: { scope: string; nonce: number; againstMain?: boolean } | null;
  /** Opens (or retargets) the review tab and shows it; scope 'all', a terminal id or 'repo:<root>' (a working tree). */
  openReview(scope: string, o?: { againstMain?: boolean }): void;
  /** Review "Against main": the branch's commits too, not only the working tree; remembered per viewer. */
  reviewAgainstMain: boolean;
  setReviewAgainstMain(on: boolean): void;
  /** Source Control: the switcher's entries (null until main answers), the selected one. */
  scmRepos: ScmRepoEntry[] | null;
  scmRepo: string | null;
  /** How the project's folder scan for repositories went (null until main answers). */
  scmSearch: RepoSearch | null;
  setScmSearch(s: RepoSearch): void;
  /** The last refs read per repository root. */
  scmRefs: Record<string, ScmRefs>;
  /** Fetch states per git common dir: running, last outcome. */
  scmFetch: Record<string, ScmFetchState>;
  setScmFetch(s: ScmFetchState): void;
  /** Collapsed sidebar sections ('branches', 'tags', 'worktrees', 'stashes', 'remote:<name>'), per project. */
  scmCollapsed: string[];
  /** Source Control's view: One repository (the switcher) or All Repositories, per project. */
  scmView: 'one' | 'all';
  /** A view picked before the window's project was known: it wins over the saved one, and is saved with the project. */
  scmViewAsked: 'one' | 'all' | null;
  setScmView(view: 'one' | 'all'): void;
  /** All Repositories: blocks folded (true) or unfolded (false) by hand, per project; the rest follow foldedOf. */
  scmFolds: Record<string, boolean>;
  /** `def`: the block's own default (foldedOf): a fold back to it is forgotten, so only folds by hand are kept. */
  setScmFold(root: string, folded: boolean, def: boolean): void;
  /** All Repositories: Sync All, Pull All or Push All running in this window (one at a time), null when none. */
  scmBulk: 'sync' | 'pull' | 'push' | null;
  setScmBulk(bulk: 'sync' | 'pull' | 'push' | null): void;
  /** The History tab, null when it isn't open. */
  historyTab: HistoryTab | null;
  /** The Background tab: one tab, its terminal scope and item chosen inside. */
  backgroundTab: { terminalId: string; itemId: string | null; nonce: number } | null;
  /** Docker tabs: one per target the sidebar (or a link) opened, in no particular order. */
  dockerTabs: DockerTabRef[];
  /** The Docker preview tab: replaced by the next sidebar click, kept by working in it. */
  dockerPreview: TabKey | null;
  /**
   * Shows `target` in its tab (an open one comes to the front, in `view` when one is asked for); `preview`: a sidebar
   * click (Settings › Preview tabs).
   */
  openDocker(target: DockerTarget, view?: DockerView, o?: { preview?: boolean }): void;
  /** A tab's Logs · Inspect switch: it keeps a preview. */
  setDockerView(key: TabKey, view: DockerView): void;
  keepDockerTab(key: TabKey): void;
  /** Redis tabs: the views open, one tab each (`rd:<view>`). */
  redisTabs: RedisView[];
  /** Shows a view in its tab (Keys when none is asked for); a view the instance doesn't offer opens nothing. */
  openRedis(view?: RedisView): void;
  /** Automations: every project's, from main; the tab shows one (or all) and its runs. */
  automations: AutomationsState;
  setAutomations(s: AutomationsState): void;
  /** Automations tabs: one per automation opened, and every project's list. */
  autoTabs: AutoTabRef[];
  /** The Automations preview tab: replaced by the next sidebar click. */
  autoPreview: TabKey | null;
  /** The sidebar's This project / All: which cards it lists (no tab changes with it). */
  autoFilter: 'project' | 'all';
  /** Shows an automation in its tab (null: every project's list); `preview`: a sidebar click (Settings › Preview tabs). */
  openAutomations(id: string | null, o?: { preview?: boolean }): void;
  setAutoFilter(f: 'project' | 'all'): void;
  keepAutoTab(key: TabKey): void;
  /** The editor sheet: a draft and what it was before (null: new). */
  automationEditor: { draft: Automation; prev: Automation | null } | null;
  editAutomation(draft: Automation | null, prev?: Automation | null): void;
  /** The Turn On sheet: the automation (saved) to turn on. */
  automationConsent: { automation: Automation; reconfirm: boolean } | null;
  /** reconfirm: an edit widened an automation that was on; Cancel turns it off. */
  askTurnOn(a: Automation | null, reconfirm?: boolean): void;
  /** The Close Run sheet: the run's id. */
  closingRun: string | null;
  askCloseRun(runId: string | null): void;
  /** Feeds received from main, key = feedKey(terminalId, itemId). */
  bgFeeds: Record<string, BgFeedState>;
  /** The keys being followed now: a feed for any other (one main sent before it saw the unwatch) is ignored. */
  bgWatched: Record<string, true>;
  /** Follows an item (its feeds are taken from now on). */
  watchBackground(terminalId: string, itemId: string): Promise<WatchResult>;
  unwatchBackground(terminalId: string, itemId: string): void;
  /** The chip's popover. */
  bgPopover: { terminalId: string; anchor: { left: number; top: number; right: number; bottom: number }; side: 'below' | 'right'; section: 'all' | 'scheduled' } | null;
  openBackground(o: { terminalId: string; itemId?: string | null; here?: boolean }): void;
  selectBackgroundItem(itemId: string | null): void;
  setBackgroundScope(terminalId: string): void;
  applyBackgroundFeed(f: BackgroundFeed): void;
  /** Forgets a feed's buffer (main re-sends a full snapshot on the next watch). */
  dropBackgroundFeed(key: string): void;
  openBgPopover(p: NonNullable<AppState['bgPopover']>): void;
  closeBgPopover(): void;
  /** Scheduled prompts: every project's, as atelierd sends them. */
  schedules: ScheduledPrompt[];
  setSchedules(list: ScheduledPrompt[]): void;
  /**
   * atelierd's Claude Code signals notebook, for Settings › Claude. null until
   * the first book; kept while atelierd is away (the row gates on DaemonState.signalsAvailable, not on this).
   */
  claudeSignals: SignalBookView | null;
  setClaudeSignals(book: SignalBookView): void;
  /** The composer: a new prompt for a session (maybe with text), or one being edited. */
  scheduleSheet: { terminalId: string; editId?: string; text?: string } | null;
  setScheduleSheet(v: AppState['scheduleSheet']): void;
  /** A session's scheduled prompts, from its chip (below) or its row (right). */
  schedulePopover: { terminalId: string; anchor: { left: number; top: number; right: number; bottom: number }; side: 'below' | 'right' } | null;
  openSchedulePopover(p: NonNullable<AppState['schedulePopover']>): void;
  closeSchedulePopover(): void;
  /** Files open at a commit. */
  revFiles: RevFile[];
  /**
   * Table tabs: every one open in this window — another workspace's too, as files are — by its
   * `db:` key. Their own state (filters, rows…) is the databases store's, keyed by tab key, and goes with the tab.
   */
  dbTabs: DbTabRef[];
  /** The table preview tab (italic, replaced by the next table opened with a single click): a slot of its own, next to the files' `preview`. */
  dbPreview: TabKey | null;
  /**
   * Opens (or activates) a table tab — the overview for kind 'overview' (never a preview). preview: a single click, into
   * the table preview where the focused pane has it (Settings › Editor's preview tabs off: kept); side: Open to the Side
   * (kept); view: the view asked for (an open tab keeps its own otherwise); filters: opened on a key (Open ›, "N rows
   * ›", Open Referenced Row) — the tab's filters become those (no investment: a preview stays one) and its first
   * row is picked when the rows come; inspector: shown there too.
   */
  openDbTab(ref: Omit<DbTabRef, 'key'>, o: { preview: boolean; side?: boolean; view?: DbTabView; filters?: readonly DbFilter[]; inspector?: boolean }): void;
  /** The table preview becomes a kept tab (a double click, a filter, a sort…). */
  keepDbTab(key: TabKey): void;
  /** A tab's view (Data, Structure, Relations); switching it keeps a preview. */
  setDbView(key: TabKey, view: DbTabView): void;
  /** Closes every table tab `filter` names, in every workspace (Settings › Never, a connection removed). */
  closeDbTabs(filter: (r: DbTabRef) => boolean): void;
  /** Keeps the selection while it is listed, else the project's root repository, else the first. */
  setScmRepos(list: ScmRepoEntry[]): void;
  /** Selects a repository; an open History tab follows it (all branches). */
  selectScmRepo(root: string): void;
  setScmRefs(root: string, refs: ScmRefs): void;
  toggleScmSection(key: string): void;
  /** Opens (or focuses and retargets) the History tab: the repository and scope given, else the current or last ones. */
  openHistory(o?: { repo?: string; scope?: ScmScope }): void;
  openRevFile(f: { root: string; oid: string; rel: string }): void;
  /** The repository switcher's dropdown is open (the card's click, the palette's Switch Repository…). */
  scmSwitcherOpen: boolean;
  setScmSwitcherOpen(open: boolean): void;
  /**
   * The ref picker sheet: choosing the History scope, the other side of a compare with `head`, or a branch to switch
   * to. head: the side kept while the other is picked; base: compare whatever is picked with it.
   */
  refPicker: { mode: 'scope' | 'compare' | 'switch'; head?: string; base?: string } | null;
  setRefPicker(p: { mode: 'scope' | 'compare' | 'switch'; head?: string; base?: string } | null): void;
  maximized: string | null;
  /** Time of the last paste into a session (for the notice in the terminal). */
  pastedAt: number | null;
  /** A newer build is ready (npm run stage-update): the footer offers a restart. */
  updateReady: boolean;
  /** The in-app updater (Settings › About, footer "Update available"); null until main answers. */
  updateStatus: UpdateStatus | null;
  setUpdateStatus(s: UpdateStatus | null): void;
  dictation: DictationUi;
  setDictation(d: DictationUi): void;
  /** State of the dictation steps from the main process (microphone, model, engine, polish). */
  dictationStatus: DictationStatus | null;
  setDictationStatus(s: DictationStatus): void;
  /** Widths of the sessions bar and of Changes (by dragging their edge), saved between launches. */
  panels: PanelWidths;
  setPanelWidth(panel: Panel, width: number, persist: boolean): void;
  resumables: Resumable[];
  /** Whether atelierd's resumables have arrived (until then they may still hold a task link or a pin). */
  resumablesKnown: boolean;
  /** Claude Code's conversations of this project not running here (read when resume: or the New menu opens). */
  history: ClaudeConversation[];
  /** Whether the main process answered at least once (until then resume: says it is loading). */
  historyLoaded: boolean;
  setHistory(list: ClaudeConversation[]): void;
  paletteOpen: boolean;
  /** Inline field in the tree: new file, new folder or rename. */
  treeEdit: TreeEdit | null;
  startTreeEdit(e: TreeEdit): void;
  endTreeEdit(): void;
  /** Increases when the tree must be re-read (after new, rename, duplicate, trash). */
  treeNonce: number;
  bumpTree(): void;
  /** Per folder of Files: raised when the folder's listing may have changed on disk (it is listed again if shown). */
  dirNonce: Record<string, number>;
  /** These folders (or every open one) changed on disk: Files lists them again. */
  relistFolders(folders: ReadonlySet<string> | 'all'): void;
  /** Short message at the bottom (e.g. a failed file operation), with an optional action (Undo) or two (Push, Undo). */
  /** Without a tone it reads as an error (a failed operation); `info` is a neutral notice. `ms`: how long it stays. */
  toast: { text: string; nonce: number; action?: ToastAction; second?: ToastAction; tone?: 'info'; ms?: number } | null;
  showToast(text: string | null, action?: ToastActions, tone?: 'info', ms?: number): void;
  /** Line comments not sent yet, this project's, saved between launches. */
  comments: LineComment[];
  addComment(c: Omit<LineComment, 'id' | 'createdAt' | 'hash' | 'gone'>): string;
  updateComment(id: string, patch: Partial<Pick<LineComment, 'text' | 'target'>>): void;
  deleteComment(id: string): void;
  /** Comments set aside when their file went to the Trash: back in the review (sent with that path). */
  keepComments(ids: string[]): void;
  /** Takes comments out (sent) and returns them, for an Undo. */
  removeComments(ids: string[]): LineComment[];
  restoreComments(list: LineComment[]): void;
  /** The comment box being written (one at a time). */
  commentDraft: CommentDraft | null;
  openCommentDraft(d: Omit<CommentDraft, 'nonce' | 'text'>): void;
  /** What is typed in the box and where it goes: kept here, so a redrawn box (the diff rebuilt) gets it back. */
  updateCommentDraft(patch: Partial<Pick<CommentDraft, 'text' | 'target'>>): void;
  closeCommentDraft(): void;
  /** Saved comments in Edit mode: their text being edited, by id (kept here for the same reason). */
  commentEdits: Record<string, string>;
  setCommentEdit(id: string, text: string | null): void;
  /** The Claude session selected last: the default target of a new comment. */
  lastSession: string | null;
  /** A renamed file (or folder): open tabs follow the new path. */
  renameOpenFiles(oldPath: string, newPath: string, root: string): void;
  /** A file (or folder) moved to the Trash: its tabs close without asking to save. */
  dropOpenFiles(path: string): void;
  /** Before renaming or trashing: the open files underneath with unsaved changes (Save / Don't Save / Cancel). */
  confirmUnsavedUnder(path: string, how: 'rename' | 'trash'): Promise<boolean>;
  /** Open files with unsaved changes. */
  dirty: Record<string, boolean>;
  setDirty(path: string, dirty: boolean): void;
  /**
   * The rename field open now, and where: the sidebar row, the tab or the session bar — wherever
   * Rename was asked. A tab rename for a terminal with no tab opens in its row.
   */
  renaming: RenameRequest | null;
  setRenaming(req: RenameRequest | null): void;
  /** Session panel: the terminal whose session bar shows the panel, or none. */
  sessionPanel: string | null;
  setSessionPanel(id: string | null): void;
  /** Context usage: the terminal whose Context sheet is open, or none. */
  contextSheet: string | null;
  setContextSheet(id: string | null): void;
  /** The last report per terminal in this app run (the panel's split bar), with the session it is of. */
  contextReports: Readonly<Record<string, { sessionId: string; report: ContextReport }>>;
  setContextReport(id: string, sessionId: string, report: ContextReport): void;
  /**
   * File to show in the tree (Reveal in Files): the tree opens the folders and scrolls it into view. Quiet when Files is
   * opened with a project file in front: no flash, no toast when it isn't in the tree.
   */
  treeReveal: { path: string; nonce: number; quiet?: boolean } | null;
  revealInTree(path: string): void;
  /** Tooltip shown by code (e.g. a link's destination in the terminal), besides those with data-tip. */
  linkTip: { text: string; x: number; y: number } | null;
  setLinkTip(tip: { text: string; x: number; y: number } | null): void;
  /** Open right-click menu (only one at a time). */
  /** onStep: ← / → past the menu's own levels (a menu bar's drop-down moves to its neighbour). */
  menu: { x: number; y: number; items: MenuItem[]; anchor?: { left: number; right: number; bottom: number }; onStep?: (dir: -1 | 1) => void } | null;
  openMenu(at: { clientX: number; clientY: number; preventDefault?: () => void } | { x: number; y: number; anchor?: { left: number; right: number; bottom: number } }, items: MenuItem[], opts?: { onStep?: (dir: -1 | 1) => void }): void;
  closeMenu(): void;
  /** Tab order: every terminal not hidden, every open file, Services, the review. */
  tabOrder: TabKey[];
  /** Active tab when a terminal not yet in the list was selected: the new one goes next to it. */
  pendingAnchor: TabKey | null;
  activeKey(): TabKey | null;
  activate(key: TabKey | null): void;
  /**
   * Split view with tab groups: 1–3 panes side by side, each with its own tabs and
   * its tab in front. The focused pane's front is the active tab (activeKey), and `tabOrder` is the panes' tabs left to
   * right. One pane: the `single()` placeholder, `tabOrder` and the active tab are all there is (today's app).
   */
  split: Split;
  /** ⌘\: an empty pane right of the focused one, focused (at three panes: a toast). */
  splitRight(): void;
  /** Unsplit (the pane ×): pane `i` (the focused one by default) goes, its tabs join the neighbour. */
  closePane(i?: number): void;
  /** Unsplit All: every tab in one strip, in pane order. */
  closeOtherPanes(): void;
  /** A tab into pane `pane` before `before` (null: at the end), in front, focused: a strip drop, a menu. */
  moveTabToPane(key: TabKey, pane: number, before: TabKey | null): void;
  /** A tab into a new pane on `side` of pane `pane` (an edge drop, Move to New Pane Right); nothing when refused. */
  moveTabToNewPane(key: TabKey, pane: number, side: 'left' | 'right'): void;
  /** ⌃⌘← / ⌃⌘→: the focused pane's tab in front to the neighbour on that side, or a new pane at the edge. */
  moveTabStep(dir: 1 | -1): void;
  /** Move to Left/Right Pane for any tab (its menu, ⌥-click): as moveTabStep, from the tab's own pane. */
  moveTabSide(key: TabKey, dir: 1 | -1): void;
  /** The tabs ⌘1…9 and Ctrl+Tab walk: the focused pane's strip; one pane, the whole strip. */
  focusedStrip(): TabKey[];
  focusPane(i: number): void;
  focusNextPane(): void;
  focusPrevPane(): void;
  /** Open to the Side: the tab in the pane right of the focused one; a hidden terminal gets its tab back. */
  openToSide(key: TabKey): void;
  /** Open to the Side for a file (opened as a normal tab, never the preview), at `line` when given. */
  openFileToSide(path: string, rel: string, line?: number | null, at?: FileOpening): void;
  /** A tab dropped on a pane's body: into it at the end (middle) or into a new pane on that side (edge). */
  dropTab(key: TabKey, pane: number, zone: DropZone): void;
  /** Widths of the panes (a divider moved); a list of the wrong length is ignored. */
  setFractions(fractions: number[]): void;
  equalizePanes(): void;
  /** The tab being dragged from the strip (the panes show where it can land), or null. */
  tabDrag: TabKey | null;
  /** Where the dragged tab's pointer is (client point), null while it is outside the window (tab-drag.ts). */
  tabDragAt: Point | null;
  /** Where the dragged tab would land there (the strip's caret, the pane zones), computed once per move. */
  tabDragTarget: TabDropTarget | null;
  /** Finder files dragged over the window, not over a terminal: the "Drop to open" pill. */
  fileDrag: boolean;
  setFileDrag(v: boolean): void;
  setTabDrag(key: TabKey | null): void;
  /** The saved layout was restored (or the user split first): from then on every split change is saved. Once per window. */
  layoutRestored: boolean;
  /** The project's saved tabs had their chance: from then on the tabs are saved. Once per window. */
  tabsRestored: boolean;
  moveTab(key: TabKey, before: TabKey | null): void;
  /**
   * This project's workspaces; null: never turned on, no project, or a pop-out. While on,
   * tabOrder, split, activeTab and selectedId are the active workspace's view, swapped by switchWorkspace.
   */
  ws: WorkspacesState | null;
  /** Turns workspaces on or off for this project: nothing stops, nothing closes. */
  setWorkspacesOn(on: boolean): void;
  /**
   * Settings › Appearance › Use workspaces in every project (2026-11-02), applied to this project window: on, turns
   * them on (marked `forced` unless the project had them on already); off, turns off those it turned on.
   */
  applyWorkspacesEverywhere(): void;
  /** The workspaces with the one in front's live tabs written in (its saved entry lags while it is in front). */
  workspacesNow(): WorkspacesState | null;
  /**
   * Brings place `id` to the front — a workspace's own tabs, or one of its activities: its tabs, its split, its tab in
   * front.
   */
  switchWorkspace(id: string): void;
  /**
   * A way back to workspace `id` (⌥⌘1…9, the Go menu, Next/Previous, the palette): it comes forward where it was
   * left — the activity in front then, or its own tabs.
   */
  goToWorkspace(id: string): void;
  /**
   * The space in front: Sessions, Docker, Redis, Databases or Automations. tabOrder, split,
   * activeTab are its view; the others wait in spaceViews. selectedId stays Sessions' (Send to, dictation, ⌘J).
   */
  space: SpaceId;
  /** Every space's view; the one in front's entry lags (its live view is in the fields above). */
  spaceViews: SpaceViews;
  /** The Sessions space's activity last used (Sessions, Files, Find in Files, Services or Source Control), shown when it comes back. */
  sessionsActivity: Activity;
  /**
   * Brings space `to` to the front with its tabs, split and tab in front, in one update; `activity`: the sidebar's
   * (default: the space's own, Sessions' last used). A change to a space not in front never goes through here: it is
   * made to its saved view.
   */
  switchSpace(to: SpaceId, activity?: Activity): void;
  /** A space's view as it is now: live for the one in front, saved for the others. */
  spaceView(id: SpaceId): SpaceView;
  /**
   * A new workspace, brought to the front; null when refused (an empty name, the limit). `move`: a tab of the active
   * workspace that moves into it first (Move to Workspace › New Workspace…).
   */
  newWorkspace(opts: { name: string; color?: number; folder?: string | null }, move?: TabKey): string | null;
  /** The workspace whose name is being edited in the sidebar (its head or card), or null. */
  wsRenaming: string | null;
  setWsRenaming(id: string | null): void;
  /** The New Workspace sheet: open, with the tab it was asked for from (Move to Workspace ›). */
  wsSheet: { move?: TabKey } | null;
  setWsSheet(v: { move?: TabKey } | null): void;
  /** Close Workspace… asked: the workspace the confirm is about, or null. */
  wsCloseAsk: string | null;
  /** Changes with workspaces on: all of them, or the active workspace's. Per window. */
  changesScope: 'ws' | 'all';
  setChangesScope(v: 'ws' | 'all'): void;
  setWsCloseAsk(id: string | null): void;
  renameWorkspace(id: string, name: string): void;
  recolorWorkspace(id: string, color: number): void;
  moveWorkspace(id: string, dir: -1 | 1): void;
  /** A workspace's chevron in the sidebar: folds or opens its rows, never switches. */
  toggleWorkspaceOpen(id: string): void;
  /**
   * A tab of the active workspace moves to workspace `id`: a terminal changes workspace, a file is shown
   * there. A terminal of another workspace (its row open in the sidebar) moves too.
   */
  moveToWorkspace(key: TabKey, id: string, opts?: { quiet?: boolean }): void;
  /**
   * Closes a workspace: its terminals join the one above (below for the first) and its activities go there as
   * activities, or everything in it stops resumable.
   */
  closeWorkspace(id: string, how: 'move' | 'stop'): Promise<void>;
  /**
   * New Activity…: a new activity in workspace `wsId`, brought to the front with its name in edit; null when refused
   * (activities off, the limit, `wsId` no workspace). `move`: a tab or row that moves into it first (Move to › New
   * Activity…).
   */
  newWsActivity(wsId: string, move?: TabKey): string | null;
  /** An activity goes to another workspace with everything in it; in front, the window goes to its workspace's own tabs first. */
  moveWsActivity(id: string, wsId: string): void;
  /**
   * Closes an activity: its terminals and tabs join its workspace's own tabs (move), or its terminals stop resumable
   * and its file tabs close (stop; unsaved files asked about first).
   */
  closeWsActivity(id: string, how: 'move' | 'stop'): Promise<void>;
  /** Close Activity… asked: the activity the confirm is about, or null. */
  wsActCloseAsk: string | null;
  setWsActCloseAsk(id: string | null): void;
  setProject(p: ProjectInfo | null): void;
  setTerminals(list: TerminalInfo[]): void;
  /** setTerminals without the one-time layout restore (internal: setTerminals = this + restoreLayoutOnce). */
  applyTerminals(list: TerminalInfo[]): void;
  select(id: string | null): void;
  /** A terminal just created or resumed: shown and selected from the reply, without waiting for atelierd's list. */
  opened(info: TerminalInfo): void;
  /** Terminals launched as Claude sessions and still waiting for Claude's SessionStart (starting.ts): shown as sessions. */
  starting: Starting;
  /** A terminal launched as a Claude session (New Session, Resume, a past conversation): opened, and starting until its session arrives. */
  launched(info: TerminalInfo): void;
  /**
   * Opening Files shows the project file in front there, unless `reveal: false` (Collapse Folders from the palette).
   * A hidden sidebar shows again, unless `keepHidden` (a jump to a session).
   */
  setActivity(a: Activity, opts?: { reveal?: boolean; keepHidden?: boolean }): void;
  setDaemon(s: DaemonState): void;
  setSize(cols: number, rows: number): void;
  setUsage(list: UsageEntry[]): void;
  /** Opens (or activates) a file tab; with preview (single click, link, palette) it goes into the preview tab if enabled. */
  openFile(path: string, rel: string, line?: number | null, mode?: FileMode, opts?: { preview?: boolean } & FileOpening): void;
  /**
   * A Find in Files result: its file in the preview tab (walking the results replaces it) or, `side`, in the other pane
   * of a split (a new split when there is none), at the match; a file past 5 MB straight in the large view.
   */
  openSearchResult(file: SearchFile, line: SearchLine, index: number, opts: { side: boolean; keepFocus: boolean; spec: SearchSpec }): void;
  setFileMode(path: string, mode: FileMode): void;
  /** Open Anyway on a tab whose text is past 5 MB. */
  setFileLarge(path: string): void;
  setRepos(r: RepoStatus[]): void;
  setAttributions(a: Attribution[]): void;
  toggleChanges(): void;
  setChangesGroup(g: 'repo' | 'session'): void;
  filesChanged(paths: string[]): void;
  setServices(p: ServicePane[], status?: ServicesStatus): void;
  setPorts(m: PortsMap): void;
  setPrs(p: PrsState): void;
  setServiceBuffer(id: string, lines: string[], seq: number, live?: string): void;
  /** 'ok' if appended, 'refetch' if something is missing (re-read the buffer), 'ignored' if the pane isn't loaded. */
  appendServiceLines(id: string, lines: string[], reset: boolean, seq: number, live?: string): 'ok' | 'refetch' | 'ignored';
  openServices(maximize?: string | null): void;
  setMaximized(id: string | null): void;
  setPastedAt(t: number | null): void;
  setUpdateReady(ready: boolean): void;
  /** A recent file that no longer exists (deleted outside Atelier) drops out of the recents. */
  forgetRecent(path: string): void;
  setClaudeTemp(path: string, on: boolean): void;
  setResumables(list: Resumable[]): void;
  /** Initial palette text (e.g. "resume:"). */
  paletteQuery: string;
  /** Increases on every request with a query: asking again for the same one (⌘⇧N twice) still resets the filter. */
  paletteAsk: number;
  /**
   * The palette's send step: the text to send and its terminal's folder (where New
   * Terminal opens); null otherwise. Any other palette request clears it.
   */
  paletteSend: PaletteSend | null;
  openSendPalette(send: PaletteSend): void;
  /** Notification center: this project's entries, newest first, saved between reloads. */
  notes: NoteEntry[];
  notesOpen: boolean;
  /** What the center shows: everything, or only trigger matches (palette "Show trigger matches"). */
  notesFilter: NotesFilter;
  /** Opens (with `filter`, everything by default) or closes the center. */
  setNotesOpen(open: boolean, filter?: NotesFilter): void;
  setNotesFilter(filter: NotesFilter): void;
  /** A "notify" trigger matched in a terminal of this window: its entry, through receiveNotes. False: no such terminal. */
  addTriggerNote(termId: string, rule: string, line: string): boolean;
  /** Entries from main (checked here); `viewing`: the session on screen right now, whose entries arrive read. */
  receiveNotes(raw: unknown, viewing?: string | null): void;
  /** A container's entries are read (it was opened in the Docker tab). */
  dockerSeen(containerId: string): void;
  /** Entries about this subject are read (a Redis queue looked at). */
  subjectSeen(subject: string): void;
  /** The session was viewed: read in every entry. */
  notesSeen(sessionId: string): void;
  /** An entry opened from the center: read, whatever sessions it names. */
  noteOpened(id: string): void;
  /** Mark all as read and Clear act on the entries shown (only trigger matches while filtered). */
  markAllNotesRead(): void;
  clearNotes(): void;
  /** Sessions list grouped by state (Inbox), remembered per viewer. */
  groupByState: boolean;
  toggleGroupByState(): void;
  setPaletteOpen(open: boolean, query?: string): void;
  /** Closes the given tab (path, 'services', 't:id') or the active one; a terminal's tab is only hidden (see hidden). */
  closeTab(path?: string): void;
  /** Closes several tabs (unsaved files ask once); terminal tabs are hidden, the terminals keep running. */
  closeTabs(keys: TabKey[]): Promise<void>;
  showTerminal(): void;
  setNewSessionOpen(open: boolean, account?: string): void;
  setFolderSheet(sheet: FolderSheet | null): void;
  /** Files recently opened in this window (for the palette with an empty search). */
  recentFiles: RecentFile[];
  /** App settings (from the main process; changed only through window.atelier.settings.set). */
  settings: Settings;
  setSettings(s: Settings): void;
  /** Shells offered as terminal profiles (from /etc/shells, read by main). */
  shells: ShellOption[];
  setShells(shells: ShellOption[]): void;
  /** Open Settings panel, with the section shown. */
  settingsOpen: SettingsSection | null;
  /** Settings › Claude › Launch flags: the scope shown, 'all' or an account id. */
  launchFlagsScope: string;
  setLaunchFlagsScope(scope: string): void;
  setSettingsOpen(section: SettingsSection | null): void;
  /**
   * The What's new sheet: `since` = the version of the launch before an update (every release in
   * between is shown); null = opened from the menu or the palette (the running version's notes).
   */
  whatsNew: { since: string | null } | null;
  setWhatsNew(v: { since: string | null } | null): void;
  /** Settings › Connectors cards, as main broadcasts them. */
  connectors: ConnectorInfo[];
  setConnectors(list: ConnectorInfo[]): void;
  /**
   * Settings › Connectors: the connector whose details page is shown, null for the list. Gone
   * with its section; a toast, the gear dot or a palette command for one connector opens its details directly.
   */
  connectorDetail: ConnectorId | null;
  openConnector(id: ConnectorId | null): void;
  /** The Disconnect confirm open on a details page (its Disconnect button, or the palette's "Disconnect ClickUp…"). */
  connectorConfirm: ConnectorId | null;
  setConnectorConfirm(id: ConnectorId | null): void;
  /**
   * The API-token form open on a details page (Jira's "Use an API token instead…", or its Reconnect after an expired
   * token). Gone with its details page, like the confirm.
   */
  connectorTokenForm: ConnectorId | null;
  setConnectorTokenForm(id: ConnectorId | null): void;
  /** A connector notice from main: one toast, with its way out as the action. */
  connectorNotice(n: ConnectorNotice): void;
  /** Tasks per connector (tasks:list), for the palette and the task chips. In memory only. */
  taskLists: TaskList[];
  setTaskLists(lists: TaskList[]): void;
  /** This project's sessions started from a task: terminal id → task (task-links.ts), saved between launches. */
  taskLinks: TaskLinks;
  linkTask(id: string, link: TaskLink): void;
  unlinkTask(id: string): void;
  /** A resumed session is a new terminal: its task link follows it. */
  relinkTask(from: string, to: string): void;
  /**
   * Resumes a session left without a process (sidebar, palette): the new terminal is shown as starting, and takes the
   * old one's task link and pin. null when atelierd refused.
   */
  resume(id: string): Promise<TerminalInfo | null>;
  /**
   * Resume all / Resume pinned: one at a time, pinned first, each once the previous
   * one's Claude has started; the tab in front stays in front. Does nothing while one runs.
   */
  bulkResume: BulkResume | null;
  resumeAll(which: 'all' | 'pinned'): Promise<void>;
  /** Stop: the one starting finishes, the rest stay under Resume. */
  stopResumeAll(): void;
  /** Dismiss All… (the Resume rows' menu) asked in the Resume head; they stay in ⌘K › Resume a session…. */
  dismissAllAsk: boolean;
  askDismissAll(): void;
  cancelDismissAll(): void;
  confirmDismissAll(): Promise<void>;
  /** A terminal launched as a session to the side of the focused pane (⌥Enter on a task). */
  launchedToSide(info: TerminalInfo): void;
}

export interface ToastAction { label: string; run: () => void }
/** A toast's buttons: one action, or two (Push and Undo). */
export type ToastActions = ToastAction | [ToastAction, ToastAction];
export interface RenameRequest { id: string; at: 'row' | 'tab' | 'bar' }
/** A comment box open under some lines: where, what they said, and the session it would go to. */
export interface CommentDraft { path: string; start: number; end: number; snippet: string; target: string | null; ambiguous: boolean; nonce: number; text: string }

export type SettingsSection = 'appearance' | 'terminal' | 'editor' | 'scm' | 'docker' | 'redis' | 'databases' | 'claude' | 'connectors' | 'ask' | 'automations' | 'dictation' | 'notifications' | 'keyboard' | 'about';

/** Dictation state for the pill (the logic lives in dictation/controller.ts). */
export interface DictationUi { phase: 'idle' | 'listening' | 'transcribing' | 'inserted' | 'error'; startedAt: number; message?: string; canRetry?: boolean }

// Changes panel preference: a convenience for the viewer, if storage is missing it starts open.
function readShowChanges(): boolean {
  try { return typeof localStorage === 'undefined' || localStorage.getItem('atelier.showChanges') !== '0'; } catch { return true; }
}
function writeShowChanges(v: boolean): void {
  try { localStorage.setItem('atelier.showChanges', v ? '1' : '0'); } catch { /* storage unavailable */ }
}

// Small per-viewer preferences (off when storage is missing).
function readFlag(key: string): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1'; } catch { return false; }
}
function writeFlag(key: string, v: boolean): void {
  try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* storage unavailable */ }
}

const MAX_SERVICE_LINES = 5000;

export const useApp = create<AppState>((set, get) => ({
  ...createGitSlice(set, get),
  ...createConfirmsSlice(set, get),
  ...createRestartSlice(set, get),
  ...createCompanionSlice(set, get),
  popout: null,
  enterPopout: (boot) => {
    const key = boot.key as TabKey;
    const id = key.startsWith('t:') ? key.slice(2) : null;
    // Restored and saved state are the main window's: marked done here, so nothing is restored or saved from this window.
    set({
      ...applyPayload(get(), key, boot.payload),
      popout: boot, poppedOut: [], tabOrder: [key], split: single(), pendingAnchor: null, preview: null, dbPreview: null, layoutRestored: true, tabsRestored: true,
      ...(id ? { selectedId: id, activeTab: 'term' } : { activeTab: tabOf(key) })
    });
    // Its Ask was open in the window it left: open here once the terminal is listed.
    if (id && boot.payload?.kind === 'terminal' && boot.payload.ask) get().openAskWhenListed(id);
  },
  poppedOut: [],
  applyPoppedOut: (list) => {
    const st = get();
    if (st.popout) return;
    const keys = [...new Set(list)] as TabKey[];
    if (keys.length !== st.poppedOut.length || keys.some((k, i) => k !== st.poppedOut[i])) set({ poppedOut: keys });
    // Its editor lives in the pop-out now: the main window has nothing unsaved for it.
    const clean = keys.filter((k) => k.startsWith('f:') && k.slice(2) in st.dirty).map((k) => k.slice(2));
    if (clean.length) { const dirty = { ...get().dirty }; for (const p of clean) delete dirty[p]; set({ dirty }); }
    // Like closed tabs (the neighbour becomes active, an empty pane unsplits), but nothing is hidden or closed.
    const leaving = keys.filter((k) => get().tabOrder.includes(k));
    if (leaving.length) dropTabs(leaving, false);
  },
  popOut: async (key, at, size) => {
    const st = get();
    // Some tabs have no pop-out (an automation's): every way here (⌘⇧O, the menu, a drag out) asks nothing of main.
    if (st.popout || !canPopOut(key) || popped(key)) return;
    // A file's buffer goes along, taken now while its editor is still here and frozen until the window answers
    // (a keystroke meanwhile would stay behind); a failed open leaves the editor as it was.
    let r: PopoutOpenResult;
    try {
      r = await tabMove(st, key, (req) => window.atelier.popout.open({ key, ...req, size: size ?? { ...POPOUT_SIZE }, at }), (x) => !x.ok && x.reason !== 'moved');
    } catch {
      r = { ok: false, reason: 'failed' };
    }
    // 'inside': the drop was over the main window after all (a drag that came back): nothing to do.
    if (r.ok) {
      get().applyPoppedOut([...get().poppedOut.filter((k) => k !== key), key]);
      // Its Ask went with it (or, an ended session's, has no pane here any more): closed in this window.
      if (key.startsWith('t:') && get().askOpen[key.slice(2)]) get().closeAskPanel(key.slice(2));
    } else if (r.reason === 'moved') {
      // Released over another project's window: it lives there now (a terminal
      // leaves with the list main sends).
      if (key.startsWith('f:') || key.startsWith('db:')) get().dropMovedTab(key);
    } else if (r.reason === 'refused') get().showToast(t.moveWin.refusedDrag(key.slice(2).split(/[\\/]/).at(-1) ?? key));
    else if (r.reason === 'failed') get().showToast(t.popout.failed);
  },
  applyDock: (e, target) => {
    if (get().popout) return;
    const key = e.key as TabKey;
    // A table asked for in a pop-out: opened here as openDbTab there would have.
    const p = e.payload?.kind === 'db' ? e.payload : null;
    const ref = p?.open ? dbRefOfKey(key, null, p.view) : null;
    if (p?.open && ref) {
      const { view, ...o } = p.open;
      get().openDbTab({ ...ref, kind: p.rel ?? ref.kind }, { ...o, ...(view ? { view: p.view } : {}) });
      return;
    }
    if (get().poppedOut.includes(key)) set({ poppedOut: get().poppedOut.filter((k) => k !== key) });
    // It comes back into its own space, which comes to the front; dropped over another space's
    // strip or pane, it isn't placed there: it joins its own space after the tab in front.
    if (spaceOf(key) !== get().space) { enter(key); target = null; }
    const st = get();
    const id = key.startsWith('t:') ? key.slice(2) : null;
    // Its terminal ended meanwhile: nothing comes back (a Background tab follows its terminal likewise).
    if (id && !st.terminals.some((x) => x.id === id)) return;
    const bg = e.payload?.kind === 'background' ? e.payload.terminalId : null;
    if (key === 'background' && bg !== null && !st.terminals.some((x) => x.id === bg)) return;
    const patch = id ? {} : applyPayload(st, key, e.payload);
    // Its Ask was open in the pop-out: it opens here too, wherever the tab lands.
    const askAlong = id !== null && e.payload?.kind === 'terminal' && e.payload.ask;
    // A special tab its payload gives nothing to show (History, Background, a revision without one): no dead tab.
    if (!id && !tabAlive({ ...st, ...patch }, key)) return;
    // Its buffer waits for the editor the file is about to mount, which takes it instead of reading the file.
    if (e.handoff && key.startsWith('f:') && e.handoff.path === key.slice(2)) putHandoff(e.handoff);
    const active = st.activeKey();
    // Straight into the pane (or, split, the pane's strip) it was dropped on: the focused pane keeps its tab until the
    // drop places this one — an empty focused pane never takes it on the way.
    const placeIn = (place: () => void) => {
      hush(() => {
        if (id) setHidden(showId(get().hidden, id));
        set({ ...patch, tabOrder: insertAfterActive(get().tabOrder, key, active), menu: null });
      });
      place();
      if (askAlong) get().openAskWhenListed(id!);
    };
    if (target?.kind === 'pane') { placeIn(() => get().dropTab(key, target.pane, target.zone)); return; }
    if (target?.kind === 'strip' && isSplit(st.split)) { placeIn(() => { get().moveTabToPane(key, target.pane, target.before); bringToFront(key); }); return; }
    if (id) get().select(id);
    else {
      set({ ...patch, tabOrder: insertAfterActive(st.tabOrder, key, active), menu: null });
      get().activate(key);
    }
    if (askAlong) get().openAskWhenListed(id!);
    if (target?.kind === 'strip') get().moveTabToPane(key, target.pane, target.before);
  },
  revealInPopout: (r) => {
    const boot = get().popout;
    if (!boot) return;
    const key = boot.key as TabKey;
    if (r.payload) set(applyPayload(get(), key, r.payload));
    // Opened on a key from another window: this table's filters become those.
    if (r.payload?.kind === 'db' && r.payload.open) handOver(key, r.payload.open);
    const line = r.line;
    if (typeof line === 'number' && key.startsWith('f:')) {
      const path = key.slice(2);
      // A search result comes with its match (shown as the main window would) or, a plain line, without one.
      set({ openFiles: get().openFiles.map((f) => (f.path === path ? { ...f, line, nonce: Date.now() + Math.random(), found: r.found } : f)), mdVisit: visit(get().mdVisit, path, !!r.found) });
    }
  },
  projectWindows: [],
  setProjectWindows: (projectWindows) => set({ projectWindows }),
  dropMovedTab: (key) => {
    if (key.startsWith('f:') && key.slice(2) in get().dirty) {
      const dirty = { ...get().dirty };
      delete dirty[key.slice(2)];
      set({ dirty });
    }
    if (get().tabOrder.includes(key)) dropTabs([key], false);
    else if (key.startsWith('f:')) set({ openFiles: get().openFiles.filter((f) => f.path !== key.slice(2)) });
  },
  dockHover: null,
  setDockHover: (p) => {
    const cur = get().dockHover;
    if (cur === p || (cur && p && cur.x === p.x && cur.y === p.y)) return;
    set({ dockHover: p });
  },
  project: null,
  projectLoaded: false,
  terminals: [],
  starting: {},
  selectedId: null,
  activity: 'sessions',
  sidebarHidden: readSidebarHidden(),
  toggleSidebar: () => {
    const st = get();
    if (st.popout) return;
    // Shown again as the view key would show it (Files shows the file in front).
    if (st.sidebarHidden) st.setActivity(st.activity);
    else hideSidebar();
  },
  clickActivity: (a) => {
    const st = get();
    if (!st.sidebarHidden && st.activity === a) hideSidebar();
    else st.setActivity(a);
  },
  daemon: { connected: false, listed: false, version: null, mismatch: false, incompatible: false, profilesAvailable: false, states2Available: false, backgroundAvailable: false, aliasesAvailable: false, namesAvailable: false, shellEnv: null },
  size: { cols: 0, rows: 0 },
  usage: [],
  openFiles: [],
  activeTab: 'term',
  preview: null,
  keepOpen: (path) => { if (get().preview === path) set({ preview: null }); },
  newUntitled: () => {
    // A file tab is Sessions': New File from another space opens it there.
    enterSessions();
    const st = get();
    // An untitled buffer living in a pop-out still holds its number.
    const { path, rel } = nextUntitled([...st.openFiles.map((f) => f.path), ...st.poppedOut.filter((k) => k.startsWith('f:')).map((k) => k.slice(2))]);
    // The number is free again: an earlier tab with it, saved as a file, says nothing about this one (nor its language).
    savedAs.delete(path);
    if (st.langOverrides[path]) set({ langOverrides: withOverride(st.langOverrides, path, null) });
    if (st.mdViews[path]) setMdViews(dropMdViews(st.mdViews, path));
    if (st.csvOptions[path]) setCsvOptionsMap(dropCsvOptions(st.csvOptions, path));
    const placed = openTab(st.tabOrder, `f:${path}`, st.activeKey(), st.preview ? `f:${st.preview}` : null, false);
    set({ openFiles: [...st.openFiles, { path, rel, line: null, nonce: Date.now() + Math.random(), mode: 'margin' }], tabOrder: placed.order, activeTab: path, menu: null });
  },
  saveAs: null,
  requestSaveAs: (path, text) => {
    // One sheet at a time: a second request (⌘S again) waits for nothing and changes nothing.
    if (get().saveAs) return Promise.resolve(false);
    return new Promise<boolean>((done) => set({ saveAs: { path, text, done }, menu: null, paletteOpen: false, bgPopover: null }));
  },
  submitSaveAs: (rel) => writeSaveAs((text) => window.atelier.files.saveAs(rel, text)),
  // Main never replaces a file open here with unsaved edits (they would be lost with the tab it merges into).
  submitSaveAsOutside: (name) => writeSaveAs((text) => window.atelier.files.saveAsOutside(name, text,
    get().openFiles.filter((f) => get().dirty[f.path] && !isUntitled(f.path)).map((f) => f.path))),
  cancelSaveAs: () => {
    const req = get().saveAs;
    // The file is being written: Esc or a click outside can no longer undo that, the tab must follow the write.
    if (req && writing === req) return;
    set({ saveAs: null });
    req?.done(false);
  },
  langOverrides: loadOverrides(),
  // What the name already says needs no override (same as Auto).
  setLanguage: (path, lang) => setOverrides(withOverride(get().langOverrides, path, lang && lang !== languageFor(path) ? lang : null)),
  mdViews: loadMdViews(),
  mdVisit: {},
  mdViewOf: (path) => {
    const view = mdViewOf(get().mdViews, path, defaultView(path, get().langOverrides, get().settings));
    // Split shows the code already: only Preview (Tree, Table) gives way to it.
    return view === 'preview' && get().mdVisit[path] ? 'source' : view;
  },
  setMdView: (path, view) => {
    const st = get();
    if (st.mdVisit[path]) set({ mdVisit: visit(st.mdVisit, path, false) });
    setMdViews(withMdView(st.mdViews, path, view, defaultView(path, st.langOverrides, st.settings)));
    if (view !== 'source' && st.openFiles.some((f) => f.path === path && f.mode === 'diff')) st.setFileMode(path, 'margin');
  },
  csvOptions: loadCsvOptions(),
  setCsvOptions: (path, o) => setCsvOptionsMap(withOptions(get().csvOptions, path, o)),
  languageSheet: null,
  setLanguageSheet: (languageSheet) => set({ languageSheet, ...(languageSheet ? { menu: null, paletteOpen: false, bgPopover: null } : {}) }),
  themeSheet: false,
  // One previewing sheet at a time: the one that goes puts its preview back (FontList's cleanup, ThemeSheet's).
  setThemeSheet: (themeSheet) => set({ themeSheet, ...(themeSheet ? { menu: null, paletteOpen: false, bgPopover: null, fontSheet: false } : {}) }),
  fontSheet: false,
  setFontSheet: (fontSheet) => set({ fontSheet, ...(fontSheet ? { menu: null, paletteOpen: false, bgPopover: null, themeSheet: false } : {}) }),
  fontPreview: null,
  setFontPreview: (fontPreview) => set({ fontPreview }),
  originSheet: null,
  setOriginSheet: (originSheet) => set({ originSheet, ...(originSheet ? { menu: null, paletteOpen: false, bgPopover: null } : {}) }),
  changesMaybeOpen: [],
  toggleMaybe: (id) => set((s) => ({ changesMaybeOpen: s.changesMaybeOpen.includes(id) ? s.changesMaybeOpen.filter((x) => x !== id) : [...s.changesMaybeOpen, id] })),
  resolveUnsure: async (paths, terminalId, name) => {
    let done: { token: string; count: number } | null = null;
    try { done = await window.atelier.resolveAttributions(paths, terminalId); } catch { /* nothing changed */ }
    if (!done) return;
    const { token, count } = done;
    const undo = async () => {
      let ok = false;
      try { ok = await window.atelier.undoResolve(token); } catch { /* stale */ }
      if (!ok) get().showToast(t.unsure.stale, undefined, 'info');
    };
    // The count main reports: files it skipped (no longer unsure, another project) are not counted.
    get().showToast(terminalId ? t.unsure.given(count, name) : t.unsure.outside(count), { label: t.comments.undo, run: () => void undo() }, 'info');
  },
  newSessionOpen: false,
  newSessionAccount: null,
  claudeDefaultDir: null,
  home: null,
  settingsLoaded: false,
  folderSheet: null,
  repos: [],
  attributions: [],
  showChanges: readShowChanges(),
  ...(({ collapsed, compact, grouping }) => ({ changesCollapsed: collapsed, changesExpanded: !compact, changesGroup: grouping }))(loadChangesPrefs()),
  diskNonce: {},
  claudeTemp: {},
  pins: [],
  shelf: [],
  shelfCollapsed: loadShelfCollapsed(),
  shelfNonce: 0,
  shelfUngranted: [],
  hidden: [],
  services: [],
  servicesStatus: 'ok',
  ports: {},
  prs: EMPTY_PRS,
  serviceLines: {},
  serviceSeq: {},
  serviceLive: {},
  serviceWrap: {},
  toggleServiceWrap: (id) => set((st) => { const next = { ...st.serviceWrap }; if (next[id]) delete next[id]; else next[id] = true; return { serviceWrap: next }; }),
  servicesOpen: false,
  review: null,
  openReview: (scope, o) => {
    if (popped('review', { payload: { kind: 'review', scope, ...(o?.againstMain !== undefined ? { againstMain: o.againstMain } : {}) } })) return;
    enter('review');
    const st = get();
    set({ review: { scope, nonce: Date.now() + Math.random(), ...(o?.againstMain !== undefined ? { againstMain: o.againstMain } : {}) }, activeTab: 'review', menu: null, tabOrder: insertAfterActive(st.tabOrder, 'review', st.activeKey()) });
  },
  reviewAgainstMain: readFlag('atelier.reviewAgainstMain'),
  setReviewAgainstMain: (on) => { writeFlag('atelier.reviewAgainstMain', on); set({ reviewAgainstMain: on }); },
  scmRepos: null,
  scmRepo: null,
  scmSearch: null,
  setScmSearch: (scmSearch) => set({ scmSearch }),
  scmRefs: {},
  scmCollapsed: [],
  scmView: 'one',
  scmViewAsked: null,
  setScmView: (scmView) => {
    const proj = get().project?.root;
    if (proj) saveScmPrefs(proj, { view: scmView });
    set({ scmView, ...(proj ? {} : { scmViewAsked: scmView }) });
  },
  scmFolds: {},
  setScmFold: (root, folded, def) => {
    // Saved last (the newest kept when capped), or gone when back to the default.
    const { [root]: _old, ...rest } = get().scmFolds;
    const scmFolds = folded === def ? rest : { ...rest, [root]: folded };
    const proj = get().project?.root;
    if (proj) saveScmPrefs(proj, { folds: scmFolds });
    set({ scmFolds });
  },
  scmBulk: null,
  setScmBulk: (scmBulk) => set({ scmBulk }),
  historyTab: null,
  backgroundTab: null,
  dockerTabs: [],
  dockerPreview: null,
  openDocker: (target, asked, o) => {
    const key = dockerKey(target);
    // No view asked for: an open tab keeps its own, a new one shows the logs.
    if (popped(key, asked ? { payload: { kind: 'docker', target, view: asked } } : undefined)) return;
    enter(key);
    const st = get();
    const known = st.dockerTabs.find((r) => r.key === key);
    const view = asked ?? known?.view ?? 'logs';
    // An open target only comes to the front (a click on its preview keeps it); a new one goes after the tab in front,
    // or replaces the preview in the focused pane (openFile's and openDbTab's rule, placeOpened).
    const placed = placeOpened(st.split, st.tabOrder, st.activeKey(), key, st.dockerPreview, !!o?.preview && st.settings.previewTabs && !known);
    const tab: DockerTabRef = { key, target, view, nonce: Date.now() + Math.random() };
    const gone = placed.replaced;
    const dockerTabs = known
      ? st.dockerTabs.map((r) => (r.key === key ? { ...r, view, nonce: tab.nonce } : r))
      : gone ? st.dockerTabs.map((r) => (r.key === gone ? tab : r)) : [...st.dockerTabs, tab];
    set({
      dockerTabs, tabOrder: placed.order, ...(placed.split !== st.split ? { split: placed.split } : {}),
      dockerPreview: known && st.dockerPreview === key && !o?.preview ? null : placed.preview, activeTab: key, menu: null
    });
  },
  setDockerView: (key, view) => {
    const tabs = get().dockerTabs;
    if (!tabs.some((r) => r.key === key && r.view !== view)) return;
    set({ dockerTabs: tabs.map((r) => (r.key === key ? { ...r, view } : r)) });
    get().keepDockerTab(key);
  },
  keepDockerTab: (key) => { if (get().dockerPreview === key) set({ dockerPreview: null }); },
  automations: { automations: [] },
  setAutomations: (automations) => {
    set({ automations });
    // An automation removed (here or in another window) takes its tab with it.
    const ids = new Set(automations.automations.map((v) => v.automation.id));
    for (const r of get().autoTabs) if (r.id !== null && !ids.has(r.id)) get().closeTab(r.key);
  },
  autoTabs: [],
  autoPreview: null,
  autoFilter: 'project',
  openAutomations: (id, o) => {
    const key = autoKey(id);
    if (popped(key)) return;
    enter(key);
    const st = get();
    const known = st.autoTabs.some((r) => r.key === key);
    // The files' and tables' preview rule (placeOpened): an open one only comes to the front, a click on its preview
    // without `preview` keeps it.
    const placed = placeOpened(st.split, st.tabOrder, st.activeKey(), key, st.autoPreview, !!o?.preview && st.settings.previewTabs && !known);
    const tab: AutoTabRef = { key, id };
    const gone = placed.replaced;
    const autoTabs = known ? st.autoTabs : gone ? st.autoTabs.map((r) => (r.key === gone ? tab : r)) : [...st.autoTabs, tab];
    set({
      autoTabs, tabOrder: placed.order, ...(placed.split !== st.split ? { split: placed.split } : {}),
      autoPreview: known && st.autoPreview === key && !o?.preview ? null : placed.preview, activeTab: key, menu: null
    });
  },
  setAutoFilter: (autoFilter) => set({ autoFilter }),
  keepAutoTab: (key) => { if (get().autoPreview === key) set({ autoPreview: null }); },
  automationEditor: null,
  editAutomation: (draft, prev = null) => set({ automationEditor: draft ? { draft, prev } : null, menu: null }),
  automationConsent: null,
  askTurnOn: (a, reconfirm = false) => set({ automationConsent: a ? { automation: a, reconfirm } : null, menu: null }),
  closingRun: null,
  askCloseRun: (runId) => set({ closingRun: runId, menu: null }),
  redisTabs: [],
  openRedis: (asked) => {
    const view = asked ?? 'keys';
    if (!redisViewsShown(useRedis.getState().status).includes(view)) return;
    const key = redisKey(view);
    if (popped(key)) return;
    enter(key);
    const st = get();
    const tabOrder = st.tabOrder.includes(key) ? st.tabOrder : insertAfterActive(st.tabOrder, key, st.activeKey());
    set({ redisTabs: st.redisTabs.includes(view) ? st.redisTabs : [...st.redisTabs, view], tabOrder, activeTab: key, menu: null });
  },
  bgFeeds: {},
  bgWatched: {},
  bgPopover: null,
  revFiles: [],
  dbTabs: [],
  dbPreview: null,
  openDbTab: (ref, o) => {
    const overview = ref.kind === 'overview';
    const key = overview ? dbTabKey(ref.connId) : dbTabKey(ref.connId, ref.schema, ref.name);
    const tab: DbTabRef = { ...ref, ...(overview ? { schema: '', name: '' } : {}), key, view: o.view ?? ref.view };
    // Its window comes forward (a pop-out holds it, or this is a pop-out: the project window shows it), told how it was
    // asked when there is something to tell: a preview or not, a view or none (that window keeps the one it
    // shows), a key's filters. Nothing asked of a pop-out holding it: it just comes forward.
    const p = o.view || o.filters || get().popout ? payloadOf({ ...get(), dbTabs: [tab] }, key) : undefined;
    const { side, view, ...asked } = o;
    if (popped(key, p?.kind === 'db' ? { payload: { ...p, open: { ...asked, view: !!view } } } : undefined)) return;
    enter(key);
    if (side) {
      // Open to the Side: opened kept without the panes following, then placed on the right.
      const before = get().split;
      const active = get().activeKey();
      hush(() => get().openDbTab(ref, { ...o, preview: false, side: false }));
      sideOf(before, active, key);
      return;
    }
    handOver(key, o);
    const st = get();
    // The table preview is replaced only in the focused pane: one in a pane that isn't focused (split view) stays there,
    // as a kept tab; the new preview opens in the focused one (openFile's rule, placeOpened).
    const placed = placeOpened(st.split, st.tabOrder, st.activeKey(), key, st.dbPreview, o.preview && st.settings.previewTabs && !overview);
    // The preview it replaces leaves with its tab (its state with it), unless another workspace shows that table.
    const gone = placed.replaced && !shownElsewhere(st, placed.replaced) ? placed.replaced : null;
    const known = st.dbTabs.some((r) => r.key === key);
    const dbTabs = known
      ? st.dbTabs.filter((r) => r.key !== gone).map((r) => (r.key === key && o.view && r.view !== o.view ? { ...r, view: o.view } : r))
      : gone ? st.dbTabs.map((r) => (r.key === gone ? tab : r)) : [...st.dbTabs, tab];
    set({
      dbTabs,
      tabOrder: placed.order,
      // Split view: the new preview takes the replaced one's place in its pane, in the same update.
      ...(placed.split !== st.split ? { split: placed.split } : {}),
      dbPreview: placed.preview,
      activeTab: key,
      menu: null
    });
  },
  keepDbTab: (key) => { if (get().dbPreview === key) set({ dbPreview: null }); },
  setDbView: (key, view) => {
    const tabs = get().dbTabs;
    // A view switch invests in the tab: a preview is kept.
    if (tabs.some((r) => r.key === key && r.view !== view)) { set({ dbTabs: tabs.map((r) => (r.key === key ? { ...r, view } : r)) }); get().keepDbTab(key); }
  },
  closeDbTabs: (filter) => {
    const gone = new Set(get().dbTabs.filter(filter).map((r) => r.key));
    if (!gone.size) return;
    // Closed for good wherever they show: out of the strip (and its panes) or out of Databases' saved view while another
    // space is in front, then out of every workspace.
    dropTabs([...gone], true, false);
    const cur = get();
    set({
      dbTabs: cur.dbTabs.filter((r) => !gone.has(r.key)),
      ...(cur.dbPreview && gone.has(cur.dbPreview) ? { dbPreview: null } : {}),
      ...(cur.ws ? { ws: wsForget(cur.ws, (k) => gone.has(k)) } : {})
    });
  },
  setScmRepos: (sent) => {
    const st = get();
    // Main's answer may predate a status Changes already has, or an op done since: the newer, the op laid over (only
    // Changes' reads settle an op: they are the ones main always sends after it).
    const list = freshEntries(sent, st.gitReposSeen, st.gitSyncIntents);
    const cur = st.scmRepo;
    const keep = cur && list.some((e) => e.root === cur) ? cur : (list.find((e) => e.rel === '') ?? list[0])?.root ?? null;
    set({ scmRepos: list, scmRepo: keep });
  },
  selectScmRepo: (root) => {
    const st = get();
    const proj = st.project?.root;
    if (proj) saveScmPrefs(proj, { repo: root });
    const h = st.historyTab;
    const fp = h && h.scope.kind === 'refs' ? h.scope.firstParent : false;
    set({ scmRepo: root, ...(h && h.repo !== root ? { historyTab: { repo: root, scope: { kind: 'refs', refs: 'all', firstParent: fp }, nonce: Date.now() + Math.random() } } : {}) });
  },
  setScmRefs: (root, refs) => set({ scmRefs: { ...get().scmRefs, [root]: refs } }),
  scmFetch: {},
  setScmFetch: (s) => set({ scmFetch: { ...get().scmFetch, [s.common]: s } }),
  toggleScmSection: (key) => {
    const cur = get().scmCollapsed;
    const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
    const proj = get().project?.root;
    if (proj) saveScmPrefs(proj, { collapsed: next });
    set({ scmCollapsed: next });
  },
  openHistory: (o = {}) => {
    const st = get();
    const repo = o.repo ?? st.scmRepo ?? st.scmRepos?.[0]?.root ?? null;
    if (!repo) return;
    const prefs = st.project ? loadScmPrefs(st.project.root) : {};
    const same = st.historyTab && st.historyTab.repo === repo ? st.historyTab.scope : prefs.scope && prefs.scope.repo === repo ? prefs.scope.scope : null;
    const scope: ScmScope = o.scope ?? same ?? { kind: 'refs', refs: 'all', firstParent: !!prefs.firstParent };
    // Nothing asked for: its window keeps what it shows (from a pop-out, the project window may have none: always said).
    if (popped('history', o.repo || o.scope || st.popout ? { payload: { kind: 'history', repo, scope } } : undefined)) return;
    enter('history');
    if (st.project) saveScmPrefs(st.project.root, { scope: { repo, scope }, ...(repo !== st.scmRepo ? { repo } : {}) });
    set({ historyTab: { repo, scope, nonce: Date.now() + Math.random() }, scmRepo: repo, activeTab: 'history', menu: null, tabOrder: insertAfterActive(get().tabOrder, 'history', get().activeKey()) });
  },
  openBackground: ({ terminalId, itemId = null, here = false }) => {
    const st = get();
    // No item asked for: the first row, pinned (a row that appears above it later does not take over the detail).
    const item = itemId ?? firstItemId(st.terminals.find((x) => x.id === terminalId));
    if (popped('background', { payload: { kind: 'background', terminalId, itemId: item } })) return;
    enter('background');
    const cur = get();
    const before = cur.split;
    const active = cur.activeKey();
    const tabOrder = cur.tabOrder.includes('background') ? cur.tabOrder : insertAfterActive(cur.tabOrder, 'background', active);
    hush(() => set({ backgroundTab: { terminalId, itemId: item, nonce: Date.now() + Math.random() }, tabOrder, bgPopover: null, menu: null }));
    if (here || active === 'background' || active === null) set({ activeTab: 'background' });
    else sideOf(before, active, 'background');
  },
  selectBackgroundItem: (itemId) => { const b = get().backgroundTab; if (b) set({ backgroundTab: { ...b, itemId } }); },
  setBackgroundScope: (terminalId) => {
    const b = get().backgroundTab;
    if (b && b.terminalId !== terminalId) set({ backgroundTab: { ...b, terminalId, itemId: firstItemId(get().terminals.find((x) => x.id === terminalId)) } });
  },
  watchBackground: (terminalId, itemId) => {
    // Marked before asking: main may answer with a feed before the reply.
    set({ bgWatched: { ...get().bgWatched, [feedKey(terminalId, itemId)]: true } });
    return window.atelier.background.watch(terminalId, itemId);
  },
  unwatchBackground: (terminalId, itemId) => {
    const k = feedKey(terminalId, itemId);
    if (k in get().bgWatched) { const { [k]: _gone, ...rest } = get().bgWatched; set({ bgWatched: rest }); }
    window.atelier.background.unwatch(terminalId, itemId);
  },
  applyBackgroundFeed: (f) => {
    if (!get().bgWatched[f.key]) return;
    const prev = get().bgFeeds[f.key];
    let next: BgFeedState;
    if (f.kind === 'output') {
      const fresh = f.lines.map((text, i) => ({ text, at: f.reset ? keptAt(prev, f.dropped, i, text) : f.at }));
      // A delta with no complete line (only the live one moved) keeps the same array: the log's rows are not rebuilt.
      const lines = f.reset || !prev ? fresh.slice(-BUFFER_LINES) : fresh.length === 0 ? prev.lines : [...prev.lines, ...fresh].slice(-BUFFER_LINES);
      next = { kind: 'output', lines, live: f.live, dropped: f.dropped, exit: f.exit, entries: [], meta: null, ...(f.unavailable ? { unavailable: f.unavailable } : {}) };
    } else {
      next = { kind: 'timeline', lines: [], live: '', dropped: 0, exit: null, entries: f.entries, meta: f.meta, ...(f.unavailable ? { unavailable: f.unavailable } : {}) };
    }
    set({ bgFeeds: { ...get().bgFeeds, [f.key]: next } });
  },
  dropBackgroundFeed: (key) => {
    if (!(key in get().bgFeeds)) return;
    const { [key]: _gone, ...rest } = get().bgFeeds;
    set({ bgFeeds: rest });
  },
  openBgPopover: (p) => set({ bgPopover: p }),
  closeBgPopover: () => set({ bgPopover: null }),
  schedules: [],
  setSchedules: (schedules) => set({ schedules }),
  claudeSignals: null,
  setClaudeSignals: (claudeSignals) => set({ claudeSignals }),
  scheduleSheet: null,
  setScheduleSheet: (scheduleSheet) => set({ scheduleSheet, ...(scheduleSheet ? { menu: null, paletteOpen: false, bgPopover: null, schedulePopover: null } : {}) }),
  schedulePopover: null,
  openSchedulePopover: (p) => set({ schedulePopover: p, bgPopover: null }),
  closeSchedulePopover: () => set({ schedulePopover: null }),
  openRevFile: ({ root, oid, rel }) => {
    const st = get();
    const key = `rev:${oid}:${rel}` as const;
    if (popped(key, { payload: { kind: 'rev', root, oid, rel } })) return;
    enter(key);
    const revFiles = st.revFiles.some((f) => f.key === key) ? st.revFiles : [...st.revFiles, { key, root, oid, rel }];
    set({ revFiles, activeTab: key, menu: null, tabOrder: insertAfterActive(get().tabOrder, key, get().activeKey()) });
  },
  scmSwitcherOpen: false,
  setScmSwitcherOpen: (scmSwitcherOpen) => { if (scmSwitcherOpen) enterSessions(); set({ scmSwitcherOpen, ...(scmSwitcherOpen ? { activity: 'scm', menu: null, paletteOpen: false, bgPopover: null, ...sidebarTo(false) } : {}) }); },
  refPicker: null,
  setRefPicker: (refPicker) => set({ refPicker, ...(refPicker ? { menu: null, paletteOpen: false, bgPopover: null } : {}) }),
  maximized: null,
  pastedAt: null,
  updateReady: false,
  updateStatus: null,
  setUpdateStatus: (updateStatus) => set({ updateStatus }),
  dictation: { phase: 'idle', startedAt: 0 },
  dictationStatus: null,
  panels: loadLayout(),
  resumables: [],
  resumablesKnown: false,
  bulkResume: null,
  resumeAll: async (which) => {
    const st = get();
    if (st.bulkResume || !st.project) return;
    // Workspaces on: the active workspace's (its Resume section is the one asking).
    const list = pinnedFirst(resumablesFor(st.resumables, st.project.root).filter((r) => inActiveWs(st, r.id)), st.pins);
    const ids = (which === 'pinned' ? list.filter((r) => st.pins.includes(r.id)) : list).map((r) => r.id);
    if (ids.length === 0) return;
    set({ bulkResume: { total: ids.length, done: 0, queue: ids, stopped: false } });
    let failed = 0;
    // Whatever happens on the way, the run ends: never a progress strip left behind.
    try {
      for (let i = 0; i < ids.length; i++) {
        const b = get().bulkResume;
        if (!b || b.stopped) break;
        set({ bulkResume: { ...b, done: i + 1, queue: ids.slice(i + 1) } });
        const id = ids[i]!;
        // Dismissed (or resumed by hand) meanwhile.
        if (!get().resumables.some((r) => r.id === id)) continue;
        const front = get().activeKey();
        const info = await get().resume(id);
        if (!info) { failed += 1; continue; }
        // The tab in front stays in front — in the space it is in: another space gone to meanwhile stays in front.
        if (front !== null && spaceOf(front) === get().space && get().activeKey() !== front) get().activate(front);
        await startedOrGone(info.id, BULK_START_MS);
      }
    } finally {
      set({ bulkResume: null });
    }
    if (failed > 0) get().showToast(t.resumeAllFailed(failed));
  },
  stopResumeAll: () => {
    const b = get().bulkResume;
    if (b && !b.stopped) set({ bulkResume: { ...b, queue: [], stopped: true } });
  },
  dismissAllAsk: false,
  askDismissAll: () => { enterSessions(); set({ dismissAllAsk: true, activity: 'sessions', menu: null, ...sidebarTo(false) }); },
  cancelDismissAll: () => set({ dismissAllAsk: false }),
  confirmDismissAll: async () => {
    const root = get().project?.root;
    set({ dismissAllAsk: false });
    if (!root) return;
    const st = get();
    await Promise.allSettled(resumablesFor(st.resumables, root).filter((r) => inActiveWs(st, r.id)).map((r) => window.atelier.terminals.dismiss(r.id)));
  },
  history: [],
  historyLoaded: false,
  paletteOpen: false,
  recentFiles: [],
  settings: DEFAULT_SETTINGS,
  shells: [],
  setShells: (shells) => set({ shells }),
  // Preview tabs turned off: the current preview tabs (a file's, a table's) stay as normal ones.
  setSettings: (settings) => set({ settings, settingsLoaded: true, ...(settings.previewTabs ? {} : { preview: null, dbPreview: null }) }),
  settingsOpen: null,
  launchFlagsScope: 'all',
  setLaunchFlagsScope: (launchFlagsScope) => set({ launchFlagsScope }),
  whatsNew: null,
  setWhatsNew: (whatsNew) => set({ whatsNew }),
  // A Disconnect confirm lives only while its section is shown: it never comes back on its own later.
  setSettingsOpen: (settingsOpen) => {
    // A pop-out has no Settings sheet: the project window opens it and comes forward. Never set
    // here, so this window never counts as covered.
    if (get().popout) {
      const api = typeof window !== 'undefined' ? window.atelier?.popout : undefined;
      if (settingsOpen && api) void api.forward(settingsOpen === 'connectors' ? 'open-connectors' : 'open-settings').catch(() => {});
      return;
    }
    set({ settingsOpen, menu: null, paletteOpen: false, notesOpen: false, ...(settingsOpen ? { sessionPanel: null, bgPopover: null, whatsNew: null } : {}), ...(settingsOpen !== 'connectors' ? { connectorConfirm: null, connectorDetail: null, connectorTokenForm: null } : {}) });
  },
  connectorDetail: null,
  // The confirm belongs to its details page: going back to the list or to another connector drops it.
  openConnector: (connectorDetail) => {
    // A pop-out has no Settings sheet: the project window opens that connector's details (like setSettingsOpen).
    if (get().popout) {
      const api = typeof window !== 'undefined' ? window.atelier?.popout : undefined;
      if (connectorDetail && api) void api.forward(`open-connector:${connectorDetail}`).catch(() => {});
      return;
    }
    set({
      connectorDetail, ...(get().connectorConfirm !== connectorDetail ? { connectorConfirm: null } : {}),
      ...(get().connectorTokenForm !== connectorDetail ? { connectorTokenForm: null } : {})
    });
  },
  connectors: [],
  setConnectors: (connectors) => {
    const asking = get().connectorConfirm;
    // Nothing left to disconnect (done from another window, or never connected): the confirm goes.
    const keep = asking !== null && connectors.some((c) => c.id === asking && c.status !== 'disconnected' && c.status !== 'connecting');
    set({ connectors, ...(asking !== null && !keep ? { connectorConfirm: null } : {}) });
  },
  connectorConfirm: null,
  setConnectorConfirm: (connectorConfirm) => set({ connectorConfirm }),
  connectorTokenForm: null,
  setConnectorTokenForm: (connectorTokenForm) => set({ connectorTokenForm }),
  connectorNotice: (n) => {
    const name = get().connectors.find((c) => c.id === n.id)?.name ?? CONNECTOR_NAMES[n.id];
    const v = noticeView(n, name);
    // Every way out goes on in the connector's details (Reconnect / Retry: the countdown and Cancel while the browser is open).
    const run = () => {
      useApp.getState().setSettingsOpen('connectors');
      useApp.getState().openConnector(n.id);
      if (v.action !== 'details') void window.atelier.connectors.connect(n.id).catch(() => {});
    };
    get().showToast(v.text, v.action ? { label: t.conn.toastActions[v.action], run } : undefined);
  },
  taskLists: [],
  setTaskLists: (taskLists) => set({ taskLists }),
  taskLinks: {},
  linkTask: (id, link) => setTaskLinks({ ...get().taskLinks, [id]: link }),
  unlinkTask: (id) => {
    if (!get().taskLinks[id]) return;
    const { [id]: _gone, ...rest } = get().taskLinks;
    setTaskLinks(rest);
  },
  relinkTask: (from, to) => {
    const link = get().taskLinks[from];
    if (!link || from === to) return;
    const { [from]: _moved, ...rest } = get().taskLinks;
    setTaskLinks({ ...rest, [to]: link });
  },
  resume: async (id) => {
    const { size } = get();
    // A session asked for brings Sessions forward when asked — never during Resume all, which
    // runs in the background — and doesn't pull you back once it is there.
    if (!get().bulkResume) enterSessions();
    resuming.add(id);
    try {
      const info = await window.atelier.terminals.resume(id, size.cols || 120, size.rows || 36);
      get().relinkTask(id, info.id);
      setPins(relinkPin(get().pins, id, info.id));
      // Its workspace too: the new id is where the old one was.
      const ws = get().ws;
      if (ws) set({ ws: wsRelink(ws, id, info.id) });
      // Resumed from elsewhere (the palette) into another workspace: that workspace comes forward with it. Never during
      // Resume all: it resumes the active workspace's, and a switch made meanwhile is the user's — so is a space left.
      const w = get();
      if (wsOn(w) && !w.bulkResume && w.space === 'sessions' && memberOf(w.ws, info.id) !== w.ws.active) w.switchWorkspace(memberOf(w.ws, info.id));
      get().launched(info);
      return info;
    } catch {
      return null;
    } finally {
      resuming.delete(id);
      prunePinned();
      pruneLinks();
    }
  },
  launchedToSide: (info) => {
    // Another space in front by now: it lands in Sessions without pulling them there.
    if (get().space !== 'sessions' && !get().popout) { get().launched(info); return; }
    const before = get().split;
    const active = get().activeKey();
    // Shown without taking the focused pane (as Open to the Side does for a file), then placed on its right.
    hush(() => get().launched(info));
    if (!get().tabOrder.includes(`t:${info.id}`)) return;
    sideOf(before, active, `t:${info.id}`);
  },
  treeEdit: null,
  startTreeEdit: (treeEdit) => { enterSessions(); set({ treeEdit, activity: 'files', menu: null, ...sidebarTo(false) }); },
  endTreeEdit: () => set({ treeEdit: null }),
  treeNonce: 0,
  bumpTree: () => set({ treeNonce: get().treeNonce + 1 }),
  dirNonce: {},
  relistFolders: (folders) => {
    if (folders === 'all') { get().bumpTree(); return; }
    const next = { ...get().dirNonce };
    for (const f of folders) next[f] = (next[f] ?? 0) + 1;
    set({ dirNonce: next });
  },
  toast: null,
  showToast: (text, action, tone, ms) => {
    const cur = get().toast;
    if (!text) {
      // The one waiting behind an Undo toast shows when that one closes.
      const next = waitingToast;
      waitingToast = null;
      set({ toast: next ? { text: next.text, nonce: Date.now() + Math.random(), ...(next.tone ? { tone: next.tone } : {}) } : null });
      return;
    }
    // A toast with an action (Undo after Send) keeps its 8 s: a plain one waits for it (the latest only).
    if (!action && cur?.action && Date.now() - cur.nonce < (cur.ms ?? ACTION_TOAST_MS)) { waitingToast = { text, tone }; return; }
    waitingToast = null;
    const [first, second] = Array.isArray(action) ? action : [action];
    set({ toast: { text, nonce: Date.now() + Math.random(), ...(first ? { action: first } : {}), ...(second ? { second } : {}), ...(tone ? { tone } : {}), ...(ms ? { ms } : {}) } });
  },
  comments: [],
  addComment: (c) => {
    const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    setComments([...get().comments, { ...c, ...snippetFields(c.snippet), id, createdAt: Date.now() }]);
    return id;
  },
  updateComment: (id, patch) => setComments(get().comments.map((c) => (c.id === id ? { ...c, ...patch } : c))),
  deleteComment: (id) => { get().setCommentEdit(id, null); setComments(get().comments.filter((c) => c.id !== id)); },
  keepComments: (ids) => {
    const keep = new Set(ids);
    setComments(get().comments.map((c) => { if (!keep.has(c.id) || !c.gone) return c; const { gone: _, ...rest } = c; return rest; }));
  },
  removeComments: (ids) => {
    const gone = new Set(ids);
    const removed = get().comments.filter((c) => gone.has(c.id));
    setComments(get().comments.filter((c) => !gone.has(c.id)));
    return removed;
  },
  restoreComments: (list) => {
    const have = new Set(get().comments.map((c) => c.id));
    setComments([...get().comments, ...list.filter((c) => !have.has(c.id))].sort((a, b) => a.createdAt - b.createdAt));
  },
  commentDraft: null,
  openCommentDraft: (d) => set({ commentDraft: { ...d, text: '', nonce: Date.now() + Math.random() }, menu: null }),
  updateCommentDraft: (patch) => { const d = get().commentDraft; if (d) set({ commentDraft: { ...d, ...patch } }); },
  closeCommentDraft: () => set({ commentDraft: null }),
  commentEdits: {},
  setCommentEdit: (id, text) => {
    const cur = get().commentEdits;
    if (text === null) { if (!(id in cur)) return; const { [id]: _, ...rest } = cur; set({ commentEdits: rest }); return; }
    set({ commentEdits: { ...cur, [id]: text } });
  },
  lastSession: null,
  renameOpenFiles: (oldPath, newPath, root) => {
    const st = get();
    const moved = (p: string) => (p === oldPath ? newPath : isBelow(oldPath, p) ? newPath + p.slice(oldPath.length) : null);
    set({ recentFiles: renameRecent(st.recentFiles, oldPath, newPath, root) });
    setShelf(renameRecent(st.shelf, oldPath, newPath, root));
    // A chosen language follows its file.
    setOverrides(renameOverrides(st.langOverrides, oldPath, newPath));
    setMdViews(renameMdViews(st.mdViews, oldPath, newPath));
    setCsvOptionsMap(renameCsvOptions(st.csvOptions, oldPath, newPath));
    // Line comments follow their file (the draft box too).
    if (st.comments.some((c) => moved(c.path))) setComments(st.comments.map((c) => { const n = moved(c.path); return n ? { ...c, path: n } : c; }));
    const draftPath = st.commentDraft ? moved(st.commentDraft.path) : null;
    if (st.commentDraft && draftPath) set({ commentDraft: { ...st.commentDraft, path: draftPath } });
    if (!st.openFiles.some((f) => moved(f.path))) return;
    const rel = (p: string) => (isBelow(root, p) ? p.slice(root.length + 1) : p);
    const dirty = { ...st.dirty };
    const openFiles = st.openFiles.map((f) => {
      const n = moved(f.path);
      if (!n) return f;
      if (dirty[f.path]) { dirty[n] = true; delete dirty[f.path]; }
      return { ...f, path: n, rel: rel(n), nonce: Date.now() + Math.random() };
    });
    const renamed = (k: TabKey): TabKey => (k.startsWith('f:') && moved(k.slice(2)) ? (`f:${moved(k.slice(2))}` as TabKey) : k);
    const tabOrder = st.tabOrder.map(renamed);
    const activeTab = moved(st.activeTab) ?? st.activeTab;
    const preview = st.preview ? moved(st.preview) ?? st.preview : null;
    // Another space in front: Sessions' saved view is renamed instead; the strip in front holds
    // no file, so nothing of it changes.
    set({ openFiles, tabOrder, activeTab, dirty, preview, split: renameKeys(st.split, renamed), spaceViews: renameInViews(st.spaceViews, renamed) });
    // The other workspaces' tabs follow too: their order, front and layout.
    const ws = get().ws;
    if (ws) set({ ws: wsRenameKeys(ws, renamed) });
  },
  dropOpenFiles: (path) => {
    const st = get();
    const gone = (p: string) => p === path || isBelow(path, p);
    set({ recentFiles: dropRecent(st.recentFiles, path) });
    setShelf(dropRecent(st.shelf, path));
    setOverrides(dropOverrides(st.langOverrides, path));
    setMdViews(dropMdViews(st.mdViews, path));
    setCsvOptionsMap(dropCsvOptions(st.csvOptions, path));
    // Comments on what went to the Trash are set aside: a path that no longer exists is not sent unless kept.
    const aside = st.comments.filter((c) => gone(c.path) && !c.gone).map((c) => c.id);
    if (aside.length) {
      setComments(st.comments.map((c) => (aside.includes(c.id) ? { ...c, gone: true } : c)));
      get().showToast(t.comments.setAside(aside.length), { label: t.comments.keep, run: () => useApp.getState().keepComments(aside) });
    }
    if (st.commentDraft && gone(st.commentDraft.path)) set({ commentDraft: null });
    const keys = st.openFiles.filter((f) => gone(f.path)).map((f) => `f:${f.path}` as TabKey);
    if (!keys.length) return;
    const active = st.activeKey();
    const next = afterClose(st.tabOrder, keys, active, tabRecent);
    const dirty = { ...st.dirty };
    for (const k of keys) delete dirty[k.slice(2)];
    // Another space in front: they leave Sessions' saved view instead.
    set({ openFiles: st.openFiles.filter((f) => !gone(f.path)), tabOrder: st.tabOrder.filter((k) => !keys.includes(k)), spaceViews: forgetKeys(st, (k) => keys.includes(k)), dirty, ...(st.preview && gone(st.preview) ? { preview: null } : {}) });
    if (active && keys.includes(active)) leaveActive(next);
  },
  confirmUnsavedUnder: async (path, how) => {
    const st = get();
    const under = st.openFiles.map((f) => f.path).filter((p) => (p === path || isBelow(path, p)) && isDirtyNow(p, !!st.dirty[p]));
    if (!under.length) return true;
    // Asked in the window: the checked files are saved, the others discarded.
    const answer = await get().askUnsaved(under, how, null);
    if (answer === 'cancel') return false;
    const keep = answer === 'discard' ? [] : answer.save.filter((p) => under.includes(p));
    if (keep.length && !(await saveMany(keep))) return false;
    const d = { ...get().dirty };
    for (const p of under) if (!keep.includes(p)) delete d[p];
    set({ dirty: d });
    return true;
  },
  dirty: {},
  setDirty: (path, d) => {
    if (!!get().dirty[path] !== d) set({ dirty: { ...get().dirty, [path]: d } });
    if (d) get().keepOpen(path);
  },
  renaming: null,
  setRenaming: (req) => {
    if (req?.at === 'tab' && !get().tabOrder.includes(`t:${req.id}`)) {
      get().setActivity('sessions');
      set({ renaming: { id: req.id, at: 'row' } });
    } else set({ renaming: req });
  },
  sessionPanel: null,
  // The panel's restart question closes with it.
  setSessionPanel: (sessionPanel) => set({ sessionPanel, ...(get().restartAsk?.at === 'panel' && get().restartAsk?.id !== sessionPanel ? { restartAsk: null } : {}) }),
  contextSheet: null,
  // The sheet stands alone: the Session panel, the palette and a menu close under it.
  setContextSheet: (contextSheet) => set({ contextSheet, ...(contextSheet ? { sessionPanel: null, paletteOpen: false, menu: null, bgPopover: null } : {}) }),
  contextReports: {},
  setContextReport: (id, sessionId, report) => set({ contextReports: { ...get().contextReports, [id]: { sessionId, report } } }),
  treeReveal: null,
  revealInTree: (path) => { enterSessions(); set({ treeReveal: { path, nonce: Date.now() + Math.random() }, activity: 'files', ...sidebarTo(false) }); },
  linkTip: null,
  setLinkTip: (linkTip) => set({ linkTip }),
  menu: null,
  openMenu: (at, items, opts) => {
    if ('preventDefault' in at && at.preventDefault) at.preventDefault();
    const x = 'clientX' in at ? at.clientX : at.x;
    const y = 'clientY' in at ? at.clientY : at.y;
    const anchor = 'anchor' in at ? at.anchor : undefined;
    if (items.some((i) => i !== 'sep')) set({ menu: { x, y, items, ...(anchor ? { anchor } : {}), ...(opts?.onStep ? { onStep: opts.onStep } : {}) } });
  },
  closeMenu: () => { if (get().menu) set({ menu: null }); },
  tabOrder: [],
  pendingAnchor: null,
  ws: null,
  space: 'sessions',
  spaceViews: emptyViews(),
  sessionsActivity: 'sessions',
  spaceView: (id) => {
    const s = get();
    // Its empty panes too: they are there when it comes back.
    return id === s.space ? { order: s.tabOrder, front: s.activeKey(), layout: isSplit(s.split) ? serializeLayout(s.split, true) : null } : s.spaceViews[id];
  },
  switchSpace: (to, activity) => {
    const s = get();
    if (s.popout) return;
    const act = activity ?? (to === 'sessions' ? s.sessionsActivity : SPACE_ACTIVITY[to]);
    if (to === s.space) { if (s.activity !== act) set({ activity: act }); return; }
    // The space you leave keeps its view; Sessions with workspaces on writes its workspace's entry too, as a workspace
    // switch does (its saved entry lags while it is in front).
    const views: SpaceViews = { ...s.spaceViews, [s.space]: s.spaceView(s.space) };
    const ws = s.space === 'sessions' && wsOn(s) ? wsLive(s) : s.ws;
    const v = views[to];
    // Each space keeps its own tab history: a close there still gives the front back to the tab used before it.
    recentAway = { ...recentAway, [s.space]: tabRecent };
    tabRecent = recentAway[to] ?? [];
    // What still lives of it; Sessions also takes the terminals that came (after its front) or went while it was away.
    const kept = v.order.filter((k) => aliveKey(s, k));
    const anchor = v.front && kept.includes(v.front) ? v.front : null;
    let order = to === 'sessions' ? syncTerminals(kept, sessionTerminalIds({ ...s, ws }), anchor) : kept;
    const restored = restoreLayout(v.layout, order, true);
    if (restored) order = flatten(restored);
    const split = restored ?? single();
    const fallback = anchor ?? afterClose(v.order, v.order.filter((k) => !order.includes(k)), v.front, tabRecent);
    const front = restored ? restored.panes[restored.focus]!.front : fallback && order.includes(fallback) ? fallback : order.at(-1) ?? null;
    // Sessions' selection (the Send to target, the session behind a file) is the one it had: it never changed meanwhile.
    const shown = to === 'sessions' ? frontOf(front, order, split, s.selectedId) : { activeTab: front ? tabOf(front) : NO_TAB };
    const leaving = s.space === 'sessions' && spaceOfActivity(s.activity) === 'sessions' ? { sessionsActivity: s.activity } : {};
    // One update: the split subscription never sees one space's tabs with another's panes.
    hush(() => set({ space: to, spaceViews: views, ws, tabOrder: order, split, pendingAnchor: null, ...shown, ...leaving, activity: act, menu: null }));
    // What waited for Sessions: the layout saved for the project, workspaces turned on in every project meanwhile.
    if (to === 'sessions') {
      restoreLayoutOnce();
      if (wsEverywhereWaits) { wsEverywhereWaits = false; get().applyWorkspacesEverywhere(); }
    }
  },
  wsRenaming: null,
  setWsRenaming: (wsRenaming) => set({ wsRenaming }),
  wsSheet: null,
  setWsSheet: (wsSheet) => set({ wsSheet }),
  wsCloseAsk: null,
  wsActCloseAsk: null,
  setWsActCloseAsk: (wsActCloseAsk) => set({ wsActCloseAsk }),
  changesScope: 'all',
  setChangesScope: (changesScope) => set({ changesScope }),
  setWsCloseAsk: (wsCloseAsk) => set({ wsCloseAsk }),
  activeKey: () => keyOf(get().activeTab, get().selectedId),
  activate: (key) => {
    if (!key) {
      // Another space with no tab left: its empty state, the selection untouched.
      if (get().space !== 'sessions' && !get().popout) { set({ activeTab: NO_TAB }); return; }
      // No tab left: the empty state, never a terminal whose tab is hidden or lives in a pop-out.
      const sel = get().selectedId;
      const gone = sel !== null && (get().hidden.includes(sel) || get().poppedOut.includes(`t:${sel}`));
      set({ activeTab: 'term', ...(gone ? { selectedId: null } : {}) });
      return;
    }
    if (popped(key)) return;
    enter(key);
    if (key.startsWith('t:')) get().select(key.slice(2));
    else if (key === 'services') set({ activeTab: 'services', servicesOpen: true });
    else if (key === 'review') { if (get().review) set({ activeTab: 'review' }); }
    else if (key === 'history') { if (get().historyTab) set({ activeTab: 'history' }); }
    else if (key === 'background') { if (get().backgroundTab) set({ activeTab: 'background' }); }
    else if (key.startsWith('dk:')) { if (get().dockerTabs.some((r) => r.key === key)) set({ activeTab: key }); }
    else if (key.startsWith('rd:')) { if (get().redisTabs.some((v) => redisKey(v) === key)) set({ activeTab: key }); }
    else if (key.startsWith('au:')) { if (get().autoTabs.some((r) => r.key === key)) set({ activeTab: key }); }
    else if (key.startsWith('rev:')) { if (get().revFiles.some((f) => f.key === key)) set({ activeTab: key }); }
    else if (key.startsWith('db:')) { if (get().dbTabs.some((r) => r.key === key)) set({ activeTab: key }); }
    else set({ activeTab: key.slice(2) });
  },
  split: single(),
  splitRight: () => {
    const st = get();
    const next = addPane(st.split, st.tabOrder, st.activeKey());
    if (!next) { st.showToast(t.split.max, undefined, 'info'); return; }
    applySplit(next);
  },
  closePane: (i) => {
    const s = panesNow();
    if (isSplit(s)) applySplit(unsplit(s, i ?? s.focus));
  },
  closeOtherPanes: () => {
    const s = panesNow();
    if (isSplit(s)) applySplit(unsplitAll(s));
  },
  // A preview moved on purpose is kept open (as a strip drag keeps it): the next single-click open never replaces it
  //. A table preview too.
  moveTabToPane: (key, pane, before) => {
    const s = panesNow();
    if (!isSplit(s)) { if (pane === 0) get().moveTab(key, before); return; }
    applySplit(moveToPane(s, key, pane, before, tabRecent));
    keepMoved(key);
  },
  moveTabToNewPane: (key, pane, side) => {
    const st = get();
    if (!st.tabOrder.includes(key)) return;
    const next = moveToNewPane(panesNow(), st.tabOrder, st.activeKey(), key, pane, side, tabRecent);
    if (next) { applySplit(next); keepMoved(key); }
  },
  moveTabStep: (dir) => {
    const st = get();
    const key = st.activeKey();
    const next = moveStep(panesNow(), st.tabOrder, key, dir, tabRecent);
    if (next) { applySplit(next); if (key) keepMoved(key); }
  },
  moveTabSide: (key, dir) => {
    const st = get();
    if (!st.tabOrder.includes(key)) return;
    const s = lift(panesNow(), st.tabOrder, st.activeKey());
    const from = s.panes.findIndex((p) => p.tabs.includes(key));
    if (from < 0) return;
    const to = from + dir;
    const next = to >= 0 && to < s.panes.length
      ? moveToPane(s, key, to, null, tabRecent)
      : moveToNewPane(s, st.tabOrder, st.activeKey(), key, from, dir === 1 ? 'right' : 'left', tabRecent);
    if (next) { applySplit(next); keepMoved(key); }
  },
  focusedStrip: () => { const st = get(); return stripKeys(st.split, st.tabOrder, st.split.focus); },
  focusPane: (i) => { const s = get().split; const next = focusAt(s, i); if (next !== s) applySplit(next); },
  focusNextPane: () => { const s = get().split; const next = focusStep(s, 1); if (next !== s) applySplit(next); },
  focusPrevPane: () => { const s = get().split; const next = focusStep(s, -1); if (next !== s) applySplit(next); },
  openToSide: (key) => {
    if (popped(key)) return;
    enter(key);
    // A terminal of another workspace (its row open in the sidebar): that workspace comes to
    // the front first, and it opens to the side there — never as a foreign tab in this strip.
    const s0 = get();
    if (key.startsWith('t:') && wsOn(s0) && s0.terminals.some((x) => x.id === key.slice(2))) {
      const to = memberOf(s0.ws, key.slice(2));
      if (to !== s0.ws.active) s0.switchWorkspace(to);
    }
    const st = get();
    const active = st.activeKey();
    if (key.startsWith('t:')) {
      const id = key.slice(2);
      if (!st.terminals.some((x) => x.id === id)) return;
      // A hidden terminal gets its tab back, next to the active one (as selecting it does).
      hush(() => {
        setHidden(showId(get().hidden, id));
        set({ tabOrder: insertAfterActive(get().tabOrder, key, active) });
      });
    }
    if (!get().tabOrder.includes(key)) return;
    sideOf(get().split, active, key);
  },
  openFileToSide: (path, rel, line = null, at) => {
    if (popped(`f:${path}`, line !== null ? { line, found: at?.found } : undefined)) return;
    enter(`f:${path}`);
    const before = get().split;
    const active = get().activeKey();
    // Opened without following (the focused pane keeps its tab), then placed on the side.
    hush(() => get().openFile(path, rel, line, undefined, { ...at, preview: false }));
    sideOf(before, active, `f:${path}`);
  },
  dropTab: (key, pane, zone) => {
    const st = get();
    if (!st.tabOrder.includes(key)) return;
    const s = panesNow();
    const own = isSplit(s) ? paneOf(s, key) === pane : pane === 0;
    if (zone === 'middle') {
      // Its own pane's middle (a docked tab lands in the focused pane first): that pane,
      // with it in front — set at once, so an empty focused pane can't take it.
      if (own && isSplit(s)) { applySplit(s); bringToFront(key); }
      else if (own) st.activate(key);
      else st.moveTabToPane(key, pane, null);
      return;
    }
    // An edge: a new pane on that side (refused for a tab alone in that very pane, and at three panes).
    st.moveTabToNewPane(key, pane, zone);
  },
  setFractions: (fractions) => {
    const s = get().split;
    if (!isSplit(s) || fractions.length !== s.panes.length || fractions.some((f) => !Number.isFinite(f) || f <= 0)) return;
    set({ split: { ...s, fractions } });
  },
  equalizePanes: () => {
    const s = get().split;
    if (isSplit(s)) set({ split: { ...s, fractions: s.panes.map(() => 1 / s.panes.length) } });
  },
  tabDrag: null,
  setTabDrag: (tabDrag) => { if (get().tabDrag !== tabDrag) set({ tabDrag, ...(tabDrag ? {} : { tabDragAt: null, tabDragTarget: null }) }); },
  tabDragAt: null,
  tabDragTarget: null,
  fileDrag: false,
  setFileDrag: (fileDrag) => { if (get().fileDrag !== fileDrag) set({ fileDrag }); },
  layoutRestored: false,
  tabsRestored: false,
  moveTab: (key, before) => {
    const s = panesNow();
    if (isSplit(s)) {
      // Split view: within its pane, or into the pane of the tab it lands before (in front there, focused).
      const to = before !== null ? paneOf(s, before) : paneOf(s, key);
      if (to >= 0) applySplit(moveToPane(s, key, to, before, tabRecent));
    } else set({ tabOrder: moveKey(get().tabOrder, key, before) });
    keepMoved(key);
  },
  workspacesNow: () => wsLive(get()),
  setWorkspacesOn: (on) => {
    // Workspaces cut Sessions' strip: turned on or off from another space (the menu, the palette, Settings), Sessions
    // comes forward to show them, as switching a workspace does.
    const asked = get();
    if (!asked.popout && asked.project && on !== !!asked.ws?.on && (on || !asked.settings.workspacesEverywhere)) enterSessions();
    const s = get();
    if (s.popout || !s.project || on === !!s.ws?.on) return;
    // On in every project (Settings): the project's own switch can't turn them off meanwhile.
    if (!on && s.settings.workspacesEverywhere) return;
    if (!on) {
      // Every workspace's tabs in one strip (workspace order), the front and the active workspace's split kept. Only what
      // still lives (a file trashed or renamed meanwhile leaves no ghost); terminals missing from an order come with the
      // list's own rule.
      const { forced: _forced, ...ws } = wsLive(s)!;
      const union = wsUnion(ws, s.tabOrder).filter((k) => isProjectKey(k) || liveKey(s, k));
      if (isSplit(s.split)) {
        // Split view: the active workspace's panes stay; the other workspaces' tabs join
        // the focused pane after its own (an empty focused pane: the first pane with tabs).
        const here = new Set(flatten(s.split));
        const extra = union.filter((k) => !here.has(k));
        const to = s.split.panes[s.split.focus]!.tabs.length > 0 ? s.split.focus : Math.max(0, s.split.panes.findIndex((p) => p.tabs.length > 0));
        hush(() => set({ ws: { ...ws, on: false } }));
        applySplit({ ...s.split, panes: s.split.panes.map((p, i) => (i === to && extra.length ? { ...p, tabs: [...p.tabs, ...extra] } : p)) });
      } else set({ ws: { ...ws, on: false }, tabOrder: union });
      get().applyTerminals(get().terminals);
      return;
    }
    if (!s.ws) {
      set({ ws: wsInitial(newWorkspaceId(), s.tabOrder, s.activeKey(), s.terminals.map((x) => x.id)), tabOrder: projectLast(s.tabOrder) });
      return;
    }
    // Back on: what was opened meanwhile belongs to the active workspace, the rest goes back where it was.
    set({ ws: { ...s.ws, on: true } });
    cutView();
  },
  applyWorkspacesEverywhere: () => {
    const s = get();
    if (s.popout || !s.project) return;
    // A setting changed while another space is in front: nothing switches; Sessions takes it when it comes back.
    if (s.space !== 'sessions') { wsEverywhereWaits = true; return; }
    if (s.settings.workspacesEverywhere) {
      if (s.ws?.on) return;
      get().setWorkspacesOn(true);
      const ws = get().ws;
      if (ws?.on) set({ ws: { ...ws, forced: true } });
    } else if (s.ws?.on && s.ws.forced) get().setWorkspacesOn(false);
  },
  switchWorkspace: (id) => {
    // Workspaces are Sessions': switching one from another space brings Sessions forward.
    if (wsOn(get()) && get().ws?.list.some((w) => w.id === id)) enterSessions();
    const s = get();
    if (!wsOn(s) || id === s.ws.active || !s.ws.list.some((w) => w.id === id)) return;
    // The one you go to opens in the sidebar; the one you leave stays as it showed (revised).
    const next = wsToFront(wsLive(s)!, id);
    const view = viewOf(next, id, (k) => liveKey(s, k));
    // Its live terminals its saved order misses (back from a pop-out, moved while it was away) get their tab now.
    const missing = s.terminals.map((x) => `t:${x.id}` as TabKey).filter((k) => memberOf(next, k.slice(2)) === id && liveKey(s, k) && !view.order.includes(k));
    const tabOrder = [...view.order, ...missing, ...s.tabOrder.filter(isProjectKey)];
    const restored = restoreLayout(view.layout, tabOrder);
    const front = restored ? restored.panes[restored.focus]!.front : view.active ?? tabOrder.filter((k) => !isProjectKey(k)).at(-1) ?? null;
    const split = restored ?? single();
    // One update: the split subscription never sees one workspace's tabs with the other's panes.
    // A restored split brings its own order (the panes' tabs, left to right).
    const order = restored ? flatten(restored) : tabOrder;
    // Tables are Databases': their preview stays whatever workspace comes forward.
    hush(() => set({
      ws: next, tabOrder: order, split, pendingAnchor: null, ...frontOf(front, order, split), ...(get().preview && !order.includes(`f:${get().preview}`) ? { preview: null } : {})
    }));
  },
  goToWorkspace: (id) => {
    const ws = get().ws;
    if (ws) get().switchWorkspace(placeOnReturn(ws, id));
  },
  newWorkspace: (opts, move) => {
    const s = get();
    if (!wsOn(s)) return null;
    const id = newWorkspaceId();
    const ws = wsCreate(s.ws, opts, id);
    if (!ws) return null;
    set({ ws });
    if (move) get().moveToWorkspace(move, id, { quiet: true });
    get().switchWorkspace(id);
    return id;
  },
  renameWorkspace: (id, name) => { const ws = get().ws; if (ws) set({ ws: wsRename(ws, id, name) }); },
  recolorWorkspace: (id, color) => { const ws = get().ws; if (ws) set({ ws: wsRecolor(ws, id, color) }); },
  moveWorkspace: (id, dir) => { const ws = get().ws; if (ws) set({ ws: wsReorder(ws, id, dir) }); },
  toggleWorkspaceOpen: (id) => { const s = get(); if (wsOn(s)) set({ ws: wsToggleOpen(s.ws, id) }); },
  moveToWorkspace: (key, id, opts) => {
    const s = get();
    if (!wsOn(s) || !s.ws.list.some((w) => w.id === id) || !workspaceKey(key)) return;
    const tid = key.startsWith('t:') ? key.slice(2) : null;
    const name = s.ws.list.find((w) => w.id === id)!.name;
    const item = tabTitle(s, key);
    const say = () => { if (!opts?.quiet) get().showToast(t.wsAct.moved(item, name), { label: t.ws.go, run: () => useApp.getState().switchWorkspace(id) }, 'info'); };
    // A row of a workspace not in front, open in the sidebar: its tab is in no live strip, so
    // only the membership and the saved orders change; into the active workspace it gets its tab here.
    if (tid && s.terminals.some((x) => x.id === tid) && memberOf(s.ws, tid) !== s.ws.active) {
      const from = memberOf(s.ws, tid);
      if (from === id) return;
      set({ ws: wsMove(wsLive(s)!, key, id, from) });
      if (id === s.ws.active) get().applyTerminals(get().terminals);
      else say();
      return;
    }
    if (id === s.ws.active) return;
    // A terminal of this workspace, its tab shown or closed (its row is still in the sidebar); any other tab of the strip.
    if (tid ? !s.terminals.some((x) => x.id === tid) || memberOf(s.ws, tid) !== s.ws.active : !s.tabOrder.includes(key)) return;
    // Written into the target first: a file the target shows is "shown elsewhere", so leaving this strip keeps it open.
    set({ ws: wsMove(wsLive(s)!, key, id) });
    dropTabs([key], false, true);
    // Where it went, and a way there; not when it was moved into a workspace just made, which comes forward.
    say();
  },
  closeWorkspace: async (id, how) => {
    const s = get();
    if (!wsOn(s)) return;
    const wss = workspacesOf(s.ws);
    const i = wss.findIndex((w) => w.id === id);
    if (wss.length <= 1 || i === -1) return;
    const target = wss[i === 0 ? 1 : i - 1]!.id;
    // Its files close unless another place shows them (its activities moving keep theirs); unsaved ones are asked about
    // first, as for any close, and Cancel (or a failed save) leaves everything as it was.
    const live0 = wsLive(s)!;
    const after0 = wsRemove(live0, id, how === 'move' ? target : null);
    if (!after0) return;
    const closing = closingKeys(live0, after0, [id, ...activitiesOf(live0, id).map((w) => w.id)]);
    const settled = settleUnsaved(closing);
    if (settled !== true && !(await settled)) return;
    const w0 = get().ws;
    if (w0 && workspaceOf(w0, w0.active) === id) get().switchWorkspace(target);
    const cur = get();
    if (!wsOn(cur)) return;
    const live = wsLive(cur)!;
    const mine = cur.terminals.map((x) => x.id).filter((tid) => workspaceOf(live, memberOf(live, tid)) === id);
    const ws = wsRemove(live, id, how === 'move' ? target : null);
    if (!ws) return;
    if (how === 'stop') markStopping(mine);
    set({ ws });
    closeGone(closing);
    if (how === 'move') { get().applyTerminals(get().terminals); return; }
    await stopTerminals(mine);
  },
  newWsActivity: (wsId, move) => {
    const s = get();
    if (!wsOn(s) || !s.settings.wsActivities) return null;
    const id = newWorkspaceId();
    const ws = wsCreateAct(s.ws, wsId, t.wsAct.defaultName, id);
    if (!ws) return null;
    set({ ws });
    if (move) get().moveToWorkspace(move, id, { quiet: true });
    get().switchWorkspace(id);
    get().setWsRenaming(id);
    return id;
  },
  moveWsActivity: (id, wsId) => {
    const s = get();
    if (!wsOn(s)) return;
    const a = s.ws.list.find((w) => w.id === id);
    if (!a?.parent || wsMoveAct(s.ws, id, wsId) === s.ws) return;
    // In front: its workspace's own tabs come forward first, so nothing in front changes workspace under the window.
    if (s.ws.active === id) get().switchWorkspace(a.parent);
    const cur = get();
    if (!wsOn(cur)) return;
    set({ ws: wsMoveAct(wsLive(cur)!, id, wsId) });
    const to = cur.ws.list.find((w) => w.id === wsId)!.name;
    get().showToast(t.wsAct.moved(a.name, to), { label: t.ws.go, run: () => useApp.getState().switchWorkspace(id) }, 'info');
  },
  closeWsActivity: async (id, how) => {
    const s = get();
    if (!wsOn(s)) return;
    const a = s.ws.list.find((w) => w.id === id);
    if (!a?.parent) return;
    const wsId = a.parent;
    // Stop: its file tabs close unless another place shows them, unsaved ones asked about first. Move: they join its
    // workspace, nothing closes.
    const live0 = wsLive(s)!;
    const closing = how === 'stop' ? closingKeys(live0, wsRemoveAct(live0, id, how), [id]) : [];
    const settled = settleUnsaved(closing);
    if (settled !== true && !(await settled)) return;
    if (get().ws?.active === id) get().switchWorkspace(wsId);
    const cur = get();
    if (!wsOn(cur)) return;
    const live = wsLive(cur)!;
    const entry = live.list.find((w) => w.id === id);
    if (!entry) return;
    const mine = cur.terminals.map((x) => x.id).filter((tid) => memberOf(live, tid) === id);
    const ws = wsRemoveAct(live, id, how);
    if (how === 'stop') markStopping(mine);
    set({ ws });
    if (how === 'move') {
      // Its workspace's own tabs in front: its tabs join the strip now, after the own ones, in its order.
      if (ws.active === wsId) appendToStrip(entry.order.filter((k) => liveKey(cur, k) && !cur.tabOrder.includes(k)));
      get().applyTerminals(get().terminals);
      return;
    }
    closeGone(closing);
    await stopTerminals(mine);
  },
  setProject: (project) => {
    if (project?.popout && !get().popout) get().enterPopout(project.popout);
    // Entries that arrived before the project was known join the saved ones.
    set({ project, projectLoaded: true, ...(project ? { notes: addNotes(loadNotes(project.root), get().notes), comments: loadComments(project.root) } : {}) });
    if (!project) return;
    get().loadGitProject(project.root);
    if (get().popout) {
      // A pop-out reads the project's data but owns none of its tabs: nothing pruned, hidden or restored from here.
      const sp = scmPrefsOf(project.root);
      useApp.setState({ pins: loadPins(project.root), taskLinks: loadTaskLinks(project.root), scmCollapsed: sp.collapsed ?? [], scmView: sp.view ?? 'one', scmFolds: sp.folds ?? {}, ...(sp.repo && !get().scmRepo ? { scmRepo: sp.repo } : {}) });
      return;
    }
    const alive = get().terminals.map((x) => x.id);
    // Workspaces: read before anything is placed; on, the strip becomes the active workspace's.
    useApp.setState({ ws: loadWorkspaces(project.root) });
    cutView();
    // Pruned like on every list: also against the resumables, once known.
    useApp.setState({ pins: loadPins(project.root), shelf: loadShelf(project.root) });
    prunePinned();
    setHidden(prunePins(loadHidden(project.root), alive));
    useApp.setState({ taskLinks: loadTaskLinks(project.root) });
    const sp = scmPrefsOf(project.root);
    useApp.setState({ scmCollapsed: sp.collapsed ?? [], scmView: sp.view ?? 'one', scmFolds: sp.folds ?? {}, ...(sp.repo && !get().scmRepo ? { scmRepo: sp.repo } : {}) });
    pruneLinks();
    // The list came before the project: the tabs hidden last time leave now (the selection moves as when closing them).
    if (alive.length && get().hidden.length) get().setTerminals(get().terminals);
    restoreLayoutOnce();
    restoreTabsOnce();
  },
  setTerminals: (terminals) => {
    get().applyTerminals(terminals);
    // The Background tab follows its terminal: gone → closed; its item gone, or none chosen yet → the first row, pinned.
    // A live session listed without its work (a momentary list) proves nothing gone: the selection stays. An item that
    // ended with its session is recent: it stays too.
    const b = get().backgroundTab;
    if (b) {
      const t = terminals.find((x) => x.id === b.terminalId);
      if (!t) get().closeTab('background');
      else if (!(t.session && !t.work && b.itemId)) {
        const ids = [...(t.work?.entries ?? []).map((e) => e.id), ...(t.recent ?? []).map((r) => r.id), ...(t.work?.crons ?? []).map(cronRowId)];
        if (!b.itemId || !ids.includes(b.itemId)) {
          const first = firstItemId(t);
          if (first !== b.itemId) set({ backgroundTab: { ...b, itemId: first } });
        }
      }
    }
    // Feeds of terminals that are gone, and a popover whose terminal is gone or has no session, leave with them.
    const alive = new Set(terminals.map((x) => x.id));
    const feeds = get().bgFeeds;
    const keep = Object.keys(feeds).filter((k) => alive.has(k.slice(0, k.indexOf(':'))));
    if (keep.length !== Object.keys(feeds).length) set({ bgFeeds: Object.fromEntries(keep.map((k) => [k, feeds[k]!])) });
    const pop = get().bgPopover;
    if (pop && !terminals.some((x) => x.id === pop.terminalId && x.session)) set({ bgPopover: null });
    restoreLayoutOnce();
    terminalsListed = true;
    restoreTabsOnce();
  },
  applyTerminals: (terminals) => {
    // A starting session whose session arrived (or whose window passed) is no longer starting; a restarting one whose
    // Claude just quit is starting.
    const starting = pruneStarting(restartStarting(get().restarts, get().starting, terminals, Date.now()), terminals, Date.now());
    if (starting !== get().starting) set({ starting });
    // A restart question goes with its session.
    const ask = get().restartAsk;
    if (ask && !terminals.some((x) => x.id === ask.id && x.session)) set({ restartAsk: null });
    // The Session panel goes with its session (Claude exited, or the terminal closed).
    const panel = get().sessionPanel;
    if (panel && !terminals.some((x) => x.id === panel && x.session)) set({ sessionPanel: null });
    // Context usage: the sheet goes with its session too; a report stays only
    // while its terminal runs the session it was made of.
    const sheet = get().contextSheet;
    if (sheet && !terminals.some((x) => x.id === sheet && x.session)) set({ contextSheet: null });
    const reports = get().contextReports;
    const keep = Object.entries(reports).filter(([id, r]) => terminals.some((x) => x.id === id && x.session?.sessionId === r.sessionId));
    if (keep.length !== Object.keys(reports).length) set({ contextReports: Object.fromEntries(keep) });
    // A closed terminal's draft goes with it; one that was running before this window started may hold one unseen.
    pruneDrafts(new Set(terminals.map((x) => x.id)));
    // Ask: a closed terminal's Ask goes with it.
    const askThreads = pruneThreads(get().askThreads, terminals, get().askOpen);
    if (askThreads !== get().askThreads) set({ askThreads });
    const askPick = pruneThreads(get().askPick, terminals, get().askOpen);
    if (askPick !== get().askPick) set({ askPick });
    const askDrafts = pruneThreads(get().askDrafts, terminals, get().askOpen);
    if (askDrafts !== get().askDrafts) set({ askDrafts });
    // An answer left unseen before a restart marks its row again.
    get().loadAskThreads(terminals);
    const gone = Object.keys(get().askOpen).filter((id) => !terminals.some((x) => x.id === id));
    if (gone.length) {
      const askOpen = { ...get().askOpen };
      const askNotice = { ...get().askNotice };
      const askDock = { ...get().askDock };
      // Its Ask at timer goes with its panel.
      for (const id of gone) get().cancelAskAt(askOpen[id]!.sessionId);
      for (const id of gone) { delete askOpen[id]; delete askNotice[id]; delete askDock[id]; forgetEntrance(id); }
      set({ askOpen, askNotice, askDock });
    }
    adoptTerminals(terminals);
    const boot = get().popout;
    if (boot) {
      // A pop-out shows its one tab whatever the list: a terminal tab only while its terminal lives, another only while
      // it has something to show (a Background tab closed with its terminal stays closed).
      const k = boot.key as TabKey;
      const id = k.startsWith('t:') ? k.slice(2) : null;
      const alive = id !== null ? terminals.some((x) => x.id === id) : tabAlive(get(), k);
      const cur = get().tabOrder;
      const tabOrder = !alive ? (cur.length === 0 ? cur : []) : cur.length === 1 && cur[0] === k ? cur : [k];
      set({ terminals, tabOrder, ...(id ? { selectedId: alive ? id : null } : {}) });
      // Ask came along with the tab: it opens once the terminal is here with its session.
      get().takeAskWanted();
      return;
    }
    if (get().project) {
      prunePinned(terminals);
      setHidden(prunePins(get().hidden, terminals.map((x) => x.id)));
      pruneLinks(terminals);
      // A closed session can't be viewed any more: its entries would stay unread (and the bell count) forever.
      setNotes(pruneUnseen(get().notes, new Set(terminals.map((x) => x.id))));
      // Workspaces: a new terminal belongs to the active workspace; memberships are pruned like the pins.
      const w = get();
      if (wsOn(w)) {
        const ws = wsAssign(w.ws, terminals.map((x) => x.id), w.ws.active);
        if (ws !== w.ws) set({ ws });
      }
      pruneWs(terminals);
    }
    // Another space in front: its strip has no terminal and nothing switches; Sessions takes the
    // terminals that came or went when it comes back (switchSpace). The selection goes only with its terminal.
    if (get().space !== 'sessions') {
      const sel = get().selectedId;
      set({ terminals, ...(sel !== null && !terminals.some((x) => x.id === sel) ? { selectedId: null } : {}) });
      return;
    }
    const { selectedId, activeTab, tabOrder, pendingAnchor, hidden, split, poppedOut } = get();
    // Workspaces on: only the active workspace's terminals have tabs here; the others wait in theirs.
    const wsNow = get();
    const here = (id: string) => !wsOn(wsNow) || memberOf(wsNow.ws, id) === wsNow.ws.active;
    // Terminals whose tab is hidden have no tab (new ones still get one): for the tabs they are as good as gone. So are
    // those in a pop-out (never selected here either).
    const ids = [...terminals].sort((a, b) => a.createdAt - b.createdAt).map((t) => t.id).filter((id) => !hidden.includes(id) && !poppedOut.includes(`t:${id}`) && here(id));
    const active = keyOf(activeTab, selectedId);
    const anchor = pendingAnchor && tabOrder.includes(pendingAnchor) ? pendingAnchor : active;
    const order = syncTerminals(tabOrder, ids, anchor);
    if (pendingAnchor && selectedId && ids.includes(selectedId)) set({ pendingAnchor: null });
    const alive = new Set(ids);
    if (isSplit(split)) {
      // Split view: the panes take the new order — exited terminals leave their pane,
      // which shows its own previous tab; new ones join the focused pane. An exited active terminal leaves no active
      // key, so its pane's previous tab comes to the front there.
      const cur = keyOf(activeTab, selectedId);
      const selDead = selectedId !== null && !alive.has(selectedId);
      const keep = cur !== null && !(cur.startsWith('t:') && selDead) ? cur : null;
      hush(() => set({ terminals, tabOrder: order, ...(selDead ? { selectedId: null, pendingAnchor: null } : {}) }));
      applySplit(reconcile(get().split, order, keep, tabRecent));
      // Behind a file in front, the selection is the newest terminal no pane shows.
      const s2 = get();
      if (s2.activeTab !== 'term' && (s2.selectedId === null || !alive.has(s2.selectedId))) {
        const onScreen = new Set<TabKey>(visibleKeys(s2.split));
        set({ selectedId: [...s2.tabOrder].reverse().find((k) => k.startsWith('t:') && !onScreen.has(k))?.slice(2) ?? null });
      }
      return;
    }
    if (selectedId && !alive.has(selectedId)) {
      const lastTerm = [...order].reverse().find((k) => k.startsWith('t:'))?.slice(2) ?? null;
      if (activeTab === 'term') {
        // The active terminal is gone: switch to the neighboring tab, as when closing it.
        // Every terminal that exited in this list is closing, so the one used before it is a survivor.
        const next = afterClose(tabOrder, tabOrder.filter((k) => k === `t:${selectedId}` || (k.startsWith('t:') && !order.includes(k))), `t:${selectedId}`, tabRecent);
        const nextOk = next && order.includes(next) ? next : null;
        if (nextOk && !nextOk.startsWith('t:')) { set({ terminals, tabOrder: order, selectedId: lastTerm, activeTab: tabOf(nextOk) }); return; }
        set({ terminals, tabOrder: order, selectedId: nextOk ? nextOk.slice(2) : lastTerm });
        return;
      }
      set({ terminals, tabOrder: order, selectedId: lastTerm });
      return;
    }
    // First list (or no selection): show the most recent terminal (one pane; a split view returned above).
    set({ terminals, tabOrder: order, selectedId: selectedId ?? ids.at(-1) ?? null });
  },
  select: (selectedId) => {
    // Its tab lives in a pop-out (sidebar row, palette, a notification…): that window comes forward instead.
    if (selectedId !== null && popped(`t:${selectedId}`)) return;
    // A session from another space (⌘J, a notification, Send to…): Sessions comes to the front first.
    if (selectedId !== null) enter(`t:${selectedId}`);
    // A terminal of another workspace (sidebar, ⌘J, a notification, the palette, the Dock…): its workspace comes to the
    // front first, then it is selected there like any other.
    const w0 = get();
    if (selectedId !== null && wsOn(w0) && w0.terminals.some((x) => x.id === selectedId)) {
      const to = memberOf(w0.ws, selectedId);
      if (to !== w0.ws.active) w0.switchWorkspace(to);
    }
    const st = get();
    const key: TabKey | null = selectedId === null ? null : `t:${selectedId}`;
    const known = st.terminals.some((x) => x.id === selectedId);
    const missing = key !== null && !st.tabOrder.includes(key);
    // A terminal whose tab was closed (sidebar, palette, ⌘J, a notification…): its tab comes back next to the active one.
    if (selectedId !== null) setHidden(showId(st.hidden, selectedId));
    const reveal = key && missing && known ? { tabOrder: insertAfterActive(st.tabOrder, key, st.activeKey()) } : {};
    // Terminal just created (the reply arrives before the list): remember which tab to put it next to.
    const fresh = missing && !known;
    const claude = st.terminals.some((x) => x.id === selectedId && x.session);
    // The Session panel hangs from its own session's bar: another session in front closes it.
    const panel = st.sessionPanel && st.sessionPanel !== selectedId ? { sessionPanel: null } : {};
    // Likewise the Background popover: it belongs to the session whose chip opened it.
    const bgPop = st.bgPopover && st.bgPopover.terminalId !== selectedId ? { bgPopover: null } : {};
    set({ selectedId, activeTab: 'term', ...reveal, ...panel, ...bgPop, ...(fresh ? { pendingAnchor: st.activeKey() } : {}), ...(claude ? { lastSession: selectedId } : {}) });
    // Opening a finished session marks it as read.
    const term = get().terminals.find((x) => x.id === selectedId);
    // With the window in the foreground the check in App (seenNow) takes care of it: a single request.
    if (term?.session?.unread && typeof window !== 'undefined' && !document.hasFocus()) void window.atelier.terminals.markSeen(term.id).catch(() => {});
    // Its notification entries follow the same rule (in the foreground App's check reads them).
    if (selectedId && typeof document !== 'undefined' && !document.hasFocus()) get().notesSeen(selectedId);
  },
  opened: (info) => {
    const st = get();
    if (st.project && info.projectRoot !== st.project.root) return;
    // Select first: the tab then goes next to the active one (pendingAnchor), as when the list arrives first. A
    // terminal that already belongs to another workspace (Resume all going on after a switch) lands there and nothing
    // switches (only what the user asks for brings a workspace forward).
    const elsewhere = wsOn(st) && info.id in st.ws.members && memberOf(st.ws, info.id) !== st.ws.active;
    // Another space in front by now (the user left Sessions while it started): it lands in Sessions,
    // which takes it when it comes back, and nothing pulls them there.
    const away = st.space !== 'sessions' && !st.popout;
    if (!elsewhere && !away) st.select(info.id);
    const terminals = withTerminal(get().terminals, info);
    if (terminals === get().terminals) return;
    get().setTerminals(terminals);
    // Added here, ahead of main's list: checked against it a moment later (a terminal that exited meanwhile goes).
    if (typeof window !== 'undefined' && window.atelier) {
      healAfterOpen(info.id, { list: () => window.atelier.terminals.list(), current: () => get().terminals, apply: (l) => get().setTerminals(l), later: (fn, ms) => { setTimeout(fn, ms); } });
    }
  },
  launched: (info) => {
    // Marked before it is shown: its first render is already a session row, never a terminal one.
    if (!info.session) set({ starting: markStarting(get().starting, info.id, Date.now()) });
    get().opened(info);
    // Claude did not start in time: from then on it is a plain terminal.
    setTimeout(() => {
      const next = pruneStarting(get().starting, get().terminals, Date.now());
      if (next !== get().starting) set({ starting: next });
    }, STARTING_MS + 50);
  },
  setActivity: (activity, opts) => {
    // The activity bar picks the space: another space's activity brings that space forward first;
    // entered with no tab at all, it opens what it opens by default. Closing its last tab opens nothing.
    const to = spaceOfActivity(activity);
    if (to !== get().space && !get().popout) {
      get().switchSpace(to);
      if (to !== 'sessions' && get().tabOrder.length === 0) openEntry(to);
    }
    const st = get();
    // A hidden sidebar shows again, unless this is a jump to a session.
    const showing = !opts?.keepHidden && st.sidebarHidden;
    const sidebar = opts?.keepHidden ? {} : sidebarTo(false);
    // Files coming on screen, entered or shown again, shows the project file in front there.
    if (activity === 'files' && (st.activity !== 'files' || showing)) {
      const key = st.activeKey();
      const path = key?.startsWith('f:') ? key.slice(2) : null;
      const mine = !!path && !!st.project && (isBelow(st.project.root, path) || isBelow(st.project.realRoot, path));
      const shown = mine && opts?.reveal !== false ? path : null;
      // Always replaced: an older Reveal in Files must not come back when the tree mounts again.
      set({ activity, treeReveal: shown ? { path: shown, nonce: Date.now() + Math.random(), quiet: true } : null, ...sidebar });
      return;
    }
    set({ activity, ...sidebar });
  },
  setDaemon: (daemon) => { set({ daemon }); restoreTabsOnce(); },
  setSize: (cols, rows) => set({ size: { cols, rows } }),
  setUsage: (usage) => set({ usage }),
  openFile: (path, rel, line = null, mode, opts) => {
    // Open in a pop-out (tree, palette, ⌘-click on a path): that window comes forward, at the line asked for. From
    // a pop-out, another file opens in the project window.
    if (popped(`f:${path}`, line !== null ? { line, found: opts?.found } : undefined)) return;
    enter(`f:${path}`);
    const st = get();
    const files = st.openFiles;
    const nonce = Date.now() + Math.random();
    const exists = files.some((f) => f.path === path);
    // A preview tab with edits (even typed just now) is never replaced: it stays as a normal tab. Nor is one in a pane
    // that isn't focused (split view): it stays open there; the new preview opens in the focused one (placeOpened).
    const cur = st.preview && !isDirtyNow(st.preview, !!st.dirty[st.preview]) ? (`f:${st.preview}` as TabKey) : null;
    const placed = placeOpened(st.split, st.tabOrder, st.activeKey(), `f:${path}`, cur, !!opts?.preview && st.settings.previewTabs && !isUntitled(path));
    const gone = placed.replaced?.slice(2);
    // A search result's match goes with this open only: any other open of the file shows no result.
    const found = opts?.found;
    const large = opts?.large ? { large: true as const } : {};
    const entry = { path, rel, line, nonce, mode: mode ?? 'margin', found, ...large };
    // The preview it replaces leaves with its tab, unless another workspace shows that file.
    // With workspaces off nothing is shown elsewhere: as before.
    const goneHere = gone && !shownElsewhere(st, `f:${gone}`) ? gone : undefined;
    set({
      openFiles: exists
        ? files.filter((f) => !(wsOn(st) && f.path === goneHere)).map((f) => (f.path === path ? { ...f, line, nonce, mode: mode ?? f.mode, found, ...large } : f))
        : goneHere ? files.map((f) => (f.path === goneHere ? entry : f)) : [...files, entry],
      mdVisit: visit(st.mdVisit, path, !!found),
      tabOrder: placed.order,
      // Split view: the new preview takes the replaced one's place in its pane, in the same update.
      ...(placed.split !== st.split ? { split: placed.split } : {}),
      preview: placed.preview?.slice(2) ?? null,
      activeTab: path,
      ...(isUntitled(path) ? {} : { recentFiles: pushRecent(st.recentFiles, { path, rel }) })
    });
  },
  openSearchResult: (file, line, index, o) => {
    const [from, to] = line.ranges[index] ?? [0, 0];
    const at: FileOpening = { found: { line: line.line, from, to, spec: o.spec, keepFocus: o.keepFocus }, ...(file.size > MAX_FILE_BYTES ? { large: true } : {}) };
    if (o.side) get().openFileToSide(file.path, file.rel, line.line, at);
    else get().openFile(file.path, file.rel, line.line, undefined, { ...at, preview: true });
  },
  setFileMode: (path, mode) => set({ openFiles: get().openFiles.map((f) => (f.path === path ? { ...f, mode } : f)) }),
  setFileLarge: (path) => set({ openFiles: get().openFiles.map((f) => (f.path === path ? { ...f, large: true as const } : f)) }),
  // A checkbox's click still on its way shows over main's statuses (git/stage-intents.ts).
  setRepos: (repos) => get().seeRepos(repos),
  setAttributions: (attributions) => set({ attributions }),
  toggleChanges: () => {
    // Changes is Sessions': from another space it brings Sessions forward, shown — never hidden
    // by a toggle the user couldn't see.
    if (get().space !== 'sessions' && !get().popout) { enterSessions(); if (get().showChanges) return; }
    const v = !get().showChanges;
    writeShowChanges(v);
    set({ showChanges: v });
  },
  setChangesGroup: (changesGroup) => {
    set({ changesGroup });
    saveChangesPrefs({ compact: !get().changesExpanded, collapsed: get().changesCollapsed, grouping: changesGroup });
  },
  toggleChangesGroup: (key, all) => {
    const { changesCollapsed, changesExpanded, changesGroup } = get();
    const collapsed = all ? toggleAllGroups(changesCollapsed, all, key) : toggleGroup(changesCollapsed, key);
    set({ changesCollapsed: collapsed });
    saveChangesPrefs({ compact: !changesExpanded, collapsed, grouping: changesGroup });
  },
  togglePinned: (id) => setPins(togglePin(get().pins, id)),
  addToShelf: (path, rel, before = null) => {
    const st = get();
    if (!shelvable(path, st.project?.realRoot ?? null)) return;
    setShelf(placeInShelf(st.shelf, { path, rel }, before));
    // Open again (a gesture granted it): no longer missing.
    if (st.shelfUngranted.includes(path)) set({ shelfUngranted: st.shelfUngranted.filter((p) => p !== path) });
    if (st.shelfCollapsed) get().toggleShelfCollapsed();
  },
  removeFromShelf: (path) => setShelf(removeFromShelf(get().shelf, path)),
  nudgeShelf: (path, by) => setShelf(nudgeInShelf(get().shelf, path, by)),
  clearShelf: () => {
    const was = get().shelf;
    if (!was.length) return;
    setShelf([]);
    get().showToast(t.shelf.cleared, { label: t.shelf.undo, run: () => { if (!useApp.getState().shelf.length) setShelf(was); } });
  },
  toggleShelfCollapsed: () => {
    const shelfCollapsed = !get().shelfCollapsed;
    set({ shelfCollapsed });
    saveShelfCollapsed(shelfCollapsed);
  },
  toggleChangesExpanded: () => {
    const expanded = !get().changesExpanded;
    set({ changesExpanded: expanded });
    saveChangesPrefs({ compact: !expanded, collapsed: get().changesCollapsed, grouping: get().changesGroup });
  },
  setServices: (services, servicesStatus = 'ok') => set({ services, servicesStatus }),
  setPorts: (ports) => set({ ports }),
  setPrs: (prs) => set({ prs }),
  setServiceBuffer: (id, lines, seq, live = '') => set({
    serviceLines: { ...get().serviceLines, [id]: lines.slice(-MAX_SERVICE_LINES) },
    serviceSeq: { ...get().serviceSeq, [id]: seq },
    serviceLive: { ...get().serviceLive, [id]: live }
  }),
  appendServiceLines: (id, lines, reset, seq, live = '') => {
    const { serviceLines, serviceSeq, serviceLive } = get();
    if (reset) {
      set({ serviceLines: { ...serviceLines, [id]: lines.slice(-MAX_SERVICE_LINES) }, serviceSeq: { ...serviceSeq, [id]: seq }, serviceLive: { ...serviceLive, [id]: live } });
      return 'ok';
    }
    const cur = serviceLines[id];
    const curSeq = serviceSeq[id];
    if (!cur || curSeq === undefined) return 'ignored';
    if (curSeq + lines.length !== seq) return 'refetch';
    const next = lines.length ? cur.concat(lines) : cur;
    set({
      serviceLines: { ...serviceLines, [id]: next.length > MAX_SERVICE_LINES ? next.slice(-MAX_SERVICE_LINES) : next },
      serviceSeq: { ...serviceSeq, [id]: seq },
      serviceLive: { ...serviceLive, [id]: live }
    });
    return 'ok';
  },
  openServices: (maximize = null) => {
    if (popped('services')) return;
    enter('services');
    set({ servicesOpen: true, activeTab: 'services', maximized: maximize, tabOrder: insertAfterActive(get().tabOrder, 'services', get().activeKey()) });
  },
  setMaximized: (maximized) => set({ maximized }),
  setPastedAt: (pastedAt) => set({ pastedAt }),
  setUpdateReady: (updateReady) => set({ updateReady }),
  setDictation: (dictation) => set({ dictation }),
  setDictationStatus: (dictationStatus) => set({ dictationStatus }),
  setPanelWidth: (panel, width, persist) => {
    const panels = { ...get().panels, [panel]: clampPanel(panel, width) };
    set({ panels });
    if (persist) saveLayout(panels);
  },
  forgetRecent: (path) => set({ recentFiles: dropRecent(get().recentFiles, path) }),
  setClaudeTemp: (path, on) => {
    const cur = get().claudeTemp;
    if (!!cur[path] === on) return;
    const next = { ...cur };
    if (on) next[path] = true; else delete next[path];
    set({ claudeTemp: next });
  },
  setResumables: (resumables) => {
    // Dismiss All… asked over a section that emptied another way: the question goes with it.
    const root = get().project?.root;
    const empty = !root || !resumables.some((r) => r.projectRoot === root);
    set({ resumables, resumablesKnown: true, ...(empty && get().dismissAllAsk ? { dismissAllAsk: false } : {}) });
    pruneLinks();
    prunePinned();
  },
  setHistory: (history) => set({ history, historyLoaded: true }),
  paletteQuery: '',
  paletteAsk: 0,
  paletteSend: null,
  openSendPalette: (paletteSend) => { get().setPaletteOpen(true); set({ paletteSend }); },
  setPaletteOpen: (paletteOpen, query = '') => set({ paletteOpen, paletteQuery: query, paletteAsk: get().paletteAsk + 1, paletteSend: null, menu: null, ...(paletteOpen ? { settingsOpen: null, notesOpen: false, sessionPanel: null, bgPopover: null, schedulePopover: null, whatsNew: null } : {}) }),
  notes: [],
  notesOpen: false,
  notesFilter: 'all',
  setNotesOpen: (notesOpen, filter = 'all') => set({ notesOpen, ...(notesOpen ? { notesFilter: filter, menu: null, paletteOpen: false, settingsOpen: null, sessionPanel: null, bgPopover: null, whatsNew: null } : {}) }),
  setNotesFilter: (notesFilter) => set({ notesFilter }),
  addTriggerNote: (termId, rule, line) => {
    const st = get();
    const term = st.terminals.find((x) => x.id === termId);
    if (!term) return false;
    const viewing = viewingNow(st.selectedId, st.activeTab, typeof document !== 'undefined' && document.hasFocus(), st.settingsOpen !== null || st.paletteOpen);
    st.receiveNotes([triggerNote(term, rule, line, Date.now(), crypto.randomUUID(), viewing)], viewing);
    return true;
  },
  receiveNotes: (raw, viewing = null) => {
    const fresh = parseNotes(raw);
    // `quiet` is for this moment only: never kept with the entries.
    let list = addNotes(get().notes, fresh.map(({ quiet: _, ...e }) => e));
    if (viewing) list = markSessionSeen(list, viewing);
    setNotes(list);
    const st = get();
    // The project's main window chimes (a pop-out has no notification center of its own), unless the session is on
    // screen here, or main marked it quiet: someone is looking at it in a focused pop-out.
    const news = fresh.map((e) => (e.quiet ? { ...e, sessions: e.sessions.filter((x) => !e.quiet!.includes(x.id)) } : e));
    if (!st.popout && chimeFor(news, st.settings, onScreen(st, viewing))) playChime();
  },
  notesSeen: (sessionId) => {
    const st = get();
    const next = markSessionSeen(st.notes, sessionId);
    setNotes(next);
    // A pop-out never writes its copy over the main window's list (setNotes): what is looked at here is marked in
    // storage itself, read-modify-write, and storage-sync carries it to the main window. Nothing new to mark here: no
    // read, no write (storage-sync reloads this copy whenever the main window writes, so it holds what storage holds).
    if (st.popout && st.project && next !== st.notes) {
      const saved = loadNotes(st.project.root);
      const marked = markSessionSeen(saved, sessionId);
      if (marked !== saved) saveNotes(st.project.root, marked);
    }
  },
  dockerSeen: (containerId) => setNotes(markSessionSeen(get().notes, dockerSubject(containerId))),
  subjectSeen: (subject) => setNotes(markSessionSeen(get().notes, subject)),
  noteOpened: (id) => setNotes(markEntryRead(get().notes, id)),
  markAllNotesRead: () => {
    const notes = get().notes;
    if (get().notesFilter === 'all') { setNotes(markAllRead(notes)); return; }
    setNotes(notes.reduce((list, e) => (e.kind === 'trigger' ? markEntryRead(list, e.id) : list), notes));
  },
  clearNotes: () => setNotes(get().notesFilter === 'all' ? [] : get().notes.filter((e) => e.kind !== 'trigger')),
  groupByState: loadGroupByState(),
  toggleGroupByState: () => { const v = !get().groupByState; saveGroupByState(v); set({ groupByState: v }); },
  filesChanged: (paths) => {
    const open = new Set(get().openFiles.map((f) => f.path));
    const next = { ...get().diskNonce };
    let any = false;
    for (const p of paths) if (open.has(p) && !isUntitled(p)) { next[p] = (next[p] ?? 0) + 1; any = true; }
    if (any) set({ diskNonce: next });
    // A shelved file deleted or made again (from a terminal, while Atelier keeps the focus): the shelf looks again.
    if (touchesShelf(get().shelf, paths)) set({ shelfNonce: get().shelfNonce + 1 });
  },
  closeTab: (path) => {
    const st = get();
    const active = st.activeKey();
    const key: TabKey | null = path === undefined ? active : VIEW_WORDS.has(path) ? (path as TabKey) : path === 'term' ? keyOf('term', st.selectedId) : path.startsWith('t:') || selfKeyed(path) ? (path as TabKey) : `f:${path}`;
    // ⌘W on the empty focused pane of a split (the picker): that pane closes.
    if (!key) { if (path === undefined && isSplit(st.split) && st.split.panes[st.split.focus]!.tabs.length === 0) st.closePane(); return; }
    // A tab of another space (a view turned off, an automation removed, the Background tab's terminal gone): it closes
    // there — its saved view forgets it — and the space in front stays as it is. Terminal tabs
    // are only ever closed from their strip.
    if (spaceOf(key) !== st.space && !st.popout) {
      if (key.startsWith('t:')) return;
      if (key.startsWith('f:') && isDirtyNow(key.slice(2), !!st.dirty[key.slice(2)]) && !shownElsewhere(st, key)) { void st.closeTabs([key]); return; }
      dropTabs([key], true);
      return;
    }
    if (key.startsWith('t:')) {
      // Only the tab goes: the terminal keeps running in atelierd and stays in the sidebar (its X closes it for real).
      if (st.tabOrder.includes(key)) void st.closeTabs([key]);
      return;
    }
    if (!st.tabOrder.includes(key) && !VIEW_WORDS.has(key) && !st.openFiles.some((f) => `f:${f.path}` === key)) return;
    if (key.startsWith('f:') && isDirtyNow(key.slice(2), !!st.dirty[key.slice(2)]) && !shownElsewhere(st, key)) { void st.closeTabs([key]); return; }
    const next = afterClose(st.tabOrder, [key], active, tabRecent);
    const patch: Partial<AppState> = { tabOrder: st.tabOrder.filter((k) => k !== key) };
    if (key === 'services') { patch.servicesOpen = false; patch.maximized = null; } else if (key === 'review') patch.review = null; else if (key === 'history') patch.historyTab = null; else if (key === 'background') patch.backgroundTab = null; else if (key.startsWith('dk:')) patch.dockerTabs = st.dockerTabs.filter((r) => r.key !== key); else if (key.startsWith('rd:')) patch.redisTabs = st.redisTabs.filter((v) => redisKey(v) !== key); else if (key.startsWith('au:')) patch.autoTabs = st.autoTabs.filter((r) => r.key !== key); else if (shownElsewhere(st, key)) { /* another workspace still shows it: it stays open */ } else if (key.startsWith('rev:')) patch.revFiles = st.revFiles.filter((f) => f.key !== key); else if (key.startsWith('db:')) patch.dbTabs = st.dbTabs.filter((r) => r.key !== key); else patch.openFiles = st.openFiles.filter((f) => `f:${f.path}` !== key);
    if (st.preview && key === `f:${st.preview}`) patch.preview = null;
    if (st.dbPreview === key) patch.dbPreview = null;
    if (st.dockerPreview === key) patch.dockerPreview = null;
    if (st.autoPreview === key) patch.autoPreview = null;
    set(patch);
    if (active === key) leaveActive(next);
  },
  closeTabs: async (closing) => {
    let keys = closing;
    // Unsaved files: a single question for all of them. Cancel (or a failed save) closes nothing.
    // A file another workspace still shows stays open there with its edits: nothing to ask.
    const unsaved = keys.filter((k) => k.startsWith('f:') && isDirtyNow(k.slice(2), !!get().dirty[k.slice(2)]) && !shownElsewhere(get(), k)).map((k) => k.slice(2));
    let discarded: string[] = [];
    if (unsaved.length) {
      // Asked in the window: under the tab when it is that one file closing, else the sheet.
      const tab = closing.length === 1 && unsaved.length === 1 ? closing[0]! : null;
      const answer = await get().askUnsaved(unsaved, 'close', tab);
      if (answer === 'cancel') return;
      const keep = answer === 'discard' ? [] : answer.save.filter((p) => unsaved.includes(p));
      // Only what this very save writes counts: an older entry for the same untitled number is about another tab.
      for (const p of keep) if (isUntitled(p)) savedAs.delete(p);
      if (keep.length && !(await saveMany(keep))) return;
      // Untitled tabs saved through the sheet are real files now: those are the tabs to close.
      if (keep.length) {
        keys = keys.map((k) => {
          const p = k.slice(2);
          const real = k.startsWith('f:') && keep.includes(p) ? savedAs.get(p) : undefined;
          if (real) savedAs.delete(p);
          return real ? (`f:${real}` as TabKey) : k;
        });
      }
      discarded = unsaved.filter((p) => !keep.includes(p));
    }
    if (discarded.length) {
      const d = { ...get().dirty };
      for (const p of discarded) delete d[p];
      set({ dirty: d });
    }
    // Terminal tabs are only hidden: no confirmation, the terminals keep running and stay in the sidebar.
    dropTabs(keys, true);
  },
  showTerminal: () => { enterSessions(); set({ activeTab: 'term' }); },
  // Like the other overlays, these close What's new: one sheet at a time, keys to the one in front.
  setNewSessionOpen: (newSessionOpen, account) => set({ newSessionOpen, newSessionAccount: newSessionOpen ? account ?? null : null, ...(newSessionOpen ? { folderSheet: null, bgPopover: null, whatsNew: null } : {}) }),
  setFolderSheet: (folderSheet) => set({ folderSheet, ...(folderSheet ? { newSessionOpen: false, bgPopover: null, whatsNew: null } : {}) })
}));

// The draft follower (Session panel's guard) asks whether Claude shows a permission or question dialog in a terminal:
// an Enter there answers it and sends no draft.
setDialogProbe((id) => isWaiting(useApp.getState().terminals.find((x) => x.id === id)?.session));

// ---- Workspaces ----

/** Workspaces are on in this window (a pop-out never has them). */
function wsOn(s: AppState): s is AppState & { ws: WorkspacesState } {
  return !!s.ws?.on && !s.popout;
}

/** A tab key that still has something to show here: a terminal with a tab, an open file, a revision tab, a table tab. */
function liveKey(s: AppState, k: TabKey): boolean {
  if (k.startsWith('t:')) return s.terminals.some((x) => x.id === k.slice(2)) && !s.hidden.includes(k.slice(2)) && !s.poppedOut.includes(k);
  if (k.startsWith('f:')) return s.openFiles.some((f) => `f:${f.path}` === k) && !s.poppedOut.includes(k);
  if (k.startsWith('rev:')) return s.revFiles.some((f) => f.key === k);
  if (k.startsWith('db:')) return s.dbTabs.some((r) => r.key === k) && !s.poppedOut.includes(k);
  if (k.startsWith('dk:')) return s.dockerTabs.some((r) => r.key === k) && !s.poppedOut.includes(k);
  if (k.startsWith('rd:')) return s.redisTabs.some((v) => redisKey(v) === k) && !s.poppedOut.includes(k);
  if (k.startsWith('au:')) return s.autoTabs.some((r) => r.key === k);
  return false;
}

// ---- Spaces ----

/** activeTab of a space other than Sessions with nothing in front: never a terminal (selectedId stays Sessions'). */
export const NO_TAB = 'none';

/** A key a space's saved view may bring back: a live tab, or a Sessions view whose state is still there. */
function aliveKey(s: AppState, k: TabKey): boolean {
  return liveKey(s, k) || (VIEW_WORDS.has(k) && tabAlive(s, k));
}

/** The terminals with a tab in Sessions (oldest first): not hidden, not in a pop-out, of the active workspace. */
function sessionTerminalIds(s: AppState): string[] {
  return [...s.terminals].sort((a, b) => a.createdAt - b.createdAt).map((x) => x.id).filter((id) => !s.hidden.includes(id) && !s.poppedOut.includes(`t:${id}`) && inActiveWs(s, id));
}

/** Opening or activating `key` brings its space to the front first. */
function enter(key: TabKey): void {
  const st = useApp.getState();
  if (!st.popout && spaceOf(key) !== st.space) st.switchSpace(spaceOf(key));
}

/**
 * What a space opens when you enter it with no tab: Docker its Overview, Redis its Keys,
 * Automations this project's first automation (else every project's list, when there is any). Otherwise — Databases
 * always — its empty state: an overview read would connect the remembered pick on demand before the sidebar's connect
 * (the one that reads the catalog), which then finds it connected and reads nothing.
 */
function openEntry(space: SpaceId): void {
  const st = useApp.getState();
  if (space === 'docker') st.openDocker({ kind: 'overview' });
  else if (space === 'redis') st.openRedis('keys');
  else if (space === 'automations') {
    const all = st.automations.automations;
    const mine = all.find((v) => v.automation.project === st.project?.root);
    if (mine || all.length) st.openAutomations(mine?.automation.id ?? null);
  }
}

/** The sidebar shown or hidden, remembered for the next window; a pop-out has none: no change. */
function sidebarTo(hidden: boolean): Partial<AppState> {
  const st = useApp.getState();
  if (st.popout || st.sidebarHidden === hidden) return {};
  writeSidebarHidden(hidden);
  return { sidebarHidden: hidden };
}

/**
 * Hides the sidebar with what only it draws (a question or a rename in a row, Dismiss All, an edit in the tree, a
 * workspace's name, the branch switcher): none would wait out of sight. The keyboard, if it was in there, goes to the
 * work area.
 */
function hideSidebar(): void {
  const st = useApp.getState();
  const keys = keyboardInSidebar();
  useApp.setState({
    ...sidebarTo(true),
    ...(st.restartAsk?.at === 'row' ? { restartAsk: null } : {}),
    ...(st.renaming?.at === 'row' ? { renaming: null } : {}),
    dismissAllAsk: false, treeEdit: null, wsRenaming: null, scmSwitcherOpen: false
  });
  if (keys) keyboardToWork(st.activeKey());
}

/** Sessions to the front (a session, a workspace, Back to terminal). */
function enterSessions(): void {
  const st = useApp.getState();
  if (!st.popout && st.space !== 'sessions') st.switchSpace('sessions');
}

/**
 * A change to a space not in front (a file renamed while in Docker, a connection removed while in Sessions) is made to
 * its saved view (spaceViews), never by bringing it forward for a moment: every subscriber would see that moment.
 * Keys closed for good leave every saved view, each front passing to the tab used before it there.
 */
function forgetKeys(s: AppState, gone: (k: TabKey) => boolean): SpaceViews {
  return forgetInViews(s.spaceViews, gone, (id) => (id === s.space ? tabRecent : recentAway[id] ?? []));
}

/** Workspaces turned on (or off) in every project while another space was in front: Sessions takes it when it comes back. */
let wsEverywhereWaits = false;

/** A terminal (or a session to resume) belongs to the active workspace; always true while workspaces are off. */
function inActiveWs(s: AppState, id: string): boolean {
  return !wsOn(s) || memberOf(s.ws, id) === s.ws.active;
}

/** A workspace other than the active one shows this tab (a file stays open while one does). */
function shownElsewhere(s: AppState, k: TabKey): boolean {
  return wsOn(s) && s.ws.list.some((w) => w.id !== s.ws.active && w.order.includes(k));
}

/** The workspaces with the active one's live view written into its entry (what a switch leaves, and what is saved). */
function wsLive(s: AppState): WorkspacesState | null {
  // Another space in front: leaving Sessions wrote its workspace's entry, and the live fields are that space's.
  if (!wsOn(s) || s.space !== 'sessions') return s.ws;
  // Before the saved tabs are back (tabs.json), its files that aren't open yet are still its own: kept at the end.
  const saved = s.tabsRestored ? [] : (s.ws.list.find((w) => w.id === s.ws.active)?.order ?? []).filter((k) => (k.startsWith('f:') || k.startsWith('rev:') || k.startsWith('db:')) && !s.tabOrder.includes(k));
  return withView(s.ws, [...s.tabOrder, ...saved], s.activeKey(), serializeLayout(s.split));
}

/** What a row or tab shows as its title: a terminal's title, a file's name, a file at a commit's "name @ commit". */
function tabTitle(s: AppState, key: TabKey): string {
  if (key.startsWith('t:')) return s.terminals.find((x) => x.id === key.slice(2))?.title ?? key.slice(2);
  if (key.startsWith('f:')) {
    const path = key.slice(2);
    return (s.openFiles.find((f) => f.path === path)?.rel ?? path).split(/[\\/]/).at(-1) ?? path;
  }
  const rev = key.startsWith('rev:') ? s.revFiles.find((f) => f.key === key) : undefined;
  return rev ? revTitle(rev) : key;
}

/** Of the places `ids` (as `before` holds them), the file and other tabs no place of `after` holds any more: they close. */
function closingKeys(before: WorkspacesState, after: WorkspacesState, ids: string[]): TabKey[] {
  const held = new Set(after.list.flatMap((w) => w.order));
  const keys = before.list.filter((w) => ids.includes(w.id)).flatMap((w) => w.order).filter((k) => k.startsWith('f:') || k.startsWith('rev:') || k.startsWith('db:'));
  return [...new Set(keys)].filter((k) => !held.has(k));
}

/**
 * Unsaved files among `closing` are asked about first, as for any close: false when the answer is Cancel or a save
 * failed (nothing may close then). Nothing unsaved: true at once, so the close goes on in the same tick.
 */
function settleUnsaved(closing: TabKey[]): true | Promise<boolean> {
  const st = useApp.getState();
  const unsaved = closing.filter((k) => k.startsWith('f:') && isDirtyNow(k.slice(2), !!st.dirty[k.slice(2)])).map((k) => k.slice(2));
  if (!unsaved.length) return true;
  return (async () => {
    const answer = await st.askUnsaved(unsaved, 'close', null);
    if (answer === 'cancel') return false;
    const keep = answer === 'discard' ? [] : answer.save.filter((p) => unsaved.includes(p));
    if (keep.length && !(await saveMany(keep))) return false;
    const d = { ...useApp.getState().dirty };
    for (const p of unsaved) if (!keep.includes(p)) delete d[p];
    useApp.setState({ dirty: d });
    return true;
  })();
}

/**
 * Terminals about to stop: until atelierd drops them they belong to no place any more, so they would join the one in
 * front; they show there as closing, with no tab.
 */
function markStopping(ids: string[]): void {
  if (!ids.length) return;
  const st = useApp.getState();
  setHidden(hideIds(st.hidden, ids));
  useApp.setState({ closing: { ...useApp.getState().closing, ...Object.fromEntries(ids.map((x) => [x, true as const])) } });
}

/** Stops terminals resumable; refused, they keep running in the place in front (their rows say so again) and a notice says why. */
async function stopTerminals(ids: string[]): Promise<void> {
  if (!ids.length || typeof window === 'undefined') return;
  try {
    await window.atelier.terminals.stop(ids);
  } catch {
    const closing = { ...useApp.getState().closing };
    for (const x of ids) delete closing[x];
    useApp.setState({ closing });
    useApp.getState().showToast(t.ws.stopFailed);
  }
}

/** Closing tabs not in the strip any more leave the window: their files, files at a commit and tables. */
function closeGone(closing: TabKey[]): void {
  const st = useApp.getState();
  const gone = new Set(closing.filter((k) => !st.tabOrder.includes(k)));
  if (!gone.size) return;
  useApp.setState({
    openFiles: st.openFiles.filter((f) => !gone.has(`f:${f.path}`)), revFiles: st.revFiles.filter((f) => !gone.has(f.key)), dbTabs: st.dbTabs.filter((r) => !gone.has(r.key)),
    ...(st.preview && gone.has(`f:${st.preview}`) ? { preview: null } : {}), ...(st.dbPreview && gone.has(st.dbPreview) ? { dbPreview: null } : {})
  });
}

/** Tabs join the strip after its own tabs (before the project views); in a split, the focused pane's. */
function appendToStrip(keys: TabKey[]): void {
  if (!keys.length) return;
  const s = useApp.getState();
  if (isSplit(s.split)) {
    const to = s.split.focus;
    applySplit({ ...s.split, panes: s.split.panes.map((p, i) => (i === to ? { ...p, tabs: projectLast([...p.tabs, ...keys]) } : p)) });
  } else useApp.setState({ tabOrder: projectLast([...s.tabOrder, ...keys]) });
}

/**
 * activeTab and selectedId showing `front` (null: nothing in front); the selection stays on a terminal not in another
 * pane — `keep` when it still is one, else the last such terminal.
 */
function frontOf(front: TabKey | null, order: TabKey[], split: Split, keep: string | null = null): Pick<AppState, 'activeTab' | 'selectedId'> {
  if (front?.startsWith('t:')) return { activeTab: 'term', selectedId: front.slice(2) };
  const shown = new Set<TabKey>(isSplit(split) ? visibleKeys(split) : []);
  const free = (k: TabKey) => k.startsWith('t:') && !shown.has(k) && order.includes(k);
  const last = keep !== null && free(`t:${keep}`) ? keep : [...order].reverse().find(free)?.slice(2) ?? null;
  return front ? { activeTab: tabOf(front), selectedId: last } : { activeTab: 'term', selectedId: null };
}

/**
 * The active workspace's view cut out of whatever the strip holds (after loading, a restore, turning on again): every
 * live terminal and tab belongs somewhere first, then the strip keeps the active workspace's tabs and the project views.
 */
function cutView(saved = false) {
  const s = useApp.getState();
  if (!wsOn(s)) return;
  // Another space in front: Sessions' saved view is cut, the strip in front stays as it is.
  const away = s.space !== 'sessions' && !s.popout;
  const v = away ? s.spaceViews.sessions : null;
  const cur = v ? v.front : s.activeKey();
  const split = v ? v.layout !== null : isSplit(s.split);
  const ws = wsAbsorb(wsAssign(s.ws, s.terminals.map((x) => x.id), s.ws.active), v ? v.order : s.tabOrder);
  const view = viewOf(ws, ws.active, (k) => liveKey(s, k));
  const tabOrder = [...view.order, ...(v ? v.order : s.tabOrder).filter(isProjectKey)];
  // After a restore the workspace's saved front wins, as the saved tab in front does today (a restored split decides
  // itself); otherwise what is in front stays if it is still here.
  const front = saved && view.active && !split ? view.active : cur && tabOrder.includes(cur) ? cur : view.active ?? view.order.at(-1) ?? null;
  if (v) { useApp.setState({ ws, spaceViews: { ...s.spaceViews, sessions: { ...v, order: tabOrder, front } } }); return; }
  useApp.setState({ ws, tabOrder, ...(front === cur ? {} : frontOf(front, tabOrder, s.split)) });
}

/**
 * Tabs leave the strip (and their panes): closed (hide: their terminals' tabs are hidden) or moved to a pop-out (hide
 * false: nothing hidden). The active one gives the front to its neighbour; the selection stays on a terminal still here.
 * keepShared: a file another workspace still shows stays open (a close, a move to a workspace); a pop-out takes the
 * file's editor away from this window whatever the other workspaces show.
 */
function dropTabs(keys: TabKey[], hide: boolean, keepShared = hide) {
  const gone = new Set(keys);
  if (gone.size === 0) return;
  const cur = useApp.getState();
  const active = cur.activeKey();
  const next = afterClose(cur.tabOrder, keys, active, tabRecent);
  const terms = keys.filter((k) => k.startsWith('t:') && cur.tabOrder.includes(k)).map((k) => k.slice(2));
  const tabOrder = cur.tabOrder.filter((k) => !gone.has(k));
  useApp.setState({
    tabOrder,
    // A space not in front loses them from its saved view: its front goes to the one used before.
    ...(cur.popout ? {} : { spaceViews: forgetKeys(cur, (k) => gone.has(k)) }),
    // A file another workspace still shows stays open.
    openFiles: cur.openFiles.filter((f) => !gone.has(`f:${f.path}`) || (keepShared && shownElsewhere(cur, `f:${f.path}`))),
    ...(cur.preview && gone.has(`f:${cur.preview}`) ? { preview: null } : {}),
    ...(gone.has('services') ? { servicesOpen: false, maximized: null } : {}),
    ...(gone.has('review') ? { review: null } : {}),
    ...(gone.has('history') ? { historyTab: null } : {}),
    ...(gone.has('background') ? { backgroundTab: null } : {}),
    ...(cur.dockerTabs.some((r) => gone.has(r.key)) ? { dockerTabs: cur.dockerTabs.filter((r) => !gone.has(r.key)) } : {}),
    ...(cur.dockerPreview && gone.has(cur.dockerPreview) ? { dockerPreview: null } : {}),
    ...(cur.redisTabs.some((v) => gone.has(redisKey(v))) ? { redisTabs: cur.redisTabs.filter((v) => !gone.has(redisKey(v))) } : {}),
    ...(cur.autoTabs.some((r) => gone.has(r.key)) ? { autoTabs: cur.autoTabs.filter((r) => !gone.has(r.key)) } : {}),
    ...(cur.autoPreview && gone.has(cur.autoPreview) ? { autoPreview: null } : {}),
    ...(cur.revFiles.some((f) => gone.has(f.key)) ? { revFiles: cur.revFiles.filter((f) => !gone.has(f.key) || (keepShared && shownElsewhere(cur, f.key))) } : {}),
    // A table tab: as a file (another workspace showing it keeps it open there); its preview slot empties with it.
    ...(cur.dbPreview && gone.has(cur.dbPreview) ? { dbPreview: null } : {}),
    ...(cur.dbTabs.some((r) => gone.has(r.key)) ? { dbTabs: cur.dbTabs.filter((r) => !gone.has(r.key) || (keepShared && shownElsewhere(cur, r.key))) } : {})
  });
  if (hide && terms.length) setHidden(hideIds(cur.hidden, terms));
  // Behind another tab, the selection (the terminal shown when a terminal tab comes back to the front) stays on a tab
  // (in split view one that no other pane shows).
  const reselect = () => {
    const s = useApp.getState().split;
    const shown = new Set<TabKey>(isSplit(s) ? visibleKeys(s) : []);
    useApp.setState({ selectedId: [...tabOrder].reverse().find((k) => k.startsWith('t:') && !shown.has(k))?.slice(2) ?? null });
  };
  if (active && gone.has(active)) {
    leaveActive(next && !gone.has(next) ? next : null);
    // A terminal moved to a pop-out is not here at all (unlike a hidden one, which a later activate(null) clears): the
    // selection leaves it even when a file took the front.
    const sel = useApp.getState().selectedId;
    if (!hide && sel && terms.includes(sel)) reselect();
  } else if (cur.selectedId && terms.includes(cur.selectedId)) reselect();
}

/** A tab that isn't a terminal has something to show: Services always, the others while their state is there. */
function tabAlive(st: AppState, key: TabKey): boolean {
  return key === 'services' || payloadOf(st, key) !== undefined;
}

/**
 * A table opened on a key (Open ›, "N rows ›", Open Referenced Row): the key's filters handed to the tab —
 * its lazy view applies them before it reads (filter-actions applyHandoff: the first row picked, the inspector), never
 * through the filter bar, so a preview stays one.
 */
function handOver(key: TabKey, o: { filters?: readonly DbFilter[]; inspector?: boolean }): void {
  if (o.filters) useDb.getState().patchTab(key, { handoff: o });
}

/**
 * A tab asked for that this window doesn't show itself (true: handled, nothing to do here).
 * - Main window: a key that lives in a pop-out — its window comes forward (with what to reveal there).
 * - Pop-out: any key but its own (a link, the inspector, a revision, another session…) — shown in the project window,
 *   which comes forward (or in the pop-out holding it); a file through the opener (grants, the line); an untitled
 *   buffer exists nowhere else: nothing. The pop-out keeps its one tab, and what led there (a menu, a popover) closes.
 */
function popped(key: TabKey, reveal?: PopoutReveal): boolean {
  const st = useApp.getState();
  const api = typeof window !== 'undefined' ? window.atelier?.popout : undefined;
  if (st.popout) {
    if (key === st.popout.key) return false;
    if (st.menu !== null || st.bgPopover !== null) useApp.setState({ menu: null, bgPopover: null });
    if (key.startsWith('f:')) {
      const path = key.slice(2);
      if (api && !isUntitled(path)) void api.openInMain(path, reveal?.line).catch(() => {});
    } else if (api) void api.showInMain({ key, ...(reveal?.payload ? { payload: reveal.payload } : {}) }).catch(() => {});
    return true;
  }
  if (!st.poppedOut.includes(key)) return false;
  if (api) void (reveal ? api.focus(key, reveal) : api.focus(key)).catch(() => {});
  return true;
}

/**
 * A pop-out whose own tab is gone (a Background tab closed with its terminal) gives it back rather than stay an empty
 * bar: main closes the window, and the main window adds nothing for a dead tab. A terminal's window is main's to close
 * (atelierd's list); a key changing with its tab (Save As) is not a tab leaving.
 */
useApp.subscribe((s, prev) => {
  const key = s.popout?.key as TabKey | undefined;
  if (!key || key.startsWith('t:') || s.popout !== prev.popout || s.tabOrder === prev.tabOrder) return;
  if (!prev.tabOrder.includes(key) || s.tabOrder.includes(key)) return;
  if (typeof window !== 'undefined') void window.atelier?.popout?.dock({}).catch(() => {});
});

/** Activation history of the tabs (most recent last): a closed tab gives the front back to the one used before it. */
let tabRecent: TabKey[] = [];
/** The other spaces' histories while one is in front (switchSpace swaps them with tabRecent). */
let recentAway: Partial<Record<SpaceId, TabKey[]>> = {};
useApp.subscribe((s, prev) => {
  // Only open tabs: a closed one leaves the history (a file opened again starts afresh).
  if (s.tabOrder !== prev.tabOrder) tabRecent = tabRecent.filter((k) => s.tabOrder.includes(k));
  if (s.activeTab === prev.activeTab && s.selectedId === prev.selectedId) return;
  // The tab that was in front first: the very first one never went through a change.
  for (const k of [keyOf(prev.activeTab, prev.selectedId), keyOf(s.activeTab, s.selectedId)]) if (k && s.tabOrder.includes(k)) tabRecent = noteActive(tabRecent, k);
});

/** Untitled tabs saved in this window → their real path (a close waiting on "Save" must close the renamed tab). */
const savedAs = new Map<string, string>();
/** The Save as request whose file is being written right now. */
let writing: unknown = null;

/** The name a tab shows: "Untitled-1" for an untitled tab (never its internal key), the file name otherwise. */
export function tabName(files: OpenFile[], path: string): string {
  if (isUntitled(path)) return files.find((f) => f.path === path)?.rel ?? path;
  return path.split('/').at(-1) ?? path;
}

/** Resume all: how long the next one waits for the previous one's Claude to start. */
const BULK_START_MS = 20_000;

/**
 * Resolves once terminal `id` has a Claude session, has gone after showing up, had its Claude exit before starting (a
 * session closed before its first message has no conversation: `claude --resume` fails at once), a Stop came, or `ms`
 * passed.
 */
function startedOrGone(id: string, ms: number): Promise<void> {
  return new Promise((done) => {
    let seen = false;
    let ran = false;
    const check = (s: AppState) => {
      const term = s.terminals.find((x) => x.id === id);
      if (term) seen = true;
      const back = !!term && isShell(term.foreground);
      if (term && !back) ran = true;
      return !!term?.session || (seen && !term) || (ran && back) || !s.bulkResume || s.bulkResume.stopped;
    };
    if (check(useApp.getState())) { done(); return; }
    const timer = setTimeout(finish, ms);
    const unsub = useApp.subscribe((s) => { if (check(s)) finish(); });
    function finish() { clearTimeout(timer); unsub(); done(); }
  });
}

/** While > 0, panes don't follow the active tab: a pane command sets both at once (applySplit). */
let quiet = 0;
function hush(fn: () => void) {
  quiet++;
  try { fn(); } finally { quiet--; }
}

const sameKeys = (a: TabKey[], b: TabKey[]) => a.length === b.length && a.every((k, i) => k === b[i]);

/** Split view: `key`'s pane takes the focus with it in front, in one step (a docked tab arrives in front). */
function bringToFront(key: TabKey) {
  const s = useApp.getState().split;
  const at = isSplit(s) ? paneOf(s, key) : -1;
  if (at >= 0) applySplit({ ...s, panes: s.panes.map((p, i) => (i === at ? { ...p, front: key } : p)), focus: at });
}

/**
 * A tab moved on purpose — dragged in its strip, or between panes — is no preview any more: a file's, or a table's.
 */
function keepMoved(key: TabKey) {
  if (key.startsWith('f:')) useApp.getState().keepOpen(key.slice(2));
  else if (key.startsWith('db:')) useApp.getState().keepDbTab(key);
}

/**
 * The panes caught up with the order (a key added under `hush` — a docked tab, a hidden terminal — lands in the focused
 * pane) before a pane command works on them; one pane: the placeholder.
 */
function panesNow(): Split {
  const st = useApp.getState();
  if (!isSplit(st.split)) return st.split;
  const active = st.activeKey();
  return reconcile(st.split, st.tabOrder, active !== null && st.tabOrder.includes(active) ? active : null, tabRecent);
}

/**
 * Panes computed by a pane command, a close or a restore: the store's order becomes the panes' tabs (left to right),
 * the focused pane's front becomes the active tab — an empty pane means no selection — then the panes are set. A
 * one-pane result goes back to the `single()` placeholder (today's code path); the placeholder itself changes nothing.
 */
function applySplit(next: Split) {
  if (!isSplit(next) && next === useApp.getState().split) return;
  const order = flatten(next);
  const pane = next.panes[next.focus];
  const key = pane?.front ?? (isSplit(next) ? null : pane?.tabs[0] ?? null);
  hush(() => {
    if (!sameKeys(useApp.getState().tabOrder, order)) useApp.setState({ tabOrder: order });
    if (key) { if (useApp.getState().activeKey() !== key) useApp.getState().activate(key); }
    // An empty focused pane: no selection — in another space, nothing in front and the selection Sessions' still.
    else if (isSplit(next)) useApp.setState(useApp.getState().space !== 'sessions' ? { activeTab: NO_TAB } : { activeTab: 'term', selectedId: null });
    else useApp.getState().activate(null);
  });
  useApp.setState({ split: isSplit(next) ? next : single() });
}

/**
 * Open to the Side after the caller added `key` to the order (and, for a file, opened it) without the panes following:
 * placed from the panes as they were before; when nothing moves, the panes catch up as the subscription would.
 */
function sideOf(before: Split, active: TabKey | null, key: TabKey) {
  const st = useApp.getState();
  const next = toSide(before, st.tabOrder, active, key, tabRecent);
  if (next !== before) { applySplit(next); return; }
  if (isSplit(st.split)) applySplit(reconcile(st.split, st.tabOrder, st.activeKey(), tabRecent));
}

/**
 * Saved layout: once per window, when the project is known, the saved tabs are back
 * (tabs.json: its files are what the panes hold besides terminals) and atelierd has listed its terminals (an empty list
 * from before it answered doesn't count). The open tabs go to their saved panes (restoreLayout); terminals named there
 * whose tab was hidden get it back; nothing is started, resumed or reopened.
 */
function restoreLayoutOnce() {
  const st = useApp.getState();
  if (st.popout || st.layoutRestored || !st.project || !st.tabsRestored) return;
  if (st.terminals.length === 0 && !st.daemon.listed) return;
  // The saved layout is Sessions': another space came forward first, it waits for Sessions
  // (switchSpace asks again) — nothing is saved over it meanwhile.
  if (st.space !== 'sessions') return;
  useApp.setState({ layoutRestored: true });
  const root = st.project.root;
  const raw = loadSplitLayout(root);
  const mine = new Set(st.terminals.filter((x) => x.projectRoot === root).map((x) => `t:${x.id}`));
  const named = new Set(savedKeys(raw));
  const back = st.hidden.filter((id) => named.has(`t:${id}`) && mine.has(`t:${id}`));
  if (back.length) {
    setHidden(st.hidden.filter((id) => !back.includes(id)));
    st.applyTerminals(useApp.getState().terminals);
  }
  // A terminal living in a pop-out (or another project's) gets no pane here.
  const now = useApp.getState();
  const split = restoreLayout(raw, now.tabOrder.filter((k) => !k.startsWith('t:') || (mine.has(k) && !now.poppedOut.includes(k))));
  if (split) applySplit(split);
}

/**
 * The project's tabs from before a restart, once: when the project is known and atelierd has
 * sent its terminal list (main says so with `listed`; before it main answers an empty list, against which the saved
 * terminals would be lost). An empty list from atelierd counts: a project may have none. An incompatible atelierd never
 * lists: the files come back anyway.
 */
let terminalsListed = false;
let restoringTabs = false;
function restoreTabsOnce() {
  const st = useApp.getState();
  if (st.popout || st.tabsRestored || restoringTabs || !st.project || !terminalsListed) return;
  if (!st.daemon.listed && !st.daemon.incompatible) return;
  const api = typeof window !== 'undefined' ? window.atelier?.tabs : undefined;
  if (!api) return;
  restoringTabs = true;
  // The shelf's outside files come back only as main granted them again: those on it when
  // asking (one put there meanwhile came with a gesture), granted as shelf files or as tabs; none if the restore failed.
  const asked = st.shelf;
  const realRoot = st.project.realRoot;
  const settle = (granted: string[] | null) => {
    const gone = ungranted(asked, realRoot, granted);
    useApp.setState({ shelfUngranted: useApp.getState().shelf.filter((x) => gone.has(x.path)).map((x) => x.path) });
  };
  void api.restore()
    .then((r) => {
      settle(r ? [...(r.shelf ?? []), ...r.files].map((f) => f.path) : null);
      if (r) applyRestoredTabs(r);
    })
    .catch(() => settle(null))
    .finally(() => { restoringTabs = false; useApp.setState({ tabsRestored: true }); restoreLayoutOnce(); });
}

function applyRestoredTabs(saved: RestoredTabs) {
  const st = useApp.getState();
  // Tabs living in pop-outs stay there: not reopened here, never brought to the front.
  const away = new Set<string>(st.poppedOut);
  const r: RestoredTabs = { files: saved.files.filter((f) => !away.has(`f:${f.path}`)), order: saved.order.filter((k) => !away.has(k)), active: saved.active && !away.has(saved.active) ? saved.active : null };
  const open = new Set(st.openFiles.map((f) => f.path));
  const added = r.files.filter((f) => !open.has(f.path)).map((f) => ({ path: f.path, rel: f.rel, line: null, nonce: Date.now() + Math.random(), mode: 'margin' as FileMode }));
  // Table tabs come back kept, their kind from the catalog when it is there already — in the
  // Databases space. An older save kept the table in front as the window's: Databases' now.
  const shown = new Set<string>([...st.spaceView('databases').order, ...st.dbTabs.map((x) => x.key)]);
  const catalog = useDb.getState().snap.catalog;
  const tables = r.order.filter((k) => k.startsWith('db:') && !shown.has(k)).map((k) => dbRefOfKey(k, catalog)).filter((x): x is DbTabRef => x !== null);
  const dbFront = saved.dbActive ?? (r.active?.startsWith('db:') ? r.active : null);
  useApp.setState({ openFiles: [...st.openFiles, ...added], ...(tables.length ? { dbTabs: [...st.dbTabs, ...tables] } : {}) });
  // Each space's part goes to its strip when it is in front, to its saved view otherwise: nothing switches.
  if (tables.length) {
    const cur = useApp.getState();
    const here = cur.space === 'databases';
    const v = cur.spaceView('databases');
    const order = [...v.order, ...tables.map((x) => x.key)];
    const front = !v.front && dbFront && order.includes(dbFront as TabKey) ? (dbFront as TabKey) : null;
    if (here) useApp.setState({ tabOrder: order, ...(front ? { activeTab: front } : {}) });
    else useApp.setState({ spaceViews: { ...cur.spaceViews, databases: { ...v, order, front: front ?? v.front } } });
  }
  // Checked against main's first snapshot: now if it is in, otherwise as soon as it is.
  for (const x of tables) restoredTables.add(x.key);
  restoreSessionsPart(r, added.map((f) => `f:${f.path}` as TabKey));
  dropRestoredTables();
}

/** Sessions' part of a restore: the restored files join its strip first, so the saved order can place them; then the order is merged. */
function restoreSessionsPart(r: RestoredTabs, added: TabKey[]) {
  const cur = useApp.getState();
  const here = cur.space === 'sessions';
  const v = cur.spaceView('sessions');
  const order = mergeOrder([...v.order, ...added], r.order.filter((k) => !k.startsWith('db:')) as TabKey[], new Set(r.files.map((f) => f.path)));
  if (here) useApp.setState({ tabOrder: order });
  else useApp.setState({ spaceViews: { ...cur.spaceViews, sessions: { ...v, order } } });
  // Workspaces on: tabs.json held every workspace's tabs; the strip keeps the active one's, and its front.
  if (wsOn(useApp.getState())) { cutView(true); return; }
  // Split view restored: its panes decide what is shown.
  if (here ? isSplit(useApp.getState().split) : v.layout !== null) return;
  const alive = new Set(useApp.getState().terminals.map((x) => x.id));
  const active = restoredActive(r.active?.startsWith('db:') ? null : r.active, order, alive);
  if (!active) return;
  if (here) useApp.getState().activate(active);
  else useApp.setState({ spaceViews: { ...useApp.getState().spaceViews, sessions: { ...v, order, front: active } } });
}

/**
 * Table tabs a restore brought back: those whose connection is gone (removed, another project's)
 * are dropped, once main's first snapshot says which connections this window shows — never against the empty one
 * before it. Later snapshots close nothing (a tab whose connection goes says so instead).
 */
const restoredTables = new Set<TabKey>();
function dropRestoredTables() {
  const db = useDb.getState();
  if (!restoredTables.size || !db.loaded) return;
  const shown = new Set(db.snap.connections.map((v) => v.conn.id));
  const gone = new Set([...restoredTables].filter((k) => !shown.has(parseDbTabKey(k)?.connId ?? '')));
  restoredTables.clear();
  if (gone.size) useApp.getState().closeDbTabs((x) => gone.has(x.key));
}
useDb.subscribe((s, prev) => { if (s.loaded && !prev.loaded) dropRestoredTables(); });

// A table tab's own state (filters, sort, rows…) lives while its tab does in this window: closed, replaced as the
// preview, moved to a pop-out or another window, its state goes with it.
useApp.subscribe((s, prev) => {
  if (s.dbTabs === prev.dbTabs) return;
  const open = new Set(s.dbTabs.map((x) => x.key));
  for (const x of prev.dbTabs) if (!open.has(x.key)) useDb.getState().dropTab(x.key);
});

/** How long tab changes settle before they are saved. */
export const TABS_SAVE_MS = 500;
let tabsTimer: ReturnType<typeof setTimeout> | null = null;
function saveTabsNow() {
  if (tabsTimer) { clearTimeout(tabsTimer); tabsTimer = null; }
  const st = useApp.getState();
  const api = typeof window !== 'undefined' ? window.atelier?.tabs : undefined;
  if (!api || !st.project || !st.tabsRestored || st.popout) return;
  // Sessions' tabs, then the Databases space's tables, each space's tab in front — the same
  // whatever space is in front. Workspaces on: every workspace's tabs, so their files (and outside files' grants) come
  // back.
  const sessions = st.spaceView('sessions');
  const tables = st.spaceView('databases');
  const own = (wsOn(st) ? wsUnion(wsLive(st)!, sessions.order) : sessions.order).filter((k) => spaceOf(k) === 'sessions');
  const order = [...own, ...tables.order.filter((k) => k.startsWith('db:'))];
  void api.save(snapshotTabs(order, sessions.front, outsideOf(st.shelf, st.project.realRoot), tables.front)).catch(() => {});
}
useApp.subscribe((s, prev) => {
  if (!s.tabsRestored || (s.tabOrder === prev.tabOrder && s.activeTab === prev.activeTab && s.selectedId === prev.selectedId && s.tabsRestored === prev.tabsRestored && s.shelf === prev.shelf && s.ws === prev.ws && s.space === prev.space && s.spaceViews === prev.spaceViews)) return;
  if (tabsTimer) clearTimeout(tabsTimer);
  tabsTimer = setTimeout(saveTabsNow, TABS_SAVE_MS);
});

/** How long workspace changes settle before they are saved. */
export const WS_SAVE_MS = 400;
let wsTimer: ReturnType<typeof setTimeout> | null = null;
function saveWsNow() {
  if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
  const st = useApp.getState();
  if (!st.project || st.popout || !st.ws) return;
  saveWorkspaces(st.project.root, wsLive(st));
}
useApp.subscribe((s, prev) => {
  if (!s.ws || s.popout) return;
  if (s.ws === prev.ws && (!s.ws.on || (s.tabOrder === prev.tabOrder && s.activeTab === prev.activeTab && s.selectedId === prev.selectedId && s.split === prev.split))) return;
  if (wsTimer) clearTimeout(wsTimer);
  wsTimer = setTimeout(saveWsNow, WS_SAVE_MS);
});
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide', () => { if (wsTimer) saveWsNow(); });

// Workspaces on: the project views stay after the workspace's tabs, wherever they were opened. In
// a split, after each pane's own tabs, once the panes hold the order (reconciled).
useApp.subscribe((s, prev) => {
  if ((s.tabOrder === prev.tabOrder && s.split === prev.split) || !wsOn(s) || s.space !== 'sessions') return;
  if (isSplit(s.split)) {
    if (!sameKeys(flatten(s.split), s.tabOrder)) return;
    const panes = s.split.panes.map((p) => { const tabs = projectLast(p.tabs); return tabs === p.tabs ? p : { ...p, tabs }; });
    if (panes.some((p, i) => p !== s.split.panes[i])) applySplit({ ...s.split, panes });
    return;
  }
  const order = projectLast(s.tabOrder);
  if (order !== s.tabOrder) useApp.setState({ tabOrder: order });
});
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide', () => { if (tabsTimer) saveTabsNow(); });

/** How long split changes settle before the layout is saved (a divider drag is many changes). */
export const LAYOUT_SAVE_MS = 300;
let layoutTimer: ReturnType<typeof setTimeout> | null = null;
function saveLayoutNow() {
  if (layoutTimer) { clearTimeout(layoutTimer); layoutTimer = null; }
  const st = useApp.getState();
  // The saved layout is Sessions': another space in front saves Sessions' as it left it.
  const layout = st.space === 'sessions' ? serializeLayout(st.split) : st.spaceViews.sessions.layout;
  if (st.project && st.layoutRestored && !st.popout) saveSplitLayout(st.project.root, layout as SavedLayout | null);
}

// Every split change is saved (debounced) once the restore had its chance; a split made in Sessions before it cancels it
// (the user's panes win over the saved ones) — one made in another space has nothing to do with Sessions' layout.
useApp.subscribe((s, prev) => {
  if (s.split === prev.split) return;
  if (!s.layoutRestored) {
    if (!isSplit(s.split) || s.space !== 'sessions') return;
    useApp.setState({ layoutRestored: true });
  }
  if (layoutTimer) clearTimeout(layoutTimer);
  layoutTimer = setTimeout(saveLayoutNow, LAYOUT_SAVE_MS);
});
// Closing the window right after a change: saved now, not lost with the timer.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide', () => { if (layoutTimer) saveLayoutNow(); });

/**
 * The active tab is going away (closed, trashed, its terminal exited). One pane: `next`, today's neighbor rule. Split
 * view: the global `next` is ignored — the focused pane shows its own previous tab, or closes if emptied.
 */
function leaveActive(next: TabKey | null) {
  const st = useApp.getState();
  if (!isSplit(st.split)) { st.activate(next); return; }
  applySplit(reconcile(st.split, st.tabOrder, null, tabRecent));
}

// Split view: every way of changing the order or the active tab (sidebar, ⌘J, notifications, palette, ⌘1…9, new
// terminals, files, closes…) ends here: `reconcile` takes closed keys out of their pane (which shows its previous tab,
// or closes when emptied), puts new keys in the focused pane, and moves the focus to the pane holding the active key.
// An active key not in the order yet (a terminal just launched, before atelierd lists it) waits for the list.
useApp.subscribe((s, prev) => {
  if (quiet || !isSplit(s.split)) return;
  if (s.activeTab === prev.activeTab && s.selectedId === prev.selectedId && s.tabOrder === prev.tabOrder && s.split === prev.split) return;
  const active = keyOf(s.activeTab, s.selectedId);
  if (active !== null && !s.tabOrder.includes(active)) return;
  const next = reconcile(s.split, s.tabOrder, active, tabRecent);
  if (next !== s.split || !sameKeys(flatten(next), s.tabOrder) || (next.panes[next.focus]?.front ?? null) !== active) applySplit(next);
});

// A dragged tab that leaves the strip mid-drag (closed, its terminal exited) gets no dragend: the drag ends here, the
// drop layer never stays over the workspace. Panes that come or go mid-drag (a pane emptied by an exit) clear the drop
// target: it may name a pane that is gone or moved; the next pointer move computes it again.
useApp.subscribe((s, prev) => {
  if (s.tabDrag && !s.tabOrder.includes(s.tabDrag)) useApp.setState({ tabDrag: null, tabDragAt: null, tabDragTarget: null });
  else if (s.tabDrag && s.tabDragTarget && s.split.panes.length !== prev.split.panes.length) useApp.setState({ tabDragTarget: null });
});

// A question about something that went away: dropped.
useApp.subscribe((s) => {
  const patch = staleConfirms(s);
  if (patch) useApp.setState(patch);
});

// A search result's visit ends with its tab (closed, replaced as the preview tab, gone to a pop-out): back as a tab, the
// file shows its own view.
useApp.subscribe((s, prev) => {
  if (s.openFiles === prev.openFiles) return;
  for (const path in s.mdVisit) if (!s.openFiles.some((f) => f.path === path)) useApp.setState({ mdVisit: visit(useApp.getState().mdVisit, path, false) });
});

// A Save as sheet whose untitled tab went away (closed with "Don't Save", for example) has nothing left to save:
// it closes, so that a later Enter cannot write the text of an editor that no longer exists.
useApp.subscribe((s) => {
  const req = s.saveAs;
  if (!req || writing === req || s.openFiles.some((f) => f.path === req.path)) return;
  useApp.setState({ saveAs: null });
  req.done(false);
});

/**
 * The open Save as sheet's write (`write` gets the buffer): one at a time; once written — and while the sheet is still the
 * same — the tab becomes that file. An error or a cancel leaves the sheet as it was.
 */
async function writeSaveAs<R extends { path: string; rel?: string } | { error: string } | { canceled: true }>(write: (text: string) => Promise<R>): Promise<R | { error: string }> {
  const req = useApp.getState().saveAs;
  if (!req) return { error: 'cancelled' };
  if (writing === req) return { error: 'busy' };
  writing = req;
  let r: R;
  try { r = await write(req.text()); } finally { writing = null; }
  if (!('path' in r) || useApp.getState().saveAs !== req) return r;
  useApp.setState({ saveAs: null });
  adoptUntitled(req.path, r.path, r.rel);
  req.done(true);
  return r;
}

/**
 * An untitled tab saved as a real file: same position, new path, not dirty, among the recents; the tree re-reads. `rel`:
 * how main labels it (an outside file: from the home); else from the project root.
 */
function adoptUntitled(untitled: string, path: string, given?: string) {
  const st = useApp.getState();
  const root = st.project;
  const rel = given ?? (root && isBelow(root.realRoot, path) ? path.slice(root.realRoot.length + 1) : root && isBelow(root.root, path) ? path.slice(root.root.length + 1) : path);
  savedAs.set(untitled, path);
  const dirty = { ...st.dirty };
  delete dirty[untitled];
  const entry: OpenFile = { path, rel, line: null, nonce: Date.now() + Math.random(), mode: 'margin' };
  // A pop-out holding this buffer holds the file now: its key follows in the same update (its one tab never looks
  // gone), and main's registry follows too (Move Back, a reload, the project window's list).
  const rekey = st.popout?.key === `f:${untitled}`;
  // Its pane follows; that file's old tab (merged into this one) leaves its pane, which closes if emptied.
  const panes = renameKeys(removeKeys(st.split, (k) => k === `f:${path}`, tabRecent), (k) => (k === `f:${untitled}` ? (`f:${path}` as TabKey) : k));
  useApp.setState({
    ...(rekey ? { popout: { key: `f:${path}`, payload: { kind: 'file', rel, mode: 'margin' } } } : {}),
    openFiles: st.openFiles.filter((f) => f.path !== path).map((f) => (f.path === untitled ? entry : f)),
    tabOrder: st.tabOrder.filter((k) => k !== `f:${path}`).map((k) => (k === `f:${untitled}` ? (`f:${path}` as TabKey) : k)),
    activeTab: st.activeTab === untitled ? path : st.activeTab,
    split: isSplit(panes) ? panes : single(),
    // Saved while another space is in front: Sessions' saved view follows.
    spaceViews: renameInViews(forgetKeys(st, (k) => k === `f:${path}`), (k) => (k === `f:${untitled}` ? (`f:${path}` as TabKey) : k)),
    // Every workspace showing the untitled tab shows the file now.
    ...(st.ws ? { ws: wsRenameKeys(st.ws, (k) => (k === `f:${untitled}` ? (`f:${path}` as TabKey) : k)) } : {}),
    dirty,
    recentFiles: pushRecent(st.recentFiles, { path, rel }),
    treeNonce: st.treeNonce + 1
  });
  if (rekey) void window.atelier?.popout?.rekey(`f:${untitled}`, `f:${path}`).catch(() => {});
  // The language chosen while it was untitled stays, unless the new name already says it.
  const lang = st.langOverrides[untitled] ?? null;
  const moved = withOverride(st.langOverrides, untitled, null);
  setOverrides(lang && languageFor(path) !== lang ? withOverride(moved, path, lang) : moved);
  // So does the Markdown view.
  setMdViews(renameMdViews(useApp.getState().mdViews, untitled, path));
  setCsvOptionsMap(renameCsvOptions(useApp.getState().csvOptions, untitled, path));
}

/** New CSV parse options: state and storage, only when they changed. */
function setCsvOptionsMap(all: CsvOptionsMap) {
  if (all === useApp.getState().csvOptions) return;
  useApp.setState({ csvOptions: all });
  saveCsvOptions(all);
}

/**
 * A search result once shown (or given up on, its module not loading) leaves its tab: the tab stays at the line, but a
 * view made again (Diff and back) or a remount neither selects nor marks it again, and the keyboard is the editor's
 * again as usual. `found` is that very result (the same object), not an equal one.
 */
export function forgetFound(found: FoundTarget): void {
  const files = useApp.getState().openFiles;
  if (files.some((f) => f.found === found)) useApp.setState({ openFiles: files.map((f) => (f.found === found ? { ...f, found: undefined } : f)) });
}

/** The files on a search result's visit with `path` on it or off (the same object when nothing changes). */
function visit(all: Record<string, true>, path: string, on: boolean): Record<string, true> {
  if (!!all[path] === on) return all;
  const { [path]: _, ...rest } = all;
  return on ? { ...rest, [path]: true } : rest;
}

/** New Markdown views: state and storage, only when they changed. */
function setMdViews(all: MdViews) {
  if (all === useApp.getState().mdViews) return;
  useApp.setState({ mdViews: all });
  saveMdViews(all);
}

/** New language overrides: state and storage, only when they changed. */
function setOverrides(all: LangOverrides) {
  if (all === useApp.getState().langOverrides) return;
  useApp.setState({ langOverrides: all });
  saveOverrides(all);
}

/** New notification entries: state and storage, only when they changed. */
function setNotes(notes: NoteEntry[]) {
  const st = useApp.getState();
  if (notes === st.notes) return;
  useApp.setState({ notes });
  // The main window keeps the project's entries: a pop-out's copy is never written over them.
  if (st.project && !st.popout) saveNotes(st.project.root, notes);
}

/** New line comments: state and storage. */
function setComments(comments: LineComment[]) {
  const st = useApp.getState();
  useApp.setState({ comments });
  if (!st.project) return;
  const saved = saveComments(st.project.root, comments);
  // Storage full: said once (the drafts stay for this session), again only after a save worked in between.
  if (!saved && !commentsUnsaved) st.showToast(t.comments.notSaved);
  commentsUnsaved = !saved;
}
let commentsUnsaved = false;
/** This window holds comments storage refused (full): a reload from storage would drop them (storage-sync). */
export const hasUnsavedComments = (): boolean => commentsUnsaved;

/** How long a toast with an action stays (Toast closes it then). */
export const ACTION_TOAST_MS = 8000;
/** A plain toast held while an action toast is up. */
let waitingToast: { text: string; tone?: 'info' } | null = null;

/** New hidden terminal tabs: state and storage, only when they changed. */
function setHidden(hidden: string[]) {
  const st = useApp.getState();
  if (hidden.length === st.hidden.length && hidden.every((x, i) => x === st.hidden[i])) return;
  useApp.setState({ hidden });
  // Hidden tabs are the main window's: a pop-out never writes them.
  if (st.project && !st.popout) saveHidden(st.project.root, hidden);
}

/**
 * Sessions being resumed: atelierd's lists may arrive before its reply (the resumable gone, the new terminal running),
 * and their link and pin must still be there to move.
 */
const resuming = new Set<string>();

/**
 * Task links of terminals that are gone — neither running nor resumable — are dropped. Only once both lists are known:
 * a link pruned before the resumables arrived would be lost for a session resumed after an atelierd restart.
 */
function pruneLinks(terminals = useApp.getState().terminals) {
  const st = useApp.getState();
  // The main window prunes the project's links: a pop-out never writes them.
  if (st.popout || !st.project || !st.resumablesKnown || terminals.length === 0) return;
  setTaskLinks(pruneTaskLinks(st.taskLinks, [...terminals.map((x) => x.id), ...st.resumables.map((r) => r.id), ...resuming]));
}

/**
 * A project's saved Source Control preferences, with the view picked before the project was known (the sidebar can
 * show its switch first): that one wins and is saved now.
 */
function scmPrefsOf(root: string): ReturnType<typeof loadScmPrefs> {
  const asked = useApp.getState().scmViewAsked;
  if (!asked) return loadScmPrefs(root);
  saveScmPrefs(root, { view: asked });
  useApp.setState({ scmViewAsked: null });
  return { ...loadScmPrefs(root), view: asked };
}

/**
 * Pins of terminals that are gone — neither running, resumable nor being resumed — are dropped:
 * after an atelierd restart the pinned sessions wait in "To resume" with their pin. Only once both lists are known.
 */
function prunePinned(terminals = useApp.getState().terminals) {
  const st = useApp.getState();
  // Likewise the pins.
  if (st.popout || !st.project || !st.resumablesKnown || terminals.length === 0) return;
  setPins(prunePins(st.pins, [...terminals.map((x) => x.id), ...st.resumables.map((r) => r.id), ...resuming]));
}

/** Workspace memberships of terminals that are gone (neither running, resumable nor being resumed): the pins' rule. */
function pruneWs(terminals = useApp.getState().terminals) {
  const st = useApp.getState();
  if (st.popout || !st.project || !st.ws || !st.resumablesKnown || terminals.length === 0) return;
  const ws = wsPrune(st.ws, [...terminals.map((x) => x.id), ...st.resumables.map((r) => r.id), ...resuming]);
  if (ws !== st.ws) useApp.setState({ ws });
}

/** New task links: state and storage, only when they changed. */
function setTaskLinks(links: TaskLinks) {
  const st = useApp.getState();
  if (links === st.taskLinks) return;
  useApp.setState({ taskLinks: links });
  if (st.project) saveTaskLinks(st.project.root, links);
}

/** A new shelf: state and storage, only when it changed. */
function setShelf(shelf: ShelfItem[]) {
  const st = useApp.getState();
  if (shelf.length === st.shelf.length && shelf.every((x, i) => x.path === st.shelf[i]!.path && x.rel === st.shelf[i]!.rel)) return;
  useApp.setState({ shelf });
  if (st.project) saveShelf(st.project.root, shelf);
}

/** New pins: state and storage, only when they changed. */
function setPins(pins: string[]) {
  const st = useApp.getState();
  if (pins.length === st.pins.length && pins.every((x, i) => x === st.pins[i])) return;
  useApp.setState({ pins });
  if (st.project) savePins(st.project.root, pins);
}

/**
 * Keys that are their own activeTab value: a revision, a table, a Docker target, a Redis view, an automation. File
 * paths are absolute or `untitled:N`, never one of these.
 */
const SELF_KEYED = ['rev:', 'db:', 'dk:', 'rd:', 'au:'];
const selfKeyed = (k: string): boolean => SELF_KEYED.some((p) => k.startsWith(p));
const VIEW_WORDS = new Set(['services', 'review', 'history', 'background']);

function keyOf(activeTab: string, selectedId: string | null): TabKey | null {
  if (activeTab === 'term') return selectedId ? `t:${selectedId}` : null;
  if (activeTab === NO_TAB) return null;
  if (VIEW_WORDS.has(activeTab) || selfKeyed(activeTab)) return activeTab as TabKey;
  return `f:${activeTab}`;
}

/**
 * The activeTab value of a tab that is not a terminal (files: the path; real paths are absolute and untitled ones
 * `untitled:N`, never these words nor a self-keyed key).
 */
function tabOf(key: TabKey): string {
  return VIEW_WORDS.has(key) || selfKeyed(key) ? key : key.slice(2);
}

/**
 * A snapshot line's arrival time: the one the kept buffer has for the same text at the same absolute line number
 * (same `dropped` count, so the same numbering), else unknown. A Background tab shown again gets main's fresh snapshot of the whole tail:
 * a monitor's events keep the times they arrived at.
 */
function keptAt(prev: BgFeedState | undefined, dropped: number, i: number, text: string): number | null {
  // A follower that starts elsewhere in a big file counts `dropped` from its own start: only a snapshot whose
  // `dropped` equals the kept buffer's shares its absolute numbering. Otherwise blank, never a wrong time.
  if (!prev || prev.kind !== 'output' || prev.dropped !== dropped) return null;
  const line = prev.lines[i];
  return line && line.text === text ? line.at : null;
}

function insertAfterActive(order: TabKey[], key: TabKey, active: TabKey | null): TabKey[] {
  if (order.includes(key)) return order;
  const i = active ? order.indexOf(active) : -1;
  return i >= 0 ? [...order.slice(0, i + 1), key, ...order.slice(i + 1)] : [...order, key];
}
