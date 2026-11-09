// The beats' player: plays a compiled beat's segment step by step on the engine's clock — the
// session's ready-made state changes, text streamed at a reading pace, tool output line by line, edits to the working
// tree, menus that wait for the visitor. Everything a step changes goes through a host (engine/claude.ts), so this
// module only knows the order and the timing. Plus the pure helpers the host applies: a patch stamped on a terminal
// (a copy, never a reducer), the status line's totals, an edit applied to a file, and which beat a free prompt plays.
import type { TerminalInfo } from '@shared/protocol';
import type { BeatAsk, BeatStep, BeatWrite, CompiledBeat, DemoBeats, SessionPatch } from './beats-types';
import { clipVisible, visibleLength } from './claude-screen';
import type { Cancel, Clock } from './clock';

/** Characters revealed per frame and the frame's length: about 1 000 characters a second, a fast reader's pace. */
export const CHUNK = 40;
export const FRAME_MS = 40;
/** The pause after each line of text. */
export const LINE_MS = 70;

export type Vars = Record<string, string>;

/** `{name}` filled in from `vars` (the visitor's prompt, a typed answer); unknown names stay as they are. */
export const fill = (s: string, vars: Vars): string => s.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);

/** A line being streamed: its first `n` visible characters (claude-screen's clip). */
export const sliceVisible = clipVisible;

/** A session change stamped on a terminal: the compiled fields, the times set to now, the work and recent items. */
export function applyPatch(t: TerminalInfo, p: SessionPatch, now: number): TerminalInfo {
  if (!t.session) return t;
  const session: Record<string, unknown> = { ...t.session, ...p.set };
  for (const k of p.drop ?? []) delete session[k];
  for (const k of p.stamp) session[k] = now;
  const out: TerminalInfo = { ...t, session: session as unknown as TerminalInfo['session'] };
  if (p.work !== undefined) { if (p.work === null) delete out.work; else out.work = p.work; }
  if (p.recent !== undefined) { if (p.recent === null) delete out.recent; else out.recent = p.recent; }
  return out;
}

/** The status line moved on: cost and lines grow, the context fills (never past 100 %). */
export function applyCost(t: TerminalInfo, c: { usd: number; added: number; removed: number; context: number }): TerminalInfo {
  const s = t.session;
  if (!s) return t;
  const cost = s.cost ?? { usd: 0, linesAdded: 0, linesRemoved: 0 };
  return {
    ...t,
    session: {
      ...s,
      cost: { usd: Math.round((cost.usd + c.usd) * 100) / 100, linesAdded: cost.linesAdded + c.added, linesRemoved: cost.linesRemoved + c.removed },
      contextPct: Math.min(100, (s.contextPct ?? 0) + c.context)
    }
  };
}

/** The file after an edit, or null when it changes nothing (already there, or the text it edits is gone). */
export function applyWrite(current: string | undefined, w: BeatWrite, vars: Vars): string | null {
  if (current === undefined) return w.content !== undefined ? fill(w.content, vars) : null;
  let text = current;
  for (const [from, to] of w.replace ?? []) {
    if (!text.includes(from)) return null;
    text = text.replace(from, fill(to, vars));
  }
  if (w.append !== undefined) {
    const add = fill(w.append, vars);
    if (!text.endsWith(add)) text += add;
  }
  if (w.replace === undefined && w.append === undefined && w.content !== undefined) text = fill(w.content, vars);
  return text === current ? null : text;
}

// "Send to session": the Docker view sends the worker's log lines or its crash, the Redis view a failed
// job; both are pasted into the prompt, the visitor presses Enter. Keywords, not the exact text, so a few lines picked
// by hand or a later wording of the app's prompts still match.
const JOB = /ECONNREFUSED\s+127\.0\.0\.1:1025|send-(?:receipt|welcome)|email-queue|\b(?:BullMQ|Bull)\b[\s\S]*\bfailed\b/i;
const WORKER = /ECONNREFUSED\s+127\.0\.0\.1:6379|\bworker\b[\s\S]*\b(?:exit\w*|stop\w*|crash\w*|restart\w*|die[ds]?|down|ECONNREFUSED)\b/i;

/** The beat a submitted prompt plays: a diagnosis when it matches a known failure, else the next free-prompt beat. */
export function beatForPrompt(text: string, beats: Pick<DemoBeats, 'generic' | 'diagnose'>, turn: number): string {
  if (JOB.test(text)) return beats.diagnose.job;
  if (WORKER.test(text)) return beats.diagnose.worker;
  return beats.generic[turn % beats.generic.length]!;
}

/** What playing a beat changes, through the Claude screen that hosts it. */
export interface BeatHost {
  readonly clock: Clock;
  /** Appends a transcript line, or replaces the last one (a line still being streamed). */
  line(text: string, replaceLast: boolean): void;
  spinner(text: string): void;
  prompt(): void;
  ask(a: BeatAsk): void;
  session(p: SessionPatch): void;
  cost(c: { usd: number; added: number; removed: number; context: number }): void;
  write(w: BeatWrite): void;
  redraw(): void;
}

export interface Playing {
  cancel(): void;
  /** ms of clock time the beat has taken so far (its `until` steps count from its start). */
  readonly elapsed: number;
}

/**
 * Plays `segment` of `beat` from its first step. Stops at its end, or at an ask (the host routes the answer by playing
 * another segment, passing `elapsed` on). Every delay goes through the host's clock, so the page can pause it.
 */
export function play(host: BeatHost, beat: CompiledBeat, segment: string, vars: Vars, elapsed0 = 0): Playing {
  const steps: BeatStep[] = beat.segments[segment] ?? [];
  let pending: Cancel | null = null;
  let elapsed = elapsed0;
  let stopped = false;
  const later = (ms: number, fn: () => void) => {
    elapsed += ms;
    pending = host.clock.after(ms, () => { pending = null; if (!stopped) fn(); });
  };

  const run = (i: number): void => {
    if (stopped || i >= steps.length) return;
    const s = steps[i]!;
    const next = () => run(i + 1);
    switch (s.k) {
      case 'session': host.session(s.patch); return next();
      case 'cost': host.cost(s); return next();
      case 'write': host.write(s.write); return next();
      case 'spinner': host.spinner(s.text); host.redraw(); return next();
      case 'prompt': host.prompt(); host.redraw(); return next();
      case 'ask': host.ask(s.ask); host.redraw(); return;
      case 'wait': return later(s.ms, next);
      case 'until': return later(Math.max(0, s.ms - elapsed), next);
      case 'out': {
        const outLine = (k: number): void => {
          if (k >= s.lines.length) return next();
          host.line(fill(s.lines[k]!, vars), false);
          host.redraw();
          if (s.every > 0) later(s.every, () => outLine(k + 1)); else outLine(k + 1);
        };
        return outLine(0);
      }
      case 'say': {
        const sayLine = (k: number): void => {
          if (k >= s.lines.length) return next();
          const line = fill(s.lines[k]!, vars);
          const len = visibleLength(line);
          if (len === 0) { host.line(line, false); return sayLine(k + 1); }
          const reveal = (n: number): void => {
            host.line(sliceVisible(line, n), n > CHUNK);
            host.redraw();
            if (n < len) later(FRAME_MS, () => reveal(n + CHUNK));
            else later(LINE_MS, () => sayLine(k + 1));
          };
          reveal(CHUNK);
        };
        return sayLine(0);
      }
    }
  };
  run(0);
  return {
    cancel() { stopped = true; pending?.(); pending = null; },
    get elapsed() { return elapsed; }
  };
}
