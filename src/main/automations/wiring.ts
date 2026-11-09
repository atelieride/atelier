// Automations in main: the runner with its real ports, the git guard written at start,
// the IPC (sender checked, strict schemas, a new automation only for the sender's project) and the broadcast.
import { randomUUID } from 'node:crypto';
import { Notification, powerSaveBlocker, type IpcMainInvokeEvent } from 'electron';
import { IPC, type AutomationsState } from '@shared/api';
import { normalizeAutomation, type Automation } from '@shared/automations';
import type { Settings } from '@shared/settings';
import type { ConnectorId } from '@shared/tasks';
import { showBanner } from '../attention';
import { accountsOf, defaultConfigDirNow } from '../claude-accounts';
import { devEnv } from '../dev-env';
import { currentPlatform } from '@shared/platform';
import { claudeTrusts, configRootsFor, sourceInClaude } from '../claude-config';
import { realClock } from '../connectors/clock';
import type { TaskConnector } from '../connectors/task-connector';
import { dirname, join } from '../cpath';
import { probeDefault } from '../git/compare';
import { runGit } from '../git/exec';
import type { GitOps } from '../git-ops';
import { gitReads } from '../git-ops';
import {
  automationCatchUpSchema, automationPausedSchema, automationRefSchema, automationSaveSchema, automationTurnOnSchema, automationSourceMcpSchema, connectorRefSchema, runCloseSchema, runRefSchema
} from '../ipc-schemas';
import type { TerminalHub } from '../terminal-hub';
import { launchAccount } from '@shared/claude-accounts';
import { claudeRoots, realHubFs } from '../background-fs';
import { readDecisions } from './decisions';
import { writeGuard } from './guard';
import { launchRun, type LaunchPorts } from './launch';
import { branchMerged } from './merged';
import { removeLaunchFiles } from './launcher';
import { AutomationRunner } from './runner';
import { keepExistingOn, runnerSettings } from './settings';
import { AutomationsStore } from './store';

export interface AutomationsDeps {
  home: string;
  settings: { get(): Settings; set(patch: unknown): Settings | null; onChange(fn: (s: Settings) => void): () => void; absent?(key: keyof Settings): boolean };
  connectors: Record<ConnectorId, TaskConnector<never, never>>;
  hub: TerminalHub;
  gitOps: GitOps;
  fetchNow(root: string, common: string): Promise<{ outcome: string | null }>;
  windows(): { send(channel: string, payload: unknown): void; isDestroyed(): boolean }[];
  /** The sender window's project (real root), null when it has none. */
  projectOf(e: IpcMainInvokeEvent): string | null;
  trusted(e: IpcMainInvokeEvent): boolean;
  log(message: string): void;
  /** A banner's click: that project's window in front, on Automations (opened when it has no window). */
  revealAutomations(project: string): void;
  /** Windows: the app's atelier-git.exe, the session's git; null when the build has none. */
  gitExe?: string | null;
}

const quiet = (p: Promise<string>) => p.then((s) => s.trim(), () => null);


export function createAutomations(d: AutomationsDeps): { runner: AutomationRunner; installIpc(handle: (channel: string, fn: (e: IpcMainInvokeEvent, arg?: unknown) => unknown) => void): void; dispose(): void } {
  const dir = join(d.home, 'automations');
  const guardDir = join(dir, 'guard');
  try { writeGuard(guardDir, { gitExe: d.gitExe ?? null }); } catch (e) { d.log(`automations: couldn't write the git guard: ${(e as Error).message}`); }
  const store = new AutomationsStore(dir, d.log);
  // Automations became opt-in (2026-11-02): someone who already had some keeps them working, before the runner reads.
  if (keepExistingOn(d.settings.absent?.('automationsEnabled') ?? false, store.loadAutomations().length)) {
    d.settings.set({ automationsEnabled: true });
    d.log('automations: turned on (automations were set up before they became opt-in)');
  }
  const accountOf = (id: string) => {
    let picked: ReturnType<typeof launchAccount>;
    try {
      picked = launchAccount(accountsOf(d.settings.get(), defaultConfigDirNow()), id);
    } catch {
      throw new Error('its Claude account was removed in Settings › Claude: pick another in the automation');
    }
    return { dir: picked.dir, name: picked.account.name };
  };

  const launchPorts: LaunchPorts = {
    automationsDir: dir,
    guardDir,
    account: accountOf,
    trust: (configDir, root, o) => claudeTrusts(configRootsFor(configDir), root, o),
    sourceServers: async (configDir, root, connector) => (await sourceInClaude(configRootsFor(configDir), root, connector)).servers,
    git: {
      repoRoot: (folder) => gitReads.repoRoot(folder),
      version: () => quiet(runGit(d.home, ['version'])),
      defaultStart: async (root) => {
        const def = await probeDefault(root).catch(() => null);
        if (!def) return null;
        return def.ref.includes('/') ? `refs/remotes/${def.ref}` : `refs/heads/${def.ref}`;
      },
      hasRemote: async (root) => !!(await quiet(runGit(root, ['remote']))),
      currentBranch: async (folder) => {
        const b = await quiet(runGit(folder, ['rev-parse', '--abbrev-ref', 'HEAD']));
        return b && b !== 'HEAD' ? b : null;
      },
      branchExists: async (root, name) => (await quiet(runGit(root, ['rev-parse', '--verify', '-q', `refs/heads/${name}`]))) !== null,
      remoteUrls: async (root) => {
        const names = ((await quiet(runGit(root, ['remote']))) ?? '').split('\n').map((s) => s.trim()).filter((n) => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(n));
        const urls = await Promise.all(names.map((n) => quiet(runGit(root, ['config', '--get', `remote.${n}.url`]))));
        return urls.filter((u): u is string => !!u);
      },
      fetchRemote: async (root, common) => (await d.fetchNow(root, common).catch(() => ({ outcome: null }))).outcome === 'ok',
      worktreeAdd: (a) => d.gitOps.worktreeAddForRun(a),
      oid: (root, ref) => quiet(runGit(root, ['rev-parse', '--verify', '-q', ref]))
    },
    createSession: (o) => d.hub.createAutomatedSession(o)
  };

  let blocker: number | null = null;
  let broadcast: ReturnType<typeof setTimeout> | null = null;
  const runner: AutomationRunner = new AutomationRunner({
    clock: realClock,
    store,
    newId: () => randomUUID(),
    log: d.log,
    settings: () => runnerSettings(d.settings.get()),
    connector: {
      status: (c) => d.connectors[c].info().status,
      userId: (c) => d.connectors[c].userIdNow(),
      watch: (c, scopes) => d.connectors[c].watch(scopes),
      definedStatuses: (c, scopes) => d.connectors[c].definedStatuses(scopes),
      creator: (c, id) => d.connectors[c].creator(id),
      serviceScopes: (c, scopes) => d.connectors[c].serviceScopes(scopes),
      // null only when the task is gone; not read just now (offline, a 429, signed out) throws: the run waits.
      detail: async (c, id) => {
        const r = await d.connectors[c].task(id);
        if (r.ok) return r.task;
        if (r.reason === 'gone') return null;
        throw new Error(r.reason);
      }
    },
    launch: (a, run, detail) => launchRun(a, run, detail, launchPorts),
    sessions: {
      ready: () => d.hub.daemonListed(),
      terminals: () => d.hub.allTerminals(),
      interrupt: (id) => d.hub.interruptSession(id),
      close: (id) => d.hub.closeAutomatedSession(id),
      onChange: (cb) => d.hub.onTerminals(cb)
    },
    usage: (accountId) => d.hub.usageFor(accountOf(accountId).dir, defaultConfigDirNow()),
    removeLaunchFiles: (runId) => removeLaunchFiles(join(dir, 'runs', runId)),
    launchFilesUntilEnd: currentPlatform() === 'win32',
    changed: () => {
      if (broadcast) return;
      broadcast = setTimeout(() => {
        broadcast = null;
        const state = runner.view();
        for (const w of d.windows()) if (!w.isDestroyed()) w.send(IPC.evAutomations, state);
        keepAwake(state);
      }, 50);
    },
    // The session's transcript, under its account's projects root (the default one's honours test roots).
    // A run's worktree is <root>/.claude/worktrees/<name>; GitOps checks that root is the repository's top level.
    // The worktree is <dir>/.claude/worktrees/<name>, <dir> a folder of the repository's own checkout.
    removeWorktree: async (project, path) => {
      const repo = await gitReads.repoRoot(dirname(dirname(dirname(path)))).catch(() => null);
      return repo ? d.gitOps.worktreeRemoveForRun({ project, root: repo.root, path }) : { outcome: 'error', message: 'That worktree isn\'t in a repository anymore' };
    },
    merged: async (_project, r) => (r.worktree && r.branch && r.base && r.baseOid
      ? branchMerged(dirname(dirname(dirname(r.worktree))), { branch: r.branch, base: r.base, baseOid: r.baseOid }) : false),
    decisions: async (a, _run, t) => {
      if (!t.session) return null;
      const dir = accountOf(a.claude.account).dir;
      return readDecisions({ projects: dir ? join(dir, 'projects') : claudeRoots().projects, cwd: t.session.cwd ?? t.cwd, sessionId: t.session.sessionId, fs: realHubFs });
    },
    // What needs the user, as Settings › Notifications › waiting says (banner, or the test log).
    notify: (n) => {
      if (!d.settings.get().notifyWaiting) return;
      const testLog = devEnv('ATELIER_TEST_NOTIFY_LOG');
      if (!testLog && !Notification.isSupported()) return;
      showBanner({ title: n.title, body: n.body, silent: false }, testLog, () => {
        const note = new Notification({ title: n.title, body: n.body });
        notes.add(note);
        note.on('close', () => notes.delete(note));
        note.on('click', () => { notes.delete(note); d.revealAutomations(n.project); });
        note.show();
      });
    }
  });
  /** Banners alive until closed (Electron drops their clicks otherwise). */
  const notes = new Set<Notification>();

  /** Settings › Automations › Keep the Mac awake while a run works. */
  function keepAwake(state: AutomationsState): void {
    const working = state.automations.some((v) => v.runs.some((r) => r.state === 'working' || r.state === 'starting'));
    const want = working && d.settings.get().automationsKeepAwake;
    if (want && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!want && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
  }

  const offSettings = d.settings.onChange(() => runner.settingsChanged());

  /** A draft from a window: valid values, and a new automation only for that window's project; an edit keeps its own. */
  function fromWindow(e: IpcMainInvokeEvent, raw: unknown): Automation | null {
    const { automation } = automationSaveSchema.parse(raw);
    const a = normalizeAutomation(automation);
    if (!a) return null;
    const existing = runner.view().automations.find((v) => v.automation.id === a.id)?.automation;
    if (existing) return { ...a, project: existing.project, createdAt: existing.createdAt };
    const project = d.projectOf(e);
    return project && project === a.project ? a : null;
  }

  function installIpc(handle: (channel: string, fn: (e: IpcMainInvokeEvent, arg?: unknown) => unknown) => void): void {
    const on = (channel: string, fn: (e: IpcMainInvokeEvent, arg: unknown) => Promise<unknown> | unknown) =>
      handle(channel, async (e, arg) => {
        if (!d.trusted(e)) throw new Error('unauthorized sender');
        return fn(e, arg);
      });
    const state = () => runner.view();
    // A window looking at its runs: "Merged by you" read again (at most every 30 s), answered with the next broadcast.
    on(IPC.automationsList, () => { void runner.refreshMerged(); return state(); });
    on(IPC.automationsSave, (e, arg) => {
      const a = fromWindow(e, arg);
      if (!a) throw new Error('invalid automation');
      runner.save(a);
      return state();
    });
    on(IPC.automationsPreview, (e, arg) => {
      const a = fromWindow(e, arg);
      if (!a) throw new Error('invalid automation');
      return runner.preview(a);
    });
    on(IPC.automationsRemove, (_e, arg) => { runner.remove(automationRefSchema.parse(arg).id); return state(); });
    on(IPC.automationsTurnOn, async (_e, arg) => { const o = automationTurnOnSchema.parse(arg); await runner.turnOn(o.id, { startMatching: o.startMatching }); return state(); });
    on(IPC.automationsTurnOff, (_e, arg) => { runner.turnOff(automationRefSchema.parse(arg).id); return state(); });
    on(IPC.automationsCheckNow, async (_e, arg) => { await runner.checkNow(automationRefSchema.parse(arg).id); return state(); });
    on(IPC.automationsStartRun, async (_e, arg) => { await runner.startRun(runRefSchema.parse(arg).runId); return state(); });
    on(IPC.automationsSkipRun, (_e, arg) => { runner.skipRun(runRefSchema.parse(arg).runId); return state(); });
    on(IPC.automationsStopRun, (_e, arg) => { runner.stopRun(runRefSchema.parse(arg).runId); return state(); });
    on(IPC.automationsCloseRun, async (_e, arg) => {
      const o = runCloseSchema.parse(arg);
      const r = await runner.closeRun(o.runId, o.removeWorktree);
      return { state: state(), ...r };
    });
    on(IPC.automationsCatchUp, async (_e, arg) => { const o = automationCatchUpSchema.parse(arg); await runner.catchUp(o.id, o.action); return state(); });
    on(IPC.automationsScopes, async (_e, arg) => {
      const c = connectorRefSchema.parse(arg).id;
      return d.connectors[c].scopes().catch(() => []);
    });
    on(IPC.automationsSourceMcp, async (e, arg) => {
      const o = automationSourceMcpSchema.parse(arg);
      // A saved automation's own project (the All view edits other projects'); a draft's is the window's.
      const project = (o.automation !== undefined ? runner.projectOf(o.automation) : null) ?? d.projectOf(e);
      if (!project) return { state: 'unknown' };
      const r = await sourceInClaude(configRootsFor(accountOf(o.account).dir), project, o.id);
      return r.name ? { state: r.state, name: r.name } : { state: r.state };
    });
    on(IPC.automationsSetPaused, (_e, arg) => { d.settings.set({ automationsPaused: automationPausedSchema.parse(arg).paused }); return state(); });
  }

  return {
    runner,
    installIpc,
    dispose: () => {
      offSettings();
      runner.dispose();
      if (broadcast) clearTimeout(broadcast);
      if (blocker !== null) powerSaveBlocker.stop(blocker);
    }
  };
}
