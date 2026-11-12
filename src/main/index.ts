import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, powerMonitor, safeStorage, screen, shell, systemPreferences, webContents } from 'electron';
import { AppLog } from './app-log';
import { installErrorLog } from './error-log';
import { basename, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { appendFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { daemonPaths } from '@shared/paths.node';
import { daemonVersionArg } from '@shared/daemon-build';
import { isBelow, samePath, toCanonical, trimOneSep } from '@shared/paths';
import { dockPoint, type Point, type ProjectWindowInfo } from '@shared/popout';
import { realOut, toOut } from './cpath';
import { currentPlatform } from '@shared/platform';
import { MENU_SPEC } from '@shared/menu-spec';
import { windowsMenu, type WinRole } from '@shared/windows-menu';
import { WindowsMenuHost, menuTargets, runMenuItem } from './windows-menu-host';
import { argvPaths, JumpListFeed, networkRoot, revealArg } from './win-shell';
import { claudeCandidates as claudeBinCandidates } from './claude-bin';
import { envGet, pathListSplit } from '@shared/env';
import { IPC, type AppInfo, type AppNotice, type MenuCommand, type ProjectInfo } from '@shared/api';
import { opensInApp, trafficLights, WINDOW_BAR, windowButtons, zoomFactor } from '@shared/settings';
import { themeOf } from '@shared/themes';
import { chromeOf } from './theme-chrome';
import { createAppIcon } from './app-icon';
import { appIconDeps } from './app-icon-exec';
import { profileOptions } from '@shared/profiles';
import { SettingsStore } from './settings-store';
import { ensureDaemon, stopStaleDaemon } from './daemon-launcher';
import { daemonFingerprint } from './daemon-fingerprint';
import { DaemonClient } from './daemon-client';
import { TerminalHub } from './terminal-hub';
import { ScreenResync, isLayoutChange } from './screen-resync';
import { createPopoutWindow, createProjectWindow, isAppUrl, isGhostUrl, SessionEndGuard, setDictationGate } from './windows';
import { PopoutManager, popoutFileRules, type PopoutWin, type ProjectWin } from './popouts';
import { commandPlan, isPopoutWindow, mainWindows, openProjectRoots, pageReloading, projectWindowId, windowToFront, type WindowKind } from './popout-wiring';
import { CloseGuard, type CloseAnswer } from './close-guard';
import { busyShells } from './foreground';
import { effectiveCloseMode, projectBusy, type CloseSessionsAsk } from '@shared/close-sessions';
import { installPopoutIpc } from './popout-ipc';
import { TearOff } from './tear-off';
import { TabMover } from './tab-mover';
import { TerminalHomes } from './terminal-homes';
import { makeGhost } from './ghost-window';
import { addRecent, forgetRecent, loadUiState, placeOfWindow, recentForWelcome, rememberWindow, saveUiStateLogged, windowPlace, type UiState } from './projects';
import { buildMenu } from './menu';
import { MenuStates } from './menu-state';
import { askAnswerSchema, askShownSchema, menuStateSchema, unsavedStateSchema } from './ipc-schemas';
import { AskBroker, restartAsk } from './ask';
import type { AskAnswer, AskRequest } from '@shared/asks';
import { accountsOf, defaultConfigDirNow } from './claude-accounts';
import { aboutPanelOptions } from './about';
import { grantedOf, installFilesIpc, type ClaudeTempDeps } from './files-ipc';
import { GrantStore, MAX_GRANTS } from './fs/grants';
import { insideProject } from './fs/files';
import { Opener, realOf } from './open-ipc';
import { TabsStore } from './tabs-store';
import { installTabsIpc, restoreGrants } from './tabs-ipc';
import { GrantWatch, nodeWatch } from './grant-watch';
import { OutsideFiles } from './outside-files';
import { installShellCommandIpc, shellCommandDeps } from './shell-command-exec';
import { installClipboardIpc } from './clipboard-ipc';
import { installUpdates, type Updates } from './updates-ipc';
import { DictationService } from './dictation/service';
import { broadcastDictation, installDictationIpc } from './dictation/ipc';
import { findClaude, type Runner } from './dictation/polish';
import { GitHub } from './git-hub';
import { ScmHub } from './scm-hub';
import { GitOps, quitAnyway, quitPrompt } from './git-ops';
import { moveToTrash } from './fs/write';
import { defaultUserEnv } from './git/user-env';
import { killAllWrites, runWrite, stopAllWrites } from './git/write';
import { disposeTrace2Dir } from './git/trace2';
import { isOnline } from './update-net';
import { BashAttributions } from './bash-attributions';
import type { ToolCallWindow } from '@shared/tool-calls';
import type { Attribution } from '@shared/attribution';
import type { Resumable, TerminalInfo } from '@shared/protocol';
import { ServicesHub } from './services-hub';
import { devEnv, testMs } from './dev-env';
import { applyHiddenWindowSwitches, hiddenWindows, hideTestDockIcon, revealedAt, revealWindow } from './hidden-windows';
import { muteTestAudio } from './test-audio';
import { openAppUrl, openUrl, revealFolder } from './links';
import { PortsHub } from './ports-hub';
import { DockerHub } from './docker/hub';
import { showBanner } from './attention';
import { electronTrayHost } from './tray-electron';
import { afterAllClosed, quitsWhenTurnedOff, reopensAfterCancelledQuit } from './tray';
import { installDockerIpc } from './docker/ipc';
import { RedisHub } from './redis/hub';
import { installRedisIpc } from './redis/ipc';
import { createPicks } from './redis/picks';
import { brewRedisInstalled, clientOriginsOf, dockerIpsOf, dockerRedisSecret, projectFiles } from './redis/main-deps';
import { DbHub } from './databases/hub';
import { installDbIpc } from './databases/ipc';
import { createDbStore } from './databases/store';
import { postgresDriver } from './databases/postgres/client';
import { closeAllTunnels, createTunnelFactory, sshBinary } from './databases/ssh-tunnel';
import { readArgs, readCwd, readListening, useWindowsProcs } from './procs/exec';
import { sharedProcessTree } from './procs/shared-tree';
import { WorkHub } from './work-hub';
import { PrHub } from './pr-hub';
import { viewPr } from './github/exec';
import { readShells } from './shells';
import { clickupEndpoint } from './connectors/clickup/config';
import { ClickUpConnector } from './connectors/clickup/clickup';
import type { ConnectorNotice } from '@shared/tasks';
import { notionEndpoint } from './connectors/notion/config';
import { NotionConnector } from './connectors/notion/notion';
import { jiraEndpoint } from './connectors/jira/config';
import { JiraConnector } from './connectors/jira/jira';
import { followAuthorize } from './connectors/oauth/follow-auth';
import { electronTransport } from './connectors/net';
import { BackgroundHub } from './background-hub';
import { claudeRoots, realHubFs } from './background-fs';
import { ConnectorRegistry } from './connectors/registry';
import { createAutomations } from './automations/wiring';
import { runningContainers, secretStoreFor } from './hub-deps';
import { CompanionService } from './companion/service';
import { CompanionStore } from './companion/store';
import { runCompanion } from './companion/run';
import { broadcastCompanion, installCompanionIpc, transcriptExists } from './companion/ipc';
import { configRootsFor } from './claude-config';
import { ContextService } from './context/service';
import { installContextIpc } from './context/ipc';
import { installSearchIpc } from './search/ipc';
import { branchAt, companionAccountDir, companionFacts, sessionFiles } from './companion/wiring';
import { randomUUID } from 'node:crypto';
import { installMedia, registerMediaScheme } from './media-ipc';

// atelier-media: must be privileged before the app is ready.
registerMediaScheme();
const paths = daemonPaths();
// Chromium data (cache, storage) stays in a subfolder: the root belongs to atelierd.
// With ATELIER_HOME (tests) the single-instance lock stays isolated too.
app.setPath('userData', join(paths.home, 'electron'));
// The app's error log, next to atelierd's (see app-log.ts).
const appLog = new AppLog(join(paths.logDir, 'app.log'));
// e2e: windows stay hidden yet render as if visible (before ready, so Chromium picks the switches up).
applyHiddenWindowSwitches(app.commandLine);
// e2e: pages play their sounds muted (chime, dictation tones).
muteTestAudio(app);
// Every window's project (null: the welcome window), tab pop-outs included so every IPC resolves their project; the
// kinds tell "the project's window" from its pop-outs.
const windowProjects = new Map<number, string | null>();
const windowKinds = new Map<number, WindowKind>();
const windowsView = { projects: windowProjects, kinds: windowKinds };
let uiState: UiState = loadUiState(paths.uiState);
const shells = readShells();
const settings = new SettingsStore(paths.preferences, { shells: () => shells().map((s) => s.path), log: (message) => { appLog.write({ source: 'main:settings', message }); } });
let quitting = false;

function isDir(p: string): boolean {
  try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; }
}

function projectFromArgv(argv: string[]): string | null {
  const a = argv.find((x) => x.startsWith('--project='));
  const p = a?.slice('--project='.length);
  return p && isDir(p) ? p : null;
}

// Where a project's window is, for the next time it opens, as big as it was and maximized if it was. In full screen the
// place it had before stays (as pop-outs do): the screen's frame is not a place to reopen at.
const placeOf = (state: UiState, root: string, win: BrowserWindow | null) => {
  const place = win ? placeOfWindow(win) : null;
  return place ? rememberWindow(state, root, place) : state;
};

/** ui-state.json written; a failure is logged, never thrown (close handlers save it and must go on). */
const saveUi = () => saveUiStateLogged(paths.uiState, uiState, (message) => { appLog.write({ source: 'main:ui-state', message }); });

function persistOpenProjects(): void {
  uiState = { ...uiState, openProjects: openProjectRoots(windowsView) };
  for (const root of uiState.openProjects) uiState = placeOf(uiState, root, projectWindow(root));
  saveUi();
}

/** The project's main window (one per folder): never one of its pop-outs. */
function projectWindow(root: string): BrowserWindow | null {
  const id = projectWindowId(windowsView, root);
  return id === null ? null : BrowserWindow.getAllWindows().find((b) => b.webContents.id === id) ?? null;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // The app icon follows Docsy's themes: the Dock's from the first moment, before ready (no
  // Aurora flash after an update, whose fresh bundle has no custom icon yet); the installed bundle's once ready.
  const iconLog = devEnv('ATELIER_TEST_APP_ICON_LOG');
  const appIcon = createAppIcon(appIconDeps({
    packaged: app.isPackaged, exePath: app.getPath('exe'), userHome: homedir(), atelierHome: paths.home,
    resourcesPath: process.resourcesPath, appPath: app.getAppPath(), dock: app.dock,
    log: (line) => { if (iconLog) appendFileSync(iconLog, JSON.stringify(line) + '\n'); },
    error: (message) => { appLog.write({ source: 'main:app-icon', message }); }
  }));
  appIcon.start(settings.get().theme);
  const daemonScript = join(__dirname, 'daemon.js');
  // ATELIER_TEST_NO_PROFILES: the app behaves as with an atelierd older than terminal profiles ('1'), or only older
  // than the capabilities listed ('states2': profiles but no v2.0 states).
  const noCaps = devEnv('ATELIER_TEST_NO_PROFILES');
  // Which code a started atelierd runs travels in its --version: an update that leaves it alone asks for no restart.
  // Windows: atelierd installs atelier-bridge.exe from the runtime copy this fingerprint names (the one it would find
  // first): a bridge-only change must make a new copy. macOS passes none, its fingerprint stays as it always was.
  const daemonHelpers = currentPlatform() === 'win32'
    ? [[join(process.resourcesPath, 'bin', 'atelier-bridge.exe'), join(__dirname, '..', '..', 'vendor', 'bin', 'atelier-bridge.exe')].find((p) => existsSync(p)) ?? 'atelier-bridge.exe']
    : [];
  const daemonBuild = { version: app.getVersion(), build: daemonFingerprint(daemonScript, process.versions.electron, daemonHelpers) };
  const client = new DaemonClient(() => ensureDaemon({ execPath: process.execPath, script: daemonScript, version: daemonVersionArg(daemonBuild.version, daemonBuild.build), packaged: app.isPackaged, fingerprint: daemonBuild.build }), { hideCapabilities: noCaps === '1' ? true : noCaps ? noCaps.split(',') : false });
  // Terminals moved to another project's window: every list atelierd
  // sends reads with their new project, for every listener; a home goes once atelierd has neither the terminal nor its
  // resume entry.
  const homes = new TerminalHomes(uiState.homes ?? {}, (h) => { uiState = { ...uiState, homes: h }; saveUi(); });
  client.setRelabel((list) => homes.relabel(list));
  const alive: { terminals: string[] | null; resumables: string[] | null } = { terminals: null, resumables: null };
  const pruneHomes = () => { if (alive.terminals && alive.resumables) homes.prune(alive.terminals, alive.resumables); };
  client.on('terminals', (list: TerminalInfo[]) => { alive.terminals = list.map((t) => t.id); pruneHomes(); });
  client.on('resumables', (list: Resumable[]) => { alive.resumables = list.map((r) => r.id); pruneHomes(); });
  // A new connection (an atelierd restart) sends its terminals before its resume entries: never pruned against the
  // previous one's entries.
  client.on('status', (s: string) => { if (s !== 'connected') { alive.terminals = null; alive.resumables = null; } });
  const hub = new TerminalHub(client, daemonBuild, (e) => isAppUrl(e.senderFrame?.url ?? ''));
  // A moved terminal's session resumed in its new window: the new terminal keeps its home.
  hub.onResumed = (oldId, info) => homes.resumed(oldId, info);
  // e2e: a folder cap a test reaches with a handful of folders.
  const searchCap = testMs('ATELIER_TEST_REPO_SEARCH_MAX_FOLDERS');
  const gitHub = new GitHub(client, { depth: () => settings.get().repoSearchDepth, ...(searchCap ? { maxFolders: () => searchCap } : {}) });
  // A window coming to the front: repositories cloned or moved while no event said so are looked for again.
  app.on('browser-window-focus', (_e, w) => { const root = windowProjects.get(w.webContents.id); if (root) gitHub.focused(root); });
  // Fetch: view and manual fetches from the renderer, periodic ones per the setting, for open projects.
  const scmHub = new ScmHub(gitHub, {
    setting: () => settings.get().autoFetch,
    online: () => isOnline(),
    projects: () => [...new Set([...windowProjects.values()].filter((r): r is string => !!r))]
  });
  scmHub.startFetching();
  app.on('will-quit', () => scmHub.dispose());
  // tmux at full pace only while Atelier is focused; a focus lists at once. Not at all until
  // Settings › Appearance › Services is on (2026-11-02), never on Windows (no Services view there).
  const servicesHub = new ServicesHub({
    focused: () => hiddenWindows() || BrowserWindow.getAllWindows().some((b) => b.isFocused()),
    enabled: () => settings.get().showServices && currentPlatform() !== 'win32'
  });
  app.on('browser-window-focus', () => servicesHub.onFocus());
  // Docker view: read-only, over the engine's Unix socket; nothing runs with Show Docker = Never.
  const dockerHub = new DockerHub({
    settings: () => settings.get(),
    home: toOut(homedir()),
    testSocket: devEnv('ATELIER_TEST_DOCKER_SOCKET'),
    // Tests only: an engine that starts later is found within this many ms instead of 30 s.
    ...(Number(devEnv('ATELIER_TEST_DOCKER_PROBE_MS')) > 0 ? { timing: { probeMs: Number(devEnv('ATELIER_TEST_DOCKER_PROBE_MS')), tickMs: 250 } } : {}),
    focused: () => hiddenWindows() || BrowserWindow.getAllWindows().some((b) => b.isFocused()),
    banner: (b) => {
      const testLog = devEnv('ATELIER_TEST_NOTIFY_LOG');
      if (!testLog && !Notification.isSupported()) return;
      showBanner(b, testLog, () => {
        const note = new Notification({ title: b.title, body: b.body, silent: b.silent });
        dockerBanners.add(note);
        note.on('close', () => dockerBanners.delete(note));
        note.on('click', () => {
          dockerBanners.delete(note);
          const win = projectWindow(b.root);
          if (!win) return;
          revealWindow(win);
          win.webContents.send(IPC.evDockerOpen, b.containerId);
        });
        note.show();
      });
    }
  });
  // Shown banners are kept referenced, or a click on one collected by the GC does nothing.
  const dockerBanners = new Set<Notification>();
  app.on('browser-window-focus', () => dockerHub.onFocus());
  app.on('will-quit', () => dockerHub.dispose());
  // Listening ports of the terminals: only while an Atelier window is focused (hidden e2e windows never
  // are, so they count as focused) and only with the setting on.
  const portsHub = new PortsHub({
    // One ps -A shared with the background work scan and the Redis clients.
    readTree: () => sharedProcessTree(),
    readListening: (pids) => readListening(pids),
    enabled: () => settings.get().showPorts,
    focused: () => hiddenWindows() || BrowserWindow.getAllWindows().some((b) => b.isFocused()),
    showEphemeral: () => settings.get().showEphemeralPorts,
    pollMs: testMs('ATELIER_TEST_PORTS_POLL_MS')
  });
  // The work scan: whatever the focus, only while a session has background shells or monitors.
  hub.useWorkHub(new WorkHub({
    readTree: () => sharedProcessTree(), readArgs: (pids) => readArgs(pids), readListening: (pids) => readListening(pids),
    serverListenMs: testMs('ATELIER_TEST_SERVER_LISTEN_MS')
  }));
  // The Background inspector: follows task outputs and subagent transcripts, read-only.
  const backgroundHub = new BackgroundHub({
    fs: realHubFs, roots: claudeRoots, uid: typeof process.getuid === 'function' ? process.getuid() : null,
    log: (message) => { appLog.write({ source: 'main:background', message }); },
    missingGiveUpMs: testMs('ATELIER_TEST_BG_MISSING_MS')
  });
  hub.useBackgroundHub(backgroundHub);
  app.on('will-quit', () => backgroundHub.dispose());
  // Redis view: local instances only (loopback, sockets); nothing runs with Show Redis = Never.
  // The projects' .env and compose files, cached a few seconds: read for Redis and for Databases.
  const redisFiles = projectFiles();
  const redisTestPorts = devEnv('ATELIER_TEST_REDIS_PORTS');
  const redisBrew = devEnv('ATELIER_TEST_REDIS_BREW');
  const redisHub = new RedisHub({
    settings: () => settings.get(),
    focused: () => hiddenWindows() || BrowserWindow.getAllWindows().some((b) => b.isFocused()),
    ...(redisTestPorts !== undefined ? { testPorts: redisTestPorts.split(',').map(Number).filter((n) => n > 0 && n < 65536), testSocketDir: tmpdir() } : {}),
    readEnv: (root) => redisFiles.env(root),
    readCompose: (root) => redisFiles.compose(root),
    dockerContainers: () => runningContainers(dockerHub),
    dockerSecret: (id) => dockerRedisSecret(dockerHub, id),
    dockerIps: dockerIpsOf(dockerHub),
    terminalPorts: () => portsHub.listening(),
    clientOrigins: clientOriginsOf(portsHub),
    secrets: secretStoreFor(paths.home, safeStorage),
    picks: createPicks(paths.home),
    brewInstalled: () => (redisBrew !== undefined ? redisBrew === '1' : brewRedisInstalled()),
    banner: (b) => {
      const testLog = devEnv('ATELIER_TEST_NOTIFY_LOG');
      if (!testLog && !Notification.isSupported()) return;
      showBanner(b, testLog, () => {
        const note = new Notification({ title: b.title, body: b.body, silent: b.silent });
        dockerBanners.add(note);
        note.on('close', () => dockerBanners.delete(note));
        note.on('click', () => {
          dockerBanners.delete(note);
          const win = projectWindow(b.root);
          if (!win) return;
          revealWindow(win);
          win.webContents.send(IPC.evRedisOpen, b.queueId);
        });
        note.show();
      });
    },
    // Tests only: a server that starts later is found within this many ms instead of 30 s.
    ...(Number(devEnv('ATELIER_TEST_REDIS_PROBE_MS')) > 0 ? { timing: { probeMs: Number(devEnv('ATELIER_TEST_REDIS_PROBE_MS')), tickMs: 250 } } : {})
  });
  portsHub.onChange = () => redisHub.sourcesChanged();
  app.on('browser-window-focus', () => redisHub.onFocus());
  app.on('will-quit', () => redisHub.dispose());
  // Databases view: saved connections, added by hand (nothing is looked for),
  // contacted only when a window selects one; nothing runs with Never.
  // The connections file: the hub's, and the tab mover's to know where a table tab may go.
  const dbStore = createDbStore(paths.home);
  // e2e: overview reads share one server read for 2 s; a test counting the Overview's polls by the server shortens it.
  const overviewMs = testMs('ATELIER_TEST_DB_OVERVIEW_MS');
  const dbHub = new DbHub({
    ...(overviewMs ? { timing: { overviewMs } } : {}),
    settings: () => settings.get(),
    store: dbStore,
    secrets: secretStoreFor(paths.home, safeStorage),
    driver: postgresDriver,
    // SSH tunnels through the system's ssh; tests point ATELIER_TEST_SSH_BIN at tests/support/fake-ssh.mjs.
    tunnel: createTunnelFactory({ bin: devEnv('ATELIER_TEST_SSH_BIN') ?? sshBinary(process.platform, process.env) })
  });
  dockerHub.onChange = () => redisHub.sourcesChanged();
  // Every ssh too, a tunnel still opening (or a Test Connection's) included: dispose only knows the open sessions'.
  app.on('will-quit', () => { dbHub.dispose(); closeAllTunnels(); });
  client.on('terminals', (list: TerminalInfo[]) => portsHub.setTerminals(list));
  // atelierd gone: its terminals (and their pids) are no longer known.
  client.on('status', (s: string) => { if (s !== 'connected') portsHub.setTerminals([]); });
  app.on('browser-window-focus', () => portsHub.refresh());
  // Pull requests of the sessions' branches: gh only with the setting on; polls only while focused.
  const prInterval = Number(devEnv('ATELIER_TEST_PR_INTERVAL_MS') ?? 0);
  const prHub = new PrHub({
    view: (root, branch) => viewPr(root, branch),
    enabled: () => settings.get().prStatus,
    focused: () => hiddenWindows() || BrowserWindow.getAllWindows().some((b) => b.isFocused()),
    reposOf: (project) => gitHub.reposOf(project),
    realpath: (p) => toOut(realpathSync(p)),
    // Tests only: every interval shortened, so a rewritten fake gh answer shows up without minute-long waits.
    ...(prInterval > 0 ? { intervals: { tick: prInterval, focus: prInterval, poll: prInterval, pending: prInterval, rest: prInterval } } : {})
  });
  client.on('terminals', (list: TerminalInfo[]) => prHub.setTerminals(list));
  client.on('status', (s: string) => { if (s !== 'connected') prHub.setTerminals([]); });
  app.on('browser-window-focus', () => prHub.refresh());
  hub.onTouched = (path) => gitHub.touched(path);
  // Files changed through Bash: app-side, from the sessions' activity and each git status.
  const bash = new BashAttributions(join(paths.home, 'bash-attributions.json'));
  client.on('terminals', (list: TerminalInfo[]) => bash.setTerminals(list));
  client.on('attributions', (list: Attribution[]) => bash.setDaemonAttributions(list));
  // Exact attribution: atelierd's tool-call windows; none (null) with an older atelierd.
  client.on('toolCalls', (list: ToolCallWindow[], full: boolean) => bash.setToolCalls(list, full));
  client.on('status', (s: string) => {
    if (s === 'connected' && !client.hasCapability('toolcalls')) bash.setToolCalls(null);
    else bash.awaitToolCalls(s === 'connected');
  });
  gitHub.onStatus = (st, o) => { void bash.status(st, o); prHub.repoStatus(st); gitOps.statusChanged(st); };
  bash.onChange = () => hub.refreshAttributions();
  bash.onBaselineNeeded = () => gitHub.refreshAll();
  hub.bashAttributions = () => bash.list();
  hub.resolveAttributions = (paths, terminalId, scope) => bash.resolve(paths, terminalId, scope);
  hub.undoResolve = (token, scope) => bash.undo(token, scope);
  hub.settings = () => settings.get();
  hub.shells = shells;
  hub.readCwd = (pid) => readCwd(pid);
  // Only projects with live sessions in atelierd (Dock and notifications): folders that still exist.
  hub.openProject = (root) => {
    if (!isDir(root)) return;
    // As with Open Recent: the welcome window gives way to the project.
    const welcome = BrowserWindow.getAllWindows().find((b) => windowProjects.get(b.webContents.id) === null);
    if (openWindow(root, welcome)) welcome?.close();
  };
  // A change applies everywhere at once: window zoom, Dock badge, and every window receives the new settings.
  // Dictation: engine, model and polish. The microphone opens only while dictation is enabled.
  setDictationGate(() => settings.get().dictationEnabled);
  const testPolish = devEnv('ATELIER_TEST_POLISH');
  const polishRun: Runner | undefined = testPolish
    ? async (_b, _a, input) => {
      if (testPolish === 'fail') throw new Error('test polish failure');
      return (/<dictation>\n([\s\S]*)\n<\/dictation>/.exec(input)?.[1] ?? '').toUpperCase();
    }
    : undefined;
  // The real `claude` (never the wrapper with hooks in ATELIER_HOME): from the usual places and from PATH (Windows: npm's,
  // WinGet's and Scoop's folders too).
  const claudeCandidates = () => claudeBinCandidates({
    home: homedir(), path: envGet(process.env, 'PATH') ?? '', atelierHome: paths.home, platform: currentPlatform(),
    appData: envGet(process.env, 'APPDATA'), localAppData: envGet(process.env, 'LOCALAPPDATA')
  });
  // Windows: ps and lsof's stand-in for ports and the work scan; none found, those readings are off.
  if (currentPlatform() === 'win32') {
    useWindowsProcs([join(process.resourcesPath, 'bin', 'atelier-procs.exe'), join(__dirname, '..', '..', 'vendor', 'bin', 'atelier-procs.exe')].find((p) => existsSync(p)) ?? null);
  }
  const whisperName = currentPlatform() === 'win32' ? 'atelier-whisper.exe' : 'atelier-whisper';
  const whisperBin = devEnv('ATELIER_TEST_WHISPER_BIN')
    ?? [join(process.resourcesPath, 'bin', whisperName), join(__dirname, '..', '..', 'vendor', 'bin', whisperName)].find((p) => existsSync(p))
    ?? null;
  const testSpec = devEnv('ATELIER_TEST_MODEL_SPEC');
  const micMap = (s: string) => (s === 'granted' || s === 'denied' || s === 'restricted' ? s : 'not-determined');
  let prevSettings = settings.get();
  const dictation = new DictationService({
    home: paths.home,
    settings: () => settings.get(),
    binPath: whisperBin,
    modelSpec: testSpec ? JSON.parse(testSpec) : undefined,
    micStatus: () => (devEnv('ATELIER_TEST_FAKE_MIC') ? 'granted' : micMap(systemPreferences.getMediaAccessStatus('microphone'))),
    // askForMediaAccess is macOS's: Windows asks when the page opens the microphone (its privacy settings decide).
    askMic: () => (devEnv('ATELIER_TEST_FAKE_MIC') ? Promise.resolve(true) : process.platform === 'win32' ? Promise.resolve(systemPreferences.getMediaAccessStatus('microphone') === 'granted') : systemPreferences.askForMediaAccess('microphone')),
    claudeBin: () => (testPolish ? '/test/claude' : findClaude(claudeCandidates())),
    polishRun,
    onStatus: broadcastDictation
  });
  app.on('browser-window-focus', () => dictation.warmIfReady());
  app.on('will-quit', () => dictation.dispose());
  // Git writes: one queue with Source Control's fetches, the user's shell environment captured on
  // the first write, ✦ with the real claude (or the e2e fake), events to the windows that show the root.
  const userEnv = defaultUserEnv();
  // e2e only: git as slow as on a busy Windows PC, so a checkbox's click shows before git is done.
  const writeDelay = testMs('ATELIER_TEST_GIT_WRITE_DELAY_MS');
  const gitOps = new GitOps({
    ...(writeDelay ? { run: async (root, inv, o) => { await new Promise((r) => setTimeout(r, writeDelay)); return runWrite(root, inv, o); } } : {}),
    settings: () => settings.get(),
    git: gitHub,
    scm: scmHub,
    queue: scmHub.writes,
    sessions: (key) => hub.sessionsOf(key),
    accountDir: (key, terminalId) => hub.accountDirOf(key, terminalId),
    trash: (root, path) => moveToTrash(root, path),
    userEnv: () => userEnv.get(),
    claude: () => devEnv('ATELIER_TEST_MESSAGE_CLAUDE') ?? findClaude(claudeCandidates()),
    emit: (root, e) => { for (const wc of gitHub.windowsShowing(root)) if (!wc.isDestroyed()) wc.send(IPC.evGitOp, e); }
  });
  // Quitting never leaves a detached git behind: Quit Anyway already waited for the stopped ops' cleanups, so whatever
  // still runs here is killed at once (SIGKILL to each group); trace2's private folder goes too.
  app.on('will-quit', () => { gitOps.cancelAll(); killAllWrites(); disposeTrace2Dir(); });
  // Ask: one thread per Claude session under ATELIER_HOME/companion, each run an isolated read-only
  // `claude -p` (the real one, never the hooks wrapper; the e2e fake in tests). Its facts come from what the app already
  // knows; threads are app-wide, so their events go to every window.
  const companionTerm = (id: string) => hub.allTerminals().find((t) => t.id === id) ?? null;
  const realOr = (p: string) => { try { return realOut(p); } catch { return p; } };
  const companion = new CompanionService({
    store: new CompanionStore(join(paths.home, 'companion')),
    claudeBin: () => devEnv('ATELIER_TEST_COMPANION_CLAUDE') ?? findClaude(claudeCandidates()),
    settings: () => settings.get(),
    accountDir: (choice, sessionDir) => companionAccountDir(accountsOf(settings.get(), defaultConfigDirNow()), defaultConfigDirNow(), choice, sessionDir),
    projectRoot: (terminalId) => companionTerm(terminalId)?.projectRoot ?? null,
    facts: (b) => {
      const term = companionTerm(b.terminalId);
      const project = term?.projectRoot ?? null;
      const files = project ? sessionFiles(hub.sessionsOf(project).attributions, realOr(project), b.sessionId) : [];
      const statuses = (project ? gitHub.info(project)?.status.values() : undefined) ?? [];
      return companionFacts(term, b, { files, branch: branchAt(statuses, realOr(b.cwd)), now: Date.now() });
    },
    live: () => hub.keptSessions() ?? new Set(),
    open: () => hub.openSessions(),
    run: runCompanion,
    now: () => Date.now(),
    uuid: () => randomUUID()
  }, broadcastCompanion(() => BrowserWindow.getAllWindows().map((b) => ({
    send: (channel: string, payload: unknown) => b.webContents.send(channel, payload), isDestroyed: () => b.isDestroyed() || b.webContents.isDestroyed()
  }))));
  // Retention: once atelierd's terminals and Resume list are both in (before, an empty list
  // would mean nothing), then once a day. Quitting settles the questions still in flight and stops their runs.
  const sweepCompanion = () => {
    if (hub.keptSessions() === null) return false;
    try { companion.sweep(); } catch (err) { appLog.write({ source: 'main:companion', message: `sweep failed: ${err instanceof Error ? err.message : String(err)}` }); }
    return true;
  };
  let companionSwept = false;
  hub.onKeptSessions(() => { if (!companionSwept) companionSwept = sweepCompanion(); });
  setInterval(sweepCompanion, 24 * 3600_000).unref();
  app.on('will-quit', () => companion.stopAll());
  // Set once the app is ready (installUpdates): a channel picked in Settings › About is checked right away.
  let updates: Updates | null = null;
  settings.onChange((s) => {
    dictation.settingsChanged(prevSettings);
    if (s.updateChannel !== prevSettings.updateChannel) updates?.channelChanged();
    if (s.showPorts !== prevSettings.showPorts || s.showEphemeralPorts !== prevSettings.showEphemeralPorts) portsHub.settingsChanged();
    if (s.countBackgroundWork !== prevSettings.countBackgroundWork) hub.workSettingsChanged();
    if (s.claudeMcpNotice !== prevSettings.claudeMcpNotice) hub.mcpSettingsChanged();
    if (s.prStatus !== prevSettings.prStatus) prHub.settingsChanged();
    if (s.autoFetch !== prevSettings.autoFetch) scmHub.fetchSettingsChanged();
    if (s.repoSearchDepth !== prevSettings.repoSearchDepth) gitHub.settingsChanged();
    if (s.showServices !== prevSettings.showServices) servicesHub.settingsChanged();
    if (s.showDocker !== prevSettings.showDocker || s.dockerSocket !== prevSettings.dockerSocket) dockerHub.settingsChanged();
    if (s.showRedis !== prevSettings.showRedis || s.redisInstances.join('\n') !== prevSettings.redisInstances.join('\n') || s.redisMonitor !== prevSettings.redisMonitor || s.redisQueues !== prevSettings.redisQueues || s.redisNotify !== prevSettings.redisNotify) redisHub.settingsChanged();
    if (s.showDatabases !== prevSettings.showDatabases || s.dbTimeoutSec !== prevSettings.dbTimeoutSec) dbHub.settingsChanged();
    if (s.trayIcons !== prevSettings.trayIcons) {
      hub.refreshTray();
      // Windows with no window open: the icon was the only way back to the app.
      if (!s.trayIcons && quitsWhenTurnedOff(currentPlatform(), BrowserWindow.getAllWindows().length)) app.quit();
    }
    // Themes: what main paints itself, and the native parts (dialogs, form controls) light or dark.
    if (s.theme !== prevSettings.theme) {
      nativeTheme.themeSource = themeOf(s.theme).appearance;
      void appIcon.themeChanged(s.theme);
      const { background } = chromeOf(s.theme);
      for (const b of BrowserWindow.getAllWindows()) if (!isGhostUrl(b.webContents.getURL())) b.setBackgroundColor(background);
    }
    prevSettings = s;
    for (const b of BrowserWindow.getAllWindows()) {
      b.webContents.setZoomFactor(zoomFactor(s.interfaceSize));
      // Windows has no traffic lights (setWindowButtonPosition throws there): its caption buttons follow the zoom.
      if (process.platform === 'win32') {
        // One bar in every window: the header, the Welcome window's bar, a pop-out's.
        try { b.setTitleBarOverlay(windowButtons(zoomFactor(s.interfaceSize), WINDOW_BAR, chromeOf(s.theme).symbol)); } catch { /* a window without the overlay (the ghost) */ }
      }
      else b.setWindowButtonPosition(trafficLights(zoomFactor(s.interfaceSize)));
      b.webContents.send(IPC.evSettings, s);
    }
    hub.refreshBadge();
  });

  /** A project's window (main or pop-out) gets the data of every hub. */
  const registerHubs = (root: string, wc: Electron.WebContents) => {
    hub.register(wc, root);
    gitHub.open(root, wc);
    servicesHub.open(root, wc);
    dockerHub.open(root, wc);
    redisHub.open(root, wc);
    dbHub.open(root, wc);
    portsHub.open(root, wc);
    prHub.open(root, wc);
  };

  /** A window of `root` closed: with none left, its outside files are no longer watched. */
  const lastWindowGone = (root: string) => {
    if (![...windowProjects.values()].includes(root)) { grantWatch.close(root); outsideOpen.close(root); }
  };

  /**
   * A window closing with unsaved files asks in its page when it listens; Save or Don't Save
   * there resumes a quit in progress.
   */
  const unsavedAsk = (win: () => BrowserWindow) => ({
    unsaved: {
      canAsk: () => asks.isReady(win().webContents.id),
      // The window asking comes forward (minimized, hidden with ⌘H, behind another): its question must be seen.
      ask: (what: 'close' | 'quit' | 'reload') => { revealWindow(win()); return asks.ask(win().webContents.id, { kind: 'unsaved-close', what }); }
    },
    isQuitting: () => quitting,
    resumeQuit: () => app.quit()
  });

  /** The unsaved-files dialog kept a page while quitting: Electron cancelled the quit, so windows close as usual again. */
  const quitStopped = () => {
    gitResumes();
    updates?.quitCalledOff();
    // A quit a page called off is no longer confirmed (a Windows shutdown held for unsaved files, then Cancel): the next
    // quit asks again about running git writes.
    quitConfirmed = false;
    if (!quitting) return;
    quitting = false;
    popouts.quitting = false;
  };

  /** Brings back the project's remembered pop-outs (terminals once atelierd has listed them). */
  const restorePopouts = (root: string) => popouts.restore(root, hub.daemonState().listed ? hub.terminalIds(root) : null);

  /**
   * `replacing`: the welcome window giving way to the project, whose place the project window takes. Null when the
   * folder can't be a project (Windows: a network share, said in a dialog; the welcome window then stays).
   */
  const openWindow = (given: string | null, replacing?: BrowserWindow | null): BrowserWindow | null => {
    // A folder from the OS (argv, a dialog) is native on Windows: projects are known by the canonical path (C:/…).
    const root = given && toCanonical(given);
    // Windows: a share or WSL folder (\\server\share) has no drive letter, which every path IPC takes has: its window
    // would see every file as outside. Refused, with the way in (a mapped drive).
    const refused = root && currentPlatform() === 'win32' ? networkRoot(root) : null;
    if (refused) {
      const parent = replacing && !replacing.isDestroyed() ? replacing : BrowserWindow.getFocusedWindow();
      const opts = { type: 'info' as const, buttons: ['OK'], message: refused.message, detail: refused.detail };
      void (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts));
      return null;
    }
    // One window per folder: if the project is already open, that window is brought to the front.
    const existing = root ? projectWindow(root) : null;
    if (existing) { revealWindow(existing); return existing; }
    // Where the project's window was last time (on a display still there), else centered.
    // The welcome window's own place is its normal bounds: a maximized one's overhang the screen (by 8 px on Windows).
    const saved = root ? uiState.windows?.[root] : undefined;
    const place = windowPlace(replacing && !replacing.isDestroyed() ? replacing : null, saved, screen.getAllDisplays().map((d) => d.workArea));
    const win: BrowserWindow = createProjectWindow(root, zoomFactor(settings.get().interfaceSize), place, {
      onUnloadKept: quitStopped,
      // The project's own unsaved guard said Cancel after its pop-outs closed: they come back, and the sessions' answer
      // is forgotten.
      onUnloadCancel: () => {
        if (root) closeGuard.forget(root);
        // A quit called off here: its sessions' answer goes too (the next quit asks again). Save or Don't Save resume
        // the quit with the answer given.
        if (sessionsDecided) { sessionsDecided = false; closeGuard.forgetAll(); }
        if (root && !quitting) restorePopouts(root);
      },
      ...unsavedAsk(() => win)
    }, settings.get().theme);
    const wcId = win.webContents.id;
    win.webContents.on('did-finish-load', () => {
      win.webContents.setZoomFactor(zoomFactor(settings.get().interfaceSize));
      if (root) restorePopouts(root);
    });
    windowProjects.set(wcId, root);
    windowKinds.set(wcId, 'project');
    announceWindows();
    if (root) {
      registerHubs(root, win.webContents);
      uiState = addRecent(uiState, root);
      refreshJumpList();
    }
    // Closing the project closes its pop-outs first, each with its unsaved guard; a Cancel there keeps the project open.
    win.on('close', (e) => {
      // Its bounds, for the next time it opens (on a quit too: the open projects stay as the quit saved them).
      if (root) { uiState = placeOf(uiState, root, win); saveUi(); }
      if (!root || quitting) return;
      // Still waiting on its pop-outs (the manager's own in-flight close, so it can never stay stuck).
      if (popouts.closingProject(root)) { e.preventDefault(); return; }
      // Its busy sessions asked about first; held meanwhile, closed again once decided.
      if (!closeGuard.onClose(root, win, () => { if (!win.isDestroyed()) win.close(); })) { e.preventDefault(); return; }
      if (popouts.live(root) === 0) return;
      e.preventDefault();
      void popouts.closeForProject(root).then((ok) => {
        if (win.isDestroyed()) return;
        if (ok) { win.close(); return; }
        // Cancelled in a later pop-out: those already closed (still remembered) come back; the sessions stay as they are.
        closeGuard.forget(root);
        if (!quitting) restorePopouts(root);
      });
    });
    win.on('closed', () => {
      windowProjects.delete(wcId);
      windowKinds.delete(wcId);
      focusedAt.delete(wcId);
      opener.forget(wcId);
      announceWindows();
      if (root) lastWindowGone(root);
      // Really gone: its terminals stop when that was the answer (on a quit too).
      if (root) closeGuard.onClosed(root);
      if (!quitting) {
        // Its remembered terminals still waiting for atelierd won't come back into a closed project (they stay saved).
        if (root) void popouts.closeForProject(root);
        persistOpenProjects();
      }
    });
    // A reload: the page asks for what was held for it again once it listens. A tab drag it had going ends (its ghost
    // goes), as when its page crashes.
    win.webContents.on('did-start-loading', () => opener.pageLoading(wcId));
    win.webContents.on('did-start-navigation', (d) => { if (root && pageReloading(d)) tear.end(root); });
    win.webContents.on('render-process-gone', () => { if (root) tear.end(root); });
    focusedAt.set(wcId, Date.now());
    persistOpenProjects();
    return win;
  };

  // New Window: the welcome window (recents, Open Folder) for working on another project; only one.
  const newWindow = () => {
    const welcome = BrowserWindow.getAllWindows().find((b) => windowProjects.get(b.webContents.id) === null);
    if (welcome) { revealWindow(welcome); return; }
    openWindow(null);
  };
  hub.newWindow = newWindow;

  const chooseFolder = async (from: BrowserWindow | null) => {
    const r = from
      ? await dialog.showOpenDialog(from, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    const root = r.filePaths[0];
    if (r.canceled || !root) return;
    // The welcome window becomes the project, in its place; the others stay and a new one is opened.
    const welcome = from && windowProjects.get(from.webContents.id) === null ? from : null;
    if (openWindow(root, welcome)) welcome?.close();
  };

  // Open any file: files outside a project the user opened, and every way a path comes in.
  const focusedAt = new Map<number, number>();
  app.on('browser-window-focus', (_e, w) => focusedAt.set(w.webContents.id, Date.now()));
  const grantWatch = new GrantWatch({
    watch: nodeWatch,
    send: (root, changed) => {
      for (const b of BrowserWindow.getAllWindows()) if (windowProjects.get(b.webContents.id) === root && !b.isDestroyed()) b.webContents.send(IPC.evFsChanged, changed);
    }
  });
  app.on('will-quit', () => grantWatch.dispose());
  // The outside files open in each project's tabs: never evicted from the grants, watched for disk changes.
  const outsideOpen = new OutsideFiles((root, files) => grantWatch.update(root, [...files]), Date.now, testMs('ATELIER_TEST_OUTSIDE_GRACE_MS'));
  // A read grant made editable by a gesture: no longer remembered read-only.
  // Both stores exist by the time a gesture can come.
  const grants = new GrantStore(MAX_GRANTS, (root) => outsideOpen.get(root), (root, real) => { tabsStore.dropReadOnly(root, real); popouts.editable(root, real); });
  // Terminal links to the files in Claude's temp folder: the Background inspector's root.
  const claudeTempDeps: ClaudeTempDeps = {
    tmp: () => claudeRoots().tmp, uid: typeof process.getuid === 'function' ? process.getuid() : null, grants,
    onUntrusted: (root) => appLog.write({ source: 'main:files', message: `Claude's temp folder ${root} is not private to this user (owner, permissions or a link): its files don't open from terminal links.` })
  };
  const tabsStore = new TabsStore(join(paths.home, 'tabs.json'));
  const windowById = (id: number) => BrowserWindow.getAllWindows().find((b) => b.webContents.id === id) ?? null;
  const opener = new Opener<BrowserWindow>({
    grants,
    projectOf: (id) => windowProjects.get(id) ?? null,
    isTrusted: (e) => isAppUrl(e.senderFrame?.url ?? ''),
    openProject: (root, replacing) => {
      // Routing works on real paths; a project is opened as it was spelled before (one window per folder).
      const spelled = [...windowProjects.values(), ...uiState.recent].find((r): r is string => !!r && realOf(r) === root) ?? root;
      const win = openWindow(spelled, replacing);
      if (win && replacing && win !== replacing) replacing.close();
      return win;
    },
    reveal: revealWindow,
    // Project and welcome windows: a file from macOS opens in the project's main window, never in a pop-out.
    windows: () => mainWindows(windowsView).map(([id, root]) => ({ id, root: root ? realOf(root) : null, focusedAt: focusedAt.get(id) ?? 0 })),
    recent: () => uiState.recent.filter(isDir).map(realOf),
    window: windowById,
    // Watched now: the tabs report (debounced) would leave a change right after opening unseen.
    opened: (root, files) => outsideOpen.opened(root, files),
    wrote: (path) => bash.noteAppWrite(path),
    // Opening files is the project's: what reaches a pop-out opens in its project window.
    targetOf: (w) => {
      const id = w.webContents.id;
      const root = windowProjects.get(id);
      return isPopoutWindow(windowsView, id) ? (root ? projectWindow(root) : null) : w;
    },
    welcome: () => BrowserWindow.getAllWindows().find((b) => windowProjects.get(b.webContents.id) === null) ?? openWindow(null)!
  });
  // Finder's Open With, `open -a Atelier`, the atelier command: held until the restored windows exist.
  app.on('open-file', (e, path) => { e.preventDefault(); opener.openFromSystem(path); });

  // Tab pop-out windows: a tab in a window of its own, joined to every hub like its project's window.
  const sendTo = (b: BrowserWindow, channel: string, payload?: unknown) => {
    if (b.isDestroyed() || b.webContents.isDestroyed()) return;
    if (payload === undefined) b.webContents.send(channel); else b.webContents.send(channel, payload);
  };
  const asPopoutWin = (b: BrowserWindow): PopoutWin => ({
    id: b.webContents.id,
    getBounds: () => b.getBounds(),
    setPosition: (x, y) => b.setPosition(Math.round(x), Math.round(y)),
    setOpacity: (o) => b.setOpacity(o),
    isFullScreen: () => b.isFullScreen(),
    isMinimized: () => b.isMinimized(),
    close: () => b.close(),
    destroy: () => b.destroy(),
    isDestroyed: () => b.isDestroyed(),
    send: (channel, payload) => sendTo(b, channel, payload),
    on: (event, fn) => {
      const plain = { preventDefault: () => {} };
      if (event === 'page-gone') b.webContents.on('render-process-gone', () => fn(plain));
      // Its main frame only: an iframe loading inside it mid-drag must not cancel the drag.
      else if (event === 'page-loading') b.webContents.on('did-start-navigation', (d) => { if (pageReloading(d)) fn(plain); });
      else b.on(event as 'close', fn);
    }
  });
  const asProjectWin = (b: BrowserWindow): ProjectWin => ({
    id: b.webContents.id,
    getContentBounds: () => b.getContentBounds(),
    getBounds: () => b.getBounds(),
    zoom: () => b.webContents.getZoomFactor(),
    send: (channel, payload) => sendTo(b, channel, payload),
    reveal: () => revealWindow(b)
  });
  // e2e move a fake cursor (app.evaluate), never the real one.
  const cursor = () => (devEnv('ATELIER_TEST_CURSOR') === '1'
    ? ((globalThis as { __atelierTestCursor?: { x: number; y: number } }).__atelierTestCursor ?? { x: 0, y: 0 })
    : screen.getCursorScreenPoint());
  // Moving tabs between projects' windows.
  /** The project window under a screen point: the most recently focused one holding it (the front one), not minimized. */
  const projectWindowAt = (c: Point): { b: BrowserWindow; root: string } | null => {
    const hits = mainWindows(windowsView).flatMap(([id, root]) => {
      const b = root ? windowById(id) : null;
      if (!b || !root || b.isDestroyed() || b.isMinimized()) return [];
      const r = b.getBounds();
      return c.x >= r.x && c.x < r.x + r.width && c.y >= r.y && c.y < r.y + r.height ? [{ b, root }] : [];
    });
    hits.sort((x, y) => (focusedAt.get(y.b.webContents.id) ?? 0) - (focusedAt.get(x.b.webContents.id) ?? 0));
    return hits[0] ?? null;
  };
  const relIn = (root: string, path: string) => { const base = trimOneSep(root); return isBelow(base, path) ? path.slice(base.length + 1) : path; };
  const mover: TabMover = new TabMover({
    projectWindow: (root) => {
      const b = projectWindow(root);
      return b && !b.isDestroyed() ? { id: b.webContents.id, send: (channel, payload) => sendTo(b, channel, payload), reveal: () => revealWindow(b) } : null;
    },
    inside: (root, p) => insideProject(root, p) !== null,
    grantMode: (root, p) => { const real = grants.check(root, p); return real ? grants.mode(root, real) : null; },
    grant: (root, p, mode) => {
      const real = grants.grant(root, p, mode);
      if (real) outsideOpen.opened(root, [real]);
      return real !== null;
    },
    revoke: (root, p) => grants.revoke(root, p),
    relOf: relIn,
    // Only while atelierd is there: its lists are what a move relabels.
    terminal: (id) => (client.connected ? hub.allTerminals().find((t) => t.id === id) ?? null : null),
    rehome: (id, from, to) => {
      homes.set(id, client.listedProject(id) ?? from, to);
      client.reemit();
      hub.rehomed(id, to);
    },
    popoutKey: (wcId) => popouts.entryOf(wcId)?.key ?? null,
    closePopout: (wcId) => popouts.release(wcId),
    holdPopout: (wcId, on) => popouts.hold(wcId, on),
    poppedOut: (root, key) => popouts.windowFor(root, key) !== null,
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return { clear: () => clearTimeout(t) }; },
    dbScope: (id) => dbStore.get(id)?.scope ?? null
  });
  /** The open project windows, by project root and folder name (the menus' "Move to Window ›"). */
  const projectWindowsInfo = (): ProjectWindowInfo[] => openProjectRoots(windowsView).map((root) => ({ root, name: basename(root) }));
  let windowsKey = '';
  const announceWindows = () => {
    const list = projectWindowsInfo();
    const key = JSON.stringify(list);
    if (key === windowsKey) return;
    windowsKey = key;
    for (const b of BrowserWindow.getAllWindows()) if (windowProjects.has(b.webContents.id)) sendTo(b, IPC.evProjectWindows, list);
  };
  /** mover.canMove for drags (asked on every 16 ms tick): the same answer for half a second, no file checks each tick. */
  const canMoveCache = new Map<string, { at: number; ok: boolean }>();
  const canMoveSoon = (root: string, key: string, to: string): boolean => {
    const k = `${root}\0${key}\0${to}`;
    const hit = canMoveCache.get(k);
    if (hit && Date.now() - hit.at < 500) return hit.ok;
    const ok = mover.canMove(root, key, to);
    if (canMoveCache.size > 64) canMoveCache.clear();
    canMoveCache.set(k, { at: Date.now(), ok });
    return ok;
  };
  /** Over another project's window that can take the tab: its root, the client point there, and its drop hint. */
  const acrossAt = (root: string, key: string, c: Point): { root: string; point: Point; b: BrowserWindow } | null => {
    const h = projectWindowAt(c);
    if (!h || h.root === root || !canMoveSoon(root, key, h.root)) return null;
    const point = dockPoint(c, h.b.getContentBounds(), h.b.webContents.getZoomFactor());
    return point ? { root: h.root, point, b: h.b } : null;
  };
  // Tab tear-off: the ghost that follows a tab dragged out of its project window.
  const tear: TearOff = new TearOff({
    across: (root, key, c) => {
      const a = acrossAt(root, key, c);
      return a ? { root: a.root, point: a.point, hover: (p) => sendTo(a.b, IPC.evDockHover, p ? { ...p, across: true } : null) } : null;
    },
    cursor,
    displays: () => screen.getAllDisplays().map((d) => d.workArea),
    projectBounds: (root) => { const b = projectWindow(root); return b && !b.isDestroyed() ? b.getBounds() : null; },
    createGhost: (bounds) => { try { return makeGhost(bounds, zoomFactor(settings.get().interfaceSize)); } catch { return null; } },
    snapshot: async (root, rect) => {
      const b = projectWindow(root);
      if (!b || b.isDestroyed()) return null;
      // The rect is in CSS pixels; the page is drawn at the interface size's zoom.
      const z = b.webContents.getZoomFactor();
      const img = await b.webContents.capturePage({ x: Math.round(rect.x * z), y: Math.round(rect.y * z), width: Math.round(rect.width * z), height: Math.round(rect.height * z) });
      if (img.isEmpty()) return null;
      // Shown at most at the pop-out's size, translucent: a smaller image is enough and quick to encode.
      const small = img.getSize().width > 1000 ? img.resize({ width: 1000, quality: 'good' }) : img;
      return `data:image/jpeg;base64,${small.toJPEG(76).toString('base64')}`;
    },
    onceReady: (id, fn) => { const b = windowById(id); if (b && !b.isDestroyed()) b.once('ready-to-show', fn); else fn(); },
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return { clear: () => clearTimeout(t) }; },
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); return { clear: () => clearInterval(t) }; }
  });
  const popouts: PopoutManager = new PopoutManager({
    create: (root, bounds, title, onUnloadCancel, onUnloadKept) => {
      const win: BrowserWindow = createPopoutWindow(bounds, zoomFactor(settings.get().interfaceSize), title, { onUnloadCancel, onUnloadKept: () => { quitStopped(); onUnloadKept(); }, ...unsavedAsk(() => win) }, settings.get().theme);
      const wcId = win.webContents.id;
      windowProjects.set(wcId, root);
      windowKinds.set(wcId, 'popout');
      registerHubs(root, win.webContents);
      win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(zoomFactor(settings.get().interfaceSize)));
      win.webContents.on('did-start-loading', () => opener.pageLoading(wcId));
      win.on('closed', () => {
        windowProjects.delete(wcId);
        windowKinds.delete(wcId);
        focusedAt.delete(wcId);
        opener.forget(wcId);
        lastWindowGone(root);
      });
      return asPopoutWin(win);
    },
    projectWindow: (root) => { const b = projectWindow(root); return b ? asProjectWin(b) : null; },
    reveal: (w) => { const b = windowById(w.id); if (b) revealWindow(b); },
    cursor,
    displays: () => screen.getAllDisplays().map((d) => d.workArea),
    ...popoutFileRules({
      inside: (root, p) => insideProject(root, p),
      isFile: (p) => { try { return statSync(p).isFile(); } catch { return false; } },
      real: (p) => { try { return realOut(p); } catch { return null; } },
      check: (root, p) => grants.check(root, p),
      mode: (root, real) => grants.mode(root, real),
      // As a tab restore grants it: a file of Claude's temp folder, or one remembered read-only,
      // read-only; never made editable.
      grant: (root, p, readOnly) => restoreGrants(root, grants, claudeTempDeps, readOnly ? [p] : null).grant(p),
      opened: (root, files) => outsideOpen.opened(root, files)
    }),
    loadSaved: () => uiState.popouts ?? [],
    save: (saved) => { uiState = { ...uiState, popouts: saved }; saveUi(); },
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return { clear: () => clearTimeout(t) }; },
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); return { clear: () => clearInterval(t) }; },
    takeTear: (root) => tear.takeOver(root),
    windowAt: (c) => { const h = projectWindowAt(c); return h ? Object.assign(asProjectWin(h.b), { root: h.root }) : null; },
    canMove: (root, key, to) => canMoveSoon(root, key, to),
    moveAcross: (wcId, r, to, at) => {
      const e = popouts.entryOf(wcId);
      if (!e) return Promise.resolve({ ok: false, reason: 'failed' });
      return mover.move({ wcId, root: e.root, popout: true }, { to, key: e.key, ...(r.payload ? { payload: r.payload } : {}), ...(r.handoff ? { handoff: r.handoff } : {}), at });
    }
  });
  // Only atelierd's own lists (always full): a remembered terminal comes back or goes, an ended one closes its window.
  client.on('terminals', (list: TerminalInfo[]) => popouts.terminalsChanged(list));
  hub.isPopout = (id) => isPopoutWindow(windowsView, id);
  hub.popoutFor = (root, id) => (popouts.windowFor(root, `t:${id}`) ? () => { popouts.focus(root, `t:${id}`); } : null);
  // The main window's renderer can't tell whether a pop-out is in front: main can, and its entries arrive seen.
  hub.viewedInPopout = (root, id) => {
    const w = popouts.windowFor(root, `t:${id}`);
    const b = w ? windowById(w.id) : null;
    return !!b && !b.isDestroyed() && b.isFocused();
  };

  // Main's questions to pages: Aurora sheets in a window, the native dialog only when none
  // can answer (no window, a page not listening yet).
  const asks = new AskBroker((wcId, m) => {
    const wc = webContents.fromId(wcId);
    if (!wc || wc.isDestroyed()) return false;
    wc.send(IPC.evAsk, m);
    return true;
  }, undefined, (wcId, id) => {
    const wc = webContents.fromId(wcId);
    if (wc && !wc.isDestroyed()) wc.send(IPC.evAskWithdrawn, id);
  });
  const askWatched = new WeakSet<Electron.WebContents>();
  /** The window an app-level question goes to: the asking one, else the focused one, else the last focused app window. */
  const askWindow = (from: BrowserWindow | null): BrowserWindow | null => {
    if (from && !from.isDestroyed() && windowProjects.has(from.webContents.id)) return from;
    const all = BrowserWindow.getAllWindows().filter((b) => !b.isDestroyed() && windowProjects.has(b.webContents.id));
    return all.find((b) => b.isFocused()) ?? all.sort((a, b) => (focusedAt.get(b.webContents.id) ?? 0) - (focusedAt.get(a.webContents.id) ?? 0))[0] ?? null;
  };
  // A page that doesn't say it got the question within this (hung), or stops responding: the native dialog instead.
  const askShownMs = testMs('ATELIER_TEST_ASK_SHOWN_MS') ?? 2000;
  const askIn = <R extends AskRequest>(from: BrowserWindow | null, request: R): Promise<AskAnswer<R['kind']> | null> => {
    const win = askWindow(from);
    if (!win || !asks.isReady(win.webContents.id)) return Promise.resolve(null);
    revealWindow(win);
    return asks.ask(win.webContents.id, request, { shownMs: askShownMs });
  };

  // An update's restart, an OS shutdown or logout: everything keeps running for this long, however the windows go
  // (unsaved files close them one by one or resume the quit later). The updater's helper
  // waits as long.
  const RESTART_KEEP_MS = 120_000;
  // A project window closing or Atelier quitting stops what runs in it.
  const closeGuard = new CloseGuard<BrowserWindow>({
    mode: () => effectiveCloseMode(settings.get().closeWindowSessions, hub.canStopResumable(), devEnv('ATELIER_TEST_CLOSE_SESSIONS')),
    busy: async (roots) => {
      const all = hub.allTerminals();
      const foreground = await busyShells(all.filter((t) => roots.includes(t.projectRoot) && !t.session));
      const scheduled = hub.scheduledPrompts();
      return roots.map((r) => projectBusy(r, all, scheduled, foreground));
    },
    ask: (win, request) => askCloseSessions(win, request),
    stop: (root) => hub.stopProject(root),
    log: (message) => { appLog.write({ source: 'main:close', message }); }
  });

  // Never asked during Mac shutdown or restart (a dialog would cancel it), nor about sessions then: atelierd's registry
  // makes them resumable.
  let quitConfirmed = false;
  // The sessions' question of this quit was answered.
  let sessionsDecided = false;
  // A git write running or queued: ask first. Wait cancels the quit; Quit Anyway stops them.
  let gitQuitAnyway = false;
  // That quit called off afterwards (a page kept, the info dialog cancelled): Source Control works again (it answered
  // "Atelier is quitting" to every op until a restart) and the next quit asks again.
  const gitResumes = () => {
    if (!gitQuitAnyway) return;
    gitQuitAnyway = false;
    gitOps.resume();
  };
  // Windows: closing the last window quits; a quit called off there must not leave the app running with no window.
  // Windows with no window left: one comes back, unless the notification-area icon is there to reach the app.
  const quitCalledOff = () => {
    // A question that went with its window while a later quit goes on (⌘Q again over the first-quit sheet): that quit
    // stands; nothing comes back.
    if (quitting) return;
    gitResumes();
    updates?.quitCalledOff();
    // An answer about the sessions given before the quit was called off (git's Wait) must not be applied later.
    sessionsDecided = false;
    closeGuard.forgetAll();
    if (reopensAfterCancelledQuit(currentPlatform(), settings.get().trayIcons, BrowserWindow.getAllWindows().length)) openWindow(null);
  };
  // The quit's questions in the front window; the native dialog when no window can answer.
  const askQuitGit = async (p: NonNullable<ReturnType<typeof quitPrompt>>): Promise<boolean> => {
    const asked = await askIn(null, { kind: 'quit-git', title: p.message, detail: p.detail, ops: p.ops });
    if (asked !== null) return asked === 'quit';
    const r = await dialog.showMessageBox({ type: 'warning', buttons: ['Wait', 'Quit Anyway'], defaultId: 0, cancelId: 0, message: p.message, detail: p.detail });
    return r.response === 1;
  };
  // A project window closing or Atelier quitting with busy sessions: asked in the window;
  // the native dialog when no page can answer.
  const askCloseSessions = async (from: BrowserWindow | null, request: CloseSessionsAsk): Promise<CloseAnswer> => {
    const asked = await askIn(from, request);
    if (asked !== null) return asked;
    const quit = request.what === 'quit';
    const opts = {
      type: 'warning' as const, buttons: ['Keep in Background', quit ? 'Stop and Quit' : 'Stop and Close', 'Cancel'], defaultId: 0, cancelId: 2,
      message: quit ? 'Quit Atelier?' : `Close “${request.projects[0]?.name ?? ''}”?`,
      detail: 'Some sessions are still busy. Stopped Claude sessions wait under Resume the next time you open their project.'
    };
    const parent = from && !from.isDestroyed() ? from : null;
    const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
    return r.response === 0 ? 'keep' : r.response === 1 ? 'stop' : 'cancel';
  };
  app.on('before-quit', (e) => {
    const gitPrompt = quitConfirmed || gitQuitAnyway ? null : quitPrompt(gitOps.runningOps());
    if (gitPrompt) {
      e.preventDefault();
      void askQuitGit(gitPrompt).then((quit) => {
        if (!quit) { quitCalledOff(); return; }
        gitQuitAnyway = true;
        // The ops stop as Cancel would; the app quits once their cleanups (rebase --abort, a stash popped back) ended.
        void quitAnyway({ ops: gitOps, stopWrites: stopAllWrites, quit: () => app.quit() });
      });
      return;
    }
    // Quitting: pop-outs close without docking and stay remembered (until a kept page cancels the quit: quitStopped).
    if (quitConfirmed || sessionsDecided) { quitting = true; popouts.quitting = true; persistOpenProjects(); return; }
    // One question for every project window's busy sessions.
    e.preventDefault();
    void closeGuard.decideQuit(openProjectRoots(windowsView), null).then((go) => {
      if (go) { sessionsDecided = true; app.quit(); } else quitCalledOff();
    });
  });
  // The stop requests of the windows that closed reach atelierd before the process goes (at most 3 s).
  let stopsAwaited = false;
  app.on('will-quit', (e) => {
    if (stopsAwaited || !closeGuard.hasPending()) return;
    stopsAwaited = true;
    e.preventDefault();
    void closeGuard.settle(3000).then(() => app.exit(0));
  });

  /** Service restart, only on request and with confirmation: sessions are closed and left to be resumed. */
  const restartDaemon = async (from: BrowserWindow | null) => {
    const opts = {
      type: 'warning' as const, buttons: ['Restart', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'Restart atelierd?',
      detail: 'Every terminal and Claude session in Atelier will be closed. Claude sessions can be resumed afterwards from the sidebar.'
    };
    // Asked in the window with what closes; the native dialog when no window can answer.
    const asked = await askIn(from, restartAsk(hub.allTerminals()));
    const go = asked !== null ? asked === 'restart' : (from ? await dialog.showMessageBox(from, opts) : await dialog.showMessageBox(opts)).response === 0;
    if (!go) return;
    // A service of another version accepts no requests, not even shutdown: it is stopped with a signal.
    if (client.isIncompatible) {
      if (!(await stopStaleDaemon(paths.info))) {
        // A toast with Open Logs in the window; the native error box when none listens.
        const win = askWindow(from);
        if (win && asks.isReady(win.webContents.id)) win.webContents.send(IPC.evAppNotice, { kind: 'restart-failed' } satisfies AppNotice);
        else dialog.showErrorBox('Could not restart atelierd', `The running atelierd did not stop. Its log is in ${paths.log}.`);
        return;
      }
      await client.retry().catch(() => {});
      return;
    }
    // On close the client reconnects by itself and ensureDaemon starts this app's version.
    await client.request({ t: 'shutdown' }).catch(() => {});
  };

  // Windows: the Jump List — sessions waiting for you, recent projects, New Window. Set only when
  // it changes; the recents (a stat per folder) read again only when a project opens or a window comes forward.
  const jumpFeed = new JumpListFeed({
    exe: process.execPath, newWindow: 'New Window',
    recents: () => recentForWelcome(uiState, isDir),
    set: (list) => {
      try { app.setJumpList(list); } catch { /* a Jump List refused (no Start menu shell): the app works without it */ }
    }
  });
  const refreshJumpList = () => { if (process.platform === 'win32') jumpFeed.refreshRecents(); };
  if (process.platform === 'win32') app.on('browser-window-focus', refreshJumpList);
  /**
   * Windows: what a second launch hands over — a Jump List entry (--reveal, --new-window), folders and files from File
   * Explorer (Open with, a drop on the shortcut). True when something was done.
   */
  const openFromWindowsArgv = (argv: string[]): boolean => {
    // A session gone (a stale entry) or atelierd not listed yet (at start): the usual windows open instead.
    const reveal = revealArg(argv);
    if (reveal) return hub.revealTerminal(reveal);
    if (argv.includes('--new-window')) { openWindow(null); return true; }
    const paths = argvPaths(argv, app.isPackaged).filter((p) => existsSync(p));
    for (const p of paths) { if (isDir(p)) openWindow(p); else opener.openFromSystem(p); }
    return paths.length > 0;
  };

  /**
   * The app brought forward (a second launch, the tray's Open Atelier): the window in use (windowToFront), or a new one.
   * The tear-off ghost never takes the focus, so it is never one.
   */
  const openApp = () => {
    const all = BrowserWindow.getAllWindows().filter((b) => !b.isDestroyed() && b.isFocusable());
    const id = windowToFront(all.map((b) => {
      const wcId = b.webContents.id;
      return { id: wcId, popout: isPopoutWindow(windowsView, wcId), usedAt: Math.max(focusedAt.get(wcId) ?? 0, revealedAt(b)) };
    }));
    const front = all.find((b) => b.webContents.id === id);
    if (front) revealWindow(front);
    else openWindow(null);
  };

  app.on('second-instance', (_e, argv) => {
    const root = projectFromArgv(argv);
    if (root) openWindow(root);
    else if (process.platform === 'win32' && openFromWindowsArgv(argv)) return;
    else openApp();
  });

  void app.whenReady().then(async () => {
    nativeTheme.themeSource = themeOf(settings.get().theme).appearance;
    powerMonitor.on('shutdown', () => { quitConfirmed = true; closeGuard.keepFor(RESTART_KEEP_MS); });
    // Waking or a display coming and going (not a mere unlock: nothing moves then, and a resync drops scroll position and
    // selection): once things settle, the Claude sessions' screens come again from atelierd.
    const resync = new ScreenResync({ delayMs: 1000, run: () => hub.resyncScreens(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) });
    powerMonitor.on('resume', () => resync.poke());
    screen.on('display-added', () => resync.poke());
    screen.on('display-removed', () => resync.poke());
    screen.on('display-metrics-changed', (_e, _d, changed) => { if (isLayoutChange(changed)) resync.poke(); });
    // Windows: logging off or shutting down never waits on the quit dialog (powerMonitor's shutdown is macOS's). A window
    // with unsaved files holds it ("Atelier is preventing shutdown") and the app quits, so its question comes forward.
    const sessionEnd = new SessionEndGuard();
    const unsavedWatched = new Set<number>();
    ipcMain.on(IPC.unsavedState, (e, arg) => {
      if (!isAppUrl(e.senderFrame?.url ?? '')) return;
      const o = unsavedStateSchema.safeParse(arg);
      if (!o.success) return;
      const id = e.sender.id;
      if (!unsavedWatched.has(id)) {
        unsavedWatched.add(id);
        e.sender.once('destroyed', () => { unsavedWatched.delete(id); sessionEnd.drop(id); });
        // A reload starts with nothing unsaved; the page says so again if it has.
        e.sender.on('did-navigate', () => sessionEnd.set(id, false));
      }
      sessionEnd.set(id, o.data);
    });
    if (process.platform === 'win32') {
      app.on('browser-window-created', (_e, b) => {
        const id = b.webContents.id;
        b.on('query-session-end', (e) => {
          closeGuard.keepFor(RESTART_KEEP_MS);
          if (!sessionEnd.query(id, () => { quitConfirmed = true; app.quit(); })) return;
          e.preventDefault();
          quitConfirmed = true;
        });
        b.on('session-end', () => { quitConfirmed = true; closeGuard.keepFor(RESTART_KEEP_MS); });
      });
    }
    app.setAboutPanelOptions(aboutPanelOptions(new Date().getFullYear()));
    // The Dock icon again now that the app is up (development: Atelier's, not Electron's), then the bundle's.
    void appIcon.ready();
    hideTestDockIcon(app.dock);
    ipcMain.handle(IPC.project, (e): ProjectInfo | null => {
      if (!isAppUrl(e.senderFrame?.url ?? '')) return null;
      const root = windowProjects.get(e.sender.id);
      if (!root) return null;
      let realRoot = root;
      try { realRoot = realOut(root); } catch { /* folder gone: use it as is */ }
      // A pop-out learns its tab before anything renders.
      const pop = popouts.entryOf(e.sender.id);
      return { root, name: basename(root), realRoot, ...(pop ? { popout: { key: pop.key, ...(pop.payload ? { payload: pop.payload } : {}) } } : {}) };
    });
    ipcMain.handle(IPC.daemonRestart, (e) => {
      if (!isAppUrl(e.senderFrame?.url ?? '')) return;
      return restartDaemon(BrowserWindow.fromWebContents(e.sender));
    });
    const trusted = (e: Electron.IpcMainInvokeEvent) => isAppUrl(e.senderFrame?.url ?? '');
    // Main's questions to a page: asked once the page listens, forgotten when it goes.
    ipcMain.handle(IPC.askReady, (e) => {
      if (!trusted(e)) return;
      const wc = e.sender;
      if (!askWatched.has(wc)) {
        askWatched.add(wc);
        const gone = () => asks.gone(wc.id);
        wc.once('destroyed', gone);
        wc.on('render-process-gone', gone);
        // A navigation that happened (a reload), not one asked and blocked (a stray drop): the page listens again once
        // it has mounted (ask:ready).
        wc.on('did-navigate', gone);
        // Hung: main's own questions there fall back to the native dialog (a quit with git running must stay possible).
        wc.on('unresponsive', () => asks.unresponsive(wc.id));
      }
      asks.ready(wc.id);
    });
    ipcMain.handle(IPC.askShown, (e, arg) => {
      if (!trusted(e)) return false;
      const o = askShownSchema.parse(arg);
      return asks.shown(e.sender.id, o.id);
    });
    ipcMain.handle(IPC.askAnswer, (e, arg) => {
      if (!trusted(e)) return false;
      const o = askAnswerSchema.parse(arg);
      return asks.answer(e.sender.id, o.id, o.answer);
    });
    ipcMain.handle(IPC.settingsGet, (e) => (trusted(e) ? settings.get() : null));
    ipcMain.handle(IPC.settingsSet, (e, patch) => (trusted(e) ? settings.set(patch) : null));
    // The page asked already, in the Settings nav.
    ipcMain.handle(IPC.settingsReset, (e) => (trusted(e) ? settings.reset() : null));
    ipcMain.handle(IPC.appInfo, (e): AppInfo | null => (trusted(e) ? { version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, packaged: app.isPackaged } : null));
    installErrorLog(appLog, (e) => isAppUrl(e.senderFrame?.url ?? ''), devEnv('ATELIER_TEST_RENDER_ERROR') ?? null);
    // App folders, never the project's: the atelierd logs and the licenses bundled in the package.
    ipcMain.handle(IPC.openLogs, async (e) => { if (trusted(e)) await shell.openPath(paths.logDir); });
    ipcMain.handle(IPC.notifyTest, (e) => { if (trusted(e)) hub.testNotification(); });
    ipcMain.handle(IPC.notifySettings, async (e) => { if (trusted(e)) await shell.openExternal(process.platform === 'win32' ? 'ms-settings:notifications' : 'x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=app.atelier.desktop'); });
    // The folder is that of the requesting window: the renderer passes no paths.
    ipcMain.handle(IPC.revealProject, async (e) => {
      const root = windowProjects.get(e.sender.id);
      if (trusted(e) && root && isDir(root)) await revealFolder(root);
    });
    updates = installUpdates(paths.home, trusted, {
      log: (message) => { appLog.write({ source: 'main:update', message }); },
      channelSetting: () => settings.get().updateChannel,
      // An update's restart keeps every session running: nothing asked, nothing stopped.
      beforeRestart: () => { closeGuard.keepFor(RESTART_KEEP_MS); }
    });
    installDictationIpc(dictation, trusted, (id) => windowProjects.get(id) ?? null, devEnv('ATELIER_TEST_FAKE_MIC') ?? null, (project, terminalId) => hub.accountDirOf(project, terminalId));
    // Connectors: ClickUp, Notion, then Jira, main only. Their network
    // goes through Electron's net in a session each, to mcp.clickup.com / mcp.notion.com / mcp.atlassian.com +
    // auth.atlassian.com only (the local fakes in tests); a token is encrypted
    // with safeStorage, which is touched only when a saved connection exists or on Connect (never at a plain launch).
    // e2e use a stand-in, never the Keychain (ATELIER_TEST_FAKE_SAFE_STORAGE), and may let main follow the authorize
    // page (ATELIER_TEST_FOLLOW_AUTH).
    // One transport (and session) per connector, each allowing only its own endpoint's origin: a Notion request can
    // never reach ClickUp's origin, nor the reverse.
    const userAgent = `Atelier/${app.getVersion()}`;
    const connectorStore = secretStoreFor(paths.home, safeStorage);
    let connectors: ConnectorRegistry | null = null;
    let automations: ReturnType<typeof createAutomations> | null = null;
    const connectorDeps = (endpoint: { allow: (u: URL) => boolean }, partition: string) => {
      const transport = electronTransport(endpoint.allow, userAgent, partition);
      return {
        store: connectorStore,
        transport,
        openAuthPage: devEnv('ATELIER_TEST_FOLLOW_AUTH') === '1' ? followAuthorize(transport, endpoint.allow) : (url: string) => { void openUrl(url); },
        focused: () => hiddenWindows() || BrowserWindow.getAllWindows().some((b) => b.isFocused()),
        log: (message: string) => { appLog.write({ source: 'main:connectors', message }); },
        onChange: () => { connectors?.changed(); automations?.runner.connectorsChanged(); },
        onNotice: (n: ConnectorNotice, origin?: number) => connectors?.notice(n, origin),
        // The window that started Connect comes forward (never in e2e: hidden-windows.ts).
        reveal: (origin: number) => {
          const win = BrowserWindow.getAllWindows().find((b) => !b.isDestroyed() && b.webContents.id === origin);
          if (win) revealWindow(win);
        },
        clientVersion: app.getVersion()
      };
    };
    const clickupEp = clickupEndpoint();
    const clickup = new ClickUpConnector({ ...connectorDeps(clickupEp, 'atelier-connectors'), endpoint: clickupEp });
    const notionEp = notionEndpoint();
    const notion = new NotionConnector({ ...connectorDeps(notionEp, 'atelier-connectors-notion'), endpoint: notionEp });
    const jiraEp = jiraEndpoint();
    const jira = new JiraConnector({ ...connectorDeps(jiraEp, 'atelier-connectors-jira'), endpoint: jiraEp });
    connectors = new ConnectorRegistry([clickup, notion, jira], {
      windows: () => BrowserWindow.getAllWindows().filter((b) => !b.isDestroyed()).map((b) => ({
        id: b.webContents.id, send: (channel, payload) => b.webContents.send(channel, payload), isDestroyed: () => b.isDestroyed() || b.webContents.isDestroyed()
      })),
      focusedId: () => BrowserWindow.getFocusedWindow()?.webContents.id ?? null
    });
    // A linked task opens in its desktop app when installed (Settings › Connectors, one toggle per connector), else in
    // the browser.
    connectors.installIpc((channel, fn) => ipcMain.handle(channel, fn), trusted, openUrl,
      async (url, source) => opensInApp(settings.get(), source) && openAppUrl(url));
    clickup.init();
    notion.init();
    jira.init();
    app.on('browser-window-focus', () => connectors?.windowFocused());
    app.on('will-quit', () => connectors?.dispose());
    // Automations: app-wide, every project's, also for projects with no window.
    automations = createAutomations({
      home: paths.home, settings, connectors: { clickup, notion, jira } as never, hub, gitOps,
      fetchNow: (root, common) => scmHub.fetchNow(root, common),
      windows: () => BrowserWindow.getAllWindows().filter((b) => !b.isDestroyed()).map((b) => ({
        send: (channel: string, payload: unknown) => b.webContents.send(channel, payload), isDestroyed: () => b.isDestroyed() || b.webContents.isDestroyed()
      })),
      projectOf: (e) => windowProjects.get(e.sender.id) ?? null,
      trusted,
      log: (message) => { appLog.write({ source: 'main:automations', message }); },
      gitExe: currentPlatform() === 'win32'
        ? [join(process.resourcesPath, 'bin', 'atelier-git.exe'), join(__dirname, '..', '..', 'vendor', 'bin', 'atelier-git.exe')].find((p) => existsSync(p)) ?? null
        : null,
      revealAutomations: (project) => {
        const win = BrowserWindow.getAllWindows().find((b) => !b.isDestroyed() && windowProjects.get(b.webContents.id) === project);
        if (!win) { openWindow(project); return; }
        revealWindow(win);
        sendCommand('view-automations', win);
      }
    });
    automations.installIpc((channel, fn) => ipcMain.handle(channel, fn));
    automations.runner.start();
    app.on('will-quit', () => automations?.dispose());
    ipcMain.handle(IPC.openLicenses, async (e) => {
      if (trusted(e)) await shell.openPath(app.isPackaged ? join(process.resourcesPath, 'licenses') : join(app.getAppPath(), 'assets/licenses'));
    });
    ipcMain.handle(IPC.recentProjects, (e) => (isAppUrl(e.senderFrame?.url ?? '') ? recentForWelcome(uiState, isDir) : []));
    ipcMain.handle(IPC.openRecent, (e, arg) => {
      if (!isAppUrl(e.senderFrame?.url ?? '') || typeof arg !== 'string') return;
      // Only a path that is really among the recents: the renderer cannot open arbitrary folders.
      if (!uiState.recent.includes(arg) || !isDir(arg)) return;
      const from = BrowserWindow.fromWebContents(e.sender);
      const welcome = from && windowProjects.get(from.webContents.id) === null ? from : null;
      if (openWindow(arg, welcome)) welcome?.close();
    });
    // Forgets a recent folder (the welcome window's ×), then answers with the recents left to show.
    ipcMain.handle(IPC.forgetRecent, (e, arg) => {
      if (!isAppUrl(e.senderFrame?.url ?? '') || typeof arg !== 'string') return [];
      const next = forgetRecent(uiState, arg);
      if (next !== uiState) { uiState = next; saveUi(); refreshJumpList(); }
      return recentForWelcome(uiState, isDir);
    });
    ipcMain.handle(IPC.newWindow, (e) => { if (isAppUrl(e.senderFrame?.url ?? '')) newWindow(); });
    ipcMain.handle(IPC.openFolder, (e) => {
      if (!isAppUrl(e.senderFrame?.url ?? '')) return;
      return chooseFolder(BrowserWindow.fromWebContents(e.sender));
    });
    hub.installIpc();
    installFilesIpc((id) => windowProjects.get(id) ?? null, (e) => isAppUrl(e.senderFrame?.url ?? ''), (path) => bash.noteAppWrite(path), (root) => grantedOf(grants, root), claudeTempDeps, { grants, home: toOut(homedir()) });
    // Videos in a tab: tokens over atelier-media:, read-only.
    installMedia((id) => windowProjects.get(id) ?? null, (e) => isAppUrl(e.senderFrame?.url ?? ''), (root) => grantedOf(grants, root));
    installClipboardIpc((id) => windowProjects.get(id) ?? null, (e) => isAppUrl(e.senderFrame?.url ?? ''), paths.home, (root) => grantedOf(grants, root));
    opener.installIpc();
    installShellCommandIpc((e) => isAppUrl(e.senderFrame?.url ?? ''), () => shellCommandDeps(app.isPackaged, process.resourcesPath));
    // A pop-out never saves nor restores the project's tabs: those are the main window's.
    // Its reports count the pop-outs' outside files too: theirs stay watched and protected from the grants' limit.
    installTabsIpc({
      projectOf: (id) => (isPopoutWindow(windowsView, id) ? null : windowProjects.get(id) ?? null), isTrusted: (e) => isAppUrl(e.senderFrame?.url ?? ''), grants, store: tabsStore, outside: outsideOpen,
      popoutFiles: (root) => popouts.keys(root).filter((k) => k.startsWith('f:')).map((k) => k.slice(2)),
      claudeTempDeps
    });
    gitHub.installIpc((id) => windowProjects.get(id) ?? null, (e) => isAppUrl(e.senderFrame?.url ?? ''));
    // Find in Files: the project's real root and the repositories found in it, as ⌘K lists them; its worker is bundled
    // next to this file. The project's watcher says when files change after a search.
    const findInFiles = installSearchIpc({
      projectOf: (e) => {
        const root = windowProjects.get(e.sender.id);
        const info = root ? gitHub.info(root) : null;
        return info ? { root: info.root, discovered: info.discovered } : null;
      },
      isTrusted: (e) => isAppUrl(e.senderFrame?.url ?? ''),
      workerPath: join(__dirname, 'search-worker.js')
    });
    gitHub.onFilesChanged = (root, ignoredOnly) => findInFiles.filesChanged(root, ignoredOnly);
    scmHub.installIpc((id) => windowProjects.get(id) ?? null, (e) => isAppUrl(e.senderFrame?.url ?? ''));
    // Git writes: project windows' app pages only (a tab pop-out has no commit drawer, no sheets).
    gitOps.installIpc((id) => (isPopoutWindow(windowsView, id) ? null : windowProjects.get(id) ?? null), (e) => isAppUrl(e.senderFrame?.url ?? ''),
      (channel, fn) => ipcMain.handle(channel, fn));
    // Context usage: a private copy of a session, asked by a project window's pages
    // (pop-outs included). Its session, folder and account come from main's own terminal list, never the page; files
    // outside the project open read-only.
    const contextUsage = new ContextService({
      terminal: (id) => hub.allTerminals().find((t) => t.id === id) ?? null,
      accountDir: (project, terminalId) => hub.accountDirOf(project, terminalId),
      isDefaultDir: (dir) => samePath(trimOneSep(dir), trimOneSep(defaultConfigDirNow())),
      claudeBin: () => devEnv('ATELIER_TEST_CONTEXT_CLAUDE') ?? findClaude(claudeCandidates()),
      userEnv: async () => (await userEnv.get()).env,
      globalFile: (dir) => configRootsFor(dir).globalFile,
      grant: (project, path) => grants.grant(project, path, 'read'),
      home: toOut(homedir()),
      now: Date.now
    });
    app.on('will-quit', () => contextUsage.dispose());
    installContextIpc(contextUsage, {
      projectOf: (id) => windowProjects.get(id) ?? null,
      isTrusted: trusted,
      handle: (channel, fn) => ipcMain.handle(channel, fn)
    });
    // Ask: a project window's pages, pop-outs included (a popped-out session has its panel too).
    // A binding's session and account come from main's own terminal list (and the session's transcript), never the page.
    installCompanionIpc(companion, {
      projectOf: (id) => windowProjects.get(id) ?? null,
      isTrusted: trusted,
      handle: (channel, fn) => ipcMain.handle(channel, fn),
      accountDir: (project, terminalId) => hub.accountDirOf(project, terminalId),
      terminal: companionTerm,
      hasTranscript: transcriptExists
    });
    servicesHub.installIpc((id) => windowProjects.get(id) ?? null, (e) => isAppUrl(e.senderFrame?.url ?? ''));
    installDockerIpc(dockerHub, (id) => windowProjects.get(id) ?? null, (e) => isAppUrl(e.senderFrame?.url ?? ''));
    installRedisIpc(redisHub, (id) => windowProjects.get(id) ?? null, (e) => isAppUrl(e.senderFrame?.url ?? ''));
    installDbIpc(dbHub, (id) => windowProjects.get(id) ?? null, (e) => isAppUrl(e.senderFrame?.url ?? ''));
    portsHub.installIpc((id) => windowProjects.get(id) ?? null, (e) => isAppUrl(e.senderFrame?.url ?? ''), openUrl);
    prHub.installIpc((id) => windowProjects.get(id) ?? null, (e) => isAppUrl(e.senderFrame?.url ?? ''), openUrl);
    const sendCommand = (c: MenuCommand, win?: Electron.BaseWindow) => {
      const target = (win instanceof BrowserWindow ? win : null) ?? BrowserWindow.getFocusedWindow();
      if (!target) return;
      // A project window gets it as always; a pop-out keeps its tab's commands and sends the rest (rule 9).
      const plan = commandPlan(c, target.webContents.id, windowsView);
      if (plan.close !== null) { const b = windowById(plan.close); if (b) sendTo(b, IPC.evPopoutClose); }
      for (const id of plan.send) { const b = windowById(id); if (b) sendTo(b, IPC.evCommand, c); }
      if (plan.reveal !== null) { const b = windowById(plan.reveal); if (b) revealWindow(b); }
    };
    installPopoutIpc({
      isTrusted: trusted,
      kindOf: (id) => windowKinds.get(id),
      projectOf: (id) => windowProjects.get(id) ?? null,
      popouts,
      tear,
      forward: (root, cmd) => {
        const b = projectWindow(root);
        if (!b) return;
        sendTo(b, IPC.evCommand, cmd);
        revealWindow(b);
      },
      // The opener hands the path to the pop-out's project window (targetOf) and brings that window forward. The page
      // named it: never granted (a project file or one granted before), never a folder.
      openInMain: (wcId, path, line) => {
        const w = windowById(wcId);
        if (w) opener.openLinked(w, path, line);
      },
      // The project window's dock handler inserts and activates it, as for a tab moved back.
      showInMain: (root, ev) => {
        const b = projectWindow(root);
        if (!b) return;
        sendTo(b, IPC.evDock, ev);
        revealWindow(b);
      },
      moveTo: (from, r) => mover.move(from, r),
      adopted: (wcId, a) => mover.adopted(wcId, a),
      projectWindows: projectWindowsInfo,
      // Released outside its window over another project's window that takes it: moved there, never popped out.
      moveAtCursor: async (root, wcId, r) => {
        const a = acrossAt(root, r.key, cursor());
        if (!a) return null;
        const res = await mover.move({ wcId, root, popout: false }, { to: a.root, key: r.key, ...(r.payload ? { payload: r.payload } : {}), ...(r.handoff ? { handoff: r.handoff } : {}), at: a.point });
        return res.ok ? { ok: false, reason: 'moved' } : { ok: false, reason: res.reason === 'refused' ? 'refused' : 'failed' };
      }
    });
    // Rebuilt when atelierd changes (a restart can bring terminal profiles), only if what it shows changed.
    let menuKey = '';
    // Git › Undo Last Commit follows the window in front: each project window reports its state.
    const menuStates = new MenuStates();
    const menuWatched = new Set<number>();
    // View › Services and Automations (2026-11-02): listed once turned on in Settings, from main's settings; Toggle
    // Workspaces for This Project disabled while they are on in every project. View › Word Wrap checked while it is on.
    const menuViews = () => ({ services: settings.get().showServices, automations: settings.get().automationsEnabled, wsEverywhere: settings.get().workspacesEverywhere, wordWrap: settings.get().wordWrap });
    // Windows: no native menu; each window draws its own from this model.
    const winMenu = new WindowsMenuHost({
      windows: () => menuTargets(BrowserWindow.getAllWindows(), isAppUrl)
        .map((b) => ({ id: b.webContents.id, send: (m) => sendTo(b, IPC.evMenuModel, m) })),
      build: (id) => windowsMenu(MENU_SPEC, {
        profiles: hub.daemonState().profilesAvailable ? profileOptions(shells()) : null,
        accounts: accountsOf(settings.get(), defaultConfigDirNow()).list.map((a) => ({ id: a.id, label: a.name })),
        state: { ...menuStates.of(id), ...menuViews() }, isPackaged: app.isPackaged
      }),
      watch: (id, gone) => webContents.fromId(id)?.once('destroyed', gone)
    });
    const runRole = (r: WinRole, win: BrowserWindow | null, wc: Electron.WebContents) => {
      switch (r) {
        case 'undo': wc.undo(); return;
        case 'redo': wc.redo(); return;
        case 'cut': wc.cut(); return;
        case 'copy': wc.copy(); return;
        case 'paste': wc.paste(); return;
        case 'selectAll': wc.selectAll(); return;
        case 'minimize': win?.minimize(); return;
        case 'maximize': if (win?.isMaximized()) win.unmaximize(); else win?.maximize(); return;
        case 'close': win?.close(); return;
        case 'quit': app.quit(); return;
        case 'togglefullscreen': win?.setFullScreen(!win.isFullScreen()); return;
        case 'reload': wc.reload(); return;
        case 'toggleDevTools': wc.toggleDevTools(); return;
      }
    };
    if (currentPlatform() === 'win32') {
      Menu.setApplicationMenu(null);
      ipcMain.handle(IPC.menuModel, (e) => {
        if (!isAppUrl(e.senderFrame?.url ?? '')) throw new Error('unauthorized sender');
        return winMenu.model(e.sender.id);
      });
      ipcMain.on(IPC.menuInvoke, (e, id: unknown) => {
        if (!isAppUrl(e.senderFrame?.url ?? '') || typeof id !== 'string' || !winMenu.allowed(e.sender.id, id)) return;
        const win = BrowserWindow.fromWebContents(e.sender);
        runMenuItem(id, {
          command: (c) => sendCommand(c, win ?? undefined),
          action: (a) => {
            if (a === 'open-folder') void chooseFolder(win);
            else if (a === 'new-window') newWindow();
            else if (a === 'restart-daemon') void restartDaemon(win);
            // Help › Check for Updates… asks the Microsoft Store; About shows it.
            else if (a === 'check-for-updates') { updates?.checkNow(); sendCommand('open-about', win ?? undefined); }
          },
          role: (r) => runRole(r, win, e.sender)
        });
      });
    } else {
      ipcMain.handle(IPC.menuModel, () => null);
    }
    const refreshMenu = () => {
      if (currentPlatform() === 'win32') { winMenu.refresh(); return; }
      const profiles = hub.daemonState().profilesAvailable ? profileOptions(shells()) : null;
      // File › New Session with Account: the accounts as they apply here.
      const accounts = accountsOf(settings.get(), defaultConfigDirNow()).list.map((a) => ({ id: a.id, label: a.name }));
      const state = { ...menuStates.front(BrowserWindow.getFocusedWindow()?.webContents.id ?? null), ...menuViews() };
      const key = JSON.stringify([profiles, accounts, state]);
      if (key === menuKey) return;
      menuKey = key;
      Menu.setApplicationMenu(buildMenu({
        openFolder: () => void chooseFolder(BrowserWindow.getFocusedWindow()), newWindow, command: sendCommand,
        restartDaemon: () => void restartDaemon(BrowserWindow.getFocusedWindow()),
        // The check runs in main; the front window shows its progress in Settings › About.
        checkForUpdates: (win) => { updates?.checkNow(); sendCommand('open-about', win); }
      }, profiles, accounts, state));
    };
    refreshMenu();
    client.on('status', refreshMenu);
    settings.onChange(refreshMenu);
    ipcMain.on(IPC.menuState, (e, arg) => {
      if (!isAppUrl(e.senderFrame?.url ?? '')) return;
      const o = menuStateSchema.safeParse(arg);
      if (!o.success) return;
      const id = e.sender.id;
      if (!menuWatched.has(id)) {
        menuWatched.add(id);
        e.sender.once('destroyed', () => { menuWatched.delete(id); menuStates.drop(id); refreshMenu(); });
      }
      menuStates.set(id, o.data);
      refreshMenu();
    });
    app.on('browser-window-focus', refreshMenu);

    // Windows do not wait for the service: if it does not respond they show the state and the client retries by itself.
    void client.start().catch(() => {});

    const fromArgv = projectFromArgv(process.argv);
    const toOpen = fromArgv ? [fromArgv] : uiState.openProjects.filter(isDir);
    // Windows: Open with Atelier on a folder or a file starts the app with it on the command line.
    const handed = process.platform === 'win32' && !fromArgv && openFromWindowsArgv(process.argv);
    if (!handed) {
      // None (or none that could open: a network folder on Windows): the welcome window.
      const opened = toOpen.map((p) => openWindow(p)).filter((w) => w !== null);
      if (opened.length === 0) openWindow(null);
    }
    opener.appStarted();
    hub.onDockEntries = (entries) => { if (process.platform === 'win32') jumpFeed.setWaiting(entries); };
    refreshJumpList();
    // The session icons (spec session tray icons). Tests never reach the real menu bar: the log stands for it, and a
    // test drives the icons through __atelierTestTray.
    const trayLog = devEnv('ATELIER_TEST_TRAY_LOG');
    const tray = hub.startTray({
      host: trayLog ? null : electronTrayHost(currentPlatform()),
      ...(trayLog && { log: (line: unknown) => appendFileSync(trayLog, JSON.stringify(line) + '\n') }),
      openApp,
      quit: () => app.quit(),
      turnOff: () => settings.set({ trayIcons: false }),
      onError: (e) => { appLog.write({ source: 'main:tray', message: String(e) }); }
    });
    if (trayLog) (globalThis as { __atelierTestTray?: typeof tray }).__atelierTestTray = tray;

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) openWindow(null); });
  });

  // On macOS closing the windows does not quit the app; quitting does not stop atelierd: sessions stay alive.
  // Windows has no Dock to stay in: the last window closed quits (atelierd and the sessions go on, as after a quit).
  // With the notification-area icon on it stays there instead, said once.
  let trayNote: Notification | null = null;
  app.on('window-all-closed', () => {
    const next = afterAllClosed(currentPlatform(), settings.get().trayIcons, uiState.trayInfoShown === true);
    if (next === 'quit') { app.quit(); return; }
    if (next === 'stay') return;
    uiState = { ...uiState, trayInfoShown: true };
    saveUi();
    const testLog = devEnv('ATELIER_TEST_NOTIFY_LOG');
    if (!testLog && !Notification.isSupported()) return;
    const banner = { title: 'Atelier is still running', body: 'It stays in the notification area: click its icon to open it again or to quit.', silent: true };
    showBanner(banner, testLog, () => {
      // Held until it goes: without a reference the click handler could be collected.
      const note = new Notification(banner);
      trayNote = note;
      note.on('click', () => { trayNote = null; openApp(); });
      note.on('close', () => { trayNote = null; });
      note.show();
    });
  });
}
