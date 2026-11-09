import { NO_IDENTITY, parseCheck, parseHelperError, parseUpdateLine, storeDecision, type StoreCheck } from '@shared/store-updates';
import type { UpdatePhase, UpdateStatus } from '@shared/update-feed';

// Windows: the Microsoft Store's updates inside Atelier. atelier-store.exe asks
// the Store (store-exec.ts runs it); this decides what Settings › About and the footer show. A newer version Windows
// has registered is "ready": Restart quits and Windows starts the registered version (updates-ipc.ts).

/** How a run of atelier-store ended: its exit code (null when it was stopped: timeout, output cap) and its output. */
export interface StoreRun { code: number | null; out: string }

export interface StoreRunner {
  check(): Promise<StoreRun>;
  /** Download and install; each output line as it arrives. */
  update(onLine: (line: string) => void): Promise<StoreRun>;
}

export interface StoreUpdaterDeps {
  /** The running version (package.json's). */
  version: string;
  /** Windows' build number (os.release()); null when unknown. */
  build: number | null;
  /** Null without atelier-store.exe (dev runs): no Store updates. */
  runner: StoreRunner | null;
  now(): number;
  log(message: string): void;
  onStatus(s: UpdateStatus): void;
}

const failure = (r: StoreRun): string => {
  const e = parseHelperError(r.out);
  if (e) return `error ${e.hresult}${e.message ? ` ${e.message}` : ''}`;
  return r.code === null ? 'no answer' : 'unexpected output';
};

export class StoreUpdater {
  private phase: UpdatePhase = { kind: 'idle' };
  private lastCheck: number | null = null;
  private available: boolean;
  private busy = false;
  private familyName: string | null = null;

  constructor(private readonly o: StoreUpdaterDeps) {
    this.available = o.runner !== null;
  }

  status(): UpdateStatus {
    return { available: this.available, buildChannel: null, channel: null, version: this.o.version, lastCheck: this.lastCheck, phase: this.phase, currentNotes: null };
  }

  ready(): boolean { return this.phase.kind === 'ready'; }

  /** The package family the Restart activates (from the last check). */
  family(): string | null { return this.familyName; }

  private set(phase: UpdatePhase): void { this.phase = phase; this.o.onStatus(this.status()); }

  /** One check at a time; a ready update stays ready until the restart. */
  async check(): Promise<void> {
    const runner = this.o.runner;
    if (!runner || !this.available || this.busy || this.phase.kind === 'ready') return;
    this.busy = true;
    try {
      this.set({ kind: 'checking' });
      const c = await this.ask(runner);
      if (!c) return;
      const d = storeDecision(c, { running: this.o.version, build: this.o.build });
      if (d.kind !== 'download') { this.settle(d); return; }
      await this.install(runner);
    } finally {
      this.busy = false;
    }
  }

  /** The check's findings, or null once the phase says why there are none. */
  private async ask(runner: StoreRunner): Promise<StoreCheck | null> {
    // A runner that throws (a spawn Windows refuses) is a run without answer, never a phase left on "checking".
    const r = await runner.check().catch((): StoreRun => ({ code: null, out: '' }));
    this.lastCheck = this.o.now();
    const c = r.code === 0 ? parseCheck(r.out) : null;
    if (c) { this.familyName = c.family; return c; }
    if (parseHelperError(r.out)?.hresult === NO_IDENTITY) {
      // A dev run or an unpacked build: the Store has nothing to say to it, now or later.
      this.available = false;
      this.set({ kind: 'idle' });
      return null;
    }
    const message = failure(r);
    this.o.log(`store check failed: ${message}`);
    this.set({ kind: 'error', error: 'store', message });
    return null;
  }

  private settle(d: Exclude<ReturnType<typeof storeDecision>, { kind: 'download' }>): void {
    if (d.kind === 'ready') this.set({ kind: 'ready', version: d.version, notes: '' });
    else this.set(d);
  }

  private async install(runner: StoreRunner): Promise<void> {
    this.set({ kind: 'downloading', version: '', received: 0, total: 100 });
    let done: string | null = null;
    const r = await runner.update((line) => {
      const l = parseUpdateLine(line);
      if (l?.kind === 'progress') this.set({ kind: 'downloading', version: '', received: Math.round(l.value * 100), total: 100 });
      else if (l?.kind === 'done') done = l.result;
    }).catch((): StoreRun => ({ code: null, out: '' }));
    if (done !== 'completed' && done !== 'none') {
      const message = done ?? failure(r);
      this.o.log(`store update failed: ${message}`);
      this.set({ kind: 'error', error: 'store-download', message });
      return;
    }
    this.o.log(`store update ${done}`);
    const c = await this.ask(runner);
    if (!c) return;
    const d = storeDecision(c, { running: this.o.version, build: this.o.build });
    if (d.kind === 'ready') { this.settle(d); return; }
    // Installed, yet nothing newer registered: with Atelier running, UpdateWhileInUse=defer stages the new version and
    // Windows registers it when the app next starts through its package (the packaged runs on the test PC); the Store may
    // keep listing it meanwhile. Ready, by a version nothing readable without admin rights names.
    if (done === 'completed') {
      this.o.log('store update staged: Windows registers it at the next start');
      this.set({ kind: 'ready', version: '', notes: '' });
      return;
    }
    // Nothing to install, yet the Store still lists an update: an error the next check retries, never "up to date", and
    // never a second download in the same check.
    if (d.kind === 'download') {
      this.set({ kind: 'error', error: 'store-download', message: 'error' });
      return;
    }
    this.settle(d);
  }
}

/** How long a Restart waits for the quit it asked for (unsaved files may take a while; macOS's helper waits as long). */
const RELAUNCH_WINDOW = 120_000;

/**
 * Restart: what Windows starts once Atelier has exited — the package's app by its family name, so the registered (new)
 * version starts, never the old folder's exe. Armed for a while only, taken once.
 */
export class RelaunchArm {
  private family: string | null = null;
  private until = 0;

  arm(family: string, now: number): void { this.family = family; this.until = now + RELAUNCH_WINDOW; }

  /** The quit was called off (a Cancel over unsaved files): a later quit is an ordinary one. */
  disarm(): void { this.family = null; }

  take(now: number): string | null {
    const f = this.family;
    this.family = null;
    return f && now <= this.until ? `shell:AppsFolder\\${f}!Atelier` : null;
  }
}
