import type { ThemeId } from './themes';
import type { WinMenu } from './windows-menu';
import type { AskMessage } from './asks';
import type { BackgroundFeed, LoopResult, WatchResult } from './background-feed';
import type { Resumable, ShellEnvState, TerminalInfo } from './protocol';
import type { UsageEntry } from './session';
import type { DirEntry, FileContent, ImageContent, OpenPathsEvent, Stamp, VideoContent } from './files';
import type { RestoredTabs, SavedTabs } from './tabs-state';
import type { RepoCompare, RepoStatus } from './git';
import type { GitApi, GitOpEvent, ScmMessageEvent } from './git-write';
import type { FetchOutcome, FetchReason, RepoSearch, ScmBlob, ScmCommitDetail, ScmEvent, ScmFetchAnswer, ScmFetchState, ScmLogPage, ScmRefs, ScmRepoEntry, ScmScope, ScmStash, ScmWorktree } from './scm';
import type { Attribution } from './attribution';
import type { ServicePane, ServicesStatus } from './services';
import type { DfSummary, DockerContainer, DockerDetail, DockerEventEntry, DockerNote, DockerSnapshot, StatsSample } from './docker';
import type { DockerLogLine } from './docker-logs';
import type { ClientRow, KeyEntry, Preview, RedisNote, RedisSnapshot, RedisStatus, RedisValueReply, RedisWatch, RedisWriteOp, SlowEntry, UndoResult, ValuePage, WriteResult } from './redis';
import type { MonitorLine } from './redis-monitor';
import type { JobInfo, JobState } from './redis-queues';
import type {
  DbConnectionForm, DbFilteredRef, DbFullRequest, DbFunctionRef, DbOverview, DbPage, DbPageRequest, DbPeek, DbPeekRequest, DbRefCount, DbRefsRequest,
  DbRelations, DbResult, DbServerInfo, DbSnapshot, DbStructure, DbTableRef
} from './databases';
import type { Settings } from './settings';
import type { DictationStatus } from './dictation';
import type { ProfileKey, ShellOption } from './profiles';
import type { ClaudeConversation } from './history';
import type { ClaudeConfig, McpAdded } from './claude-config';
import type { ContextProgress, ContextResult } from './context-usage';
import type { UpdateStatus } from './update-feed';
import type { PortsMap } from './ports';
import type { PrsState } from './pr';
import type { AdoptAnswer, AdoptRequest, DockEvent, DockRequest, EditorHandoff, MoveRequest, MoveResult, Point, PopoutBoot, PopoutOpenRequest, PopoutOpenResult, PopoutReveal, ProjectWindowInfo, ShowInMainRequest, TearStart } from './popout';
import type { Platform } from './platform';
import type { AddSourceResult, ConnectorId, ConnectorInfo, ConnectorNotice, FilterPick, NotionFields, SourcePick, TaskGetResult, TaskList, TaskSummary } from './tasks';
import type { Automation, AutomationPreview, AutomationStatus } from './automations';
import type { Run } from './automation-run';
import type { IfBusy, ScheduledPrompt } from './scheduled-prompts';
import type { ScheduleNotice } from './schedule-notices';
import type { Binding, CompanionEvent, CompanionModel, Thread } from './companion/types';
import type { SignalBookView } from './claude-signals';
import type { SearchEvent, SearchRequest } from './search';

/** One automation as the windows see it: its settings, its last runs, its state. */
export interface AutomationView { automation: Automation; runs: Run[]; status: AutomationStatus }
/** Every project's automations (the window's own first is the renderer's choice). */
export interface AutomationsState { automations: AutomationView[] }

/** What main tells a window as a toast. */
export type AppNotice = { kind: 'restart-failed' };

export type MenuCommand = 'new-session' | `new-session-account:${string}` | 'new-terminal' | `new-terminal-profile:${ProfileKey}` | 'reload-shell-env' | 'new-session-in-folder' | 'new-terminal-in-folder' | 'resume-session' | 'start-from-task' | 'new-file' | 'open-file' | 'install-shell-command' | 'uninstall-shell-command' | 'save' | 'save-all' | 'save-all-and-close' | 'close-tab' | 'move-tab-window' | 'move-tab-back' | 'show-terminal' | 'redraw-terminal' | 'view-sessions' | 'view-files' | 'find-in-files' | 'next-search-result' | 'prev-search-result' | 'view-services' | 'view-scm' | 'view-docker' | 'view-redis' | 'view-databases' | 'view-automations' | 'show-history' | 'show-background' | 'fetch' | 'fetch-all' | 'git-commit' | 'git-commit-all' | 'git-write-message' | 'git-undo-commit' | 'git-push' | 'git-pull' | 'git-sync' | 'git-sync-all' | 'git-new-branch' | 'git-switch-branch' | 'git-stash' |'toggle-changes' | 'toggle-sidebar' | 'swap-side-panels' | 'change-theme' | 'change-terminal-font' | 'open-palette' | 'open-settings' | 'open-about' | 'whats-new' | 'open-connectors' | `open-connector:${ConnectorId}` | 'next-attention' | 'toggle-group-by-state' | 'show-notifications' | 'session-panel' | 'ask-session' | 'restart-session' | 'context-usage' | 'schedule-prompt' | 'scheduled-prompts' | 'md-toggle-preview' | 'md-split' | 'md-outline' | 'toggle-word-wrap' | 'review-all' | 'review-session' | 'comment-selection' | 'next-change' | 'prev-change' | 'reveal-in-finder' | 'send-review' | 'next-tab' | 'prev-tab' | 'split-right' | 'focus-next-pane' | 'focus-prev-pane' | 'move-tab-left' | 'move-tab-right' | 'close-pane' | 'close-other-panes' | `tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}` | 'new-workspace' | 'toggle-workspaces' | 'next-workspace' | 'prev-workspace' | `workspace-${number}`;

/**
 * What a window tells main for the application menu (menu-spec's conditions it owns): an Undo on
 * offer, a repository in the project (the Git menu), Git actions on (its write items), messages with Claude on (✦).
 */
export interface MenuState {
  gitUndo: boolean; hasRepos: boolean; gitWrites: boolean; messages: boolean;
  /** Workspaces on in this window's project: their names in order and the active one's index. */
  workspaces?: { names: string[]; active: number };
  /** A project window (not the welcome window, not a pop-out): the workspaces toggle applies there. */
  project?: boolean;
  /** Views turned on in Settings (2026-11-02): main adds them from the settings, never from the window. */
  services?: boolean;
  automations?: boolean;
  /** Workspaces on in every project (Settings): the project's own toggle is set aside. From main too. */
  wsEverywhere?: boolean;
  /** Word wrap on: View › Word Wrap's check. From main's settings too. */
  wordWrap?: boolean;
}

/** A renderer error for the app log: messages and stacks only (clipped to RENDERER_ERROR_MAX). */
export interface RendererError { kind: 'error' | 'rejection' | 'boundary'; message: string; stack?: string; panel?: string }
export const RENDERER_ERROR_MAX = { message: 4000, stack: 16000, panel: 80 } as const;

export interface AppInfo { version: string; electron: string; chrome: string; node: string; packaged: boolean }
/** realRoot: the resolved root (links included), the form of tree and git paths. */
export interface ProjectInfo { root: string; name: string; realRoot: string; /** Set when this window is a tab pop-out. */ popout?: PopoutBoot }

/** A file checked for changes before a new Atelier terminal: builtin = one of zsh's startup files; label: ~ for home. */
export interface CheckedFile { path: string; label: string; builtin: boolean; exists: boolean }
/** Auto-reload of the shell environment, for the window opening the terminal (files: the changed ones). */
export type ShellEnvAuto = { phase: 'reloading'; files: string[] } | { phase: 'failed'; error: string };

/**
 * profilesAvailable: the running atelierd supports terminal profiles (an older one needs a restart first).
 * states2Available: it sends the richer session states and its Atelier profile emits command marks (v2.0).
 * backgroundAvailable: it sends the sessions' background work; without it the field is stripped.
 * shellEnv: its capture of the user's shell environment (null while unknown or with an atelierd older than it).
 */
/** version: of the app that started atelierd (not this app's); mismatch: it runs other code than this app would start. */
export interface DaemonState { connected: boolean; listed: boolean; version: string | null; mismatch: boolean; incompatible: boolean; profilesAvailable: boolean; states2Available: boolean; backgroundAvailable: boolean; aliasesAvailable: boolean; namesAvailable: boolean; shellEnv: ShellEnvState | null; /** Scheduled prompts (capability 'schedules'); absent from an older app's state. */ schedulesAvailable?: boolean; /** Closing a window stops its sessions (capability 'kill-resumable'). */ closeStopAvailable?: boolean; /** The Claude Code signals notebook (capability 'signals'). */ signalsAvailable?: boolean }

/**
 * A scheduled prompts request's answer: the prompt, or atelierd's refusal ('time taken',
 * 'time passed', 'unknown terminal', 'not a Claude session', 'unknown prompt', 'not editable', 'unavailable'…).
 */
export type ScheduleResult = { ok: true; prompt?: ScheduledPrompt } | { ok: false; error: string };

/**
 * Ask companion: one thread per Claude session, kept by main. ask and catchUp answer at once
 * with the run's id (or why none starts); what the run streams and the thread it lands in come on `on.companion`.
 * model and account (Settings › Ask's 'session' or an account id) stay the thread's for its later runs.
 */
export interface CompanionApi {
  thread(sessionId: string): Promise<Thread | null>;
  ask(o: { binding: Binding; text: string; model?: CompanionModel; account?: string }): Promise<{ runId: string } | { error: string }>;
  /** final: the session has ended (the catch-up adds what it left open). model and account: as for ask. */
  catchUp(o: { binding: Binding; final: boolean; model?: CompanionModel; account?: string }): Promise<{ runId: string } | { error: string }>;
  stop(sessionId: string): Promise<void>;
  /** Empties the thread and starts a new Ask conversation; its model and account are kept. */
  newThread(sessionId: string): Promise<Thread>;
  /** The thread's latest outcome was looked at: its unseen mark goes. */
  seen(sessionId: string): Promise<void>;
}

/** Install / Uninstall 'atelier' Command. */
export type ShellCommandResult = { ok: 'installed' | 'uninstalled' | 'already' } | { error: 'dev' | 'foreign' | 'not-installed' | 'cancelled' | 'failed'; detail?: string };

export const IPC = {
  project: 'project:get',
  openFolder: 'project:open-folder',
  newWindow: 'app:new-window',
  recentProjects: 'project:recent',
  openRecent: 'project:open-recent',
  forgetRecent: 'project:forget-recent',
  daemonState: 'daemon:state',
  termList: 'term:list',
  termCreate: 'term:create',
  termAttach: 'term:attach',
  termDetach: 'term:detach',
  termKill: 'term:kill',
  /** Close Workspace's Stop: these terminals stop, Claude sessions under Resume. */
  termStop: 'term:stop',
  termInput: 'term:input',
  termResize: 'term:resize',
  termRename: 'term:rename',
  termMarkSeen: 'term:mark-seen',
  termFolder: 'term:folder',
  termOpenFolder: 'term:open-folder',
  termCreateSession: 'term:create-session',
  usage: 'usage:get',
  filesList: 'files:list',
  filesRead: 'files:read',
  filesReadImage: 'files:read-image',
  filesReadLarge: 'files:read-large',
  filesOpenVideo: 'files:open-video',
  filesResolve: 'files:resolve',
  filesClaudeTempResolve: 'files:claude-temp-resolve',
  filesClaudeTempOpen: 'files:claude-temp-open',
  filesClaudeFolderReveal: 'files:claude-folder-reveal',
  filesOutsideResolve: 'files:outside-resolve',
  filesOutsideOpen: 'files:outside-open',
  filesIndex: 'files:index',
  filesSave: 'files:save',
  filesCreate: 'files:create',
  filesSaveAs: 'files:save-as',
  filesSaveAsOutside: 'files:save-as-outside',
  filesRename: 'files:rename',
  filesDuplicate: 'files:duplicate',
  filesTrash: 'files:trash',
  filesTrashInfo: 'files:trash-info',
  openUrl: 'links:open-url',
  clipboardWrite: 'clipboard:write',
  clipboardRead: 'clipboard:read',
  clipboardImage: 'clipboard:image',
  filesReveal: 'files:reveal',
  filesOpenDropped: 'files:open-dropped',
  filesOpenPicker: 'files:open-picker',
  filesOpenReady: 'files:open-ready',
  shellCommandInstall: 'shell-command:install',
  shellCommandUninstall: 'shell-command:uninstall',
  tabsSave: 'tabs:save',
  tabsRestore: 'tabs:restore',
  gitStatus: 'git:status',
  gitHead: 'git:head',
  gitBase: 'git:base',
  gitCompare: 'git:compare',
  attributions: 'attributions:get',
  attributionsResolve: 'attributions:resolve',
  attributionsUndo: 'attributions:undo',
  servicesList: 'services:list',
  servicesLines: 'services:lines',
  servicesWatch: 'services:watch',
  dockerSnapshot: 'docker:snapshot',
  dockerLogs: 'docker:logs',
  dockerWatchLogs: 'docker:watch-logs',
  dockerWatchStats: 'docker:watch-stats',
  dockerStats: 'docker:stats',
  dockerInspect: 'docker:inspect',
  dockerDf: 'docker:df',
  dockerEvents: 'docker:events',
  dockerTail: 'docker:tail',
  redisSnapshot: 'redis:snapshot',
  redisStatus: 'redis:status',
  redisWatch: 'redis:watch',
  redisPick: 'redis:pick',
  redisAuth: 'redis:auth',
  redisForget: 'redis:forget',
  redisSeen: 'redis:seen',
  redisScan: 'redis:scan',
  redisValue: 'redis:value',
  redisCounter: 'redis:counter',
  redisClients: 'redis:clients',
  redisSlowlog: 'redis:slowlog',
  redisJobs: 'redis:jobs',
  redisJob: 'redis:job',
  redisPreview: 'redis:preview',
  redisWrite: 'redis:write',
  redisUndo: 'redis:undo',
  dbSnapshot: 'db:snapshot',
  dbSelect: 'db:select',
  dbConnect: 'db:connect',
  dbDisconnect: 'db:disconnect',
  dbPassword: 'db:password',
  dbTest: 'db:test',
  dbSave: 'db:save',
  dbDuplicate: 'db:duplicate',
  dbRemove: 'db:remove',
  dbSetMask: 'db:set-mask',
  dbNoteWrite: 'db:note-write',
  dbSetSchema: 'db:set-schema',
  dbRefresh: 'db:refresh',
  dbPage: 'db:page',
  dbEstimate: 'db:estimate',
  dbCount: 'db:count',
  dbPeek: 'db:peek',
  dbRefs: 'db:refs',
  dbFull: 'db:full',
  dbStructure: 'db:structure',
  dbRelations: 'db:relations',
  dbDdl: 'db:ddl',
  dbOverview: 'db:overview',
  dbReadOnlySql: 'db:read-only-sql',
  resumables: 'resumables:get',
  schedules: 'schedules:get',
  scheduleAdd: 'schedules:add',
  scheduleUpdate: 'schedules:update',
  scheduleRemove: 'schedules:remove',
  scheduleRestore: 'schedules:restore',
  scheduleFire: 'schedules:fire',
  scheduleSnooze: 'schedules:snooze',
  claudeSignals: 'claude-signals:get',
  claudeSignalsClear: 'claude-signals:clear',
  termResume: 'term:resume',
  claudeHistory: 'claude:history',
  claudeResume: 'claude:resume',
  claudeConfig: 'claude:config',
  claudeRestartCommand: 'claude:restart-command',
  claudeMcpAdded: 'claude:mcp-added',
  claudeContext: 'claude:context',
  claudeContextLive: 'claude:context-live',
  claudeContextOpen: 'claude:context-open',
  claudeDirs: 'claude:dirs',
  claudePickDir: 'claude:pick-dir',
  claudeLaunchPreview: 'claude:launch-preview',
  termDismiss: 'term:dismiss',
  termClose: 'term:close',
  daemonRestart: 'daemon:restart',
  daemonReloadEnv: 'daemon:reload-env',
  shellEnvFiles: 'shell-env:files',
  shellEnvPickFiles: 'shell-env:pick-files',
  termShells: 'term:shells',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsReset: 'settings:reset',
  appInfo: 'app:info',
  openLogs: 'app:open-logs',
  notifyTest: 'notify:test',
  notifySettings: 'notify:open-settings',
  logError: 'app:log-error',
  menuState: 'app:menu-state',
  unsavedState: 'app:unsaved-state',
  menuModel: 'app:menu-model',
  menuInvoke: 'app:menu-invoke',
  testFault: 'app:test-fault',
  revealProject: 'project:reveal',
  dictationStatus: 'dictation:status',
  dictationDownload: 'dictation:download',
  dictationCancel: 'dictation:cancel-download',
  dictationRemove: 'dictation:remove-model',
  dictationRestart: 'dictation:restart-engine',
  dictationMic: 'dictation:request-mic',
  dictationPrivacy: 'dictation:open-privacy',
  dictationTranscribe: 'dictation:transcribe',
  dictationTestAudio: 'dictation:test-audio',
  openLicenses: 'app:open-licenses',
  updateState: 'app:update-state',
  updateApply: 'app:update-apply',
  updateStatus: 'app:update-status',
  updateCheck: 'app:update-check',
  updateWhatsNew: 'app:update-whats-new',
  updateOpenRelease: 'app:update-open-release',
  updateOpenApplications: 'app:update-open-applications',
  updateOpenStore: 'app:update-open-store',
  triggerNotify: 'trigger:notify',
  portsList: 'ports:list',
  portsOpen: 'ports:open',
  prsList: 'prs:list',
  prOpen: 'pr:open',
  connectorsList: 'connectors:list',
  connectorsConnect: 'connectors:connect',
  connectorsCancel: 'connectors:cancel',
  connectorsDisconnect: 'connectors:disconnect',
  connectorsRefresh: 'connectors:refresh',
  connectorsSetOptions: 'connectors:setOptions',
  connectorsReopenAuth: 'connectors:reopenAuth',
  connectorsOpenTask: 'connectors:openTask',
  connectorsSearchSources: 'connectors:searchSources',
  connectorsAddSource: 'connectors:addSource',
  connectorsRemoveSource: 'connectors:removeSource',
  connectorsSetSourceFields: 'connectors:setSourceFields',
  connectorsLoadSourceColumns: 'connectors:loadSourceColumns',
  connectorsSetSourceScope: 'connectors:setSourceScope',
  connectorsListFilters: 'connectors:listFilters',
  connectorsSetFilter: 'connectors:setFilter',
  connectorsConnectToken: 'connectors:connectToken',
  automationsList: 'automations:list',
  automationsSave: 'automations:save',
  automationsRemove: 'automations:remove',
  automationsTurnOn: 'automations:turnOn',
  automationsTurnOff: 'automations:turnOff',
  automationsCheckNow: 'automations:checkNow',
  automationsPreview: 'automations:preview',
  automationsStartRun: 'automations:startRun',
  automationsSkipRun: 'automations:skipRun',
  automationsStopRun: 'automations:stopRun',
  automationsCloseRun: 'automations:closeRun',
  automationsCatchUp: 'automations:catchUp',
  automationsSetPaused: 'automations:setPaused',
  automationsScopes: 'automations:scopes',
  automationsSourceMcp: 'automations:sourceMcp',
  tasksList: 'tasks:list',
  tasksGet: 'tasks:get',
  tasksSearch: 'tasks:search',
  scmRepos: 'scm:repos',
  scmSearch: 'scm:search',
  scmRefs: 'scm:refs',
  scmLog: 'scm:log',
  scmLocate: 'scm:locate',
  scmResolve: 'scm:resolve',
  scmCommit: 'scm:commit',
  scmFile: 'scm:file',
  scmAheadBehind: 'scm:ahead-behind',
  scmWorktrees: 'scm:worktrees',
  scmStashes: 'scm:stashes',
  scmStatus: 'scm:status',
  scmFetch: 'scm:fetch',
  scmFetchAll: 'scm:fetch-all',
  scmFetchStates: 'scm:fetch-states',
  /*
   * Git writes. The preload sends one object per call, exactly these keys (`?`: present only
   * when set), for main's strict schemas. root: a listed working tree; rels: paths relative to it, or 'all'.
   *   git:stage, git:unstage, git:discard  { root, rels: string[] | 'all' }
   *   git:commit                          { root, message, amend: boolean, coAuthor: boolean, noVerify: boolean }
   *   git:undo-commit                     { root, oid }
   *   git:push                            { root, publish?: { remote }, lease?: { oid } }
   *   git:pull                            { root, rebase: boolean, stash?: true }
   *   git:sync                            { root, rebase: boolean }
   *   git:sync-all, git:running           (no argument)
   *   git:switch                          { root, ref, carry: 'none' | 'stash' | 'bring' }
   *   git:check-branch-name               { root, name }
   *   git:branch-create                   { root, name, from?: string, switch: boolean }
   *   git:branch-rename                   { root, ref, name }
   *   git:branch-delete                   { root, ref, force: boolean }
   *   git:branch-restore                  { root, name, oid }
   *   git:worktree-check                  { root, path }
   *   git:worktree-add                    { root, path, ref?: string, newName?: string }
   *   git:stash-push                      { root, message, untracked: boolean, staged: boolean }
   *   git:stash-apply                     { root, index: number, oid, pop: boolean }
   *   git:stash-drop                      { root, index: number, oid }
   *   git:stash-restore                   { root, oid, message }
   *   git:cancel                          { id }
   *   git:facts                           { root, view? }
   *   git:incoming                        { root }
   *   git:remote-commits                  { root, n: number }
   *   scm:message                         { root, tweak?: { kind: 'shorter' | 'detail' | 'subject', current } }
   *   scm:message-cancel                  { id }
   * Events: ev:git-op (GitOpEvent), ev:scm-message (ScmMessageEvent).
   */
  gitStage: 'git:stage',
  gitUnstage: 'git:unstage',
  gitCommit: 'git:commit',
  gitUndoCommit: 'git:undo-commit',
  gitPush: 'git:push',
  gitPull: 'git:pull',
  gitSync: 'git:sync',
  gitSyncAll: 'git:sync-all',
  gitSwitch: 'git:switch',
  gitCheckBranchName: 'git:check-branch-name',
  gitBranchCreate: 'git:branch-create',
  gitBranchRename: 'git:branch-rename',
  gitBranchDelete: 'git:branch-delete',
  gitBranchRestore: 'git:branch-restore',
  gitWorktreeCheck: 'git:worktree-check',
  gitWorktreeAdd: 'git:worktree-add',
  gitStashPush: 'git:stash-push',
  gitStashApply: 'git:stash-apply',
  gitStashDrop: 'git:stash-drop',
  gitStashRestore: 'git:stash-restore',
  gitDiscard: 'git:discard',
  gitCancel: 'git:cancel',
  gitFacts: 'git:facts',
  gitIncoming: 'git:incoming',
  gitRemoteCommits: 'git:remote-commits',
  gitRunning: 'git:running',
  scmMessage: 'scm:message',
  scmMessageCancel: 'scm:message-cancel',
  /**
   * Ask companion: a trusted app page of a project window (pop-outs included), strict
   * schemas; a binding's terminal must be the sender's project's, its cwd inside that project, its session the
   * terminal's or one with a transcript there. Main takes the config dir from the terminal, a configured account's only
   * (the binding's is ignored).
   * Threads are app-wide: ev:companion (CompanionEvent) goes to every window.
   *   companion:thread, companion:stop, companion:new, companion:seen   { sessionId }
   *   companion:ask        { binding, text, model?, account? }
   *   companion:catch-up   { binding, final }
   */
  companionThread: 'companion:thread',
  companionAsk: 'companion:ask',
  companionCatchUp: 'companion:catch-up',
  companionStop: 'companion:stop',
  companionNew: 'companion:new',
  companionSeen: 'companion:seen',
  backgroundWatch: 'background:watch',
  backgroundUnwatch: 'background:unwatch',
  backgroundLoop: 'background:loop',
  /**
   * Find in Files: a trusted app page of a project window (pop-outs included), strict schemas. One search at a time
   * per window; its events (SearchEvent) go back to that window only, on ev:search, a `stale` among them once files
   * change after its search.
   *   search:start   SearchRequest
   *   search:stop    searchId
   */
  searchStart: 'search:start',
  searchStop: 'search:stop',
  // main → renderer events
  evTerminals: 'ev:terminals',
  evBackgroundFeed: 'ev:background-feed',
  evSnapshot: 'ev:snapshot',
  evData: 'ev:data',
  evExit: 'ev:exit',
  evDaemon: 'ev:daemon',
  evUsage: 'ev:usage',
  evCommand: 'ev:command',
  evMenuModel: 'ev:menu-model',
  evGit: 'ev:git',
  evFsChanged: 'ev:fs-changed',
  evOpenPaths: 'ev:open-paths',
  evAttributions: 'ev:attributions',
  evServices: 'ev:services',
  evServiceLines: 'ev:service-lines',
  evDocker: 'ev:docker',
  evDockerLogs: 'ev:dockerLogs',
  evDockerStats: 'ev:dockerStats',
  evDockerEvent: 'ev:dockerEvent',
  evDockerNote: 'ev:dockerNote',
  evDockerOpen: 'ev:dockerOpen',
  evRedis: 'ev:redis',
  evRedisStatus: 'ev:redisStatus',
  evRedisMonitor: 'ev:redisMonitor',
  evRedisNote: 'ev:redisNote',
  evRedisOpen: 'ev:redisOpen',
  evDatabases: 'ev:databases',
  evResumables: 'ev:resumables',
  evSchedules: 'ev:schedules',
  evScheduleNotice: 'ev:schedule-notice',
  evClaudeSignals: 'ev:claude-signals',
  evSelect: 'ev:select',
  evSettings: 'ev:settings',
  evUpdate: 'ev:update',
  evUpdateStatus: 'ev:update-status',
  evDictation: 'ev:dictation',
  evNotes: 'ev:notes',
  evPorts: 'ev:ports',
  evPrs: 'ev:prs',
  evConnectors: 'ev:connectors',
  evAutomations: 'ev:automations',
  evConnectorNotice: 'ev:connector-notice',
  evShellEnvAuto: 'ev:shell-env-auto',
  evMcpAdded: 'ev:mcp-added',
  evContextProgress: 'ev:context-progress',
  // In-app confirms: main asks a page, the page says it listens and answers.
  evAsk: 'ev:ask',
  evAskWithdrawn: 'ev:ask-withdrawn',
  askReady: 'ask:ready',
  askAnswer: 'ask:answer',
  askShown: 'ask:shown',
  evAppNotice: 'ev:app-notice',
  evScm: 'ev:scm',
  evScmFetch: 'ev:scm-fetch',
  evGitOp: 'ev:git-op',
  evScmMessage: 'ev:scm-message',
  evCompanion: 'ev:companion',
  evSearch: 'ev:search',
  // Tab pop-out windows.
  popoutOpen: 'popout:open',
  popoutTearStart: 'popout:tear-start',
  popoutTearEnd: 'popout:tear-end',
  popoutDock: 'popout:dock',
  popoutFocus: 'popout:focus',
  popoutRecall: 'popout:recall',
  popoutForward: 'popout:forward',
  popoutList: 'popout:list',
  popoutHandoff: 'popout:handoff',
  popoutDragStart: 'popout:drag-start',
  popoutDragEnd: 'popout:drag-end',
  popoutDragCancel: 'popout:drag-cancel',
  popoutOpenInMain: 'popout:open-in-main',
  popoutShowInMain: 'popout:show-in-main',
  popoutRekey: 'popout:rekey',
  evPopouts: 'popout:ev-list',
  evDock: 'popout:ev-dock',
  evDockHover: 'popout:ev-hover',
  evPopoutReveal: 'popout:ev-reveal',
  evPopoutClose: 'popout:ev-close',
  // Moving a tab to another project's window.
  windowsMoveTab: 'windows:move-tab',
  windowsAdopted: 'windows:adopted',
  windowsList: 'windows:list',
  evAdopt: 'windows:ev-adopt',
  evProjectWindows: 'windows:ev-list'
} as const;

export interface AtelierApi {
  /** The platform the app runs on, the renderer's only way to know it. */
  readonly platform: Platform;
  /** The OS version (`10.0.26200` on Windows): the build number xterm's Windows pty option needs (shared/windows-pty). */
  readonly osVersion: string;
  /** The theme this window opened on, set on <html> before the first paint; settings follow. */
  readonly bootTheme: ThemeId;
  project(): Promise<ProjectInfo | null>;
  openFolder(): Promise<void>;
  /** The welcome window for another project (only one). */
  newWindow(): Promise<void>;
  /** Tab pop-out windows. */
  popout: {
    open(r: PopoutOpenRequest): Promise<PopoutOpenResult>;
    /** Move this pop-out's tab back to the main window. */
    dock(r: DockRequest): Promise<void>;
    focus(key: string, reveal?: PopoutReveal): Promise<void>;
    recall(key: string): Promise<void>;
    /** Run a menu command in the main window (from a pop-out). */
    forward(cmd: MenuCommand): Promise<void>;
    /** Keys of the tabs that live in pop-outs now. */
    list(): Promise<string[]>;
    /** The editor state handed over to this pop-out, once. */
    handoff(): Promise<EditorHandoff | null>;
    dragStart(): Promise<void>;
    /** Released: over another project's window, the move's answer; else null. */
    dragEnd(r: DockRequest): Promise<MoveResult | null>;
    dragCancel(): Promise<void>;
    /** From a pop-out: open another file (a link, a path) in the project window, brought forward, at that line. */
    openInMain(path: string, line?: number): Promise<void>;
    /** From a pop-out: show another tab (a session, the inspector, a revision…) in the project window, brought forward. */
    showInMain(r: ShowInMainRequest): Promise<void>;
    /** From a pop-out: its untitled buffer was saved as a file (Save As), its window holds that file now. */
    rekey(from: string, to: string): Promise<void>;
    /** A tab drag started in the project window: outside it, a ghost of the pop-out follows the pointer (tear-off). */
    tearStart(s: TearStart): Promise<void>;
    /** The tab drag ended without a pop-out (released inside, Esc): the ghost goes. */
    tearEnd(): Promise<void>;
  };
  /** The open project windows, and a file or a plain terminal sent to one. */
  projectWindows: {
    /** The open project windows (this one included). */
    list(): Promise<ProjectWindowInfo[]>;
    moveTab(r: MoveRequest): Promise<MoveResult>;
    /** This window's answer to an adopt request (on.adopt). */
    adopted(a: AdoptAnswer): Promise<void>;
  };
  /** Recent projects that still exist (for the welcome screen). */
  recentProjects(): Promise<string[]>;
  /** Opens a recent project: main only accepts paths that are really among the recents. */
  openRecent(path: string): Promise<void>;
  /** Forgets a recent project (only the list: the folder stays); the recents left to show. */
  forgetRecent(path: string): Promise<string[]>;
  daemonState(): Promise<DaemonState>;
  /** Limits per Claude config dir. */
  usage(): Promise<UsageEntry[]>;
  files: {
    list(dir: string, showHidden: boolean): Promise<DirEntry[]>;
    read(path: string): Promise<FileContent>;
    /** Open Anyway: text up to 50 MB, read-only 'large' past 5 MB. */
    readLarge(path: string): Promise<FileContent>;
    /** An image file of the project, for its tab (imageMime says which files are images). */
    readImage(path: string): Promise<ImageContent>;
    /** A video for its tab: an atelier-media: token URL, never its bytes. */
    openVideo(path: string): Promise<VideoContent>;
    /** A path quoted in the terminal → project file, if it exists. */
    resolve(candidate: string, cwd: string): Promise<{ path: string; rel: string } | null>;
    /**
     * A file in Claude's temp folder quoted in the terminal: resolve checks it (hover),
     * open checks it again and grants it read-only (click). Real path and short label, or null.
     */
    claudeTemp: {
      /** A path ending in / is a folder: folder: true when it is one inside the temp folder. */
      resolve(path: string): Promise<{ path: string; rel: string; folder?: true } | null>;
      open(path: string): Promise<{ path: string; rel: string } | null>;
      /** A folder inside the temp folder, checked again and opened in Finder; false when refused. */
      reveal(path: string): Promise<boolean>;
    };
    /**
     * Any other file a terminal link names, absolute or `~/…`: resolve checks it (asked only
     * while ⌘ is held: it touches the disk), open checks it again and grants it read-only (⌘-click). Real path and label.
     */
    outside: {
      resolve(path: string): Promise<{ path: string; rel: string } | null>;
      open(path: string): Promise<{ path: string; rel: string } | null>;
    };
    /** All the project's files (for ⌘K). */
    index(): Promise<{ path: string; rel: string }[]>;
    /** Saves (atomic); with a base different from disk it answers conflict. `create`: a file deleted on disk is made
     *  again, only while its name is free (one that came back is a conflict). */
    save(path: string, text: string, base: Stamp | null, eol: 'lf' | 'crlf', create?: boolean): Promise<SaveResult>;
    create(dir: string, name: string, kind: 'file' | 'folder'): Promise<{ path: string } | { error: string }>;
    /** Save as (untitled tab): a new file at a path relative to the project root, never replacing one; the real path. */
    saveAs(rel: string, text: string): Promise<{ path: string } | { error: string }>;
    /**
     * Save as outside the project: main's save panel, its name field holding `name`; the
     * file saved where it was put (granted when outside the project), `rel` as its tab shows it; canceled: nothing.
     * `unsaved`: the files open with unsaved edits, which it refuses to replace.
     */
    saveAsOutside(name: string, text: string, unsaved: string[]): Promise<{ path: string; rel: string } | { error: string } | { canceled: true }>;
    rename(path: string, name: string): Promise<{ path: string } | { error: string }>;
    duplicate(path: string): Promise<{ path: string } | { error: string }>;
    /** What Move to Trash would take (a folder: how many files, 10000 at most), for the page's question. */
    trashInfo(path: string): Promise<{ kind: 'file' | 'folder'; files: number } | { error: string }>;
    /** Moves to the Trash; the page asked first. */
    trash(path: string): Promise<{ ok: true } | { error: string }>;
    /**
     * Files and folders dropped from Finder: the preload turns the File objects into paths, so a
     * page can't name paths of its own. Main answers with ev:open-paths (and opens an outside folder as a project).
     */
    openDropped(files: File[]): Promise<void>;
    /** Open File… (⌥⌘O): main's open panel; the picked files arrive as ev:open-paths. */
    openPicker(): Promise<void>;
    /** The page listens for ev:open-paths now: what main held for it (a cold launch from Finder) comes back. */
    openReady(): Promise<OpenPathsEvent[]>;
  };
  /**
   * write answers false if the text is too large (over 16 MB); with html, the copy carries that HTML flavour too
   * (Ask's formatted copies), each held to the same limit. saveImage saves the clipboard image to a private png and
   * returns its path (null if the clipboard has no image, tooLarge over 30 MB).
   */
  clipboard: { write(text: string, html?: string): Promise<boolean>; read(): Promise<string | null>; saveImage(): Promise<{ path: string } | { tooLarge: true } | null> };
  /** Path of a file dragged from Finder into the window (null if it has none). */
  pathForFile(file: File): string | null;
  /**
   * The family names of the fonts installed on this machine (Local Font Access, granted to app
   * pages only), unsorted, each once; null when they can't be read. The renderer keeps the monospaced ones.
   */
  localFonts(): Promise<string[] | null>;
  /** Shows the file in Finder (only inside the project). */
  reveal(path: string): Promise<void>;
  /** The `atelier` shell command: a link in /usr/local/bin to the app's script. */
  shellCommand: { install(): Promise<ShellCommandResult>; uninstall(): Promise<ShellCommandResult> };
  /** The window's tabs across restarts: saved per project by main, restored once at start. */
  tabs: {
    save(tabs: SavedTabs): Promise<void>;
    restore(): Promise<RestoredTabs | null>;
  };
  /** Opens an http(s) URL in the user's default browser. */
  openUrl(url: string): Promise<void>;
  /** The project's statuses and file bases (read-only), and the git writes (GitApi). */
  git: GitApi & {
    status(): Promise<RepoStatus[]>;
    /** File content at HEAD (null if new or outside a repo). */
    head(path: string): Promise<{ original: string | null }>;
    /** File content at HEAD or at a commit id (the merge base of a review against main); null if not there. */
    base(path: string, rev: string): Promise<{ original: string | null }>;
    /** Each repo compared with its default branch (review "Against main"), or why it isn't offered. */
    compare(): Promise<RepoCompare[]>;
  };
  /**
   * Source Control, read-only. `root`: one of repos()'s entries; refnames: from refs() for
   * that root; `view`: a newer call with the same view aborts the older one.
   */
  scm: {
    repos(): Promise<ScmRepoEntry[]>;
    /** How the project's folder scan for repositories went (Source Control says when it stopped early). */
    search(): Promise<RepoSearch>;
    refs(root: string): Promise<ScmRefs>;
    log(root: string, scope: ScmScope, skip: number, count: number, filter?: string, view?: string): Promise<ScmLogPage>;
    /** Where a commit is in the scope's history (to jump to it), null when it isn't there. */
    locate(root: string, scope: ScmScope, oid: string, view?: string): Promise<number | null>;
    /** A full commit id from a 4–40 hex prefix. */
    resolve(root: string, prefix: string): Promise<string | null>;
    /** A commit's message and files, against `against` (another parent, a merge base) or its first parent. */
    commit(root: string, oid: string, against?: string | null, view?: string): Promise<ScmCommitDetail>;
    /** A file's content at a commit. */
    file(root: string, oid: string, rel: string): Promise<ScmBlob>;
    aheadBehind(root: string, base: string, head: string): Promise<{ ahead: number; behind: number } | null>;
    worktrees(root: string): Promise<ScmWorktree[]>;
    stashes(root: string): Promise<ScmStash[]>;
    /** A working tree's status (a hidden-folder worktree's too, which Changes doesn't watch); null before the first read. */
    status(root: string): Promise<RepoStatus | null>;
    /**
     * `view` runs only past the gates (setting, remote, 10 min, backoff, auth); `manual` always, and joins
     * a fetch of that repo already running. The only call here that writes (remote-tracking refs) and uses the network.
     */
    fetchRepo(root: string, reason: FetchReason): Promise<ScmFetchAnswer>;
    /** A manual fetch of every repository of the project that has a remote: the outcomes. */
    fetchAll(): Promise<FetchOutcome[]>;
    /** The project's repositories' fetch states (running, last outcome). */
    fetchStates(): Promise<ScmFetchState[]>;
  };
  attributions(): Promise<Attribution[]>;
  /**
   * The user says who changed unsure files: one of their candidate sessions, or null (outside Claude). Returns an undo
   * token and how many files changed, null when none did.
   */
  resolveAttributions(paths: string[], terminalId: string | null): Promise<{ token: string; count: number } | null>;
  /** Undoes a resolution; false when its files changed since. */
  undoResolve(token: string): Promise<boolean>;
  resumables(): Promise<Resumable[]>;
  /** Scheduled prompts: every project's, owned by atelierd. */
  schedules: {
    list(): Promise<ScheduledPrompt[]>;
    add(o: { terminalId: string; text: string; at: number; ifBusy: IfBusy }): Promise<ScheduleResult>;
    update(o: { id: string; text?: string; at?: number; ifBusy?: IfBusy }): Promise<ScheduleResult>;
    remove(id: string): Promise<ScheduleResult>;
    /** Undo of a remove: the prompt as it was. */
    restore(prompt: ScheduledPrompt): Promise<ScheduleResult>;
    /** Send Now (also the countdown's end); `usage`: Send Anyway past a usage limit. */
    fire(id: string, force?: 'usage'): Promise<ScheduleResult>;
    /** Not Now: later by `minutes`. */
    snooze(id: string, minutes: number): Promise<ScheduleResult>;
  };
  /**
   * The Claude Code signals notebook: what Claude Code sends that Atelier
   * doesn't recognize, kept by atelierd. get: null without the capability 'signals'. clear: empties the entries.
   */
  claudeSignals: {
    get(): Promise<SignalBookView | null>;
    clear(): Promise<void>;
  };
  /** Claude Code's own conversations of this project (read-only from Claude's history), not running in Atelier. */
  claude: {
    /**
     * The default Claude account's config dir (`~/.claude`, or the CLAUDE_CONFIG_DIR the app runs with), and the
     * user's home (a `~/…` folder typed in Settings › Claude › Accounts).
     */
    dirs(): Promise<{ defaultDir: string; home: string }>;
    /** Settings › Claude › Accounts: a folder from the open panel (hidden ones shown), null when cancelled. */
    pickDir(): Promise<string | null>;
    /**
     * Settings › Claude › Launch flags: the command a new session of that account (absent: the one new sessions start
     * with) and that name would run now, built by main as it builds the real one.
     */
    launchPreview(o: { account?: string; name: string }): Promise<string>;
    history(): Promise<ClaudeConversation[]>;
    /**
     * `claude --resume <id>` in the conversation's folder; main only resumes conversations its history lists. account:
     * the Claude account the conversation belongs to (ClaudeConversation.account; absent: the default one).
     */
    resume(sessionId: string, cols: number, rows: number, account?: string): Promise<TerminalInfo>;
    /**
     * Session panel: the MCP servers, skills and plugins Claude Code's config files set up for a folder
     * of this project (names and enabled state only), read-only in main.
     */
    /** terminalId: the session's terminal, so main reads its Claude account's config (default when unknown). */
    config(cwd: string, terminalId?: string): Promise<ClaudeConfig>;
    /**
     * Restart Session: the command that resumes this live session in its own shell, built by
     * main (its account, the current launch flags); refused for another project's terminal or another session id.
     */
    restartCommand(terminalId: string, sessionId: string): Promise<string>;
    /** New MCP servers: this project's sessions' servers added since they started, by terminal. */
    mcpAdded(): Promise<McpAdded>;
    /**
     * Context usage: Claude Code's own split of this project's terminal's session,
     * from a private copy main starts (nothing sent to Claude, nothing saved); progress on `on.contextProgress`.
     */
    contextUsage(terminalId: string): Promise<ContextResult>;
    /** The session's last reply's input from its transcript, null when unknown. */
    contextLive(terminalId: string): Promise<number | null>;
    /** A file the terminal's last report listed, granted read-only when outside the project; null when refused. */
    contextOpen(terminalId: string, path: string): Promise<{ path: string; rel: string } | null>;
  };
  /** Asks for confirmation (in this window) and restarts atelierd (closes all sessions, which stay resumable). */
  restartDaemon(): Promise<void>;
  /** Main's questions: this page listens now; its answer to one. */
  /** shown: the page got main's question (a page that never says so in time gets the native dialog instead). */
  asks: { ready(): Promise<void>; shown(id: string): Promise<boolean>; answer(id: string, answer: string): Promise<boolean> };
  /** Captures the user's shell environment again for Atelier-profile terminals (only with profilesAvailable). */
  reloadShellEnv(): Promise<{ ok: true } | { error: string }>;
  shellEnv: {
    /** The files checked before a new Atelier terminal: zsh's own, then the extra ones. */
    files(): Promise<CheckedFile[] | null>;
    /** The open panel for extra files (files only, hidden ones shown): the chosen paths, none if cancelled. */
    pickFiles(): Promise<string[]>;
  };
  settings: {
    get(): Promise<Settings>;
    /** Partial change: main validates it, saves it and sends it to all windows (null if rejected). */
    set(patch: Partial<Settings>): Promise<Settings | null>;
    /** Asks for confirmation and goes back to defaults (null if cancelled). */
    reset(): Promise<Settings | null>;
  };
  /** Versions for the About section. */
  appInfo(): Promise<AppInfo>;
  openLogs(): Promise<void>;
  /** Settings › Notifications: a test banner (macOS asks for permission the first time) and Dock badge; macOS's settings. */
  notifications: { test(): Promise<void>; openSettings(): Promise<void> };
  /** An error of this page (uncaught, unhandled rejection, caught by an error boundary) for ATELIER_HOME/logs/app.log. */
  logError(e: RendererError): void;
  /** This window's state for the application menu while it is in front (Git › Undo Last Commit). */
  menuState(s: MenuState): void;
  /** Whether this window has unsaved files (on Windows they hold a sign-out or shutdown until its question is answered). */
  unsaved(has: boolean): void;
  /**
   * Windows: this window's menu, drawn in its header (null on macOS, where the menu is
   * native), and running one of its items by id.
   */
  menu: { model(): Promise<WinMenu[] | null>; invoke(id: string): void };
  /** Test only (ATELIER_TEST_RENDER_ERROR): the panel made to throw while rendering; null in the real app. */
  testFault(): Promise<string | null>;
  /** Opens this window's project folder in Finder. */
  revealProject(): Promise<void>;
  /** Dictation: status of the steps, setup, transcription. */
  dictation: {
    status(): Promise<DictationStatus>;
    download(): Promise<void>;
    cancelDownload(): Promise<void>;
    removeModel(): Promise<void>;
    restartEngine(): Promise<void>;
    requestMic(): Promise<boolean>;
    openPrivacy(): Promise<void>;
    /** Test only (ATELIER_TEST_FAKE_MIC): 16 kHz PCM of a WAV in place of the microphone; null in the real app. */
    testAudio(): Promise<Uint8Array | null>;
    /** terminalId: where the text goes; the polish runs with that session's Claude account. */
    transcribe(pcm: Uint8Array, raw: boolean, context: { sessions: string[]; branch: string | null; files: string[]; identifiers: string[] }, terminalId?: string):
      Promise<{ text: string; polished: boolean; warning?: 'no-speech' | 'not-polished' | 'engine-error' }>;
  };
  openLicenses(): Promise<void>;
  /**
   * state/apply: a newer build set aside (npm run stage-update or the in-app updater) and applicable without closing
   * sessions. The rest is the in-app updater (Settings › About): its status, "Check now", the one-time "What's new"
   * after an update, the release page for a manual install (the update's release when it needs an atelierd restart,
   * otherwise the releases list; opened in the browser) and Finder on /Applications (an app that cannot replace
   * itself where it runs).
   */
  update: {
    state(): Promise<boolean>;
    apply(): Promise<boolean>;
    status(): Promise<UpdateStatus>;
    check(): Promise<UpdateStatus>;
    /** Once, to the first window that asks after an update: the running version, its notes, the version it came from. */
    whatsNew(): Promise<{ version: string; notes: string; since: string } | null>;
    openRelease(): Promise<void>;
    openApplications(): Promise<void>;
    /** Windows: Atelier's page in the Microsoft Store (a fixed link main opens). */
    openStore(): Promise<void>;
  };
  /** Redis view: local instances, from main's RedisHub; writes only as these operations. */
  redis: {
    snapshot(): Promise<RedisSnapshot>;
    status(): Promise<RedisStatus>;
    /** What this window shows (database, sidebar, Queues, Overview, Live): what main polls and streams for it. */
    watch(w: RedisWatch): void;
    pick(key: string): Promise<void>;
    auth(a: { key: string; user?: string; password?: string; useEnv?: boolean }): Promise<{ ok: true } | { ok: false; reason: 'wrong' | 'unreachable' }>;
    forget(key: string): Promise<void>;
    /** The Queues tab looked at this queue: its failures are no longer new. */
    seen(queueId: string): void;
    scan(a: { db: number; match: string; cursor: string }): Promise<{ cursor: string; keys: KeyEntry[]; total: number }>;
    value(a: { db: number; key: string; page: ValuePage }): Promise<RedisValueReply>;
    counter(a: { db: number; key: string }): Promise<{ value: string | null; ttl: number }>;
    clients(): Promise<ClientRow[]>;
    slowlog(): Promise<{ threshold: number | null; entries: SlowEntry[] }>;
    jobs(a: { db: number; queue: string; state: JobState; start: number; count: number }): Promise<JobInfo[]>;
    job(a: { db: number; queue: string; state: JobState; id: string }): Promise<{ job: JobInfo; command: string | null } | null>;
    preview(a: { db: number; pattern: string; instance: string }): Promise<Preview>;
    /** `instance`: the endpoint the user confirmed on; main refuses when the window shows another by now. */
    write(a: { db: number; op: RedisWriteOp; instance: string }): Promise<WriteResult>;
    undo(id: string): Promise<UndoResult>;
  };
  /**
   * Databases view: read-only, from main's DbHub. Connections by id, only those the window's
   * project can see; a password goes to main (password, test, save) and never comes back.
   */
  databases: {
    snapshot(): Promise<DbSnapshot>;
    /** Selects a connection for the project (remembered) and connects it; null selects none. */
    select(connId: string | null): Promise<void>;
    connect(id: string): Promise<DbResult<DbServerInfo>>;
    disconnect(id: string): Promise<void>;
    /** Connects with a typed password; `save`: into the Keychain once it works (the reply warns when it refused). */
    password(a: { connId: string; password: string; save: boolean }): Promise<DbResult<DbServerInfo>>;
    /** Test Connection: saves nothing. Editing (`id`), '' or null keeps the saved password (on the same server only). */
    test(a: { form: DbConnectionForm; password: string | null; id: string | null }): Promise<DbResult<DbServerInfo>>;
    /** A new connection (`id` null) or an edit; '' or null keeps the saved password while the server stays the same. */
    save(a: { form: DbConnectionForm; password: string | null; id: string | null }): Promise<DbResult<{ id: string }>>;
    duplicate(id: string): Promise<DbResult<{ id: string }>>;
    remove(id: string): Promise<void>;
    setMask(id: string, on: boolean): Promise<void>;
    /** Dismiss on the "this role can write" note. */
    noteWrite(id: string): Promise<void>;
    /** The schema chip: remembered on the connection. */
    setSchema(id: string, schema: string): Promise<void>;
    /** The sidebar's Refresh: the selected connection's catalog. */
    refresh(): Promise<void>;
    page(req: DbPageRequest): Promise<DbResult<DbPage>>;
    estimate(a: DbFilteredRef): Promise<DbResult<number | null>>;
    count(a: DbFilteredRef): Promise<DbResult<number>>;
    peek(a: DbPeekRequest): Promise<DbResult<DbPeek>>;
    refs(a: DbRefsRequest): Promise<DbResult<DbRefCount[]>>;
    full(a: DbFullRequest): Promise<DbResult<string>>;
    structure(ref: DbTableRef): Promise<DbResult<DbStructure>>;
    relations(ref: DbTableRef): Promise<DbResult<DbRelations>>;
    /** A table's DDL rebuilt from the catalog, or a function's definition (pg_get_functiondef: the sidebar's Copy Definition). */
    ddl(ref: DbTableRef | DbFunctionRef): Promise<DbResult<string>>;
    overview(id: string): Promise<DbResult<DbOverview>>;
    /** Copy SQL for a Read-only Role: the script for the connected server's version (never run). */
    readOnlySql(id: string): Promise<DbResult<string>>;
  };
  /** Docker view: read-only, from main's DockerHub. */
  docker: {
    snapshot(): Promise<DockerSnapshot>;
    /** A container's kept lines (main keeps them while watched, and a minute after). */
    logs(id: string): Promise<{ lines: DockerLogLine[]; ended: boolean }>;
    /** Containers whose logs this window shows now: main streams only these. */
    watchLogs(ids: string[]): void;
    /** Containers whose stats this window shows now (at most 24 streams in all). */
    watchStats(ids: string[]): void;
    stats(ids: string[]): Promise<Record<string, StatsSample[]>>;
    inspect(id: string): Promise<{ container: DockerContainer; detail: DockerDetail } | null>;
    df(): Promise<DfSummary | null>;
    events(): Promise<DockerEventEntry[]>;
    /** The last lines of a container, read once (not followed): "Ask Claude Why It Crashed". */
    tail(id: string, n: number): Promise<DockerLogLine[]>;
  };
  services: {
    list(): Promise<{ status: ServicesStatus; panes: ServicePane[] }>;
    /** Lines of a pane's buffer, with the sequence to attach updates to. */
    lines(id: string): Promise<{ lines: string[]; seq: number; live: string }>;
    /** Panes shown now: captured every second instead of every five. */
    watch(ids: string[]): void;
  };
  terminals: {
    list(): Promise<TerminalInfo[]>;
    /** profile: one of the offered profiles; absent = the default from Settings (ignored by an older atelierd). */
    create(o: { cwd?: string; cols: number; rows: number; name?: string; command?: string; profile?: ProfileKey }): Promise<TerminalInfo>;
    /** Shells from /etc/shells offered as profiles, besides Atelier and zsh (your config). */
    shells(): Promise<ShellOption[]>;
    /** Terminal with `claude` (and `-n name` if given) already started. */
    /** account: a Claude account's id (absent: the one set for new sessions). */
    createSession(o: { cols: number; rows: number; name?: string; cwd?: string; account?: string; noFlags?: true }): Promise<TerminalInfo>;
    rename(id: string, name: string | null): Promise<void>;
    markSeen(id: string): Promise<void>;
    /** Where the terminal is now: Claude's folder for a session, the shell's (after `cd`) otherwise. */
    folder(id: string): Promise<string>;
    /** Opens that folder in Finder (main finds it again: the renderer never names the path). */
    openFolder(id: string): Promise<void>;
    resume(id: string, cols: number, rows: number): Promise<TerminalInfo>;
    dismiss(id: string): Promise<void>;
    /** Closes a terminal, stopping what runs in it: the page asks first. */
    close(id: string): Promise<void>;
    /** The screen arrives from the snapshot event, on the same ordered channel as the data. */
    attach(id: string): Promise<void>;
    detach(id: string): Promise<void>;
    kill(id: string): Promise<void>;
    /** Stops these terminals of the window's project as a window close does: Claude sessions come back under Resume. */
    stop(ids: string[]): Promise<void>;
    input(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    /** A "notify" output trigger matched in this terminal: main may show an OS banner. */
    triggerMatched(id: string, rule: string, line: string): void;
  };
  /**
   * Listening ports of this project's terminals: list = the current map; open = `http://localhost:<port>/`
   * in the user's browser, only for a port main lists now for that terminal (false otherwise).
   */
  ports: {
    list(): Promise<PortsMap>;
    open(id: string, port: number): Promise<boolean>;
  };
  /**
   * Pull requests of this project's Claude sessions: list = the current state; open = the PR of that
   * repo+branch (or its checks page) in the user's browser, only the https URL gh gave main (false otherwise).
   */
  prs: {
    list(): Promise<PrsState>;
    open(root: string, branch: string, checks: boolean): Promise<boolean>;
  };
  /**
   * External accounts, one app-wide connection per connector. list: the cards plus the toasts
   * that came before any window could show them (taken once). Actions answer with the updated card. connect from a
   * second window joins the running sign-in; reopenAuth reopens its page from main (the renderer never sees the URL).
   * openTask: main opens the task's page it holds (or builds from the id), never a URL from the renderer.
   */
  connectors: {
    list(): Promise<{ connectors: ConnectorInfo[]; notices: ConnectorNotice[] }>;
    connect(id: ConnectorId): Promise<ConnectorInfo>;
    cancel(id: ConnectorId): Promise<ConnectorInfo>;
    reopenAuth(id: ConnectorId): Promise<ConnectorInfo>;
    disconnect(id: ConnectorId): Promise<ConnectorInfo>;
    refresh(id: ConnectorId): Promise<ConnectorInfo>;
    setOptions(id: ConnectorId, options: { includeClosed?: boolean }): Promise<ConnectorInfo>;
    openTask(source: ConnectorId, id: string): Promise<boolean>;
    /** Connectors with chosen sources (Notion's databases). `ref`: a pick's id or a pasted link. */
    searchSources(id: ConnectorId, query: string): Promise<SourcePick[]>;
    addSource(id: ConnectorId, ref: string): Promise<AddSourceResult>;
    removeSource(id: ConnectorId, sourceId: string): Promise<ConnectorInfo>;
    setSourceFields(id: ConnectorId, sourceId: string, fields: NotionFields): Promise<ConnectorInfo>;
    /** The fields editor opened: main reads the source's schema and the card carries its columns. */
    loadSourceColumns(id: ConnectorId, sourceId: string): Promise<ConnectorInfo>;
    /** Jira: a project's "Mine | Everyone". */
    setSourceScope(id: ConnectorId, sourceId: string, everyone: boolean): Promise<ConnectorInfo>;
    /** Jira: the user's saved filters; rejects with one line when they can't be listed. */
    listFilters(id: ConnectorId): Promise<FilterPick[]>;
    /** A filter from the last listing, or null for none. */
    setFilter(id: ConnectorId, filterId: string | null): Promise<ConnectorInfo>;
    /** Jira: sign in with an API token instead of OAuth. The token is sent once and never echoed back. */
    connectToken(id: ConnectorId, creds: { user: string; secret: string; site?: string }): Promise<ConnectorInfo>;
  };
  /**
   * Automations: every project's, app-wide. save: a new automation must be the window's
   * project's; an edit keeps its project. Every answer is the new state (also broadcast on `on.automations`).
   */
  automations: {
    list(): Promise<AutomationsState>;
    save(automation: Automation): Promise<AutomationsState>;
    remove(id: string): Promise<AutomationsState>;
    turnOn(id: string, startMatching: boolean): Promise<AutomationsState>;
    turnOff(id: string): Promise<AutomationsState>;
    checkNow(id: string): Promise<AutomationsState>;
    /** The editor's "Matching now" for an automation as drafted (not saved). */
    preview(automation: Automation): Promise<AutomationPreview>;
    startRun(runId: string): Promise<AutomationsState>;
    skipRun(runId: string): Promise<AutomationsState>;
    stopRun(runId: string): Promise<AutomationsState>;
    /** Close Run: the session closes; with `removeWorktree`, its worktree goes when nothing is left to commit. */
    closeRun(runId: string, removeWorktree: boolean): Promise<{ state: AutomationsState; outcome: string; message?: string }>;
    catchUp(id: string, action: 'start' | 'skip'): Promise<AutomationsState>;
    setPaused(paused: boolean): Promise<AutomationsState>;
    /** The editor's places to watch: ClickUp's lists (Notion's are its chosen databases, in ConnectorInfo.sources). */
    scopes(connector: ConnectorId): Promise<{ id: string; label: string }[]>;
    /** The task source in Claude Code for this account and the window's project. */
    /** `automation`: a saved automation's id, whose project is read (a draft: the window's). */
    sourceMcp(connector: ConnectorId, account: string, automation?: string): Promise<{ state: 'found' | 'notFound' | 'unknown'; name?: string }>;
  };
  /**
   * Tasks from connected sources. list: per connector, the cached tasks (never blocks; a stale cache refreshes in the
   * background and ConnectorInfo.tasksVersion changes when new tasks are in). get: one task's detail, or why not
   * (`gone`: "This task is no longer available in ClickUp."). search: the source's own search; a failure is no results.
   */
  tasks: {
    list(): Promise<TaskList[]>;
    get(source: ConnectorId, id: string): Promise<TaskGetResult>;
    search(source: ConnectorId, query: string): Promise<TaskSummary[]>;
  };
  background: {
    /** Follow an item of a terminal's background work (its output or timeline arrives on `on.backgroundFeed`). */
    watch(terminalId: string, itemId: string): Promise<WatchResult>;
    unwatch(terminalId: string, itemId: string): void;
    /** A self-paced loop's details, read once from its session's transcript. */
    loop(terminalId: string, cronId: string): Promise<LoopResult>;
  };
  /** Ask, the read-only companion of a session. */
  companion: CompanionApi;
  /**
   * Find in Files over the window's project. `start` stops the window's search before it; every event carries the id
   * the page gave its search, so a late event of an older one is told apart.
   */
  search: {
    start(req: SearchRequest): Promise<void>;
    stop(searchId: number): Promise<void>;
    onEvent(cb: (e: SearchEvent) => void): () => void;
  };
  on: {
    backgroundFeed(cb: (feed: BackgroundFeed) => void): () => void;
    terminals(cb: (list: TerminalInfo[]) => void): () => void;
    snapshot(cb: (id: string, data: string) => void): () => void;
    data(cb: (id: string, data: string) => void): () => void;
    exit(cb: (id: string) => void): () => void;
    daemon(cb: (s: DaemonState) => void): () => void;
    usage(cb: (list: UsageEntry[]) => void): () => void;
    command(cb: (cmd: MenuCommand) => void): () => void;
    /** Windows: this window's menu changed (profiles, accounts, its project's Git state). */
    menuModel(cb: (model: WinMenu[]) => void): () => void;
    git(cb: (repos: RepoStatus[]) => void): () => void;
    fsChanged(cb: (paths: string[]) => void): () => void;
    openPaths(cb: (e: OpenPathsEvent) => void): () => void;
    attributions(cb: (list: Attribution[]) => void): () => void;
    services(cb: (e: { status: ServicesStatus; panes: ServicePane[] }) => void): () => void;
    docker(cb: (s: DockerSnapshot) => void): () => void;
    dockerLogs(cb: (e: { id: string; lines: DockerLogLine[]; ended: boolean }) => void): () => void;
    dockerStats(cb: (e: { id: string; sample: StatsSample }) => void): () => void;
    dockerEvent(cb: (e: DockerEventEntry) => void): () => void;
    dockerNote(cb: (n: DockerNote) => void): () => void;
    /** A click on a Docker banner: show that container. */
    dockerOpen(cb: (id: string) => void): () => void;
    redis(cb: (s: RedisSnapshot) => void): () => void;
    redisStatus(cb: (s: RedisStatus) => void): () => void;
    redisMonitor(cb: (e: { key: string; lines: MonitorLine[] }) => void): () => void;
    redisNote(cb: (n: RedisNote) => void): () => void;
    /** A click on a failed-job banner: show that queue. */
    redisOpen(cb: (queueId: string) => void): () => void;
    /** This window's databases snapshot, whenever it changes. */
    databases(cb: (s: DbSnapshot) => void): () => void;
    resumables(cb: (list: Resumable[]) => void): () => void;
    schedules(cb: (list: ScheduledPrompt[]) => void): () => void;
    /** A prompt of this window's project sent, skipped, missed or moved (toasts). */
    scheduleNotice(cb: (n: ScheduleNotice) => void): () => void;
    /** atelierd's signals notebook, on every change (debounced 2 s) and after a Clear. */
    claudeSignals(cb: (book: SignalBookView) => void): () => void;
    /** Click on a notification: leads to the session. */
    select(cb: (id: string) => void): () => void;
    settings(cb: (s: Settings) => void): () => void;
    update(cb: (ready: boolean) => void): () => void;
    updateStatus(cb: (s: UpdateStatus) => void): () => void;
    dictation(cb: (s: DictationStatus) => void): () => void;
    /** New notification center entries for this window's project (checked with parseNotes before use). */
    notes(cb: (entries: unknown) => void): () => void;
    serviceLines(cb: (e: { id: string; lines: string[]; reset: boolean; seq: number; live: string }) => void): () => void;
    /** This project's terminals' listening ports, whenever they change. */
    ports(cb: (map: PortsMap) => void): () => void;
    /** This project's sessions' pull requests and the GitHub CLI status, whenever they change. */
    prs(cb: (state: PrsState) => void): () => void;
    /** Every connector's card, whenever one changes (all windows). */
    connectors(cb: (list: ConnectorInfo[]) => void): () => void;
    /** Every project's automations and runs, whenever one changes (all windows). */
    automations(cb: (s: AutomationsState) => void): () => void;
    /** A connector toast for this window. */
    connectorNotice(cb: (notice: ConnectorNotice) => void): () => void;
    /** A new Atelier terminal of this window reloads the shell environment first, or that reload failed. */
    shellEnvAuto(cb: (e: ShellEnvAuto) => void): () => void;
    /** This project's new MCP servers by terminal, whenever they change. */
    mcpAdded(cb: (m: McpAdded) => void): () => void;
    /** Context usage's progress, for the analyses this window asked for. */
    contextProgress(cb: (p: ContextProgress) => void): () => void;
    /** A question main asks this window (restart atelierd, quitting, closing with unsaved files). */
    ask(cb: (m: AskMessage) => void): () => void;
    /** Main gave up on a question it asked (the page was too slow; its native dialog asks instead): drop it. */
    askWithdrawn(cb: (id: string) => void): () => void;
    /** Something main has to tell this window (a restart that failed): a toast. */
    appNotice(cb: (n: AppNotice) => void): () => void;
    /** Refs, a HEAD, a fetch or a hidden worktree's status changed in one of the project's repositories. */
    scm(cb: (e: ScmEvent) => void): () => void;
    /** A repository's fetch started or ended. */
    scmFetch(cb: (s: ScmFetchState) => void): () => void;
    /** A git write of one of the project's working trees was queued, ran a phase, printed, or ended. */
    gitOp(cb: (e: GitOpEvent) => void): () => void;
    /** A ✦ message being written: a chunk, the full text, or why it failed. */
    scmMessage(cb: (e: ScmMessageEvent) => void): () => void;
    /** An Ask run queued, started, streamed or traced, or a thread saved (any session's: every window gets them). */
    companion(cb: (e: CompanionEvent) => void): () => void;
    /** The keys of the tabs in pop-outs changed. */
    popouts(cb: (keys: string[]) => void): () => void;
    /** A pop-out's tab is moved back here. */
    dock(cb: (e: DockEvent) => void): () => void;
    /** A pop-out is dragged over this window (null: it left); across: another project's tab. */
    /** A pop-out dragged over this window: the point, and its key (its own project's window) or `across` (another's). */
    dockHover(cb: (p: (Point & { across?: boolean; key?: string }) | null) => void): () => void;
    /** Another project's window sends this one a tab (answer with tabs.adopted). */
    adopt(cb: (r: AdoptRequest) => void): () => void;
    /** The open project windows changed. */
    projectWindows(cb: (list: ProjectWindowInfo[]) => void): () => void;
    /** Reveal something in this pop-out's tab. */
    popoutReveal(cb: (r: PopoutReveal) => void): () => void;
    /** This pop-out is asked to close (its tab was recalled). */
    popoutClose(cb: () => void): () => void;
  };
}

export type SaveResult = { kind: 'saved'; stamp: Stamp } | { kind: 'conflict'; disk: string; stamp: Stamp } | { kind: 'error'; reason: string };
