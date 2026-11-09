// Ask companion: which files the session changed after an answer was given.
import { isUnsure, type Attribution } from '../attribution';

/** Unique paths changed by `sessionId` strictly after `at`, in first-change order. Unsure attributions never count. */
export function changedAfter(attrs: readonly Attribution[], sessionId: string, at: number): string[] {
  const seen = new Set<string>();
  for (const a of attrs) {
    if (a.sessionId !== sessionId || isUnsure(a)) continue;
    const when = a.via === 'bash' && a.changedAt !== undefined ? a.changedAt : a.at;
    if (when > at) seen.add(a.path);
  }
  return [...seen];
}
