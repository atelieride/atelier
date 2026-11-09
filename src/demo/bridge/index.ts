// The demo's fake backend: `window.atelier` for the real renderer, answered in the browser from
// the compiled world. Typed in full — `satisfies AtelierApi`, no Proxy, no Partial — so a new method in api.ts is a
// type error here until someone decides what the demo does with it (usually one line).
import type { AtelierApi, DaemonState } from '@shared/api';
import type { Platform } from '@shared/platform';
import { createClock, type Clock } from '../engine/clock';
import { rebase } from '../engine/time';
import { createWorktree } from '../engine/worktree';
import type { DemoWorld } from '../types';
import { createClipboard } from './clipboard';
import { createAutomations } from './automations';
import { createConnectors, createTasks } from './connectors';
import { noop, resolved, type DemoContext } from './context';
import { createDictation } from './dictation';
import { createDocker } from './docker';
import { createEmitter, type Emitter } from './events';
import { createFiles } from './files';
import { createGit, createScm } from './git';
import { createBackground } from './background';
import { createClaude, createClaudeSignals, createNotifications, createPorts, createPrs, createSchedules, createServices, createShellCommand, createShellEnv } from './inert';
import { createCompanion } from './companion';
import { createDatabases } from './databases';
import type { AskPlayer } from '../engine/ask';
import { notInDemo } from './not-in-demo';
import { createRedis } from './redis';
import { DEMO_SETTINGS, createSettings } from './settings';
import { createTabs } from './tabs';
import { createTerminals } from './terminals';
import { createUpdate } from './update';

export interface DemoBridgeOptions {
  /** The app version (package.json, defined at build time). */
  version: string;
  now?: () => number;
  /** Tests pass their own; the demo makes one. */
  clock?: Clock;
  /**
   * darwin for a visitor on a Mac, linux for anyone else: Ctrl key labels, while the world's paths stay POSIX (win32
   * would switch the renderer to Windows paths the fictional world doesn't have). Default darwin.
   */
  platform?: Platform;
  /** Ask's script and its reader (engine/ask.ts ASK_PLAYER): tests hand it over; the demo loads it as a chunk of its own on first use. */
  askPlayer?: () => Promise<AskPlayer>;
}

/** The world's scripted moments the shell may bring forward ("Things to try" shows them on a click). */
export interface DemoBeats {
  /** The Docker beat now: the worker crash-loops and stays exited 1 (once; the 20 s timer then does nothing). */
  crashWorker(): void;
}

export interface DemoBridge { api: AtelierApi; events: Emitter; context: DemoContext; beats: DemoBeats }

/** The bridge and its insides (the engine and the demo shell drive the events and the state). */
export function createDemo(compiled: DemoWorld, opts: DemoBridgeOptions): DemoBridge {
  const now = opts.now ?? Date.now;
  // The world on the visitor's clock: "just now" stays just now, limits reset in 2 h as in the shot.
  const world = rebase(compiled, now() - compiled.t0);
  const events = createEmitter();
  const base: Omit<DemoContext, 'worktree'> = {
    world, events, now, version: opts.version, clock: opts.clock ?? createClock(),
    state: {
      terminals: world.sessions.map((s) => s.terminal), files: { ...world.files }, index: {}, attributions: [...world.attributions], settings: DEMO_SETTINGS, clipboard: null,
      sizes: new Map(), attached: new Set(), dirs: new Set(), prompts: new Map(), scripted: new Map(), cleared: new Set()
    }
  };
  const ctx: DemoContext = { ...base, worktree: createWorktree(base) };
  const { root, name } = world.project;
  const daemon: DaemonState = {
    connected: true, listed: true, version: opts.version, mismatch: false, incompatible: false, profilesAvailable: true, states2Available: true,
    backgroundAvailable: true, aliasesAvailable: true, namesAvailable: true, shellEnv: { state: 'ready', capturedAt: now(), aliases: 0 },
    // Settings › Claude's compatibility row reads as with a current atelierd (an empty notebook, inert).
    signalsAvailable: true
  };
  const mac = (what: string) => () => { notInDemo(what); return noop(); };
  const docker = createDocker(ctx);

  const api = {
    platform: opts.platform ?? 'darwin',
    // Never Windows here: no Windows pty for the demo's xterms.
    osVersion: '',
    bootTheme: 'aurora',
    project: () => resolved({ root, name, realRoot: root }),
    openFolder: mac('Open Folder'),
    newWindow: mac('New Window'),
    // Pop-out windows are a desktop thing: inert here, and never any in the list.
    popout: {
      open: () => { notInDemo('New Window'); return resolved({ ok: false as const, reason: 'failed' as const }); },
      dock: () => resolved(undefined),
      focus: () => resolved(undefined),
      recall: () => resolved(undefined),
      forward: () => resolved(undefined),
      list: () => resolved([] as string[]),
      handoff: () => resolved(null),
      dragStart: () => resolved(undefined),
      dragEnd: () => resolved(null),
      dragCancel: () => resolved(undefined),
      openInMain: () => resolved(undefined),
      showInMain: () => resolved(undefined),
      rekey: () => resolved(undefined),
      tearStart: () => resolved(undefined),
      tearEnd: () => resolved(undefined)
    },
    // One project window on the site: nowhere to move a tab to.
    projectWindows: {
      list: () => resolved([]),
      moveTab: () => resolved({ ok: false as const, reason: 'failed' as const }),
      adopted: () => resolved(undefined)
    },
    recentProjects: () => resolved([]),
    openRecent: mac('Open Recent'),
    forgetRecent: () => resolved([]),
    daemonState: () => resolved(daemon),
    usage: () => resolved(world.usage),
    files: createFiles(ctx),
    clipboard: createClipboard(ctx),
    pathForFile: () => { notInDemo('Files from your disk'); return null; },
    // Never the browser's queryLocalFonts (a permission prompt): common monospaced families, of which the renderer's
    // canvas check keeps the ones the visitor has.
    localFonts: () => resolved(['Menlo', 'Monaco', 'SF Mono', 'Courier New', 'Consolas', 'Cascadia Mono', 'Ubuntu Mono', 'DejaVu Sans Mono', 'Liberation Mono']),
    reveal: mac('Reveal in Finder'),
    shellCommand: createShellCommand(),
    tabs: createTabs(ctx),
    openUrl(url) {
      // https only, in a new tab of the visitor's browser (the app opens it in the default browser).
      if (/^https:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
      return noop();
    },
    git: createGit(ctx),
    scm: createScm(ctx),
    attributions: () => resolved(ctx.state.attributions),
    resolveAttributions: () => resolved(null),
    undoResolve: () => resolved(false),
    resumables: () => resolved([]),
    // Scheduled prompts need atelierd: the demo's daemon state says they aren't available (entries stay disabled).
    schedules: createSchedules(),
    claudeSignals: createClaudeSignals(),
    claude: createClaude(ctx),
    restartDaemon: mac('Restart atelierd'),
    asks: { ready: noop, shown: () => resolved(false), answer: () => resolved(false) },
    reloadShellEnv: () => resolved({ ok: true }),
    shellEnv: createShellEnv(),
    settings: createSettings(ctx),
    appInfo: () => resolved({ version: opts.version, electron: '—', chrome: /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? '—', node: '—', packaged: true }),
    openLogs: mac('Logs'),
    notifications: createNotifications(),
    // The app's own errors: to the console, where the demo's tests look for them.
    logError: (e) => { console.error(`[atelier] ${e.kind}: ${e.message}`); },
    // The demo's menu bar never offers Undo Last Commit (the demo never commits).
    menuState: () => {},
    unsaved: () => {},
    // The demo draws its own menu bar (shell/menubar.ts): the page asks for none.
    menu: { model: async () => null, invoke: () => {} },
    testFault: () => resolved(null),
    revealProject: mac('Reveal in Finder'),
    dictation: createDictation(),
    openLicenses() {
      window.open(new URL('licenses.txt', document.baseURI).href, '_blank', 'noopener');
      return noop();
    },
    update: createUpdate(ctx),
    redis: createRedis(ctx),
    databases: createDatabases(ctx),
    docker: docker.api,
    services: createServices(),
    terminals: createTerminals(ctx),
    ports: createPorts(),
    prs: createPrs(),
    connectors: createConnectors(),
    automations: createAutomations(ctx),
    tasks: createTasks(ctx),
    background: createBackground(ctx),
    companion: createCompanion(ctx, opts.askPlayer ? { load: opts.askPlayer } : {}),
    on: events.on
  } satisfies AtelierApi;

  return { api, events, context: ctx, beats: { crashWorker: docker.crashNow } };
}

/** `window.atelier` for the demo. */
export function createDemoBridge(world: DemoWorld, opts: DemoBridgeOptions): AtelierApi {
  return createDemo(world, opts).api;
}
