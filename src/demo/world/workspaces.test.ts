import { expect, test } from 'vitest';
import { compileWorld } from '../compile';
import { MemoryStorage } from '../storage';
import { parseWorkspaces } from '../../renderer/workspaces';
import { WS_KEY } from '../../renderer/workspaces-save';
import { demoWorkspaces, seedWorkspaces } from './workspaces';

// Workspaces in the live demo: off as in the app, with four fronts ready for
// when the visitor turns them on, every session in one of them.

const world = compileWorld();

test('four workspaces, off; every session of the world belongs to one; the auth front first and in front', () => {
  const s = demoWorkspaces(world.sessions);
  expect(s.on).toBe(false);
  expect(s.list.map((w) => [w.name, w.color])).toEqual([['Auth & sessions', 1], ['Billing', 2], ['DB migration', 3], ['Docs & copy', 4]]);
  expect(s.active).toBe(s.list[0]!.id);
  const ids = world.sessions.map((x) => x.terminal.id).sort();
  expect(Object.keys(s.members).sort()).toEqual(ids);
  const byScenario = (n: string) => s.members[world.sessions.find((x) => x.scenario === n)!.terminal.id];
  expect(byScenario('auth-refactor')).toBe(s.list[0]!.id);
  expect(byScenario('billing-tests')).toBe(s.list[1]!.id);
  expect(byScenario('db-migration')).toBe(s.list[2]!.id);
  expect([byScenario('onboarding-copy'), byScenario('docs')]).toEqual([s.list[3]!.id, s.list[3]!.id]);
  // What the app reads back is exactly this (nothing dropped as junk).
  expect(parseWorkspaces(JSON.parse(JSON.stringify(s)))).toEqual(s);
});

test('seeded where the app reads them: the demo project’s entry in atelier.workspaces', () => {
  const storage = new MemoryStorage();
  seedWorkspaces(storage, world);
  const saved = JSON.parse(storage.getItem(WS_KEY)!) as Record<string, unknown>;
  expect(Object.keys(saved)).toEqual([world.project.root]);
  expect(parseWorkspaces(saved[world.project.root])).toEqual(demoWorkspaces(world.sessions));
});
