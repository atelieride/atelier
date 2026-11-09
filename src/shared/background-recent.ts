/**
 * Background items that just ended: main remembers, per terminal, the inspector entries
 * that left its list, for an hour and at most ten, so the Background tab can still show a finished test run. Kept in
 * memory only (lost when the app quits). A session that ends leaves everything it ran as recent ("Session
 * ended", recent items still shown); only a different session in the terminal starts over. Pure.
 */
import type { BackgroundKind } from './session';
import type { InspectorEntry } from './background';
import type { TerminalInfo } from './protocol';

/**
 * `sessionId` and `cwd`: the session the item ran in and its folder, so its files can still be found once the
 * terminal's session is gone.
 */
export interface RecentItem { id: string; kind: BackgroundKind; label: string; since: number; endedAt: number; exit: number | null; owner?: string; display?: string; sessionId: string; cwd: string }
export const RECENT_MAX = 10;
export const RECENT_TTL_MS = 60 * 60 * 1000;

type Ended = { terminalId: string; id: string; kind: BackgroundKind };

export class RecentBook {
  /** Per terminal: the last session seen in it (kept after it ended) and what it listed then. */
  private last = new Map<string, { sessionId: string; cwd: string; entries: InspectorEntry[] }>();
  private recent = new Map<string, RecentItem[]>();

  apply(list: TerminalInfo[], now: number): { list: TerminalInfo[]; ended: Ended[] } {
    const ended: Ended[] = [];
    const alive = new Set(list.map((t) => t.id));
    for (const id of [...this.last.keys()]) if (!alive.has(id)) { this.last.delete(id); this.recent.delete(id); }
    const fresh = (r: RecentItem[]) => r.filter((y) => now - y.endedAt <= RECENT_TTL_MS);
    const out = list.map((t) => {
      const prev = this.last.get(t.id);
      const sessionId = t.session?.sessionId;
      if (!sessionId) {
        // The session ended: what it still listed ended with it. The terminal keeps them (and the session they ran in)
        // until they expire or another session starts.
        let r = this.recent.get(t.id) ?? [];
        if (prev) {
          r = this.leave(t.id, prev, new Set(), r, now, ended);
          this.last.set(t.id, { ...prev, entries: [] });
        }
        r = fresh(r).slice(0, RECENT_MAX);
        if (r.length) this.recent.set(t.id, r); else this.recent.delete(t.id);
        return r.length ? { ...t, recent: r.slice() } : t;
      }
      if (prev && prev.sessionId !== sessionId) this.recent.delete(t.id);
      let r = this.recent.get(t.id) ?? [];
      const cwd = t.session?.cwd ?? t.cwd;
      if (!t.work) {
        // No work field (older atelierd, or a momentary list): report nothing as ended and keep what was tracked.
        r = fresh(r);
        this.recent.set(t.id, r);
        if (!prev || prev.sessionId !== sessionId) this.last.set(t.id, { sessionId, cwd, entries: [] });
        return r.length ? { ...t, recent: r.slice() } : t;
      }
      const entries = t.work.entries ?? [];
      const liveIds = new Set(entries.map((x) => x.id));
      if (prev && prev.sessionId === sessionId) r = this.leave(t.id, prev, liveIds, r, now, ended);
      // An id that is live again is no longer recent.
      r = fresh(r.filter((y) => !liveIds.has(y.id))).slice(0, RECENT_MAX);
      this.last.set(t.id, { sessionId, cwd, entries });
      this.recent.set(t.id, r);
      return r.length ? { ...t, recent: r.slice() } : t;
    });
    return { list: out, ended };
  }

  /** The previous entries that are not live any more, newest first in front of `r`; each reported in `ended`. */
  private leave(terminalId: string, prev: { sessionId: string; cwd: string; entries: InspectorEntry[] }, liveIds: Set<string>, r: RecentItem[], now: number, ended: Ended[]): RecentItem[] {
    let out = r;
    for (const x of prev.entries) {
      if (liveIds.has(x.id) || x.id.startsWith('subagent-')) continue;
      ended.push({ terminalId, id: x.id, kind: x.kind });
      const item: RecentItem = { id: x.id, kind: x.kind, label: x.label, since: x.since, endedAt: now, exit: null, ...(x.owner ? { owner: x.owner } : {}), ...(x.display ? { display: x.display } : {}), sessionId: prev.sessionId, cwd: prev.cwd };
      out = [item, ...out.filter((y) => y.id !== x.id)];
    }
    return out;
  }

  /** When the earliest recent item (any terminal) leaves its list: the work timer fires then so it goes on time. */
  nextExpiry(): number | null {
    let min: number | null = null;
    for (const r of this.recent.values()) for (const y of r) { const t = y.endedAt + RECENT_TTL_MS; if (min === null || t < min) min = t; }
    return min;
  }

  setExit(terminalId: string, id: string, exit: number): boolean {
    const r = this.recent.get(terminalId);
    const i = r?.findIndex((y) => y.id === id) ?? -1;
    if (!r || i < 0) return false;
    // Replace, never mutate: an array already handed out by apply() is a snapshot the caller may still compare.
    const next = r.slice();
    next[i] = { ...r[i]!, exit };
    this.recent.set(terminalId, next);
    return true;
  }
}
