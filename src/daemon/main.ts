import net from 'node:net';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { homedir, release } from 'node:os';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { daemonPaths, isPipePath, type DaemonPaths } from '@shared/paths.node';
import type { DaemonInfo } from '@shared/protocol';
import { mergeUsage, mergeUsageByDir, usageKey, type Usage, type UsageEntry } from '@shared/session';
import { resumedName, type NameReply } from '@shared/session-name';
import { addAttribution, pruneAttributions, type Attribution } from '@shared/attribution';
import {
  CALL_CAP_MS, CALL_KEEP_MS, MAX_CALLS, applyToolCallHook, changedCalls, pruneToolCalls, syncToolCalls, waitingForAnswer, type ToolCallWindow
} from '@shared/tool-calls';
import { generateToken } from './auth';
import { HOOK_EVENTS, installAtelierFiles } from './install';
import { loadRegistry, saveRegistry, toResumables } from './registry';
import { shellQuote, withConfigDir } from '@shared/shell';
import type { Resumable, ShellEnvState, TerminalInfo, TerminalProfile } from '@shared/protocol';
import { atelierOwn, buildTerminalEnv } from './env';
import { defaultPowerShell, listedShell, loginArgs, windowsShells } from './profiles';
import { powerShellArgs } from './install-files';
import { toNative } from '@shared/paths';
import { currentPlatform } from '@shared/platform';
import { closeWaitsForPrograms, windowsPtyFor } from '@shared/windows-pty';
import { endTreeWith } from './win-tree';
import { aliasSnippet, captureShellEnv, type ShellEnv } from './shell-env';
import { ensureDir, writeFileAtomic } from './fsutil';
import { createLogger } from './log';
import { startServer, type RunningServer } from './server';
import { ScheduleBook } from './schedules';
import { SignalBook } from './signals';
import { TerminalManager, type CreateTerminal, type Launch } from './terminals';
import { autoContinueAtUsageLimit } from './claude-settings';
import { Launchd, jobLabel } from './launchd';
import { PtyHostServer } from './pty-host-server';
import { ptyNative } from './pty-native';
import { isolatedSpawner, type IsolationConfig, type SpawnFor } from './session-pty';
import * as pty from 'node-pty';

export interface RunningDaemon {
  paths: DaemonPaths;
  info: DaemonInfo;
  hookToken: string;
  terminals: TerminalManager;
  /** Captures the user's shell environment again (see reloadEnv in the protocol). */
  reloadEnv(): Promise<ShellEnv>;
  /** The capture's state as the app sees it. */
  getShellEnv(): ShellEnvState;
  stop(): Promise<void>;
}

export interface RunDaemonOptions {
  home?: string;
  version: string;
  shell?: string;
  shellArgs?: string[];
  /** Replaces the hook handling (tests): such a daemon never replies to the bridge. */
  onHook?: (term: string, payload: unknown) => void;
  onStatus?: (term: string, payload: unknown) => void;
  maxQueuedBytes?: number;
  /** Called after a shutdown requested by a client (the real process exits). */
  onStopped?: () => void;
  /** The user's Claude settings file to read the status line from (default ~/.claude/settings.json). */
  userClaudeSettings?: string;
  /** The user's original ZDOTDIR; default is the environment's. null = the user has none (tests only). */
  userZdotdir?: string | null;
  /** Extra variables for the terminals and the environment capture (tests only). */
  extraEnv?: Record<string, string>;
  /**
   * Runs the user's login+interactive zsh to capture its environment for Atelier-profile terminals (in the background
   * at start, and on reloadEnv). Only the real atelierd turns it on: tests opt in with a fake ZDOTDIR and HOME, so
   * they never run the user's own config.
   */
  captureShellEnv?: boolean;
  /** The list of allowed shells for { shell } profiles (default /etc/shells; tests only). */
  etcShells?: string;
  /** Windows: where atelier-bridge.exe may be, first found wins. */
  bridges?: string[];
  /**
   * How long a new Atelier-profile terminal waits for the first capture still in flight before opening in the user's
   * own zsh instead (default 5 s: well within the app's 10 s request timeout; tests shorten it).
   */
  envWaitMs?: number;
  /**
   * Each terminal's shell in a launchd job of its own: a force quit of an app started in a
   * session ends that session only. execPath is the job's first image (Atelier's executable: the job keeps Atelier's
   * privacy grants), hostScript pty-host.js, nativeHost atelier-pty-host. Absent: node-pty's spawn, as before.
   */
  isolation?: IsolationConfig | ((paths: DaemonPaths) => IsolationConfig | null);
}

export type { IsolationConfig } from './session-pty';

export function isSocketAlive(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection(sock);
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 1000);
  });
}

export async function runDaemon(o: RunDaemonOptions): Promise<RunningDaemon> {
  const paths = daemonPaths(o.home);
  ensureDir(paths.home, 0o700);
  ensureDir(paths.logDir, 0o700);
  // Windows: a named pipe, no file to prepare or leave behind.
  const pipe = isPipePath(paths.sock);
  if (!pipe) ensureDir(path.dirname(paths.sock), 0o700);
  const log = createLogger(paths.log);

  if (await isSocketAlive(paths.sock)) throw new Error('atelierd already running');
  if (!pipe) try { unlinkSync(paths.sock); } catch { /* no orphan socket */ }

  // Never fails the start: a file that can't be installed is logged and keeps its previous copy.
  installAtelierFiles(paths, o.userClaudeSettings, o.bridges, { log });
  const tokens = { control: generateToken(), hook: generateToken() };
  // Only if the user really had a ZDOTDIR: otherwise Atelier's zsh files unset it before theirs.
  const userZdotdir = o.userZdotdir === undefined ? process.env.ZDOTDIR : o.userZdotdir ?? undefined;
  const userZ: Record<string, string> = userZdotdir ? { ATELIER_USER_ZDOTDIR: userZdotdir } : {};
  const shellArgs = o.shellArgs ?? ['-l'];
  const atelierVars = (id: string) => ({
    ATELIER_HOME: paths.home,
    ATELIER_SOCK: paths.sock,
    ATELIER_HOOK_TOKEN: tokens.hook,
    ATELIER_TERMINAL_ID: id,
    ATELIER_CLAUDE_SETTINGS: paths.settings
  });

  // The user's environment as their own zsh ends up with it, for Atelier-profile terminals: in memory only, captured
  // at every start (it holds secrets and per-boot values). A development build cached it on disk: that file goes.
  try { unlinkSync(path.join(paths.home, 'shell-env.json')); } catch { /* none */ }
  let shellEnv: ShellEnv | null = null;
  let capturing: { result: Promise<ShellEnv>; cancel(): void } | null = null;
  // What the app shows in Settings › Terminal (a failed capture says why).
  let envState: ShellEnvState = { state: o.captureShellEnv ? 'capturing' : 'off' };
  const envEvents = new EventEmitter();
  const setEnvState = (s: ShellEnvState) => { envState = s; envEvents.emit('shellEnv', s); };
  /** The capture in use, if any: when it was taken and how many aliases it brings. */
  const inUse = (): Partial<ShellEnvState> => (shellEnv ? { capturedAt: shellEnv.capturedAt, aliases: shellEnv.aliasCode?.count ?? 0 } : {});
  const reloadEnv = (): Promise<ShellEnv> => {
    if (!o.captureShellEnv) return Promise.reject(new Error('shell environment capture is off'));
    if (capturing) return capturing.result;
    setEnvState({ state: 'capturing', ...inUse() });
    const base = buildTerminalEnv(process.env, { ...o.extraEnv, DISABLE_AUTO_UPDATE: 'true' });
    for (const k of Object.keys(base)) if (k.startsWith('ATELIER_')) delete base[k];
    delete base.ZDOTDIR;
    if (userZdotdir) base.ZDOTDIR = userZdotdir;
    const run = captureShellEnv({ env: base, cwd: base.HOME ?? homedir() });
    const result = run.result.then(({ env, claude, aliases }) => {
      // Oh My Zsh's update prompt is off only for the capture.
      if (process.env.DISABLE_AUTO_UPDATE === undefined && o.extraEnv?.DISABLE_AUTO_UPDATE === undefined) delete env.DISABLE_AUTO_UPDATE;
      const aliasCode = aliasSnippet(aliases);
      shellEnv = { env, claude, aliases, aliasCode, capturedAt: Date.now() };
      log(`shell environment captured (${Object.keys(env).length} variables, ${aliasCode ? `${aliasCode.count} aliases` : 'aliases left out: too large'})`);
      capturing = null;
      setEnvState({ state: 'ready', ...inUse() });
      return shellEnv;
    }, (err: Error) => {
      log(`shell environment not captured: ${err.message}`);
      capturing = null;
      // A failed reload keeps the earlier capture in use: still reported, so the app can say why.
      setEnvState({ state: 'failed', error: err.message, ...inUse() });
      throw err;
    });
    capturing = { result, cancel: run.cancel };
    return result;
  };

  const launch = (id: string, profile: TerminalProfile, lo: { aliases?: boolean } = {}): Launch => {
    // Windows: both built-in profiles are PowerShell with Atelier's integration after the user's
    // profile; only the Atelier one gets command marks (the nonce terminals.ts sets for it).
    if (currentPlatform() === 'win32' && (profile === 'user' || profile === 'atelier')) {
      const ps = defaultPowerShell(windowsShells(process.env, (p) => existsSync(toNative(p))));
      if (!ps) throw new Error('PowerShell not found');
      return {
        file: toNative(ps.path), args: powerShellArgs(path.win32.join(paths.shell, 'atelier.ps1')), initCommandEnv: 'ATELIER_INIT_CMD',
        env: buildTerminalEnv(process.env, { ...atelierVars(id), ...o.extraEnv })
      };
    }
    // No captured environment (first capture still running or failed): atelierd's own is launchd's minimal one for an
    // app opened from the Dock, where claude, node… aren't found. The user's own zsh builds the right one.
    if (profile === 'atelier' && !shellEnv && o.captureShellEnv) return { ...launch(id, 'user'), profile: 'user' };
    if (profile === 'user') {
      return {
        file: o.shell ?? '/bin/zsh', args: shellArgs,
        // With -f (tests only) zsh doesn't read Atelier's files: there the initial command is typed.
        initCommandEnv: shellArgs.includes('-f') ? undefined : 'ATELIER_INIT_CMD',
        // The shell loads Atelier's files, which in turn load the user's.
        env: buildTerminalEnv(process.env, { ...atelierVars(id), ...userZ, ZDOTDIR: path.join(paths.shell, 'zsh'), ...o.extraEnv })
      };
    }
    if (profile === 'atelier') {
      // ATELIER_USER_ALIASES: the user's other aliases, defined by the profile's .zlogin and unset there at once.
      const aliasCode = lo.aliases === false ? '' : shellEnv?.aliasCode?.code ?? '';
      return {
        file: '/bin/zsh', args: ['-l'], initCommandEnv: 'ATELIER_INIT_CMD',
        // Without capture (tests only) atelierd's own environment. userZ: a nested zsh (or exec zsh) goes back to the
        // user's own config.
        // atelierd's own ATELIER_* (e.g. ATELIER_CLAUDE_BIN, the fake claude in tests) on top of the captured
        // environment, which drops them: without it `claude` resolved to the real one on PATH.
        // ATELIER_USER_CLAUDE: the user's claude alias (their rc isn't loaded here), for Atelier's claude function.
        env: buildTerminalEnv(shellEnv ? { ...shellEnv.env, ...atelierOwn(process.env) } : process.env, { ...atelierVars(id), ...userZ, ...(shellEnv?.claude ? { ATELIER_USER_CLAUDE: shellEnv.claude } : {}), ...(aliasCode ? { ATELIER_USER_ALIASES: aliasCode } : {}), ZDOTDIR: path.join(paths.shell, 'atelier'), ...o.extraEnv })
      };
    }
    const file = listedShell(profile.shell, o.etcShells);
    // macOS's bash 3.2 would greet every terminal with "The default interactive shell is now zsh".
    const quiet: Record<string, string> = path.basename(file) === 'bash' ? { BASH_SILENCE_DEPRECATION_WARNING: '1' } : {};
    return { file, args: loginArgs(file), env: buildTerminalEnv(process.env, { ...quiet, ...atelierVars(id), ...o.extraEnv }) };
  };
  // Terminal isolation: the host socket first, then this home's stale jobs (an atelierd that died or stopped left them,
  // finished) go.
  let hostServer: PtyHostServer | null = null;
  let spawnFor: SpawnFor | undefined;
  if (o.isolation) {
    try {
      // A function installs the host files: only now, once no other atelierd is alive (it may be running them).
      const iso = typeof o.isolation === 'function' ? o.isolation(paths) : o.isolation;
      if (!iso) throw new Error('terminal host files not found');
      ensureDir(path.dirname(paths.hostSock), 0o700);
      ensureDir(paths.run, 0o700);
      hostServer = await PtyHostServer.start(paths.hostSock, log);
      const launchd = new Launchd({ runDir: paths.run });
      const prefix = jobLabel('session', paths.home);
      // Listed now, before any terminal of this run exists; booted out in the background (startup never waits on it).
      const stale = await launchd.ownLabels(prefix);
      void Promise.all(stale.map((label) => launchd.bootout(label).catch(() => false)));
      const server = hostServer;
      spawnFor = isolatedSpawner({
        launchd, server, native: ptyNative(),
        label: (id) => jobLabel('session', paths.home, id),
        program: (token) => [iso.execPath, iso.hostScript, iso.nativeHost, paths.hostSock, token],
        stderr: paths.log,
        direct: (file, args, so) => pty.spawn(file, args, so),
        kill: (pid, signal) => process.kill(pid, signal),
        log
      });
    } catch (err) {
      log(`terminal isolation off: ${(err as Error).message}`);
      await hostServer?.close();
      hostServer = null;
    }
  }
  // Usage limits: per Claude config dir, and the app-wide merge older apps read.
  let usage: Usage | null = null;
  let usageByDir: UsageEntry[] = [];
  const usageEvents = new EventEmitter();
  // The usage-limit pause reads the account's merged limits and Claude Code's
  // own setting.
  // Windows before 11 24H2: closing a console waits for every program in it, Claude's SessionEnd hook waiting for this
  // very process meanwhile; a terminal's process tree ends first (win-tree.ts).
  const endTree = closeWaitsForPrograms(windowsPtyFor(currentPlatform(), release())) ? endTreeWith() : undefined;
  const terminals = new TerminalManager({
    launch, spawnFor, log, ...(endTree ? { endTree } : {}),
    usageFor: (dir) => usageByDir.find((e) => e.configDir === dir)?.usage ?? null,
    autoContinue: (dir) => autoContinueAtUsageLimit(dir)
  });
  /** An Atelier terminal asked for before the first capture is ready waits for it, up to envWaitMs. */
  const envReady = async (profile: TerminalProfile | undefined): Promise<void> => {
    if (profile !== 'atelier' || shellEnv || !capturing) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      capturing.result.catch(() => { /* reported in envState */ }),
      new Promise<void>((r) => { timer = setTimeout(r, o.envWaitMs ?? 5000); })
    ]);
    clearTimeout(timer);
  };
  const create = async (c: CreateTerminal): Promise<TerminalInfo> => {
    await envReady(c.profile);
    return terminals.create(c);
  };

  // Registry on disk: what was there at the last shutdown. Claude sessions without a process become resumable.
  const prevRegistry = loadRegistry(paths.registry);
  let resumables: Resumable[] = toResumables(prevRegistry, Date.now());
  const resumeEvents = new EventEmitter();
  let saveTimer: NodeJS.Timeout | null = null;
  const saveNow = () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { saveRegistry(paths.registry, { v: 1, terminals: terminals.snapshotForRegistry(), resumables, attributions }); } catch (err) { log(`registry not saved: ${(err as Error).message}`); }
  };
  const scheduleSave = () => { if (!saveTimer) saveTimer = setTimeout(saveNow, 500); };

  // File → session attributions: sent with a small delay, a burst of changes becomes one message.
  let attributions: Attribution[] = prevRegistry.attributions;
  const attrEvents = new EventEmitter();
  let attrTimer: NodeJS.Timeout | null = null;
  const emitAttributions = () => {
    scheduleSave();
    if (attrTimer) return;
    attrTimer = setTimeout(() => { attrTimer = null; attrEvents.emit('attributions', attributions); }, 200);
  };
  const prune = (root: string, dirty: string[], opts: { exclude?: string[]; before?: number }) => {
    const next = pruneAttributions(attributions, root, new Set(dirty), opts);
    if (next.length !== attributions.length) { attributions = next; emitAttributions(); }
  };
  // Tool-call windows: sent at once, never debounced — atelierd handles a PreToolUse
  // before the hook bridge exits, so the window reaches the app before the command can write anything.
  let toolCalls: ToolCallWindow[] = [];
  const callEvents = new EventEmitter();
  const setCalls = (next: ToolCallWindow[]) => {
    if (next === toolCalls) return;
    const changed = changedCalls(toolCalls, next);
    toolCalls = next;
    if (changed.length > 0) callEvents.emit('toolCalls', changed);
  };
  // The Claude Code signals notebook: fed before the reducers, so a payload they
  // ignore is noted too; it never throws.
  const signals = new SignalBook({ file: paths.claudeSignals, installed: new Set<string>(HOOK_EVENTS), log });
  const custom = o.onHook;
  const onHook = custom ? (term: string, payload: unknown): null => { custom(term, payload); return null; } : ((term: string, payload: unknown): NameReply | null => {
    signals.noteHook(payload, terminals.foregroundOf(term));
    const r = terminals.applyHook(term, payload);
    if (!r.ok) { log(`hook ignored for terminal ${term}`); return null; }
    if (r.attribution) { attributions = addAttribution(attributions, r.attribution); emitAttributions(); }
    // After the reducer: a background Bash's PostToolUse registers its shell, which gives the window its taskId.
    setCalls(applyToolCallHook(toolCalls, term, payload, Date.now()));
    return r.reply;
  });
  const onStatus = o.onStatus ?? ((term: string, payload: unknown) => {
    signals.noteStatus(payload, terminals.foregroundOf(term));
    const r = terminals.applyStatus(term, payload);
    if (!r) return;
    const now = Date.now() / 1000;
    // Stored with its fresh updatedAt (the per-dir cap evicts the stalest); sent only when something visible changed.
    const merged = mergeUsage(usage, r.usage, now);
    const usageMoved = usageKey(merged) !== usageKey(usage);
    usage = merged;
    if (usageMoved) usageEvents.emit('usage', usage);
    const byDir = mergeUsageByDir(usageByDir, r.configDir, r.usage, now);
    const dirMoved = usageKey(byDir) !== usageKey(usageByDir);
    usageByDir = byDir;
    if (dirMoved) usageEvents.emit('usageByConfigDir', usageByDir);
  });

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const setResumables = (next: Resumable[]) => { resumables = next; resumeEvents.emit('resumables', resumables); scheduleSave(); };
  const resuming = new Set<string>();
  /**
   * `configDir`: the account's dir the app picked, never the stored one — only the app knows
   * which dir is the default, which must start without CLAUDE_CONFIG_DIR. Null or absent: plain `claude --resume`.
   */
  const resume = async (id: string, cols: number, rows: number, profile?: TerminalProfile, aliases?: boolean, configDir?: string | null): Promise<TerminalInfo> => {
    const r = resumables.find((x) => x.id === id);
    if (!r || resuming.has(id)) throw new Error('session already resumed or unknown');
    if (!UUID.test(r.sessionId)) throw new Error('invalid session id');
    resuming.add(id);
    try {
      const p = profile ?? r.profile;
      await envReady(p);
      // Created first: a profile that can't start (shell no longer allowed) leaves the session resumable; so does a
      // shell that dies at once (resumeOf).
      // The terminal's name as saved (a pending one goes to Claude at SessionStart); the last title is only a label.
      const info = terminals.create({ projectRoot: r.projectRoot, cwd: r.cwd, cols, rows, nameState: resumedName(r), label: r.title, color: r.color, profile: p, aliases, command: withConfigDir(`claude --resume ${shellQuote(r.sessionId)}`, configDir ?? undefined), resumeOf: r, ...(r.lastMessageAt !== undefined ? { lastMessageAt: r.lastMessageAt } : {}) });
      setResumables(resumables.filter((x) => x.id !== id));
      return info;
    } finally {
      resuming.delete(id);
    }
  };
  const dismiss = (id: string) => setResumables(resumables.filter((x) => x.id !== id));
  terminals.on('changed', scheduleSave);
  // A terminal or session gone, a background shell over: their open calls end.
  const syncCalls = () => { if (toolCalls.some((c) => c.end === null)) setCalls(syncToolCalls(toolCalls, terminals.list(), Date.now())); };
  terminals.on('lost', (r: Resumable) => setResumables([...resumables.filter((x) => x.id !== r.id), r]));

  // Scheduled prompts: ticked every second and on every terminal change; while a
  // pasted prompt waits for its Enter, pumped every 50 ms.
  let server: RunningServer | null = null;
  const schedules = new ScheduleBook({
    terminals: () => terminals.list(),
    promptState: (id) => terminals.promptState(id),
    write: (id, data) => terminals.writeOwn(id, data),
    usageFor: (configDir) => usageByDir.find((e) => e.configDir === (configDir ?? null))?.usage ?? null,
    clients: () => (server?.clients() ?? 0) > 0
  }, { file: paths.schedules, log });
  let schedSave: NodeJS.Timeout | null = null;
  let pump: NodeJS.Timeout | null = null;
  const pumpWhileSending = () => {
    if (pump || !schedules.sending()) return;
    pump = setInterval(() => {
      schedules.pump();
      if (!schedules.sending() && pump) { clearInterval(pump); pump = null; }
    }, 50);
  };
  schedules.on('changed', () => {
    pumpWhileSending();
    if (!schedSave) schedSave = setTimeout(() => { schedSave = null; schedules.save(); }, 200);
  });
  let schedTick: NodeJS.Timeout | null = null;
  // After every tick too, not only on its 'changed' event: a paste must never wait for an unrelated change to get its Enter.
  const tick = () => { schedules.tick(); pumpWhileSending(); };
  const tickSoon = () => { if (!schedTick) schedTick = setTimeout(() => { schedTick = null; tick(); }, 0); };
  terminals.on('changed', tickSoon);
  const schedPoll = setInterval(tick, 1000);

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      clearInterval(schedPoll);
      if (pump) clearInterval(pump);
      if (schedTick) clearTimeout(schedTick);
      if (schedSave) clearTimeout(schedSave);
      terminals.off('changed', tickSoon);
      schedules.save();
      clearInterval(poll);
      clearInterval(callPrune);
      terminals.off('changed', syncCalls);
      capturing?.cancel();
      if (attrTimer) clearTimeout(attrTimer);
      // Save before closing the terminals: at the next start the live sessions become resumable.
      terminals.off('changed', scheduleSave);
      saveNow();
      terminals.disposeAll();
      await server?.close();
      // Once no hook can arrive any more: whatever the notebook's debounce still held is saved now.
      signals.flush();
      signals.dispose();
      await hostServer?.close();
      if (!pipe) try { unlinkSync(paths.sock); } catch { /* already removed */ }
      try { unlinkSync(paths.info); } catch { /* already removed */ }
      log('atelierd stopped');
    })();
    return stopping;
  };

  server = await startServer(paths.sock, {
    tokens, terminals, version: o.version, pid: process.pid, log,
    onHook, onStatus, getUsage: () => usage, getUsageByConfigDir: () => usageByDir, usageEvents,
    getAttributions: () => attributions, attrEvents, prune,
    getToolCalls: () => toolCalls, callEvents,
    getResumables: () => resumables, resumeEvents, resume, dismiss, create,
    getShellEnv: () => envState, envEvents, schedules, signals,
    reloadEnv: async () => ({ capturedAt: (await reloadEnv()).capturedAt }),
    onShutdown: () => { void stop().then(() => o.onStopped?.()); },
    maxQueuedBytes: o.maxQueuedBytes
  });
  // Windows: Node can't set a pipe's DACL; the tokens are the guard there.
  if (!pipe) chmodSync(paths.sock, 0o600);

  const info: DaemonInfo = {
    pid: process.pid, version: o.version, sock: paths.sock, token: tokens.control, startedAt: Date.now(),
    ...(currentPlatform() === 'win32' ? { runtime: path.dirname(process.execPath) } : {})
  };
  writeFileAtomic(paths.info, JSON.stringify(info), 0o600);
  const poll = setInterval(() => terminals.pollForeground(), 1000);
  terminals.on('changed', syncCalls);
  // A call whose session waits for a permission or an answer is never capped: the command runs only once you answer.
  const callPrune = setInterval(() => {
    setCalls(pruneToolCalls(toolCalls, Date.now(), CALL_CAP_MS, CALL_KEEP_MS, MAX_CALLS, waitingForAnswer(terminals.list())));
  }, 30_000);
  // Started now, so a create that arrives first finds it in flight and waits for it; the user's shell runs in the
  // background (it may take seconds) and only Atelier-profile terminals wait for it.
  if (o.captureShellEnv) reloadEnv().catch(() => { /* logged, and reported in envState */ });
  log(`atelierd ${o.version} started, pid ${process.pid}`);

  return { paths, info, hookToken: tokens.hook, terminals, reloadEnv, getShellEnv: () => envState, stop };
}
