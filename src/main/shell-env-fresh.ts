// Shell environment auto-reload: before a new Atelier-profile terminal,
// atelierd's capture of the user's zsh is reloaded when one of their zsh files changed after it. Checked on demand,
// never watched: nothing runs while nobody opens a terminal.
import path from 'node:path';
import type { TerminalProfile } from '@shared/protocol';

/** What identifies a file's version: a save changes at least one (an atomic save the inode). */
export interface FileStamp { mtimeMs: number; size: number; ino: number }

/** The startup files zsh reads, in its order: in ZDOTDIR when set, else in the home folder. */
export function zshStartupFiles(home: string, zdotdir: string | undefined): string[] {
  const dir = zdotdir || home;
  return ['.zshenv', '.zprofile', '.zshrc', '.zlogin'].map((f) => path.join(dir, f));
}

/** The files checked: zsh's own, then the user's extra ones, without duplicates. */
export function checkedFiles(builtin: readonly string[], extra: readonly string[]): string[] {
  return [...new Set([...builtin, ...extra])];
}

/** Only Atelier-profile terminals use atelierd's capture; undefined profile = an atelierd older than profiles. */
export function checkApplies(profile: TerminalProfile | undefined, enabled: boolean, connected: boolean): boolean {
  return profile === 'atelier' && enabled && connected;
}

export interface FreshnessDeps {
  /** A file's stamp, null when missing (or unreadable). Async: a picked file may sit on a slow volume. */
  stat(p: string): Promise<FileStamp | null> | FileStamp | null;
  /** atelierd's reloadEnv; rejects when the capture fails. */
  reload(): Promise<void>;
  /** When atelierd's capture in use was taken (undefined: none yet, or capture off). */
  capturedAt(): number | undefined;
}

export interface FreshnessEvents {
  /** A reload starts (or is already running, for a terminal that joins it), for these changed files. */
  reloading(files: string[]): void;
  failed(error: string): void;
}

const key = (s: FileStamp | null) => (s ? `${s.mtimeMs}:${s.size}:${s.ino}` : 'missing');

export class ShellEnvFreshness {
  /** The files' stamps when the last reload of ours started, valid while atelierd still uses that capture. */
  private baseline: { stamps: Map<string, string>; capturedAt: number | undefined } | null = null;
  /** The stamps a reload failed with: no retry until a file changes. */
  private failedWith: string | null = null;
  /** The reload under way: what changed, and every window waiting for it (all hear of a failure). */
  private running: { done: Promise<void>; files: string[]; waiting: FreshnessEvents[] } | null = null;

  constructor(private readonly deps: FreshnessDeps) {}

  /** Resolves once the environment is fresh, or a reload failed (the terminal opens with the earlier capture). */
  async ensure(files: readonly string[], on: FreshnessEvents): Promise<void> {
    if (this.running) return this.join(on);
    const capturedAt = this.deps.capturedAt();
    if (capturedAt === undefined) return;
    const now = new Map(await Promise.all(files.map(async (f) => [f, await this.deps.stat(f)] as const)));
    // Another terminal started a reload while the files were read: wait for that one.
    if (this.running) return this.join(on);
    const stamps = new Map([...now].map(([f, s]) => [f, key(s)]));
    const changed = this.changed(now, capturedAt);
    if (changed.length === 0) return;
    const all = [...stamps].map(([f, k]) => `${f}\u0000${k}`).join('\u0000');
    if (all === this.failedWith) return;
    on.reloading(changed);
    const waiting = [on];
    const done = this.deps.reload().then(() => {
      this.failedWith = null;
      this.baseline = { stamps, capturedAt: this.deps.capturedAt() };
    }, (err: Error) => {
      this.failedWith = all;
      for (const w of waiting) w.failed(err.message);
    }).finally(() => { this.running = null; });
    this.running = { done, files: changed, waiting };
    return done;
  }

  /** Another terminal waits for the reload under way, and is told like the first one. */
  private join(on: FreshnessEvents): Promise<void> {
    const r = this.running!;
    r.waiting.push(on);
    on.reloading(r.files);
    return r.done;
  }

  /**
   * The files changed since the capture: against our last reload's stamps while atelierd still uses that capture
   * (deletions and saves landing during the capture included), else (first check, or a capture taken elsewhere) by
   * an mtime newer than the capture.
   */
  private changed(now: Map<string, FileStamp | null>, capturedAt: number): string[] {
    const base = this.baseline && this.baseline.capturedAt === capturedAt ? this.baseline.stamps : null;
    const out: string[] = [];
    for (const [f, s] of now) {
      const before = base?.get(f);
      if (before !== undefined) { if (before !== key(s)) out.push(f); continue; }
      if (s && s.mtimeMs > capturedAt) out.push(f);
    }
    return out;
  }
}
