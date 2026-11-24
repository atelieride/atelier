// A paired phone's requests for the project windows themselves: one opened as opening a recent project does (an open
// one comes to the front), one closed as its own close does. A close never asks anything on this computer: the busy
// sessions' question was the phone's user's to answer (or Atelier decides by itself, keeping busy ones running), and a
// window with unsaved files is refused, since its Save / Don't Save question would wait for someone here. Electron-free:
// index.ts gives it the windows, the close guard and the unsaved files the pages report.
import type { RemoteWindowResult } from './remote-hub';

/** How long a close waits for its window to be gone (its pop-outs closing first included). */
export const WINDOW_CLOSE_MS = 10_000;

export interface PhoneWindowsDeps<W> {
  /** The project's main window, or null while it is closed. */
  windowOf(root: string): W | null;
  /** Opens the project's window as opening a recent project does (an open one comes to the front); null when it can't. */
  open(root: string): W | null;
  isDir(root: string): boolean;
  /** Whether a window of the project, its pop-outs included, has unsaved files. */
  unsaved(root: string): boolean;
  /** The close decided away from the window (the busy sessions' answer, or none); false when it no longer holds. */
  decide(root: string, sessions?: 'keep' | 'stop'): Promise<boolean>;
  close(win: W): void;
  /** Calls `cb` once the window is gone; returns what stops listening. */
  whenClosed(win: W, cb: () => void): () => void;
  timeoutMs?: number;
}

const failed = (message: string): RemoteWindowResult => ({ ok: false, code: 'failed', message });

export class PhoneWindows<W> {
  private readonly timeoutMs: number;

  constructor(private readonly d: PhoneWindowsDeps<W>) {
    this.timeoutMs = d.timeoutMs ?? WINDOW_CLOSE_MS;
  }

  async open(root: string): Promise<RemoteWindowResult> {
    if (!this.d.isDir(root)) return failed('The project\'s folder isn\'t there any more.');
    return this.d.open(root) === null ? failed('The project\'s window could not be opened.') : { ok: true };
  }

  async close(root: string, sessions?: 'keep' | 'stop'): Promise<RemoteWindowResult> {
    if (this.d.windowOf(root) === null) return { ok: true };
    if (this.d.unsaved(root)) return { ok: false, code: 'invalid', message: 'It has unsaved files: save or close them on this computer first.' };
    const held = await this.d.decide(root, sessions);
    // Closed on this computer meanwhile: what the phone asked for is done.
    const win = this.d.windowOf(root);
    if (win === null) return { ok: true };
    if (!held) return failed('The window didn\'t close.');
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r: RemoteWindowResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(r);
      };
      // Held past the wait (a pop-out's own question, a page that never let go): the phone hears it didn't close.
      const timer = setTimeout(() => finish(failed('The window didn\'t close.')), this.timeoutMs);
      timer.unref?.();
      const off = this.d.whenClosed(win, () => finish({ ok: true }));
      this.d.close(win);
    });
  }
}
