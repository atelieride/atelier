import type { TerminalInfo } from '@shared/protocol';
import type { BackgroundItem } from '@shared/session';
import { WORK_CAP_MS, backgroundWork, matchShells, watchServer, type ProcArgs, type ServerWatch, type WorkScan } from '@shared/background';
import { isEphemeralPort } from '@shared/ports';
import { MAX_PIDS, descendants, type ListeningProc } from './procs/exec';

const POLL_MS = 3000;
/** The scan's pace when nothing counted depends on it (only servers, gone or capped items left). */
const IDLE_POLL_MS = 15_000;

export interface WorkDeps {
  readTree(): Promise<Map<number, number[]>>;
  readArgs(pids: number[]): Promise<ProcArgs[]>;
  readListening(pids: number[]): Promise<Map<number, ListeningProc>>;
  now?(): number;
  /** How long a listener must be seen before its shell is a server (SERVER_LISTEN_MS; shorter in e2e). */
  serverListenMs?: number;
}

/** The items a scan looks for: shells, monitors and other tasks with a command (agents are no process of their own). */
const scanned = (t: TerminalInfo): BackgroundItem[] => (t.session?.background?.items ?? []).filter((i) => i.kind !== 'agent' && !!i.command);
const isTarget = (t: TerminalInfo) => !!t.pid && scanned(t).length > 0;
/** A scan's content without its time: whether it changed. */
const contentKey = (scans: Record<string, WorkScan>) => JSON.stringify(Object.entries(scans).map(([id, s]) => [id, s.matched, s.servers, s.gone, s.ports ?? null]));

/**
 * The work scan: which of the sessions' background shells and monitors still run, and which are
 * servers. Every 3 s, whatever the windows' focus (a "Finished" matters most when you look elsewhere), and at once when
 * such items appear or change, but only while a terminal with a pid has some: otherwise no process is ever run. Per
 * terminal: the arguments of its descendants (at most MAX_PIDS) matched to the items' commands, then the listening
 * sockets of the matched shells' trees. A shell is a server once a non-ephemeral listener has been seen for 15 s in a
 * row (never for a test run), and stays one while its process runs (lsof no longer asks about it). A failed read keeps
 * the last scans (retried on the next tick).
 */
export class WorkHub {
  private terminals: TerminalInfo[] = [];
  private signature = '';
  private result: Record<string, WorkScan> = {};
  /** Per terminal: item ids matched by some scan, until the item leaves the session (then a missing process is "gone"). */
  private seen = new Map<string, Set<string>>();
  /** Per terminal: each matched shell's listener (servers), until it is unmatched or leaves. */
  private watches = new Map<string, Map<string, ServerWatch>>();
  private running = false;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;
  /** The scans changed (their content, not only their time). */
  onChange: (scans: Record<string, WorkScan>) => void = () => {};

  constructor(private readonly deps: WorkDeps) {}

  /** The terminals (capabilities applied): items that appear or change scan at once; none left stops the scans. */
  update(list: readonly TerminalInfo[]): void {
    this.terminals = [...list];
    const targets = this.terminals.filter(isTarget);
    this.forget(targets);
    const sig = JSON.stringify(targets.map((t) => [t.id, t.pid, scanned(t).map((i) => [i.id, i.command])]));
    if (sig === this.signature) return;
    this.signature = sig;
    if (targets.length === 0) { this.stop(); return; }
    // At once; the next one at the pace the new items need (a backed-off timer must not hold them for 15 s).
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    void this.scan();
  }

  scans(): Record<string, WorkScan> {
    return this.result;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  /** Drops what is remembered for terminals and items that are no longer there; their scans go at once. */
  private forget(targets: TerminalInfo[]): void {
    const live = new Map(targets.map((t) => [t.id, new Set(scanned(t).map((i) => i.id))]));
    for (const [id, set] of this.seen) {
      const items = live.get(id);
      if (!items) { this.seen.delete(id); continue; }
      for (const item of set) if (!items.has(item)) set.delete(item);
    }
    for (const [id, map] of this.watches) {
      const items = live.get(id);
      if (!items) { this.watches.delete(id); continue; }
      for (const item of [...map.keys()]) if (!items.has(item)) map.delete(item);
    }
    const kept = Object.fromEntries(Object.entries(this.result).filter(([id]) => live.has(id)));
    if (Object.keys(kept).length !== Object.keys(this.result).length) this.publish(kept);
  }

  private stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.seen.clear();
    this.watches.clear();
    this.publish({});
  }

  private schedule(): void {
    if (this.timer || this.disposed || !this.terminals.some(isTarget)) return;
    this.timer = setTimeout(() => { this.timer = null; void this.scan(); }, this.needed() ? POLL_MS : IDLE_POLL_MS);
    this.timer.unref?.();
  }

  /**
   * Whether some item that counts as work depends on the scan: one neither a server, nor gone, nor past the cap. With
   * only those left nothing a scan finds changes what counts, so it backs off.
   */
  private needed(): boolean {
    const now = this.deps.now?.() ?? Date.now();
    return this.terminals.filter(isTarget).some((t) => {
      const scan = this.result[t.id];
      const settled = new Set([...(scan?.servers ?? []), ...(scan?.gone ?? [])]);
      return scanned(t).some((it) => !settled.has(it.id) && now < it.since + WORK_CAP_MS + 1);
    });
  }

  private async scan(): Promise<void> {
    if (this.running) { this.again = true; return; }
    const targets = this.terminals.filter(isTarget);
    if (targets.length === 0 || this.disposed) return;
    this.running = true;
    try {
      const tree = await this.deps.readTree();
      const parent = new Map<number, number>();
      for (const [ppid, kids] of tree) for (const k of kids) parent.set(k, ppid);
      // Claude's background shells are below the terminal's own shell.
      const below = targets.map((t) => descendants(tree, t.pid!).slice(1));
      const pids = fairShare(below, MAX_PIDS);
      const read = new Set(pids);
      // A terminal with descendants past the cap may have its shells unread: nothing of it is "gone" in this scan.
      const cut = below.map((d) => d.some((pid) => !read.has(pid)));
      const procs = new Map((pids.length ? await this.deps.readArgs(pids) : []).map((p) => [p.pid, { ...p, ppid: parent.get(p.pid) ?? 0 }]));
      const matched = targets.map((t, i) => matchShells(scanned(t), below[i]!.flatMap((pid) => procs.get(pid) ?? [])));
      const watches = targets.map((t) => this.watches.get(t.id) ?? new Map<string, ServerWatch>());
      // A server stays one while its shell runs: its tree is not asked about again.
      const sticky = new Set(matched.flatMap((m, i) => Object.entries(m).filter(([id, pid]) => {
        const w = watches[i]!.get(id);
        return w?.server && w.pid === pid;
      }).map(([, pid]) => pid)));
      const shellTrees = new Map(matched.flatMap((m) => Object.values(m)).filter((pid) => !sticky.has(pid)).map((pid) => [pid, descendants(tree, pid)]));
      const lsofPids = [...new Set([...shellTrees.values()].flat())].slice(0, MAX_PIDS);
      const listening = lsofPids.length ? await this.deps.readListening(lsofPids) : new Map<number, ListeningProc>();
      const at = this.deps.now?.() ?? Date.now();
      const next: Record<string, WorkScan> = {};
      targets.forEach((t, i) => {
        const m = matched[i]!;
        const items = new Map(scanned(t).map((it) => [it.id, it]));
        const seen = this.seen.get(t.id) ?? new Set<string>();
        for (const id of seen) if (!items.has(id)) seen.delete(id);
        for (const id of Object.keys(m)) seen.add(id);
        this.seen.set(t.id, seen);
        // Servers: a listener seen for 15 s, sticky afterwards; an unmatched shell's watch ends (unless its terminal was
        // cut at the pid cap: it may just be unread).
        const w = watches[i]!;
        for (const id of [...w.keys()]) if (!(id in m) && (!cut[i] || !items.has(id))) w.delete(id);
        for (const [id, pid] of Object.entries(m)) {
          const ports = [...new Set((shellTrees.get(pid) ?? []).flatMap((p) => listening.get(p)?.ports ?? []))]
            .filter((port) => !isEphemeralPort(port)).sort((a, b) => a - b);
          w.set(id, watchServer(w.get(id), pid, ports.length > 0, items.get(id)!.command!, at, ports, this.deps.serverListenMs));
        }
        this.watches.set(t.id, w);
        // Cut at the pid cap: a still-listed shell whose kept watch is a server stays one (unread, not stopped).
        const unread = cut[i] ? [...w.keys()].filter((id) => !(id in m) && items.has(id)) : [];
        const servers = [...Object.keys(m), ...unread].filter((id) => w.get(id)!.server);
        // Cut at the pid cap: what was gone stays gone (still listed, not found now), so counting never flickers back.
        const gone = cut[i] ? (this.result[t.id]?.gone ?? []).filter((id) => items.has(id) && !(id in m)) : [...seen].filter((id) => !(id in m));
        const ports = Object.fromEntries(servers.map((id) => [id, w.get(id)?.ports ?? []]));
        next[t.id] = { at, matched: m, servers, gone, ...(servers.length ? { ports } : {}) };
      });
      // Terminals that lost their items while reading get nothing.
      const live = new Set(this.terminals.filter(isTarget).map((t) => t.id));
      this.publish(Object.fromEntries(Object.entries(next).filter(([id]) => live.has(id))));
    } catch {
      /* ps or lsof failed (timeout, output too large): keep the last scans, retry on the next tick */
    } finally {
      this.running = false;
      this.schedule();
      if (this.again) { this.again = false; void this.scan(); }
    }
  }

  private publish(next: Record<string, WorkScan>): void {
    if (contentKey(next) === contentKey(this.result)) return;
    this.result = next;
    this.onChange(next);
  }
}

/**
 * The longest wait of the work timer. A cron can fire up to a year ahead, and Node fires a timer longer than 2^31-1 ms
 * (~24.8 days) after 1 ms: the recomputation would re-arm the same delay in a tight loop. On waking early the hub just
 * recomputes and arms again.
 */
export const MAX_WORK_TIMER_MS = 24 * 60 * 60 * 1000;

/** One timer for the next change that only time brings (`BackgroundWork.nextChange`); arming replaces it. */
export class WorkTimer {
  private handle: NodeJS.Timeout | null = null;
  constructor(private readonly fire: () => void) {}
  arm(nextChange: number | null, now: number): void {
    this.clear();
    if (nextChange === null) return;
    this.handle = setTimeout(() => { this.handle = null; this.fire(); }, Math.min(MAX_WORK_TIMER_MS, Math.max(0, nextChange - now)));
    this.handle.unref?.();
  }
  clear(): void {
    if (this.handle) { clearTimeout(this.handle); this.handle = null; }
  }
}

/**
 * At most `max` pids from the lists, taken in turn (each list shallowest first, as `descendants` orders it), so a
 * terminal with a huge tree never starves the others. Each pid once.
 */
export function fairShare(lists: readonly number[][], max: number): number[] {
  const out = new Set<number>();
  for (let i = 0; out.size < max && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      if (out.size >= max) break;
      if (i < l.length) out.add(l[i]!);
    }
  }
  return [...out];
}

/**
 * Each terminal's work, only for sessions with a background field (an atelierd without the
 * capability has none: the list stays as today), and the earliest cap expiry: when to compute again. The items go on
 * without their raw commands: those are for matching in main only, the renderer never needs them.
 */
export function attachWork(list: readonly TerminalInfo[], scans: Record<string, WorkScan>, now: number, countAsWork: boolean): { list: TerminalInfo[]; nextChange: number | null } {
  let nextChange: number | null = null;
  const out = list.map((t) => {
    const bg = t.session?.background;
    if (!t.session || !bg) return t;
    const work = backgroundWork(t.session, scans[t.id] ?? null, now, { countAsWork });
    if (work.nextChange !== null && (nextChange === null || work.nextChange < nextChange)) nextChange = work.nextChange;
    const items = bg.items.map(({ command: _command, ...rest }) => rest);
    return { ...t, session: { ...t.session, background: { ...bg, items } }, work };
  });
  return { list: out, nextChange };
}
