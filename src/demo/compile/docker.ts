// The Docker world, compiled: the world's container specs become the Engine's
// inspect JSON (docker-inspect.ts, what the fake engine serves) and go through the app's own parsers, as main's
// DockerHub reads them; so do disk usage (dfSummary) and the events stream (eventEntry). The runtime gets the resulting
// DockerContainer / DockerDetail / DfSummary / DockerEventEntry and plays the live part (engine/docker.ts): new log
// lines, stats, and the worker's crash a little after the demo opens.
import { containerFromInspect, detailFromInspect, dfSummary, engineName, eventEntry, type DockerContainer, type DockerDetail, type DockerEventEntry, type DockerSnapshot } from '../../shared/docker';
import { isFrame, lineLevel } from '../../shared/docker-logs';
import { redactSecrets } from '../../shared/session';
import type { CompiledDocker, DemoLogLine } from '../types';
import { dockerContainers } from '../world/docker';
import { inspectOf } from './docker-inspect';

/** The fake engine's version and info (tests/support/fake-docker.ts): an OrbStack on Apple silicon. */
const VERSION = { Version: '27.3.1', ApiVersion: '1.47', Os: 'linux', Arch: 'arm64', Platform: { Name: 'Docker Engine - Community' } };
const INFO = { OperatingSystem: 'OrbStack', Name: 'orbstack', NCPU: 4, MemTotal: 8 * 1024 ** 3 };

export type { CompiledDocker };

/** `healthy`: the overview's stack (the worker runs); without it the worker has crashed (the Docker beat). */
export function compileDocker(root: string, t0: number, opts: { healthy: boolean }): Pick<CompiledDocker, 'snapshot' | 'details'> {
  const home = root.split('/').slice(0, 3).join('/');
  const socket = `${home}/.orbstack/run/docker.sock`;
  const containers: DockerContainer[] = [];
  const details: Record<string, DockerDetail> = {};
  for (const c of dockerContainers(root, t0, opts)) {
    const raw = inspectOf(c.spec, t0);
    const container = containerFromInspect(raw);
    const detail = detailFromInspect(raw);
    if (!container || !detail) throw new Error(`docker: ${c.key} does not parse`);
    containers.push(container);
    details[container.id] = detail;
  }
  const snapshot: DockerSnapshot = {
    engine: { state: 'running', socket, name: engineName(VERSION, INFO, socket), version: VERSION.Version, apiVersion: VERSION.ApiVersion, os: VERSION.Os, arch: VERSION.Arch, cpus: INFO.NCPU, memory: INFO.MemTotal },
    containers
  };
  return { snapshot, details };
}

/** One `/events` message as Docker sends it, through the app's eventEntry. */
function event(c: DockerContainer, action: string, at: number, attrs: Record<string, string> = {}): DockerEventEntry {
  const e = eventEntry({ Type: 'container', Action: action, Actor: { ID: c.id, Attributes: { name: c.containerName, image: c.image, ...attrs } }, time: Math.floor(at / 1000), timeNano: at * 1e6 });
  if (!e) throw new Error(`docker: event ${action} is not listed`);
  return e;
}

/** `GET /system/df` for the world (images, the stack's volumes, the containers' writable layers, a build cache). */
function dfRaw(containers: readonly DockerContainer[]): Record<string, unknown> {
  const images = [...new Set(containers.map((c) => c.image))];
  const GB = 1_000_000_000;
  return {
    LayersSize: 14.2 * GB,
    Images: [
      ...images.map((tag, i) => ({ Id: `sha256:${i}`, RepoTags: [tag], Size: [1.21, 0.18, 0.27, 0.12, 0.04, 0.26, 0.9, 1.4][i % 8]! * GB, Containers: containers.filter((c) => c.image === tag).length })),
      { Id: 'sha256:old1', RepoTags: ['acme/api:2026-09'], Size: 1.18 * GB, Containers: 0 },
      { Id: 'sha256:old2', RepoTags: ['<none>:<none>'], Size: 0.64 * GB, Containers: 0 }
    ],
    Containers: containers.map((c, i) => ({ Id: c.id, State: c.state, SizeRw: [48, 210, 12, 3, 31, 6, 9, 4, 120][i % 9]! * 1_000_000 })),
    Volumes: [
      { Name: 'acme_node_modules', UsageData: { Size: 412_000_000, RefCount: 1 } },
      { Name: 'acme_pgdata', UsageData: { Size: 96_000_000, RefCount: 1 } },
      { Name: 'billing_pgdata', UsageData: { Size: 1_300_000_000, RefCount: 0 } }
    ],
    BuildCache: [{ ID: 'b1', Size: 2.1 * GB, InUse: false, Shared: false }, { ID: 'b2', Size: 0.4 * GB, InUse: true, Shared: false }]
  };
}

/** The Docker world for the demo: the overview (healthy), its lines and events, and the crash to play. */
export function compileDockerWorld(root: string, t0: number): CompiledDocker {
  const { snapshot, details } = compileDocker(root, t0, { healthy: true });
  const crashed = compileDocker(root, t0, { healthy: false });
  const byKey = new Map(dockerContainers(root, t0, { healthy: true }).map((c, i) => [snapshot.containers[i]!.id, c]));
  const logs: Record<string, DemoLogLine[]> = {};
  for (const [id, c] of byKey) {
    if (!c.logs?.length) continue;
    const n = c.logs.length;
    // Bare lines: one second apart before t0, as the fake engine serves them.
    logs[id] = c.logs.map((l, i) => (typeof l === 'string' ? { at: t0 - (n - i) * 1000, err: false, text: l } : l)).filter((l) => l.at < t0);
  }

  const events: DockerEventEntry[] = [];
  for (const c of snapshot.containers) {
    if (c.startedAt && c.state === 'running') events.push(event(c, 'start', c.startedAt));
    if (c.health && c.startedAt) events.push(event(c, 'health_status: healthy', c.startedAt + 12_000));
    if (c.state === 'exited' && c.finishedAt) events.push(event(c, 'die', c.finishedAt, { exitCode: String(c.exitCode ?? 0) }));
  }
  events.sort((a, b) => b.at - a.at);

  // The crash: the worker's last lines as the crashed world has them, from its first one on.
  const workerId = snapshot.containers.find((c) => c.project === 'acme-store' && c.service === 'worker')!.id;
  const worker = crashed.snapshot.containers.find((c) => c.id === workerId)!;
  const raw = (dockerContainers(root, t0, { healthy: false }).find((c) => c.key === 'worker')!.logs ?? []) as DemoLogLine[];
  const lines = raw.map((l) => ({ afterMs: l.at - raw[0]!.at, err: l.err, text: l.text }));
  // Three restarts (on-failure:3) between the first refusal and the last: die, restart, start, …, die.
  const crashEvents: CompiledDocker['crash']['events'] = [];
  const last = lines.at(-1)!.afterMs;
  for (let k = 0; k < 4; k++) {
    const dieAt = k === 3 ? last + 100 : 300 + k * 1700;
    crashEvents.push({ afterMs: dieAt, entry: omitAt(event(worker, 'die', t0, { exitCode: '1' })) });
    if (k < 3) for (const [j, action] of (['restart', 'start'] as const).entries()) crashEvents.push({ afterMs: dieAt + 1200 + j * 100, entry: omitAt(event(worker, action, t0)) });
  }
  // main's notify: the last error-looking line that is not a stack frame, redacted, 200 characters at most.
  const errLine = [...lines].reverse().find((l) => !isFrame(l.text) && lineLevel(l.text, l.err ? 'err' : 'out') === 'error');
  const note = redactSecrets((errLine ?? lines.at(-1)!).text.trim()).slice(0, 200);

  return {
    snapshot, details, logs, df: dfSummary(dfRaw(snapshot.containers)), events,
    crash: { container: worker, detail: crashed.details[workerId]!, lines, events: crashEvents, note }
  };
}

const omitAt = ({ at: _at, ...rest }: DockerEventEntry): Omit<DockerEventEntry, 'at'> => rest;
