// docker.* in the demo: the compiled containers, details, disk usage and events (built at
// build time with the app's own parsers), with the live part — logs, stats, the worker's crash — from engine/docker.ts.
import type { AtelierApi } from '@shared/api';
import { createDockerEngine } from '../engine/docker';
import { resolved, type DemoContext } from './context';

/** The api, and the beat's trigger for the shell ("Things to try" brings the worker's crash forward). */
export function createDocker(ctx: DemoContext): { api: AtelierApi['docker']; crashNow(): void } {
  const d = createDockerEngine(ctx);
  const api: AtelierApi['docker'] = {
    snapshot: () => resolved(d.snapshot()),
    logs: (id) => resolved(d.logs(id)),
    watchLogs: (ids) => d.watchLogs(ids),
    watchStats: (ids) => d.watchStats(ids),
    stats: (ids) => resolved(d.stats(ids)),
    inspect: (id) => resolved(d.detail(id)),
    df: () => resolved(ctx.world.docker.df),
    events: () => resolved(d.events()),
    tail: (id, n) => resolved(d.tail(id, n))
  };
  return { api, crashNow: () => d.crashNow() };
}
