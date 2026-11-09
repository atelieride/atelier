// The Claude beats as the runtime plays them: what src/demo/compile/beats.ts makes of the
// authored beats in src/demo/world/beats.ts. The hook payloads are gone, replaced by what the app's reducers made of
// them at build time (session patches, the background work, the recent items); the runtime only stamps the times and
// the terminal's identity on them.
import type { BackgroundWork } from '@shared/background';
import type { RecentItem } from '@shared/background-recent';
import type { SessionInfo } from '@shared/session';
import type { TimelineEntry, TimelineMeta } from '@shared/transcript';
import type { PermissionView } from './claude-screen';

/** Time fields a step sets to "now" at runtime (they were build-clock times in the reducers' output). */
export type StampKey = 'updatedAt' | 'lastMessageAt';

/**
 * A session change, as the reducers made it: the public fields to set (always the state fields, then whatever else
 * changed), the ones to drop, and the times to stamp. `work`/`recent`: the terminal's background work and recently
 * ended items as main would attach them (only for sessions whose background changes; null removes them).
 */
export interface SessionPatch {
  set: Partial<SessionInfo>;
  drop?: string[];
  stamp: StampKey[];
  work?: BackgroundWork | null;
  recent?: RecentItem[] | null;
}

/** A menu Claude shows: a permission (a Bash command, or an edit) or a question, and where each answer leads. */
export type BeatAsk =
  | { kind: 'permission'; command?: string; view?: PermissionView; routes: string[]; cancel: string }
  | {
    kind: 'question'; options: string[]; routes: string[]; cancel: string;
    /** The option that lets the visitor type the answer ("Type something"): its route gets the text as {answer}. */
    typed?: number;
  };

/** One write to the working tree, attributed to the session (its terminal and colour stamped at runtime). */
export interface BeatWrite {
  /** Path relative to the project. */
  file: string;
  /** Applied in order to the file as it is now (the visitor may have edited it); none applies: the file is left. */
  replace?: [from: string, to: string][];
  /** Appended unless the file already ends with it. */
  append?: string;
  /** The whole file, when it does not exist yet. */
  content?: string;
}

export type BeatStep =
  | { k: 'session'; patch: SessionPatch }
  /** Transcript lines, streamed at a reading pace ({answer} and {prompt} filled in). */
  | { k: 'say'; lines: string[] }
  /** A tool's output lines, one every `every` ms. */
  | { k: 'out'; lines: string[]; every: number }
  /** The bottom area: Claude works (the spinner's text) or waits for a prompt. */
  | { k: 'spinner'; text: string }
  | { k: 'prompt' }
  | { k: 'ask'; ask: BeatAsk }
  | { k: 'write'; write: BeatWrite }
  | { k: 'wait'; ms: number }
  /** Waits until `ms` after the beat started (a beat in step with the background work's own clock). */
  | { k: 'until'; ms: number }
  /** The status line moved: cost and lines added/removed grow, the context changes (deltas). */
  | { k: 'cost'; usd: number; added: number; removed: number; context: number };

export interface CompiledBeat {
  /** The segment the beat starts with. */
  start: string;
  /** Named step lists: each ends the beat (a prompt) or asks (its answers route to other segments). */
  segments: Record<string, BeatStep[]>;
  /** Esc while Claude works: the session's change (none: the beat cannot be interrupted, background agents run). */
  interrupt?: SessionPatch;
}

/**
 * A followed item's feed, played on the engine's clock from the demo's start (`times`:
 * ms after it). A shell: its first `shown` lines at once, line `shown + i` at `times[i]`, the exit code after the last.
 * An agent: its timeline as TranscriptReader reads it after each step, `frames[0]` at once, `frames[i + 1]` at `times[i]`.
 * `rerun` (a test watcher): from `after` ms on, each change to a file matching `match` (a path relative to the project)
 * appends `lines`, {file} filled in, as vitest --watch prints a rerun.
 */
export type CompiledFeed =
  | { kind: 'output'; lines: string[]; shown: number; times: number[]; exit: number | null; rerun?: { after: number; match: string; lines: string[] } }
  | { kind: 'timeline'; frames: { entries: TimelineEntry[]; meta: TimelineMeta }[]; shown: number; times: number[] };

/** The beats' part of the compiled world. */
export interface DemoBeats {
  beats: Record<string, CompiledBeat>;
  /** Free prompts play these in turn. */
  generic: string[];
  /** The diagnosis beats for "send to session": the worker's crash, a failed job. */
  diagnose: { worker: string; job: string };
  /** What each scripted session plays (by terminal id), and whether it starts with the demo. */
  sessions: Record<string, { beat: string; auto: boolean }>;
  /** A new session: its state once Claude has started (stamped at runtime) and its welcome screen. */
  fresh: { session: SessionInfo; transcript: string[] };
  /** The Background inspector's feeds, by feedKey. */
  feeds: Record<string, CompiledFeed>;
  /** Crons' periods (terminal id → cron id → ms): the runtime moves `next` on when it passes. */
  crons: Record<string, Record<string, number>>;
  /** atelierd's identity colours in order: a new terminal takes the next one. */
  colors: string[];
}
