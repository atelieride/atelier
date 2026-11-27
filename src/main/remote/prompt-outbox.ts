// The prompts phones type into Claude sessions, every phone's, with no terminal attached (the terminal keeps the
// computer's size). A prompt goes at once into Claude's empty prompt while Claude waits for one. While Claude works it
// waits here instead, after the ones that came before it, and what waits for a session goes as one prompt (the texts
// a blank line apart, as Claude Code sends what waits in its own queue; a slash or shell command alone) as soon as a
// fresh read of the screen shows Claude idle. An Enter goes only into an idle Claude, never into a turn: a permission
// request can be drawn at any moment of a turn, and one drawn between the last read and the Enter would take that
// Enter as its "Yes", for a call nobody saw. A prompt waits on while the phone that sent it is away; it is dropped
// once its phone is unpaired, iPhone access is turned off, the terminal holds another Claude session than the one it
// was sent to (`/clear`, a resume), or text typed on the computer has kept it out for staleMs. A prompt with images
// (their files' paths, kept by images.ts) pastes each path alone first, each once Claude Code shows the one before as
// its `[Image #N]`, then its text after a space; it always goes alone.
import type { TerminalInfo } from '@shared/protocol';
import { promptPaste } from '@shared/scheduled-prompts';
import { waitKind } from '@shared/session-view';
import { isClaudeProcess } from '@shared/shells';
import type { ConversationHost, ConversationTiming } from './conversation-requests';
import { claudeWorking, promptHolds, promptState, readDialog } from './dialog';
import { MAX_SAY_BYTES, type ErrorCode } from './messages';
import type { PhoneImage } from './images';
import type { ScreenView } from './prompt';
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
/** An image's path pasted that never showed as its marker (Claude Code couldn't read it, or took too long). */
const IMAGE_NOT_REACHED: Refusal = { code: 'failed', message: 'The image didn\'t reach Claude\'s prompt.' };
const MEANWHILE: Refusal = { code: 'busy', message: 'Claude asked something meanwhile. Check the terminal.' };
/**
 * A turn Claude started by itself while a prompt was being typed (a background task's notice, a scheduled prompt):
 * nothing more goes, what went stays in the prompt.
 */
const STARTED: Refusal = { code: 'busy', message: 'Claude started working meanwhile. Check the terminal.' };
/** Claude working on screen: the prompt waits for the turn's end. Never sent to a phone. */
const WORKING: Refusal = { code: 'busy', message: 'Claude is working.' };
/** A text typed on the computer, or no prompt on screen: the computer keeps the prompt out. */
const HELD = new Set([TYPED, NO_PROMPT]);
const FULL: Refusal = { code: 'busy', message: 'Too much is waiting for Claude already. Send it once Claude is done.' };
/** Images waiting for one session at most, in all its prompts: each holds the terminal for its paste. */
export const MAX_WAITING_IMAGES = 10;
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
  /** How long the computer may keep waiting prompts out (text typed there, no prompt on screen) before they're dropped. */
  staleMs: number;
}

/** What a phone's prompt became: typed and sent, waiting for Claude to be idle, or why not. */
export type Said = 'sent' | 'queued' | Refusal;

/**
 * A prompt waiting for an idle Claude (its text, and the images pasted before it), and the phone that sent it;
 * `dropped` once it may go no more.
 */
interface Waiting { device: string; text: string; images: readonly PhoneImage[]; dropped?: true }

/** The prompts waiting for one session, oldest first. */
interface Queue {
  items: Waiting[];
  /** The Claude session they were sent to (null while Claude starts): another one there drops them. */
  session: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** When the timer fires (ms). */
  due: number;
  /** The wait before the next try. */
  gap: number;
  /** A try is under way. */
  busy: boolean;
  /** What the session's hooks said Claude does, as of the last look. */
  seen: string;
  /** Since when the computer keeps them out, null while it doesn't. */
  heldSince: number | null;
}

const doing = (t: TerminalInfo | undefined) => t?.session?.state ?? 'none';
/**
 * A slash command or a shell command (Claude Code reads a prompt by its first character), or a prompt with images
 * (each pasted before its own text): it goes alone.
 */
const alone = (p: Waiting) => p.images.length > 0 || /^[/!]/.test(p.text.trimStart());
/** The prompts that go together next: the first, and those after it up to one that goes alone. */
function batchOf(items: readonly Waiting[]): Waiting[] {
  const out: Waiting[] = [];
  for (const p of items) {
    if (out.length && alone(p)) break;
    out.push(p);
    if (alone(p)) break;
  }
  return out;
}

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
    /** How many prompts wait for a session changed. */
    changed(): void;
  }) {}

  /** How many prompts wait for terminal `id`. */
  waiting(id: string): number {
    return this.queues.get(id)?.items.length ?? 0;
  }

  /**
   * Phone `device`'s prompt for terminal `id` (a Claude session the state lists), with the files of the images it
   * carries: typed now while Claude waits for a prompt; kept for later while Claude works, while another typing or
   * answer is on its way into the terminal, or after prompts already waiting there; else refused as typing it found
   * the session.
   */
  async say(device: string, id: string, text: string, images: readonly PhoneImage[] = []): Promise<Said> {
    const body = text.replace(CONTROL, '');
    if (this.disposed || (!body.trim() && images.length === 0)) return NOT_REACHED;
    // After the prompts already waiting, in order.
    if (this.queues.has(id)) return this.enqueue(device, id, body, images, false);
    // Another typing or an answer on its way into the terminal: this one goes once Claude is idle after it.
    if (this.o.host.answers.hold(id)) return this.enqueue(device, id, body, images, false);
    let typed = false;
    let r: Refusal | null;
    try {
      r = await this.typePrompt(id, body, images, (key) => { typed = true; this.o.terms.answerKey(id, key); }, () => !this.o.allowed(device));
    } catch (e) {
      this.o.host.log(`conversations: a prompt in terminal ${id} stopped (${reasonOf(e)})`);
      const t = sessionOf(this.o.host, id);
      // A read that fails before the paste: no prompt seen; after it, the text may be there, but no Enter goes.
      r = 'code' in t ? t : typed ? NOT_REACHED : NO_PROMPT;
    } finally {
      this.o.host.answers.release(id);
    }
    // Before whatever came while this one held the terminal.
    if (r === WORKING) return this.enqueue(device, id, body, images, true);
    return r ?? 'sent';
  }

  /**
   * The terminals changed: a session gone, no Claude in front any more, or another Claude session there drops what
   * waits for it; new hooks retry soon.
   */
  terminalsChanged(list: readonly TerminalInfo[]): void {
    const byId = new Map(list.map((t) => [t.id, t]));
    for (const [id, q] of [...this.queues]) {
      const t = byId.get(id);
      const why = this.gone(id, q, t);
      if (why) { this.end(id, q, why); continue; }
      if (doing(t) === q.seen) continue;
      q.seen = doing(t);
      q.gap = this.o.outbox.retryMs;
      this.schedule(id, q);
    }
  }

  /** Phone `device` unpaired: what it sent goes no more (a try under way gets no Enter). */
  forget(device: string): void {
    for (const [id, q] of [...this.queues]) {
      for (const p of q.items) if (p.device === device) p.dropped = true;
      this.prune(id, q);
    }
  }

  /** iPhone access off, or a new identity: nothing waiting goes any more (a try under way gets no Enter). */
  clear(): void {
    for (const [id, q] of [...this.queues]) {
      for (const p of q.items) p.dropped = true;
      this.prune(id, q);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const [id, q] of [...this.queues]) this.end(id, q, null);
  }

  private enqueue(device: string, id: string, text: string, images: readonly PhoneImage[], first: boolean): Said {
    if (this.disposed) return NOT_REACHED;
    const t = this.o.host.terminal(id);
    const q = this.queues.get(id) ?? {
      items: [], session: t?.session?.sessionId ?? null, timer: null, due: 0, gap: this.o.outbox.retryMs, busy: false, seen: doing(t), heldSince: null
    };
    // The same text and images from the same phone, sent again (a tap twice, a resend with no answer): it waits once.
    // An image sent again is a new file under a new reference: the same image by its bytes' digest.
    const sums = (list: readonly PhoneImage[]) => list.map((i) => i.sum).join(' ');
    const same = (p: Waiting) => p.device === device && p.text === text && sums(p.images) === sums(images) && !p.dropped;
    if (first) q.items = q.items.filter((p) => !same(p));
    else if (q.items.some(same)) return 'queued';
    // What waits goes in prompts within the size one may take, and pastes MAX_WAITING_IMAGES images at most.
    const size = q.items.reduce((n, p) => n + bytes(p.text) + bytes(SEPARATOR), bytes(text));
    if (size > MAX_SAY_BYTES) return FULL;
    if (images.length > 0 && q.items.reduce((n, p) => n + p.images.length, images.length) > MAX_WAITING_IMAGES) return FULL;
    if (first) q.items.unshift({ device, text, images });
    else q.items.push({ device, text, images });
    this.queues.set(id, q);
    this.schedule(id, q);
    this.o.changed();
    return 'queued';
  }

  /** Why what waits for terminal `id` goes no more, by the terminal as listed; null while it may still go. */
  private gone(id: string, q: Queue, t: TerminalInfo | undefined): string | null {
    if (!t) return 'its terminal is gone';
    // Between `/clear`'s end and its next session, Claude is still in front with no session.
    if (!this.o.host.claude(id) && !isClaudeProcess(t.foreground)) return 'Claude left the terminal';
    const session = t.session?.sessionId ?? null;
    if (session !== null && q.session !== null && session !== q.session) return 'another Claude session is there';
    if (session !== null) q.session = session;
    return null;
  }

  /** Drops what may go no more: a queue left empty ends, unless a try under way ends it. */
  private prune(id: string, q: Queue): void {
    const before = q.items.length;
    q.items = q.items.filter((p) => !p.dropped && this.o.allowed(p.device));
    if (!q.items.length && !q.busy) this.end(id, q, null);
    else if (q.items.length !== before) this.o.changed();
  }

  /** The next try `q.gap` from now, unless one comes sooner. */
  private schedule(id: string, q: Queue): void {
    if (this.disposed || this.queues.get(id) !== q) return;
    const gap = Math.max(1, q.gap);
    const at = Date.now() + gap;
    if (q.timer) {
      if (q.due <= at) return;
      clearTimeout(q.timer);
    }
    q.due = at;
    q.timer = setTimeout(() => { q.timer = null; void this.attempt(id, q); }, gap);
    q.timer.unref?.();
  }

  private end(id: string, q: Queue, why: string | null): void {
    if (q.timer) clearTimeout(q.timer);
    q.timer = null;
    if (this.queues.get(id) !== q) return;
    this.queues.delete(id);
    if (why && q.items.length) this.o.host.log(`conversations: ${q.items.length} prompt(s) waiting for terminal ${id} dropped (${why})`);
    this.o.changed();
  }

  /**
   * Types the next prompts waiting for terminal `id` (batchOf) as one prompt, when the screen shows Claude idle with
   * its prompt empty: looked at first without holding the terminal (a phone's Stop or answer meanwhile isn't refused
   * for it), then read again and typed while holding it. Sent, or pasted with no Enter after it (it stays in Claude's
   * prompt), they wait no more; otherwise they are tried again later.
   */
  private async attempt(id: string, q: Queue): Promise<void> {
    // A try under way schedules the next one when it ends.
    if (this.disposed || q.busy || this.queues.get(id) !== q) return;
    const why = this.gone(id, q, this.o.host.terminal(id));
    if (why) { this.end(id, q, why); return; }
    this.prune(id, q);
    if (this.queues.get(id) !== q) return;
    const taken = batchOf(q.items);
    const off = () => taken.some((p) => p.dropped || !this.o.allowed(p.device));
    q.busy = true;
    let typed = false;
    let r: Refusal | null;
    try {
      r = await this.look(id, Date.now(), off);
      if (r === null) {
        if (this.o.host.answers.hold(id)) r = WORKING;
        else {
          try {
            // A prompt with images goes alone (batchOf): its images are the batch's.
            r = await this.typePrompt(id, taken.map((p) => p.text).join(SEPARATOR), taken.flatMap((p) => p.images), (key) => { typed = true; this.o.terms.answerKey(id, key); }, off);
          } finally {
            this.o.host.answers.release(id);
          }
        }
      }
    } catch (e) {
      this.o.host.log(`conversations: prompts waiting for terminal ${id} stopped (${reasonOf(e)})`);
      r = NOT_REACHED;
    } finally {
      q.busy = false;
    }
    if (r === null || typed) {
      q.items = q.items.filter((p) => !taken.includes(p));
      if (r) this.o.host.log(`conversations: prompts waiting for terminal ${id} stayed in Claude's prompt (${r.message})`);
      this.o.changed();
    }
    if (r?.code === 'not-found') { this.end(id, q, 'its terminal is gone'); return; }
    // Kept out by the computer too long: someone there is at it.
    const now = Date.now();
    q.heldSince = r && !typed && HELD.has(r) ? q.heldSince ?? now : null;
    if (q.heldSince !== null && now - q.heldSince >= this.o.outbox.staleMs) { this.end(id, q, 'text typed on the computer kept it out'); return; }
    this.prune(id, q);
    if (this.queues.get(id) !== q) return;
    // Sent with more waiting: Claude works on it now.
    q.seen = doing(this.o.host.terminal(id));
    q.gap = Math.min(q.gap * 2, this.o.outbox.slowMs);
    this.schedule(id, q);
  }

  /**
   * Why a prompt can't go into terminal `id` now, by the session and a fresh read of its screen; null when it can:
   * refused while the session waits, a dialog or a menu shows, the prompt isn't on screen or holds text, or a window
   * typed in the terminal since `started` or just before; WORKING while the screen shows Claude working, whatever the
   * hooks say. Idle, Claude asks nothing before a model's answer.
   */
  private async look(id: string, started: number, off: () => boolean): Promise<Refusal | null> {
    /** A window typed in the terminal since `started`, or just before. */
    const typedThere = () => { const at = this.o.terms.lastWindowInput(id); return at >= started || Date.now() - at < TYPED_RECENTLY_MS; };
    const before = free(this.o.host, id);
    if ('code' in before) return before;
    if (typedThere()) return TYPED;
    const view = await this.o.terms.screenView(id);
    // The session as it is now, with the screen just read.
    const now = free(this.o.host, id);
    if ('code' in now) return now;
    if (this.disposed || off()) return NOT_REACHED;
    if (typedThere()) return TYPED;
    if (readDialog(view, null)) return ANSWER_FIRST;
    const state = promptState(view);
    if (state === 'none') return NO_PROMPT;
    if (state === 'typed') return TYPED;
    if (claudeWorking(view)) return WORKING;
    return null;
  }

  /**
   * Types a prompt into Claude's empty prompt, once `look` finds nothing against it: each image's path alone as one
   * bracketed paste (Claude Code shows it as its `[Image #N]`), the next once a read shows the prompt holding one more
   * marker and nothing else; then the text as one bracketed paste (as Atelier's scheduled prompts do; after a space
   * when images came first, which Claude Code puts right after the last marker), and Enter once a read shows the
   * prompt holding the images and that text and nothing else. A marker waits imageCapMs at most, the text enterCapMs,
   * all of it typingCapMs (the terminal is held all that time). Nothing more is typed once the session waits or a
   * dialog shows, Claude starts a turn by itself (what was typed stays in the prompt), a window types, the session is
   * gone or `off()` says the prompt goes no more, or the prompt never shows what was pasted.
   */
  private async typePrompt(id: string, text: string, images: readonly PhoneImage[], type: (key: string) => void, off: () => boolean): Promise<Refusal | null> {
    const started = Date.now();
    const not = await this.look(id, started, off);
    if (not) return not;
    const from = { started, doing: doing(this.o.host.terminal(id)) };
    const clock = this.o.timing.now ?? Date.now;
    const by = clock() + this.o.timing.typingCapMs;
    for (let i = 0; i < images.length; i++) {
      type(promptPaste(images[i]!.path).join(''));
      const n = i + 1;
      const r = await this.shows(id, from, off, (v) => promptHolds(v, '', n), { capMs: this.o.timing.imageCapMs, by, late: IMAGE_NOT_REACHED });
      if (r) return r;
    }
    if (text !== '') {
      const pasted = images.length > 0 ? ` ${text}` : text;
      // One input: within the 16 KiB a prompt may take, the paste needs no chunks.
      type(promptPaste(pasted).join(''));
      const r = await this.shows(id, from, off, (v) => promptHolds(v, pasted, images.length), { capMs: this.o.timing.enterCapMs, by, late: NOT_REACHED });
      if (r) return r;
    }
    type('\r');
    return null;
  }

  /**
   * After a paste into terminal `id`'s prompt, typed since `from.started` with the session's hooks saying `from.doing`:
   * reads its screen until `holds` says the prompt shows what was pasted (null), for `capMs` after the paste and until
   * `by` at most (then `late`); else why nothing more may be typed (see typePrompt). A turn Claude started meanwhile
   * shows on screen as "esc to interrupt" only while its prompt is empty (text there takes the hint's place), so its
   * hooks tell too: running now, not when the typing began (an interrupt leaves them running, then the screen alone
   * tells).
   */
  private async shows(id: string, from: { started: number; doing: string }, off: () => boolean, holds: (view: ScreenView) => boolean, wait: { capMs: number; by: number; late: Refusal }): Promise<Refusal | null> {
    const { started } = from;
    const clock = this.o.timing.now ?? Date.now;
    const pasted = clock();
    const until = Math.min(pasted + wait.capMs, wait.by);
    await sleep(this.o.timing.enterMs);
    for (;;) {
      const shown = await this.o.terms.screenView(id);
      const t = sessionOf(this.o.host, id);
      if ('code' in t) return t;
      if (this.disposed || off()) return NOT_REACHED;
      if (waits(this.o.host, t) || readDialog(shown, null)) return MEANWHILE;
      if (claudeWorking(shown) || (from.doing !== 'running' && doing(t) === 'running')) return STARTED;
      // What a window typed may be in the prompt with the text: Enter would send it too.
      if (this.o.terms.lastWindowInput(id) >= started) return TYPED;
      if (holds(shown)) return null;
      if (clock() + this.o.timing.keyMs > until) return wait.late;
      await sleep(this.o.timing.keyMs);
    }
  }
}
