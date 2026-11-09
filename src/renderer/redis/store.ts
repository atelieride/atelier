// Redis view state: the instances and status from main, the keys scan and the open value, the
// queue lists, the live monitor, the sheets. A store of its own: monitor lines and TTL ticks don't re-render the app.
import { create } from 'zustand';
import type { ClientRow, KeyEntry, RedisSnapshot, RedisStatus, RedisValueReply, SlowEntry } from '@shared/redis';
import { markMisses, type MonitorLine } from '@shared/redis-monitor';
import type { JobInfo, JobState } from '@shared/redis-queues';

export interface ScanState {
  /** `<instance>|<db>|<match>`: a new one restarts the scan. */
  id: string;
  keys: KeyEntry[];
  cursor: string;
  total: number;
  scanned: number;
  done: boolean;
  running: boolean;
  /** Stopped at Settings › Redis › Keys per scan (Keep scanning goes on). */
  limited: boolean;
  at: number;
  error: string | null;
}

export interface ValueState { key: string; reply: RedisValueReply | null; at: number; loading: boolean; error: string | null; more: boolean }
export interface LiveLine extends MonitorLine { seq: number }

/** A write that can still be undone (the countdown pill). */
export interface UndoPill { id: string; text: string; at: number; ms: number }

export type Sheet =
  | { kind: 'delete'; keys: string[] }
  | { kind: 'deleteMatching'; pattern: string; label: string }
  | { kind: 'empty'; db: number; keys: number }
  | { kind: 'ttl'; key: string; x: number; y: number }
  | { kind: 'edit'; key: string; target: { kind: 'string' } | { kind: 'json' } | { kind: 'hash'; field: string; value: string } | { kind: 'list'; index: number; value: string } | { kind: 'zset'; member: string; score: number } }
  | { kind: 'job'; action: 'retry' | 'remove'; queue: string; job: JobInfo }
  | { kind: 'instances' };

interface RedisState {
  snap: RedisSnapshot | null;
  status: RedisStatus | null;
  setSnap(s: RedisSnapshot): void;
  setStatus(s: RedisStatus): void;
  db: number;
  setDb(db: number): void;
  filter: string;
  setFilter(f: string): void;
  ns: string | null;
  setNs(ns: string | null): void;
  key: string | null;
  setKey(key: string | null): void;
  noTtl: boolean;
  setNoTtl(v: boolean): void;
  scan: ScanState | null;
  setScan(s: ScanState | null): void;
  value: ValueState | null;
  setValue(v: ValueState | null): void;
  /** Masked values shown on purpose (cleared when the key changes). */
  revealed: ReadonlySet<string>;
  toggleReveal(id: string): void;
  /** JSON nodes the viewer folded or unfolded, by path. */
  folds: ReadonlySet<string>;
  toggleFold(path: string): void;
  queue: string | null;
  jobState: JobState;
  jobs: JobInfo[] | null;
  jobsLoading: boolean;
  job: { info: JobInfo; command: string | null } | null;
  jobId: string | null;
  allStacks: boolean;
  pickQueue(id: string | null, state?: JobState): void;
  setJobState(s: JobState): void;
  setJobs(j: JobInfo[] | null, loading?: boolean): void;
  setJob(j: { info: JobInfo; command: string | null } | null, id?: string | null): void;
  setAllStacks(v: boolean): void;
  lines: LiveLine[];
  misses: ReadonlySet<number>;
  paused: LiveLine[] | null;
  showReads: boolean;
  showWrites: boolean;
  showScripts: boolean;
  liveFilter: string;
  pushLines(lines: MonitorLine[]): void;
  clearLines(): void;
  setPaused(on: boolean): void;
  setLiveToggle(k: 'showReads' | 'showWrites' | 'showScripts', v: boolean): void;
  setLiveFilter(f: string): void;
  clients: ClientRow[];
  setClients(c: ClientRow[]): void;
  slow: { threshold: number | null; entries: SlowEntry[] } | null;
  setSlow(s: { threshold: number | null; entries: SlowEntry[] } | null): void;
  sheet: Sheet | null;
  setSheet(s: Sheet | null): void;
  undo: UndoPill | null;
  setUndo(u: UndoPill | null): void;
}

export const MAX_LINES = 2000;
let seq = 0;

export const useRedis = create<RedisState>((set, get) => ({
  snap: null,
  status: null,
  setSnap: (snap) => set({ snap }),
  // Main sends the samples only while the Overview or Live shows: without them, the last ones of the
  // same running instance stay, so the charts are drawn at once when the Overview opens again.
  setStatus: (status) => {
    const prev = get().status;
    const keep = status.samples.length === 0 && !!status.info && prev?.key === status.key && (prev?.samples.length ?? 0) > 0;
    set({ status: keep ? { ...status, samples: prev!.samples } : status });
  },
  db: 0,
  setDb: (db) => { if (db !== get().db) set({ db, ns: null, key: null, value: null, scan: null, queue: null, jobs: null, job: null, jobId: null }); },
  filter: '',
  setFilter: (filter) => set({ filter }),
  ns: null,
  setNs: (ns) => set({ ns, noTtl: false }),
  key: null,
  setKey: (key) => { if (key !== get().key) set({ key, revealed: new Set(), folds: new Set() }); },
  noTtl: false,
  setNoTtl: (noTtl) => set({ noTtl }),
  scan: null,
  setScan: (scan) => set({ scan }),
  value: null,
  setValue: (value) => set({ value }),
  revealed: new Set(),
  toggleReveal: (id) => { const n = new Set(get().revealed); if (n.has(id)) n.delete(id); else n.add(id); set({ revealed: n }); },
  folds: new Set(),
  toggleFold: (p) => { const n = new Set(get().folds); if (n.has(p)) n.delete(p); else n.add(p); set({ folds: n }); },
  queue: null,
  jobState: 'failed',
  jobs: null,
  jobsLoading: false,
  job: null,
  jobId: null,
  allStacks: false,
  pickQueue: (queue, state) => set({ queue, jobState: state ?? get().jobState, jobs: null, job: null, jobId: null, allStacks: false }),
  setJobState: (jobState) => set({ jobState, jobs: null, job: null, jobId: null }),
  setJobs: (jobs, loading = false) => set({ jobs, jobsLoading: loading }),
  setJob: (job, id) => set({ job, ...(id !== undefined ? { jobId: id, allStacks: false } : {}) }),
  setAllStacks: (allStacks) => set({ allStacks }),
  lines: [],
  misses: new Set(),
  paused: null,
  showReads: true,
  showWrites: true,
  showScripts: false,
  liveFilter: '',
  pushLines: (fresh) => {
    if (!fresh.length) return;
    const lines = [...get().lines, ...fresh.map((l) => ({ ...l, seq: ++seq }))];
    const kept = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;
    // A GET followed by the same client's SET of that key: a miss (cache-aside refill). Looked for near the end only.
    const tail = kept.slice(-400);
    const misses = new Set([...get().misses].filter((s) => s >= kept[0]!.seq));
    for (const i of markMisses(tail)) misses.add(tail[i]!.seq);
    set({ lines: kept, misses });
  },
  clearLines: () => set({ lines: [], misses: new Set(), paused: null }),
  setPaused: (on) => set({ paused: on ? get().lines : null }),
  setLiveToggle: (k, v) => set({ [k]: v } as Pick<RedisState, typeof k>),
  setLiveFilter: (liveFilter) => set({ liveFilter }),
  clients: [],
  setClients: (clients) => set({ clients }),
  slow: null,
  setSlow: (slow) => set({ slow }),
  sheet: null,
  setSheet: (sheet) => set({ sheet }),
  undo: null,
  setUndo: (undo) => set({ undo })
}));

/** The picked instance of this window. */
export const pickedOf = (s: Pick<RedisState, 'snap'>) => s.snap?.instances.find((i) => i.key === s.snap?.pick) ?? null;

/** A stable empty list for selectors (a new [] on each call would re-render forever). */
export const NONE: readonly never[] = Object.freeze([]);
