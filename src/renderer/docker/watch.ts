// What this window shows of Docker, told to main: each view registers the containers whose
// logs or stats it shows; their union goes to main, which streams only those. A container leaving the union drops its
// copy here (main keeps logs a minute, so coming back is instant).
import { useEffect } from 'react';
import { useApp } from '../store';
import { useDocker } from './store';

type Kind = 'logs' | 'stats';
const wants: Record<Kind, Map<string, string[]>> = { logs: new Map(), stats: new Map() };
const sent: Record<Kind, Set<string>> = { logs: new Set(), stats: new Set() };
let pending = false;

const cap = () => useApp.getState().settings.dockerLogLines;

function flush(): void {
  pending = false;
  for (const kind of ['logs', 'stats'] as const) {
    // Within what main accepts: 64 log streams, 24 stats streams (the first asked for win).
    const next = new Set([...new Set([...wants[kind].values()].flat())].slice(0, kind === 'logs' ? 64 : 24));
    const prev = sent[kind];
    if (next.size === prev.size && [...next].every((id) => prev.has(id))) continue;
    sent[kind] = next;
    const added = [...next].filter((id) => !prev.has(id));
    const removed = [...prev].filter((id) => !next.has(id));
    const d = useDocker.getState();
    if (kind === 'logs') {
      for (const id of added) d.beginLogs(id);
      for (const id of removed) d.dropLogs(id);
      window.atelier.docker.watchLogs([...next]);
      for (const id of added) void window.atelier.docker.logs(id).then((b) => useDocker.getState().setLogs(id, b.lines, b.ended, cap())).catch(() => {});
    } else {
      for (const id of removed) d.dropStats(id);
      window.atelier.docker.watchStats([...next]);
      if (added.length) void window.atelier.docker.stats(added).then((m) => useDocker.getState().setStats(m)).catch(() => {});
    }
  }
}

function schedule(): void {
  if (pending) return;
  pending = true;
  queueMicrotask(flush);
}

/** This view shows these containers' logs (or stats) while mounted and `ids` stay the same. */
export function useDockerWatch(kind: Kind, key: string, ids: readonly string[]): void {
  const joined = ids.join(',');
  useEffect(() => {
    wants[kind].set(key, joined ? joined.split(',') : []);
    schedule();
    return () => { wants[kind].delete(key); schedule(); };
  }, [kind, key, joined]);
}

/** Lines pushed by main: only for containers this window watches. */
export function receiveLogs(e: { id: string; lines: import('@shared/docker-logs').DockerLogLine[]; ended: boolean }): void {
  if (sent.logs.has(e.id)) useDocker.getState().appendLogs(e.id, e.lines, e.ended, cap());
}
