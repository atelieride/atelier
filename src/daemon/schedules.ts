import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { TerminalInfo } from '@shared/protocol';
import type { Usage } from '@shared/session';
import {
  ARM_MS, ENTER_CAP_MS, ENTER_FLOOR_MS, ENTER_QUIET_MS, GRACE_MS, clashOf, decide, minuteOf,
  MAX_ENTRIES, nextFreeMinute, parseSchedules, promptPaste, pruneSchedules, scheduledPromptSchema, type IfBusy, type ScheduledPrompt
} from '@shared/scheduled-prompts';
import { writeFileAtomic } from './fsutil';

const MIN = 60_000;
/** Ticks run every second: a gap this long means atelierd was asleep or stopped. */
const SLEEP_GAP_MS = 60_000;
/**
 * Gates that pass in seconds: a prompt held by one when the Mac slept would go the moment it wakes, hours late. Claude
 * working or asking waits as long as it takes; a closed session or no Claude goes missed through decide.
 */
const BRIEF_GATES = new Set(['typing', 'draft']);

/** What atelierd knows about a terminal's prompt (TerminalManager.promptState). */
export interface PromptState { bracketed: boolean; draft: boolean; lastInputAt: number; lastOutputAt: number }

/** The book's view of atelierd: terminals, their prompts, the usage, the connected apps, and its own writes. */
export interface SchedulePort {
  terminals(): TerminalInfo[];
  promptState(id: string): PromptState | null;
  /** atelierd's own write into a terminal (never counted as the user's input); false when the terminal is gone. */
  write(id: string, data: string): boolean;
  usageFor(configDir: string | undefined): Usage | null;
  /** An app is connected (it may show the countdown). */
  clients(): boolean;
}

export interface ScheduleBookOptions {
  /** schedules.json; absent: memory only (tests). */
  file?: string;
  now?: () => number;
  uuid?: () => string;
  log?: (msg: string) => void;
}

export interface AddRequest { terminalId: string; text: string; at: number; ifBusy: IfBusy }
export interface UpdateRequest { id: string; text?: string; at?: number; ifBusy?: IfBusy }

const isLive = (p: ScheduledPrompt) => p.status === 'pending' || p.status === 'armed';

/**
 * Scheduled prompts: the list, its requests, and the tick that sends them.
 * Emits 'changed' with the whole list after every change; the daemon saves and broadcasts it.
 */
export class ScheduleBook extends EventEmitter {
  private items: ScheduledPrompt[] = [];
  private readonly now: () => number;
  private readonly uuid: () => string;
  /** Prompts pasted and waiting for their Enter (memory only). */
  private inFlight = new Map<string, { terminalId: string; pastedAt: number }>();
  /** When a scheduled prompt was last pasted into each terminal. */
  private lastSent = new Map<string, number>();
  /** The last tick (memory only): a long gap since means atelierd didn't run. */
  private lastTick: number | null = null;

  constructor(private readonly port: SchedulePort, private readonly o: ScheduleBookOptions = {}) {
    super();
    this.now = o.now ?? Date.now;
    this.uuid = o.uuid ?? randomUUID;
    if (o.file) this.items = this.load(o.file);
  }

  list(): ScheduledPrompt[] {
    return this.items.map((p) => ({ ...p }));
  }

  /** A prompt pasted and waiting for its Enter (the daemon pumps faster meanwhile). */
  sending(): boolean {
    return this.inFlight.size > 0;
  }

  add(r: AddRequest): ScheduledPrompt {
    const t = this.port.terminals().find((x) => x.id === r.terminalId);
    if (!t) throw new Error('unknown terminal');
    if (!t.session) throw new Error('not a Claude session');
    if (this.items.filter(isLive).length >= MAX_ENTRIES) throw new Error('too many');
    const at = this.checkTime(r.terminalId, r.at);
    const p: ScheduledPrompt = {
      id: this.uuid(), terminalId: t.id, sessionId: t.session.sessionId, projectRoot: t.projectRoot, title: t.title.slice(0, 200),
      text: r.text, at, ifBusy: r.ifBusy, createdAt: this.now(), status: 'pending'
    };
    this.items.push(p);
    this.changed();
    return { ...p };
  }

  update(r: UpdateRequest): ScheduledPrompt {
    const p = this.must(r.id);
    if (p.status === 'sent' || p.status === 'skipped') throw new Error('not editable');
    this.notSending(p.id);
    if (r.at !== undefined) {
      const at = this.checkTime(p.terminalId, r.at, p.id);
      this.inFlight.delete(p.id);
      Object.assign(p, { at, status: 'pending' as const });
      for (const k of ['armedUntil', 'dueSince', 'reason', 'fired', 'forceUsage', 'movedFrom', 'doneAt', 'limitRetried'] as const) delete p[k];
    }
    if (r.text !== undefined) p.text = r.text;
    if (r.ifBusy !== undefined) p.ifBusy = r.ifBusy;
    this.changed();
    return { ...p };
  }

  remove(id: string): void {
    this.notSending(id);
    const before = this.items.length;
    this.items = this.items.filter((x) => x.id !== id);
    this.inFlight.delete(id);
    if (this.items.length !== before) this.changed();
  }

  /** Undo of a remove: the entry as it was, re-checked (schema, no clash). */
  restore(prompt: unknown): ScheduledPrompt {
    const r = scheduledPromptSchema.safeParse(prompt);
    if (!r.success) throw new Error('invalid prompt');
    const p = r.data;
    if (this.items.some((x) => x.id === p.id)) throw new Error('already there');
    // Its own session only: a live terminal with that id must be the same project and session.
    const t = this.port.terminals().find((x) => x.id === p.terminalId);
    if (t && (t.projectRoot !== p.projectRoot || (t.session && t.session.sessionId !== p.sessionId))) throw new Error('unknown terminal');
    // Gone: no live terminal of another project may carry its session (resolve() would follow it there).
    if (!t && this.port.terminals().some((x) => x.session?.sessionId === p.sessionId && x.projectRoot !== p.projectRoot)) throw new Error('unknown terminal');
    if (isLive(p) && this.items.filter(isLive).length >= MAX_ENTRIES) throw new Error('too many');
    if (isLive(p) && clashOf(this.items, p.terminalId, p.at)) throw new Error('time taken');
    const { armedUntil: _a, fired: _f, forceUsage: _u, ...rest } = p;
    const back: ScheduledPrompt = { ...rest, status: p.status === 'armed' ? 'pending' : p.status };
    this.items.push(back);
    this.changed();
    return { ...back };
  }

  /** Send Now (and the countdown's end): sent as soon as Claude is free; `usage` skips the usage gate once. */
  fire(id: string, force?: 'usage'): void {
    const p = this.must(id);
    if (p.status === 'sent' || p.status === 'skipped') throw new Error('not editable');
    const now = this.now();
    if (p.status === 'missed') {
      p.status = 'pending';
      delete p.doneAt;
      delete p.reason;
    }
    // The scheduled time stays (the list and the notices name it); `fired` and `dueSince` say it goes now.
    p.fired = true;
    p.dueSince = now;
    if (force === 'usage') p.forceUsage = true;
    this.changed();
    this.tick();
  }

  /** Not Now: later by `minutes`, past any clash, back to pending. */
  snooze(id: string, minutes: number): void {
    const p = this.must(id);
    if (!isLive(p)) throw new Error('not editable');
    this.notSending(p.id);
    p.at = nextFreeMinute(this.items, p.terminalId, minuteOf(this.now()) + minutes * MIN, MIN, p.id);
    p.status = 'pending';
    for (const k of ['armedUntil', 'dueSince', 'reason', 'fired'] as const) delete p[k];
    this.changed();
  }

  /** Every second and on every terminal change: each live prompt's decision, applied. */
  tick(): void {
    const now = this.now();
    const terms = this.port.terminals();
    const before = JSON.stringify(this.items);
    const sendingBefore = this.inFlight.size;
    // A gap between ticks: atelierd didn't run (the Mac slept). A prompt armed, or held by a gate that passes in
    // seconds, past its grace by now is missed, never sent late; a busy or asking Claude waits on.
    const slept = this.lastTick !== null && now - this.lastTick > SLEEP_GAP_MS;
    this.lastTick = now;
    for (const p of this.items) {
      if (!isLive(p) || this.inFlight.has(p.id)) continue;
      if (slept && !p.fired && p.dueSince !== undefined && now - p.at > GRACE_MS && (p.status === 'armed' || BRIEF_GATES.has(p.reason ?? ''))) {
        p.status = 'missed';
        p.reason = 'asleep';
        p.doneAt = now;
        delete p.armedUntil;
        continue;
      }
      const term = this.resolve(p, terms);
      const st = term ? this.port.promptState(term.id) : null;
      const d = decide(p, {
        term, usage: term ? this.port.usageFor(term.configDir) : null,
        bracketed: st?.bracketed ?? false, draft: st?.draft ?? false, lastInputAt: st?.lastInputAt ?? 0,
        lastSentAt: term ? this.lastSent.get(term.id) ?? 0 : 0, clients: this.port.clients()
      }, now);
      switch (d.kind) {
        case 'none': break;
        case 'wait':
          if (p.status === 'armed') { p.status = 'pending'; delete p.armedUntil; }
          p.dueSince ??= now;
          p.reason = d.reason;
          break;
        case 'arm':
          p.status = 'armed';
          p.armedUntil = now + ARM_MS;
          p.dueSince ??= now;
          delete p.reason;
          break;
        case 'send':
          this.paste(p, term!.id, now);
          break;
        case 'move':
          p.movedFrom ??= p.at;
          p.at = nextFreeMinute(this.items, p.terminalId, d.to, MIN, p.id);
          p.status = 'pending';
          p.reason = 'limit';
          for (const k of ['armedUntil', 'dueSince', 'fired'] as const) delete p[k];
          break;
        case 'skip':
        case 'missed':
          p.status = d.kind === 'skip' ? 'skipped' : 'missed';
          p.reason = d.reason;
          p.doneAt = now;
          delete p.armedUntil;
          break;
      }
    }
    this.items = pruneSchedules(this.items, now);
    // A paste is always news: the host pumps its Enter on it (the list may read the same as before the paste).
    if (JSON.stringify(this.items) !== before || this.inFlight.size > sendingBefore) this.changed();
  }

  /** The Enter of each pasted prompt, once the screen settled (Sending). */
  pump(): void {
    if (this.inFlight.size === 0) return;
    const now = this.now();
    let moved = false;
    for (const [id, f] of [...this.inFlight]) {
      const p = this.items.find((x) => x.id === id);
      const st = this.port.promptState(f.terminalId);
      if (!p || !st) {
        this.inFlight.delete(id);
        if (p) { p.status = 'pending'; p.reason = 'closed'; delete p.armedUntil; moved = true; }
        continue;
      }
      const since = now - f.pastedAt;
      if (since < ENTER_FLOOR_MS) continue;
      if (now - st.lastOutputAt < ENTER_QUIET_MS && since < ENTER_CAP_MS) continue;
      this.inFlight.delete(id);
      this.port.write(f.terminalId, '\r');
      this.lastSent.set(f.terminalId, now);
      p.status = 'sent';
      p.doneAt = now;
      for (const k of ['armedUntil', 'reason', 'fired', 'forceUsage'] as const) delete p[k];
      moved = true;
    }
    if (moved) this.changed();
  }

  /** Writes the list now (the daemon calls it shortly after each change and at stop). */
  save(): void {
    if (!this.o.file) return;
    try { writeFileAtomic(this.o.file, JSON.stringify({ v: 1, list: this.items }), 0o600); } catch (err) { this.o.log?.(`schedules not saved: ${(err as Error).message}`); }
  }

  private load(file: string): ScheduledPrompt[] {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
    // Nothing is in flight across a restart: an armed prompt counts down again.
    return parseSchedules(raw).map((p) => {
      if (p.status !== 'armed') return p;
      const { armedUntil: _a, ...rest } = p;
      return { ...rest, status: 'pending' as const };
    });
  }

  private paste(p: ScheduledPrompt, terminalId: string, now: number): void {
    for (const part of promptPaste(p.text)) {
      if (!this.port.write(terminalId, part)) { p.status = 'pending'; p.reason = 'closed'; delete p.armedUntil; return; }
    }
    p.status = 'armed';
    p.armedUntil = now;
    p.dueSince ??= now;
    delete p.reason;
    this.inFlight.set(p.id, { terminalId, pastedAt: now });
    // The next prompt into this terminal waits for Claude to take this one.
    this.lastSent.set(terminalId, now);
  }

  /** The prompt's terminal, or the one its session was resumed in (the prompt follows it there). */
  private resolve(p: ScheduledPrompt, terms: TerminalInfo[]): TerminalInfo | null {
    const own = terms.find((x) => x.id === p.terminalId);
    if (own) return own;
    // A resumed session keeps its project: a terminal of another project never takes the prompt.
    const moved = terms.find((x) => x.session?.sessionId === p.sessionId && x.projectRoot === p.projectRoot);
    if (!moved) return null;
    p.terminalId = moved.id;
    return moved;
  }

  /** The minute asked for: not before the current one, and free in that terminal. */
  private checkTime(terminalId: string, at: number, exceptId?: string): number {
    const m = minuteOf(at);
    if (m < minuteOf(this.now())) throw new Error('time passed');
    if (clashOf(this.items, terminalId, m, exceptId)) throw new Error('time taken');
    return m;
  }

  /** A prompt pasted and waiting for its Enter can't be changed for those 0.25–2 s (its text is in Claude's prompt). */
  private notSending(id: string): void {
    if (this.inFlight.has(id)) throw new Error('sending');
  }

  private must(id: string): ScheduledPrompt {
    const p = this.items.find((x) => x.id === id);
    if (!p) throw new Error('unknown prompt');
    return p;
  }

  private changed(): void {
    this.emit('changed', this.list());
  }
}
