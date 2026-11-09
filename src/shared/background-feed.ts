// src/shared/background-feed.ts
/** What main's BackgroundHub sends for a followed item. */
import type { TimelineEntry, TimelineMeta } from './transcript';

export type Unavailable = 'missing' | 'unreadable' | 'outside' | 'format';
/** A shell's or monitor's output: `reset` replaces the buffer with `lines`, else they are appended. */
export interface OutputFeed { key: string; kind: 'output'; lines: string[]; live: string; reset: boolean; seq: number; dropped: number; exit: number | null; at: number; unavailable?: Unavailable }
/** A subagent's timeline: always the whole shown timeline (at most TIMELINE_SHOWN entries). */
export interface TimelineFeed { key: string; kind: 'timeline'; entries: TimelineEntry[]; meta: TimelineMeta; at: number; unavailable?: Unavailable }
export type BackgroundFeed = OutputFeed | TimelineFeed;
export type WatchResult = { ok: true } | { ok: false; reason: Unavailable };
export const feedKey = (terminalId: string, itemId: string): string => `${terminalId}:${itemId}`;

/** One wake-up of a self-paced loop, as the Checks list shows it. */
export interface LoopCheck { at: number | null; delaySeconds: number | null; reason: string | null }
/**
 * A self-paced loop's details from its session's transcript: the cron's wake-up and the run up to it, newest first.
 * `complete`: the run's start was read; otherwise it began before the part of the transcript read ("9+ checks").
 */
export interface LoopDetail {
  prompt: string | null; reason: string | null; scheduledFor: number | null; delaySeconds: number | null;
  startedAt: number | null; checks: number; complete: boolean; last: LoopCheck[];
}
export type LoopResult = { ok: true; detail: LoopDetail } | { ok: false; reason: Unavailable };
