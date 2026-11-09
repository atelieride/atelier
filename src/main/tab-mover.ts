// Moving a file, a plain terminal or a table tab to another project's window:
// checks what the source may send, grants an outside file for the target (as the source has
// it), gives a terminal its new home, asks the target window to adopt the tab and closes a pop-out source once it did.
// No Electron here: windows, grants, terminals and connections are deps.
import { IPC } from '@shared/api';
import type { DbScope } from '@shared/databases';
import { isAbsPath } from '@shared/paths';
import type { AdoptAnswer, AdoptRequest, MoveRequest, MoveResult, PopoutPayload } from '@shared/popout';
import { isDbTabKey } from '@shared/tabs-state';

/** A target window that never answers: the move fails and the source keeps everything. */
export const ADOPT_TIMEOUT_MS = 3000;
/** The target may take the tab only this long after it was asked (its deadline): never once the source gave up. */
export const ADOPT_WINDOW_MS = 2500;

/** Where a move comes from: a project window or one of its pop-outs (its webContents id), and its project. */
export interface MoveSource { wcId: number; root: string; popout: boolean }
export interface MoverWindow { id: number; send(channel: string, payload?: unknown): void; reveal(): void }
type GrantMode = 'edit' | 'read';

export interface MoverDeps {
  /** The project's main window (never a pop-out or the welcome window), null when it has none. */
  projectWindow(root: string): MoverWindow | null;
  inside(root: string, path: string): boolean;
  /** How an outside file is granted to the project (null: it isn't). */
  grantMode(root: string, path: string): GrantMode | null;
  /** Granted for that project (in that mode) and watched like any outside file it shows; false when it can't be. */
  grant(root: string, path: string, mode: GrantMode): boolean;
  /** A grant made for a move that didn't happen: gone again. */
  revoke(root: string, path: string): void;
  /** The path as the project's tabs name it: relative inside it, else absolute. */
  relOf(root: string, path: string): string;
  /** A terminal as windows see it now (moved ones with their new project), null when atelierd doesn't list it. */
  terminal(id: string): { projectRoot: string; session: unknown } | null;
  /** The terminal belongs to `to` now (it was `from`'s): its home saved, the lists sent again, `from`'s watchers dropped. */
  rehome(id: string, from: string, to: string): void;
  /** The key the pop-out with this webContents holds; closing it for good (no dock, no question); holding it still
   *  (no Move Back, close or drag) while the target decides. */
  popoutKey(wcId: number): string | null;
  closePopout(wcId: number): void;
  holdPopout(wcId: number, on: boolean): void;
  /** The project's tab lives in one of its pop-outs now (its buffer is there: only that window may send it). */
  poppedOut(root: string, key: string): boolean;
  setTimer(fn: () => void, ms: number): { clear(): void };
  /** Which projects a database connection shows in, null when main has none by that id. Absent: table tabs never move. */
  dbScope?(connId: string): DbScope | null;
}

type Answer = Omit<AdoptAnswer, 'id'>;
const FAILED: MoveResult = { ok: false, reason: 'failed' };

export class TabMover {
  private seq = 0;
  private readonly pending = new Map<number, { win: number; done(a: Answer): void }>();

  constructor(private readonly d: MoverDeps) {}

  /** What a drag may offer that window (the move's own checks, nothing asked or changed). */
  canMove(from: string, key: string, to: string): boolean {
    return this.check(from, key, to) === null;
  }

  async move(from: MoveSource, r: MoveRequest): Promise<MoveResult> {
    const bad = this.check(from.root, r.key, r.to);
    if (bad) return bad;
    if (from.popout ? this.d.popoutKey(from.wcId) !== r.key : this.d.poppedOut(from.root, r.key)) return FAILED;
    const target = this.d.projectWindow(r.to)!;
    const at = r.at ? { at: r.at } : {};
    if (from.popout) this.d.holdPopout(from.wcId, true);
    try {
      if (r.key.startsWith('f:')) {
        const path = r.key.slice(2);
        // Granted as the source has it (a read-only temp file stays read-only); not again when the target has it already,
        // unless only read-only while the source may edit it: the buffer (maybe with edits) stays editable.
        const mode: GrantMode = this.d.inside(from.root, path) ? 'edit' : this.d.grantMode(from.root, path)!;
        const had = this.d.inside(r.to, path) ? 'edit' : this.d.grantMode(r.to, path);
        const granting = had === null || (had === 'read' && mode === 'edit');
        if (granting && !this.d.grant(r.to, path, mode)) return FAILED;
        const payload: PopoutPayload = { kind: 'file', rel: this.d.relOf(r.to, path), mode: r.payload?.kind === 'file' ? r.payload.mode : 'margin' };
        const answer = await this.ask(target, { key: r.key, payload, ...(r.handoff ? { handoff: r.handoff } : {}), ...at });
        if (!answer.ok) {
          // The grant made for the move goes; one the target had before comes back as it was.
          if (granting) { this.d.revoke(r.to, path); if (had) this.d.grant(r.to, path, had); }
          return { ok: false, reason: answer.reason === 'open-there' ? 'refused' : 'failed' };
        }
      } else if (r.key.startsWith('db:')) {
        // A table tab: nothing to grant or rehome (the connection shows in both projects, check() said so); B opens it
        // from its payload, the window leaving it drops it once B said yes.
        if (r.payload?.kind !== 'db') return FAILED;
        const answer = await this.ask(target, { key: r.key, payload: r.payload, ...at });
        if (!answer.ok) return FAILED;
      } else {
        // The lists go out first (the source loses it, the target has it), then the target places it where it was
        // dropped; a target that didn't take it gives it back.
        const id = r.key.slice(2);
        this.d.rehome(id, from.root, r.to);
        const answer = await this.ask(target, { key: r.key, ...at });
        if (!answer.ok) { this.d.rehome(id, r.to, from.root); return FAILED; }
      }
    } finally {
      if (from.popout) this.d.holdPopout(from.wcId, false);
    }
    if (from.popout) this.d.closePopout(from.wcId);
    target.reveal();
    return { ok: true };
  }

  /** The target window's answer (only that window's, only once). */
  adopted(wcId: number, a: AdoptAnswer): void {
    const p = this.pending.get(a.id);
    if (!p || p.win !== wcId) return;
    p.done({ ok: a.ok, ...(a.reason ? { reason: a.reason } : {}) });
  }

  /** null when the tab may go to that window; else the refusal. */
  private check(from: string, key: string, to: string): MoveResult | null {
    if (to === from || !this.d.projectWindow(to)) return FAILED;
    if (key.startsWith('f:')) {
      // A file on disk the source may read (never an untitled buffer, never a path the page just names).
      const path = key.slice(2);
      return isAbsPath(path) && (this.d.inside(from, path) || this.d.grantMode(from, path) !== null) ? null : FAILED;
    }
    if (key.startsWith('t:') && key.length > 2) {
      const t = this.d.terminal(key.slice(2));
      if (!t || t.projectRoot !== from) return FAILED;
      return t.session ? { ok: false, reason: 'session' } : null;
    }
    if (isDbTabKey(key)) {
      // A table tab goes only where its connection shows too: one shown in every project.
      const scope = this.d.dbScope?.(key.slice(3).split('/')[0]!) ?? null;
      const sees = (root: string) => scope !== null && (scope.kind === 'all' || scope.root === root);
      return sees(from) && sees(to) ? null : FAILED;
    }
    return FAILED;
  }

  private ask(win: MoverWindow, r: Omit<AdoptRequest, 'id' | 'deadline'>): Promise<Answer> {
    const id = ++this.seq;
    return new Promise<Answer>((resolve) => {
      const timer = this.d.setTimer(() => done({ ok: false }), ADOPT_TIMEOUT_MS);
      const done = (a: Answer) => {
        if (!this.pending.delete(id)) return;
        timer.clear();
        resolve(a);
      };
      this.pending.set(id, { win: win.id, done });
      win.send(IPC.evAdopt, { id, ...r, deadline: Date.now() + ADOPT_WINDOW_MS } satisfies AdoptRequest);
    });
  }
}
