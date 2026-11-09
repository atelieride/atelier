import { afterEach, expect, test } from 'vitest';
import { MAX_WS_PROJECTS, WS_KEY, loadWorkspaces, saveWorkspaces } from './workspaces-save';
import type { WorkspacesState } from './workspaces';

// Workspaces are saved per project root in localStorage, like the pins and the split layout.

const g = globalThis as { localStorage?: unknown };
const prev = g.localStorage;
afterEach(() => { g.localStorage = prev; });
const memory = () => {
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
  return saved;
};
const S: WorkspacesState = {
  on: true, active: 'A',
  list: [{ id: 'A', name: 'Auth', color: 1, folder: null, order: ['t:a'], active: 't:a', layout: null }],
  members: { a: 'A' }
};

test('saved per project root under atelier.workspaces; one project does not touch another', () => {
  const saved = memory();
  saveWorkspaces('/p', S);
  saveWorkspaces('/q', { ...S, on: false });
  expect(loadWorkspaces('/p')).toEqual(S);
  expect(loadWorkspaces('/q')!.on).toBe(false);
  expect(loadWorkspaces('/r')).toBeNull();
  expect(Object.keys(JSON.parse(saved.get(WS_KEY)!))).toEqual(['/p', '/q']);
});

test('null removes the project\'s entry; junk in storage reads as nothing', () => {
  const saved = memory();
  saveWorkspaces('/p', S);
  saveWorkspaces('/p', null);
  expect(loadWorkspaces('/p')).toBeNull();
  saved.set(WS_KEY, '{not json');
  expect(loadWorkspaces('/p')).toBeNull();
  saved.set(WS_KEY, JSON.stringify({ '/p': { list: 'no' } }));
  expect(loadWorkspaces('/p')).toBeNull();
});

test('the least recently saved projects are forgotten past the limit; a save makes a project the newest', () => {
  memory();
  for (let i = 0; i < MAX_WS_PROJECTS; i++) saveWorkspaces(`/p${i}`, S);
  saveWorkspaces('/p0', S);
  saveWorkspaces('/new', S);
  expect(loadWorkspaces('/p1')).toBeNull();
  expect(loadWorkspaces('/p0')).toEqual(S);
  expect(loadWorkspaces('/new')).toEqual(S);
});

test('storage that throws never reaches the caller', () => {
  g.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
  expect(loadWorkspaces('/p')).toBeNull();
  expect(() => saveWorkspaces('/p', S)).not.toThrow();
});
