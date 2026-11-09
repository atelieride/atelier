import { describe, expect, test } from 'vitest';
import { COMMITS, FILES } from '../world/project';
import { SCENARIOS } from '../world/scenarios';
import { compileWorld } from './index';
import { DEMO_ROOT, T0 } from './sessions';

describe('compileWorld', () => {
  const world = compileWorld();

  test('plain JSON: what the virtual module serializes comes back the same', () => {
    expect(JSON.parse(JSON.stringify(world))).toEqual(world);
  });

  test('the project: HEAD is the committed files, the working tree has every session edit on top', () => {
    expect(world).toMatchObject({ t0: T0, project: { root: DEMO_ROOT, name: 'acme-store' }, head: FILES });
    expect(world.commits.map(({ oid: _oid, ...c }) => c)).toEqual(COMMITS);
    expect(world.commits.every((c) => /^[0-9a-f]{40}$/.test(c.oid))).toBe(true);
    expect(world.headOid).toBe(world.commits.at(-1)!.oid);
    for (const s of Object.values(SCENARIOS)) for (const e of s.edits) expect(world.files[e.file]).toBe(e.content);
    // Plus compose.yml (compile/scm.ts EXTRA_FILES), which the Docker view links to.
    expect(Object.keys(world.files).sort()).toEqual([...Object.keys(FILES), 'compose.yml'].sort());
    expect(world.head['compose.yml']).toBe(world.files['compose.yml']);
  });

  test('the startup tabs: every session, the waiting one with the permission in front (the overview shot)', () => {
    const auth = world.sessions.find((s) => s.scenario === 'auth-refactor')!;
    expect(world.tabs).toEqual({ order: world.sessions.map((s) => `t:${s.terminal.id}`), active: `t:${auth.terminal.id}` });
  });

  test('Docker and Redis for the footer and the activity bar', () => {
    expect(world.docker.snapshot.containers.length).toBeGreaterThan(0);
    expect(world.redis.snapshot.pick).toBe('tcp:6379');
  });
});
