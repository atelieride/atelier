// A paired phone's changes to a project's workspaces and activities, carried to the project's main window, which
// applies them as its own menus and drags would (workspaces live in the window). A closed window is opened first, as
// opening a recent project does; a change waits until the window's page listens (its store has its project, its
// saved tabs and atelierd's list), then goes; the window answers with how it went. No answer in time, a page that
// reloads with the change in hand, or a window that closes: `failed`.
import type { RemotePlaceOp, RemotePlaceRequest, RemotePlaceResult } from '@shared/remote';

/** How long a change waits for its window's answer, the window's opening and loading included. */
export const PLACES_TIMEOUT_MS = 10_000;

export interface PlaceWindows {
  /** The project's main window (its webContents id), or null while it is closed. */
  windowOf(root: string): number | null;
  /** Opens the project's window as opening a recent project does: its webContents id, or null when it can't. */
  open(root: string): number | null;
  /** A change to the window's page. */
  send(wcId: number, req: RemotePlaceRequest): void;
  timeoutMs?: number;
}

interface Pending {
  wcId: number;
  /** Handed to the page (its outcome is the page's), or still held for it. */
  sent: boolean;
  resolve(r: RemotePlaceResult): void;
  timer: ReturnType<typeof setTimeout>;
}

const failed = (message: string): RemotePlaceResult => ({ ok: false, code: 'failed', message });

export class PlaceRequests {
  private seq = 0;
  /** Windows whose page listens now (since it last loaded). */
  private readonly ready = new Set<number>();
  private readonly pending = new Map<number, Pending>();
  private readonly held = new Map<number, RemotePlaceRequest[]>();
  private readonly timeoutMs: number;

  constructor(private readonly w: PlaceWindows) {
    this.timeoutMs = w.timeoutMs ?? PLACES_TIMEOUT_MS;
  }

  /** Applies a change in the project's window, opening it when it is closed: the window's answer. */
  apply(root: string, op: RemotePlaceOp): Promise<RemotePlaceResult> {
    const wcId = this.w.windowOf(root) ?? this.w.open(root);
    if (wcId === null) return Promise.resolve(failed('The project could not be opened.'));
    const req: RemotePlaceRequest = { id: ++this.seq, op };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(req.id, failed('The project\'s window did not answer in time.')), this.timeoutMs);
      timer.unref?.();
      const p: Pending = { wcId, sent: false, resolve, timer };
      this.pending.set(req.id, p);
      if (this.ready.has(wcId)) this.hand(p, req);
      else this.held.set(wcId, [...(this.held.get(wcId) ?? []), req]);
    });
  }

  /** The window's page listens now: the changes that waited for it, in order (and later ones go at once). */
  takeHeld(wcId: number): RemotePlaceRequest[] {
    this.ready.add(wcId);
    const list = (this.held.get(wcId) ?? []).filter((r) => this.pending.has(r.id));
    this.held.delete(wcId);
    for (const r of list) this.pending.get(r.id)!.sent = true;
    return list;
  }

  /** The window's answer to a change it was given; false when it is no change of that window's, or one answered. */
  done(wcId: number, id: number, result: RemotePlaceResult): boolean {
    const p = this.pending.get(id);
    if (!p || p.wcId !== wcId || !p.sent) return false;
    this.settle(id, result);
    return true;
  }

  /** The page (re)loads: what it was given has an unknown outcome (failed); what wasn't sent waits for the new page. */
  pageLoading(wcId: number): void {
    this.ready.delete(wcId);
    for (const [id, p] of [...this.pending]) if (p.wcId === wcId && p.sent) this.settle(id, failed('The project\'s window reloaded.'));
  }

  /** The window closed: everything it had or waited for fails now. */
  closed(wcId: number): void {
    this.ready.delete(wcId);
    this.held.delete(wcId);
    for (const [id, p] of [...this.pending]) if (p.wcId === wcId) this.settle(id, failed('The project\'s window closed.'));
  }

  private hand(p: Pending, req: RemotePlaceRequest): void {
    p.sent = true;
    this.w.send(p.wcId, req);
  }

  private settle(id: number, r: RemotePlaceResult): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    const held = this.held.get(p.wcId);
    if (held) {
      const rest = held.filter((x) => x.id !== id);
      if (rest.length) this.held.set(p.wcId, rest); else this.held.delete(p.wcId);
    }
    p.resolve(r);
  }
}
