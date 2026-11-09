/**
 * A self-paced loop's wake-ups from its session's transcript. Claude Code calls the line
 * format internal: only `assistant` lines with a ScheduleWakeup tool_use and `user` lines with its tool_result are read,
 * everything else is skipped, and a text that is mostly unparsable is reported as unrecognized. Pure.
 */
import type { LoopResult } from './background-feed';
import { cronNext } from './background';
import { LOOP_MAX_AHEAD_MS } from './loop';
import { redactSecrets } from './session';

export interface Wakeup {
  toolUseId: string;
  /** ms of the tool_use line, null without a valid timestamp. */
  at: number | null;
  delaySeconds: number | null;
  reason: string | null;
  prompt: string | null;
  /** ms Claude Code scheduled it for (its tool_result), null until that line is read. */
  scheduledFor: number | null;
  /** `ScheduleWakeup {stop: true}`: the loop ended here. */
  stop?: true;
}

/** The Checks list's length. */
export const LOOP_LAST = 5;
const LINE_MAX = 1024 * 1024;
const REASON_CHARS = 200;
const PROMPT_CHARS = 2000;
const MIN_LINES_TO_JUDGE = 20;
const TOOL = 'ScheduleWakeup';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** One line, no control characters, redacted, at most `max` code points. */
function clean(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const one = redactSecrets(v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim());
  if (!one) return null;
  const points = Array.from(one);
  return points.length > max ? `${points.slice(0, max - 1).join('').trimEnd()}…` : one;
}

export function parseWakeups(text: string): { wakeups: Wakeup[]; unrecognized: boolean } {
  const wakeups: Wakeup[] = [];
  const byId = new Map<string, Wakeup>();
  let lines = 0;
  let bad = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.length > LINE_MAX) continue;
    lines++;
    let j: unknown;
    try { j = JSON.parse(raw); } catch { bad++; continue; }
    if (!isObj(j) || !isObj(j.message) || !Array.isArray(j.message.content)) continue;
    if (j.type === 'assistant') {
      const at = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : NaN;
      for (const b of j.message.content) {
        if (!isObj(b) || b.type !== 'tool_use' || b.name !== TOOL || typeof b.id !== 'string' || byId.has(b.id)) continue;
        const input = isObj(b.input) ? b.input : {};
        const w: Wakeup = input.stop === true
          ? { toolUseId: b.id, at: Number.isFinite(at) ? at : null, delaySeconds: null, reason: null, prompt: null, scheduledFor: null, stop: true }
          : { toolUseId: b.id, at: Number.isFinite(at) ? at : null, delaySeconds: num(input.delaySeconds), reason: clean(input.reason, REASON_CHARS), prompt: clean(input.prompt, PROMPT_CHARS), scheduledFor: null };
        byId.set(b.id, w);
        wakeups.push(w);
      }
    } else if (j.type === 'user') {
      const result = isObj(j.toolUseResult) ? j.toolUseResult : null;
      for (const b of j.message.content) {
        if (!isObj(b) || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        const w = byId.get(b.tool_use_id);
        const at = num(result?.scheduledFor);
        if (!w || w.stop || at === null || at <= 0) continue;
        w.scheduledFor = at;
        // The delay Claude Code kept (clamped to [60, 3600] s), not the one asked for.
        w.delaySeconds = num(result?.clampedDelaySeconds) ?? w.delaySeconds;
      }
    }
  }
  return { wakeups, unrecognized: lines >= MIN_LINES_TO_JUDGE && bad * 2 > lines };
}

/** The oldest line timestamp a text holds (a transcript is written in order: the first one), or null. */
export function oldestStamp(text: string): number | null {
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.length > LINE_MAX) continue;
    try {
      const j: unknown = JSON.parse(raw);
      const at = isObj(j) && typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : NaN;
      if (Number.isFinite(at)) return at;
    } catch { /* a cut first line, or not a transcript line */ }
  }
  return null;
}

/**
 * The wake-up a cron stands for: the newest one scheduled inside the minute the cron's schedule names, within a
 * wake-up's reach of `now` (a dateless schedule names that minute every day: an earlier loop's is not this one).
 */
export function matchWakeup(wakeups: readonly Wakeup[], schedule: string, now: number): Wakeup | null {
  for (let i = wakeups.length - 1; i >= 0; i--) {
    const w = wakeups[i]!;
    if (w.scheduledFor === null || Math.abs(w.scheduledFor - now) > LOOP_MAX_AHEAD_MS + 60_000) continue;
    const minute = Math.floor(w.scheduledFor / 60_000) * 60_000;
    // The schedule's first match strictly after the minute before is that minute itself when it names it.
    if (cronNext(schedule, new Date(minute - 60_000))?.getTime() === minute) return w;
  }
  return null;
}

/**
 * The run a prompt belongs to: its consecutive wake-ups back to the last stop or another prompt, newest first.
 * `complete`: that boundary was seen; a run reaching the window's first wake-up may have started before it.
 */
export function loopRun(wakeups: readonly Wakeup[], prompt: string): { startedAt: number | null; checks: number; last: Wakeup[]; complete: boolean } {
  const run: Wakeup[] = [];
  let complete = false;
  for (let i = wakeups.length - 1; i >= 0; i--) {
    const w = wakeups[i]!;
    if (w.stop || w.prompt !== prompt) { complete = true; break; }
    run.push(w);
  }
  return { startedAt: run.length ? run[run.length - 1]!.at : null, checks: run.length, last: run.slice(0, LOOP_LAST), complete };
}

/** A cron's loop details from a transcript's text: its wake-up and the run up to it. `fromStart`: the whole file was read. */
export function loopDetail(text: string, schedule: string, now: number, fromStart = false): LoopResult {
  const { wakeups, unrecognized } = parseWakeups(text);
  if (unrecognized) return { ok: false, reason: 'format' };
  const w = matchWakeup(wakeups, schedule, now);
  if (!w) return { ok: false, reason: 'missing' };
  const run = w.prompt !== null ? loopRun(wakeups.slice(0, wakeups.indexOf(w) + 1), w.prompt) : { startedAt: w.at, checks: 1, last: [w], complete: false };
  return {
    ok: true,
    detail: {
      prompt: w.prompt, reason: w.reason, scheduledFor: w.scheduledFor, delaySeconds: w.delaySeconds,
      startedAt: run.startedAt, checks: run.checks, complete: run.complete || fromStart,
      last: run.last.map((x) => ({ at: x.at, delaySeconds: x.delaySeconds, reason: x.reason }))
    }
  };
}
