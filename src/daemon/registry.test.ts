import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadRegistry, saveRegistry, toResumables, type RegistryFile } from './registry';
import { expectMode } from '../../tests/support/platform';

const f = () => join(mkdtempSync(join(tmpdir(), 'atl-reg-')), 'registry.json');
const term = (id: string, sessionId: string | null) => ({ id, projectRoot: '/p', cwd: '/p/app', name: null, title: `T ${id}`, color: '#B794F6', sessionId, state: 'done' as const, createdAt: 1 });

test('saves and reloads, 0600 permissions', () => {
  const file = f();
  const r: RegistryFile = { v: 1, terminals: [term('a', 's1')], resumables: [], attributions: [] };
  saveRegistry(file, r);
  expect(loadRegistry(file)).toEqual(r);
  expectMode(file, 0o600);
});
test('missing, corrupt, half-written, different version → empty', () => {
  const empty = { v: 1, terminals: [], resumables: [], attributions: [] };
  expect(loadRegistry(join(tmpdir(), 'non-esiste.json'))).toEqual(empty);
  for (const bad of ['{', '{"v":1,"terminals":[{"id":', '{"v":2,"terminals":[]}', 'null', '[]', '{"v":1,"terminals":"x"}']) {
    const file = f(); writeFileSync(file, bad);
    expect(loadRegistry(file)).toEqual(empty);
  }
});
test('malformed entries are discarded one by one', () => {
  const file = f();
  writeFileSync(file, JSON.stringify({ v: 1, terminals: [term('a', 's1'), { id: 3 }], resumables: [{ nope: true }], attributions: [] }));
  expect(loadRegistry(file).terminals.map((t) => t.id)).toEqual(['a']);
});
test('toResumables: only terminals with a session; old resumables stay; no duplicates', () => {
  const prev: RegistryFile = {
    v: 1, terminals: [term('a', 's1'), term('b', null)],
    resumables: [{ id: 'z', projectRoot: '/p', cwd: '/p', title: 'Z', color: '#fff', sessionId: 's9', endedAt: 1 }, { id: 'a', projectRoot: '/p', cwd: '/p', title: 'A', color: '#fff', sessionId: 's1', endedAt: 1 }],
    attributions: []
  };
  const r = toResumables(prev, 50);
  expect(r.map((x) => [x.id, x.sessionId])).toEqual([['z', 's9'], ['a', 's1']]);
});
test('profiles: kept when present, optional for entries written before profiles, carried to resumables', () => {
  const file = f();
  writeFileSync(file, JSON.stringify({ v: 1, terminals: [{ ...term('a', 's1'), profile: 'atelier' }, term('b', 's2'), { ...term('c', 's3'), profile: { shell: '/bin/bash' } }, { ...term('d', 's4'), profile: 'nope' }], resumables: [{ id: 'z', projectRoot: '/p', cwd: '/p', title: 'Z', color: '#fff', sessionId: 's9', endedAt: 1 }], attributions: [] }));
  const reg = loadRegistry(file);
  expect(reg.terminals.map((t) => [t.id, t.profile])).toEqual([['a', 'atelier'], ['b', undefined], ['c', { shell: '/bin/bash' }]]);
  expect(reg.resumables[0]!.profile).toBeUndefined();
  const r = toResumables(reg, 50);
  expect(Object.fromEntries(r.map((x) => [x.id, x.profile]))).toEqual({ z: undefined, a: 'atelier', b: undefined, c: { shell: '/bin/bash' } });
});

test('the config dir: kept and carried to resumables; a bad one is forgotten, the entry kept', () => {
  const file = f();
  const ops = '/Users/x/.claude_ops';
  writeFileSync(file, JSON.stringify({ v: 1, terminals: [{ ...term('a', 's1'), configDir: ops }, { ...term('b', 's2'), configDir: '/a/../etc' }, term('c', 's3'), { ...term('d', 's4'), configDir: 7 }], resumables: [{ id: 'z', projectRoot: '/p', cwd: '/p', title: 'Z', color: '#fff', sessionId: 's9', endedAt: 1, configDir: 'rel' }], attributions: [] }));
  const reg = loadRegistry(file);
  expect(reg.terminals.map((t) => [t.id, t.configDir])).toEqual([['a', ops], ['b', undefined], ['c', undefined], ['d', undefined]]);
  expect(reg.terminals.every((t) => t.configDir !== undefined || !('configDir' in t))).toBe(true);
  expect(reg.resumables.map((x) => x.id)).toEqual(['z']);
  expect(toResumables(reg, 50).map((x) => [x.id, x.configDir])).toEqual([['z', undefined], ['a', ops], ['b', undefined], ['c', undefined], ['d', undefined]]);
});
test('the last message time: kept in terminals and resumables, optional for older entries, carried to resumables', () => {
  const file = f();
  writeFileSync(file, JSON.stringify({ v: 1, terminals: [{ ...term('a', 's1'), lastMessageAt: 42 }, term('b', 's2'), { ...term('c', 's3'), lastMessageAt: 'x' }], resumables: [{ id: 'z', projectRoot: '/p', cwd: '/p', title: 'Z', color: '#fff', sessionId: 's9', endedAt: 1, lastMessageAt: 7 }], attributions: [] }));
  const reg = loadRegistry(file);
  expect(reg.terminals.map((t) => [t.id, t.lastMessageAt])).toEqual([['a', 42], ['b', undefined]]);
  const r = toResumables(reg, 50);
  expect(r.map((x) => [x.id, x.lastMessageAt])).toEqual([['z', 7], ['a', 42], ['b', undefined]]);
});
