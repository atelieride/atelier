// The demo's world, compiled at build time: the fictional project, sessions,
// containers and Redis through the app's real pure functions, out as plain JSON for `virtual:demo-world`. Node only;
// nothing here reaches the bundle but its output.
import type { DemoWorld } from '../types';
import { COMMITS, FILES, PROJECT_NAME } from '../world/project';
import { SCENARIOS } from '../world/scenarios';
import { compileDemoBeats } from './beats';
import { compileDockerWorld } from './docker';
import { compileRedis, compileRedisWithQueues } from './redis';
import { EXTRA_FILES, commitOids, compileScm } from './scm';
import { DEMO_ROOT, T0, compileSessions } from './sessions';

export function compileWorld(): DemoWorld {
  const head = { ...FILES, ...EXTRA_FILES };
  const files = { ...head };
  for (const s of Object.values(SCENARIOS)) for (const e of s.edits) files[e.file] = e.content;
  const { sessions, usage, attributions, raw } = compileSessions(DEMO_ROOT, T0);
  const front = sessions.find((s) => s.scenario === 'auth-refactor') ?? sessions[0]!;
  const docker = compileDockerWorld(DEMO_ROOT, T0);
  const commits = commitOids(COMMITS);
  return {
    t0: T0,
    project: { root: DEMO_ROOT, name: PROJECT_NAME },
    head,
    files,
    commits,
    headOid: commits.at(-1)!.oid,
    scm: compileScm(commits, T0),
    sessions,
    beats: compileDemoBeats(DEMO_ROOT, T0, sessions, raw),
    tabs: { order: sessions.map((s) => `t:${s.terminal.id}`), active: `t:${front.terminal.id}` },
    usage,
    attributions,
    docker,
    redis: compileRedis(docker.snapshot.containers, T0)
  };
}

/**
 * The world the demo ships (`virtual:demo-world`): compileWorld plus the Redis queues, which main's own adapters read
 * asynchronously (compile/redis-queues.ts). Tests that don't need the queues use compileWorld.
 */
export async function compileDemoWorld(): Promise<DemoWorld> {
  const world = compileWorld();
  return { ...world, redis: await compileRedisWithQueues(world.docker.snapshot.containers, T0) };
}
