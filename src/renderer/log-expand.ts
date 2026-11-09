// Service log lines too long for their card: expanded one by one, or wrapped for the whole card. Pure.
import type { MenuItem } from './menu-model';
import { t } from './i18n/en';

/** The live line's key among the expanded ones (line keys are never negative). */
export const LIVE_KEY = -1;

/**
 * After a capture: an expanded live line that was committed (it is now the last line) stays expanded under its line
 * key (`seq - 1`); one that only grew stays as it is; one replaced by another live line is folded. The same set when
 * nothing changes.
 */
export function carryLive(expanded: ReadonlySet<number>, liveBefore: string, liveNow: string, lines: readonly string[], seq: number): ReadonlySet<number> {
  if (!expanded.has(LIVE_KEY)) return expanded;
  if (lines.length > 0 && lines[lines.length - 1] === liveBefore && liveNow !== liveBefore) {
    const next = new Set(expanded);
    next.delete(LIVE_KEY);
    next.add(seq - 1);
    return next;
  }
  if (liveNow.startsWith(liveBefore)) return expanded;
  const next = new Set(expanded);
  next.delete(LIVE_KEY);
  return next;
}

/** The expanded lines (by line key) with `key` expanded or folded: a new set, so React sees the change. */
export function toggleLine(expanded: ReadonlySet<number>, key: number): Set<number> {
  const next = new Set(expanded);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** A service card's context menu: wrap (the label says what it will do), then maximize or back to the grid. */
export function serviceMenu(o: { wrap: boolean; maximized: boolean; toggleWrap: () => void; toggleMax: () => void }): MenuItem[] {
  return [
    { id: 'svc-wrap', label: o.wrap ? t.logs.unwrapMenu : t.logs.wrapMenu, icon: 'wrap', run: o.toggleWrap },
    { id: 'svc-max', label: o.maximized ? t.logs.restoreMenu : t.logs.maximizeMenu, icon: 'maximize', run: o.toggleMax }
  ];
}
