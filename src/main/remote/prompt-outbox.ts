// The prompts phones type into Claude sessions, every phone's, with no terminal attached (the terminal keeps the
// computer's size). A prompt goes at once into Claude's empty prompt while Claude waits for one. While Claude works it
// waits here instead, after the ones that came before it, and everything waiting for a session goes as one prompt
// (the texts a blank line apart, as Claude Code sends what waits in its own queue) as soon as a fresh read of the
// screen shows Claude idle. An Enter goes only into an idle Claude, never into a turn: a permission request can be
// drawn at any moment of a turn, and one drawn between the last read and the Enter would take that Enter as its "Yes",
// for a call nobody saw. A prompt waits on while the phone that sent it is away; a phone unpaired, or iPhone access
// turned off, takes its prompts back.
import type { TerminalInfo } from '@shared/protocol';
import { promptPaste } from '@shared/scheduled-prompts';
import { waitKind } from '@shared/session-view';
import { isClaudeProcess } from '@shared/shells';
import type { ConversationHost, ConversationTiming } from './conversation-requests';
import { claudeWorking, promptHolds, promptState, readDialog } from './dialog';
import { MAX_SAY_BYTES, type ErrorCode } from './messages';
import type { RemoteTerminals } from './remote-hub';
import { waitOf } from './rows';

/** A window typed in a session this recently (ms): what it typed may not be drawn yet, so no prompt goes in. */
export const TYPED_RECENTLY_MS = 1500;

export type Refusal = { code: ErrorCode; message: string };
export const GONE = 'This session is not on this computer any more.';
export const NOT_CLAUDE = 'This is not a Claude session.';
export const ANSWER_FIRST: Refusal = { code: 'busy', message: 'Answer Claude\'s request first.' };
export const TYPED: Refusal = { code: 'busy', message: 'Text is typed in Claude\'s prompt on the computer.' };
export const NO_PROMPT: Refusal = { code: 'busy', message: 'Claude\'s prompt isn\'t on screen.' };
export const NOT_REACHED: Refusal = { code: 'failed', message: 'The text didn\'t reach Claude\'s prompt.' };
const MEANWHILE: Refusal = { code: 'busy', message: 'Claude asked something meanwhile. Check the terminal.' };
/** Claude working on screen: the prompt waits for the turn's end. Never sent to a phone. */
const WORKING: Refusal = { code: 'busy', message: 'Claude is working.' };
const FULL: Refusal = { code: 'busy', message: 'Too much is waiting for Claude already. Send it once Claude is done.' };
/** Between two prompts that go together. */
const SEPARATOR = '\n\n';
/** Control characters but newline and tab: a prompt types none of them. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const codeOf = (e: unknown) => (typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : null);
/** An error for the log: its code when it has one, else its message. */
const reasonOf = (e: unknown) => codeOf(e) ?? (e instanceof Error ? e.message : 'error');

/** Terminal `id` when the state lists it as a Claude session; else why not. */
export function sessionOf(host: ConversationHost, id: string): TerminalInfo | Refusal {
  const t = host.listed(id) ? host.terminal(id) : undefined;
  if (!t) return { code: 'not-found', message: GONE };
  if (!host.claude(id)) return { code: 'invalid', message: NOT_CLAUDE };
  return t;
}

/**
 * Whether a phone answered the wait session `t` is in, when one answer ends it: a permission (by its row or in its
 * dialog) or a plan approval. After "Yes" no hook comes until the tool has run, so the session waits under the same
 * ask all that time while Claude works: with no dialog on screen, that wait is over. Never a question: its next page
 * keeps the ask, and a frame with no dialog between pages would hide that page. One answered on the computer can't
 * be told from one still to answer.
 */
export function answered(host: ConversationHost, t: TerminalInfo): boolean {
  const wait = waitOf(t.session);
  if (wait !== 'permission' && wait !== 'plan') return false;
  const ask = host.asks.keyOf(t);
  return ask !== null && host.answers.isAnswered(t.id, ask);
}

/** Session `t` waits for an answer no phone gave (a dialog still on screen is checked apart). */
export function waits(host: ConversationHost, t: TerminalInfo): boolean {
  return waitKind(t.session) !== null && !answered(host, t);
}

/** Terminal `id` as listed now, a Claude session waiting for nothing a phone didn't answer; else why not. */
export function free(host: ConversationHost, id: string): TerminalInfo | Refusal {
  const t = sessionOf(host, id);
  if ('code' in t) return t;
  return waits(host, t) ? ANSWER_FIRST : t;
}

export interface OutboxTiming {
  /**
   * A waiting prompt is tried this long after it came, or after its session's hooks changed what Claude does (ms);
   * each try that can't send it doubles the wait before the next, up to slowMs. A turn's end comes with its Stop hook,
   * an interrupt's only on screen.
   */
  retryMs: number;
  slowMs: number;
}

/** What a phone's prompt became: typed and sent, waiting for Claude to be idle, or why not. */
export type Said = 'sent' | 'queued' | Refusal;

/** A prompt waiting for an idle Claude, and the phone that sent it. */
interface Waiting { device: string; text: string }

/** The prompts waiting for one session, oldest first. */
interface Queue {
  items: Waiting[];
  timer: ReturnType<typeof setTimeout> | null;
  /** When the timer fires (ms). */
  due: number;
  /** The wait before the next try. */
  gap: number;
  /** A try is typing them now. */
  typing: boolean;
  /** What the session's hooks said Claude does, as of the last look. */
  seen: string;
}

const doing = (t: TerminalInfo | undefined) => t?.session?.state ?? 'none';

export class PromptOutbox {
  private readonly queues = new Map<string, Queue>();
  private disposed = false;

  constructor(private readonly o: {
    host: ConversationHost;
    terms: RemoteTerminals;
    timing: ConversationTiming;
    outbox: OutboxTiming;
    /** Whether phone `device` may still type: paired, with iPhone access on. */
    allowed(device: string): boolean;
  }) {}

  /**
   * Phone `device`'s prompt for terminal `id` (a Claude session the state lists): typed now while Claude waits for a
   * prompt; kept for later while Claude works, while another typing or answer is on its way into the terminal, or
   * after prompts already waiting there; else refused as typing it found the session.
   */
  async say(device: string, id: string, text: string): Promise<Said> {
    const body = text.replace(CONTROL, '');
    if (this.disposed || !body.trim()) return NOT_REACHED;
    // After the prompts already waiting, in order.
    if (this.queues.has(id)) return this.enqueue(device, id, body, false);
    // Another typing or an answer on its way into the terminal: this one goes once Claude is idle after it.
    if (this.o.host.answers.hold(id)) return this.enqueue(device, id, body, false);
    let typed = false;
    let r: Refusal | null;
    try {
      r = await this.typePrompt(id, body, (key) => { typed = true; this.o.terms.answerKey(id, key); }, () => !this.o.allowed(device));
    } catch (e) {
      this.o.host.log(`conversations: a prompt in terminal ${id} stopped (${reasonOf(e)})`);
      const t = sessionOf(this.o.host, id);
      // A read that fails before the paste: no prompt seen; after it, the text may be there, but no Enter goes.
      r = 'code' in t ? t : typed ? NOT_REACHED : NO_PROMPT;
    } finally {
      this.o.host.answers.release(id);
    }
    // Before whatever came while this one held the terminal.
    if (r === WORKING) return this.enqueue(device, id, body, true);
    return r ?? 'sent';
  }

  /** The terminals changed: a session gone, or no Claude in front any more, drops its prompts; new hooks retry soon. */
  terminalsChanged(list: readonly TerminalInfo[]): void {
    const byId = new Map(list.map((t) => [t.id, t]));
    for (const [id, q] of [...this.queues]) {
      const t = byId.get(id);
      if (!t || (!this.o.host.claude(id) && !isClaudeProcess(t.foreground))) { this.end(id, q, 'its session ended'); continue; }
      if (doing(t) === q.seen) continue;
      q.seen = doing(t);
      q.gap = this.o.outbox.retryMs;
      this.schedule(id, q);
    }
  }

  /** Phone `device` unpaired: what it sent goes no more (a typing under way gets no Enter). */
  forget(device: string): void {
    for (const [id, q] of [...this.queues]) {
      q.items = q.items.filter((p) => p.device !== device);
      if (!q.items.length && !q.typing) this.end(id, q, null);
    }
  }

  /** iPhone access off, or a new identity: nothing waiting goes any more. */
  clear(): void {
    for (const [id, q] of [...this.queues]) {
      q.items = [];
      if (!q.typing) this.end(id, q, null);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const [id, q] of [...this.queues]) this.end(id, q, null);
  }

  private enqueue(device: string, id: string, text: string, first: boolean): Said {
    const q = this.queues.get(id) ?? { items: [], timer: null, due: 0, gap: this.o.outbox.retryMs, typing: false, seen: doing(this.o.host.terminal(id)) };
    // Everything waiting goes as one prompt, within the size one may take.
    const size = q.items.reduce((n, p) => n + bytes(p.text) + bytes(SEPARATOR), bytes(text));
    if (size > MAX_SAY_BYTES) return FULL;
    if (first) q.items.unshift({ device, text });
    else q.items.push({ device, text });
    this.queues.set(id, q);
    this.schedule(id, q);
    return 'queued';
  }

  /** The next try `q.gap` from now, unless one comes sooner. */
  private schedule(id: string, q: Queue): void {
    if (this.disposed || this.queues.get(id) !== q) return;
    const at = Date.now() + q.gap;
    if (q.timer) {
      if (q.due <= at) return;
      clearTimeout(q.timer);
    }
    q.due = at;
    q.timer = setTimeout(() => { q.timer = null; void this.attempt(id, q); }, q.gap);
    q.timer.unref?.();
  }

  private end(id: string, q: Queue, why: string | null): void {
    if (q.timer) clearTimeout(q.timer);
    q.timer = null;
    if (this.queues.get(id) !== q) return;
    this.queues.delete(id);
    if (why && q.items.length) this.o.host.log(`conversations: ${q.items.length} prompt(s) waiting for terminal ${id} dropped (${why})`);
  }

  /**
   * Types what waits for terminal `id` as one prompt, when nothing else types there and the screen shows Claude idle
   * with its prompt empty. Sent, or pasted with no Enter after it (it stays in Claude's prompt), it waits no more;
   * otherwise it is tried again later.
   */
  private async attempt(id: string, q: Queue): Promise<void> {
    // A try under way schedules the next one when it ends.
    if (this.disposed || q.typing || this.queues.get(id) !== q) return;
    q.items = q.items.filter((p) => this.o.allowed(p.device));
    if (!q.items.length) { this.end(id, q, null); return; }
    if (this.o.host.answers.hold(id)) { this.again(id, q); return; }
    q.typing = true;
    const taken = [...q.items];
    let typed = false;
    let r: Refusal | null;
    try {
      r = await this.typePrompt(id, taken.map((p) => p.text).join(SEPARATOR), (key) => { typed = true; this.o.terms.answerKey(id, key); },
        () => !taken.every((p) => this.o.allowed(p.device)));
    } catch (e) {
      this.o.host.log(`conversations: prompts waiting for terminal ${id} stopped (${reasonOf(e)})`);
      r = NOT_REACHED;
    } finally {
      this.o.host.answers.release(id);
      q.typing = false;
    }
    if (r === null || typed) {
      q.items = q.items.filter((p) => !taken.includes(p));
      if (r) this.o.host.log(`conversations: prompts waiting for terminal ${id} stayed in Claude's prompt (${r.message})`);
    }
    if (r?.code === 'not-found') { this.end(id, q, 'its session ended'); return; }
    if (!q.items.length) { this.end(id, q, null); return; }
    this.again(id, q);
  }

  /** Not sent this time: the next try waits twice as long, up to slowMs. */
  private again(id: string, q: Queue): void {
    q.seen = doing(this.o.host.terminal(id));
    q.gap = Math.min(q.gap * 2, this.o.outbox.slowMs);
    this.schedule(id, q);
  }

  /**
   * Types `text` into Claude's empty prompt as one bracketed paste (as Atelier's scheduled prompts do), and Enter once
   * a read shows the prompt holding that text and nothing else, within enterCapMs. Before the paste: refused while the
   * session waits, a dialog or a menu shows, the prompt isn't on screen or holds text, or a window typed in the
   * terminal just now; WORKING while the screen shows Claude working, whatever the hooks say. Idle, Claude asks
   * nothing before a model's answer. No Enter after the paste once the session waits or a dialog shows (the text stays
   * in the prompt), a window types, the session is gone or `gone()` says the prompt goes no more, or the prompt never
   * shows the text.
   */
  private async typePrompt(id: string, text: string, type: (key: string) => void, gone: () => boolean): Promise<Refusal | null> {
    const started = Date.now();
    /** A window typed in the terminal since the prompt began, or just before. */
    const typedThere = () => { const at = this.o.terms.lastWindowInput(id); return at >= started || Date.now() - at < TYPED_RECENTLY_MS; };
    const before = free(this.o.host, id);
    if ('code' in before) return before;
    if (typedThere()) return TYPED;
    const view = await this.o.terms.screenView(id);
    // The session as it is now, with the screen just read.
    const now = free(this.o.host, id);
    if ('code' in now) return now;
    if (this.disposed || gone()) return NOT_REACHED;
    if (typedThere()) return TYPED;
    if (readDialog(view, null)) return ANSWER_FIRST;
    const state = promptState(view);
    if (state === 'none') return NO_PROMPT;
    if (state === 'typed') return TYPED;
    if (claudeWorking(view)) return WORKING;
    // One input: within the 16 KiB a prompt may take, the paste needs no chunks.
    type(promptPaste(text).join(''));
    const clock = this.o.timing.now ?? Date.now;
    const pasted = clock();
    await sleep(this.o.timing.enterMs);
    for (;;) {
      const shown = await this.o.terms.screenView(id);
      const t = sessionOf(this.o.host, id);
      if ('code' in t) return t;
      if (this.disposed || gone()) return NOT_REACHED;
      if (waits(this.o.host, t) || readDialog(shown, null)) return MEANWHILE;
      // What a window typed may be in the prompt with the text: Enter would send it too.
      if (this.o.terms.lastWindowInput(id) >= started) return TYPED;
      if (promptHolds(shown, text)) { type('\r'); return null; }
      if (clock() - pasted + this.o.timing.keyMs > this.o.timing.enterCapMs) return NOT_REACHED;
      await sleep(this.o.timing.keyMs);
    }
  }
}
