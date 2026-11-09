// A project window closing, or Atelier quitting, stops what runs in it: asked
// first when something is busy, applied only once the window is really gone, so a later Cancel (unsaved files,
// a pop-out) stops nothing. Electron-free: index.ts wires it to the windows, the ask broker and TerminalHub.
import { closeSessionsAsk, type CloseMode, type CloseSessionsAsk, type ProjectBusy } from '@shared/close-sessions';

export type CloseAnswer = 'cancel' | 'keep' | 'stop';
type Decision = 'keep' | 'stop';

export interface CloseGuardDeps<W> {
  /** The mode in force (setting, atelierd's capability, test override). */
  mode(): CloseMode;
  /** The projects' terminals as a close sees them. */
  busy(roots: string[]): Promise<ProjectBusy[]>;
  /** The question, in `win` (null: the front window); the native dialog when no page can answer. */
  ask(win: W | null, request: CloseSessionsAsk): Promise<CloseAnswer>;
  /** Stops every terminal of the project (Claude sessions come back under Resume). */
  stop(root: string): Promise<void>;
  log?(message: string): void;
  /** Epoch ms (tests); Date.now by default. */
  now?(): number;
}

export class CloseGuard<W> {
  private readonly decided = new Map<string, Decision>();
  private readonly asking = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  /** A close's question being prepared or asked, per root: a later `onClosed` makes its answer stale. */
  private readonly generation = new Map<string, number>();
  private quitAsk: Promise<boolean> | null = null;
  private keepUntil = 0;

  constructor(private readonly deps: CloseGuardDeps<W>) {}

  /**
   * An update's restart or an OS shutdown: for `ms` every close and quit keeps everything, however it goes
   * (unsaved files close the windows one by one, or resume the quit later).
   */
  keepFor(ms: number): void {
    this.keepUntil = Math.max(this.keepUntil, this.now() + ms);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private mode(): CloseMode {
    return this.now() < this.keepUntil ? 'keep' : this.deps.mode();
  }

  /**
   * A project window's `close`. True: let it close now. False: held (the caller prevents it); `reclose` is called once
   * decided to go on, never after a Cancel.
   */
  onClose(root: string, win: W, reclose: () => void): boolean {
    if (this.decided.has(root)) return true;
    if (this.asking.has(root)) return false;
    const mode = this.mode();
    if (mode !== 'ask') { this.decided.set(root, mode); return true; }
    this.asking.add(root);
    const gen = (this.generation.get(root) ?? 0) + 1;
    this.generation.set(root, gen);
    void this.decideClose(root, win).then((d) => {
      // The window went meanwhile (a quit closed it): its answer must not outlive it.
      if (this.generation.get(root) !== gen) return;
      this.asking.delete(root);
      if (!d) return;
      this.decided.set(root, d);
      reclose();
    });
    return false;
  }

  private async decideClose(root: string, win: W): Promise<Decision | null> {
    let list: ProjectBusy[];
    try { list = await this.deps.busy([root]); } catch (err) {
      // Nothing known to be busy, nothing known to be idle: nothing is risked.
      this.deps.log?.(`close: busy read failed, kept running: ${String(err)}`);
      return 'keep';
    }
    if (list.every((p) => p.busy.length === 0)) return 'stop';
    const answer = await this.deps.ask(win, closeSessionsAsk('close', list));
    return answer === 'cancel' ? null : answer;
  }

  /** The window is gone: its decision is applied (stop → its terminals stop) and forgotten. */
  onClosed(root: string): void {
    const d = this.decided.get(root);
    this.decided.delete(root);
    this.asking.delete(root);
    this.generation.set(root, (this.generation.get(root) ?? 0) + 1);
    if (d !== 'stop') return;
    const p = this.deps.stop(root).catch((err: unknown) => { this.deps.log?.(`close: stopping ${root} failed: ${String(err)}`); });
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** A later step called the close off (unsaved files, a pop-out): the answer is forgotten, the next close asks again. */
  forget(root: string): void {
    this.decided.delete(root);
  }

  /** A quit called off: every remembered answer goes. */
  forgetAll(): void {
    this.decided.clear();
  }

  /** Quitting: one question for every project window. False: cancelled (the quit is called off). A second quit while
   * the first one asks gets the same answer. */
  decideQuit(roots: string[], win: W | null): Promise<boolean> {
    if (this.quitAsk) return this.quitAsk;
    const asked = this.decideQuitNow(roots, win).finally(() => { if (this.quitAsk === asked) this.quitAsk = null; });
    this.quitAsk = asked;
    return asked;
  }

  private async decideQuitNow(roots: string[], win: W | null): Promise<boolean> {
    const mode = this.mode();
    if (mode !== 'ask' || roots.length === 0) { this.decideAll(roots, mode === 'ask' ? 'stop' : mode); return true; }
    let list: ProjectBusy[];
    try { list = await this.deps.busy(roots); } catch (err) {
      this.deps.log?.(`quit: busy read failed, kept running: ${String(err)}`);
      this.decideAll(roots, 'keep');
      return true;
    }
    if (list.every((p) => p.busy.length === 0)) { this.decideAll(roots, 'stop'); return true; }
    const answer = await this.deps.ask(win, closeSessionsAsk('quit', list));
    if (answer === 'cancel') return false;
    this.decideAll(roots, answer);
    return true;
  }

  /** An update's restart, an OS shutdown: everything keeps running, nothing is asked. */
  keepAll(roots: string[]): void {
    this.decideAll(roots, 'keep');
  }

  private decideAll(roots: string[], d: Decision): void {
    for (const r of roots) this.decided.set(r, d);
  }

  /** Stop requests still on their way to atelierd. */
  hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** Waits for them (the quit), at most `ms`. */
  async settle(ms: number): Promise<void> {
    if (this.pending.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...this.pending]), new Promise<void>((r) => { timer = setTimeout(r, ms); })]);
    if (timer) clearTimeout(timer);
  }
}
