// The automations' runner: it reads the sources, decides which tasks start a run, keeps
// the queues and the limits, and follows each run's session. It lives in main, so runs start for projects with no
// window; it talks to the rest of the app only through RunnerPorts (the store, the connectors, the launcher, the
// sessions, the usage), so every decision is tested with fakes and a manual clock.
import {
  conditionValues, decide, isCatchUp, ledgerAfterPoll, matches, needsConsent, needsCreator, newMatches, serviceProjectBlocked,
  type Automation, type AutomationPreview, type AutomationsSettings, type AutomationStatus, type CapInput, type Condition, type WatchedTask, type WatchResult
} from '@shared/automations';
import { ACTIVE_STATES, keepRuns, runStateOf, type Run, type RunState } from '@shared/automation-run';
import type { AutomationView, AutomationsState } from '@shared/api';
import type { TerminalInfo } from '@shared/protocol';
import type { ConnectorId, ConnectorStatus, TaskDetail } from '@shared/tasks';
import type { Clock } from '../connectors/clock';
import type { LaunchResult } from './launch';
import type { AutomationsStore, Seen } from './store';

export interface RunnerPorts {
  clock: Clock;
  store: Pick<AutomationsStore, 'loadAutomations' | 'saveAutomations' | 'loadRuns' | 'saveRuns' | 'loadSeen' | 'saveSeen' | 'remove'>;
  newId(): string;
  log(m: string): void;
  settings(): AutomationsSettings;
  connector: {
    status(c: ConnectorId): ConnectorStatus;
    /** The connected user's id ("me" in conditions); null while unknown. */
    userId(c: ConnectorId): string | null;
    /** Jira: the scopes among these that are service-desk projects; none elsewhere. */
    serviceScopes?(c: ConnectorId, scopes: readonly string[]): string[];
    /** The tasks of these scopes, with the fields conditions read, and whether that was all (throws when the source can't be read). */
    watch(c: ConnectorId, scopes: readonly string[]): Promise<WatchResult>;
    /** The statuses the scopes define, used or not (the editor's chips); best effort, none when unknown. */
    definedStatuses?(c: ConnectorId, scopes: readonly string[]): Promise<{ name: string; color?: string }[]>;
    /** Who created a task (null: unknown). */
    creator(c: ConnectorId, taskId: string): Promise<{ id: string; name: string } | null>;
    /** The task's detail for the first message (null: gone). */
    detail(c: ConnectorId, taskId: string): Promise<TaskDetail | null>;
  };
  launch(a: Automation, run: Run, detail: TaskDetail): Promise<LaunchResult>;
  sessions: {
    /** False until atelierd's first list is in (runs are re-linked then, never against an empty list). */
    ready?(): boolean;
    terminals(): readonly TerminalInfo[];
    interrupt(terminalId: string): void;
    /** Close Run: the session's terminal closed, without asking. */
    close(terminalId: string): Promise<void>;
    onChange(cb: () => void): () => void;
  };
  /** The account's 5h usage in percent, null when unknown. */
  usage(accountId: string): number | null;
  removeLaunchFiles(runId: string): void;
  /**
   * Windows: the first message points at prompt.md, which Claude reads when it needs it, so the launch files
   * stay while the run works and go when it ends; no 60 s timer.
   */
  launchFilesUntilEnd?: boolean;
  /** Something the windows show changed. */
  changed(): void;
  /** A banner for what needs the user: runs held, a catch-up, a run that couldn't start, a pause. */
  notify(n: { automationId: string; project: string; title: string; body: string }): void;
  /** "Decisions I made" from the run's session, null when there are none. */
  decisions(a: Automation, run: Run, t: TerminalInfo): Promise<string[] | null>;
  /** Close Run: the run's worktree removed through GitOps when nothing is left to commit. */
  removeWorktree(project: string, path: string): Promise<{ outcome: string; message?: string }>;
  /** Whether the user merged the run's branch: past its base commit and reachable from its base (read-only git). */
  merged(project: string, run: Run): Promise<boolean>;
}


/** Launch files go once Claude has read them: its first state, or this long after the start. */
export const LAUNCH_FILES_MS = 60_000;
/** The editor's preview: at most this many tasks, and "created by" read for this many. */
const PREVIEW_MAX = 20;
const PREVIEW_CREATORS = 10;
/** A run that just started may not be in atelierd's list yet. */
const START_GRACE_MS = 10_000;
/** A session where Claude never reported this long after the start (it exited at once, or never ran) fails the run. */
const START_LIMIT_MS = 2 * 60_000;
const SILENT = 'Claude didn\'t start in its session';
const NAMES: Record<ConnectorId, string> = { clickup: 'ClickUp', notion: 'Notion', jira: 'Jira' };
const WORKING: ReadonlySet<RunState> = new Set(['starting', 'working', 'needsYou']);
const FOLLOWED: ReadonlySet<RunState> = new Set(['starting', 'working', 'needsYou', 'review', 'stopped', 'failed']);
/** "Merged by you" is looked at for runs that no longer work, at most this often. */
const MERGED_EVERY_MS = 30_000;
/** …and only for runs that ended this recently: older branches are the user's business. */
const MERGED_FOR_MS = 30 * 24 * 60 * 60_000;
const MERGE_CHECKED: ReadonlySet<RunState> = new Set(['review', 'stopped', 'failed', 'closed']);
/** What Close Run takes: runs that no longer work. */
const CLOSABLE: ReadonlySet<RunState> = new Set(['review', 'stopped', 'failed', 'merged', 'closed']);

function pausedReason(c: ConnectorId, s: ConnectorStatus): string {
  const n = NAMES[c];
  switch (s) {
    case 'reconnect': return `${n} signed you out`;
    case 'offline': return `Can't reach ${n}`;
    case 'unavailable': return `${n}'s connector changed: update Atelier`;
    case 'connecting': return `Connecting to ${n}…`;
    default: return `${n} isn't connected`;
  }
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

export class AutomationRunner {
  private automations = new Map<string, Automation>();
  private runs = new Map<string, Run[]>();
  private seen = new Map<string, Seen>();
  /** No read before this (a failed read waits one interval). */
  private retryAt = new Map<string, number>();
  private creators = new Map<string, { id: string; name: string } | null>();
  private cleanups = new Map<string, unknown>();
  /** Each starting run's look, START_LIMIT_MS after its start, at whether Claude reported. */
  private startChecks = new Map<string, unknown>();
  private timer: unknown = null;
  private pending = new Set<Promise<unknown>>();
  private unsubscribe: (() => void) | null = null;
  private relinked = false;
  private polling = false;
  /** The pause each automation was last notified about (once per cause, until it is back). */
  private pausedNotified = new Map<string, string>();
  /** Runs whose decisions were asked for already (once each). */
  private decisionsRead = new Set<string>();

  constructor(private readonly p: RunnerPorts) {}

  // ── Life ────────────────────────────────────────────────────────────────────────────────────────────────────────

  start(): void {
    for (const a of this.p.store.loadAutomations()) {
      this.automations.set(a.id, a);
      this.runs.set(a.id, this.p.store.loadRuns(a.id));
      this.seen.set(a.id, this.p.store.loadSeen(a.id));
    }
    this.afterQuit();
    this.unsubscribe = this.p.sessions.onChange(() => this.follow());
    this.follow();
    this.plan();
  }

  dispose(): void {
    if (this.timer !== null) this.p.clock.clearTimeout(this.timer);
    this.timer = null;
    for (const h of [...this.cleanups.values(), ...this.startChecks.values()]) this.p.clock.clearTimeout(h);
    this.cleanups.clear();
    this.startChecks.clear();
    this.unsubscribe?.();
  }

  /**
   * What a quit left: a run that was starting with no session yet can't be followed, so it fails; launch
   * files go at once when their 60 s are over, else when they would have; a starting run gets its look at Claude again.
   */
  private afterQuit(): void {
    const now = this.p.clock.now();
    for (const [aid, runs] of this.runs) {
      for (const r of runs) {
        if (r.state === 'starting' && !r.terminalId) {
          this.update(aid, r.id, { state: 'failed', reason: 'Atelier closed while it was starting', endedAt: now });
          this.p.removeLaunchFiles(r.id);
          continue;
        }
        if (r.startedAt === undefined) continue;
        if (this.p.launchFilesUntilEnd) {
          if (!WORKING.has(r.state)) this.p.removeLaunchFiles(r.id);
          if (r.state === 'starting') this.checkStartAt(r.id, r.startedAt + START_LIMIT_MS - now);
          continue;
        }
        const left = r.startedAt + LAUNCH_FILES_MS - now;
        if (left > 0) this.cleanups.set(r.id, this.p.clock.setTimeout(() => this.cleanup(r.id), left));
        else this.p.removeLaunchFiles(r.id);
        if (r.state === 'starting') this.checkStartAt(r.id, r.startedAt + START_LIMIT_MS - now);
      }
    }
  }

  private checkStartAt(runId: string, wait: number): void {
    this.startChecks.set(runId, this.p.clock.setTimeout(() => this.checkStart(runId), Math.max(0, wait)));
  }

  /** START_LIMIT_MS after the start: a terminal where Claude never reported fails its run (a gone one is follow's). */
  private checkStart(runId: string): void {
    this.startChecks.delete(runId);
    const found = this.find(runId);
    if (!found || found.run.state !== 'starting' || !found.run.terminalId) return;
    const t = this.p.sessions.terminals().find((x) => x.id === found.run.terminalId);
    if (!t || t.session) return;
    this.update(found.a.id, runId, { state: 'failed', reason: SILENT, endedAt: this.p.clock.now() });
    this.processQueues();
  }

  private dropStartCheck(runId: string): void {
    const h = this.startChecks.get(runId);
    if (h === undefined) return;
    this.p.clock.clearTimeout(h);
    this.startChecks.delete(runId);
  }

  /** Every pending read and start has settled (tests). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** A saved automation's project; null for one that isn't saved (a draft). */
  projectOf(id: string): string | null {
    return this.automations.get(id)?.project ?? null;
  }

  view(): AutomationsState {
    return { automations: [...this.automations.values()].map((a) => ({ automation: a, runs: [...(this.runs.get(a.id) ?? [])], status: this.status(a) })) };
  }

  // ── Changes from the user and the app ──────────────────────────────────────────────────────────────────────────

  /**
   * A new or edited automation (validated by the caller). Enabling goes through turnOn; an edit that widens one that is
   * on (needsConsent) turns it off until the user turns it on again, so nothing starts on the wider rule before that.
   */
  save(a: Automation): void {
    const prev = this.automations.get(a.id);
    const keepOn = !!prev?.enabled && !needsConsent(prev, a);
    this.automations.set(a.id, { ...a, enabled: keepOn });
    if (!this.runs.has(a.id)) { this.runs.set(a.id, []); this.seen.set(a.id, { lastPollAt: null, ledger: {} }); }
    if (prev?.enabled && !keepOn) this.forget(a.id);
    this.persistAutomations();
    this.plan();
  }

  /** Turn On: what matches now is baselined, or started when the user asked. */
  async turnOn(id: string, o: { startMatching: boolean }): Promise<void> {
    const a = this.automations.get(id);
    if (!a) return;
    // A service-desk project without a named Created by never turns on (the editor says why).
    if (this.blocked(a)) { this.p.log('an automation on a service project needs Created by to name people: not turned on'); this.p.changed(); return; }
    this.automations.set(id, { ...a, enabled: true });
    this.persistAutomations();
    if (this.p.connector.status(a.source.connector) === 'connected') {
      await this.track(this.poll([id], o.startMatching ? 'startAll' : 'baseline'));
    }
    this.plan();
  }

  turnOff(id: string): void {
    const a = this.automations.get(id);
    if (!a) return;
    this.automations.set(id, { ...a, enabled: false });
    this.forget(id);
    this.persistAutomations();
    this.plan();
  }

  /**
   * An automation turned off forgets its ledger: turning it on again baselines what matches then. Its queued and held
   * runs leave the queue too: a baseline Turn On must not start the old backlog by itself.
   */
  private forget(id: string): void {
    this.seen.set(id, { lastPollAt: null, ledger: {} });
    this.p.store.saveSeen(id, this.seen.get(id)!);
    for (const r of this.runs.get(id) ?? []) {
      if (r.state === 'queued' || r.state === 'held') {
        this.update(id, r.id, { state: 'skipped', reason: 'Left the queue: the automation was turned off', queued: undefined, held: undefined });
      }
    }
  }

  remove(id: string): void {
    if (!this.automations.delete(id)) return;
    for (const r of this.runs.get(id) ?? []) {
      this.cleanup(r.id);
      this.dropStartCheck(r.id);
      // Windows: no timer would take them.
      if (this.p.launchFilesUntilEnd) this.p.removeLaunchFiles(r.id);
    }
    this.runs.delete(id);
    this.seen.delete(id);
    this.retryAt.delete(id);
    this.p.store.remove(id);
    this.persistAutomations();
    this.plan();
  }

  /** Check Now: this automation reads at once. */
  async checkNow(id: string): Promise<void> {
    const a = this.automations.get(id);
    if (!a?.enabled || this.p.connector.status(a.source.connector) !== 'connected') return;
    await this.track(this.poll([id], 'normal'));
    this.plan();
  }

  settingsChanged(): void {
    this.plan();
    this.processQueues();
  }

  connectorsChanged(): void {
    for (const a of this.automations.values()) {
      if (!a.enabled) continue;
      const s = this.p.connector.status(a.source.connector);
      if (s === 'connected') { this.pausedNotified.delete(a.id); continue; }
      const reason = pausedReason(a.source.connector, s);
      if (s === 'connecting' || this.pausedNotified.get(a.id) === reason) continue;
      this.pausedNotified.set(a.id, reason);
      this.say(a, `Paused: ${reason}`);
    }
    this.p.changed();
    this.plan();
  }

  /** Start, Start Now, Start Anyway: the user decided, so no limit holds it. */
  async startRun(runId: string): Promise<void> {
    const found = this.find(runId);
    if (!found || !['queued', 'held', 'skipped', 'failed'].includes(found.run.state)) return;
    await this.track(this.begin(found.a, found.run, true));
  }

  skipRun(runId: string): void {
    const found = this.find(runId);
    if (!found || !['queued', 'held'].includes(found.run.state)) return;
    this.update(found.a.id, runId, { state: 'skipped', reason: 'Skipped by you' });
  }

  stopRun(runId: string): void {
    const found = this.find(runId);
    if (!found || !WORKING.has(found.run.state) || !found.run.terminalId) return;
    this.p.sessions.interrupt(found.run.terminalId);
    // endedAt is when it stopped: the session still says running from before (no hook for the Esc), see runStateOf.
    this.update(found.a.id, runId, { state: 'stopped', reason: 'Stopped by you', endedAt: this.p.clock.now() });
    this.processQueues();
  }

  /**
   * Close Run, the user's: the session closes (a run in review becomes closed), then, when asked, its
   * worktree goes if nothing is left to commit. The branch always stays; a worktree with changes stays and the answer
   * says why.
   */
  async closeRun(runId: string, removeWorktree: boolean): Promise<{ outcome: string; message?: string }> {
    const found = this.find(runId);
    if (!found) return { outcome: 'error', message: 'That run is gone' };
    const { a, run } = found;
    if (!CLOSABLE.has(run.state)) return { outcome: 'error', message: 'That run is still working: stop it first' };
    const removing = removeWorktree && !!run.worktree && !run.worktreeRemoved;
    if (run.state === 'closed' && !removing) return { outcome: 'error', message: 'Nothing left to close' };
    if (run.terminalId && this.p.sessions.terminals().some((t) => t.id === run.terminalId)) await this.p.sessions.close(run.terminalId);
    if (this.p.launchFilesUntilEnd) this.p.removeLaunchFiles(runId);
    if (run.state === 'review') this.update(a.id, runId, { state: 'closed', endedAt: run.endedAt ?? this.p.clock.now() });
    if (!removing) return { outcome: 'ok' };
    const r = await this.p.removeWorktree(a.project, run.worktree!);
    if (r.outcome === 'ok') this.update(a.id, runId, { worktreeRemoved: true });
    return r.message !== undefined && r.outcome !== 'ok' ? { outcome: r.outcome, message: r.message } : { outcome: r.outcome };
  }

  /** "Merged by you": the runs with a base whose branch the user merged become merged. */
  async refreshMerged(): Promise<void> {
    const now = this.p.clock.now();
    if (this.mergedAt !== null && now - this.mergedAt < MERGED_EVERY_MS) return;
    for (const [aid, runs] of this.runs) {
      const a = this.automations.get(aid);
      if (!a) continue;
      for (const r of runs) {
        if (!MERGE_CHECKED.has(r.state) || !r.branch || !r.base || !r.baseOid) continue;
        if (now - (r.endedAt ?? r.startedAt ?? r.createdAt) > MERGED_FOR_MS) continue;
        this.mergedAt = now;
        if (await this.p.merged(a.project, r).catch(() => false)) this.update(aid, r.id, { state: 'merged', reason: undefined });
      }
    }
  }
  private mergedAt: number | null = null;

  /** The tasks that started matching while Atelier was closed: Start All (as new matches, limits apply) or Skip. */
  async catchUp(id: string, action: 'start' | 'skip'): Promise<void> {
    const a = this.automations.get(id);
    if (!a) return;
    const held = (r: Run | undefined): r is Run => r?.state === 'held' && r.held === 'catchUp';
    for (const { id: runId } of (this.runs.get(id) ?? []).filter(held)) {
      // Each run as it is now: a second Start All, a Skip, or a read may have taken it while this one awaited.
      const r = this.find(runId)?.run;
      if (!held(r)) continue;
      if (action === 'skip') this.update(id, r.id, { state: 'skipped', reason: 'Skipped by you', held: undefined });
      else await this.track(this.enqueue(a, { ...r, held: undefined }, false));
    }
  }

  /**
   * The editor's "Matching now" for a draft: read once, matched, nothing saved. "Created by" is read for the
   * first few matches only (one call each), so a long list costs a bounded number of reads.
   */
  async preview(a: Automation): Promise<AutomationPreview> {
    const c = a.source.connector;
    const none = { matching: [], count: 0, leftOut: [] };
    const s = this.p.connector.status(c);
    if (s !== 'connected') return { ...none, error: pausedReason(c, s) };
    // The chips' suggestions read alongside: the statuses the scopes define.
    const definedRead = this.p.connector.definedStatuses?.(c, a.source.scopes).catch(() => []) ?? Promise.resolve([]);
    let tasks: WatchedTask[];
    let people: readonly { id: string; name: string }[];
    try {
      const read = await this.p.connector.watch(c, a.source.scopes);
      tasks = read.tasks.filter((t) => a.source.scopes.includes(t.scope));
      people = read.people ?? [];
    } catch (e) {
      return { ...none, error: `Couldn't read ${NAMES[c]}: ${(e as Error).message}` };
    }
    const defined = await definedRead;
    const now = this.p.clock.now();
    const me = this.p.connector.userId(c) ?? '';
    // Every task read, before the conditions; the creators this preview read join them (ClickUp's lists carry none).
    // The connected user is "Me", never a name of its own.
    const creators = new Map<string, { id: string; name: string }>();
    const valuesNow = () => {
      const v = conditionValues(tasks.map((t) => (creators.has(t.id) ? { ...t, creatorId: creators.get(t.id)!.id } : t)), [...people, ...creators.values()], defined);
      return { ...v, people: v.people.filter((p) => p.id !== me) };
    };
    const lead = a.conditions.filter((x) => x.field !== 'createdBy');
    const matching = tasks.filter((t) => matches(t, lead, { me, now }));
    if (!needsCreator(a.conditions)) return { matching: matching.slice(0, PREVIEW_MAX), count: matching.length, leftOut: [], values: valuesNow() };
    const shown: WatchedTask[] = [];
    const leftOut: AutomationPreview['leftOut'] = [];
    for (const t of matching.slice(0, PREVIEW_CREATORS)) {
      const read = await this.creatorOf(c, t.id);
      const who = read === 'unread' ? null : read;
      if (who) creators.set(t.id, who);
      if (who && matches({ ...t, creatorId: who.id }, a.conditions, { me, now })) shown.push({ ...t, creatorId: who.id });
      else leftOut.push({ task: t, reason: who ? `Created by ${who.name}` : 'Atelier couldn\'t read who created it' });
    }
    return { matching: shown, count: shown.length + Math.max(0, matching.length - PREVIEW_CREATORS), leftOut, values: valuesNow() };
  }

  // ── Scheduling ─────────────────────────────────────────────────────────────────────────────────────────────────

  private intervalOf(a: Automation): number {
    return a.limits.checkEveryMin * 60_000;
  }

  private dueAt(a: Automation): number {
    const last = this.seen.get(a.id)?.lastPollAt ?? null;
    return Math.max(last === null ? 0 : last + this.intervalOf(a), this.retryAt.get(a.id) ?? 0);
  }

  /** The automations a read may serve now. */
  private live(): Automation[] {
    if (this.p.settings().paused) return [];
    return [...this.automations.values()].filter((a) => a.enabled && this.p.connector.status(a.source.connector) === 'connected' && !this.blocked(a));
  }

  /** A service-desk scope without a Created by naming people. */
  private blocked(a: Automation): boolean {
    return serviceProjectBlocked(a.conditions, this.p.connector.serviceScopes?.(a.source.connector, a.source.scopes) ?? []);
  }

  private plan(): void {
    if (this.timer !== null) this.p.clock.clearTimeout(this.timer);
    this.timer = null;
    const live = this.live();
    if (live.length === 0 || this.polling) return;
    const next = Math.min(...live.map((a) => this.dueAt(a)));
    const wait = next - this.p.clock.now();
    if (wait <= 0) { void this.track(this.tick()); return; }
    this.timer = this.p.clock.setTimeout(() => { this.timer = null; void this.track(this.tick()); }, wait);
  }

  /** The due automations (and those due within half the smallest interval: one read serves them), one read per connector. */
  private async tick(): Promise<void> {
    const now = this.p.clock.now();
    const live = this.live();
    if (live.length === 0) return;
    const grace = Math.min(...live.map((a) => this.intervalOf(a))) / 2;
    const due = live.filter((a) => this.dueAt(a) <= now + grace).map((a) => a.id);
    this.polling = true;
    // Whatever fails, the next read is still planned: a throw here once stopped every automation until a restart.
    try {
      await this.poll(due, 'normal');
      this.processQueues();
    } catch (e) {
      this.p.log(`automations: a read failed: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
    this.plan();
    await this.refreshMerged();
  }

  // ── Reading ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async poll(ids: readonly string[], mode: 'normal' | 'baseline' | 'startAll'): Promise<void> {
    const byConnector = new Map<ConnectorId, Automation[]>();
    for (const id of ids) {
      const a = this.automations.get(id);
      if (!a || this.blocked(a)) continue;
      byConnector.set(a.source.connector, [...(byConnector.get(a.source.connector) ?? []), a]);
    }
    for (const [c, list] of byConnector) {
      const scopes = [...new Set(list.flatMap((a) => a.source.scopes))];
      let read: WatchResult;
      try {
        read = await this.p.connector.watch(c, scopes);
      } catch (e) {
        this.p.log(`automations: couldn't read ${NAMES[c]}: ${(e as Error).message}`);
        const retry = this.p.clock.now();
        for (const a of list) this.retryAt.set(a.id, retry + this.intervalOf(a));
        continue;
      }
      for (const a of list) {
        this.retryAt.delete(a.id);
        // A never-read automation baselines on its first read: never a burst of runs.
        const first = (this.seen.get(a.id)?.lastPollAt ?? null) === null;
        await this.process(a, read.tasks.filter((t) => a.source.scopes.includes(t.scope)), read.complete, first && mode === 'normal' ? 'baseline' : mode);
      }
    }
    this.p.changed();
  }

  private async process(a: Automation, tasks: WatchedTask[], complete: boolean, mode: 'normal' | 'baseline' | 'startAll'): Promise<void> {
    const now = this.p.clock.now();
    const me = this.p.connector.userId(a.source.connector) ?? '';
    const seen = this.seen.get(a.id) ?? { lastPollAt: null, ledger: {} };
    const lead: Condition[] = a.conditions.filter((c) => c.field !== 'createdBy');
    const matching = tasks.filter((t) => matches(t, lead, { me, now }));
    const matchingIds = new Set(matching.map((t) => t.id));
    const runs = this.runs.get(a.id) ?? [];

    // Queued and held runs whose task stopped matching leave the queue (a read that wasn't whole can't tell).
    for (const r of complete ? runs : []) {
      if ((r.state === 'queued' || r.state === 'held') && !matchingIds.has(r.task.id)) {
        this.update(a.id, r.id, { state: 'skipped', reason: 'Left the queue: it no longer matches', queued: undefined, held: undefined });
      }
    }

    const busy = new Set(runs.filter((r) => ACTIVE_STATES.has(r.state)).map((r) => r.task.id));
    const candidates = mode === 'baseline' ? []
      : (mode === 'startAll' ? matching : newMatches(matching, seen.ledger, a.rerunWhenMatchesAgain)).filter((t) => !busy.has(t.id));
    const catchUp = mode === 'normal' && isCatchUp(seen.lastPollAt, now, this.intervalOf(a));

    this.seen.set(a.id, { lastPollAt: now, ledger: ledgerAfterPoll(seen.ledger, { seen: tasks.map((t) => t.id), matched: [...matchingIds] }, now) });
    this.p.store.saveSeen(a.id, this.seen.get(a.id)!);

    let held = 0;
    let caught = 0;
    const unread: string[] = [];
    for (const t of candidates) {
      const run = this.newRun(a, t);
      if (needsCreator(a.conditions)) {
        const who = await this.creatorOf(a.source.connector, t.id);
        if (who === 'unread') { unread.push(t.id); continue; }
        if (!who || !matches({ ...t, creatorId: who.id }, a.conditions, { me, now })) {
          this.add(a.id, { ...run, state: 'skipped', reason: who ? `Created by ${who.name}, who isn't in "created by"` : 'Atelier couldn\'t read who created it' });
          continue;
        }
      }
      if (catchUp) { this.add(a.id, { ...run, state: 'held', held: 'catchUp' }); caught++; continue; }
      if ((await this.enqueue(a, run, true)) === 'held') held++;
    }
    // Who created them couldn't be read (a 429, a timeout): not handled yet, so the next read tries again.
    const ledger = this.seen.get(a.id)?.ledger;
    if (unread.length && ledger) {
      for (const id of unread) if (Object.hasOwn(ledger, id)) ledger[id] = { ...ledger[id]!, done: false };
      this.p.store.saveSeen(a.id, this.seen.get(a.id)!);
      this.p.log(`automations: couldn't read who created ${unread.length} task(s); trying again on the next read`);
    }
    const s = (n: number, one: string, many: string) => (n === 1 ? one : many);
    if (caught) this.say(a, `${caught} ${s(caught, 'task', 'tasks')} started matching while Atelier was closed. Start ${s(caught, 'it', 'them')}, or skip ${s(caught, 'it', 'them')}.`);
    if (held) {
      const cap = this.p.settings().cap;
      this.say(a, `${held} ${s(held, 'run is', 'runs are')} waiting for you: ${cap} automated ${s(cap, 'run is', 'runs are')} already going, your limit.`);
    }
  }

  private say(a: Automation, body: string): void {
    this.p.notify({ automationId: a.id, project: a.project, title: a.name, body });
  }

  /** Who created a task, read once; 'unread' when the read failed (never kept: the next read asks again). */
  private async creatorOf(c: ConnectorId, id: string): Promise<{ id: string; name: string } | null | 'unread'> {
    const key = `${c}:${id}`;
    if (this.creators.has(key)) return this.creators.get(key) ?? null;
    try {
      const who = await this.p.connector.creator(c, id);
      this.creators.set(key, who);
      return who;
    } catch {
      return 'unread';
    }
  }

  // ── Starting ───────────────────────────────────────────────────────────────────────────────────────────────────

  private newRun(a: Automation, t: WatchedTask): Run {
    return {
      id: this.p.newId(), automationId: a.id, state: 'queued', createdAt: this.p.clock.now(),
      task: { source: a.source.connector, id: t.id, displayId: t.displayId, title: t.title, url: t.url }
    };
  }

  /** The account's 5h usage; unknown (null) when it can't be read, e.g. the account was removed (its launch says so). */
  private usageOf(a: Automation): number | null {
    try {
      return this.p.usage(a.claude.account);
    } catch {
      return null;
    }
  }

  private capInput(a: Automation): CapInput {
    const now = this.p.clock.now();
    const all = [...this.runs.values()].flat();
    const own = this.runs.get(a.id) ?? [];
    return {
      perAutomationActive: own.filter((r) => WORKING.has(r.state)).length,
      globalActive: all.filter((r) => WORKING.has(r.state)).length,
      todayCount: own.filter((r) => r.startedAt !== undefined && sameDay(r.startedAt, now)).length,
      usagePercent: this.usageOf(a),
      manual: false
    };
  }

  /** A new (or re-queued) run: started, queued or held by the limits. `fresh`: not in the list yet. */
  private async enqueue(a: Automation, run: Run, fresh: boolean): Promise<Run['state']> {
    const d = decide(a, this.p.settings(), this.capInput(a));
    const next: Run = d.kind === 'start' ? run
      : d.kind === 'queued' ? { ...run, state: 'queued', queued: d.reason, held: undefined }
      : { ...run, state: 'held', held: 'global', queued: undefined };
    if (fresh) this.add(a.id, next); else this.update(a.id, run.id, next);
    if (d.kind === 'start') await this.begin(a, next);
    return next.state;
  }

  /** Queued runs that may start now, oldest first (held ones wait for the user). */
  private processQueues(): void {
    if (this.p.settings().paused) return;
    for (const a of this.automations.values()) {
      if (!a.enabled) continue;
      for (const r of (this.runs.get(a.id) ?? []).filter((x) => x.state === 'queued').sort((x, y) => x.createdAt - y.createdAt)) {
        if (decide(a, this.p.settings(), this.capInput(a)).kind !== 'start') continue;
        void this.track(this.begin(a, r));
      }
    }
  }

  private async begin(a: Automation, run: Run, manual = false): Promise<void> {
    const now = this.p.clock.now();
    this.update(a.id, run.id, { state: 'starting', startedAt: now, queued: undefined, held: undefined, reason: undefined });
    let detail: TaskDetail | null;
    try {
      detail = await this.p.connector.detail(a.source.connector, run.task.id);
    } catch (e) {
      // Not read just now (offline, a 429, signed out): never "no longer available". A queued run waits for a later
      // read (no retry from here: that would loop while offline); one the user started stays as it was and says so.
      this.p.log(`automations: couldn't read ${run.task.displayId} to start it: ${(e as Error).message}`);
      // Turned off meanwhile: it leaves the queue like the others (a baseline Turn On must not start it).
      if (run.state === 'queued' && !this.automations.get(a.id)?.enabled) {
        this.update(a.id, run.id, { state: 'skipped', reason: 'Left the queue: the automation was turned off', startedAt: run.startedAt, queued: undefined });
        return;
      }
      const reason = run.state === 'queued' && !manual ? 'Atelier couldn\'t read the task just now: it tries again on the next read'
        : 'Atelier couldn\'t read the task just now: try again in a moment';
      this.update(a.id, run.id, { state: run.state, startedAt: run.startedAt, queued: run.queued, held: run.held, reason });
      return;
    }
    if (!detail) {
      this.update(a.id, run.id, { state: 'skipped', reason: 'The task is no longer available' });
      this.processQueues();
      return;
    }
    let r: LaunchResult;
    try {
      r = await this.p.launch(a, { ...run, state: 'starting', startedAt: now }, detail);
    } catch (e) {
      r = { ok: false, reason: `Couldn't start: ${(e as Error).message}` };
    }
    if (!r.ok) {
      this.say(a, `Couldn't start ${run.task.displayId}: ${r.reason}`);
      this.update(a.id, run.id, { state: 'failed', reason: r.reason, endedAt: this.p.clock.now(), ...(r.branch ? { branch: r.branch, worktree: r.worktree } : {}) });
      this.p.removeLaunchFiles(run.id);
      this.processQueues();
      return;
    }
    this.update(a.id, run.id, {
      terminalId: r.terminalId, ...(r.branch ? { branch: r.branch } : {}), ...(r.worktree ? { worktree: r.worktree } : {}), ...(r.note ? { reason: r.note } : {}),
      ...(r.base && r.baseOid ? { base: r.base, baseOid: r.baseOid } : {})
    });
    if (!this.p.launchFilesUntilEnd) this.cleanups.set(run.id, this.p.clock.setTimeout(() => this.cleanup(run.id), LAUNCH_FILES_MS));
    if (this.automations.has(a.id)) this.checkStartAt(run.id, START_LIMIT_MS);
  }

  private cleanup(runId: string): void {
    const h = this.cleanups.get(runId);
    if (h === undefined) return;
    this.p.clock.clearTimeout(h);
    this.cleanups.delete(runId);
    this.p.removeLaunchFiles(runId);
  }

  // ── Following the sessions ─────────────────────────────────────────────────────────────────────────────────────

  private follow(): void {
    if (this.p.sessions.ready && !this.p.sessions.ready()) return;
    const now = this.p.clock.now();
    const terms = new Map(this.p.sessions.terminals().map((t) => [t.id, t]));
    let freed = false;
    for (const [aid, runs] of this.runs) {
      for (const r of runs) {
        if (!r.terminalId || !FOLLOWED.has(r.state)) continue;
        const t = terms.get(r.terminalId);
        if (!t && r.state === 'starting' && this.relinked && now - (r.startedAt ?? 0) < START_GRACE_MS) continue;
        if (t?.session && this.cleanups.has(r.id)) this.cleanup(r.id);
        if (t?.session || r.state !== 'starting') this.dropStartCheck(r.id);
        const silent = r.state === 'starting' && t && !t.session && now - (r.startedAt ?? 0) >= START_LIMIT_MS;
        const next = silent ? { state: 'failed' as const, reason: SILENT } : runStateOf(t, r.state, r.state === 'stopped' ? r.endedAt : undefined);
        const cost = t?.session?.cost?.usd;
        const patch: Partial<Run> = {};
        if (next.state !== r.state) {
          patch.state = next.state;
          if (next.reason !== undefined) patch.reason = next.reason;
          if ((next.state === 'review' || !ACTIVE_STATES.has(next.state)) && r.endedAt === undefined) patch.endedAt = now;
          // Working again (resumed after Stop Run or a failure): no end time, so its duration and a later end are right.
          if (next.state !== 'review' && ACTIVE_STATES.has(next.state) && r.endedAt !== undefined) patch.endedAt = undefined;
          if (WORKING.has(r.state) && !WORKING.has(next.state)) freed = true;
        }
        if (typeof cost === 'number' && cost !== r.cost) patch.cost = cost;
        if (Object.keys(patch).length) this.update(aid, r.id, patch);
        const a = this.automations.get(aid);
        if (t && a?.claude.decideAlone && (patch.state ?? r.state) === 'review' && !r.decisions && !this.decisionsRead.has(r.id)) {
          this.decisionsRead.add(r.id);
          void this.track(this.p.decisions(a, r, t).then((d) => { if (d?.length) this.update(aid, r.id, { decisions: d }); }, () => {}));
        }
      }
    }
    this.relinked = true;
    if (freed) this.processQueues();
  }

  // ── State ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private status(a: Automation): AutomationStatus {
    const lastPollAt = this.seen.get(a.id)?.lastPollAt ?? null;
    if (!a.enabled) return { kind: 'off', lastPollAt, nextPollAt: null };
    if (this.p.settings().paused) return { kind: 'paused', reason: 'All automations are paused', lastPollAt, nextPollAt: null };
    const s = this.p.connector.status(a.source.connector);
    if (s !== 'connected') return { kind: 'paused', reason: pausedReason(a.source.connector, s), lastPollAt, nextPollAt: null };
    if (this.blocked(a)) return { kind: 'paused', reason: 'A service project needs Created by set to people you trust', lastPollAt, nextPollAt: null };
    return { kind: 'on', lastPollAt, nextPollAt: this.dueAt(a) };
  }

  private find(runId: string): { a: Automation; run: Run } | null {
    for (const [aid, runs] of this.runs) {
      const run = runs.find((r) => r.id === runId);
      const a = this.automations.get(aid);
      if (run && a) return { a, run };
    }
    return null;
  }

  private add(aid: string, run: Run): void {
    if (!this.automations.has(aid)) return;
    this.runs.set(aid, keepRuns([...(this.runs.get(aid) ?? []), run]));
    this.p.store.saveRuns(aid, this.runs.get(aid)!);
    this.p.changed();
  }

  private update(aid: string, runId: string, patch: Partial<Run>): void {
    if (!this.automations.has(aid)) return;
    const list = this.runs.get(aid) ?? [];
    const was = list.find((r) => r.id === runId);
    // Windows: a run that stops working (review, stopped…) no longer needs its task's file; a failed one keeps it (an
    // error may pass and the session go on) until Close Run or the next start.
    if (this.p.launchFilesUntilEnd && was && WORKING.has(was.state) && patch.state && !WORKING.has(patch.state) && patch.state !== 'failed') {
      this.p.removeLaunchFiles(runId);
    }
    this.runs.set(aid, list.map((r) => {
      if (r.id !== runId) return r;
      const next = { ...r, ...patch };
      for (const k of Object.keys(next) as (keyof Run)[]) if (next[k] === undefined) delete next[k];
      return next;
    }));
    this.p.store.saveRuns(aid, this.runs.get(aid)!);
    this.p.changed();
  }

  private persistAutomations(): void {
    this.p.store.saveAutomations([...this.automations.values()]);
    this.p.changed();
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p)).catch(() => {});
    return p;
  }
}
