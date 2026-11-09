import { beforeAll, expect, test, vi } from 'vitest';
import type { AtelierApi } from '@shared/api';

// The git writes' payloads: one object per call with exactly the documented keys, optional ones
// only when set, so main's strict schemas never see an extra or undefined key.

const calls: unknown[][] = [];
let api: AtelierApi;
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_k: string, v: AtelierApi) => { api = v; } },
  ipcRenderer: { invoke: (...a: unknown[]) => { calls.push(a); return Promise.resolve(); }, send: () => {}, on: () => {}, off: () => {} },
  webUtils: { getPathForFile: () => '' }
}));
beforeAll(async () => { await import('./index'); });

const sent = (fn: () => unknown) => { calls.length = 0; void fn(); return calls[0]; };

test('each git write invokes its channel with one plain object', () => {
  const g = () => api.git;
  expect(sent(() => g().stage('/r', ['a', 'b']))).toStrictEqual(['git:stage', { root: '/r', rels: ['a', 'b'] }]);
  expect(sent(() => g().unstage('/r', 'all'))).toStrictEqual(['git:unstage', { root: '/r', rels: 'all' }]);
  expect(sent(() => g().discard('/r', ['a']))).toStrictEqual(['git:discard', { root: '/r', rels: ['a'] }]);
  const extra = { root: '/r', message: 'm', amend: false, coAuthor: true, noVerify: false, sneaky: '--force' } as Parameters<AtelierApi['git']['commit']>[0];
  expect(sent(() => g().commit(extra))).toStrictEqual(['git:commit', { root: '/r', message: 'm', amend: false, coAuthor: true, noVerify: false }]);
  expect(sent(() => g().commit({ root: '/r', message: 'm', amend: true, coAuthor: false, noVerify: false, expectHead: 'abc' })))
    .toStrictEqual(['git:commit', { root: '/r', message: 'm', amend: true, coAuthor: false, noVerify: false, expectHead: 'abc' }]);
  expect(sent(() => g().undoCommit('/r', 'abc'))).toStrictEqual(['git:undo-commit', { root: '/r', oid: 'abc' }]);
  expect(sent(() => g().push({ root: '/r' }))).toStrictEqual(['git:push', { root: '/r' }]);
  expect(sent(() => g().push({ root: '/r', publish: { remote: 'origin' }, lease: { oid: 'abc' } }))).toStrictEqual(['git:push', { root: '/r', publish: { remote: 'origin' }, lease: { oid: 'abc' } }]);
  expect(sent(() => g().pull({ root: '/r', rebase: false }))).toStrictEqual(['git:pull', { root: '/r', rebase: false }]);
  expect(sent(() => g().pull({ root: '/r', rebase: true, stash: true }))).toStrictEqual(['git:pull', { root: '/r', rebase: true, stash: true }]);
  expect(sent(() => g().sync({ root: '/r', rebase: false }))).toStrictEqual(['git:sync', { root: '/r', rebase: false }]);
  expect(sent(() => g().syncAll())).toStrictEqual(['git:sync-all']);
  const skip = { skip: ['/r/api'], extra: true } as Parameters<AtelierApi['git']['syncAll']>[0];
  expect(sent(() => g().syncAll(skip))).toStrictEqual(['git:sync-all', { skip: ['/r/api'] }]);
  expect(sent(() => g().switchTo({ root: '/r', ref: 'refs/heads/x', carry: 'none' }))).toStrictEqual(['git:switch', { root: '/r', ref: 'refs/heads/x', carry: 'none' }]);
  expect(sent(() => g().checkBranchName('/r', 'feat/x'))).toStrictEqual(['git:check-branch-name', { root: '/r', name: 'feat/x' }]);
  expect(sent(() => g().branchCreate({ root: '/r', name: 'x', switch: true }))).toStrictEqual(['git:branch-create', { root: '/r', name: 'x', switch: true }]);
  expect(sent(() => g().branchCreate({ root: '/r', name: 'x', from: 'refs/heads/main', switch: false }))).toStrictEqual(['git:branch-create', { root: '/r', name: 'x', from: 'refs/heads/main', switch: false }]);
  expect(sent(() => g().branchRename({ root: '/r', ref: 'refs/heads/x', name: 'y' }))).toStrictEqual(['git:branch-rename', { root: '/r', ref: 'refs/heads/x', name: 'y' }]);
  expect(sent(() => g().branchDelete({ root: '/r', ref: 'refs/heads/x', force: false }))).toStrictEqual(['git:branch-delete', { root: '/r', ref: 'refs/heads/x', force: false }]);
  expect(sent(() => g().branchRestore({ root: '/r', name: 'x', oid: 'abc' }))).toStrictEqual(['git:branch-restore', { root: '/r', name: 'x', oid: 'abc' }]);
  expect(sent(() => g().worktreeCheck('/r', '/r/.claude/worktrees/x'))).toStrictEqual(['git:worktree-check', { root: '/r', path: '/r/.claude/worktrees/x' }]);
  expect(sent(() => g().worktreeAdd({ root: '/r', path: '/r/w', newName: 'x' }))).toStrictEqual(['git:worktree-add', { root: '/r', path: '/r/w', newName: 'x' }]);
  expect(sent(() => g().worktreeAdd({ root: '/r', path: '/r/w', ref: 'refs/heads/x' }))).toStrictEqual(['git:worktree-add', { root: '/r', path: '/r/w', ref: 'refs/heads/x' }]);
  expect(sent(() => g().stashPush({ root: '/r', message: 'wip', untracked: true, staged: false }))).toStrictEqual(['git:stash-push', { root: '/r', message: 'wip', untracked: true, staged: false }]);
  expect(sent(() => g().stashApply({ root: '/r', index: 0, oid: 'abc', pop: true }))).toStrictEqual(['git:stash-apply', { root: '/r', index: 0, oid: 'abc', pop: true }]);
  expect(sent(() => g().stashDrop({ root: '/r', index: 1, oid: 'abc' }))).toStrictEqual(['git:stash-drop', { root: '/r', index: 1, oid: 'abc' }]);
  expect(sent(() => g().stashRestore({ root: '/r', oid: 'abc', message: 'wip' }))).toStrictEqual(['git:stash-restore', { root: '/r', oid: 'abc', message: 'wip' }]);
  expect(sent(() => g().cancel('op1'))).toStrictEqual(['git:cancel', { id: 'op1' }]);
  expect(sent(() => g().facts('/r'))).toStrictEqual(['git:facts', { root: '/r' }]);
  expect(sent(() => g().incoming('/r'))).toStrictEqual(['git:incoming', { root: '/r' }]);
  expect(sent(() => g().remoteCommits('/r', 3))).toStrictEqual(['git:remote-commits', { root: '/r', n: 3 }]);
  expect(sent(() => g().running())).toStrictEqual(['git:running']);
  expect(sent(() => g().message({ root: '/r' }))).toStrictEqual(['scm:message', { root: '/r' }]);
  expect(sent(() => g().message({ root: '/r', tweak: { kind: 'shorter', current: 'feat: x' } }))).toStrictEqual(['scm:message', { root: '/r', tweak: { kind: 'shorter', current: 'feat: x' } }]);
  expect(sent(() => g().messageCancel('m1'))).toStrictEqual(['scm:message-cancel', { id: 'm1' }]);
});
