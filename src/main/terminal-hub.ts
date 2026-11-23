import { realpathSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { openTerminalFolder } from './links';
import { app, BrowserWindow, Menu, Notification, dialog, ipcMain, nativeImage, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { dockEntries, dockOverflow } from './dock-menu';
import { badgeBitmap } from './win-shell';
import { currentPlatform } from '@shared/platform';
import { randomUUID } from 'node:crypto';
import { withoutBackground, withoutStates2 } from '@shared/session-view';
import type { WorkScan } from '@shared/background';
import { WorkTimer, attachWork, type WorkHub } from './work-hub';
import { RecentBook } from '@shared/background-recent';
import { probeEndedExits, type BackgroundHub } from './background-hub';
import { attachArtifacts, type ArtifactHub } from './artifact-hub';
import { INTERRUPT_KEY_MS, InterruptWatch } from './interrupt-watch';
import { DoneTracker, FinishQueue, StateTracker, TriggerBanners, TurnClock, longFinishes, WaitingTracker, badgeText, bannerSilent, centerEntries, groupNotes, notesFor, seenWhereViewed, showBanner, waitingCount, type Finish, type Note } from './attention';
import { devEnv, testMs } from './dev-env';
import type { NoteEntry } from '@shared/notifications';
import type { DaemonClient } from './daemon-client';
import { Attachments } from './attachments';
import { TerminalSizes, type Size } from './terminal-sizes';
import { typesSomething } from '@shared/drafts';
import type { RemoteSized } from '@shared/remote';
import { IPC, type CheckedFile, type DaemonState, type ShellEnvAuto } from '@shared/api';
import { pathListSplit } from '@shared/env';
import { neverSent } from '@shared/daemon-errors';
import { daemonOutdated, parseDaemonVersion, type DaemonBuild } from '@shared/daemon-build';
import { ClaudeHistory, historyRoot, runningSessions, type HistoryQuery } from './claude-history';
import { claudeConfigFor, claudeReducesMotion, configRootsFor, mcpConfigFiles, readClaudeConfig } from './claude-config';
import { McpWatch, POLL_MS, type McpPair } from './mcp-watch';
import { loadableMcp, type McpAdded } from '@shared/claude-config';
import { ScheduleHub } from './schedule-hub';
import type { ScheduledPrompt } from '@shared/scheduled-prompts';
import { noArgsSchema, scheduleAddSchema, scheduleFireSchema, scheduleIdSchema, scheduleRestoreSchema, scheduleSnoozeSchema, scheduleUpdateSchema } from './ipc-schemas';
import type { SignalBookView } from '@shared/claude-signals';
import { attributionResolveSchema, attributionUndoSchema, backgroundLoopSchema, backgroundWatchSchema, claudeConfigSchema, claudeRestartSchema, claudeLaunchPreviewSchema, claudeResumeSchema, termResumeSchema, idSchema, termCreateSchema, termCreateSessionSchema, termInputSchema, termRenameSchema, termResizeSchema, termStopSchema, triggerNotifySchema } from './ipc-schemas';
import { claudeResumeCommand, cleanName } from '@shared/shell';
import { isShell } from '@shared/shells';
import { keptOnClose } from '@shared/close-plan';
import { accountDirOf, accountsOf, defaultConfigDirNow, historyResume, historyRoots, isRegularFile, launchFlags, restartCommand, resumeConfigDir, resumeFields, sessionCommand } from './claude-accounts';
import { historyResumeTitle } from '@shared/session-name';
import { terminalCwd } from './fs/files';
import { wellFormedTerminal, withTerminal } from '@shared/terminal-list';
import { usageKey, type UsageEntry } from '@shared/session';
import { LastSent } from './last-sent';
import type { Attribution } from '@shared/attribution';
import { mergeAttributions } from '@shared/bash-attribution';
import type { Resumable, ShellEnvState, TerminalInfo, TerminalProfile } from '@shared/protocol';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import { aliasesOption, sessionProfile, terminalProfile, type ShellOption } from '@shared/profiles';
import { revealWindow } from './hidden-windows';
import { ShellEnvFreshness, checkApplies, checkedFiles, zshStartupFiles } from './shell-env-fresh';
import { isBelow, trimOneSep } from '@shared/paths';
import { join, toOut } from './cpath';
import { atelierHome } from '@shared/paths.node';
import { Osc7Tracker } from './osc7';
import { SessionTray, type TrayActions, type TrayHost } from './tray';

interface WindowEntry { wc: WebContents; project: string }

/**
 * A viewer that is not a window (a paired phone): it gets a terminal's screen, then its output in order, nothing lost
 * or duplicated, as a window does; the size changes it doesn't own; the terminal's end.
 */
export interface RemoteViewer {
  /** The screen, as escape sequences, at the terminal's size (null: not known). */
  snapshot(id: string, data: string, size: Size | null): void;
  data(id: string, data: string): void;
  /** Another view took the terminal's size. */
  size(id: string, cols: number, rows: number): void;
  exit(id: string): void;
}

/** Remote viewers share the windows' attachments under negative keys, which no webContents id ever is. */
const isRemote = (viewer: number) => viewer < 0;

const inProject = (t: TerminalInfo, root: string) => t.projectRoot === root;
/** `p` under a `…/` prefix (projectPrefix): `p.startsWith(prefix)` on macOS; any case and separator on Windows. */
export const underPrefix = (prefix: string, p: string) => isBelow(trimOneSep(prefix), p);
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
/** A terminal launched as a Claude session without a session this long after: Claude didn't start (the renderer's own window). */
const STARTING_MS = 30_000;

export class TerminalHub {
  private windows = new Map<number, WindowEntry>();
  /** What each window last got, the Dock badge, the usage: an equal value is not sent again. */
  private readonly sent = new LastSent();
  private attachments = new Attachments();
  /** Each terminal's one size, and which view owns it (windows and remote viewers alike). */
  private readonly sizes = new TerminalSizes();
  private readonly remotes = new Map<number, RemoteViewer>();
  private nextRemote = -1;
  /** Which terminals a remote viewer owns the size of may have changed (index.ts: the iPhone status). */
  onRemoteSized: () => void = () => {};
  /** What windows get: atelierd's list (capabilities applied) with each session's background work and artifacts attached. */
  private terminals: TerminalInfo[] = [];
  /** atelierd's list, capabilities applied, before the work is attached. */
  private raw: TerminalInfo[] = [];
  /** The work scan: which background shells still run and which are servers. */
  private work: WorkHub | null = null;
  private scans: Record<string, WorkScan> = {};
  private bg: BackgroundHub | null = null;
  /** The artifacts each session published, read from its transcript. */
  private artifactHub: (Pick<ArtifactHub, 'terminals' | 'artifacts'> & { onChange: () => void }) | null = null;
  private recentBook = new RecentBook();
  /** Recomputes the work at the next change only time brings (a cap expiry, a cron fire), waiting at most 24 h. */
  private workTimer = new WorkTimer(() => this.publish(false));
  /** Turns interrupted with Ctrl+C or Esc: Claude Code sends no hook for them (interrupt-watch.ts). */
  private interrupts = new InterruptWatch();
  /**
   * Interrupt keys waiting for quiet output (InterruptWatch.quiet): the check's timer, and Claude Code's reduced motion
   * for the session's account once read (null while reading).
   */
  private quietChecks = new Map<string, { timer: ReturnType<typeof setTimeout> | null; reduced: boolean | null; at: number }>();
  /** Connected to atelierd: without it a scan or a timer never resends the last list (nor refills the Dock menu). */
  private live = false;
  /** atelierd sent its terminal list since it connected: before it, the list windows get is empty for lack of an answer. */
  private listed = false;
  private incompatible = false;
  /** Limits per Claude config dir; one `configDir: null` entry from an older atelierd. */
  private usage: UsageEntry[] = [];
  /** The automations' runner: whether atelierd's first list is in, and who to call after each list. */
  private listedOnce = false;
  private readonly terminalListeners = new Set<() => void>();
  private readonly shownListeners = new Set<() => void>();
  private attributions: Attribution[] = [];
  private resumables: Resumable[] = [];
  /** Which of atelierd's lists arrived since it connected: until both did, the sessions it keeps aren't known. */
  private keptKnown = { terminals: false, resumables: false };
  private readonly keptListeners = new Set<() => void>();
  // Every Claude account's history, the default first.
  private history = new ClaudeHistory(() => historyRoots(accountsOf(this.settings(), defaultConfigDirNow()), historyRoot()), () => join(atelierHome(), 'companion'));
  /** Conversations from Claude's history resumed here (sessionId → terminal), hidden before Claude reports them. */
  private resumed = new Map<string, string>();
  private resuming = new Set<string>();
  /** Terminals launched as Claude sessions, still waiting for Claude to start: terminal id → when (startingIds). */
  private readonly launching = new Map<string, number>();
  /** New MCP servers: each live session's baseline, and the poll while sessions are open. */
  private mcp = new McpWatch({
    pairOf: (t) => this.mcpPair(t),
    stat: (p) => stat(p).then((s) => `${s.size}:${s.mtimeMs}`, () => ''),
    now: () => Date.now(),
    readEveryMs: testMs('ATELIER_TEST_MCP_POLL_MS')
  });
  private mcpTimer: ReturnType<typeof setInterval> | null = null;
  private mcpBusy = false;
  /** The shell environment capture of the connected atelierd (null: unknown, e.g. an atelierd older than it). */
  private shellEnv: ShellEnvState | null = null;
  /** The capture reloaded before an Atelier terminal when the user's zsh files changed. */
  private freshness = new ShellEnvFreshness({
    stat: (p) => stat(p).then((s) => ({ mtimeMs: s.mtimeMs, size: s.size, ino: s.ino }), () => null),
    reload: () => this.reloadEnv(),
    capturedAt: () => this.shellEnv?.capturedAt
  });
  private waiting = new WaitingTracker();
  private done = new DoneTracker();
  private failed = new StateTracker('error');
  private turns = new TurnClock();
  private finishes = new FinishQueue(() => this.lastList, (items) => this.flushFinishes(items));
  private lastList: TerminalInfo[] = [];
  private triggerBanners = new TriggerBanners();
  /** Scheduled prompts. */
  private readonly schedules: ScheduleHub;
  /** The connected atelierd's Claude Code signals notebook; null until it sends one. */
  private signals: SignalBookView | null = null;
  /** Current settings (provided by index.ts from the SettingsStore). */
  settings: () => Settings = () => DEFAULT_SETTINGS;
  /** Shells offered as profiles (from /etc/shells, provided by index.ts). */
  shells: () => ShellOption[] = () => [];
  /** A shell's current folder, null when unknown (provided by index.ts: procs/exec readCwd). */
  readCwd: (pid: number) => Promise<string | null> = async () => null;
  /** References to the notifications shown: without them the click handler could vanish via garbage collection. */
  private notes = new Set<Notification>();
  /** Called for every newly attributed file (the git service refreshes its repo right away). */
  onTouched: (path: string) => void = () => {};
  /** The app-side "via Bash" attributions (provided by index.ts), merged with atelierd's for the windows. */
  bashAttributions: () => Attribution[] = () => [];
  /** Settles unsure app-side attributions and undoes that (provided by index.ts: BashAttributions). */
  resolveAttributions: (paths: string[], terminalId: string | null, scope: string) => { token: string; count: number } | null = () => null;
  undoResolve: (token: string, scope: string) => boolean = () => false;
  /** Opens a project's window (provided by index.ts): for notifications and Dock entries of projects with no window. */
  openProject: (root: string) => void = () => {};
  newWindow: () => void = () => {};
  /**
   * Sessions just started waiting, or finished (past Settings' "only after working for") or stopped with an error, as
   * the trackers decided them for the Mac's own notices (index.ts: a paired phone's push notifications).
   */
  onAttention: (news: { waiting: TerminalInfo[]; done: TerminalInfo[]; error: TerminalInfo[] }) => void = () => {};
  /** Windows: the sessions to look at changed (the Jump List's "Waiting for you"). */
  onDockEntries: (entries: { id: string; label: string }[]) => void = () => {};
  /** The session icons in the menu bar / notification area (spec session tray icons), from startTray. */
  private tray: SessionTray | null = null;

  /**
   * A session the Jump List names (`--reveal=<id>`): brought forward as the Dock menu would. Asked before atelierd's
   * first list (the app starting from the Jump List), it waits for that list; false when it is not shown now.
   */
  revealTerminal(id: string): boolean {
    const t = this.lastList.find((x) => x.id === id);
    if (t) { this.reveal(t.id, t.projectRoot); return true; }
    this.pendingReveal = this.listed ? null : id;
    return false;
  }
  private pendingReveal: string | null = null;
  /** Windows: each terminal's folder from the OSC 7 its shell prints (no lsof there). */
  private osc7 = currentPlatform() === 'win32' ? new Osc7Tracker('win32') : null;
  private liveCwd(id: string): string | null { return this.osc7?.cwdOf(id) ?? null; }
  private revealPending(list: TerminalInfo[], fromDaemon: boolean): void {
    if (!fromDaemon || !this.pendingReveal) return;
    const t = list.find((x) => x.id === this.pendingReveal);
    this.pendingReveal = null;
    if (t) this.reveal(t.id, t.projectRoot);
  }
  /** Tab pop-out windows (provided by index.ts): whether a window is one, never "the project's". */
  isPopout?: (wcId: number) => boolean;
  /** A terminal living in a pop-out: the function bringing that window forward (null: not popped out). */
  popoutFor?: (root: string, terminalId: string) => (() => void) | null;
  /** A terminal shown in a pop-out window that has the focus (its notification entries arrive seen). */
  viewedInPopout?: (root: string, terminalId: string) => boolean;
  private dockKey = '';
  /**
   * Terminals whose kill atelierd received, until they leave the list: never killed again, whichever window or caller
   * asks (on Windows a second kill while ConPTY closes frees its console twice and atelierd dies).
   */
  private readonly closing = new Set<string>();

  constructor(
    private readonly client: DaemonClient,
    /** The atelierd this app would start (shared/daemon-build.ts): a running one with other code is outdated. */
    private readonly daemonBuild: DaemonBuild,
    private readonly isTrusted: (e: IpcMainInvokeEvent | IpcMainEvent) => boolean
  ) {
    this.schedules = new ScheduleHub(client, {
      broadcast: (channel, payload) => { for (const w of this.windows.values()) this.emit(w, channel, payload); },
      toProject: (project, channel, payload) => { for (const w of this.windows.values()) if (w.project === project) this.emit(w, channel, payload); },
      projectFocused: (project) => [...this.windows.values()].some((x) => x.project === project && !!BrowserWindow.fromWebContents(x.wc)?.isFocused()),
      terminalProject: (id) => this.terminals.find((x) => x.id === id)?.projectRoot ?? null,
      banner: (b) => this.scheduleBanner(b)
    }, { platform: currentPlatform() });
    client.on('terminals', (raw: TerminalInfo[]) => {
      // The v2.0 fields only from an atelierd that says it has them (the old one behaves exactly as before).
      // Fields atelierd may leave out are filled in once, here, for every window (see wellFormedTerminal).
      const known = raw.map(wellFormedTerminal);
      const states = this.client.hasCapability('states2') ? known : withoutStates2(known);
      // Background work likewise only from an atelierd that has it.
      this.raw = this.client.hasCapability('background') ? states : withoutBackground(states);
      for (const id of this.closing) if (!raw.some((x) => x.id === id)) this.closing.delete(id);
      this.work?.update(this.raw);
      this.artifactHub?.terminals(this.raw);
      void this.mcpList();
      this.publish(true);
      this.listedOnce = true;
      this.keptKnown.terminals = true;
      this.keptChanged();
      for (const cb of [...this.terminalListeners]) cb();
    });
    client.on('data', (id: string, data: string) => {
      this.osc7?.feed(id, data);
      if (this.interrupts.output(id, data, Date.now())) this.publish(true);
      for (const wcId of this.attachments.watchers(id)) {
        if (isRemote(wcId)) { this.remotes.get(wcId)?.data(id, data); continue; }
        const w = this.windows.get(wcId);
        if (w) this.emit(w, IPC.evData, id, data);
      }
    });
    client.on('exit', (id: string) => {
      this.osc7?.forget(id);
      const remotes = this.attachments.watchers(id).filter(isRemote);
      this.attachments.forgetTerminal(id);
      const sized = this.sizes.owner(id);
      this.sizes.forgetTerminal(id);
      for (const key of remotes) this.remotes.get(key)?.exit(id);
      if (sized !== undefined && isRemote(sized)) this.onRemoteSized();
      this.interrupts.forget(id);
      this.endQuietCheck(id);
      for (const w of this.windows.values()) this.emit(w, IPC.evExit, id);
    });
    client.on('attributions', (list: Attribution[]) => {
      const before = new Set(this.attributions.map((a) => `${a.path}\u0000${a.terminalId}\u0000${a.at}`));
      this.attributions = list;
      for (const a of list) if (!before.has(`${a.path}\u0000${a.terminalId}\u0000${a.at}`)) this.onTouched(a.path);
      this.refreshAttributions();
    });
    client.on('resumables', (list: Resumable[]) => {
      this.resumables = list;
      for (const w of this.windows.values()) this.emit(w, IPC.evResumables, list.filter((r) => r.projectRoot === w.project));
      this.keptKnown.resumables = true;
      this.keptChanged();
      // A paired phone lists them too.
      this.shownChanged();
    });
    client.on('usageByConfigDir', (list: UsageEntry[]) => {
      this.usage = list;
      // A new updatedAt alone changes nothing on screen; a new window asks for this.usage itself (IPC.usage).
      if (!this.sent.changed('usage', usageKey(list))) return;
      for (const w of this.windows.values()) this.emit(w, IPC.evUsage, list);
    });
    client.on('shellEnv', (s: ShellEnvState) => {
      this.shellEnv = s;
      this.broadcastDaemon();
    });
    // Only from an atelierd with the capability (DaemonClient drops the message otherwise).
    client.on('signals', (book: SignalBookView) => {
      this.signals = book;
      for (const w of this.windows.values()) this.emit(w, IPC.evClaudeSignals, book);
    });
    client.on('status', (s: string) => {
      this.incompatible = s === 'incompatible';
      this.live = s === 'connected';
      this.listed = false;
      this.keptKnown = { terminals: false, resumables: false };
      // The next atelierd may be another one: its own capture and notebook arrive after its welcome.
      if (s !== 'connected') { this.shellEnv = null; this.signals = null; this.sizes.unknown(); }
      if (s === 'connected') { this.waiting.reset(); this.done.reset(); this.failed.reset(); this.turns = new TurnClock(); }
      // Service lost: the Dock menu and badge must not point to sessions that may no longer exist.
      if (s !== 'connected') {
        this.lastList = []; this.refreshBadge(); this.refreshDockMenu([]); this.tray?.update([]);
        // Nothing recomputes the old list meanwhile: after a reconnection the first list is the trackers' baseline.
        this.work?.update([]);
        this.workTimer.clear();
      }
      this.broadcastDaemon();
    });
    // After a reconnection the service no longer knows who was attached: the still-live terminals are re-attached.
    client.on('reconnected', () => {
      for (const [wcId, w] of this.windows) {
        for (const id of this.attachments.terminalsOf(wcId)) {
          this.attachments.remove(wcId, id);
          void this.attachFor(w, wcId, id).catch(() => {});
        }
      }
      // A phone too, with a new screen; its size only if it owned it (a reconnection is nobody taking the size).
      for (const [key, v] of this.remotes) {
        for (const id of this.attachments.terminalsOf(key)) {
          const size = this.sizes.asked(key, id);
          this.attachments.remove(key, id);
          if (!size) continue;
          void this.remoteAttach(key, id, size.cols, size.rows, this.sizes.owner(id) === key).catch(() => v.exit(id));
        }
      }
    });
  }

  register(wc: WebContents, project: string): void {
    const wcId = wc.id;
    this.windows.set(wcId, { wc, project });
    this.sent.forget(`terminals:${wcId}`);
    this.sent.forget(`mcp:${wcId}`);
    wc.once('destroyed', () => this.unregister(wcId));
    // Windows: each window has its own taskbar button, so a new one gets the badge the others show.
    if (currentPlatform() === 'win32') { this.sent.forget('badge'); this.refreshBadge(); }
  }

  unregister(wcId: number): void {
    if (!this.windows.delete(wcId)) return;
    this.sent.forget(`terminals:${wcId}`);
    this.sent.forget(`mcp:${wcId}`);
    this.bg?.windowGone(wcId);
    const shown = this.attachments.terminalsOf(wcId);
    for (const id of this.attachments.removeWindow(wcId)) void this.client.request({ t: 'detach', id }).catch(() => {});
    for (const id of shown) this.leaveSize(wcId, id);
    this.sizes.forgetViewer(wcId);
  }

  /**
   * A resume entry resumed (index.ts: TerminalHomes.resumed): atelierd's reply as windows must see it — the project a
   * moved terminal went to, not the one atelierd stored.
   */
  onResumed: (oldId: string, info: TerminalInfo) => TerminalInfo = (_oldId, info) => info;

  /**
   * A terminal moved to `to`'s window: the other projects' windows stop watching it
   * at once (no output, no input). atelierd keeps its listener: the new window attaches to it.
   */
  rehomed(id: string, to: string): void {
    for (const wcId of this.attachments.watchers(id)) {
      // A phone follows the terminal wherever it goes.
      if (isRemote(wcId)) continue;
      if (this.windows.get(wcId)?.project !== to) this.attachments.remove(wcId, id);
    }
  }

  /** The ids of the project's terminals as windows know them now (pop-out restore). */
  terminalIds(root: string): string[] {
    return this.terminals.filter((t) => inProject(t, root)).map((t) => t.id);
  }

  daemonState(): DaemonState {
    const v = this.client.daemonVersion;
    return { connected: this.client.connected, listed: this.listed, version: v === null ? null : parseDaemonVersion(v).version, mismatch: v !== null && daemonOutdated(v, this.daemonBuild), incompatible: this.incompatible, profilesAvailable: this.profilesAvailable(), states2Available: this.client.hasCapability('states2'), backgroundAvailable: this.client.hasCapability('background'), aliasesAvailable: this.client.hasCapability('aliases'), namesAvailable: this.client.hasCapability('names'), shellEnv: this.shellEnv, schedulesAvailable: this.schedules.available(), closeStopAvailable: this.canStopResumable(), signalsAvailable: this.client.hasCapability('signals') };
  }

  /** The work scan's hub (index.ts): it gets every terminal list, and its scans recompute the work. */
  useWorkHub(work: WorkHub): void {
    this.work = work;
    work.onChange = (scans) => { this.scans = scans; this.publish(false); };
    work.update(this.raw);
  }

  /** The Background inspector's file follower (index.ts): it gets every list, its feeds go to their window. */
  useBackgroundHub(bg: BackgroundHub): void {
    this.bg = bg;
    bg.onFeed = (wcId, feed) => { const w = this.windows.get(wcId); if (w) this.emit(w, IPC.evBackgroundFeed, feed); };
    bg.terminals(this.terminals);
  }

  /** The sessions' artifacts (index.ts): it gets every list from atelierd, and its changes send the terminals again. */
  useArtifactHub(hub: Pick<ArtifactHub, 'terminals' | 'artifacts'> & { onChange: () => void }): void {
    this.artifactHub = hub;
    hub.onChange = () => this.publish(false);
    hub.terminals(this.raw);
  }

  /** Settings › "Count background work as Working" changed: the work, the inbox and the trackers follow at once. */
  workSettingsChanged(): void {
    this.publish(false);
  }

  /**
   * Attaches each session's work and sends the list. On a new list from atelierd always; on a scan,
   * a cap expiry or a setting only when some work changed. The trackers follow every list sent.
   */
  private publish(fromDaemon: boolean): void {
    if (!fromDaemon && !this.live) return;
    const now = Date.now();
    const count = this.settings().countBackgroundWork;
    const attached = attachWork(this.interrupts.apply(this.raw), this.scans, now, count);
    const artifacts = this.artifactHub;
    const withArtifacts = artifacts ? attachArtifacts(attached.list, (id, sid) => artifacts.artifacts(id, sid)) : attached.list;
    const { list, ended } = this.recentBook.apply(withArtifacts, now);
    const expiry = this.recentBook.nextExpiry();
    const nextChange = expiry === null ? attached.nextChange : attached.nextChange === null ? expiry : Math.min(attached.nextChange, expiry);
    const workKey = (l: TerminalInfo[]) => JSON.stringify(l.map((t) => [t.id, t.work ?? null, t.recent ?? null, t.artifacts ?? null]));
    const changed = fromDaemon || workKey(list) !== workKey(this.terminals);
    this.terminals = list;
    this.bg?.terminals(list);
    const bg = this.bg;
    if (bg && ended.length) {
      void probeEndedExits(ended, {
        exitOf: (terminalId, id) => bg.exitOf(terminalId, id),
        setExit: (terminalId, id, exit) => this.recentBook.setExit(terminalId, id, exit),
        publish: () => this.publish(false),
        wait: (ms) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); }),
        live: () => this.live,
        log: (line) => bg.log(line)
      });
    }
    this.workTimer.arm(nextChange, now);
    if (!changed) { this.revealPending(list, fromDaemon); return; }
    this.shownChanged();
    this.notifyWaiting(list, now, count);
    for (const [wcId, w] of this.windows) {
      const mine = list.filter((t) => inProject(t, w.project));
      // A list equal to the last one this window got changes nothing on its screen.
      if (this.sent.changed(`terminals:${wcId}`, mine)) this.emit(w, IPC.evTerminals, mine);
    }
    // The windows got the real list just before (same channel order): now they may restore their tabs.
    if (fromDaemon && !this.listed) { this.listed = true; this.broadcastDaemon(); }
    this.revealPending(list, fromDaemon);
  }

  /** Profiles only with an atelierd that has them: an older one gets exactly the requests it always got. */
  private profilesAvailable(): boolean { return this.client.hasCapability('profiles'); }

  /**
   * Profiles depend on the connected atelierd's capabilities: requests that carry one are built by DaemonClient once
   * the connection is up (during an atelierd restart a new terminal would otherwise go without its profile).
   */
  private sessionProfile() {
    const p = sessionProfile(this.settings().terminalProfile, this.profilesAvailable());
    return { ...(p ? { profile: p } : {}), ...this.aliases() };
  }

  /**
   * The Claude account dir of a project's terminal, when it is a configured account other than the default:
   * what the session panel reads and the dictation polish runs as.
   */
  accountDirOf(project: string | null, terminalId: string | undefined): string | undefined {
    const term = terminalId === undefined ? undefined : this.terminals.find((x) => x.id === terminalId && x.projectRoot === project);
    return accountDirOf(term?.configDir, accountsOf(this.settings(), defaultConfigDirNow()), defaultConfigDirNow());
  }

  /** Settings › Terminal › Aliases from your shell, for create/resume (built with the connected atelierd's capabilities). */
  private aliases() { return aliasesOption(this.settings().terminalAliases, this.client.hasCapability('aliases')); }

  /** atelierd captures the user's shell environment again; it replies once the capture is over (up to ~10 s). */
  private async reloadEnv(): Promise<void> {
    await this.client.request({ t: 'reloadEnv' }, { timeoutMs: 20000 });
  }

  /** The files checked before an Atelier terminal: zsh's startup files (ZDOTDIR as atelierd got it), then the extra ones. */
  private checkedFiles(): string[] {
    return checkedFiles(zshStartupFiles(homedir(), process.env.ZDOTDIR), this.settings().shellEnvWatchFiles);
  }

  /**
   * Before a terminal in the Atelier profile: the capture is reloaded first when the
   * user's zsh files changed since; the window that asked is told (toasts). Never fails the terminal.
   */
  private async freshEnv(w: WindowEntry, profile: TerminalProfile | undefined): Promise<void> {
    if (!checkApplies(profile, this.settings().shellEnvAutoReload, this.client.connected)) return;
    await this.freshness.ensure(this.checkedFiles(), {
      reloading: (files) => this.emit(w, IPC.evShellEnvAuto, { phase: 'reloading', files } satisfies ShellEnvAuto),
      failed: (error) => this.emit(w, IPC.evShellEnvAuto, { phase: 'failed', error } satisfies ShellEnvAuto)
    });
  }

  installIpc(): void {
    const handle = <T>(channel: string, fn: (w: WindowEntry, wcId: number, arg: unknown) => Promise<T> | T) =>
      ipcMain.handle(channel, (e, arg) => {
        const w = this.windows.get(e.sender.id);
        if (!w || !this.isTrusted(e)) throw new Error('unauthorized sender');
        return fn(w, e.sender.id, arg);
      });
    const on = (channel: string, fn: (wcId: number, arg: unknown) => void) =>
      ipcMain.on(channel, (e, arg) => {
        if (!this.windows.has(e.sender.id) || !this.isTrusted(e)) return;
        fn(e.sender.id, arg);
      });

    // The service state is needed by the welcome window too, which has no project.
    ipcMain.handle(IPC.daemonState, (e) => (this.isTrusted(e) ? this.daemonState() : null));
    ipcMain.handle(IPC.usage, (e) => (this.isTrusted(e) ? this.usage : []));
    handle(IPC.attributions, (w) => this.attributionsOf(w.project));
    // Only files of the window's own project (real paths, like the attributions).
    handle(IPC.attributionsResolve, (w, _wcId, arg) => {
      const o = attributionResolveSchema.parse(arg);
      const prefix = this.projectPrefix(w.project);
      const paths = o.paths.filter((p) => underPrefix(prefix, p));
      return paths.length > 0 ? this.resolveAttributions(paths, o.terminalId, prefix) : null;
    });
    // Only the project that resolved can undo it.
    handle(IPC.attributionsUndo, (w, _wcId, arg) => this.undoResolve(attributionUndoSchema.parse(arg).token, this.projectPrefix(w.project)));
    handle(IPC.resumables, (w) => this.resumables.filter((r) => r.projectRoot === w.project));
    // Scheduled prompts: every project's are listed (the palette shows them all); changes only to the window's own.
    handle(IPC.schedules, () => this.schedules.list());
    handle(IPC.scheduleAdd, (w, _wcId, arg) => this.schedules.add(w.project, scheduleAddSchema.parse(arg)));
    handle(IPC.scheduleUpdate, (w, _wcId, arg) => this.schedules.update(w.project, scheduleUpdateSchema.parse(arg)));
    handle(IPC.scheduleRemove, (w, _wcId, arg) => this.schedules.remove(w.project, scheduleIdSchema.parse(arg).id));
    handle(IPC.scheduleRestore, (w, _wcId, arg) => this.schedules.restore(w.project, scheduleRestoreSchema.parse(arg).prompt as unknown as ScheduledPrompt));
    handle(IPC.scheduleFire, (w, _wcId, arg) => { const o = scheduleFireSchema.parse(arg); return this.schedules.fire(w.project, o.id, o.force); });
    handle(IPC.scheduleSnooze, (w, _wcId, arg) => { const o = scheduleSnoozeSchema.parse(arg); return this.schedules.snooze(w.project, o.id, o.minutes); });
    // The Claude Code signals notebook (Settings › Claude): app-wide, null without the capability.
    handle(IPC.claudeSignals, (_w, _wcId, arg) => {
      noArgsSchema.parse(arg);
      return this.client.hasCapability('signals') ? this.signals : null;
    });
    // atelierd sends the empty book before it replies: once this resolves, windows have it.
    handle(IPC.claudeSignalsClear, async (_w, _wcId, arg): Promise<void> => {
      noArgsSchema.parse(arg);
      if (!this.client.hasCapability('signals')) return;
      await this.client.request({ t: 'signalsClear' });
    });
    handle(IPC.termResume, async (w, _wcId, arg) => {
      const o = termResumeSchema.parse(arg);
      const r = this.resumables.find((x) => x.id === o.id);
      if (!r || r.projectRoot !== w.project) throw new Error('session of another project');
      return this.resumeOf(r, o.cols, o.rows, (profile) => this.freshEnv(w, profile));
    });
    // Claude Code's own history of the project: listed and resumed only as the main process reads it.
    handle(IPC.claudeHistory, (w) => this.history.list(this.historyQuery(w)));
    // Claude accounts: the renderer tells the default account's sessions by this dir.
    handle(IPC.claudeDirs, () => ({ defaultDir: toOut(defaultConfigDirNow()), home: toOut(homedir()) }));
    // Launch flags: the very command a new session would run, for Settings' preview.
    handle(IPC.claudeLaunchPreview, (_w, _wcId, arg) => {
      const o = claudeLaunchPreviewSchema.parse(arg);
      return sessionCommand(this.settings(), defaultConfigDirNow(), o.account, o.name);
    });
    ipcMain.handle(IPC.claudePickDir, async (e): Promise<string | null> => {
      if (!this.isTrusted(e)) return null;
      // e2e: the folder the open panel would return, never a real panel.
      const fake = devEnv('ATELIER_TEST_PICK_DIR');
      if (fake !== undefined) return fake || null;
      const from = BrowserWindow.fromWebContents(e.sender);
      // Config folders are hidden ones: shown; a new account's folder can be made here.
      const o = { defaultPath: homedir(), properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'] as ('openDirectory' | 'createDirectory' | 'showHiddenFiles')[] };
      const r = from ? await dialog.showOpenDialog(from, o) : await dialog.showOpenDialog(o);
      return r.canceled ? null : (r.filePaths[0] && toOut(r.filePaths[0])) ?? null;
    });
    handle(IPC.claudeResume, async (w, _wcId, arg) => {
      const o = claudeResumeSchema.parse(arg);
      if (this.resuming.has(o.sessionId)) throw new Error('conversation already being resumed');
      this.resuming.add(o.sessionId);
      try {
        // Found again in its own account's folder only, and resumed with that account.
        const acc = historyResume(accountsOf(this.settings(), defaultConfigDirNow()), o.account);
        const c = await this.history.find(this.historyQuery(w), o.sessionId, acc.account);
        if (!c) throw new Error('no such conversation in this project');
        await this.freshEnv(w, sessionProfile(this.settings().terminalProfile, this.profilesAvailable()));
        const cwd = this.cwdIn(w, c.cwd);
        // With its account's launch flags, as a new session of that account.
        const command = claudeResumeCommand(c.sessionId, { model: this.settings().claudeModel, permissionMode: this.settings().claudePermissionMode, configDir: acc.dir, flags: launchFlags(this.settings(), acc.account) });
        const title = historyResumeTitle(c.title, this.client.hasCapability('names'));
        // Its new session starts with the conversation's last message time, for an atelierd that keeps it.
        const last = this.client.hasCapability('lastmessage') ? { lastMessageAt: c.at } : {};
        const info = this.launched(this.created(await this.client.request<TerminalInfo>(() => ({ t: 'create', projectRoot: w.project, cwd, cols: o.cols, rows: o.rows, ...title, command, ...last, ...this.sessionProfile() }))));
        this.resumed.set(c.sessionId, info.id);
        return info;
      } finally {
        this.resuming.delete(o.sessionId);
      }
    });
    // Session panel: what Claude Code's config files set up for a folder of the window's project — an
    // existing folder inside its real root, never .git; any other: the user scope only — from main's own config roots
    //.
    // The session's own Claude account when it is a configured one, else the default's.
    handle(IPC.claudeConfig, (w, _wcId, arg) => {
      const o = claudeConfigSchema.parse(arg);
      return claudeConfigFor(configRootsFor(this.accountDirOf(w.project, o.terminalId)), w.project, o.cwd);
    });
    // Restart Session: the window's own terminal, with that session live in it; the command
    // from main's settings (the account the session runs with, its launch flags now).
    handle(IPC.claudeRestartCommand, (w, _wcId, arg) => {
      const o = claudeRestartSchema.parse(arg);
      const term = this.terminals.find((x) => x.id === this.ownedBy(w, o.terminalId));
      if (term?.session?.sessionId !== o.sessionId) throw new Error('no such session in this terminal');
      return restartCommand(this.settings(), defaultConfigDirNow(), term.configDir, o.sessionId);
    });
    handle(IPC.claudeMcpAdded, (w) => this.mcpAddedFor(w.project));
    handle(IPC.termDismiss, async (w, _wcId, arg) => {
      const id = idSchema.parse(arg);
      const r = this.resumables.find((x) => x.id === id);
      if (!r || r.projectRoot !== w.project) return;
      await this.client.request({ t: 'dismiss', id });
    });
    handle(IPC.termCreateSession, async (w, _wcId, arg) => {
      const o = termCreateSessionSchema.parse(arg);
      const cwd = this.cwdIn(w, o.cwd);
      // The account's dir, resolved here from its id; the default account starts as before.
      const command = sessionCommand(this.settings(), defaultConfigDirNow(), o.account, o.name, { noFlags: o.noFlags });
      await this.freshEnv(w, sessionProfile(this.settings().terminalProfile, this.profilesAvailable()));
      return this.launched(this.created(await this.client.request<TerminalInfo>(() => ({ t: 'create', projectRoot: w.project, cwd, cols: o.cols, rows: o.rows, name: o.name, command, ...this.sessionProfile() }))));
    });
    handle(IPC.termRename, async (w, _wcId, arg) => {
      const o = termRenameSchema.parse(arg);
      await this.client.request({ t: 'rename', id: this.ownedBy(w, o.id), name: o.name });
    });
    handle(IPC.termMarkSeen, async (w, _wcId, arg) => {
      await this.client.request({ t: 'markSeen', id: this.ownedBy(w, idSchema.parse(arg)) });
    });
    handle(IPC.termFolder, (w, _wcId, arg) => this.folderOf(w, idSchema.parse(arg)));
    handle(IPC.termOpenFolder, async (w, _wcId, arg) => {
      const dir = await this.folderOf(w, idSchema.parse(arg));
      if (isDir(dir)) await openTerminalFolder(dir);
    });
    handle(IPC.backgroundWatch, (w, wcId, arg) => {
      const { terminalId, itemId } = backgroundWatchSchema.parse(arg);
      const t = this.terminals.find((x) => x.id === terminalId);
      if (!this.bg || !t || !inProject(t, w.project)) return { ok: false, reason: 'missing' } as const;
      return this.bg.watch(wcId, terminalId, itemId);
    });
    handle(IPC.backgroundLoop, (w, _wcId, arg) => {
      const { terminalId, cronId } = backgroundLoopSchema.parse(arg);
      const t = this.terminals.find((x) => x.id === terminalId);
      if (!this.bg || !t || !inProject(t, w.project)) return { ok: false, reason: 'missing' } as const;
      return this.bg.loop(terminalId, cronId);
    });
    on(IPC.backgroundUnwatch, (wcId, arg) => {
      const p = backgroundWatchSchema.safeParse(arg);
      if (p.success) this.bg?.unwatch(wcId, p.data.terminalId, p.data.itemId);
    });
    handle(IPC.termList, (w) => this.terminals.filter((t) => inProject(t, w.project)));
    handle(IPC.termCreate, async (w, _wcId, arg) => {
      const o = termCreateSchema.parse(arg);
      const cwd = this.cwdIn(w, o.cwd);
      const shells = () => this.shells().map((s) => s.path);
      // An unavailable profile throws below, when the request is built.
      let likely: TerminalProfile | undefined;
      try { likely = terminalProfile(o.profile, this.settings().terminalProfile, shells(), this.profilesAvailable()); } catch { likely = undefined; }
      await this.freshEnv(w, likely);
      return this.created(await this.client.request<TerminalInfo>(() => {
        const profile = terminalProfile(o.profile, this.settings().terminalProfile, shells(), this.profilesAvailable());
        return { t: 'create', projectRoot: w.project, cwd, cols: o.cols, rows: o.rows, name: o.name, command: o.command, ...(profile ? { profile } : {}), ...this.aliases() };
      }));
    });
    handle(IPC.termShells, () => this.shells());
    // Settings › Terminal › Checked files: any app page, the welcome window included.
    ipcMain.handle(IPC.shellEnvFiles, async (e): Promise<CheckedFile[] | null> => {
      if (!this.isTrusted(e)) return null;
      const home = homedir();
      const builtin = new Set(zshStartupFiles(home, process.env.ZDOTDIR));
      const label = (p: string) => (isBelow(home, p) ? `~${p.slice(home.length)}` : p);
      return Promise.all(this.checkedFiles().map(async (p) => ({ path: p, label: label(p), builtin: builtin.has(p), exists: await stat(p).then(() => true, () => false) })));
    });
    ipcMain.handle(IPC.shellEnvPickFiles, async (e): Promise<string[]> => {
      if (!this.isTrusted(e)) return [];
      // e2e: the paths the open panel would return (a PATH-like list), never a real panel.
      const fake = devEnv('ATELIER_TEST_PICK_FILES');
      if (fake !== undefined) return pathListSplit(fake).filter(Boolean);
      const from = BrowserWindow.fromWebContents(e.sender);
      const o = { defaultPath: homedir(), properties: ['openFile', 'multiSelections', 'showHiddenFiles'] as ('openFile' | 'multiSelections' | 'showHiddenFiles')[] };
      const r = from ? await dialog.showOpenDialog(from, o) : await dialog.showOpenDialog(o);
      return r.canceled ? [] : r.filePaths;
    });
    // atelierd replies once the capture is over (up to ~10 s for a slow shell config): a longer wait than usual.
    handle(IPC.daemonReloadEnv, async () => {
      if (!this.profilesAvailable()) return { error: 'atelierd does not support shell environments yet' };
      try { await this.reloadEnv(); return { ok: true as const }; }
      catch (err) { return { error: (err as Error).message }; }
    });
    handle(IPC.termAttach, (w, wcId, arg) => this.attachFor(w, wcId, idSchema.parse(arg)));
    handle(IPC.termDetach, async (_w, wcId, arg) => {
      const id = idSchema.parse(arg);
      const was = this.attachments.has(wcId, id);
      const last = this.attachments.remove(wcId, id);
      if (was) this.leaveSize(wcId, id);
      if (last) await this.client.request({ t: 'detach', id });
    });
    // The page asked already, in the row or the popover where the close was asked. With
    // "Keep closed sessions under Resume" the session comes back there: main decides.
    handle(IPC.termClose, async (w, _wcId, arg) => {
      await this.closeAsTab(this.ownedBy(w, idSchema.parse(arg)));
    });
    handle(IPC.termKill, async (w, _wcId, arg) => {
      await this.killOnce(this.ownedBy(w, idSchema.parse(arg)));
    });
    // Close Workspace's Stop: like a window close, atelierd keeps a resume entry for what has one
    // (capability 'kill-resumable'), whatever "Keep closed sessions" says. Every id must be this window's project's.
    handle(IPC.termStop, async (w, _wcId, arg) => {
      // An id that left the list meanwhile (exited) is skipped; one of another project refuses the whole call.
      const listed = termStopSchema.parse(arg).filter((id) => this.terminals.some((t) => t.id === id));
      const ids = [...new Set(listed.map((id) => this.ownedBy(w, id)))];
      const resumable = this.canStopResumable();
      await Promise.allSettled(ids.map((id) => this.killOnce(id, resumable)));
    });
    on(IPC.termInput, (wcId, arg) => {
      const o = termInputSchema.safeParse(arg);
      if (!o.success) return;
      // Typed while this window's attach is still on its way (the terminal is on screen, its screen not yet): held
      // and sent once attached, never dropped (it was: a lost first keystroke right after opening a terminal).
      if (!this.attachments.has(wcId, o.data.id)) { this.attachments.hold(wcId, o.data.id, o.data.data); return; }
      // Typing in a window takes the size back from a phone (never from another window: there only a resize does).
      if (typesSomething(o.data.data)) this.applySize(o.data.id, this.sizes.takeBack(wcId, o.data.id, isRemote), wcId);
      this.typed(o.data.id, o.data.data);
      this.client.send({ t: 'input', id: o.data.id, data: o.data.data });
    });
    on(IPC.termResize, (wcId, arg) => {
      const o = termResizeSchema.safeParse(arg);
      if (!o.success) return;
      const deliver = this.attachments.has(wcId, o.data.id) && this.client.connected;
      // One that can't be sent now goes when the attach that comes next completes (see Attachments.sized).
      this.attachments.sized(wcId, o.data.id, o.data.cols, o.data.rows, deliver);
      // A window's resize always goes as before; the views that don't own the size any more learn it.
      const hadRemote = this.remoteOwns(o.data.id);
      const changed = this.sizes.ask(wcId, o.data.id, { cols: o.data.cols, rows: o.data.rows });
      if (deliver) this.client.send({ t: 'resize', id: o.data.id, cols: o.data.cols, rows: o.data.rows });
      if (changed) this.tellSize(o.data.id, changed, wcId);
      if (hadRemote) this.onRemoteSized();
    });
    // A "notify" trigger matched: the window made its center entry; the OS banner is decided here, for a
    // terminal of its project it is attached to, with main's own setting, focus and 30 s checks.
    on(IPC.triggerNotify, (wcId, arg) => {
      const o = triggerNotifySchema.safeParse(arg);
      const w = this.windows.get(wcId);
      if (!o.success || !w || !this.attachments.has(wcId, o.data.id)) return;
      const term = this.terminals.find((x) => x.id === o.data.id && inProject(x, w.project));
      if (!term) return;
      const focused = !!BrowserWindow.fromWebContents(w.wc)?.isFocused();
      const note = this.triggerBanners.note(this.settings(), term, o.data.rule, o.data.line, focused, Date.now());
      if (note) this.showNotes([note]);
    });
  }

  /**
   * A terminal just created: known right away, so the window can attach before atelierd's next list (~100 ms later),
   * which then replaces the whole list as usual.
   */
  // ── For the automations' runner ─────────────────────────────────────────────────

  /** Every project's terminals. */
  allTerminals(): readonly TerminalInfo[] {
    return this.terminals;
  }

  /** Every project's sessions offered to resume, as atelierd last listed them. */
  allResumables(): readonly Resumable[] {
    return this.resumables;
  }

  /** The Claude accounts' limits per config dir, as the status line last reported them. */
  usageList(): readonly UsageEntry[] {
    return this.usage;
  }

  /**
   * Terminals launched as Claude sessions (New Session, Resume, a conversation from the history, a phone's new
   * session) whose Claude hasn't reported its session yet: they read as sessions already, for STARTING_MS at most.
   */
  startingIds(now = Date.now()): ReadonlySet<string> {
    for (const [id, at] of this.launching) {
      const t = this.terminals.find((x) => x.id === id);
      if (t?.session || now - at >= STARTING_MS) this.launching.delete(id);
    }
    return new Set(this.launching.keys());
  }

  /** A terminal just launched as a Claude session: starting until its session arrives. */
  private launched(info: TerminalInfo): TerminalInfo {
    if (!info.session) this.launching.set(info.id, Date.now());
    return info;
  }

  /** atelierd's first list is in (before it, an empty list means nothing). */
  daemonListed(): boolean {
    return this.listedOnce;
  }

  /** Called after every list from atelierd. */
  onTerminals(cb: () => void): () => void {
    this.terminalListeners.add(cb);
    return () => { this.terminalListeners.delete(cb); };
  }

  /**
   * Called whenever the list windows are shown may have changed: atelierd's lists, and the work, interrupts and
   * artifacts recomputed between them, or a terminal just created.
   */
  onShown(cb: () => void): () => void {
    this.shownListeners.add(cb);
    return () => { this.shownListeners.delete(cb); };
  }

  private shownChanged(): void {
    for (const cb of [...this.shownListeners]) {
      try { cb(); } catch { /* a listener's failure never stops the windows' list */ }
    }
  }

  /**
   * The Claude conversations Atelier keeps (Ask's retention): live in a terminal, kept under
   * Resume, or being resumed from Claude's history (before its terminal exists, and until Claude reports it). Null
   * until atelierd sent both its terminals and its resumables since it connected: an empty answer then would mean nothing.
   */
  keptSessions(): ReadonlySet<string> | null {
    if (!this.keptKnown.terminals || !this.keptKnown.resumables) return null;
    return new Set([...this.openSessions(), ...this.resumables.map((r) => r.sessionId)]);
  }

  /**
   * The Claude conversations open now (Ask's thread cap): live in a terminal or being
   * resumed — Resume's left out. Read once keptSessions is known.
   */
  openSessions(): ReadonlySet<string> {
    return new Set([
      ...this.terminals.flatMap((t) => (t.session ? [t.session.sessionId] : [])),
      ...this.resuming,
      ...this.resumed.keys()
    ]);
  }

  /** Called after every terminals or resumables list from atelierd (keptSessions may have become known). */
  onKeptSessions(cb: () => void): () => void {
    this.keptListeners.add(cb);
    return () => { this.keptListeners.delete(cb); };
  }

  private keptChanged(): void {
    for (const cb of [...this.keptListeners]) {
      try { cb(); } catch { /* a listener's failure never stops atelierd's lists */ }
    }
  }

  /** Stop Run: Esc into the session, as the user pressing it (Claude Code stops its turn). */
  interruptSession(id: string): void {
    // Seen by the interrupt watch as a typed Esc is, so a window showing the session brings it back to ready too.
    this.typed(id, '\x1b');
    this.client.send({ t: 'input', id, data: '\x1b' });
  }

  /** Input on its way to a terminal, seen by the interrupt watch first; an interrupt key starts its quiet check. */
  private typed(id: string, data: string): void {
    if (!this.interrupts.input(id, data, Date.now())) return;
    this.endQuietCheck(id);
    const check = { timer: null, reduced: null as boolean | null, at: Date.now() };
    this.quietChecks.set(id, check);
    // Claude Code's spinner stands still with reduced motion: then quiet says nothing.
    const t = this.raw.find((x) => x.id === id);
    const cwd = t ? terminalCwd(t.projectRoot, t.session?.cwd ?? t.cwd) : null;
    claudeReducesMotion(configRootsFor(t?.configDir), cwd).then((r) => { check.reduced = r; }, () => { check.reduced = true; });
    this.scheduleQuietCheck(id);
  }

  private scheduleQuietCheck(id: string, delay?: number): void {
    const check = this.quietChecks.get(id);
    const due = this.interrupts.quietDue(id);
    if (!check || due === null) { this.endQuietCheck(id); return; }
    check.timer = setTimeout(() => this.quietCheck(id), delay ?? Math.max(0, due - Date.now()));
    check.timer.unref?.();
  }

  private quietCheck(id: string): void {
    const check = this.quietChecks.get(id);
    if (!check) return;
    check.timer = null;
    const now = Date.now();
    // The settings read is a few milliseconds: asked again shortly, never past the key's window.
    if (check.reduced === null) {
      if (now - check.at > INTERRUPT_KEY_MS) this.endQuietCheck(id);
      else this.scheduleQuietCheck(id, 50);
      return;
    }
    // Main gets a terminal's output only while a window shows it and atelierd is connected: else quiet means nothing.
    const watched = this.live && this.attachments.watchers(id).length > 0;
    const session = this.raw.find((t) => t.id === id)?.session ?? null;
    const step = this.interrupts.quiet(id, now, session, { watched, reduced: check.reduced });
    if (step === 'wait') { this.scheduleQuietCheck(id); return; }
    this.endQuietCheck(id);
    if (step === 'settled') this.publish(true);
  }

  private endQuietCheck(id: string): void {
    const check = this.quietChecks.get(id);
    if (check?.timer) clearTimeout(check.timer);
    this.quietChecks.delete(id);
  }

  /** Close Run: an automated session's terminal closed, without the close dialog. */
  async closeAutomatedSession(id: string): Promise<void> {
    await this.killOnce(id);
  }

  /**
   * A project window closed: every terminal of the project stops, once; a Claude session
   * comes back under Resume (capability 'kill-resumable': atelierd decides which terminal has one, a resume whose Claude
   * has not started yet included). One that fails does not keep the others running.
   */
  async stopProject(root: string): Promise<void> {
    const resumable = this.client.hasCapability('kill-resumable');
    const mine = this.terminals.filter((t) => t.projectRoot === root);
    await Promise.allSettled(mine.map((t) => this.killOnce(t.id, resumable)));
  }

  /** Whether atelierd can give stopped sessions back under Resume. */
  canStopResumable(): boolean {
    return this.client.hasCapability('kill-resumable');
  }

  /** The scheduled prompts atelierd keeps (none without the capability). */
  scheduledPrompts(): ScheduledPrompt[] {
    return this.schedules.list();
  }

  /** Kills a terminal once (see `closing`); a kill atelierd never received can be sent again. */
  private async killOnce(id: string, resumable = false): Promise<void> {
    if (this.closing.has(id)) return;
    this.closing.add(id);
    try { await this.client.request(resumable ? { t: 'kill', id, resumable: true } : { t: 'kill', id }); }
    catch (err) {
      if (neverSent(err)) this.closing.delete(id);
      throw err;
    }
  }

  /**
   * An account's 5h usage in percent (undefined: the default account); null when unknown. atelierd keys entries by the
   * transcript's dir, so the default account's is `defaultDir`'s (an older atelierd sent it with no dir).
   */
  usageFor(configDir: string | undefined, defaultDir: string): number | null {
    const dir = configDir ?? defaultDir;
    const e = this.usage.find((x) => x.configDir === dir) ?? (dir === defaultDir ? this.usage.find((x) => x.configDir == null) : undefined);
    return e?.usage.fiveHour?.pct ?? null;
  }

  /**
   * A session an automation starts: New Session's request for the automation's
   * project, which may have no window; 120×36 until a window attaches (a resize then reaches the PTY). `command` is the
   * run's dot command. The folder must be in the project, never inside .git.
   */
  async createAutomatedSession(o: { project: string; cwd: string; name: string; command: string }): Promise<TerminalInfo> {
    const cwd = terminalCwd(o.project, o.cwd);
    if (!cwd) throw new Error('folder outside the project');
    if (checkApplies(sessionProfile(this.settings().terminalProfile, this.profilesAvailable()), this.settings().shellEnvAutoReload, this.client.connected)) {
      await this.freshness.ensure(this.checkedFiles(), { reloading: () => {}, failed: () => {} });
    }
    return this.created(await this.client.request<TerminalInfo>(() => ({ t: 'create', projectRoot: o.project, cwd, cols: 120, rows: 36, name: o.name, command: o.command, ...this.sessionProfile() })));
  }

  // ── Remote viewers: a paired phone, through the remote hub ─────────────────────────────

  /** A viewer that is not a window; its key, for the calls below. */
  addRemoteViewer(v: RemoteViewer): number {
    const key = this.nextRemote--;
    this.remotes.set(key, v);
    return key;
  }

  /** The viewer is gone (its phone's channel ended): it leaves every terminal it watched, sizes given back. */
  removeRemoteViewer(key: number): void {
    if (!this.remotes.delete(key)) return;
    const shown = this.attachments.terminalsOf(key);
    for (const id of this.attachments.removeWindow(key)) void this.client.request({ t: 'detach', id }).catch(() => {});
    for (const id of shown) this.leaveSize(key, id);
    this.sizes.forgetViewer(key);
    for (const k of [...this.detachAfter]) if (k.startsWith(`${key} `)) this.detachAfter.delete(k);
    this.onRemoteSized();
  }

  /** Detaches asked for while their attach was still on its way, by `key id`: done once it completes. */
  private readonly detachAfter = new Set<string>();

  /**
   * The viewer starts watching a listed terminal at its size (taking the size unless `take` is false): the terminal is
   * resized first, then atelierd sends its screen (the viewer's snapshot), then output. Resolves once the screen is in.
   * A terminal already watched is asked again: atelierd keeps one listener per terminal, and the stream the windows get
   * goes on without a gap.
   */
  remoteAttach(key: number, id: string, cols: number, rows: number, take = true): Promise<void> {
    if (!this.remotes.has(key)) return Promise.reject(new Error('viewer gone'));
    if (!this.terminals.some((t) => t.id === id)) return Promise.reject(new Error('no such terminal'));
    this.detachAfter.delete(`${key} ${id}`);
    this.applySize(id, this.sizes.ask(key, id, { cols, rows }, take), key);
    this.attachments.begin(key, id);
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const onSnap = (sid: string, data: string) => {
        if (sid !== id) return;
        done = true;
        this.client.off('snapshot', onSnap);
        const held = this.attachments.complete(key, id);
        const cancelled = this.detachAfter.delete(`${key} ${id}`);
        if (held === null || cancelled) {
          if (cancelled) { this.attachments.remove(key, id); this.leaveSize(key, id); }
          if (this.attachments.watchers(id).length === 0) this.client.request({ t: 'detach', id }).catch(() => {});
          resolve();
          return;
        }
        this.remotes.get(key)?.snapshot(id, data, this.sizeOf(id));
        for (const d of held) this.remoteType(key, id, d);
        resolve();
      };
      this.client.on('snapshot', onSnap);
      this.client.request({ t: 'attach', id }).catch((err: Error) => {
        if (done) return;
        this.client.off('snapshot', onSnap);
        this.attachments.abort(key, id);
        reject(err);
      });
    });
  }

  remoteDetach(key: number, id: string): void {
    if (!this.attachments.has(key, id)) {
      if (this.attachments.attaching(key, id)) this.detachAfter.add(`${key} ${id}`);
      return;
    }
    const last = this.attachments.remove(key, id);
    this.leaveSize(key, id);
    if (last) void this.client.request({ t: 'detach', id }).catch(() => {});
  }

  /** Input from the viewer: false (refused) unless it watches the terminal or its attach is on its way. */
  remoteInput(key: number, id: string, data: string): boolean {
    if (!this.remotes.has(key)) return false;
    if (!this.attachments.has(key, id)) return this.attachments.hold(key, id, data);
    this.remoteType(key, id, data);
    return true;
  }

  /** The viewer's own size changed: it takes the terminal's size. False unless it watches the terminal. */
  remoteResize(key: number, id: string, cols: number, rows: number): boolean {
    if (!this.attachments.has(key, id) && !this.attachments.attaching(key, id)) return false;
    this.applySize(id, this.sizes.ask(key, id, { cols, rows }), key);
    this.onRemoteSized();
    return true;
  }

  /** The terminals whose size a remote viewer owns now, with that size (windows draw them at it). */
  remoteSized(): RemoteSized[] {
    return this.sizes.owned(isRemote).flatMap((id) => {
      const size = this.sizeOf(id);
      return size ? [{ id, cols: size.cols, rows: size.rows }] : [];
    });
  }

  /** Typing from a phone takes the size back for it, from whichever view had it. */
  private remoteType(key: number, id: string, data: string): void {
    if (typesSomething(data)) this.applySize(id, this.sizes.takeBack(key, id, () => true), key);
    this.typed(id, data);
    this.client.send({ t: 'input', id, data });
  }

  /** The size the terminal has: what atelierd was sent, else the owner's own (unknown after a reconnection). */
  private sizeOf(id: string): Size | null {
    const owner = this.sizes.owner(id);
    return this.sizes.current(id) ?? (owner === undefined ? undefined : this.sizes.asked(owner, id)) ?? null;
  }

  /** A new size for atelierd (null: nothing to send); the remote viewers but `by` are told. */
  private applySize(id: string, size: Size | null, by: number | null): void {
    if (!size) return;
    if (this.client.connected) this.client.send({ t: 'resize', id, cols: size.cols, rows: size.rows });
    this.tellSize(id, size, by);
    this.onRemoteSized();
  }

  private tellSize(id: string, size: Size, by: number | null): void {
    for (const key of this.attachments.watchers(id)) if (isRemote(key) && key !== by) this.remotes.get(key)?.size(id, size.cols, size.rows);
  }

  private remoteOwns(id: string): boolean {
    const owner = this.sizes.owner(id);
    return owner !== undefined && isRemote(owner);
  }

  /** `viewer` stopped showing the terminal: when it owned the size, the most recent view still showing it takes it back. */
  private leaveSize(viewer: number, id: string): void {
    const owned = this.sizes.owner(id) === viewer;
    const next = this.sizes.leave(viewer, id, this.attachments.watchers(id));
    if (next) this.applySize(id, next, null);
    else if (owned && isRemote(viewer)) this.onRemoteSized();
  }

  /**
   * A session a phone starts in a listed project: exactly New Session (the command for the account the phone chose or
   * the one set for new sessions, its launch flags, the session profile) or New Terminal (the default profile), at the
   * project's root, at the phone's size. The shell environment is checked first, as for any Atelier terminal.
   */
  async createRemoteSession(o: { project: string; kind: 'claude' | 'terminal'; cols: number; rows: number; account?: string }): Promise<TerminalInfo> {
    const cwd = terminalCwd(o.project, o.project);
    if (!cwd) throw new Error('project folder not found');
    const at = (info: TerminalInfo) => { const t = this.created(info); this.sizes.known(t.id, { cols: o.cols, rows: o.rows }); return t; };
    const s = this.settings();
    if (o.kind === 'claude') {
      // The account the phone chose (an id it was listed), else the one set for new sessions.
      const command = sessionCommand(s, defaultConfigDirNow(), o.account, undefined);
      await this.freshEnvQuietly(sessionProfile(s.terminalProfile, this.profilesAvailable()));
      return this.launched(at(await this.client.request<TerminalInfo>(() => ({ t: 'create', projectRoot: o.project, cwd, cols: o.cols, rows: o.rows, command, ...this.sessionProfile() }))));
    }
    const shells = () => this.shells().map((x) => x.path);
    let likely: TerminalProfile | undefined;
    try { likely = terminalProfile(undefined, s.terminalProfile, shells(), this.profilesAvailable()); } catch { likely = undefined; }
    await this.freshEnvQuietly(likely);
    return at(await this.client.request<TerminalInfo>(() => {
      const profile = terminalProfile(undefined, this.settings().terminalProfile, shells(), this.profilesAvailable());
      return { t: 'create', projectRoot: o.project, cwd, cols: o.cols, rows: o.rows, ...(profile ? { profile } : {}), ...this.aliases() };
    }));
  }

  /**
   * Resumes a session left without a process, with the account it ran with, in a new terminal known at once (the
   * window shows it from the reply and attaches before atelierd's next list).
   */
  private async resumeOf(r: Resumable, cols: number, rows: number, fresh: (profile: TerminalProfile | undefined) => Promise<void>): Promise<TerminalInfo> {
    await fresh(sessionProfile(this.settings().terminalProfile, this.profilesAvailable()));
    // The account it ran with: main picks the dir, null for the default one; sent only to an
    // atelierd that uses it (the request is built once connected, so the capability is the connected one's).
    const configDir = await resumeConfigDir(r, accountsOf(this.settings(), defaultConfigDirNow()), defaultConfigDirNow(), isRegularFile);
    const dir = () => resumeFields(this.client.hasCapability('resume-config-dir'), configDir);
    // A terminal moved to another project's window: the new one keeps its home.
    const info = await this.client.request<TerminalInfo>(() => ({ t: 'resume', id: r.id, cols, rows, ...this.sessionProfile(), ...dir() }));
    return this.launched(this.created(this.onResumed(r.id, info)));
  }

  /**
   * Closes a terminal as closing its tab does: with "Keep closed sessions under Resume" a session with a conversation
   * comes back there (atelierd decides which terminal has one); once, whoever asks.
   */
  private async closeAsTab(id: string): Promise<void> {
    const term = this.terminals.find((t) => t.id === id);
    const keep = this.settings().keepClosedSessions && this.canStopResumable();
    let resumable = !!term && keptOnClose(term, keep);
    // No message yet by atelierd's count, but a conversation resumed in place (Restart Session, /resume, claude -c)
    // starts again that way: Claude's own history says whether there is one. Unreadable: not kept.
    const s = term?.session;
    if (term && keep && !resumable && s && s.lastMessageAt === null) resumable = await this.history.hasConversation(this.historyQueryFor(term.projectRoot), s.sessionId).catch(() => false);
    await this.killOnce(id, resumable);
  }

  // ── A paired phone's actions on rows (the remote hub checked them first) ──

  /**
   * Answers the permission dialog a session shows, as a key pressed in it: "1" picks its first option (allow once),
   * Esc declines. Claude Code's selection lists take a digit as the choice itself, whichever row the cursor is on.
   */
  answerPermission(id: string, choice: 'allow' | 'deny'): void {
    const data = choice === 'allow' ? '1' : '\x1b';
    // Seen by the interrupt watch as a typed key is (Esc ends the turn without a Stop).
    this.typed(id, data);
    this.client.send({ t: 'input', id, data });
  }

  /** Rename, as a row's: trimmed, control characters out, "" gives the automatic name back, the shown name is nothing. */
  async renameRemote(id: string, name: string): Promise<void> {
    const term = this.terminals.find((t) => t.id === id);
    if (!term) throw new Error('no such terminal');
    const v = cleanName(name);
    if (v === term.title) return;
    await this.client.request({ t: 'rename', id, name: v || null });
  }

  /** Close, as its tab's. */
  async closeRemote(id: string): Promise<void> {
    if (!this.terminals.some((t) => t.id === id)) throw new Error('no such terminal');
    await this.closeAsTab(id);
  }

  /** Resume, for a listed resumable of any project, at the phone's size; nothing to show the shell's reload to. */
  async resumeRemote(id: string, cols: number, rows: number): Promise<TerminalInfo> {
    const r = this.resumables.find((x) => x.id === id);
    if (!r) throw new Error('no such session to resume');
    const info = await this.resumeOf(r, cols, rows, (profile) => this.freshEnvQuietly(profile));
    this.sizes.known(info.id, { cols, rows });
    return info;
  }

  /** Dismiss, as Resume's own. */
  async dismissRemote(id: string): Promise<void> {
    if (!this.resumables.some((x) => x.id === id)) throw new Error('no such session to resume');
    await this.client.request({ t: 'dismiss', id });
  }

  /** freshEnv for a terminal no window asked for: nobody to show the reload to. */
  private async freshEnvQuietly(profile: TerminalProfile | undefined): Promise<void> {
    if (!checkApplies(profile, this.settings().shellEnvAutoReload, this.client.connected)) return;
    await this.freshness.ensure(this.checkedFiles(), { reloading: () => {}, failed: () => {} });
  }

  private created(raw: TerminalInfo): TerminalInfo {
    const info = wellFormedTerminal(raw);
    this.terminals = withTerminal(this.terminals, info);
    // Kept by a recomputation of the work before atelierd's list arrives.
    this.raw = withTerminal(this.raw, info);
    this.shownChanged();
    return info;
  }

  /** Where a new terminal starts: the project root, or one of its folders (never outside it, never inside .git). */
  private cwdIn(w: WindowEntry, cwd: string | undefined): string {
    if (cwd === undefined) return w.project;
    const ok = terminalCwd(w.project, cwd);
    if (!ok) throw new Error('folder outside the project');
    return ok;
  }

  /**
   * Attaches a window to a terminal of its project. The screen goes to the renderer as an event,
   * in the same order as the data: sending it as a reply would make it arrive after more recent data.
   */
  private attachFor(w: WindowEntry, wcId: number, rawId: string): Promise<void> {
    const id = this.ownedBy(w, rawId);
    this.attachments.begin(wcId, id);
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const onSnap = (sid: string, data: string) => {
        if (sid !== id) return;
        done = true;
        this.client.off('snapshot', onSnap);
        const held = this.attachments.complete(wcId, id);
        // The window closed meanwhile: nobody to show it to; atelierd stops sending it if no other window watches.
        if (held === null) {
          if (this.attachments.watchers(id).length === 0) this.client.request({ t: 'detach', id }).catch(() => {});
          resolve();
          return;
        }
        this.emit(w, IPC.evSnapshot, id, data);
        // The pane's size, if a resize during the attach or the disconnection never reached atelierd: the program redraws.
        const size = this.attachments.takeUndelivered(wcId, id);
        if (size) this.client.send({ t: 'resize', id, ...size });
        // What the window typed meanwhile follows the screen, in order.
        for (const d of held) {
          this.typed(id, d);
          this.client.send({ t: 'input', id, data: d });
        }
        resolve();
      };
      this.client.on('snapshot', onSnap);
      // e2e only: a slow attach, to type into a terminal before its screen arrives.
      const delay = Number(devEnv('ATELIER_TEST_ATTACH_DELAY_MS') ?? 0);
      (delay > 0 ? new Promise((r) => setTimeout(r, delay)) : Promise.resolve())
        // Superseded by a later attach of the same terminal, atelierd never replies (timeout): once its screen came, the
        // attach is over, and an abort now would cancel the one on its way.
        .then(() => this.client.request({ t: 'attach', id })).catch((err: Error) => { if (done) return; this.client.off('snapshot', onSnap); this.attachments.abort(wcId, id); reject(err); });
    });
  }

  /**
   * The screens of the Claude sessions each window shows, asked again from atelierd and sent to it, as a restart would
   * (see ScreenResync). Never a plain terminal, nor a session back at its shell: a new screen drops command blocks,
   * scroll position and selection, and only Claude's redraws were seen to go out of step.
   */
  resyncScreens(): void {
    for (const [wcId, w] of this.windows) {
      for (const id of this.attachments.terminalsOf(wcId)) {
        const info = this.terminals.find((x) => x.id === id);
        if (!info?.session || isShell(info.foreground)) continue;
        void this.attachFor(w, wcId, id).catch(() => {});
      }
    }
  }

  /** Dock badge with the number of waiting sessions (if enabled in settings). */
  refreshBadge(): void {
    const text = badgeText(this.settings(), waitingCount([this.lastList]));
    if (!this.sent.changed('badge', text)) return;
    if (currentPlatform() === 'win32') setTaskbarBadge(text); else app.dock?.setBadge(text);
  }

  /**
   * Settings › Notifications › Send Test Notification: a banner even with the window in front (the first one makes macOS
   * ask for permission, which the Dock badge needs too) and, if enabled, a badge for a few seconds. The window chimes.
   */
  testNotification(): void {
    const testLog = devEnv('ATELIER_TEST_NOTIFY_LOG');
    const banner = { title: 'Atelier', body: 'Notifications are on. Sessions waiting for you will show up like this.', silent: true };
    if (testLog || Notification.isSupported()) {
      showBanner(banner, testLog, () => {
        const note = new Notification(banner);
        this.notes.add(note);
        note.on('close', () => this.notes.delete(note));
        note.on('click', () => this.notes.delete(note));
        note.show();
      });
    }
    if (!this.settings().dockBadge) return;
    if (currentPlatform() === 'win32') setTaskbarBadge('1'); else app.dock?.setBadge('1');
    // The badge no longer shows what refreshBadge last set: the next refresh must set it again.
    this.sent.forget('badge');
    setTimeout(() => this.refreshBadge(), 5000);
  }

  /**
   * Sessions that start waiting for you or finish: an entry in the windows' notification center, always; a macOS
   * notification (per settings) if their window is not focused. Finishes wait a moment for others to group with.
   */
  private notifyWaiting(next: TerminalInfo[], now: number, countAsWork: boolean): void {
    this.lastList = next;
    this.refreshBadge();
    this.refreshDockMenu(next);
    this.tray?.update(next);
    // The trackers always update: re-enabling notifications must not fire for sessions that were already waiting.
    const waitingNow = this.waiting.update(next);
    // "Finished" on the effective state: not while background work counts, never for a cap expiry.
    const all: Finish[] = [...this.done.finishes(next, this.scans, now, countAsWork), ...this.failed.update(next).map((term) => ({ term, kind: 'error' as const, at: now }))];
    // Each finish carries its turn's length: only the long ones notify (flushFinishes, after the queue settles them).
    const finished = all.map((f) => ({ ...f, took: this.turns.took(f.term.id, now) }));
    this.turns.update(next, now);
    this.publishEntries(centerEntries(waitingNow, [], now, randomUUID));
    this.showNotes(notesFor(this.settings(), waitingNow, []));
    if (waitingNow.length) this.onAttention({ waiting: waitingNow, done: [], error: [] });
    this.finishes.push(finished);
  }

  /**
   * A batch of finishes is out, already settled by the queue (only sessions still done, once each: a woken main
   * agent's report turn makes an earlier finish stale): center entries (read already for sessions seen meanwhile) and
   * OS notifications.
   */
  private flushFinishes(settled: Finish[]): void {
    // A quick reply is no news: "Finished" (bell entry, chime, macOS banner) only after a turn of the chosen length.
    const items = longFinishes(settled, this.settings().notifyDoneAfter);
    const seen = new Set(this.lastList.filter((x) => x.session && !x.session.unread).map((x) => x.id));
    this.publishEntries(centerEntries([], items, Date.now(), randomUUID, seen));
    const done = items.filter((f) => f.kind === 'done').map((f) => f.term);
    const error = items.filter((f) => f.kind === 'error').map((f) => f.term);
    this.showNotes(notesFor(this.settings(), [], done, error));
    if (done.length || error.length) this.onAttention({ waiting: [], done, error });
  }

  /** Each window gets its project's entries (those of a session shown in a focused pop-out arrive seen). */
  private publishEntries(raw: { project: string; entry: NoteEntry }[]): void {
    if (raw.length === 0) return;
    const viewed = this.viewedInPopout;
    const list = viewed ? seenWhereViewed(raw, viewed) : raw;
    for (const w of this.windows.values()) {
      const mine = list.filter((x) => x.project === w.project).map((x) => x.entry);
      if (mine.length) this.emit(w, IPC.evNotes, mine);
    }
  }

  private showNotes(notes: Note[]): void {
    const testLog = devEnv('ATELIER_TEST_NOTIFY_LOG');
    if (notes.length === 0 || (!testLog && !Notification.isSupported())) return;
    // First drop the sessions of a project with a window in front of you (its main window or a pop-out), then group
    // the others.
    const focused = (root: string) => [...this.windows.values()].some((x) => x.project === root && !!BrowserWindow.fromWebContents(x.wc)?.isFocused());
    const windowOpen = (root: string) => [...this.windows.values()].some((x) => x.project === root);
    for (const { term: t, body, silent: quiet, title } of groupNotes(notes.filter((n) => !focused(n.term.projectRoot)))) {
      const silent = bannerSilent(quiet, windowOpen(t.projectRoot));
      showBanner({ title: title ?? t.title, body, silent }, testLog, () => {
        const note = new Notification({ title: title ?? t.title, body, silent });
        this.notes.add(note);
        note.on('close', () => this.notes.delete(note));
        note.on('click', () => { this.notes.delete(note); this.reveal(t.id, t.projectRoot); });
        note.show();
      });
    }
  }

  /**
   * Brings the session forward: its pop-out window if it lives in one, else the project's window (selecting it); with
   * no window, opens the project.
   */
  private reveal(id: string, projectRoot: string): void {
    const pop = this.popoutFor?.(projectRoot, id);
    if (pop) { pop(); return; }
    const w = [...this.windows.values()].find((x) => x.project === projectRoot && !this.isPopout?.(x.wc.id));
    const win = w && BrowserWindow.fromWebContents(w.wc);
    if (!w || !win) { this.openProject(projectRoot); return; }
    revealWindow(win);
    this.emit(w, IPC.evSelect, id);
  }

  /**
   * The session icons (spec session tray icons), started once the app is ready: index.ts gives the host (none in
   * tests: the log instead) and what only it can do; sessions open as the notifications and the Dock menu open them.
   */
  startTray(o: { host: TrayHost | null; log?: (line: unknown) => void; onError?: (e: unknown) => void } & Pick<TrayActions, 'openApp' | 'quit' | 'turnOff'>): SessionTray {
    this.tray = new SessionTray({
      platform: currentPlatform(), host: o.host, log: o.log, onError: o.onError,
      actions: { reveal: (id, root) => this.reveal(id, root), openProject: (root) => this.openProject(root), newWindow: () => this.newWindow(), openApp: o.openApp, quit: o.quit, turnOff: o.turnOff }
    });
    this.tray.setEnabled(this.settings().trayIcons);
    this.tray.update(this.lastList);
    return this.tray;
  }

  /** Where a session's MCP servers come from: its account's roots and its folder inside the project. */
  private mcpPair(t: TerminalInfo): McpPair {
    const roots = configRootsFor(accountDirOf(t.configDir, accountsOf(this.settings(), defaultConfigDirNow()), defaultConfigDirNow()));
    const cwd = terminalCwd(t.projectRoot, t.session?.cwd ?? t.cwd);
    return {
      key: [roots.configDir, roots.globalFile, cwd ?? ''].join('\u0000'),
      files: mcpConfigFiles(roots, cwd),
      read: async () => { const c = await readClaudeConfig(roots, cwd); return c.unreadable ? null : loadableMcp(c); }
    };
  }

  private mcpAddedFor(project: string): McpAdded {
    return this.settings().claudeMcpNotice ? this.mcp.addedIn(project) : {};
  }

  /** Each window gets its project's news, only when they changed. */
  private mcpEmit(): void {
    for (const [wcId, w] of this.windows) {
      const m = this.mcpAddedFor(w.project);
      if (this.sent.changed(`mcp:${wcId}`, m)) this.emit(w, IPC.evMcpAdded, m);
    }
  }

  /** atelierd's list: baselines for the sessions that appeared; the poll runs while any session is live. */
  private async mcpList(): Promise<void> {
    if (!this.settings().claudeMcpNotice) return;
    await this.mcp.update(this.raw);
    this.mcpEmit();
    if (this.mcp.live() && !this.mcpTimer) {
      this.mcpTimer = setInterval(() => void this.mcpTick(), testMs('ATELIER_TEST_MCP_POLL_MS') ?? POLL_MS);
      this.mcpTimer.unref?.();
    } else if (!this.mcp.live() && this.mcpTimer) {
      clearInterval(this.mcpTimer);
      this.mcpTimer = null;
    }
  }

  private async mcpTick(): Promise<void> {
    if (this.mcpBusy) return;
    this.mcpBusy = true;
    try { if (await this.mcp.tick()) this.mcpEmit(); } finally { this.mcpBusy = false; }
  }

  /** Settings › Claude › Notice new MCP servers: off, the news go and the poll stops; on, baselines start from now. */
  mcpSettingsChanged(): void {
    if (!this.settings().claudeMcpNotice) {
      if (this.mcpTimer) clearInterval(this.mcpTimer);
      this.mcpTimer = null;
      void this.mcp.update([]);
    }
    this.mcpEmit();
    void this.mcpList();
  }

  /** The setting changed: the icons go, or come back from the last list. */
  refreshTray(): void {
    this.tray?.setEnabled(this.settings().trayIcons);
  }

  /** Dock menu: the sessions waiting for you or finished, across all projects. Rebuilt only when it changes. */
  private refreshDockMenu(list: TerminalInfo[]): void {
    // Windows: the same entries go to the Jump List (index.ts builds it with the recent projects).
    if (currentPlatform() === 'win32') { this.onDockEntries(dockEntries(list)); return; }
    if (!app.dock) return;
    const entries = dockEntries(list);
    const more = dockOverflow(list);
    const key = JSON.stringify([entries, more]);
    if (key === this.dockKey) return;
    this.dockKey = key;
    app.dock.setMenu(Menu.buildFromTemplate([
      ...entries.flatMap((e, i, all) => [
        ...(i > 0 && all[i - 1]!.kind !== e.kind ? [{ type: 'separator' as const }] : []),
        { label: `${e.kind === 'waiting' ? '● ' : e.kind === 'error' ? '! ' : '✓ '}${e.label}`, click: () => this.reveal(e.id, e.projectRoot) }
      ]),
      ...(more ? [{ label: `+${more} more`, enabled: false }] : []),
      ...(entries.length ? [{ type: 'separator' as const }] : []),
      { label: 'New Window', click: () => this.newWindow() }
    ]));
  }

  private historyQuery(w: WindowEntry): HistoryQuery {
    return this.historyQueryFor(w.project);
  }

  private historyQueryFor(project: string): HistoryQuery {
    let realRoot = project;
    try { realRoot = toOut(realpathSync(project)); } catch { /* folder gone: nothing will match */ }
    return { root: project, realRoot, exclude: runningSessions(this.terminals, this.resumed) };
  }

  /** Sends every window its project's attributions again (atelierd's or the app-side Bash ones changed). */
  refreshAttributions(): void {
    for (const w of this.windows.values()) this.emit(w, IPC.evAttributions, this.attributionsOf(w.project));
  }

  /**
   * A project's attributions and its terminals as windows know them now (git writes: ✦ reads what the sessions that
   * changed the staged files were asked).
   */
  sessionsOf(project: string): { attributions: Attribution[]; terminals: TerminalInfo[] } {
    return { attributions: this.attributionsOf(project), terminals: this.terminals.filter((t) => inProject(t, project)) };
  }

  private attributionsOf(project: string): Attribution[] {
    const prefix = this.projectPrefix(project);
    // atelierd's (Edit/Write) first; the Bash ones only for paths it has none for.
    return mergeAttributions(this.attributions, this.bashAttributions()).filter((a) => underPrefix(prefix, a.path));
  }

  /**
   * The project's real path with a trailing slash: attributions carry real paths (e.g. /var → /private/var). Test a
   * path against it with underPrefix (a Windows path may differ in case or separator).
   */
  private projectPrefix(project: string): string {
    let real = project;
    try { real = toOut(realpathSync(project)); } catch { /* folder gone: use it as is */ }
    return real.endsWith('/') ? real : real + '/';
  }

  /**
   * Where a terminal of this window is now (Open in Finder): Claude's own folder for a session, the shell's current one
   * for a plain terminal (it follows `cd`), the folder it started in when that can't be read.
   */
  private async folderOf(w: WindowEntry, id: string): Promise<string> {
    const t = this.terminals.find((x) => x.id === this.ownedBy(w, id))!;
    if (t.session?.cwd && isDir(t.session.cwd)) return t.session.cwd;
    const live = this.liveCwd(t.id);
    if (live && isDir(live)) return live;
    if (t.pid && !this.osc7) {
      // A folder deleted meanwhile (or a name lsof could not decode) is not one: the start folder then.
      try { const dir = await this.readCwd(t.pid); if (dir && isDir(dir)) return dir; } catch { /* lsof failed: the start folder */ }
    }
    return t.cwd;
  }

  private ownedBy(w: WindowEntry, id: string): string {
    const t = this.terminals.find((x) => x.id === id);
    if (!t || !inProject(t, w.project)) throw new Error('terminal of another project');
    return id;
  }

  /** A scheduled prompt's news with no window of its project in front. */
  private scheduleBanner(b: { title: string; body: string; terminalId: string; projectRoot: string }): void {
    const testLog = devEnv('ATELIER_TEST_NOTIFY_LOG');
    if (!testLog && !Notification.isSupported()) return;
    const windowOpen = [...this.windows.values()].some((x) => x.project === b.projectRoot);
    const silent = bannerSilent(false, windowOpen);
    showBanner({ title: b.title, body: b.body, silent }, testLog, () => {
      const note = new Notification({ title: b.title, body: b.body, silent });
      this.notes.add(note);
      note.on('close', () => this.notes.delete(note));
      note.on('click', () => { this.notes.delete(note); this.reveal(b.terminalId, b.projectRoot); });
      note.show();
    });
  }

  private broadcastDaemon(): void {
    const s = this.daemonState();
    for (const w of this.windows.values()) this.emit(w, IPC.evDaemon, s);
  }

  private emit(w: WindowEntry, channel: string, ...args: unknown[]): void {
    if (!w.wc.isDestroyed()) w.wc.send(channel, ...args);
  }
}

/**
 * Windows: the waiting count as an overlay on every Atelier window's taskbar button (there is no Dock badge): an amber
 * dot, the count in its description (screen readers, the tooltip).
 */
function setTaskbarBadge(text: string): void {
  const icon = text ? nativeImage.createFromBitmap(badgeBitmap(16), { width: 16, height: 16 }) : null;
  for (const b of BrowserWindow.getAllWindows()) if (!b.isDestroyed()) b.setOverlayIcon(icon, text ? `${text} waiting` : '');
}
