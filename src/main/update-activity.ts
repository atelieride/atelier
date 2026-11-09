// Active installs without an identifier: the update check says whether it is the
// first successful check of this UTC day, ISO week and month. The site sums those flags; nothing else is sent.

export interface PeriodKeys { d: string; w: string; m: string }

/** The UTC day, ISO week (the week holding this date's Thursday, named after that Thursday's year) and month. */
export function periodKeys(ms: number): PeriodKeys {
  const t = new Date(ms);
  const d = t.toISOString().slice(0, 10);
  const fromMonday = (t.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - fromMonday + 3));
  const week = Math.floor((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / (7 * 86_400_000)) + 1;
  return { d, w: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`, m: d.slice(0, 7) };
}

/** The periods this check is the first of: each key not equal to the one last reported. */
export function activityParam(now: PeriodKeys, reported: Partial<PeriodKeys>): string {
  return (['d', 'w', 'm'] as const).filter((k) => reported[k] !== now[k]).join('');
}

/** The keys saved in updates/state.json; anything unexpected is forgotten (and so reported again). */
export function parseReported(v: unknown): Partial<PeriodKeys> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const out: Partial<PeriodKeys> = {};
  for (const k of ['d', 'w', 'm'] as const) {
    const s = o[k];
    if (typeof s === 'string' && s.length <= 10) out[k] = s;
  }
  return out;
}

/** The release list URL with `a` (always present, empty included: it tells new apps from old ones). */
export function withActivity(url: string, a: string): string {
  const u = new URL(url);
  u.searchParams.set('a', a);
  return u.href;
}
