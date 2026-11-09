// Docker view state: the engine and containers from main, the logs and stats of what is on
// screen, the overview's events. A store of its own: log lines arriving many times a second don't re-render the app.
import { create } from 'zustand';
import type { DockerContainer, DockerDetail, DockerEventEntry, DockerSnapshot, EngineState, StatsSample } from '@shared/docker';
import type { DockerLogLine } from '@shared/docker-logs';

export interface LogBuffer { lines: DockerLogLine[]; ended: boolean; loaded: boolean }

interface DockerState {
  engine: EngineState;
  containers: DockerContainer[];
  /** The first snapshot arrived. */
  known: boolean;
  logs: Record<string, LogBuffer>;
  stats: Record<string, StatsSample[]>;
  events: DockerEventEntry[];
  setSnapshot(s: DockerSnapshot): void;
  /** A watch started: an empty buffer until main's copy arrives. */
  beginLogs(id: string): void;
  setLogs(id: string, lines: DockerLogLine[], ended: boolean, cap: number): void;
  appendLogs(id: string, lines: DockerLogLine[], ended: boolean, cap: number): void;
  dropLogs(id: string): void;
  setStats(map: Record<string, StatsSample[]>): void;
  addStats(id: string, sample: StatsSample): void;
  dropStats(id: string): void;
  setEvents(list: DockerEventEntry[]): void;
  pushEvent(e: DockerEventEntry): void;
  /** Inspect results by container (mounts for frame links, the Inspect view), refreshed when the container changes. */
  details: Record<string, { detail: DockerDetail; container: DockerContainer }>;
  loadDetail(id: string): Promise<void>;
}

export const STATS_KEPT = 60;
const MAX_EVENTS = 200;

export const useDocker = create<DockerState>((set, get) => ({
  engine: { state: 'absent' },
  containers: [],
  known: false,
  logs: {},
  stats: {},
  events: [],
  setSnapshot: (s) => set({ engine: s.engine, containers: s.containers, known: true }),
  beginLogs: (id) => set({ logs: { ...get().logs, [id]: { lines: [], ended: false, loaded: false } } }),
  setLogs: (id, lines, ended, cap) => {
    const cur = get().logs[id];
    if (!cur) return;
    // Lines pushed while main's copy was on its way are newer than its last: kept after it.
    const last = lines.at(-1)?.seq ?? 0;
    const merged = [...lines, ...cur.lines.filter((l) => l.seq > last)];
    // Whatever arrived after the copy knows better whether the stream ended.
    set({ logs: { ...get().logs, [id]: { lines: merged.slice(-cap), ended: cur.lines.length ? cur.ended : ended, loaded: true } } });
  },
  appendLogs: (id, lines, ended, cap) => {
    const cur = get().logs[id];
    if (!cur) return;
    const last = cur.lines.at(-1)?.seq ?? 0;
    const fresh = lines.filter((l) => l.seq > last);
    if (!fresh.length && cur.ended === ended) return;
    const all = fresh.length ? [...cur.lines, ...fresh] : cur.lines;
    set({ logs: { ...get().logs, [id]: { lines: all.length > cap ? all.slice(-cap) : all, ended, loaded: cur.loaded } } });
  },
  dropLogs: (id) => { const { [id]: _gone, ...rest } = get().logs; set({ logs: rest }); },
  setStats: (map) => set({ stats: { ...get().stats, ...map } }),
  addStats: (id, sample) => {
    const cur = get().stats[id] ?? [];
    const next = cur.length >= STATS_KEPT ? [...cur.slice(1 - STATS_KEPT), sample] : [...cur, sample];
    set({ stats: { ...get().stats, [id]: next } });
  },
  dropStats: (id) => { const { [id]: _gone, ...rest } = get().stats; set({ stats: rest }); },
  setEvents: (events) => set({ events: events.slice(0, MAX_EVENTS) }),
  pushEvent: (e) => set({ events: [e, ...get().events].slice(0, MAX_EVENTS) }),
  details: {},
  loadDetail: async (id) => {
    const r = await window.atelier.docker.inspect(id).catch(() => null);
    if (r) set({ details: { ...get().details, [id]: r } });
  }
}));
