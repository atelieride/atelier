import { afterEach, expect, test } from 'vitest';
import { useApp } from '../store';
import { copy } from './actions';

const g = globalThis as { window?: unknown };
afterEach(() => { delete g.window; });

test('copying a SHA confirms it with an info toast, never the error tone', async () => {
  g.window = { atelier: { clipboard: { write: async () => true } } };
  useApp.setState({ toast: null });
  copy('a'.repeat(40), 'Copied aaaaaaa');
  await new Promise((r) => setTimeout(r, 0));
  expect(useApp.getState().toast).toMatchObject({ text: 'Copied aaaaaaa', tone: 'info' });
});

import { fetchAll, fetchRepo, fetchSelected } from './actions';
import type { ScmFetchAnswer } from '@shared/scm';

function fakeFetch(answer: Partial<ScmFetchAnswer>, all: string[] = []) {
  const calls: unknown[] = [];
  g.window = { atelier: { scm: {
    fetchRepo: async (root: string, reason: string) => { calls.push([root, reason]); return { state: { common: `${root}/.git`, running: false, last: null }, outcome: null, ...answer }; },
    fetchAll: async () => all
  } } };
  useApp.setState({ toast: null, scmFetch: {} });
  return calls;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('manual fetch: no toast when it worked, the state is kept', async () => {
  const calls = fakeFetch({ outcome: 'ok', state: { common: '/p/.git', running: false, last: { outcome: 'ok', at: 1 } } });
  await fetchRepo('/p', 'manual');
  expect(calls).toEqual([['/p', 'manual']]);
  expect(useApp.getState().toast).toBeNull();
  expect(useApp.getState().scmFetch['/p/.git']).toMatchObject({ last: { outcome: 'ok' } });
});

test.each([
  ['network', undefined, "Couldn't reach the remote."],
  ['busy', 'cannot lock ref', 'Git is busy in this repository. Try again in a moment.'],
  ['auth', 'Authentication failed', 'Fetch needs sign-in: Authentication failed'],
  ['error', 'boom', 'Fetch failed: boom']
] as const)('manual fetch, %s: an error toast with Try Again', async (outcome, message, text) => {
  fakeFetch({ outcome, ...(message ? { message } : {}) });
  await fetchRepo('/p', 'manual');
  const toast = useApp.getState().toast as { text: string; tone?: string; action?: { label: string } } | null;
  expect(toast?.text).toBe(text);
  expect(toast?.tone).toBeUndefined();
});

test('a view fetch never shows a toast, whatever happened', async () => {
  fakeFetch({ outcome: 'error', message: 'boom' });
  await fetchRepo('/p', 'view');
  expect(useApp.getState().toast).toBeNull();
});

test('Fetch All Repositories: how many, how many failed, or nothing to fetch', async () => {
  fakeFetch({}, []);
  await fetchAll();
  expect(useApp.getState().toast).toMatchObject({ text: 'No repository with a remote to fetch', tone: 'info' });
  fakeFetch({}, ['ok', 'ok']);
  await fetchAll();
  expect(useApp.getState().toast).toMatchObject({ text: 'Fetched 2 repositories', tone: 'info' });
  fakeFetch({}, ['ok', 'auth', 'network']);
  await fetchAll();
  const toast = useApp.getState().toast as { text: string; tone?: string };
  expect(toast.text).toBe('Fetched 1 of 3 repositories · 2 failed');
  expect(toast.tone).toBeUndefined();
  await tick();
});

test('M7: Git › Fetch on a repository without a remote says so instead of doing nothing', async () => {
  const calls = fakeFetch({ outcome: 'ok' });
  const refs = { root: '/p', head: { branch: 'main', oid: null, detached: false }, refs: [], defaultBranch: null, shallow: false, fetchedAt: null, remotes: [], hasRemote: false, emptyTree: '' };
  useApp.setState({ scmRepos: [{ root: '/p', rel: '', name: 'p', worktreeOf: null, nestedIn: null, common: '/p/.git', status: null }], scmRepo: '/p', scmRefs: { '/p': refs } });
  fetchSelected();
  await tick(); await tick();
  expect(calls).toEqual([]);
  expect(useApp.getState().toast).toMatchObject({ text: 'No remote to fetch from', tone: 'info' });
  useApp.setState({ scmRefs: { '/p': { ...refs, remotes: ['origin'], hasRemote: true } } });
  fetchSelected();
  await tick(); await tick();
  expect(calls).toEqual([['/p', 'manual']]);
});

import { hideRepo, repoMenu } from './actions';
import type { ScmRepoEntry } from '@shared/scm';

const entry = (root: string, rel: string, extra: Partial<ScmRepoEntry> = {}): ScmRepoEntry => ({ root, rel, name: rel.split('/').at(-1) || 'p', worktreeOf: null, nestedIn: null, common: `${root}/.git`, status: null, ...extra });
const ids = (root: string) => repoMenu(root).map((m) => (m === 'sep' ? 'sep' : m.id));

test('Hide This Repository: offered for a repository inside the project, never for its root or a linked worktree', () => {
  useApp.setState({ scmRepos: [entry('/p', ''), entry('/p/agent/data/repo', 'agent/data/repo'), entry('/p/wt', 'wt', { linked: true }), entry('/p/.claude/worktrees/x', '.claude/worktrees/x', { worktreeOf: '/p' })], scmRefs: {}, repos: [] });
  expect(ids('/p/agent/data/repo')).toEqual(['show-history', 'sep', 'hide-repo']);
  expect(ids('/p')).not.toContain('hide-repo');
  expect(ids('/p/wt')).not.toContain('hide-repo');
  expect(ids('/p/.claude/worktrees/x')).not.toContain('hide-repo');
});

test('hiding a repository: gone from Source Control at once with the ones inside it, a toast says so, and Undo shows it again', async () => {
  const calls: unknown[] = [];
  g.window = { atelier: { scm: {
    hide: async (root: string) => { calls.push(['hide', root]); return ['agent/data/repo']; },
    unhide: async (rel: string) => { calls.push(['unhide', rel]); return []; },
    repos: async () => [], search: async () => ({ capped: false, searching: false, maxFolders: 20_000, hidden: [] }), fetchStates: async () => []
  } } };
  useApp.setState({ toast: null, scmSearch: { capped: false, searching: false, maxFolders: 20_000, hidden: [] }, scmRepo: '/p/agent/data/repo', scmRefs: {}, repos: [],
    scmRepos: [entry('/p', ''), entry('/p/agent/data/repo', 'agent/data/repo'), entry('/p/agent/data/repo/inner', 'agent/data/repo/inner'), entry('/p/tools', 'tools')] });
  await hideRepo('/p/agent/data/repo');
  expect(calls).toEqual([['hide', '/p/agent/data/repo']]);
  expect(useApp.getState().scmRepos?.map((e) => e.root)).toEqual(['/p', '/p/tools']);
  // The selection moves off it, as when a repository goes away.
  expect(useApp.getState().scmRepo).toBe('/p');
  expect(useApp.getState().scmSearch?.hidden).toEqual(['agent/data/repo']);
  const toast = useApp.getState().toast!;
  expect(toast).toMatchObject({ text: 'repo hidden from Atelier', tone: 'info', action: { label: 'Undo' } });
  toast.action!.run();
  await tick();
  expect(calls.at(-1)).toEqual(['unhide', 'agent/data/repo']);
  expect(useApp.getState().scmSearch?.hidden).toEqual([]);
});

test('a hide main refuses says so, and nothing leaves Source Control', async () => {
  g.window = { atelier: { scm: { hide: async () => { throw new Error('no'); } } } };
  useApp.setState({ toast: null, scmRepos: [entry('/p', ''), entry('/p/a', 'a')], scmRefs: {}, repos: [] });
  await hideRepo('/p/a');
  expect(useApp.getState().scmRepos).toHaveLength(2);
  expect(useApp.getState().toast).toMatchObject({ text: "Couldn't hide this repository" });
});
