import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { noteHook, noteStatus, parseBook, recordFindings, type Finding, type SignalBookView } from '@shared/claude-signals';
import { claudeVersion } from '@shared/limit-pause';
import { writeFileAtomic } from './fsutil';

/**
 * The Claude Code signals notebook: the values hooks and the status line send
 * that Atelier doesn't recognize, content-free, with the Claude Code version. atelierd is the only writer of the file.
 * Emits 'changed' (with the view) and saves on one debounce.
 */
export class SignalBook extends EventEmitter {
  private book: SignalBookView;
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private readonly now: () => number;
  private readonly delayMs: number;

  constructor(private readonly o: { file: string; installed: ReadonlySet<string>; log?: (m: string) => void; now?: () => number; delayMs?: number }) {
    super();
    this.now = o.now ?? Date.now;
    this.delayMs = o.delayMs ?? 2000;
    this.book = this.load();
  }

  view(): SignalBookView { return this.book; }

  /** Notes one hook payload; never throws (noting must not stop a hook). */
  noteHook(payload: unknown, foreground: string | null): void {
    this.note(() => noteHook(payload, this.o.installed), foreground);
  }

  noteStatus(payload: unknown, foreground: string | null): void {
    this.note(() => noteStatus(payload), foreground);
  }

  /** Empties the entries (the last Claude Code version stays); the book restarts now. */
  clear(): void {
    this.book = { lastVersion: this.book.lastVersion, since: this.now(), entries: [] };
    this.touch();
  }

  /** Saves now (a pending debounce is cancelled; no 'changed': it is for the stop path). */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.save();
  }

  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private note(find: () => Finding[], foreground: string | null): void {
    try {
      const next = recordFindings(this.book, find(), claudeVersion(foreground), this.now());
      if (next === this.book) return;
      this.book = next;
      this.touch();
    } catch (err) {
      this.o.log?.(`signals not noted: ${(err as Error).message}`);
    }
  }

  private touch(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.save(); this.announce(); }, this.delayMs);
    this.timer.unref?.();
  }

  /** 'changed' from a timer: a throwing listener must never become an uncaught exception in atelierd. */
  private announce(): void {
    try { this.emit('changed', this.book); } catch (err) { this.o.log?.(`signals listener failed: ${(err as Error).message}`); }
  }

  private save(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try { writeFileAtomic(this.o.file, JSON.stringify(this.book), 0o600); } catch (err) { this.o.log?.(`signals not saved: ${(err as Error).message}`); }
  }

  private load(): SignalBookView {
    let text: string;
    try { text = readFileSync(this.o.file, 'utf8'); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.o.log?.(`signals not read: ${(err as Error).message}`);
      return parseBook(null, this.now());
    }
    try { return parseBook(JSON.parse(text), this.now()); } catch (err) {
      this.o.log?.(`signals file unreadable, starting empty: ${(err as Error).message}`);
      return parseBook(null, this.now());
    }
  }
}
