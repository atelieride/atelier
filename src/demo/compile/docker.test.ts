import { describe, expect, test } from 'vitest';
import { containerFromInspect, detailFromInspect } from '../../shared/docker';
import { dockerContainers } from '../world/docker';
import { idOf, inspectOf } from './docker-inspect';
import { compileDocker, compileDockerWorld } from './docker';
import { DEMO_ROOT, T0 } from './sessions';

// The containers through the app's own parsers at build time: the runtime gets DockerContainer /
// DockerDetail, never containerFromInspect / detailFromInspect.

describe('compileDocker', () => {
  const healthy = compileDocker(DEMO_ROOT, T0, { healthy: true });

  test('a running engine, as main detects the fake one (OrbStack)', () => {
    expect(healthy.snapshot.engine).toMatchObject({ state: 'running', name: 'OrbStack', version: '27.3.1', apiVersion: '1.47' });
  });

  test("the world's containers in the engine's order, parsed by the app's own parser", () => {
    const specs = dockerContainers(DEMO_ROOT, T0, { healthy: true });
    expect(healthy.snapshot.containers.map((c) => c.containerName)).toEqual(['acme-store-api-1', 'acme-store-web-1', 'acme-store-postgres-1', 'acme-store-redis-1', 'acme-store-worker-1', 'acme-store-mailpit-1', 'billing-sandbox-db-1', 'billing-sandbox-api-1', 'localstack']);
    specs.forEach((c, i) => {
      const raw = inspectOf(c.spec, T0);
      expect(healthy.snapshot.containers[i]).toEqual(containerFromInspect(raw));
      expect(healthy.details[healthy.snapshot.containers[i]!.id]).toEqual(detailFromInspect(raw));
    });
  });

  test('the overview: acme-store all up (docker 6/6) with the healthy worker', () => {
    const acme = healthy.snapshot.containers.filter((c) => c.project === 'acme-store');
    expect(acme).toHaveLength(6);
    expect(acme.every((c) => c.state === 'running')).toBe(true);
    expect(acme.every((c) => c.workingDir === DEMO_ROOT)).toBe(true);
  });

  test('the crashed worker for the Docker beat: exited 1 after three restarts', () => {
    const crashed = compileDocker(DEMO_ROOT, T0, { healthy: false });
    expect(crashed.snapshot.containers.find((c) => c.name === 'worker')).toMatchObject({ id: idOf('acme-store-worker-1'), state: 'exited', exitCode: 1, restarts: 3 });
  });

  test('stable: the same world gives the same snapshot', () => {
    expect(compileDocker(DEMO_ROOT, T0, { healthy: true })).toEqual(healthy);
  });
});

describe('compileDockerWorld (the runtime part: logs, disk usage, events, the crash)', () => {
  const w = compileDockerWorld(DEMO_ROOT, T0);
  const id = (name: string) => w.snapshot.containers.find((c) => c.name === name && c.project === 'acme-store')!.id;

  test("the overview snapshot (healthy) and every running container's lines before t0, oldest first", () => {
    expect(w.snapshot).toEqual(compileDocker(DEMO_ROOT, T0, { healthy: true }).snapshot);
    const api = w.logs[id('api')]!;
    expect(api.length).toBeGreaterThan(20);
    expect(api.every((l, i) => l.at < T0 && (i === 0 || l.at >= api[i - 1]!.at))).toBe(true);
    expect(api.some((l) => l.err && l.text.includes('session.ts:42'))).toBe(true);
  });

  test("disk usage through the app's dfSummary; events through eventEntry, newest first", () => {
    expect(w.df.images.count).toBeGreaterThan(0);
    expect(w.df.containers).toMatchObject({ count: 9, stopped: 2 });
    expect(w.events.map((e) => e.at)).toEqual([...w.events.map((e) => e.at)].sort((a, b) => b - a));
    expect(w.events).toContainEqual(expect.objectContaining({ type: 'container', action: 'start', name: 'acme-store-api-1', detail: 'acme/api:dev' }));
    expect(w.events).toContainEqual(expect.objectContaining({ action: 'health', detail: 'healthy', name: 'acme-store-postgres-1' }));
  });

  test("the crash: the worker as the app parses it once exited, its last lines, the events and the note's line", () => {
    expect(w.crash.container).toMatchObject({ id: id('worker'), state: 'exited', exitCode: 1, restarts: 3 });
    expect(w.crash.detail.env).toContainEqual({ key: 'REDIS_URL', value: 'redis://127.0.0.1:6379' });
    expect(w.crash.lines.at(-1)!.text).toBe('info: exiting with code 1 · restart limit reached');
    expect(w.crash.lines.map((l) => l.afterMs)).toEqual([...w.crash.lines.map((l) => l.afterMs)].sort((a, b) => a - b));
    expect(w.crash.events.map((e) => e.entry.action)).toEqual(['die', 'restart', 'start', 'die', 'restart', 'start', 'die', 'restart', 'start', 'die']);
    expect(w.crash.events.filter((e) => e.entry.action === 'die').every((e) => e.entry.detail === 'exit 1')).toBe(true);
    // The error itself (not its stack frame), as main's notify picks it.
    expect(w.crash.note).toBe('Error: connect ECONNREFUSED 127.0.0.1:6379');
  });
});
