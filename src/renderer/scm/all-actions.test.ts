import { afterEach, beforeEach, expect, test } from 'vitest';
import type { RepoStatus } from '@shared/git';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { useApp } from '../store';
import { pullAll, pushAll } from './all-actions';

// Sync All's ▾ in the All Repositories view: Pull All and Push All go one repository at a
// time and end with one toast; a failure or a question stops them there and speaks for itself.

const g = globalThis as { window?: unknown; localStorage?: unknown };
let calls: [string, ...unknown[]][];
let answers: Record<string, unknown>;
let release: (() => void) | null;

const st = (root: string, o: Partial<RepoStatus> = {}): RepoStatus => ({
  root, name: root.split('/').pop()!, branch: 'main', detached: false, ahead: 0, behind: 0, upstream: 'origin/main', changes: [], oid: 'a'.repeat(40), checkedAt: 1, truncated: 0, ...o
});

beforeEach(() => {
  calls = []; answers = {}; release = null;
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  const method = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); const a = answers[name]; return typeof a === 'function' ? (a as (...x: unknown[]) => unknown)(...args) : a ?? { outcome: 'ok' }; };
  g.window = { atelier: { git: Object.fromEntries(['pull', 'push', 'sync', 'facts', 'incoming'].map((n) => [n, method(n)])) } };
  answers.incoming = [];
  useApp.setState({
    settings: DEFAULT_SETTINGS, project: { root: '/p', name: 'p', realRoot: '/p' }, scmRepos: null, scmBulk: null,
    repos: [st('/p/a', { behind: 1 }), st('/p/b', { behind: 2 }), st('/p/c', { ahead: 1, behind: 1 }), st('/p/d', { ahead: 2 })],
    gitFacts: {}, gitOps: {}, gitResult: {}, gitSheet: null, toast: null, terminals: [], attributions: [],
    gitStageIntents: [], gitReposSeen: [], gitSyncIntents: []
  });
});
afterEach(() => { delete g.window; delete g.localStorage; });

const toast = () => useApp.getState().toast?.text;

test('Pull All: only the repositories just behind, one after the other, then one toast that names the diverged one left', async () => {
  await pullAll();
  expect(calls.filter((c) => c[0] === 'pull').map((c) => (c[1] as { root: string }).root)).toEqual(['/p/a', '/p/b']);
  expect(toast()).toBe('Pulled 2 repositories · 1 diverged: sync it on its own');
});

test("Pull All: a failure stops it there, and its own toast stays", async () => {
  answers.pull = (o: { root: string }) => (o.root === '/p/a' ? { outcome: 'network' } : { outcome: 'ok' });
  await pullAll();
  expect(calls.filter((c) => c[0] === 'pull')).toHaveLength(1);
  expect(toast()).toBe("Couldn't reach the remote.");
});

test('Push All: only the repositories just ahead, then one toast', async () => {
  await pushAll();
  expect(calls.filter((c) => c[0] === 'push').map((c) => (c[1] as { root: string }).root)).toEqual(['/p/d']);
  expect(toast()).toBe('Pushed 1 repository · 1 diverged: sync it on its own');
});

test('one run at a time: a second Pull All while the first runs does nothing; the run shows in the store', async () => {
  answers.pull = () => new Promise((r) => { release = () => r({ outcome: 'ok' }); });
  const first = pullAll();
  await new Promise((r) => setTimeout(r, 0));
  expect(useApp.getState().scmBulk).toBe('pull');
  await pullAll();
  expect(calls.filter((c) => c[0] === 'pull')).toHaveLength(1);
  release!();
  await new Promise((r) => setTimeout(r, 0));
  release!();
  await first;
  expect(useApp.getState().scmBulk).toBeNull();
});
