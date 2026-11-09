// A container's `GET /containers/{id}/json` as Docker answers it, from the world's spec.
// Served by the fake engine in tests (tests/support/fake-docker.ts) and fed to the app's own parsers at the
// demo's build time (compile/docker.ts): the same raw JSON for both. Node only (the ids are sha256 digests).
import { createHash } from 'node:crypto';
import type { ContainerSpec } from '../world/docker';

/** A container's id: the sha256 of its name (the e2e find containers by it). */
export const idOf = (name: string): string => createHash('sha256').update(name).digest('hex');

/** The Engine's inspect JSON for a spec; times not in the spec are taken around `now`. */
export function inspectOf(s: ContainerSpec, now = Date.now()): Record<string, unknown> {
  const labels: Record<string, string> = {};
  if (s.project) {
    labels['com.docker.compose.project'] = s.project;
    labels['com.docker.compose.service'] = s.service ?? s.name;
    if (s.workingDir) labels['com.docker.compose.project.working_dir'] = s.workingDir;
    labels['com.docker.compose.project.config_files'] = (s.configFiles ?? (s.workingDir ? [`${s.workingDir}/compose.yml`] : [])).join(',');
  }
  const state = s.state ?? 'running';
  const ports: Record<string, unknown> = {};
  for (const p of s.exposed ?? []) ports[`${p}/tcp`] = null;
  for (const p of s.ports ?? []) ports[`${p.container}/tcp`] = [{ HostIp: '0.0.0.0', HostPort: String(p.host) }, { HostIp: '::', HostPort: String(p.host) }];
  const containerName = s.project ? `${s.project}-${s.service ?? s.name}-1` : s.name;
  return {
    Id: idOf(containerName),
    Name: `/${containerName}`,
    Created: '2026-10-15T07:39:57.000Z',
    RestartCount: s.restarts ?? 0,
    State: {
      Status: state, Running: state === 'running', Paused: state === 'paused', Restarting: state === 'restarting', OOMKilled: !!s.oom, Dead: state === 'dead',
      ExitCode: state === 'running' ? 0 : s.exitCode ?? 0, Error: '',
      StartedAt: s.startedAt ?? new Date(now - 3 * 3600_000).toISOString(),
      FinishedAt: state === 'running' ? '0001-01-01T00:00:00Z' : s.finishedAt ?? new Date(now - 120_000).toISOString(),
      ...(s.health ? { Health: { Status: s.health, FailingStreak: 0, Log: [{ Start: new Date(now - 2000).toISOString(), End: new Date(now - 1900).toISOString(), ExitCode: s.health === 'unhealthy' ? 1 : 0, Output: s.health === 'unhealthy' ? 'connection refused' : 'ok' }] } } : {})
    },
    Image: `sha256:${createHash('sha256').update(s.image ?? s.name).digest('hex')}`,
    Config: {
      Image: s.image ?? `${s.name}:latest`, Tty: !!s.tty, Env: s.env ?? ['PATH=/usr/local/bin:/usr/bin'], Cmd: s.cmd ?? ['node', 'server.js'], Entrypoint: null, WorkingDir: '/app',
      ExposedPorts: Object.fromEntries([...(s.exposed ?? []), ...(s.ports ?? []).map((p) => p.container)].map((p) => [`${p}/tcp`, {}])),
      Labels: labels
    },
    HostConfig: { RestartPolicy: { Name: s.restartPolicy ?? 'no', MaximumRetryCount: s.restartPolicy === 'on-failure' ? 3 : 0 }, NetworkMode: s.project ? `${s.project}_default` : 'bridge' },
    NetworkSettings: { Ports: ports, Networks: { [s.project ? `${s.project}_default` : 'bridge']: { IPAddress: '172.19.0.4', Aliases: [containerName, s.service ?? s.name] } } },
    Mounts: (s.mounts ?? []).map((m) => ({ Type: m.type, Name: m.name, Source: m.source, Destination: m.target, RW: true }))
  };
}
