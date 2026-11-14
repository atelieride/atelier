import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { newAutomation, setPaused } from '../automations/actions';
import { themeOf } from '@shared/themes';
import { fuzzyFilter, textFilter } from '@shared/fuzzy';
import { t } from '../i18n/en';
import { currentPlatform } from '@shared/platform';
import { trayCopy } from '../tray-copy';
import { defaultRef, fetchAll, fetchSelected, mayFetch, showHistory } from '../scm/actions';
import { withScm } from '../scm/data';
import { viewCommand } from '../scm/all-view';
import { lastUndo } from '../git/actions';
import { commandRepo, gitPaletteCommands, runPaletteGit, sessionWork } from '../git/commands';
import { useApp, type PaletteSend } from '../store';
import type { ClaudeConversation } from '@shared/history';
import type { TerminalInfo } from '@shared/protocol';
import { parseQuery, splitTerminals, stepActive, type PaletteQuery } from '../palette-query';
import type { Starting } from '../starting';
import { conversationHint, refreshHistory, resumeConversation, resumeEmptyText, resumeList, searchConversations } from '../history';
import { relativeCwd, truncateLeft } from '../folders';
import { goToAttention } from '../attention-nav';
import { showBackground } from '../background-command';
import { goToChange } from '../change-targets';
import { activeFindTarget, findInActiveTab } from '../editor/find/find-ext';
import { toggleWordWrap } from '../editor/word-wrap';
import { revealActive } from '../reveal';
import { hasSearchResults, openFindInFiles, stepSearchResult } from '../search/open';
import { shelfCommand } from '../menus';
import { collapseAllFolders } from './FileTree';
import { recentForPalette } from '../recent';
import { Avatar } from './Avatar';
import { FileIcon } from './FileIcon';
import { Icon, type IconName } from './Icon';
import { paletteProfileCommands } from '../profiles';
import { accountChoices, paletteAccountCommands, useAccounts } from '../accounts';
import { AccountChip } from './AccountChip';
import { accountById, hasAccounts, type ClaudeAccounts } from '@shared/claude-accounts';
import { newTerminalIn, reloadShellEnv } from '../launch';
import { continueOnPhone, remoteAvailability, remoteReason } from '../remote';
import { pendingFor, sendReason, sendReview } from '../review-send';
import { openSessionPanel, panelAvailability } from '../session-panel';
import { restartFromMenu } from '../restart-actions';
import { openContextSheet } from '../context-actions';
import { clockOf, paletteRows } from '../schedule-view';
import type { ScheduledPrompt } from '@shared/scheduled-prompts';
import { deleteSchedule, editSchedule, fireSchedule, scheduleBlock, scheduleSelected } from '../schedules';
import { commandBlocks, redrawTerminal } from '../terminal/registry';
import { focusTerminal } from '../terminal/focus';
import { requestTerminalFind, terminalFindKeys } from '../terminal/find';
import { openTriggerSettings } from './Triggers';
import { openLaunchFlags } from '../launch-flags';
import { openClaudeCompat } from './ClaudeCompatibility';
import { languageLabel } from '@shared/languages';
import { effectiveLanguage } from '../lang-overrides';
import { prGlyph, prShown } from '../pr-view';
import { CONNECTOR_ICONS, CONNECTOR_NAMES, clockTime, connectorCommands, connectorView, noneChosen, type ConnectorCommand } from '../connectors-view';
import { runConnectorCommand } from '../connector-actions';
import { chooseSourcesLabel, liveConnectors, onlyChosenNote, searchInLabel, sectionCount, taskFooter, taskSections, tasksEmptyLine, type TaskRow, type TaskSection } from '../task-view';
import { TaskCells } from './TaskCells';
import { copyTask, copyTaskId, loadTaskLists, pasteReason, pasteTaskInto, startSessionFromTask } from '../task-session';
import { sendRows, sendTextTo, textInNewTerminal } from '../send-selection';
import { selectionPreview } from '../terminal/selection';
import { folderName } from '../reveal';
import { effectiveState } from '@shared/background';
import { waitKind } from '@shared/session-view';
import { askHint } from '../companion/attention';
import { catchUpFor, openAskFor } from '../companion/actions';
import { shownStateLabel } from '../selectors';
import type { ConnectorId, ConnectorInfo, TaskSummary } from '@shared/tasks';
import { isWorktree, worktreeCommands } from '../worktrees';
import { useDocker } from '../docker/store';
import { dockerShown, hasProblem } from '../docker/view';
import { askWhyCrashed, openContainer, openOverview, openStack } from '../docker/actions';
import { groupContainers } from '@shared/docker';
import { useRedis } from '../redis/store';
import { redisShown } from '../redis/view';
import { askJobs, openQueue, openRedis } from '../redis/actions';
import { useDb } from '../databases/store';
import { liveConn } from '../databases/view';
import { openDbOverview } from '../databases/tabs';
import { isCsvTab, isJsonTab, isMarkdownTab } from '../markdown-views';
import { setActivePreviewView, toggleMarkdownOutline, togglePreview } from '../markdown-commands';
import { activeJsonTarget } from '../json-targets';
import { activeCsvTarget } from '../csv-targets';
import { runShellCommand } from '../shell-command';
import { paneSize } from '../dock-target';
import { usePointerGate } from '../pointer-hover';
import { isImeComposing, isMod } from '@shared/keys';
import { kbd } from '../kbd';
import { offersCheck } from '../update-view';
import { servicesView, shellCommand, shellEnv } from '../features';
import { moveToWindow, moveToWindowCommands } from '../move-window';
import { newSessionIn } from '../launch';
import { WorkspaceGlyph } from './WorkspaceGlyph';
import { cardOf, wsActivityCard, wsColorVar } from '../workspace-view';
import { closeWorkspaceInFront, renameWorkspaceInFront, stepWorkspace, wsActivityCommands } from '../workspace-menus';
import { activitiesOf, workspacesOf, type Dot } from '../workspaces';
import { canMoveStep } from '../split';

interface Item {
  key: string; kind: 'session' | 'terminal' | 'file' | 'command' | 'resume' | 'history' | 'line' | 'task' | 'workspace'; label: string; hint: string; color?: string; icon?: IconName; run: () => void;
  /** A workspace's row (or one of its activities', with the activity glyph): its color and state dots. */
  ws?: { color: number; dots: Dot[]; activity?: true };
  /** ⌥Enter / ⌥-click: Open to the Side (sessions, terminals and files). */
  side?: () => void;
  /** Leads to another step of the palette (a task's actions): the palette stays open. */
  keep?: boolean;
  /** ⌘ and ⌥ lead to another step too (a task's account): the palette stays open. */
  stays?: boolean;
  /** A session or conversation of another Claude account: its chip after the label. */
  configDir?: string;
  /** "New session as …": the account's color (1–8) in place of the command's icon. */
  dot?: number;
  /** Can't do it now (a session busy for Paste into Session): greyed, still pickable — the toast says why. */
  off?: boolean;
  /** What ⌥Enter does when not Open to the Side (a container: Inspect). */
  sideLabel?: string;
  /**
   * ⌘Enter / ⌘-click: a task starts the session and sends the prompt, a table opens as a kept
   * tab rather than a preview; with ⌥ too, to the side.
   */
  send?: (side: boolean) => void;
  /** What ⌘Enter does, said in the footer while the row is highlighted (a table: keep open). */
  sendLabel?: string;
  /** ⌘⌫ (scheduled prompts): delete it, the palette staying open. */
  remove?: () => void;
  /** A conversation from Claude's history: its chips and the first prompt (tooltip). */
  conv?: { branch: string | null; folder: string | null; cwd: string; prompt: string; active: boolean };
  /** A task: status dot, display id, title, list, due date; greyed when offline. */
  task?: { row: TaskRow; stale: boolean };
  /** "Ask about" rows: the hint violet for a new answer, amber while the session waits. */
  tone?: 'ask' | 'waiting';
}

/** A group of the palette's results. */
interface Group {
  title: string;
  items: Item[];
  /** What it says when it has no rows (alone in the palette; a connector's section says it inside itself). */
  empty?: string;
  /** React key when the title can change (a connector's section going offline). */
  key?: string;
  icon?: IconName;
  /** A connector's section: its glyph before the title, shown even without rows. */
  connector?: ConnectorId;
  /** task: only (several connectors) — the rows it shows, right-aligned; never with clickup: / notion:. */
  count?: number;
  /** A quiet line under its rows (which Notion databases are searched). */
  note?: string;
}

/** How a task's session is to start once its account is picked: ⌘ sends the prompt, ⌥ opens it to the side. */
interface TaskIntent { send: boolean; side: boolean }
/** With two or more Claude accounts: the task's account step, opened with that intent. */
type ChooseAccount = (row: TaskRow, intent: TaskIntent) => void;

/**
 * A task row: Enter opens its actions; ⌘Enter still starts a session and sends the prompt, ⌥Enter
 * starts it to the side — with two or more accounts, both through the account step (`choose`).
 */
function taskItem(row: TaskRow, stale: boolean, open: (row: TaskRow) => void, choose: ChooseAccount | null): Item {
  const start = (send: boolean, side: boolean) => (choose ? choose(row, { send, side }) : void startSessionFromTask(row.source, row.task, { send, side }));
  return {
    key: `task-${row.source}-${row.task.id}`, kind: 'task', label: row.task.title, hint: row.task.listName ?? '', task: { row, stale },
    run: () => open(row), keep: true, ...(choose ? { stays: true } : {}), side: () => start(false, true), send: (side) => start(true, side)
  };
}

/**
 * One connector's section: titled with its glyph and name (uppercase by CSS), the
 * rows it shows counted in task: mode; or, instead of rows, what it needs — a Connect / Reconnect row, a "Choose
 * <App> Databases…" row (its details in Settings › Connectors), or a line.
 */
function taskGroup(s: TaskSection, connectors: readonly ConnectorInfo[], q: PaletteQuery, now: number, open: (row: TaskRow) => void, choose: ChooseAccount | null): Group {
  const info = connectors.find((x) => x.id === s.source);
  const name = info?.name ?? CONNECTOR_NAMES[s.source];
  const base = { key: `tasks-${s.source}`, title: name, icon: CONNECTOR_ICONS[s.source], connector: s.source };
  const count = sectionCount(q, s);
  const command = (cmd: ConnectorCommand): Item => ({ key: cmd.key, kind: 'command', label: cmd.label, hint: '', icon: CONNECTOR_ICONS[cmd.id], run: () => runConnectorCommand(cmd) });
  switch (s.kind) {
    case 'loading': return { ...base, items: [], empty: t.tasks.loading };
    // One row instead of the tasks: Connect (not connected) or Reconnect (signed out).
    case 'connect': case 'reconnect': {
      const label = s.kind === 'connect' ? t.conn.cmd.connect(name) : t.conn.cmd.reconnect(name);
      return { ...base, items: [command({ key: `connector-${s.kind}-${s.source}`, id: s.source, action: s.kind, label })] };
    }
    case 'choose-sources': return {
      ...base,
      items: [{
        key: `choose-sources-${s.source}`, kind: 'command', label: chooseSourcesLabel(s.source, name), hint: t.tasks.chooseSourcesHint,
        icon: s.source === 'notion' ? 'database' : CONNECTOR_ICONS[s.source],
        run: () => { const st = useApp.getState(); st.setSettingsOpen('connectors'); st.openConnector(s.source); }
      }]
    };
    case 'connecting': return { ...base, items: [], empty: t.tasks.connecting(name) };
    // Offline with nothing fetched yet: not "No open tasks assigned to you".
    case 'offline': return { ...base, items: [], empty: t.conn.offlineNoTasks(name) };
    case 'unavailable': return { ...base, items: [], empty: info ? connectorView(info, now).line : t.conn.unavailable(name) };
    case 'tasks': return {
      ...base,
      title: s.stale && s.since !== undefined ? t.tasks.groupOffline(name, clockTime(s.since, now)) : name,
      items: s.rows.map((r) => taskItem(r, s.stale, open, choose)),
      empty: tasksEmptyLine(info, !!q.text),
      ...(count !== undefined ? { count } : {}),
      // notion: / jira: with a query: its search only reaches the databases or projects chosen in Settings.
      ...(onlyChosenNote(q, s.source) ? { note: onlyChosenNote(q, s.source)! } : {})
    };
  }
}

/**
 * A task's step in the palette: its actions, then (Paste into Session) the session to type it into, or (Start in New
 * Session… with two or more accounts) the account to start it as.
 */
interface TaskStep {
  row: TaskRow;
  step: 'actions' | 'paste' | 'account';
  /** Where to go back to: the query and the highlighted row. */
  query: string;
  active: number;
  /** The account step: how the session starts once picked (⌘ / ⌥ already pressed). */
  intent?: TaskIntent;
  /** The account step opened straight from the task's row (⌘↵ / ⌥↵): Escape goes back to the list. */
  fromList?: boolean;
}

/**
 * ⌘K / F1: a single search for sessions, tasks, files and commands; prefixes narrow it (> commands, @ sessions, :line,
 * resume:, task:).
 */
export function Palette({ onNewSession, onNewTerminal }: { onNewSession: () => void; onNewTerminal: () => void }) {
  const close = () => useApp.getState().setPaletteOpen(false);
  const [query, setQuery] = useState(() => useApp.getState().paletteQuery);
  const [files, setFiles] = useState<{ path: string; rel: string }[]>([]);
  const [active, setActive] = useState(0);
  const moved = usePointerGate();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const terminals = useApp((s) => s.terminals);
  // Ask about rows' hints: a new answer.
  const askThreads = useApp((s) => s.askThreads);
  const starting = useApp((s) => s.starting);
  const resumables = useApp((s) => s.resumables);
  const history = useApp((s) => s.history);
  const historyLoaded = useApp((s) => s.historyLoaded);
  const project = useApp((s) => s.project);
  const activeFile = useApp((s) => s.openFiles.find((f) => f.path === s.activeTab) ?? null);
  const activeTab = useApp((s) => s.activeTab);
  const recentFiles = useApp((s) => s.recentFiles);
  const selected = useApp((s) => s.terminals.find((x) => x.id === s.selectedId) ?? null);
  const pinned = useApp((s) => !!s.selectedId && s.pins.includes(s.selectedId));
  // Add / Remove Current File to Shelf follows the shelf.
  const shelfItems = useApp((s) => s.shelf);
  const profiles = useApp((s) => s.daemon.profilesAvailable);
  const accounts = useAccounts();
  const shells = useApp((s) => s.shells);
  const grouped = useApp((s) => s.groupByState);
  const comments = useApp((s) => s.comments);
  const langOverrides = useApp((s) => s.langOverrides);
  const prs = useApp((s) => s.prs);
  const panesOpen = useApp((s) => s.split.panes.length);
  const connectors = useApp((s) => s.connectors);
  const taskLists = useApp((s) => s.taskLists);
  // A terminal's selection on its way to another terminal.
  const sending = useApp((s) => s.paletteSend);
  // Scheduled prompts: every project's, for the scheduled: mode.
  const schedules = useApp((s) => s.schedules);
  // Source Control commands that need a repository: only when the project has one.
  const hasRepos = useApp((s) => s.repos.length > 0 || (s.scmRepos?.length ?? 0) > 0);
  const scmView = useApp((s) => s.scmView);
  const repoCount = useApp((s) => s.scmRepos?.length ?? s.repos.length);
  const scmViewCmd = viewCommand(scmView, repoCount);
  const scmDefault = useApp((s) => (s.scmRepo ? s.scmRefs[s.scmRepo]?.defaultBranch?.base ?? null : null));
  // Fetch commands: only when some repository of the project has a remote.
  const canFetch = useApp((s) => Object.values(s.scmRefs).some((r) => r.hasRemote) || s.repos.some((r) => !!r.upstream) || !!s.scmRepos?.some((e) => !!e.status?.upstream));
  // "Fetch" acts on the selected repository: only when that one has a remote.
  const canFetchSelected = useApp((s) => !!s.scmRepo && mayFetch(s.scmRepo));
  // The Git menu's commands: what they act on and whether they show, as strings and flags so the
  // list only rebuilds when one changes; the focused session's sure files for "Commit <session>'s Work…".
  const gitWrites = useApp((s) => s.settings.gitActions === 'on');
  const gitMessages = useApp((s) => s.settings.commitMessages !== 'off');
  const gitUndo = useApp((s) => s.settings.gitActions === 'on' && lastUndo(s) !== null);
  const gitRepo = useApp((s) => commandRepo(s));
  const gitRepoName = useApp((s) => (gitRepo ? s.repos.find((r) => r.root === gitRepo)?.name ?? s.scmRepos?.find((e) => e.root === gitRepo)?.name ?? folderName(gitRepo) : ''));
  const gitRemote = useApp((s) => !!gitRepo && mayFetch(gitRepo));
  const workFiles = useApp((s) => (gitWrites && selected?.session ? sessionWork(s, selected.id).length : 0));
  const gitCmds = useMemo(() => gitPaletteCommands({
    hasRepos, writes: gitWrites, messages: gitMessages, undo: gitUndo, repo: gitRepo ? { root: gitRepo, name: gitRepoName } : null, remote: gitRemote, anyRemote: canFetch,
    work: selected && workFiles > 0 ? { id: selected.id, title: selected.title, files: workFiles } : null
  }), [hasRepos, gitWrites, gitMessages, gitUndo, gitRepo, gitRepoName, gitRemote, canFetch, selected, workFiles]);
  // The linked worktrees (their review commands): a string, so the list only rebuilds when they change.
  const worktreeKey = useApp((s) => s.repos.filter(isWorktree).map((r) => `${r.root}:${r.branch}:${r.merge ? 1 : 0}`).join('\n'));
  // Docker: its commands while the view is shown, its containers as results by name.
  const dockerShow = useApp((s) => s.settings.showDocker);
  const dockerOthers = useApp((s) => s.settings.dockerOthers);
  const dockerEngine = useDocker((s) => s.engine.state);
  const dockerContainers = useDocker((s) => s.containers);
  const dockerCmds = useMemo<Item[]>(() => {
    if (!dockerShown(dockerShow, dockerEngine)) return [];
    const cmd = (key: string, label: string, hint: string, run: () => void): Item => ({ key, kind: 'command', label, hint, icon: 'whale', run });
    const mine = project && dockerEngine === 'running' ? groupContainers(dockerContainers, project, false).mine : [];
    return [
      cmd('v-docker', t.cmd.viewDocker, kbd('⌃⇧D'), () => useApp.getState().setActivity('docker')),
      ...(dockerEngine === 'running' ? [cmd('docker-overview', t.cmd.dockerOverview, '', openOverview)] : []),
      ...mine.map((g) => cmd(`docker-stack-${g.project}`, t.cmd.dockerStack, g.project, () => openStack(g.project)))
    ];
  }, [dockerShow, dockerEngine, dockerContainers, project]);
  const dockerItems = useMemo<Item[]>(() => {
    if (!dockerShown(dockerShow, dockerEngine) || dockerEngine !== 'running' || !project) return [];
    const g = groupContainers(dockerContainers, project, dockerOthers);
    const list = [...g.mine.flatMap((x) => x.containers), ...g.others.flatMap((x) => x.containers), ...g.standalone];
    return list.flatMap((c): Item[] => [
      { key: `dk-${c.id}`, kind: 'command', label: c.name, hint: `${c.project ?? t.docker.standalone} · ${t.docker.palette.logs}`, icon: 'whale', run: () => openContainer(c.id, 'logs'), side: () => openContainer(c.id, 'inspect'), sideLabel: t.docker.palette.inspect },
      ...(hasProblem(c) ? [{ key: `dk-ask-${c.id}`, kind: 'command' as const, label: `${c.name} · ${t.docker.palette.ask}`, hint: c.project ?? '', icon: 'sparkle' as const, run: () => void askWhyCrashed(c) }] : [])
    ]);
  }, [dockerShow, dockerEngine, dockerContainers, dockerOthers, project]);
  // Redis: its commands while the view is shown, its queues as results by name.
  const redisShow = useApp((s) => s.settings.showRedis);
  const redisSnap = useRedis((s) => s.snap);
  const redisQueues = useRedis((s) => s.status?.queues ?? null);
  const redisRunning = !!redisSnap?.instances.some((i) => i.key === redisSnap.pick && i.state === 'running');
  const redisDenied = useRedis((s) => s.status?.denied.includes('info') ?? false);
  const redisCmds = useMemo<Item[]>(() => {
    if (!redisShown(redisShow, redisSnap)) return [];
    const cmd = (key: string, label: string, hint: string, run: () => void): Item => ({ key, kind: 'command', label, hint, icon: 'redis', run });
    return [
      cmd('v-redis', t.cmd.viewRedis, kbd('⌃⇧R'), () => useApp.getState().setActivity('redis')),
      ...(redisRunning && !redisDenied ? [cmd('redis-overview', t.cmd.redisOverview, '', () => openRedis('overview')), cmd('redis-live', t.cmd.redisLive, '', () => openRedis('live'))] : []),
      ...(redisRunning && redisQueues?.length ? [cmd('redis-queues', t.cmd.redisQueues, '', () => openRedis('queues'))] : [])
    ];
  }, [redisShow, redisSnap, redisRunning, redisQueues, redisDenied]);
  const redisItems = useMemo<Item[]>(() => {
    if (!redisShown(redisShow, redisSnap) || !redisRunning || !redisQueues) return [];
    return redisQueues.flatMap((q): Item[] => [
      { key: `rq-${q.id}`, kind: 'command', label: q.name, hint: t.redis.palette.show, icon: 'redis', run: () => openQueue(q.id) },
      ...((q.counts.failed ?? 0) > 0 ? [{ key: `rq-ask-${q.id}`, kind: 'command' as const, label: `${q.name} · ${t.redis.palette.ask}`, hint: '', icon: 'sparkle' as const, run: () => void askJobs(q.id) }] : [])
    ]);
  }, [redisShow, redisSnap, redisRunning, redisQueues]);
  // Databases: the view and Add Connection… unless Never, Overview with a connection in use;
  // that connection's tables as results, from a module the palette loads (never the first paint).
  const dbShow = useApp((s) => s.settings.showDatabases);
  const dbConn = useDb((s) => liveConn(dbShow, s.snap));
  const dbCatalog = useDb((s) => s.snap.catalog);
  const [dbTables, setDbTables] = useState<typeof import('../databases/palette') | null>(null);
  const dbLive = !!dbConn;
  useEffect(() => {
    if (dbLive) void import('../databases/palette').then(setDbTables, (e: unknown) => console.warn('Databases: the palette\'s tables did not load', e));
  }, [dbLive]);
  const dbCmds = useMemo<Item[]>(() => {
    if (dbShow === 'never') return [];
    const cmd = (key: string, label: string, hint: string, run: () => void): Item => ({ key, kind: 'command', label, hint, icon: 'databases', run });
    return [
      cmd('v-databases', t.cmd.viewDatabases, kbd('⌃⇧B'), () => useApp.getState().setActivity('databases')),
      cmd('db-add', t.cmd.dbAdd, '', () => { useApp.getState().setActivity('databases'); useDb.getState().setSheet({ kind: 'add', step: 1 }); }),
      ...(dbConn ? [cmd('db-overview', t.cmd.dbOverview, dbConn.conn.name, () => openDbOverview(dbConn.conn.id))] : [])
    ];
  }, [dbShow, dbConn]);
  // task: / clickup: / notion: — what each connector's own search found beyond its cached list.
  const [found, setFound] = useState<Partial<Record<ConnectorId, TaskSummary[]>>>({});
  // A task picked with Enter: its actions, then the sessions for Paste into Session.
  const [taskStep, setTaskStep] = useState<TaskStep | null>(null);
  // The list as it is now (its query and highlighted row), for a step opened from a row: the rows' callbacks are made
  // once per list, not at every highlight.
  const listAt = useRef({ query, active });
  listAt.current = { query, active };
  // Going back to the list highlights the task it came from (the query change would reset it to the first row).
  const restoreActive = useRef<number | null>(null);
  const openTask = (row: TaskRow) => { setTaskStep({ row, step: 'actions', ...listAt.current }); setQuery(''); setActive(0); };
  // With two or more Claude accounts: a task's account step, on the account set for
  // new sessions — from its actions, or straight from its row (⌘↵ / ⌥↵).
  const multiAccount = hasAccounts(accounts);
  const toAccount = (row: TaskRow, intent: TaskIntent, from: TaskStep | null) => {
    const initial = accountChoices(accounts, [], null, null).initial;
    setTaskStep(from ? { ...from, step: 'account', intent } : { row, step: 'account', ...listAt.current, intent, fromList: true });
    if (listAt.current.query !== '') restoreActive.current = initial;
    setQuery('');
    setActive(initial);
  };
  /** Escape / Backspace in an empty field: one step back (sessions or account → actions → the list it came from). */
  const back = () => {
    if (!taskStep) return;
    if (taskStep.step === 'paste' || (taskStep.step === 'account' && !taskStep.fromList)) { setTaskStep({ ...taskStep, step: 'actions' }); setQuery(''); setActive(0); return; }
    restoreActive.current = taskStep.active;
    setActive(taskStep.active);
    setQuery(taskStep.query);
    setTaskStep(null);
  };

  // Tasks again on open: main refreshes a list older than 60 s in the background.
  useEffect(() => { input.current?.focus(); void window.atelier.files.index().then(setFiles).catch(() => {}); loadTaskLists(); }, []);
  // ⌘⇧N with the palette already open: changes the filter, also when it already started with the same query.
  const ask = useApp((s) => s.paletteAsk);
  const firstAsk = useRef(ask);
  useEffect(() => {
    if (ask === firstAsk.current) return;
    const asked = useApp.getState().paletteQuery;
    // A new request (⌘⇧N, Start Session from Task…) leaves a task's actions.
    if (asked) { setTaskStep(null); setQuery(asked); input.current?.focus(); }
  }, [ask]);

  const commands: Item[] = useMemo(() => {
    const st = useApp.getState();
    // The text editor of the tab in front (files and files at a commit), if any: Find, and Replace when editable.
    const findTarget = activeFindTarget();
    // Find in the terminal: the terminal tab in front.
    const frontKey = st.activeKey();
    const frontTerm = frontKey?.startsWith('t:') ? frontKey.slice(2) : null;
    const c = (key: string, label: string, hint: string, icon: IconName, run: () => void): Item => ({ key, kind: 'command', label, hint, icon, run });
    // Pin or unpin the selected session or terminal (its sidebar row goes to the top of its list).
    // Continue on phone: the selected Claude session (when its prompt isn't free, the hint and picking it say why).
    // Session panel: the selected session's model, mode, quick actions and configuration.
    const panel = selected?.session ? [c('session-panel', t.panel.open, selected.session.model ?? '', 'sliders', () => openSessionPanel(selected.id))] : [];
    // Ask: the selected session's (an ended one whose panel is open too), and a Catch me
    // up there.
    const askThis = selected && (selected.session || st.askOpen[selected.id]) && !st.poppedOut.includes(`t:${selected.id}`)
      ? [
        c('ask-session', t.companion.menu, `${selected.title}  ${kbd('⌘I')}`, 'ask', () => setTimeout(() => openAskFor(selected.id), 0)),
        c('ask-catch-up', t.companion.catchUpCommand, selected.title, 'resume', () => setTimeout(() => catchUpFor(selected.id), 0))
      ] : [];
    // Restart Session: the selected session; and every session with new MCP servers.
    const added = Object.keys(st.mcpAdded).filter((id) => st.terminals.some((x) => x.id === id && x.session) && !st.restarts[id]);
    const restart = [
      ...(selected?.session && !st.restarts[selected.id] ? [c('restart-session', panelAvailability(selected) === 'ok' ? t.restart.action : t.restart.whenDone, st.mcpAdded[selected.id]?.join(', ') ?? '', 'restart', () => restartFromMenu(selected.id))] : []),
      ...(added.length > 0 ? [c('restart-new-mcp', t.restart.paletteAll(added.length), t.restart.paletteAllHint, 'plug', () => st.restartWithNewMcp())] : [])
    ];
    // Context usage: what fills the selected session's context.
    const contextCmd = selected?.session ? [c('context-usage', t.context.palette, selected.title, 'pie', () => openContextSheet(selected.id))] : [];
    const phone = selected?.session ? [c('continue-on-phone', t.cmd.continueOnPhone, remoteReason(remoteAvailability(selected)) ?? '/remote-control', 'phone', () => continueOnPhone(selected.id))] : [];
    // Command blocks: the selected plain terminal's commands, when it has any.
    const blocks = selected && !selected.session ? commandBlocks(selected.id) : null;
    const last = blocks?.lastFinished() ?? null;
    const blockCmds = blocks ? [
      c('block-prev', t.blocks.prev, kbd('⌘↑'), 'chevron', () => { blocks.jump('prev'); setTimeout(() => focusTerminal(selected!.id), 0); }),
      c('block-next', t.blocks.next, kbd('⌘↓'), 'chevron', () => { blocks.jump('next'); setTimeout(() => focusTerminal(selected!.id), 0); }),
      ...(last ? [c('block-copy-output', t.cmd.copyLastOutput, last.command, 'terminal', () => blocks.copyOutput(last))] : [])
    ] : [];
    // The selected session's pull request, also reachable from the keyboard.
    const pr = selected?.session ? prShown(st.prs.terminals[selected.id], st.settings.prStatus) : null;
    const prEntry = selected ? st.prs.terminals[selected.id] : undefined;
    const prCmds = pr && prEntry ? [
      c('pr-open', t.cmd.openPr(pr.number), pr.title, prGlyph(pr), () => void window.atelier.prs.open(prEntry.root, prEntry.branch, false)),
      c('pr-checks', t.cmd.openChecks(pr.number), '', 'check', () => void window.atelier.prs.open(prEntry.root, prEntry.branch, true))
    ] : [];
    // Split view; the pane commands only while there are panes. Moving the tab in front: while
    // it has somewhere to go (a pane on that side, or room and company for a new one there).
    const moveTab = (dir: 1 | -1) => canMoveStep(st.split, st.tabOrder, st.activeKey(), dir);
    const tabMoves = [
      ...(moveTab(-1) ? [c('move-tab-left', t.cmd.moveTabLeft, kbd('⌃⌘←'), 'split', () => st.moveTabStep(-1))] : []),
      ...(moveTab(1) ? [c('move-tab-right', t.cmd.moveTabRight, kbd('⌃⌘→'), 'split', () => st.moveTabStep(1))] : [])
    ];
    const panes = st.split.panes.length > 1 ? [
      c('focus-next-pane', t.cmd.focusNextPane, kbd('⌘⌥→'), 'splitFocus', st.focusNextPane),
      c('focus-prev-pane', t.cmd.focusPrevPane, kbd('⌘⌥←'), 'splitFocus', st.focusPrevPane),
      c('close-pane', t.cmd.closePane, '', 'unsplit', () => st.closePane()),
      c('close-other-panes', t.cmd.closeOtherPanes, '', 'unsplit', st.closeOtherPanes),
      c('equalize-panes', t.cmd.equalizePanes, '', 'split', st.equalizePanes)
    ] : [];
    const splitCmds = [c('split-right', t.cmd.splitRight, kbd('⌘\\'), 'split', st.splitRight), ...tabMoves, ...panes];
    // Tab pop-out windows: the tab in front, in a window of its own.
    const front = st.activeKey();
    const moveCmds = front ? [
      c('move-tab-window', t.popout.moveTab, kbd('⌘⇧O'), 'window', () => void useApp.getState().popOut(front, 'cascade', paneSize())),
      // Another project's window: files and plain terminals.
      ...moveToWindowCommands(front).map((w) => c(`move-to-window:${w.root}`, w.label, '', 'window', () => void moveToWindow(front, w.root)))
    ] : [];
    // The Shelf: the project file in front.
    const shelfCmd = shelfCommand();
    const shelf = shelfCmd ? [c('shelf', shelfCmd.label, '', 'shelf', shelfCmd.run)] : [];
    const pin = selected ? [c('pin', selected.session ? (pinned ? t.cmd.unpinSession : t.cmd.pinSession) : (pinned ? t.cmd.unpinTerminal : t.cmd.pinTerminal), '', 'pin', () => st.togglePinned(selected.id))] : [];
    // Worktrees in Changes: as each worktree's menu, its review, and its comparison when it has commits to merge.
    const worktrees = worktreeCommands(st.repos).map((w) => (w.kind === 'review'
      ? c(w.key, t.cmd.reviewWorktree(w.name), w.branch, 'branchOff', () => st.openReview(w.scope))
      : c(w.key, t.cmd.compareWorktree(w.name, w.base), w.branch, 'compare', () => st.openReview(w.scope, { againstMain: true }))));
    const waitingHere = st.project ? st.resumables.filter((r) => r.projectRoot === st.project!.root) : [];
    const pinnedHere = waitingHere.filter((r) => st.pins.includes(r.id)).length;
    // Scheduled prompts: into the selected session, and the list of every project's.
    const schedWhy = selected?.session ? scheduleBlock(selected) : null;
    const sched = [
      ...(selected?.session ? [c('schedule-prompt', t.sched.action, schedWhy ?? `${t.sched.paletteIn(selected.title)}  ${kbd('⌘⌥↵')}`, 'sendLater', scheduleSelected)] : []),
      c('scheduled-prompts', t.sched.list, '', 'clock', () => setTimeout(() => useApp.getState().setPaletteOpen(true, 'scheduled:'), 0))
    ];
    return [
      c('new-session', t.cmd.newSession, kbd('⌘N'), 'sparkle', onNewSession), c('new-terminal', t.cmd.newTerminal, kbd('⌘T'), 'terminal', onNewTerminal),
      ...sched,
      c('resume', t.cmd.resume, kbd('⌘⇧N'), 'resume', () => setTimeout(() => useApp.getState().setPaletteOpen(true, 'resume:'), 0)),
      // Only while sessions wait under Resume in this project.
      ...(waitingHere.length > 0 && !st.bulkResume ? [c('resume-all', t.cmd.resumeAll, `${waitingHere.length}`, 'resume', () => void useApp.getState().resumeAll('all'))] : []),
      ...(pinnedHere > 0 && !st.bulkResume ? [c('resume-pinned', t.cmd.resumePinned, `${pinnedHere}`, 'pin', () => void useApp.getState().resumeAll('pinned'))] : []),
      c('changes', t.cmd.toggleChanges, kbd('⌘⇧M'), 'git', st.toggleChanges), ...worktrees,
      c('sidebar', t.cmd.toggleSidebar, kbd('⌘B'), 'sidebar', st.toggleSidebar),
      c('changes-expand', t.cmd.toggleChangesFolders, st.changesExpanded ? t.paletteOn : '', 'expand', () => { st.toggleChangesExpanded(); if (!useApp.getState().showChanges) st.toggleChanges(); }),
      c('change-theme', t.cmd.changeTheme, themeOf(st.settings.theme).name, 'appearance', () => useApp.getState().setThemeSheet(true)),
      c('change-terminal-font', t.cmd.changeTerminalFont, st.settings.terminalFontFamily, 'terminal', () => useApp.getState().setFontSheet(true)),
      c('swap-side-panels', t.cmd.swapSidePanels, st.settings.swapSidePanels ? t.paletteOn : '', 'split', () => void window.atelier.settings.set({ swapSidePanels: !useApp.getState().settings.swapSidePanels })),
      // Session avatars.
      c('session-avatars', t.cmd.sessionAvatars, st.settings.sessionAvatars ? t.paletteOn : '', 'sessions', () => void window.atelier.settings.set({ sessionAvatars: !useApp.getState().settings.sessionAvatars })),
      // Word wrap in every editor; ⌥Z in an editor.
      c('word-wrap', t.cmd.wordWrap, `${st.settings.wordWrap ? `${t.paletteOn}  ` : ''}${kbd('⌥Z')}`, 'wrap', toggleWordWrap),
      c('v-sessions', t.cmd.viewSessions, kbd('⌘⇧1'), 'sessions', () => st.setActivity('sessions')), c('v-files', t.cmd.viewFiles, kbd('⌘⇧2'), 'files', () => st.setActivity('files')),
      // Find in Files, once the palette has closed (the field takes the keyboard); its F4 keys while there are results.
      c('find-in-files', t.cmd.findInFiles, kbd('⌘⇧F'), 'search', () => setTimeout(() => openFindInFiles(), 0)),
      ...(hasSearchResults() ? [
        c('next-search-result', t.cmd.nextResult, 'F4', 'chevronDown', () => setTimeout(() => stepSearchResult(1, false), 0)),
        c('prev-search-result', t.cmd.prevResult, kbd('⇧F4'), 'chevronUp', () => setTimeout(() => stepSearchResult(-1, false), 0))
      ] : []),
      ...(servicesView(st.settings.showServices) ? [c('v-services', t.cmd.viewServices, kbd('⌘⇧3'), 'services', () => st.setActivity('services'))] : []), c('terminal', t.cmd.showTerminal, kbd('⌘0'), 'terminal', st.showTerminal),
      ...(selected ? [c('redraw-terminal', t.cmd.redrawTerminal, '', 'terminal', () => redrawTerminal(selected.id))] : []),
      c('v-scm', t.cmd.viewScm, kbd('⌃⇧G'), 'git', () => st.setActivity('scm')),
      ...dockerCmds,
      ...redisCmds,
      ...dbCmds,
      // Automations, once turned on in Settings (2026-11-02).
      ...(st.settings.automationsEnabled ? [
        c('v-automations', t.cmd.viewAutomations, kbd('⌘⇧A'), 'automation', () => st.setActivity('automations')),
        c('new-automation', t.auto.newOneDots, '', 'automation', newAutomation),
        c('all-automations', t.cmd.allAutomations, '', 'automation', () => st.openAutomations(null)),
        c('pause-automations', st.settings.automationsPaused ? t.auto.resumeAll : t.auto.pauseAll, '', 'pause', () => setPaused(!useApp.getState().settings.automationsPaused))
      ] : []),
      c('show-background', t.bg.palette, kbd('⌘⌥B'), 'bolt', showBackground),
      ...(hasRepos ? [
        c('scm-history', t.cmd.showHistory, '', 'commit', () => void withScm(() => showHistory('all'))),
        // The other Source Control view, with Source Control shown.
        ...(scmViewCmd ? [c(scmViewCmd.key, scmViewCmd.to === 'all' ? t.scm.all.showAll : t.scm.all.showOne, '', scmViewCmd.to === 'all' ? 'repoAll' : 'repoOne', () => {
          st.setActivity('scm');
          useApp.getState().setScmView(scmViewCmd.to);
        })] : []),
        // The switcher lives in the One view: from All, it goes back there first.
        c('scm-switch', t.cmd.switchRepo, '', 'git', () => setTimeout(() => void withScm(() => {
          if (useApp.getState().scmView === 'all') useApp.getState().setScmView('one');
          useApp.getState().setScmSwitcherOpen(true);
        }), 0)),
        c('scm-ref', t.cmd.refHistory, '', 'tag', () => setTimeout(() => void withScm(() => useApp.getState().setRefPicker({ mode: 'scope' })), 0)),
        c('scm-compare', t.cmd.compareDefault(scmDefault ?? 'main'), '', 'compare', () => setTimeout(() => void withScm(() => {
          const def = defaultRef(useApp.getState().scmRepo);
          if (def) useApp.getState().setRefPicker({ mode: 'compare', base: def.name });
        }), 0)),
        ...(canFetch ? [
          ...(canFetchSelected ? [c('scm-fetch', t.cmd.fetch, '', 'fetch', fetchSelected)] : []),
          c('scm-fetch-all', t.cmd.fetchAll, '', 'fetch', () => void fetchAll())
        ] : [])
      ] : []),
      ...gitCmds.map((g) => c(g.key, g.label, g.hint, g.icon, () => runPaletteGit(g))),
      c('attention', t.cmd.nextAttention, kbd('⌘J'), 'bell', goToAttention),
      c('settings', t.cmd.openSettings, kbd('⌘,'), 'settings', () => st.setSettingsOpen('appearance')),
      // Launch flags: Settings › Claude at the flags.
      c('launch-flags', t.flags.command, '', 'flag', () => setTimeout(() => openLaunchFlags(), 0)),
      // Claude Code compatibility: Settings › Claude at that row.
      c('claude-compat', t.cmd.claudeCompat, '', 'pulse', () => setTimeout(() => openClaudeCompat(), 0)),
      c('new-window', t.cmd.newWindow, kbd('⌃⌘N'), 'plus', () => void window.atelier.newWindow()),
      c('open-folder', t.cmd.openFolder, kbd('⌘O'), 'folderOpen', () => void window.atelier.openFolder()),
      // Only when searching: the empty palette keeps its eleven most used commands.
      // Open any file: Open File…, the `atelier` shell command.
      c('open-file', t.cmd.openFile, kbd('⌘⌥O'), 'files', () => void window.atelier.files.openPicker().catch(() => {})),
      ...(shellCommand() ? [
        c('install-shell-command', t.cmd.installShellCommand, '', 'terminal', () => void runShellCommand('install')),
        c('uninstall-shell-command', t.cmd.uninstallShellCommand, '', 'terminal', () => void runShellCommand('uninstall'))
      ] : []),
      // Tasks → sessions: the palette on its tasks.
      // The release notes since this version came out.
      c('whats-new', t.wn.command, '', 'sparkle', () => useApp.getState().setWhatsNew({ since: null })),
      // Every connector's tasks: a neutral glyph, not one connector's.
      c('start-from-task', t.tasks.startFromTask, t.tasks.startFromTaskHint, 'list', () => setTimeout(() => useApp.getState().setPaletteOpen(true, 'task:'), 0)),
      // One connector's tasks: the palette on its prefix, while it can be searched.
      ...liveConnectors(connectors).map((id) => c(`search-tasks-${id}`, searchInLabel(id, connectors.find((x) => x.id === id)?.name ?? CONNECTOR_NAMES[id]),`${id}:`, CONNECTOR_ICONS[id],
        () => setTimeout(() => useApp.getState().setPaletteOpen(true, `${id}:`), 0))),
      c('session-in-folder', t.cmd.sessionInFolder, kbd('⌘⌥⇧N'), 'files', () => st.setFolderSheet({ kind: 'session' })),
      c('terminal-in-folder', t.cmd.terminalInFolder, '', 'files', () => st.setFolderSheet({ kind: 'terminal' })),
      c('new-file', t.cmd.newFile, kbd('⌘⌥N'), 'plus', st.newUntitled),
      // Change Language Mode: for the file (or untitled) tab in front; the hint says its language now.
      ...(activeFile ? [c('change-language', t.cmd.changeLanguage, languageLabel(effectiveLanguage(activeFile.path, langOverrides)) ?? t.plain, 'code', () => useApp.getState().setLanguageSheet(activeFile.path))] : []),
      // Markdown preview: the Markdown tab in front; the outline switch always.
      ...(activeFile && isMarkdownTab(activeFile.path, langOverrides) ? [
        c('md-toggle', t.cmd.mdToggle, kbd('⇧⌘V'), 'eye', togglePreview),
        c('md-split', t.cmd.mdSplit, '', 'split', () => setActivePreviewView('split')),
        c('md-source', t.cmd.mdSource, '', 'code', () => setActivePreviewView('source'))
      ] : []),
      // JSON navigation: the JSON tab in front.
      ...(activeFile && isJsonTab(activeFile.path, langOverrides) ? [
        c('json-toggle', t.cmd.jsonToggle, kbd('⇧⌘V'), 'tree', togglePreview),
        c('json-split', t.cmd.jsonSplit, '', 'split', () => setActivePreviewView('split')),
        c('json-source', t.cmd.jsonSource, '', 'code', () => setActivePreviewView('source')),
        c('json-fold-all', t.cmd.jsonFoldAll, kbd('⌃⌥['), 'collapseAll', () => setTimeout(() => activeJsonTarget()?.foldAll(), 0)),
        c('json-unfold-all', t.cmd.jsonUnfoldAll, kbd('⌃⌥]'), 'unfoldAll', () => setTimeout(() => activeJsonTarget()?.unfoldAll(), 0)),
        ...[1, 2, 3].map((n) => c(`json-fold-${n}`, t.cmd.jsonFoldLevel(n), '', 'collapseAll', () => setTimeout(() => activeJsonTarget()?.foldLevel(n), 0))),
        c('json-copy-path', t.cmd.jsonCopyPath, kbd('⌥⇧⌘C'), 'copy', () => setTimeout(() => activeJsonTarget()?.copyPath(), 0))
      ] : []),
      // CSV viewer: the CSV tab in front.
      ...(activeFile && isCsvTab(activeFile.path, langOverrides) ? [
        c('csv-toggle', t.cmd.csvToggle, kbd('⇧⌘V'), 'table', togglePreview),
        c('csv-split', t.cmd.csvSplit, '', 'split', () => setActivePreviewView('split')),
        c('csv-source', t.cmd.csvSource, '', 'code', () => setActivePreviewView('source')),
        c('csv-go-to-row', t.cmd.csvGoToRow, kbd('⌃G'), 'arrowDown', () => setTimeout(() => activeCsvTarget()?.goToRow(), 0)),
        c('csv-options', t.cmd.csvOptions, '', 'sliders', () => setTimeout(() => activeCsvTarget()?.parseOptions(), 0)),
        c('csv-rainbow', t.cmd.csvRainbow, st.settings.csvRainbow ? t.paletteOn : '', 'appearance', () => void window.atelier.settings.set({ csvRainbow: !useApp.getState().settings.csvRainbow })),
        c('csv-align', t.cmd.csvAlign, st.settings.csvAlign ? t.paletteOn : '', 'wrap', () => void window.atelier.settings.set({ csvAlign: !useApp.getState().settings.csvAlign })),
        c('csv-summaries', t.cmd.csvSummaries, st.settings.csvSummaries ? t.paletteOn : '', 'pulse', () => void window.atelier.settings.set({ csvSummaries: !useApp.getState().settings.csvSummaries }))
      ] : []),
      c('md-outline', t.cmd.mdOutline, st.settings.markdownOutline ? t.paletteOn : '', 'outline', toggleMarkdownOutline),
      // Find and replace: the card of the file tab in front.
      ...(findTarget ? [c('find-in-file', t.cmd.findInFile, kbd('⌘F'), 'search', () => setTimeout(() => findInActiveTab(false), 0))] : []),
      ...(frontTerm ? [c('find-in-terminal', t.cmd.findInTerminal, terminalFindKeys(), 'search', () => setTimeout(() => requestTerminalFind(frontTerm), 0))] : []),
      ...(findTarget && !findTarget.readOnly ? [c('find-replace', t.cmd.findReplace, kbd('⌥⌘F'), 'swap', () => setTimeout(() => findInActiveTab(true), 0))] : []),
      ...(activeFile ? [c('next-change', t.cmd.nextChange, kbd('⌥F5'), 'chevronDown', () => goToChange(1)), c('prev-change', t.cmd.prevChange, kbd('⌥⇧F5'), 'chevronUp', () => goToChange(-1))] : []),
      c('reveal-in-finder', t.cmd.revealInFinder, kbd('⌘⌥R'), 'folderOpen', revealActive),
      c('collapse-folders', t.cmd.collapseFolders, '', 'collapseAll', () => { if (st.project) collapseAllFolders(st.project.root); st.setActivity('files', { reveal: false }); }),
      c('notifications', t.cmd.showNotifications, kbd('⌘⇧J'), 'bell', () => setTimeout(() => useApp.getState().setNotesOpen(true), 0)),
      // Output triggers: the center filtered to their matches, and their editor.
      c('trigger-matches', t.cmd.showTriggerMatches, '', 'bolt', () => setTimeout(() => useApp.getState().setNotesOpen(true, 'triggers'), 0)),
      c('edit-triggers', t.cmd.editTriggers, '', 'bolt', openTriggerSettings),
      c('group-by-state', t.cmd.groupByState, grouped ? t.paletteOn : '', 'inbox', () => { st.toggleGroupByState(); st.setActivity('sessions'); }),
      // Workspaces: the toggle always (a project window), the rest while they are on.
      ...(st.project && !st.popout && !st.settings.workspacesEverywhere ? [c('ws-toggle', t.ws.toggleCmd, st.ws?.on ? t.paletteOn : '', 'workspace', () => useApp.getState().setWorkspacesOn(!useApp.getState().ws?.on))] : []),
      ...(st.ws?.on && !st.popout ? [
        c('ws-new', t.ws.newWorkspace, kbd('⌘⌥T'), 'plus', () => setTimeout(() => useApp.getState().setWsSheet({}), 0)),
        c('ws-rename', t.ws.rename, '', 'edit', renameWorkspaceInFront),
        // The last workspace stays (its menu says why): nothing to close here.
        ...(workspacesOf(st.ws).length > 1 ? [c('ws-close', t.ws.close, '', 'x', closeWorkspaceInFront)] : []),
        c('ws-next', t.ws.nextCmd, '', 'chevronDown', () => stepWorkspace(1)),
        c('ws-prev', t.ws.prevCmd, '', 'chevronUp', () => stepWorkspace(-1))
      ] : []),
      // Activities: New Activity… while they are on, their switch while workspaces are on.
      ...wsActivityCommands().map((x) => c(x.key, x.label, x.hint, x.icon, x.run)),
      c('restart', t.cmd.restartDaemon, '', 'resume', () => void window.atelier.restartDaemon()),
      // Same as Atelier › Check for Updates…: the check runs in main, Settings › About shows its progress. On Windows
      // only where the Microsoft Store can be asked.
      ...(!offersCheck(useApp.getState().updateStatus) ? [] : [c('check-updates', t.cmd.checkUpdates, '', 'info', () => { void window.atelier.update.check(); setTimeout(() => useApp.getState().setSettingsOpen('about'), 0); })]),
      // Connectors: Connect / Reconnect / Disconnect / Refresh Tasks, only when they make sense now.
      ...connectorCommands(connectors).map((x) => c(x.key, x.label, connectors.find((k) => k.id === x.id)?.name ?? '', CONNECTOR_ICONS[x.id], () => runConnectorCommand(x))),
      // Terminal profiles: only with an atelierd that has them.
      ...paletteProfileCommands(shells, profiles).map((p) => c(p.key, p.label, '', 'terminal', () => void newTerminalIn(undefined, p.profile))),
      // Claude accounts: only with two or more; each opens New Session on that account.
      ...paletteAccountCommands(accounts).map((a) => ({ ...c(a.key, a.label, '', 'sparkle', () => useApp.getState().setNewSessionOpen(true, a.account)), dot: a.color })),
      ...(profiles && shellEnv() ? [
        c('reload-shell-env', t.cmd.reloadShellEnv, '', 'resume', () => void reloadShellEnv()),
        c('shell-env-auto', t.cmd.toggleShellEnvAuto, st.settings.shellEnvAutoReload ? t.paletteOn : '', 'resume', () => void window.atelier.settings.set({ shellEnvAutoReload: !useApp.getState().settings.shellEnvAutoReload }))
      ] : []),
      ...splitCmds,
      ...moveCmds,
      ...pin,
      ...shelf,
      ...panel,
      ...askThis,
      ...restart,
      ...contextCmd,
      ...phone,
      ...prCmds,
      ...blockCmds,
      c('command-blocks', t.cmd.toggleCommandBlocks, st.settings.commandBlocks ? t.paletteOn : '', 'terminal', () => void window.atelier.settings.set({ commandBlocks: !useApp.getState().settings.commandBlocks })),
      c('click-moves-cursor', t.cmd.toggleClickMovesCursor, st.settings.clickMovesCursor ? t.paletteOn : '', 'terminal', () => void window.atelier.settings.set({ clickMovesCursor: !useApp.getState().settings.clickMovesCursor })),
      // Session icons in the menu bar / notification area.
      c('tray-icons', trayCopy(currentPlatform()).command, st.settings.trayIcons ? t.paletteOn : '', 'bell', () => void window.atelier.settings.set({ trayIcons: !useApp.getState().settings.trayIcons })),
      // Review: every change, or one session's.
      c('review-all', t.cmd.reviewAll, '', 'review', () => st.openReview('all')),
      ...terminals.filter((x) => x.session).map((x) => c(`review-${x.id}`, t.cmd.reviewSession(x.title), '', 'review', () => useApp.getState().openReview(x.id))),
      // Send to session: sessions with comments waiting; when the prompt isn't free the hint says why.
      ...terminals.filter((x) => x.session && pendingFor(x.id) > 0).map((x) => c(`send-${x.id}`, t.comments.sendTo(x.title), sendReason(x.id) ?? t.comments.pending(pendingFor(x.id)), 'send', () => sendReview(x.id)))
    ];
  }, [onNewSession, onNewTerminal, selected, pinned, profiles, accounts, shells, grouped, terminals, comments, activeFile, activeTab, langOverrides, prs, panesOpen, connectors, hasRepos, scmDefault, canFetch, canFetchSelected, worktreeKey, dockerCmds, redisCmds, dbCmds, gitCmds, shelfItems, scmViewCmd?.key]);

  const wsOn = useApp((s) => !!s.ws?.on && !s.popout);
  const q = parseQuery(query, { workspaces: wsOn });
  // The tasks: one section per connector — its matching tasks while searching,
  // every task in task: mode (one connector's with clickup: / notion:), or what it needs.
  const taskGroups = useMemo((): Group[] => {
    if (q.mode !== 'all' && q.mode !== 'tasks') return [];
    const statuses = Object.fromEntries(connectors.map((x) => [x.id, x.status]));
    const sources = Object.fromEntries(connectors.map((x) => [x.id, x.sources ?? x.projects]));
    const now = Date.now();
    const sections = taskSections(taskLists, { mode: q.mode, ...(q.source ? { source: q.source } : {}), text: q.text, found, statuses, sources });
    return sections.map((s) => taskGroup(s, connectors, q, now, openTask, multiAccount ? (row, intent) => toAccount(row, intent, null) : null));
  }, [q.mode, q.source, q.text, taskLists, found, connectors, multiAccount, accounts]);
  // The connectors whose own search can run now: the search below runs again when one connects mid-query.
  const searchable = connectors.filter((x) => x.status === 'connected' && !noneChosen(x)).map((x) => x.id).join(',');
  // A query in task: / clickup: / notion: mode: each connected connector's own search too (that one's alone with a
  // prefix), for tasks beyond its cached list, after a pause in typing; each answer goes into its own section as it comes.
  useEffect(() => {
    setFound((f) => (Object.keys(f).length ? {} : f));
    if (q.mode !== 'tasks' || q.text.length < 2) return;
    const ids = (searchable ? searchable.split(',') as ConnectorId[] : []).filter((id) => !q.source || id === q.source);
    if (ids.length === 0) return;
    let current = true;
    const timer = setTimeout(() => {
      for (const id of ids) {
        void window.atelier.tasks.search(id, q.text).then((r) => { if (current) setFound((f) => ({ ...f, [id]: r })); }).catch(() => {});
      }
    }, 300);
    return () => { current = false; clearTimeout(timer); };
  }, [q.mode, q.source, q.text, searchable]);
  const sections = useMemo((): Group[] => {
    const text = q.text;
    if (sending) return sendSections(sending, query, terminals, starting);
    if (taskStep) {
      return taskStepSections(taskStep, query, terminals, starting, {
        toPaste: () => { setTaskStep({ ...taskStep, step: 'paste' }); setQuery(''); setActive(0); },
        accounts: multiAccount ? accounts : null,
        toAccount: (intent) => toAccount(taskStep.row, intent, taskStep)
      });
    }
    if (q.mode === 'tasks') return taskGroups;
    if (q.mode === 'scheduled') return scheduledSections(schedules, project?.root ?? '', text, terminals);
    if (q.mode === 'workspaces') return workspaceSections(text);
    if (q.mode === 'line') {
      const items: Item[] = activeFile && q.line ? [{ key: 'line', kind: 'line', label: t.goToLine(q.line), hint: activeFile.rel, icon: 'chevron', run: () => useApp.getState().openFile(activeFile.path, activeFile.rel, q.line, undefined, { preview: true }) }] : [];
      return [{ title: t.paletteLine, items, empty: activeFile ? t.paletteLineHint : t.paletteNoFile }];
    }
    if (q.mode === 'resume') {
      // Atelier's sessions left without a process, then Claude Code's own conversations of the project.
      const { sessions, conversations } = project ? resumeList(resumables, history, project.root) : { sessions: [], conversations: [] };
      if (sessions.length + conversations.length === 0) return [{ title: t.paletteResume, items: [], empty: resumeEmptyText(historyLoaded) }];
      const rs: Item[] = sessions.map((r) => ({
        key: `r-${r.id}`, kind: 'resume', label: r.title, hint: t.resume, color: r.color, ...(r.configDir ? { configDir: r.configDir } : {}),
        run: () => void useApp.getState().resume(r.id)
      }));
      const folderOf = (c: ClaudeConversation) => relativeCwd(c.cwd, project?.root, project?.realRoot);
      const now = Date.now();
      const cs: Item[] = searchConversations(conversations, text, folderOf).map((c) => {
        const hint = conversationHint(c, now);
        const dir = c.account ? accountById(accounts, c.account)?.dir : undefined;
        return {
          key: `h-${c.sessionId}`, kind: 'history', label: c.title, hint: hint.text, ...(dir ? { configDir: dir } : {}),
          conv: { branch: c.branch, folder: folderOf(c), cwd: c.cwd, prompt: c.prompt, active: hint.active },
          run: () => void resumeConversation(c.sessionId, c.account)
        };
      });
      const out: Group[] = [{ title: t.paletteResume, items: textFilter(rs, text, (s) => [s.label], 20) }, { title: t.paletteHistory, items: cs }].filter((s) => s.items.length > 0);
      return out.length ? out : [{ title: t.paletteResume, items: [], empty: t.paletteEmpty }];
    }
    const termItem = (kind: 'session' | 'terminal') => (x: TerminalInfo): Item => ({ key: `s-${x.id}`, kind, label: x.title, hint: x.session?.activity ?? x.foreground.split('/').at(-1) ?? '', color: x.color, run: () => useApp.getState().select(x.id), side: () => useApp.getState().openToSide(`t:${x.id}`) });
    const split = splitTerminals(terminals, starting);
    const sessions = split.sessions.map(termItem('session'));
    const plain = split.plain.map(termItem('terminal'));
    const fileItem = (key: string, f: { path: string; rel: string }): Item => ({
      key, kind: 'file', label: f.rel.split('/').at(-1) ?? f.rel, hint: f.rel,
      run: () => useApp.getState().openFile(f.path, f.rel, null, undefined, { preview: true }), side: () => useApp.getState().openFileToSide(f.path, f.rel)
    });
    const out: Group[] = [];
    if (q.mode === 'all' || q.mode === 'sessions') {
      out.push({ title: t.paletteSessions, items: fuzzyFilter(sessions, text, (s) => s.label, q.mode === 'sessions' ? 30 : 8) });
      out.push({ title: t.paletteTerminals, items: fuzzyFilter(plain, text, (s) => s.label, q.mode === 'sessions' ? 30 : 8) });
    }
    if (q.mode === 'all' && text) out.push({ title: t.docker.palette.group, items: fuzzyFilter(dockerItems, text, (c) => c.label, 6) });
    if (q.mode === 'all' && text) out.push({ title: t.redis.palette.group, items: fuzzyFilter(redisItems, text, (c) => c.label, 6) });
    if (q.mode === 'all' && text && dbTables) {
      // Every schema's tables; past main's cap, a line says how many were searched.
      const note = dbTables.paletteNote(dbCatalog);
      out.push({ title: t.db.palette.group, items: dbTables.paletteTables(dbCatalog, dbConn, text), ...(note ? { note } : {}) });
    }
    if (q.mode === 'all') out.push(...taskGroups);
    // Empty search: recently opened files first (index files only show up when searching).
    if (q.mode === 'all' && !text) {
      out.push({ title: t.paletteRecent, items: recentForPalette(recentFiles, activeFile?.path ?? null).map((f) => fileItem(`r-${f.path}`, f)) });
    }
    if (q.mode === 'all') out.push({ title: t.paletteFiles, items: fuzzyFilter(files, text, (f) => f.rel, text ? 40 : 0).map((f) => fileItem(`f-${f.path}`, f)) });
    if (q.mode === 'all' || q.mode === 'commands') out.push({ title: t.paletteCommands, items: fuzzyFilter(commands, text, (c) => c.label, q.mode === 'commands' ? 30 : text ? 6 : 11) });
    // Ask about: each Claude session of the project while searching, found as "Ask about
    // <name>", with one hint: a new answer, a question waiting for you, working.
    if ((q.mode === 'all' || q.mode === 'commands') && text) {
      const popped = useApp.getState().poppedOut;
      const rows = split.sessions.filter((x) => x.session && !popped.includes(`t:${x.id}`)).map((x): Item => {
        const h = askHint({ unseen: !!askThreads[x.session!.sessionId]?.unseen, wait: waitKind(x.session), working: effectiveState(x) === 'running' });
        return { key: `ask-${x.id}`, kind: 'session', label: x.title, hint: h?.text ?? '', ...(h?.tone ? { tone: h.tone } : {}), color: x.color, run: () => setTimeout(() => openAskFor(x.id), 0) };
      });
      out.push({ title: t.companion.askAboutSection, items: fuzzyFilter(rows, text, (i) => `${t.companion.askAboutSection} ${i.label}`, 6) });
    }
    return out.filter((s) => s.items.length > 0);
  }, [terminals, starting, files, commands, resumables, history, historyLoaded, accounts, project, activeFile, recentFiles, q.mode, q.text, q.line, taskGroups, taskStep, query, sending, dockerItems, redisItems, dbTables, dbCatalog, dbConn, schedules, askThreads]);
  // Claude's history is read when resume: opens (what is already known shows meanwhile).
  useEffect(() => { if (q.mode === 'resume') void refreshHistory(); }, [q.mode]);

  const flat = sections.flatMap((s) => s.items);
  useEffect(() => { setActive(restoreActive.current ?? 0); restoreActive.current = null; }, [query]);
  useEffect(() => { list.current?.querySelector('.palette-item.is-active')?.scrollIntoView({ block: 'nearest' }); }, [active]);
  // ⌥: Open to the Side when the item has it (sessions, terminals, files, tasks); ⌘ on a task also sends its prompt;
  // anything else runs as usual.
  const pick = (item: Item | undefined, side = false, send = false) => {
    if (!item) return;
    // A task's own Enter leads to its actions; ⌘ and ⌥ on it act at once (and close) — unless they lead to the account
    // step too (`stays`). A step with neither (Paste into Session…) just goes on, whatever the modifiers.
    if (!item.keep || (!item.stays && ((side && item.side) || (send && item.send)))) close();
    if (send && item.send) item.send(side);
    else (side && item.side ? item.side : item.run)();
  };
  const sideable = flat[active]?.side !== undefined;
  const onTask = !taskStep && flat[active]?.kind === 'task';
  const onNew = taskStep?.step === 'actions' && flat[active]?.key === 'task-new';
  const hasTasks = connectors.some((x) => x.status !== 'disconnected');
  // On a task in the everything search: the footer says how to see all tasks, or that task's connector's.
  // Anywhere else the usual footer (⌥↵ / Inspect, ↑↓ ↵).
  const taskKeys = onTask ? taskFooter(q.mode, flat[active]?.task?.row.source, liveConnectors(connectors)) : null;
  const now = Date.now();
  // A connector's section says its own empty line; the palette's own only when a single plain group has nothing.
  const empty = sections.length === 1 && !sections[0]!.connector && sections[0]!.items.length === 0 ? sections[0]!.empty : null;
  const shownNothing = flat.length === 0 && !sections.some((s) => s.connector);

  let n = -1;
  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette" role="dialog" aria-label={t.searchLabel} onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-search">
          <Icon name="search" size={15} />
          {sending ? <span className="palette-mode">{t.send.mode}</span> : taskStep
            ? <>
                {taskStep.row.task.displayId
                  ? <span className="palette-mode mono is-task" data-tip={taskStep.row.task.title}>{taskStep.row.task.displayId}</span>
                  // A task without an ID (a Notion database with no unique-ID column): its connector's glyph and title.
                  : <span className="palette-mode is-task has-glyph is-titled" data-tip={taskStep.row.task.title}>
                      <Icon name={CONNECTOR_ICONS[taskStep.row.source]} size={11} stroke={2.2} /><span>{taskStep.row.task.title}</span>
                    </span>}
                {taskStep.step === 'paste' && <span className="palette-mode">{t.tasks.pasteMode}</span>}
                {taskStep.step === 'account' && <span className="palette-mode">{t.tasks.accountMode}</span>}
              </>
            : q.source
              // clickup: / notion: — the connector's glyph and name.
              ? <span className="palette-mode has-glyph"><Icon name={CONNECTOR_ICONS[q.source]} size={11} stroke={2.2} />{t.tasks.sourceModes[q.source]}</span>
              : q.mode !== 'all' && <span className="palette-mode">{t.paletteModes[q.mode]}</span>}
          <input ref={input} className="palette-input" placeholder={sending ? (sending.newSession ? t.tasks.pickSession : t.send.pick) : taskStep ? (taskStep.step === 'actions' ? t.tasks.pickAction : taskStep.step === 'account' ? t.tasks.pickAccount : t.tasks.pickSession) : t.search} value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e.nativeEvent)) return;
              if (e.key === 'Escape') { if (taskStep) { e.preventDefault(); back(); } else close(); }
              else if (e.key === 'Backspace' && taskStep && query === '') { e.preventDefault(); back(); }
              else if (e.key === 'Backspace' && isMod(e) && flat[active]?.remove) { e.preventDefault(); flat[active]!.remove!(); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => stepActive(a, 1, flat.length)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => stepActive(a, -1, flat.length)); }
              else if (e.key === 'Enter') { e.preventDefault(); pick(flat[active], e.altKey, isMod(e) && !!flat[active]?.send); }
            }} />
          <span className="kbd mono" data-tip={taskStep ? t.tasks.back : undefined}>esc</span>
        </div>
        <div className="palette-list" ref={list}>
          {sending && <SendHead text={sending.text} />}
          {taskStep && <TaskHead row={taskStep.row} now={now} />}
          {sections.map((s) => (s.items.length > 0 || s.connector) && (
            <div key={s.key ?? s.title}>
              <div className={`palette-section ${s.icon ? 'has-glyph' : ''}`}>
                {s.icon && <Icon name={s.icon} size={12} stroke={2} />}
                {s.title}
                {s.count !== undefined && <span className="palette-count mono">{s.count}</span>}
              </div>
              {s.items.map((it) => {
                n++;
                const idx = n;
                if (it.task) {
                  const { row, stale } = it.task;
                  return (
                    <button key={it.key} type="button" className={`palette-item task-item ${idx === active ? 'is-active' : ''} ${stale ? 'is-stale' : ''}`}
                      onMouseMove={(e) => { if (moved(e)) setActive(idx); }} onClick={(e) => pick(it, e.altKey, isMod(e))}>
                      <TaskCells row={row} now={now} />
                    </button>
                  );
                }
                return (
                  <button key={it.key} type="button" className={`palette-item ${idx === active ? 'is-active' : ''} ${it.off ? 'is-off' : ''}`}
                    onMouseMove={(e) => { if (moved(e)) setActive(idx); }} onClick={(e) => pick(it, e.altKey, isMod(e) && !!it.send)}>
                    {(it.kind === 'session' || it.kind === 'resume') && <Avatar title={it.label} color={it.color ?? 'var(--violet)'} size={18} dim={it.kind === 'resume'} />}
                    {it.kind === 'file' && <FileIcon name={it.label} />}
                    {(it.kind === 'command' || it.kind === 'line') && (it.dot
                      ? <span className="palette-cmd is-account"><i className="palette-account-dot" style={{ '--acct': `var(--person-${it.dot})` } as CSSProperties} /></span>
                      : <span className="palette-cmd"><Icon name={it.icon ?? 'chevron'} size={11} stroke={2} /></span>)}
                    {it.kind === 'terminal' && <span className="palette-cmd"><Icon name="terminal" size={11} stroke={2} /></span>}
                    {it.kind === 'workspace' && (it.ws?.activity
                      ? <span className="palette-wsa-glyph" style={{ color: wsColorVar(it.ws.color) }}><Icon name="wsActivity" size={18} stroke={1.5} /></span>
                      : it.ws ? <WorkspaceGlyph color={it.ws.color} size={18} /> : <span className="palette-cmd"><Icon name="plus" size={11} stroke={2} /></span>)}
                    {it.kind === 'history' && <span className="palette-cmd is-conv"><Icon name="sessions" size={11} stroke={2} /></span>}
                    <span className={`palette-label ${it.conv ? 'is-conv' : ''}`} data-tip={it.conv && it.conv.prompt !== it.label ? it.conv.prompt : undefined}>{it.label}</span>
                    {it.configDir && <AccountChip configDir={it.configDir} />}
                    {it.ws && it.ws.dots.length > 0 && <span className="ws-dots palette-ws-dots" aria-hidden="true">{it.ws.dots.map((d) => <span key={d.kind} className={`ws-dot is-${d.kind}`}><i />{d.n}</span>)}</span>}
                    {it.conv?.folder && <span className="cwd-chip mono" data-tip={it.conv.cwd}><bdi dir="ltr">{truncateLeft(it.conv.folder, 14)}</bdi></span>}
                    {it.conv?.branch && <span className="branch-chip mono"><Icon name="git" size={10} stroke={1.8} /><span>{it.conv.branch}</span></span>}
                    {it.conv?.active
                      ? <span className="palette-hint mono is-live" data-tip={t.historyActiveTip}><i className="live-dot" aria-hidden="true" />{it.hint}</span>
                      : <span className={`palette-hint mono${it.tone ? ` is-${it.tone}` : ''}`}>{it.hint}</span>}
                  </button>
                );
              })}
              {s.connector && s.items.length === 0 && s.empty && <p className="empty palette-group-line">{s.empty}</p>}
              {s.note && <p className="empty palette-group-line">{s.note}</p>}
            </div>
          ))}
          {empty && <p className="empty">{empty}</p>}
          {!empty && shownNothing && <p className="empty">{t.paletteEmpty}</p>}
        </div>
        <div className="palette-foot">
          {sending ? (
            // The send step: Enter types the text, ⌘Enter types and runs it.
            <>
              <span className="palette-keys"><b className="mono">↵</b> {t.send.type}</span>
              <span className="palette-keys"><b className="mono">{kbd('⌘↵')}</b> {sending.newSession ? t.send.typeAndSend : t.send.typeAndRun}</span>
            </>
          ) : taskStep?.step === 'account' ? (
            // The account step: Enter starts as asked (⌘ / ⌥ already pressed on the way), ⌘Enter also sends.
            <>
              <span className="palette-keys"><b className="mono">↵</b> {taskStep.intent?.send ? (taskStep.intent.side ? t.tasks.startAndSendToSide : t.tasks.startAndSend) : taskStep.intent?.side ? t.tasks.startToSide : t.tasks.startKey}</span>
              {!taskStep.intent?.send && <span className="palette-keys"><b className="mono">{kbd('⌘↵')}</b> {t.tasks.startAndSend}</span>}
              <span className="palette-keys"><b className="mono">esc</b> {t.tasks.back}</span>
            </>
          ) : taskStep ? (
            // A task's steps: what Enter does here, that ⌘Enter also sends, and that Escape goes back.
            <>
              <span className="palette-keys"><b className="mono">↵</b> {taskStep.step === 'paste' ? t.tasks.paste : t.tasks.choose}</span>
              {(taskStep.step === 'paste' || onNew) && <span className="palette-keys"><b className="mono">{kbd('⌘↵')}</b> {taskStep.step === 'paste' ? t.tasks.pasteAndSend : t.tasks.startAndSend}</span>}
              <span className="palette-keys"><b className="mono">esc</b> {t.tasks.back}</span>
            </>
          ) : q.mode === 'workspaces' ? (
            // "#": go there, move the tab in front there, start a session in it.
            <>
              <span className="palette-keys"><b className="mono">↵</b> {t.ws.keyGo}</span>
              <span className="palette-keys"><b className="mono">{kbd('⌥↵')}</b> {t.ws.keyMove}</span>
              <span className="palette-keys"><b className="mono">{kbd('⌘↵')}</b> {t.ws.keySession}</span>
            </>
          ) : q.mode === 'scheduled' ? (
            // Scheduled prompts: Enter edits, ⌘Enter sends now, ⌘⌫ deletes (this project's).
            <>
              <span className="palette-keys"><b className="mono">↵</b> {t.sched.hintEdit}</span>
              <span className="palette-keys"><b className="mono">{kbd('⌘↵')}</b> {t.sched.hintSend}</span>
              <span className="palette-keys"><b className="mono">{kbd('⌘⌫')}</b> {t.sched.hintDelete}</span>
            </>
          ) : onTask ? (
            // On a task: Enter shows its actions; ⌘Enter starts a session and sends its prompt at once.
            <>
              <span className="palette-keys"><b className="mono">↵</b> {t.tasks.actionsKey}</span>
              <span className="palette-keys"><b className="mono">{kbd('⌘↵')}</b> {t.tasks.startAndSend}</span>
            </>
          ) : (
            <>
              <span><b className="mono">&gt;</b> {t.paletteModes.commands}</span>
              <span><b className="mono">@</b> {t.paletteModes.sessions}</span>
              <span><b className="mono">:</b> {t.paletteModes.line}</span>
              <span><b className="mono">resume:</b> {t.paletteModes.resume}</span>
              {hasTasks && <span><b className="mono">task:</b> {t.paletteModes.tasks}</span>}
            </>
          )}
          <span className="grow" />
          {taskKeys ? (
            // On a task in the everything search: every connector's tasks, or the highlighted one's.
            <>
              <span className="palette-keys"><b className="mono">task:</b> {t.tasks.allTasksKey}</span>
              {taskKeys.only && <span key={taskKeys.only} className="palette-keys"><b className="mono">{taskKeys.only}:</b> {t.tasks.onlyKey(connectors.find((x) => x.id === taskKeys.only)?.name ?? CONNECTOR_NAMES[taskKeys.only])}</span>}
            </>
          ) : (
            <>
              {/* ⌘Enter, when the highlighted result says what it does (a table: keep open). */}
              {flat[active]?.sendLabel && <span className="palette-keys"><b className="mono">{kbd('⌘↵')}</b> {flat[active]!.sendLabel}</span>}
              {/* Open to the Side: only said while the highlighted result can do it. */}
              <span className={`palette-side ${sideable ? '' : 'is-off'}`} aria-hidden={!sideable}><b className="mono">{kbd('⌥↵')}</b> {flat[active]?.sideLabel ?? t.paletteToSide}</span>
              <span className="mono">↑↓ ↵</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * scheduled:: every project's prompts, missed first, then by day; ↵ edits one of this
 * project (another project's opens that project), ⌘↵ sends it now, ⌘⌫ deletes it (Undo in the toast).
 */
/**
 * "#": the workspaces in order and, under each, its activities ("Workspace › Activity", while activities are on);
 * Enter goes there (a workspace: where it was left), ⌥Enter moves the tab in front there, ⌘Enter starts a session in
 * it. A name no workspace has offers New Workspace "name" (it starts with a Claude session).
 */
export function workspaceSections(text: string): Group[] {
  const s = useApp.getState();
  if (!s.ws?.on || s.popout || !s.project) return [{ title: t.ws.palette, items: [], empty: t.ws.paletteOff }];
  const ws = s.workspacesNow() ?? s.ws;
  const root = s.project.root;
  const files = s.openFiles.map((f) => f.path);
  // Files at a commit count as what a workspace holds too, as the sidebar's cards count them.
  const tabs = s.revFiles.map((f) => f.key);
  const wss = workspacesOf(ws);
  const place = (id: string, go: () => void): Pick<Item, 'run' | 'side' | 'send'> => ({
    run: go,
    side: () => { const st = useApp.getState(); const k = st.activeKey(); if (k) st.moveToWorkspace(k, id); },
    send: () => { useApp.getState().switchWorkspace(id); void newSessionIn(''); }
  });
  const rows: Item[] = wss.flatMap((w, i): Item[] => {
    const card = cardOf(ws, w.id, s.terminals, s.resumables, root, files, tabs);
    const hint = [card.folder ?? '', i < 9 ? kbd(`⌘⌥${i + 1}`) : ''].filter(Boolean).join(' · ');
    const acts = s.settings.wsActivities ? activitiesOf(ws, w.id) : [];
    return [
      { key: `ws-${w.id}`, kind: 'workspace', label: w.name, hint, ws: { color: w.color, dots: card.dots }, ...place(w.id, () => useApp.getState().goToWorkspace(w.id)) },
      ...acts.map((a): Item => {
        const ac = wsActivityCard(ws, a.id, s.terminals, s.resumables, root, files, tabs);
        return {
          key: `ws-${a.id}`, kind: 'workspace', label: t.wsAct.path(w.name, a.name), hint: '', ws: { color: a.color, dots: ac.dots, activity: true },
          ...place(a.id, () => useApp.getState().switchWorkspace(a.id))
        };
      })
    ];
  });
  const shown = fuzzyFilter(rows, text, (r) => r.label, 30);
  const name = text.trim();
  const exact = wss.some((w) => w.name.toLowerCase() === name.toLowerCase());
  const create: Item[] = name && !exact && wss.length < 20 ? [{
    key: 'ws-new', kind: 'workspace', label: t.ws.newNamed(name), hint: t.ws.newNamedHint,
    run: () => { if (useApp.getState().newWorkspace({ name })) void newSessionIn(''); }
  }] : [];
  return [{ title: t.ws.palette, items: [...shown, ...create], empty: t.paletteEmpty }];
}

function scheduledSections(list: ScheduledPrompt[], project: string, text: string, terminals: TerminalInfo[]): Group[] {
  const now = Date.now();
  const rows = paletteRows(list, project, now);
  const name = (p: ScheduledPrompt) => terminals.find((x) => x.id === p.terminalId)?.title ?? p.title;
  const items = rows.map(({ prompt: p, group, other }): Item & { group: string } => ({
    key: `sp-${p.id}`, kind: 'command', icon: 'sendLater', group, off: other,
    label: p.text.split('\n')[0]!.slice(0, 120),
    hint: `${clockOf(p.at)} · ${other ? `${name(p)} · ${t.sched.otherProject}` : name(p)}`,
    run: other ? () => void window.atelier.openRecent(p.projectRoot).catch(() => {}) : () => editSchedule(p),
    ...(other ? {} : { send: () => void fireSchedule(p.id), remove: () => void deleteSchedule(p) })
  }));
  const shown = text ? textFilter(items, text, (x) => [x.label, x.hint], 60) : items;
  if (shown.length === 0) return [{ title: t.sched.list, items: [], empty: t.paletteEmpty }];
  const groups: Group[] = [];
  for (const it of shown) {
    const g = groups.find((x) => x.title === it.group);
    if (g) g.items.push(it); else groups.push({ title: it.group, items: [it] });
  }
  return groups;
}

/**
 * The palette on a task: its actions (the task itself shows above them, TaskHead); or the Claude sessions to type
 * its prompt into, those that can't take it now greyed (picking one says why).
 */
function taskStepSections(step: TaskStep, query: string, terminals: TerminalInfo[], starting: Starting, go: { toPaste: () => void; accounts: ClaudeAccounts | null; toAccount: (intent: TaskIntent) => void }): Group[] {
  const { row } = step;
  const { source, task } = row;
  const start = (send: boolean, side: boolean, account?: string) => void startSessionFromTask(source, task, { send, side, ...(account ? { account } : {}) });
  if (step.step === 'account' && go.accounts) {
    // The accounts: Enter starts as the step was asked (⌘ / ⌥ kept), ⌘ also sends,
    // ⌥ opens it to the side.
    const st = useApp.getState();
    const intent = step.intent ?? { send: false, side: false };
    const items = accountChoices(go.accounts, st.usage, st.claudeDefaultDir, st.home).rows.map((a): Item => ({
      key: `task-account-${a.id}`, kind: 'command', label: a.name, hint: a.hint, dot: a.color,
      run: () => start(intent.send, intent.side, a.id), side: () => start(intent.send, true, a.id), send: (side) => start(true, side || intent.side, a.id)
    }));
    return [{ title: t.accounts.title, items: fuzzyFilter(items, query, (i) => i.label, 10), empty: t.paletteEmpty }];
  }
  if (step.step === 'paste') {
    const items = splitTerminals(terminals, starting).sessions.filter((x) => x.session).map((x): Item => {
      const why = pasteReason(x.id);
      return {
        key: `paste-${x.id}`, kind: 'session', label: x.title, hint: shownStateLabel(x) ?? '', color: x.color, off: why !== null,
        run: () => void pasteTaskInto(source, task, x.id, { send: false }), send: () => void pasteTaskInto(source, task, x.id, { send: true })
      };
    });
    return [{ title: t.paletteSessions, items: fuzzyFilter(items, query, (i) => i.label, 30), empty: items.length ? t.paletteEmpty : t.tasks.noSessions }];
  }
  // With two or more accounts Start in New Session… asks which one next, ⌘ and ⌥ included.
  const fresh: Item = go.accounts
    ? { key: 'task-new', kind: 'command', label: t.tasks.newSessionPick, hint: '', icon: 'plus', keep: true, stays: true,
        run: () => go.toAccount({ send: false, side: false }), side: () => go.toAccount({ send: false, side: true }), send: (side) => go.toAccount({ send: true, side }) }
    : { key: 'task-new', kind: 'command', label: t.tasks.newSession, hint: '', icon: 'plus', run: () => start(false, false), side: () => start(false, true), send: (side) => start(true, side) };
  const actions: Item[] = [
    fresh,
    { key: 'task-paste', kind: 'command', label: t.tasks.pasteInto, hint: '', icon: 'send', keep: true, run: go.toPaste },
    { key: 'task-copy', kind: 'command', label: t.tasks.copyTask, hint: t.tasks.copyTaskHint, icon: 'copy', run: () => void copyTask(source, task) }
  ];
  // A task without an ID (a Notion database with no unique-ID column) has nothing to copy.
  if (task.displayId) actions.push({ key: 'task-copy-id', kind: 'command', label: t.tasks.copyId, hint: task.displayId, icon: 'tag', run: () => void copyTaskId(task) });
  return [{ title: t.tasks.actions, items: fuzzyFilter(actions, query, (i) => i.label, 10), empty: t.paletteEmpty }];
}

/**
 * The send step: a new terminal in the source's folder, the plain terminals, the
 * Claude sessions (those not waiting for input greyed, picking one says why). Enter types, ⌘Enter types and runs.
 * Text meant for Claude (`newSession`): the Claude sessions only, then a new one.
 */
function sendSections(send: PaletteSend, query: string, terminals: TerminalInfo[], starting: Starting): Group[] {
  const own = send.newSession;
  const go = (run: boolean) => (own ? own(run) : void textInNewTerminal(send.text, send.cwd, run));
  const fresh: Item = {
    key: 'send-new', kind: 'command', label: own ? t.newSession : t.send.newTerminal, hint: own ? '' : send.cwd ? folderName(send.cwd) : t.send.newTerminalHint, icon: 'plus',
    run: () => go(false), send: () => go(true)
  };
  const rows = sendRows(terminals, starting, (id) => pasteReason(id)).map((r): Item => ({
    key: `send-${r.id}`, kind: r.kind, label: r.label, hint: r.hint, color: r.color, off: r.off,
    run: () => sendTextTo(r.id, send.text, false), send: () => sendTextTo(r.id, send.text, true)
  }));
  const sessions = rows.filter((i) => i.kind === 'session');
  // For Claude: no terminal (an empty group is not shown), the new session last.
  return [
    { title: t.paletteTerminals, items: fuzzyFilter(own ? [] : [fresh, ...rows.filter((i) => i.kind === 'terminal')], query, (i) => i.label, 30) },
    { title: t.paletteSessions, items: fuzzyFilter(own ? [...sessions, fresh] : sessions, query, (i) => i.label, 30) }
  ];
}

/** The text being sent, above the destinations: its first line and how many follow. */
function SendHead({ text }: { text: string }) {
  const { first, more } = selectionPreview(text);
  return (
    <div className="palette-send-head">
      <Icon name="send" size={12} stroke={2} />
      <span className="send-first mono">{first}</span>
      {more > 0 && <span className="send-more mono">{t.send.moreLines(more)}</span>}
    </div>
  );
}

/** Above a task's actions: the task they act on, not pickable. */
function TaskHead({ row, now }: { row: TaskRow; now: number }) {
  return <div className="palette-task-head task-item"><TaskCells row={row} now={now} /></div>;
}
