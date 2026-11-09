// The "5m ago" labels: each component showing one re-renders right when its label changes — at the
// minute, hour or day after the message (review minor: a wall-clock minute left "just now" up to a minute too long).
import { useEffect, useReducer } from 'react';
import { dayOf } from './schedule-view';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** When relativeTime(at, …) next changes: the next whole minute, hour or day since `at` (then once a day). */
export function nextLabelChange(at: number, now: number): number {
  const age = Math.max(0, now - at);
  const unit = age < HOUR ? MIN : age < DAY ? HOUR : DAY;
  return at + (Math.floor(age / unit) + 1) * unit;
}

/** The time now; with `at` (a message time), the component re-renders whenever its "ago" label changes. */
export function useAgo(at: number | null): number {
  const [n, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (at === null) return;
    // Capped: a sleeping Mac's timers drift, a day-long timeout would come late.
    const timer = setTimeout(tick, Math.min(HOUR, Math.max(50, nextLabelChange(at, Date.now()) - Date.now() + 20)));
    return () => clearTimeout(timer);
  }, [at, n]);
  return Date.now();
}

/**
 * The time now; while `on`, the component re-renders when the day turns, so a time written with its day ("tomorrow at
 * 01:30") drops the day at midnight. One timer per such component, none otherwise.
 */
export function useDayTurn(on: boolean): number {
  const [n, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!on) return;
    // Capped, as above.
    const timer = setTimeout(tick, Math.min(HOUR, Math.max(50, dayOf(Date.now(), 1) - Date.now() + 20)));
    return () => clearTimeout(timer);
  }, [on, n]);
  return Date.now();
}
