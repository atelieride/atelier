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
  useApp.setState({ scmRepos: [{ root: '/p', rel: '', name: 'p', worktreeOf: null, common: '/p/.git', status: null }], scmRepo: '/p', scmRefs: { '/p': refs } });
  fetchSelected();
  await tick(); await tick();
  expect(calls).toEqual([]);
  expect(useApp.getState().toast).toMatchObject({ text: 'No remote to fetch from', tone: 'info' });
  useApp.setState({ scmRefs: { '/p': { ...refs, remotes: ['origin'], hasRemote: true } } });
  fetchSelected();
  await tick(); await tick();
  expect(calls).toEqual([['/p', 'manual']]);
});
