import type { EventEmitter } from 'node:events';
import { IPC, type ScheduleResult } from '@shared/api';
import { newlyArmed, scheduleNotices, type ScheduleNotice } from '@shared/schedule-notices';
import type { IfBusy, ScheduleReason, ScheduledPrompt } from '@shared/scheduled-prompts';
import type { RequestMessage } from './daemon-client';
import { osWords } from '@shared/windows-words';
import type { Platform } from '@shared/platform';

/** What the hub needs of DaemonClient. */
export interface ScheduleClient extends EventEmitter {
  hasCapability(c: 'schedules'): boolean;
  request<T = unknown>(msg: RequestMessage | (() => RequestMessage), o?: { timeoutMs?: number }): Promise<T>;
}

/** What the hub needs of the windows (TerminalHub). */
export interface ScheduleHost {
  broadcast(channel: string, payload: unknown): void;
  toProject(project: string, channel: string, payload: unknown): void;
  /** A window of that project is focused (it shows the countdown and the toasts). */
  projectFocused(project: string): boolean;
  /** The project of a live terminal, null when unknown. */
  terminalProject(id: string): string | null;
  /** An OS banner; a click reveals the session. */
  banner(b: { title: string; body: string; terminalId: string; projectRoot: string }): void;
}

const REASON: Record<ScheduleReason, string> = {
  busy: 'Claude was working', waiting: 'Claude was waiting for you', draft: 'there was text in its prompt', typing: 'someone was typing in it',
  'not-claude': "Claude wasn't running", closed: 'the session was closed', asleep: 'the Mac was asleep', limit: 'usage limit reached',
  'limit-hit': 'usage limit reached'
};

/**
 * Scheduled prompts in the main process: atelierd's list to every window, the windows'
 * requests (scoped to their project) to atelierd, the countdown routing and the news (toasts, banners).
 */
export class ScheduleHub {
  private items: ScheduledPrompt[] = [];
  private known = false;
  private readonly now: () => number;

  constructor(private readonly client: ScheduleClient, private readonly host: ScheduleHost, private readonly o: { now?: () => number; platform?: Platform } = {}) {
    this.now = o.now ?? Date.now;
    client.on('schedules', (list: ScheduledPrompt[]) => this.onList(list));
    client.on('status', (s: string) => {
      if (s === 'connected') return;
      // The next list after a reconnection is a baseline: nothing in it is news.
      this.known = false;
    });
  }

  available(): boolean {
    return this.client.hasCapability('schedules');
  }

  list(): ScheduledPrompt[] {
    return this.available() ? this.items : [];
  }

  add(project: string, o: { terminalId: string; text: string; at: number; ifBusy: IfBusy }): Promise<ScheduleResult> {
    if (!this.available()) return Promise.resolve({ ok: false, error: 'unavailable' });
    if (this.host.terminalProject(o.terminalId) !== project) return Promise.resolve({ ok: false, error: 'unknown terminal' });
    return this.run({ t: 'schedAdd', ...o }, true);
  }

  update(project: string, o: { id: string; text?: string; at?: number; ifBusy?: IfBusy }): Promise<ScheduleResult> {
    return this.own(project, o.id, () => this.run({ t: 'schedUpdate', ...o }, true));
  }

  remove(project: string, id: string): Promise<ScheduleResult> {
    return this.own(project, id, () => this.run({ t: 'schedRemove', id }, false));
  }

  restore(project: string, prompt: ScheduledPrompt): Promise<ScheduleResult> {
    if (!this.available()) return Promise.resolve({ ok: false, error: 'unavailable' });
    const live = this.host.terminalProject(prompt.terminalId);
    if (prompt.projectRoot !== project || (live !== null && live !== project)) return Promise.resolve({ ok: false, error: 'unknown prompt' });
    return this.run({ t: 'schedRestore', prompt }, true);
  }

  fire(project: string, id: string, force?: 'usage'): Promise<ScheduleResult> {
    return this.own(project, id, () => this.run({ t: 'schedFire', id, ...(force ? { force } : {}) }, false));
  }

  snooze(project: string, id: string, minutes: number): Promise<ScheduleResult> {
    return this.own(project, id, () => this.run({ t: 'schedSnooze', id, minutes }, false));
  }

  private own(project: string, id: string, go: () => Promise<ScheduleResult>): Promise<ScheduleResult> {
    if (!this.available()) return Promise.resolve({ ok: false, error: 'unavailable' });
    if (this.items.find((x) => x.id === id)?.projectRoot !== project) return Promise.resolve({ ok: false, error: 'unknown prompt' });
    return go();
  }

  private async run(msg: RequestMessage, withPrompt: boolean): Promise<ScheduleResult> {
    try {
      const r = await this.client.request<ScheduledPrompt | undefined>(msg);
      return withPrompt && r ? { ok: true, prompt: r } : { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private onList(next: ScheduledPrompt[]): void {
    if (!this.available()) return;
    const prev = this.items;
    const first = !this.known;
    this.items = next;
    this.known = true;
    this.host.broadcast(IPC.evSchedules, next);
    const now = this.now();
    // A countdown nobody can see: sent at once (atelierd would send it at armedUntil anyway). A pasted prompt is armed
    // until the moment it was pasted: never fired again.
    for (const p of newlyArmed(first ? [] : prev, next)) {
      if ((p.armedUntil ?? 0) > now && !this.host.projectFocused(p.projectRoot)) void this.run({ t: 'schedFire', id: p.id }, false);
    }
    if (first) return;
    for (const n of scheduleNotices(prev, next)) this.tell(n);
  }

  private tell(n: ScheduleNotice): void {
    const p = n.prompt;
    this.host.toProject(p.projectRoot, IPC.evScheduleNotice, n);
    if (this.host.projectFocused(p.projectRoot)) return;
    this.host.banner({ title: p.title, body: osWords(this.body(n), this.o.platform), terminalId: p.terminalId, projectRoot: p.projectRoot });
  }

  private body(n: ScheduleNotice): string {
    const p = n.prompt;
    const reason = (r: ScheduleReason | undefined) => (r ? REASON[r] : '');
    switch (n.kind) {
      case 'sent': return `Sent your ${this.time(p.at)} prompt`;
      case 'skipped': return `Skipped your ${this.time(p.at)} prompt: ${reason(p.reason)}`;
      case 'missed': return `Not sent at ${this.time(p.at)}: ${reason(p.reason)}`;
      case 'moved': return `Usage limit: moved to ${this.time(p.at)}`;
    }
  }

  /** "14:30" today, "Mon 14:31" another day (local time). */
  private time(ms: number): string {
    const d = new Date(ms);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const today = new Date(this.now());
    const same = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    return same ? hm : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${hm}`;
  }
}
