// Scheduled prompts: a prompt typed and sent into one Claude session at a set
// minute. atelierd owns the list and sends them (it runs with the app closed); this module is the shared, pure part:
// the model, its validation, the one-per-minute rule and the decision taken on every tick.
import { z } from 'zod';
import type { TerminalInfo } from './protocol';
import type { Usage } from './session';
import { isLimitPaused, limitResetAt } from './limit-pause';
import { isWaiting } from './session-view';
import { isEditorOrPager, isShell } from './shells';

export type ScheduleStatus = 'pending' | 'armed' | 'sent' | 'skipped' | 'missed';
/**
 * Why a prompt waits (pending past its time), was skipped, missed or moved: Claude working (`busy`), asking a
 * permission or a question (`waiting`), text left unsent in its prompt (`draft`), someone typing there (`typing`),
 * Claude not in front (`not-claude`), the session gone (`closed`), atelierd not running at the time (`asleep`), the
 * account at a usage limit (`limit`), Claude refusing it for a limit right after it was sent (`limit-hit`).
 */
export type ScheduleReason = 'busy' | 'waiting' | 'draft' | 'typing' | 'not-claude' | 'closed' | 'asleep' | 'limit' | 'limit-hit';
export type IfBusy = 'wait' | 'skip';

export interface ScheduledPrompt {
  id: string;
  /** The terminal it was scheduled in. */
  terminalId: string;
  /** Claude's session id at that moment: the prompt follows a resumed session into its new terminal. */
  sessionId: string;
  projectRoot: string;
  /** The session's title when scheduled: shown once its terminal is gone. */
  title: string;
  text: string;
  /** Epoch ms, on a whole minute (Send Now sets it to the moment it was asked). */
  at: number;
  ifBusy: IfBusy;
  createdAt: number;
  status: ScheduleStatus;
  reason?: ScheduleReason;
  /** 'armed': sends at this time unless sent sooner (Send Now) or snoozed. */
  armedUntil?: number;
  /** The first tick that found it due: from then on it waits for Claude as long as it takes. */
  dueSince?: number;
  /** The time it had before a usage-limit move. */
  movedFrom?: number;
  /** Already put back once after Claude refused it for a usage limit. */
  limitRetried?: boolean;
  /** Send Now: sent as soon as Claude is free, without the countdown. */
  fired?: boolean;
  /** Send Anyway: the next send skips the usage gate once. */
  forceUsage?: boolean;
  /** When it was sent, skipped or missed. */
  doneAt?: number;
}

/** A prompt never sent this late after its time without asking. */
export const GRACE_MS = 15 * 60_000;
/** The countdown a focused window shows before sending. */
export const ARM_MS = 10_000;
/** Input in a terminal this recent means someone is typing there. */
export const TYPING_QUIET_MS = 10_000;
/** After a send into a terminal, the next one waits this long (Claude's UserPromptSubmit may not be in yet). */
export const SEND_GAP_MS = 15_000;
export const MAX_TEXT = 32_000;
export const MAX_ENTRIES = 200;
const DONE_KEEP_MS = 24 * 3600_000;
const MISSED_KEEP_MS = 7 * 24 * 3600_000;
const MIN = 60_000;

/** The prompt as it will be typed: control characters out (tab and newline stay), CRLF → LF, trailing blanks out. */
export function cleanPromptText(raw: string): string {
  let s = raw.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trimEnd();
  if (s.length > MAX_TEXT) {
    let end = MAX_TEXT;
    const last = s.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    s = s.slice(0, end).trimEnd();
  }
  return s;
}

export const minuteOf = (ms: number): number => Math.floor(ms / MIN) * MIN;

/** A prompt still to send (it waits for its session, resumed or not). */
export const pendingPrompt = (x: ScheduledPrompt) => x.status === 'pending' || x.status === 'armed';
const live = pendingPrompt;

/** Another live prompt of that terminal in the same minute (the one-per-minute rule), or null. */
export function clashOf(list: readonly ScheduledPrompt[], terminalId: string, at: number, exceptId?: string): ScheduledPrompt | null {
  const m = minuteOf(at);
  return list.find((x) => x.id !== exceptId && x.terminalId === terminalId && live(x) && minuteOf(x.at) === m) ?? null;
}

/** `at` (on its minute) or the first time after it, `step` apart, with no clash. */
export function nextFreeMinute(list: readonly ScheduledPrompt[], terminalId: string, at: number, step = 5 * MIN, exceptId?: string): number {
  let t = minuteOf(at);
  for (let i = 0; i < 10_000 && clashOf(list, terminalId, t, exceptId); i++) t += step;
  return t;
}

// Moved to limit-pause.ts; re-exported so existing imports keep working.
export { limitResetAt };

export interface DecideCtx {
  /** The live terminal (by id, else the one whose session has the prompt's session id); null when none. */
  term: TerminalInfo | null;
  /** The limits of that terminal's Claude account. */
  usage: Usage | null;
  /** Claude turned bracketed paste on in that screen. */
  bracketed: boolean;
  /** Something typed into that prompt and not sent. */
  draft: boolean;
  lastInputAt: number;
  /** When atelierd last sent a scheduled prompt into that terminal (0: never). */
  lastSentAt: number;
  /** An app is connected: it may show the countdown. */
  clients: boolean;
}

export type Decision =
  | { kind: 'none' }
  | { kind: 'wait'; reason: ScheduleReason }
  | { kind: 'arm' }
  | { kind: 'send' }
  | { kind: 'move'; to: number }
  | { kind: 'skip'; reason: ScheduleReason }
  | { kind: 'missed'; reason: ScheduleReason };

/** Why Claude's prompt isn't free in that terminal now, or null. */
function gate(c: DecideCtx, now: number, fired: boolean): ScheduleReason | null {
  const t = c.term!;
  const s = t.session;
  // The rule of the app's remote commands (renderer/remote.ts): a session, with neither the shell nor an editor in front.
  if (!s || isShell(t.foreground) || isEditorOrPager(t.foreground)) return 'not-claude';
  if (isWaiting(s)) return 'waiting';
  if (s.state === 'running') return 'busy';
  // A usage-limit pause: Claude Code continues its own prompt at the reset, so nothing goes in meanwhile.
  if (isLimitPaused(s)) return 'busy';
  // Send Now goes past the draft guess: you asked for it while looking at the session.
  if (c.draft && !fired) return 'draft';
  if (now - c.lastInputAt < TYPING_QUIET_MS) return 'typing';
  if (!c.bracketed) return 'busy';
  if (c.lastSentAt && now - c.lastSentAt < SEND_GAP_MS) return 'busy';
  return null;
}

/** What to do with a prompt now; the caller applies it. */
export function decide(p: ScheduledPrompt, c: DecideCtx, now: number): Decision {
  if (!live(p)) return { kind: 'none' };
  if (p.at > now && !p.fired) return { kind: 'none' };
  // A fired prompt's grace runs from the moment it was fired, not from its scheduled time.
  const late = now - (p.fired ? p.dueSince ?? now : p.at) > GRACE_MS;
  if (p.dueSince === undefined && late && p.status === 'pending' && !p.fired) return { kind: 'missed', reason: 'asleep' };
  if (!c.term) return late ? { kind: 'missed', reason: 'closed' } : { kind: 'wait', reason: 'closed' };
  const reset = p.forceUsage ? null : limitResetAt(c.usage, now);
  if (reset !== null) return p.ifBusy === 'skip' && !p.fired ? { kind: 'skip', reason: 'limit' } : { kind: 'move', to: minuteOf(reset) + MIN };
  const why = gate(c, now, !!p.fired);
  if (why === 'not-claude') return late ? { kind: 'missed', reason: 'not-claude' } : { kind: 'wait', reason: 'not-claude' };
  if (why) {
    // Typing passes in seconds and a send just made only waits for Claude to take it: neither is a reason to skip; nor
    // is anything for a prompt you sent yourself (Send Now): it waits for Claude like a "wait" one.
    if (p.ifBusy === 'skip' && !p.fired && why !== 'typing' && !(why === 'busy' && c.lastSentAt && now - c.lastSentAt < SEND_GAP_MS)) return { kind: 'skip', reason: why };
    return { kind: 'wait', reason: why };
  }
  if (p.fired) return { kind: 'send' };
  if (p.status === 'armed') return (p.armedUntil ?? 0) <= now ? { kind: 'send' } : { kind: 'none' };
  return c.clients ? { kind: 'arm' } : { kind: 'send' };
}

/** Finished entries go after a while (sent/skipped 24 h: the popover's "Sent today" keeps the whole day, missed 7 days); past the cap the oldest finished go first. */
export function pruneSchedules(list: readonly ScheduledPrompt[], now: number): ScheduledPrompt[] {
  const kept = list.filter((x) => {
    if (live(x)) return true;
    const keep = x.status === 'missed' ? MISSED_KEEP_MS : DONE_KEEP_MS;
    return now - (x.doneAt ?? x.at) < keep;
  });
  if (kept.length <= MAX_ENTRIES) return kept;
  const finished = kept.filter((x) => !live(x)).sort((a, b) => (a.doneAt ?? a.at) - (b.doneAt ?? b.at));
  const drop = new Set(finished.slice(0, kept.length - MAX_ENTRIES).map((x) => x.id));
  return kept.filter((x) => !drop.has(x.id));
}

const REASONS = ['busy', 'waiting', 'draft', 'typing', 'not-claude', 'closed', 'asleep', 'limit', 'limit-hit'] as const;
const idStr = z.string().min(1).max(64);
const time = z.number().int().nonnegative().max(8.64e15);
export const ifBusySchema = z.enum(['wait', 'skip']);
const textSchema = z.string().max(MAX_TEXT * 2).transform(cleanPromptText).refine((s) => s.trim().length > 0, 'empty prompt');

export const scheduledPromptSchema: z.ZodType<ScheduledPrompt> = z.object({
  id: idStr, terminalId: idStr, sessionId: z.string().min(1).max(128), projectRoot: z.string().min(1).max(4096),
  title: z.string().max(200), text: textSchema, at: time, ifBusy: ifBusySchema, createdAt: time,
  status: z.enum(['pending', 'armed', 'sent', 'skipped', 'missed']), reason: z.enum(REASONS).optional(),
  armedUntil: time.optional(), dueSince: time.optional(), movedFrom: time.optional(), limitRetried: z.boolean().optional(),
  fired: z.boolean().optional(), forceUsage: z.boolean().optional(), doneAt: time.optional()
}).strict() as unknown as z.ZodType<ScheduledPrompt>;

/** The saved file (`{ v: 1, list }`): entries checked one by one, broken ones dropped. */
export function parseSchedules(raw: unknown): ScheduledPrompt[] {
  if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return [];
  const list = (raw as { list?: unknown }).list;
  if (!Array.isArray(list)) return [];
  const out: ScheduledPrompt[] = [];
  const ids = new Set<string>();
  for (const x of list) {
    const r = scheduledPromptSchema.safeParse(x);
    if (r.success && !ids.has(r.data.id)) { ids.add(r.data.id); out.push(r.data); }
  }
  return out.slice(0, MAX_ENTRIES);
}

/** Request fields (protocol and IPC). */
export const scheduleAddFields = { terminalId: idStr, text: textSchema, at: time, ifBusy: ifBusySchema };
export const scheduleUpdateFields = { id: idStr, text: textSchema.optional(), at: time.optional(), ifBusy: ifBusySchema.optional() };

// The Enter after the paste (the app's enterWhenSettled rule, task-session.ts): never before ENTER_FLOOR_MS, then as
// soon as the screen has been quiet for ENTER_QUIET_MS (Claude has drawn the paste), at ENTER_CAP_MS at the latest.
export const ENTER_FLOOR_MS = 250;
export const ENTER_QUIET_MS = 150;
export const ENTER_CAP_MS = 2000;
const PASTE_CHUNK = 256 * 1024;

/** The prompt as one bracketed paste, newlines as \r (new lines inside Claude's prompt), in chunks for the input cap. */
export function promptPaste(text: string): string[] {
  const body = text.replace(/\n/g, '\r');
  const parts: string[] = [];
  for (let i = 0; i < body.length;) {
    let end = Math.min(body.length, i + PASTE_CHUNK);
    const last = body.charCodeAt(end - 1);
    if (end < body.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    parts.push(body.slice(i, end));
    i = end;
  }
  return ['\x1b[200~', ...parts, '\x1b[201~'];
}
