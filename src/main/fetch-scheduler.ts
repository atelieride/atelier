import { AUTO_FETCH_INTERVAL_MS, type AutoFetch } from '@shared/settings';
import type { FetchOutcome, FetchReason, ScmFetchAnswer, ScmFetchState } from '@shared/scm';
import type { FetchResult } from './git/fetch';

/** The view gate: neither a fetch nor an attempt in the last 10 minutes. */
export const VIEW_GATE_MS = 10 * 60_000;
export const BUSY_RETRY_MS = 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;
export const FETCH_TICK_MS = 60_000;
/** Fetches at once app-wide: the ones asked by hand (Fetch All) may use every slot. */
export const MAX_FETCHES = 6;
/** Of those, automatic ones (view, periodic): fetches nobody is waiting for never crowd the network. */
export const MAX_AUTOMATIC_FETCHES = 2;

/** A working tree and its git common dir (a repo and its worktrees share one). */
export interface FetchRepo { root: string; common: string }

export interface FetchDeps {
  now(): number;
  /** `git fetch` in that root (git/fetch.ts), whose common dir is `common`. Never rejects. */
  run(root: string, common: string): Promise<FetchResult>;
  /** mtime of FETCH_HEAD in that common dir, null when never fetched. */
  fetchedAt(common: string): Promise<number | null>;
  hasRemote(root: string): Promise<boolean>;
  /** Whether the repo may be fetched on its own: its config names no program a fetch would run (git/fetch.ts). */
  autoAllowed(root: string): Promise<boolean>;
  setting(): AutoFetch;
  online(): boolean;
  /** Every repo of every open project (periodic fetches). */
  repos(): Promise<FetchRepo[]>;
  emit(state: ScmFetchState): void;
  /**
   * The git writes queue (git/write-queue.ts) that `run` goes through, when it does: a fetch waits for its common dir's
   * writes before it takes an app-wide slot, so a long write (slow hooks) never holds one up for other repos.
   */
  writes?: { busy(common: string): boolean; idle(common: string): Promise<void> };
}

type Why = FetchReason | 'periodic';

interface Rec {
  /** A fetch asked and not finished: gated, waiting for a slot or running. */
  job: Promise<FetchResult | null> | null;
  /** Past its gates: waiting for a slot or running (the UI shows it as running). */
  active: boolean;
  /** A manual request owns or joined the fetch in progress: it never gets dropped and always runs. */
  manual: boolean;
  /** No remote when last asked: not asked again before then. */
  noRemoteUntil: number;
  /**
   * Its config named a program (no automatic fetch) when last asked: not asked again before then — Changes asks on
   * every window focus, and each check is a `git config` read.
   */
  notAllowedUntil: number;
  lastAttempt: number | null;
  /** Automatic fetches wait until then (error backoff, busy retry). */
  notBefore: number;
  failures: number;
  authBlocked: boolean;
  last: ScmFetchState['last'];
}

/** What a slot was taken as: it is given back as that, even when a manual request joined its fetch since. */
type Slot = 'manual' | 'automatic';

interface Waiter { common: string; manual: boolean; go: (got: Slot | null) => void }

/**
 * When Source Control fetches: view fetches the renderer asks for, periodic ones from the setting,
 * manual ones always. One fetch per git common dir at a time; at most six app-wide, two of them automatic; manual
 * requests first.
 */
export class FetchScheduler {
  private recs = new Map<string, Rec>();
  private running = 0;
  private automatic = 0;
  private waiting: Waiter[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: FetchDeps) {}

  start(every = FETCH_TICK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, every);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  state(common: string): ScmFetchState {
    const r = this.recs.get(common);
    return { common, running: !!r?.active, last: r?.last ?? null };
  }

  /** A view or manual fetch of one repo. A manual one joins the repo's fetch in progress, if any. */
  async request(repo: FetchRepo, reason: FetchReason): Promise<ScmFetchAnswer> {
    const r = this.rec(repo.common);
    if (!r.job) return this.answer(repo.common, await this.schedule(repo, reason));
    if (reason !== 'manual') return this.answer(repo.common, null);
    // Joins it: the job can no longer be dropped; if its gates turned it down, the manual fetch runs on its own.
    r.manual = true;
    this.promote(repo.common);
    const res = await r.job;
    return res ? this.answer(repo.common, res) : this.request(repo, 'manual');
  }

  /** Manual fetch of every repo with a remote, once per common dir. */
  async fetchAll(repos: FetchRepo[]): Promise<FetchOutcome[]> {
    const seen = new Set<string>();
    const unique = repos.filter((x) => !seen.has(x.common) && seen.add(x.common));
    const withRemote = (await Promise.all(unique.map(async (x) => ((await this.deps.hasRemote(x.root).catch(() => false)) ? x : null)))).filter((x): x is FetchRepo => !!x);
    const answers = await Promise.all(withRemote.map((x) => this.request(x, 'manual')));
    return answers.map((a) => a.outcome).filter((o): o is FetchOutcome => o !== null);
  }

  /** Periodic fetches (settings 15m/30m/60m): every open repo past its interval. */
  async tick(): Promise<void> {
    const every = AUTO_FETCH_INTERVAL_MS[this.deps.setting()];
    if (!every || !this.deps.online()) return;
    const repos = await this.deps.repos().catch(() => []);
    const seen = new Set<string>();
    for (const repo of repos) {
      if (seen.has(repo.common)) continue;
      seen.add(repo.common);
      if (!this.rec(repo.common).job) this.schedule(repo, 'periodic').catch(() => {});
    }
  }

  /** The setting changed: automatic fetches still waiting for a slot are dropped when off (checked as they start). */
  settingsChanged(): void {
    if (this.deps.setting() !== 'off') return;
    for (const w of [...this.waiting]) if (!w.manual) { this.waiting.splice(this.waiting.indexOf(w), 1); w.go(null); }
  }

  private rec(common: string): Rec {
    let r = this.recs.get(common);
    if (!r) { r = { job: null, active: false, manual: false, noRemoteUntil: 0, notAllowedUntil: 0, lastAttempt: null, notBefore: 0, failures: 0, authBlocked: false, last: null }; this.recs.set(common, r); }
    return r;
  }

  private answer(common: string, res: FetchResult | null): ScmFetchAnswer {
    return { state: this.state(common), outcome: res?.outcome ?? null, ...(res?.message ? { message: res.message } : {}) };
  }

  private schedule(repo: FetchRepo, why: Why): Promise<FetchResult | null> {
    const r = this.rec(repo.common);
    r.manual = why === 'manual';
    const job = (async () => {
      if (!r.manual && !(await this.due(repo, why))) return null;
      r.active = true;
      this.deps.emit(this.state(repo.common));
      for (;;) {
        // No slot is held while the common dir's writes run (a long commit hook would starve other repos' fetches).
        await this.deps.writes?.idle(repo.common);
        const got = await this.slot(repo.common, r.manual);
        // Switched off while waiting: an automatic fetch nobody asked for by hand never starts.
        if (!got || (!r.manual && this.deps.setting() === 'off')) {
          if (got) this.release(got);
          r.active = false;
          this.deps.emit(this.state(repo.common));
          return null;
        }
        // Checked in the same step that starts `run` (and its place in the queue): nothing can get ahead in between.
        if (!this.deps.writes?.busy(repo.common)) return this.run(repo, r, got);
        // A write was asked while this fetch waited for its slot: the slot goes on, the fetch waits for the write.
        this.release(got);
      }
    })().finally(() => { if (r.job === job) { r.job = null; r.manual = false; } });
    r.job = job;
    return job;
  }

  private async due(repo: FetchRepo, why: Why): Promise<boolean> {
    const setting = this.deps.setting();
    if (setting === 'off') return false;
    const gate = why === 'periodic' ? AUTO_FETCH_INTERVAL_MS[setting] : VIEW_GATE_MS;
    if (!gate) return false;
    const r = this.rec(repo.common);
    const now = this.deps.now();
    const fetched = await this.deps.fetchedAt(repo.common).catch(() => null);
    // Fetched elsewhere (a terminal) after Atelier's auth failure: whatever was wrong is fixed.
    if (r.authBlocked && fetched !== null && r.last && fetched > r.last.at) r.authBlocked = false;
    if (r.authBlocked || now < r.notBefore) return false;
    if (r.lastAttempt !== null && now - r.lastAttempt < gate) return false;
    if (fetched !== null && now - fetched < gate) return false;
    if (now < r.noRemoteUntil || now < r.notAllowedUntil) return false;
    if (!(await this.deps.hasRemote(repo.root).catch(() => false))) { r.noRemoteUntil = now + VIEW_GATE_MS; return false; }
    if (await this.deps.autoAllowed(repo.root).catch(() => false)) return true;
    r.notAllowedUntil = now + VIEW_GATE_MS;
    return false;
  }

  /** Whether a fetch of that kind may start now. */
  private fits(manual: boolean): boolean {
    return this.running < MAX_FETCHES && (manual || this.automatic < MAX_AUTOMATIC_FETCHES);
  }

  private take(manual: boolean): Slot {
    this.running++;
    if (manual) return 'manual';
    this.automatic++;
    return 'automatic';
  }

  /** The slot once taken (manual requests first; the caller releases it), null when dropped while waiting. */
  private slot(common: string, manual: boolean): Promise<Slot | null> {
    if (this.fits(manual)) return Promise.resolve(this.take(manual));
    return new Promise((resolve) => {
      const w: Waiter = { common, manual, go: (got) => resolve(got) };
      if (manual) {
        const firstAuto = this.waiting.findIndex((x) => !x.manual);
        this.waiting.splice(firstAuto === -1 ? this.waiting.length : firstAuto, 0, w);
      } else this.waiting.push(w);
    });
  }

  /** A slot is freed and handed at once to the waiters that fit now (in the same step: nothing gets ahead of them). */
  private release(slot: Slot): void {
    this.running--;
    if (slot === 'automatic') this.automatic--;
    this.pump();
  }

  /** Waiters start in their order while they fit: manual ones first, automatic ones below MAX_AUTOMATIC_FETCHES. */
  private pump(): void {
    for (let i = this.waiting.findIndex((w) => this.fits(w.manual)); i >= 0; i = this.waiting.findIndex((w) => this.fits(w.manual))) {
      const [w] = this.waiting.splice(i, 1);
      w!.go(this.take(w!.manual));
    }
  }

  /** A manual request for a repo whose automatic fetch is still waiting: it moves to the front, and starts if it fits. */
  private promote(common: string): void {
    const i = this.waiting.findIndex((w) => w.common === common);
    if (i < 0) return;
    const [w] = this.waiting.splice(i, 1);
    w!.manual = true;
    const firstAuto = this.waiting.findIndex((x) => !x.manual);
    this.waiting.splice(firstAuto === -1 ? this.waiting.length : firstAuto, 0, w!);
    this.pump();
  }

  private async run(repo: FetchRepo, r: Rec, slot: Slot): Promise<FetchResult> {
    const res = await this.deps.run(repo.root, repo.common).catch((err: Error): FetchResult => ({ outcome: 'error', message: err.message }));
    const at = this.deps.now();
    this.release(slot);
    r.active = false;
    switch (res.outcome) {
      case 'ok':
        Object.assign(r, { lastAttempt: at, notBefore: 0, failures: 0, authBlocked: false, last: { outcome: 'ok', at } });
        break;
      case 'auth':
        Object.assign(r, { lastAttempt: at, authBlocked: true, last: { outcome: 'auth', at, ...(res.message ? { message: res.message } : {}) } });
        break;
      case 'error':
        r.failures++;
        Object.assign(r, { lastAttempt: at, notBefore: at + Math.min(VIEW_GATE_MS * 2 ** (r.failures - 1), BACKOFF_MAX_MS), last: { outcome: 'error', at, ...(res.message ? { message: res.message } : {}) } });
        break;
      case 'busy':
        // Not an attempt that counts: another git command held a lock. Tried again a minute later.
        r.notBefore = Math.max(r.notBefore, at + BUSY_RETRY_MS);
        break;
      case 'network':
        r.lastAttempt = at;
        break;
    }
    this.deps.emit(this.state(repo.common));
    return res;
  }
}
