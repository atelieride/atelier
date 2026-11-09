// The compiled world's times are around the build's clock (DemoWorld.t0); the demo moves them to the visitor's clock
// once, at startup. Pure: a copy with every time field shifted, found by key. A test walks the
// compiled world and fails on any time-like number under a key not listed here.

/** Fields holding a time in ms. */
export const TIME_MS_KEYS: ReadonlySet<string> = new Set([
  'updatedAt', 'lastMessageAt', 'createdAt', 'since', 'lastEvent', 'capEndsAt', 'idleSince', 'next', 'nextChange',
  'at', 'startedAt', 'finishedAt', 'created', 'checkedAt', 'endedAt', 'changedAt', 'callStart', 'callEnd', 'rdbLastSave',
  // A background agent's timeline (its last step, TimelineMeta).
  'lastAt',
  // A queue's job (JobInfo).
  'queuedAt', 'processedOn', 'finishedOn'
]);

/** Fields holding a time in seconds (Claude's rate-limit resets). */
export const TIME_S_KEYS: ReadonlySet<string> = new Set(['resetsAt', 'authorAt', 'committerAt']);

/** `value` with every time field moved by `deltaMs` (seconds fields by deltaMs / 1000, rounded). */
export function rebase<T>(value: T, deltaMs: number): T {
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === 'number') {
      if (TIME_MS_KEYS.has(key)) return v + deltaMs;
      if (TIME_S_KEYS.has(key)) return v + Math.round(deltaMs / 1000);
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value, '') as T;
}
