import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { IPC, type AtelierApi } from '@shared/api';
import type { Binding } from '@shared/companion/types';
import { toCanonical } from '@shared/paths';
import { asPlatform } from '@shared/platform';
import { themeFromArgv } from '@shared/themes';

function listen<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const h = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A));
  ipcRenderer.on(channel, h);
  return () => { ipcRenderer.off(channel, h); };
}

/** The disk path behind a dropped File (none for a File the page built itself), canonical (C:/… on Windows) for main. */
function dropPath(file: File): string | null {
  try { const p = webUtils.getPathForFile(file); return p ? toCanonical(p, process.platform === 'win32' ? 'win32' : 'posix') : null; } catch { return null; }
}

const bindingArg = (b: Binding): Binding => ({ terminalId: b.terminalId, sessionId: b.sessionId, cwd: b.cwd, configDir: b.configDir, title: b.title });

const api: AtelierApi = {
  platform: asPlatform(process.platform),
  osVersion: (() => { try { return process.getSystemVersion(); } catch { return ''; } })(),
  bootTheme: themeFromArgv(process.argv),
  project: () => ipcRenderer.invoke(IPC.project),
  openFolder: () => ipcRenderer.invoke(IPC.openFolder),
  newWindow: () => ipcRenderer.invoke(IPC.newWindow),
  popout: {
    open: (r) => ipcRenderer.invoke(IPC.popoutOpen, r),
    dock: (r) => ipcRenderer.invoke(IPC.popoutDock, r),
    focus: (key, reveal) => ipcRenderer.invoke(IPC.popoutFocus, { key, ...(reveal ? { reveal } : {}) }),
    recall: (key) => ipcRenderer.invoke(IPC.popoutRecall, key),
    forward: (cmd) => ipcRenderer.invoke(IPC.popoutForward, cmd),
    list: () => ipcRenderer.invoke(IPC.popoutList),
    handoff: () => ipcRenderer.invoke(IPC.popoutHandoff),
    dragStart: () => ipcRenderer.invoke(IPC.popoutDragStart),
    dragEnd: (r) => ipcRenderer.invoke(IPC.popoutDragEnd, r),
    dragCancel: () => ipcRenderer.invoke(IPC.popoutDragCancel),
    openInMain: (path, line) => ipcRenderer.invoke(IPC.popoutOpenInMain, { path, ...(line !== undefined ? { line } : {}) }),
    showInMain: (r) => ipcRenderer.invoke(IPC.popoutShowInMain, r),
    rekey: (from, to) => ipcRenderer.invoke(IPC.popoutRekey, { from, to }),
    tearStart: (s) => ipcRenderer.invoke(IPC.popoutTearStart, s),
    tearEnd: () => ipcRenderer.invoke(IPC.popoutTearEnd)
  },
  projectWindows: {
    list: () => ipcRenderer.invoke(IPC.windowsList),
    moveTab: (r) => ipcRenderer.invoke(IPC.windowsMoveTab, r),
    adopted: (a) => ipcRenderer.invoke(IPC.windowsAdopted, a)
  },
  recentProjects: () => ipcRenderer.invoke(IPC.recentProjects),
  openRecent: (path) => ipcRenderer.invoke(IPC.openRecent, path),
  forgetRecent: (path) => ipcRenderer.invoke(IPC.forgetRecent, path),
  daemonState: () => ipcRenderer.invoke(IPC.daemonState),
  usage: () => ipcRenderer.invoke(IPC.usage),
  files: {
    list: (dir, showHidden) => ipcRenderer.invoke(IPC.filesList, { dir, showHidden }),
    read: (path) => ipcRenderer.invoke(IPC.filesRead, path),
    readImage: (path) => ipcRenderer.invoke(IPC.filesReadImage, path),
    readLarge: (path) => ipcRenderer.invoke(IPC.filesReadLarge, path),
    openVideo: (path) => ipcRenderer.invoke(IPC.filesOpenVideo, path),
    resolve: (candidate, cwd) => ipcRenderer.invoke(IPC.filesResolve, { candidate, cwd }),
    claudeTemp: {
      resolve: (path) => ipcRenderer.invoke(IPC.filesClaudeTempResolve, path),
      open: (path) => ipcRenderer.invoke(IPC.filesClaudeTempOpen, path),
      reveal: (path) => ipcRenderer.invoke(IPC.filesClaudeFolderReveal, path)
    },
    outside: {
      resolve: (path) => ipcRenderer.invoke(IPC.filesOutsideResolve, path),
      open: (path) => ipcRenderer.invoke(IPC.filesOutsideOpen, path)
    },
    index: () => ipcRenderer.invoke(IPC.filesIndex),
    save: (path, text, base, eol, create) => ipcRenderer.invoke(IPC.filesSave, { path, text, base, eol, ...(create ? { create } : {}) }),
    create: (dir, name, kind) => ipcRenderer.invoke(IPC.filesCreate, { dir, name, kind }),
    saveAs: (rel, text) => ipcRenderer.invoke(IPC.filesSaveAs, { rel, text }),
    saveAsOutside: (name, text, unsaved) => ipcRenderer.invoke(IPC.filesSaveAsOutside, { name, text, unsaved }),
    rename: (path, name) => ipcRenderer.invoke(IPC.filesRename, { path, name }),
    duplicate: (path) => ipcRenderer.invoke(IPC.filesDuplicate, path),
    trash: (path) => ipcRenderer.invoke(IPC.filesTrash, path),
    trashInfo: (path) => ipcRenderer.invoke(IPC.filesTrashInfo, path),
    // The paths come from the File objects here, never from the page.
    openDropped: (files) => ipcRenderer.invoke(IPC.filesOpenDropped, Array.from(files, dropPath).filter((p): p is string => !!p)),
    openPicker: () => ipcRenderer.invoke(IPC.filesOpenPicker),
    openReady: () => ipcRenderer.invoke(IPC.filesOpenReady)
  },
  openUrl: (url) => ipcRenderer.invoke(IPC.openUrl, url),
  // Path of a file dragged from the Finder (reads only the path, never the file).
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
  // The installed fonts' names, read here (Local Font Access): the live demo answers its own list, never the browser's.
  localFonts: async () => {
    const query = (globalThis as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
    if (!query) return null;
    try { return [...new Set((await query.call(globalThis)).map((f) => f.family))]; } catch { return null; }
  },
  clipboard: { write: (text, html) => (html === undefined ? ipcRenderer.invoke(IPC.clipboardWrite, text) : ipcRenderer.invoke(IPC.clipboardWrite, text, html)), read: () => ipcRenderer.invoke(IPC.clipboardRead), saveImage: () => ipcRenderer.invoke(IPC.clipboardImage) },
  reveal: (path) => ipcRenderer.invoke(IPC.filesReveal, path),
  tabs: { save: (tabs) => ipcRenderer.invoke(IPC.tabsSave, tabs), restore: () => ipcRenderer.invoke(IPC.tabsRestore) },
  shellCommand: { install: () => ipcRenderer.invoke(IPC.shellCommandInstall), uninstall: () => ipcRenderer.invoke(IPC.shellCommandUninstall) },
  git: {
    status: () => ipcRenderer.invoke(IPC.gitStatus),
    head: (path) => ipcRenderer.invoke(IPC.gitHead, path),
    base: (path, rev) => ipcRenderer.invoke(IPC.gitBase, { path, rev }),
    compare: () => ipcRenderer.invoke(IPC.gitCompare),
    // Git writes: one object per call with exactly the keys api.ts lists, optional ones only when
    // set, so main's strict schemas see nothing else.
    stage: (root, rels) => ipcRenderer.invoke(IPC.gitStage, { root, rels }),
    unstage: (root, rels) => ipcRenderer.invoke(IPC.gitUnstage, { root, rels }),
    commit: (o) => ipcRenderer.invoke(IPC.gitCommit, {
      root: o.root, message: o.message, amend: o.amend, coAuthor: o.coAuthor, noVerify: o.noVerify, ...(o.expectHead ? { expectHead: o.expectHead } : {})
    }),
    undoCommit: (root, oid) => ipcRenderer.invoke(IPC.gitUndoCommit, { root, oid }),
    push: (o) => ipcRenderer.invoke(IPC.gitPush, { root: o.root, ...(o.publish ? { publish: { remote: o.publish.remote } } : {}), ...(o.lease ? { lease: { oid: o.lease.oid } } : {}) }),
    pull: (o) => ipcRenderer.invoke(IPC.gitPull, { root: o.root, rebase: o.rebase, ...(o.stash ? { stash: true } : {}) }),
    sync: (o) => ipcRenderer.invoke(IPC.gitSync, { root: o.root, rebase: o.rebase }),
    syncAll: (o) => (o ? ipcRenderer.invoke(IPC.gitSyncAll, { skip: [...o.skip] }) : ipcRenderer.invoke(IPC.gitSyncAll)),
    switchTo: (o) => ipcRenderer.invoke(IPC.gitSwitch, { root: o.root, ref: o.ref, carry: o.carry }),
    checkBranchName: (root, name, same) => ipcRenderer.invoke(IPC.gitCheckBranchName, { root, name, ...(same !== undefined ? { same } : {}) }),
    branchCreate: (o) => ipcRenderer.invoke(IPC.gitBranchCreate, { root: o.root, name: o.name, ...(o.from ? { from: o.from } : {}), switch: o.switch }),
    branchRename: (o) => ipcRenderer.invoke(IPC.gitBranchRename, { root: o.root, ref: o.ref, name: o.name }),
    branchDelete: (o) => ipcRenderer.invoke(IPC.gitBranchDelete, { root: o.root, ref: o.ref, force: o.force }),
    branchRestore: (o) => ipcRenderer.invoke(IPC.gitBranchRestore, { root: o.root, name: o.name, oid: o.oid }),
    worktreeCheck: (root, path) => ipcRenderer.invoke(IPC.gitWorktreeCheck, { root, path }),
    worktreeAdd: (o) => ipcRenderer.invoke(IPC.gitWorktreeAdd, { root: o.root, path: o.path, ...(o.ref ? { ref: o.ref } : {}), ...(o.newName ? { newName: o.newName } : {}) }),
    stashPush: (o) => ipcRenderer.invoke(IPC.gitStashPush, { root: o.root, message: o.message, untracked: o.untracked, staged: o.staged }),
    stashApply: (o) => ipcRenderer.invoke(IPC.gitStashApply, { root: o.root, index: o.index, oid: o.oid, pop: o.pop }),
    stashDrop: (o) => ipcRenderer.invoke(IPC.gitStashDrop, { root: o.root, index: o.index, oid: o.oid }),
    stashRestore: (o) => ipcRenderer.invoke(IPC.gitStashRestore, { root: o.root, oid: o.oid, message: o.message }),
    discard: (root, rels) => ipcRenderer.invoke(IPC.gitDiscard, { root, rels }),
    cancel: (id) => ipcRenderer.invoke(IPC.gitCancel, { id }),
    facts: (root, o) => ipcRenderer.invoke(IPC.gitFacts, { root, ...(o?.view ? { view: true } : {}) }),
    incoming: (root) => ipcRenderer.invoke(IPC.gitIncoming, { root }),
    remoteCommits: (root, n) => ipcRenderer.invoke(IPC.gitRemoteCommits, { root, n }),
    running: () => ipcRenderer.invoke(IPC.gitRunning),
    message: (o) => ipcRenderer.invoke(IPC.scmMessage, { root: o.root, ...(o.tweak ? { tweak: { kind: o.tweak.kind, current: o.tweak.current } } : {}) }),
    messageCancel: (id) => ipcRenderer.invoke(IPC.scmMessageCancel, { id })
  },
  scm: {
    repos: () => ipcRenderer.invoke(IPC.scmRepos),
    search: () => ipcRenderer.invoke(IPC.scmSearch),
    refs: (root) => ipcRenderer.invoke(IPC.scmRefs, { root }),
    log: (root, scope, skip, count, filter, view) => ipcRenderer.invoke(IPC.scmLog, { root, scope, skip, count, ...(filter ? { filter } : {}), ...(view ? { view } : {}) }),
    locate: (root, scope, oid, view) => ipcRenderer.invoke(IPC.scmLocate, { root, scope, oid, ...(view ? { view } : {}) }),
    resolve: (root, prefix) => ipcRenderer.invoke(IPC.scmResolve, { root, prefix }),
    commit: (root, oid, against, view) => ipcRenderer.invoke(IPC.scmCommit, { root, oid, ...(against ? { against } : {}), ...(view ? { view } : {}) }),
    file: (root, oid, rel) => ipcRenderer.invoke(IPC.scmFile, { root, oid, rel }),
    aheadBehind: (root, base, head) => ipcRenderer.invoke(IPC.scmAheadBehind, { root, a: base, b: head }),
    worktrees: (root) => ipcRenderer.invoke(IPC.scmWorktrees, { root }),
    stashes: (root) => ipcRenderer.invoke(IPC.scmStashes, { root }),
    status: (root) => ipcRenderer.invoke(IPC.scmStatus, { root }),
    fetchRepo: (root, reason) => ipcRenderer.invoke(IPC.scmFetch, { root, reason }),
    fetchAll: () => ipcRenderer.invoke(IPC.scmFetchAll),
    fetchStates: () => ipcRenderer.invoke(IPC.scmFetchStates)
  },
  attributions: () => ipcRenderer.invoke(IPC.attributions),
  resolveAttributions: (paths, terminalId) => ipcRenderer.invoke(IPC.attributionsResolve, { paths, terminalId }),
  undoResolve: (token) => ipcRenderer.invoke(IPC.attributionsUndo, { token }),
  resumables: () => ipcRenderer.invoke(IPC.resumables),
  schedules: {
    list: () => ipcRenderer.invoke(IPC.schedules),
    add: (o) => ipcRenderer.invoke(IPC.scheduleAdd, o),
    update: (o) => ipcRenderer.invoke(IPC.scheduleUpdate, o),
    remove: (id) => ipcRenderer.invoke(IPC.scheduleRemove, { id }),
    restore: (prompt) => ipcRenderer.invoke(IPC.scheduleRestore, { prompt }),
    fire: (id, force) => ipcRenderer.invoke(IPC.scheduleFire, force ? { id, force } : { id }),
    snooze: (id, minutes) => ipcRenderer.invoke(IPC.scheduleSnooze, { id, minutes })
  },
  claudeSignals: {
    get: () => ipcRenderer.invoke(IPC.claudeSignals),
    clear: () => ipcRenderer.invoke(IPC.claudeSignalsClear)
  },
  claude: {
    dirs: () => ipcRenderer.invoke(IPC.claudeDirs),
    pickDir: () => ipcRenderer.invoke(IPC.claudePickDir),
    launchPreview: (o) => ipcRenderer.invoke(IPC.claudeLaunchPreview, o),
    history: () => ipcRenderer.invoke(IPC.claudeHistory),
    resume: (sessionId, cols, rows, account) => ipcRenderer.invoke(IPC.claudeResume, { sessionId, cols, rows, ...(account ? { account } : {}) }),
    config: (cwd, terminalId) => ipcRenderer.invoke(IPC.claudeConfig, { cwd, ...(terminalId ? { terminalId } : {}) }),
    restartCommand: (terminalId, sessionId) => ipcRenderer.invoke(IPC.claudeRestartCommand, { terminalId, sessionId }),
    mcpAdded: () => ipcRenderer.invoke(IPC.claudeMcpAdded),
    contextUsage: (terminalId) => ipcRenderer.invoke(IPC.claudeContext, { terminalId }),
    contextLive: (terminalId) => ipcRenderer.invoke(IPC.claudeContextLive, { terminalId }),
    contextOpen: (terminalId, path) => ipcRenderer.invoke(IPC.claudeContextOpen, { terminalId, path })
  },
  restartDaemon: () => ipcRenderer.invoke(IPC.daemonRestart),
  asks: {
    ready: () => ipcRenderer.invoke(IPC.askReady),
    shown: (id) => ipcRenderer.invoke(IPC.askShown, { id }),
    answer: (id, answer) => ipcRenderer.invoke(IPC.askAnswer, { id, answer })
  },
  reloadShellEnv: () => ipcRenderer.invoke(IPC.daemonReloadEnv),
  shellEnv: {
    files: () => ipcRenderer.invoke(IPC.shellEnvFiles),
    pickFiles: () => ipcRenderer.invoke(IPC.shellEnvPickFiles)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
    reset: () => ipcRenderer.invoke(IPC.settingsReset)
  },
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  openLogs: () => ipcRenderer.invoke(IPC.openLogs),
  notifications: {
    test: () => ipcRenderer.invoke(IPC.notifyTest),
    openSettings: () => ipcRenderer.invoke(IPC.notifySettings)
  },
  logError: (e) => ipcRenderer.send(IPC.logError, e),
  menuState: (s) => ipcRenderer.send(IPC.menuState, s),
  unsaved: (has) => ipcRenderer.send(IPC.unsavedState, has),
  menu: {
    model: () => ipcRenderer.invoke(IPC.menuModel),
    invoke: (id) => ipcRenderer.send(IPC.menuInvoke, id)
  },
  testFault: () => ipcRenderer.invoke(IPC.testFault),
  openLicenses: () => ipcRenderer.invoke(IPC.openLicenses),
  revealProject: () => ipcRenderer.invoke(IPC.revealProject),
  dictation: {
    status: () => ipcRenderer.invoke(IPC.dictationStatus),
    download: () => ipcRenderer.invoke(IPC.dictationDownload),
    cancelDownload: () => ipcRenderer.invoke(IPC.dictationCancel),
    removeModel: () => ipcRenderer.invoke(IPC.dictationRemove),
    restartEngine: () => ipcRenderer.invoke(IPC.dictationRestart),
    requestMic: () => ipcRenderer.invoke(IPC.dictationMic),
    openPrivacy: () => ipcRenderer.invoke(IPC.dictationPrivacy),
    testAudio: () => ipcRenderer.invoke(IPC.dictationTestAudio),
    transcribe: (pcm, raw, context, terminalId) => ipcRenderer.invoke(IPC.dictationTranscribe, { pcm, raw, context, ...(terminalId ? { terminalId } : {}) })
  },
  update: {
    state: () => ipcRenderer.invoke(IPC.updateState),
    apply: () => ipcRenderer.invoke(IPC.updateApply),
    status: () => ipcRenderer.invoke(IPC.updateStatus),
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    whatsNew: () => ipcRenderer.invoke(IPC.updateWhatsNew),
    openRelease: () => ipcRenderer.invoke(IPC.updateOpenRelease),
    openApplications: () => ipcRenderer.invoke(IPC.updateOpenApplications),
    openStore: () => ipcRenderer.invoke(IPC.updateOpenStore)
  },
  docker: {
    snapshot: () => ipcRenderer.invoke(IPC.dockerSnapshot),
    logs: (id) => ipcRenderer.invoke(IPC.dockerLogs, id),
    watchLogs: (ids) => ipcRenderer.send(IPC.dockerWatchLogs, ids),
    watchStats: (ids) => ipcRenderer.send(IPC.dockerWatchStats, ids),
    stats: (ids) => ipcRenderer.invoke(IPC.dockerStats, ids),
    inspect: (id) => ipcRenderer.invoke(IPC.dockerInspect, id),
    df: () => ipcRenderer.invoke(IPC.dockerDf),
    events: () => ipcRenderer.invoke(IPC.dockerEvents),
    tail: (id, n) => ipcRenderer.invoke(IPC.dockerTail, { id, n })
  },
  redis: {
    snapshot: () => ipcRenderer.invoke(IPC.redisSnapshot),
    status: () => ipcRenderer.invoke(IPC.redisStatus),
    watch: (w) => ipcRenderer.send(IPC.redisWatch, w),
    pick: (key) => ipcRenderer.invoke(IPC.redisPick, key),
    auth: (a) => ipcRenderer.invoke(IPC.redisAuth, a),
    forget: (key) => ipcRenderer.invoke(IPC.redisForget, key),
    seen: (id) => ipcRenderer.send(IPC.redisSeen, id),
    scan: (a) => ipcRenderer.invoke(IPC.redisScan, a),
    value: (a) => ipcRenderer.invoke(IPC.redisValue, a),
    counter: (a) => ipcRenderer.invoke(IPC.redisCounter, a),
    clients: () => ipcRenderer.invoke(IPC.redisClients),
    slowlog: () => ipcRenderer.invoke(IPC.redisSlowlog),
    jobs: (a) => ipcRenderer.invoke(IPC.redisJobs, a),
    job: (a) => ipcRenderer.invoke(IPC.redisJob, a),
    preview: (a) => ipcRenderer.invoke(IPC.redisPreview, a),
    write: (a) => ipcRenderer.invoke(IPC.redisWrite, a),
    undo: (id) => ipcRenderer.invoke(IPC.redisUndo, id)
  },
  databases: {
    snapshot: () => ipcRenderer.invoke(IPC.dbSnapshot),
    select: (connId) => ipcRenderer.invoke(IPC.dbSelect, connId),
    connect: (id) => ipcRenderer.invoke(IPC.dbConnect, id),
    disconnect: (id) => ipcRenderer.invoke(IPC.dbDisconnect, id),
    password: (a) => ipcRenderer.invoke(IPC.dbPassword, a),
    test: (a) => ipcRenderer.invoke(IPC.dbTest, a),
    save: (a) => ipcRenderer.invoke(IPC.dbSave, a),
    duplicate: (id) => ipcRenderer.invoke(IPC.dbDuplicate, id),
    remove: (id) => ipcRenderer.invoke(IPC.dbRemove, id),
    setMask: (id, on) => ipcRenderer.invoke(IPC.dbSetMask, { id, on }),
    noteWrite: (id) => ipcRenderer.invoke(IPC.dbNoteWrite, id),
    setSchema: (id, schema) => ipcRenderer.invoke(IPC.dbSetSchema, { id, schema }),
    refresh: () => ipcRenderer.invoke(IPC.dbRefresh),
    page: (req) => ipcRenderer.invoke(IPC.dbPage, req),
    estimate: (a) => ipcRenderer.invoke(IPC.dbEstimate, a),
    count: (a) => ipcRenderer.invoke(IPC.dbCount, a),
    peek: (a) => ipcRenderer.invoke(IPC.dbPeek, a),
    refs: (a) => ipcRenderer.invoke(IPC.dbRefs, a),
    full: (a) => ipcRenderer.invoke(IPC.dbFull, a),
    structure: (ref) => ipcRenderer.invoke(IPC.dbStructure, ref),
    relations: (ref) => ipcRenderer.invoke(IPC.dbRelations, ref),
    ddl: (ref) => ipcRenderer.invoke(IPC.dbDdl, ref),
    overview: (id) => ipcRenderer.invoke(IPC.dbOverview, id),
    readOnlySql: (id) => ipcRenderer.invoke(IPC.dbReadOnlySql, id)
  },
  services: {
    list: () => ipcRenderer.invoke(IPC.servicesList),
    lines: (id) => ipcRenderer.invoke(IPC.servicesLines, id),
    watch: (ids) => ipcRenderer.send(IPC.servicesWatch, ids)
  },
  terminals: {
    list: () => ipcRenderer.invoke(IPC.termList),
    create: (o) => ipcRenderer.invoke(IPC.termCreate, o),
    shells: () => ipcRenderer.invoke(IPC.termShells),
    createSession: (o) => ipcRenderer.invoke(IPC.termCreateSession, o),
    rename: (id, name) => ipcRenderer.invoke(IPC.termRename, { id, name }),
    markSeen: (id) => ipcRenderer.invoke(IPC.termMarkSeen, id),
    folder: (id) => ipcRenderer.invoke(IPC.termFolder, id),
    openFolder: (id) => ipcRenderer.invoke(IPC.termOpenFolder, id),
    resume: (id, cols, rows) => ipcRenderer.invoke(IPC.termResume, { id, cols, rows }),
    dismiss: (id) => ipcRenderer.invoke(IPC.termDismiss, id),
    close: (id) => ipcRenderer.invoke(IPC.termClose, id),
    attach: (id) => ipcRenderer.invoke(IPC.termAttach, id),
    detach: (id) => ipcRenderer.invoke(IPC.termDetach, id),
    kill: (id) => ipcRenderer.invoke(IPC.termKill, id),
    stop: (ids) => ipcRenderer.invoke(IPC.termStop, ids),
    input: (id, data) => ipcRenderer.send(IPC.termInput, { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.termResize, { id, cols, rows }),
    triggerMatched: (id, rule, line) => ipcRenderer.send(IPC.triggerNotify, { id, rule, line })
  },
  ports: {
    list: () => ipcRenderer.invoke(IPC.portsList),
    open: (id, port) => ipcRenderer.invoke(IPC.portsOpen, { id, port })
  },
  prs: {
    list: () => ipcRenderer.invoke(IPC.prsList),
    open: (root, branch, checks) => ipcRenderer.invoke(IPC.prOpen, { root, branch, checks })
  },
  connectors: {
    list: () => ipcRenderer.invoke(IPC.connectorsList),
    connect: (id) => ipcRenderer.invoke(IPC.connectorsConnect, { id }),
    cancel: (id) => ipcRenderer.invoke(IPC.connectorsCancel, { id }),
    reopenAuth: (id) => ipcRenderer.invoke(IPC.connectorsReopenAuth, { id }),
    disconnect: (id) => ipcRenderer.invoke(IPC.connectorsDisconnect, { id }),
    refresh: (id) => ipcRenderer.invoke(IPC.connectorsRefresh, { id }),
    setOptions: (id, options) => ipcRenderer.invoke(IPC.connectorsSetOptions, { id, options }),
    openTask: (source, id) => ipcRenderer.invoke(IPC.connectorsOpenTask, { source, id }),
    searchSources: (id, query) => ipcRenderer.invoke(IPC.connectorsSearchSources, { id, query }),
    addSource: (id, ref) => ipcRenderer.invoke(IPC.connectorsAddSource, { id, ref }),
    removeSource: (id, sourceId) => ipcRenderer.invoke(IPC.connectorsRemoveSource, { id, sourceId }),
    setSourceFields: (id, sourceId, fields) => ipcRenderer.invoke(IPC.connectorsSetSourceFields, { id, sourceId, fields }),
    loadSourceColumns: (id, sourceId) => ipcRenderer.invoke(IPC.connectorsLoadSourceColumns, { id, sourceId }),
    setSourceScope: (id, sourceId, everyone) => ipcRenderer.invoke(IPC.connectorsSetSourceScope, { id, sourceId, everyone }),
    listFilters: (id) => ipcRenderer.invoke(IPC.connectorsListFilters, { id }),
    setFilter: (id, filterId) => ipcRenderer.invoke(IPC.connectorsSetFilter, { id, filterId }),
    connectToken: (id, creds) => ipcRenderer.invoke(IPC.connectorsConnectToken, { id, ...creds })
  },
  automations: {
    list: () => ipcRenderer.invoke(IPC.automationsList),
    save: (automation) => ipcRenderer.invoke(IPC.automationsSave, { automation }),
    remove: (id) => ipcRenderer.invoke(IPC.automationsRemove, { id }),
    turnOn: (id, startMatching) => ipcRenderer.invoke(IPC.automationsTurnOn, { id, startMatching }),
    turnOff: (id) => ipcRenderer.invoke(IPC.automationsTurnOff, { id }),
    checkNow: (id) => ipcRenderer.invoke(IPC.automationsCheckNow, { id }),
    preview: (automation) => ipcRenderer.invoke(IPC.automationsPreview, { automation }),
    startRun: (runId) => ipcRenderer.invoke(IPC.automationsStartRun, { runId }),
    skipRun: (runId) => ipcRenderer.invoke(IPC.automationsSkipRun, { runId }),
    stopRun: (runId) => ipcRenderer.invoke(IPC.automationsStopRun, { runId }),
    closeRun: (runId, removeWorktree) => ipcRenderer.invoke(IPC.automationsCloseRun, { runId, removeWorktree }),
    catchUp: (id, action) => ipcRenderer.invoke(IPC.automationsCatchUp, { id, action }),
    setPaused: (paused) => ipcRenderer.invoke(IPC.automationsSetPaused, { paused }),
    scopes: (connector) => ipcRenderer.invoke(IPC.automationsScopes, { id: connector }),
    sourceMcp: (connector, account, automation) => ipcRenderer.invoke(IPC.automationsSourceMcp, { id: connector, account, ...(automation !== undefined ? { automation } : {}) })
  },
  tasks: {
    list: () => ipcRenderer.invoke(IPC.tasksList),
    get: (source, id) => ipcRenderer.invoke(IPC.tasksGet, { source, id }),
    search: (source, query) => ipcRenderer.invoke(IPC.tasksSearch, { source, query })
  },
  background: {
    watch: (terminalId, itemId) => ipcRenderer.invoke(IPC.backgroundWatch, { terminalId, itemId }),
    unwatch: (terminalId, itemId) => ipcRenderer.send(IPC.backgroundUnwatch, { terminalId, itemId }),
    loop: (terminalId, cronId) => ipcRenderer.invoke(IPC.backgroundLoop, { terminalId, cronId })
  },
  // A binding's fields one by one: main's schema is strict, so whatever else the renderer's object carries stays here.
  companion: {
    thread: (sessionId) => ipcRenderer.invoke(IPC.companionThread, { sessionId }),
    ask: (o) => ipcRenderer.invoke(IPC.companionAsk, { binding: bindingArg(o.binding), text: o.text, ...(o.model ? { model: o.model } : {}), ...(o.account ? { account: o.account } : {}) }),
    catchUp: (o) => ipcRenderer.invoke(IPC.companionCatchUp, { binding: bindingArg(o.binding), final: o.final, ...(o.model ? { model: o.model } : {}), ...(o.account ? { account: o.account } : {}) }),
    stop: (sessionId) => ipcRenderer.invoke(IPC.companionStop, { sessionId }),
    newThread: (sessionId) => ipcRenderer.invoke(IPC.companionNew, { sessionId }),
    seen: (sessionId) => ipcRenderer.invoke(IPC.companionSeen, { sessionId })
  },
  // The request's fields one by one, as for companion: main's schema is strict.
  search: {
    start: (r) => ipcRenderer.invoke(IPC.searchStart, {
      searchId: r.searchId, query: r.query, matchCase: r.matchCase, wholeWord: r.wholeWord, regex: r.regex, include: r.include, exclude: r.exclude, includeIgnored: r.includeIgnored
    }),
    stop: (searchId) => ipcRenderer.invoke(IPC.searchStop, searchId),
    onEvent: (cb) => listen(IPC.evSearch, cb)
  },
  on: {
    backgroundFeed: (cb) => listen(IPC.evBackgroundFeed, cb),
    terminals: (cb) => listen(IPC.evTerminals, cb),
    snapshot: (cb) => listen(IPC.evSnapshot, cb),
    data: (cb) => listen(IPC.evData, cb),
    exit: (cb) => listen(IPC.evExit, cb),
    daemon: (cb) => listen(IPC.evDaemon, cb),
    usage: (cb) => listen(IPC.evUsage, cb),
    command: (cb) => listen(IPC.evCommand, cb),
    menuModel: (cb) => listen(IPC.evMenuModel, cb),
    git: (cb) => listen(IPC.evGit, cb),
    fsChanged: (cb) => listen(IPC.evFsChanged, cb),
    openPaths: (cb) => listen(IPC.evOpenPaths, cb),
    attributions: (cb) => listen(IPC.evAttributions, cb),
    services: (cb) => listen(IPC.evServices, cb),
    serviceLines: (cb) => listen(IPC.evServiceLines, cb),
    docker: (cb) => listen(IPC.evDocker, cb),
    dockerLogs: (cb) => listen(IPC.evDockerLogs, cb),
    dockerStats: (cb) => listen(IPC.evDockerStats, cb),
    dockerEvent: (cb) => listen(IPC.evDockerEvent, cb),
    dockerNote: (cb) => listen(IPC.evDockerNote, cb),
    dockerOpen: (cb) => listen(IPC.evDockerOpen, cb),
    redis: (cb) => listen(IPC.evRedis, cb),
    redisStatus: (cb) => listen(IPC.evRedisStatus, cb),
    redisMonitor: (cb) => listen(IPC.evRedisMonitor, cb),
    redisNote: (cb) => listen(IPC.evRedisNote, cb),
    redisOpen: (cb) => listen(IPC.evRedisOpen, cb),
    databases: (cb) => listen(IPC.evDatabases, cb),
    resumables: (cb) => listen(IPC.evResumables, cb),
    schedules: (cb) => listen(IPC.evSchedules, cb),
    scheduleNotice: (cb) => listen(IPC.evScheduleNotice, cb),
    claudeSignals: (cb) => listen(IPC.evClaudeSignals, cb),
    select: (cb) => listen(IPC.evSelect, cb),
    settings: (cb) => listen(IPC.evSettings, cb),
    update: (cb) => listen(IPC.evUpdate, cb),
    updateStatus: (cb) => listen(IPC.evUpdateStatus, cb),
    dictation: (cb) => listen(IPC.evDictation, cb),
    notes: (cb) => listen(IPC.evNotes, cb),
    ports: (cb) => listen(IPC.evPorts, cb),
    prs: (cb) => listen(IPC.evPrs, cb),
    connectors: (cb) => listen(IPC.evConnectors, cb),
    automations: (cb) => listen(IPC.evAutomations, cb),
    connectorNotice: (cb) => listen(IPC.evConnectorNotice, cb),
    shellEnvAuto: (cb) => listen(IPC.evShellEnvAuto, cb),
    mcpAdded: (cb) => listen(IPC.evMcpAdded, cb),
    contextProgress: (cb) => listen(IPC.evContextProgress, cb),
    ask: (cb) => listen(IPC.evAsk, cb),
    askWithdrawn: (cb) => listen(IPC.evAskWithdrawn, cb),
    appNotice: (cb) => listen(IPC.evAppNotice, cb),
    scm: (cb) => listen(IPC.evScm, cb),
    scmFetch: (cb) => listen(IPC.evScmFetch, cb),
    gitOp: (cb) => listen(IPC.evGitOp, cb),
    scmMessage: (cb) => listen(IPC.evScmMessage, cb),
    companion: (cb) => listen(IPC.evCompanion, cb),
    popouts: (cb) => listen(IPC.evPopouts, cb),
    dock: (cb) => listen(IPC.evDock, cb),
    dockHover: (cb) => listen(IPC.evDockHover, cb),
    adopt: (cb) => listen(IPC.evAdopt, cb),
    projectWindows: (cb) => listen(IPC.evProjectWindows, cb),
    popoutReveal: (cb) => listen(IPC.evPopoutReveal, cb),
    popoutClose: (cb) => listen(IPC.evPopoutClose, cb)
  }
};

contextBridge.exposeInMainWorld('atelier', api);
