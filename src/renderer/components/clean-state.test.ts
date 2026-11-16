import { beforeEach, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RepoStatus } from '@shared/git';
import type { GitOp } from '@shared/git-write';
import { useApp } from '../store';
import type { WtView } from '../worktrees';
import { CleanState } from './CleanState';

// Changes when everything is clean: one quiet line, then a row per
// repository with its branch, its worktrees under it; no ring, no pills. Read-only unless a test turns git actions on:
// then a ↓ is a Pull button.

const gitActions = (v: 'on' | 'read-only') => useApp.setState({ settings: { ...useApp.getState().settings, gitActions: v } });
beforeEach(() => { gitActions('read-only'); useApp.setState({ gitOps: {} }); });

const repo = (name: string, o: Partial<RepoStatus> = {}): RepoStatus => ({
  root: `/p/${name}`, name, branch: 'dev', detached: false, ahead: 0, behind: 0, oid: 'a'.repeat(40), changes: [], checkedAt: 0, truncated: 0, ...o
}) as RepoStatus;
const wt = (name: string, state: WtView['state'], commits = 0): WtView => ({
  status: repo(name, { root: `/p/web/.claude/worktrees/${name}`, branch: `worktree-${name}`, worktreeOf: '/p/web', merge: commits ? { commits, merged: false, base: 'dev' } : null } as Partial<RepoStatus>),
  name, rows: [], state
});
// A server render reads the store's initial state: the state the test set becomes it.
const render = (repos: RepoStatus[], wts: Record<string, WtView[]> = {}, hidden = 0) => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  return renderToStaticMarkup(createElement(CleanState, { repos, worktreesOf: (root: string) => wts[root] ?? [], hidden }));
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('several repositories: "All clean · N repos", then a row each with its branch (detached says so); no ring, no pills', () => {
  const html = render([repo('api'), repo('docs', { branch: 'main' }), repo('infra', { detached: true })]);
  expect(text(html)).toBe('All clean · 3 repos api dev docs main infra detached');
  expect(html.match(/class="clean-row"/g)).toHaveLength(3);
  expect(html).not.toMatch(/clean-ring|clean-repo\b|No changes yet/);
});

test('many repositories: a dozen rows, then one row saying how many more (the count stays the whole)', () => {
  const repos = Array.from({ length: 20 }, (_, i) => repo(`r${String(i).padStart(2, '0')}`));
  const html = render(repos);
  expect(html.match(/class="clean-row"/g)).toHaveLength(12);
  expect(text(html)).toContain('All clean · 20 repos');
  expect(text(html)).toContain('r11 dev');
  expect(text(html)).not.toContain('r12');
  expect(html).toMatch(/<button[^>]*class="clean-more"[^>]*>8 more clean repositories<\/button>/);
});

test('a repository with a live session past the dozen still gets its row', () => {
  const repos = Array.from({ length: 20 }, (_, i) => repo(`r${String(i).padStart(2, '0')}`));
  const html = renderToStaticMarkup(createElement(CleanState, { repos, worktreesOf: () => [], live: new Set(['/p/r17']) }));
  expect(html.match(/class="clean-row"/g)).toHaveLength(13);
  expect(text(html)).toContain('r17 dev');
  expect(text(html)).toContain('7 more clean repositories');
});

test('one repository: "Working tree clean", no count', () => {
  const html = render([repo('acme-store', { branch: 'main' })]);
  expect(text(html)).toBe('Working tree clean acme-store main');
});

test('a repository\'s worktrees: rows under it, "↑n to merge" only when it has commits to merge, the tooltip names it', () => {
  const html = render([repo('web')], { '/p/web': [wt('login-flow', 'merge', 2), wt('spike', 'idle')] });
  expect(text(html)).toBe('Working tree clean web dev login-flow ↑2 to merge spike');
  expect(html.match(/class="clean-row is-wt"/g)).toHaveLength(2);
  expect(html).toContain('data-tip="/p/web/.claude/worktrees/login-flow');
});

test('This workspace hides every change (other workspaces\' sessions made them all): never "clean", it says where they are', () => {
  const html = render([repo('api'), repo('docs', { branch: 'main' })], {}, 3);
  expect(text(html)).toBe('Nothing in this workspace · 3 files elsewhere api dev docs main');
  expect(html).toContain('data-tip="3 changed files from other workspaces’ sessions: All shows them"');
  expect(text(render([repo('api')], {}, 1))).toBe('Nothing in this workspace · 1 file elsewhere api dev');
  expect(html).not.toMatch(/clean-note is-clean/);
});

// Sync arrows: right after the name, only against the branch's own upstream.

test('a repository with something to sync: ↓/↑ right after its name, before the branch; nothing when in sync', () => {
  const html = render([repo('api', { upstream: 'origin/dev', ahead: 2 }), repo('docs', { branch: 'main', upstream: 'origin/main', behind: 3 }), repo('infra', { upstream: 'origin/dev' })]);
  expect(text(html)).toBe('All clean · 3 repos api ↑2 dev docs ↓3 main infra dev');
  expect(html).toContain('class="sync-counts mono" role="img" data-tip="2 to push to origin/dev" aria-label="2 to push"');
  expect(html).toContain('<span class="git-sync-behind">↓3</span>');
  expect(html.match(/sync-counts/g)).toHaveLength(2);
  // Right after the name: name, arrows, branch.
  expect(html).toMatch(/clean-name">api<\/span><span class="sync-counts[^>]*><span class="git-sync-ahead">↑2<\/span><\/span><span class="clean-branch/);
});

test('both ways: ↓ first, then ↑, one tooltip naming the upstream', () => {
  const html = render([repo('api', { upstream: 'origin/dev', ahead: 2, behind: 1 })]);
  expect(text(html)).toBe('Working tree clean api ↓1 ↑2 dev');
  expect(html).toContain('data-tip="1 to pull · 2 to push · origin/dev" aria-label="1 to pull, 2 to push"');
});

test('a pushed worktree: its sync arrows after its name, the "↑n to merge" after them; a local-only one only merges', () => {
  const pushed = wt('login-flow', 'merge', 5);
  pushed.status = { ...pushed.status, upstream: 'origin/worktree-login-flow', ahead: 1 };
  const html = render([repo('web')], { '/p/web': [pushed, wt('spike', 'merge', 2)] });
  expect(text(html)).toBe('Working tree clean web dev login-flow ↑1 ↑5 to merge spike ↑2 to merge');
  expect(html.match(/sync-counts/g)).toHaveLength(1);
  expect(html).toMatch(/clean-name mono">login-flow<\/span><span class="sync-counts[^>]*>.*?<\/span><\/span><span class="clean-ahead mono">↑5 to merge/);
});

test('the arrows are not a control, and read as one label: role img, no tab stop, no button', () => {
  const html = render([repo('api', { upstream: 'origin/dev', ahead: 2 })]);
  const counts = html.match(/<span class="sync-counts[^>]*>/)![0];
  // Read as one label ("2 to push"), never the glyphs; still no tab stop and no control role.
  expect(counts).toContain('role="img"');
  expect(counts).not.toMatch(/tabindex|role="button"/i);
  expect(html).not.toContain('<button');
});

// Git actions on: the ↓ pulls, as Source Control's Pull does; the ↑ stays a label.

const running = (root: string, op: GitOp) =>
  useApp.setState({ gitOps: { a: { id: 'a', root, op, phase: 'running', startedAt: 0, output: '' } } });

test('git actions on: a ↓ is a Pull button saying what it pulls from where; the row reads the same; ↑ alone stays a label', () => {
  gitActions('on');
  const html = render([repo('api', { upstream: 'origin/dev', ahead: 2 }), repo('docs', { branch: 'main', upstream: 'origin/main', behind: 3 })]);
  expect(text(html)).toBe('All clean · 2 repos api ↑2 dev docs ↓3 main');
  expect(html.match(/<button[^>]*class="sync-pull[^"]*"/g)).toHaveLength(1);
  expect(html).toMatch(/<button type="button" class="sync-pull git-sync-behind" data-tip="Pull 3 commits from origin\/main" aria-label="Pull 3 commits from origin\/main">↓3<\/button>/);
  // The arrows keep their tooltip; with a control inside they are no longer one image.
  expect(html).toMatch(/<span class="sync-counts mono has-pull" data-tip="3 to pull from origin\/main">/);
  // api has only commits to push: its arrows stay one label, no button.
  expect(html).toContain('class="sync-counts mono" role="img" data-tip="2 to push to origin/dev" aria-label="2 to push"');
});

test('git actions on, both ways: ↓ is the button, ↑ next to it is its own label', () => {
  gitActions('on');
  const html = render([repo('api', { upstream: 'origin/dev', ahead: 2, behind: 1 })]);
  expect(text(html)).toBe('Working tree clean api ↓1 ↑2 dev');
  expect(html).toMatch(/aria-label="Pull 1 commit from origin\/dev">↓1<\/button><span class="git-sync-ahead" role="img" aria-label="2 to push">↑2<\/span>/);
  expect(html).toContain('data-tip="1 to pull · 2 to push · origin/dev"');
});

test('git actions on: a pushed worktree with commits to pull gets the button too', () => {
  gitActions('on');
  const pushed = wt('login-flow', 'idle');
  pushed.status = { ...pushed.status, upstream: 'origin/worktree-login-flow', behind: 2 };
  const html = render([repo('web')], { '/p/web': [pushed] });
  expect(html).toContain('aria-label="Pull 2 commits from origin/worktree-login-flow">↓2</button>');
});

test('read-only: the ↓ stays a label, never a button', () => {
  const html = render([repo('docs', { branch: 'main', upstream: 'origin/main', behind: 3 })]);
  expect(html).not.toContain('<button');
  expect(html).toContain('class="sync-counts mono" role="img" data-tip="3 to pull from origin/main" aria-label="3 to pull"');
});

test('a pull or a sync running there: a spinner in the arrow\'s place, busy, saying so; another tree is untouched', () => {
  gitActions('on');
  for (const op of ['pull', 'sync'] as const) {
    running('/p/docs', op);
    const html = render([repo('docs', { branch: 'main', upstream: 'origin/main', behind: 3 }), repo('api', { upstream: 'origin/dev', behind: 1 })]);
    const label = op === 'pull' ? 'Pulling…' : 'Syncing…';
    expect(html).toContain(`aria-busy="true" data-tip="${label}" aria-label="${label}"><i class="git-spin" aria-hidden="true"></i>3</button>`);
    expect(html).toContain('aria-label="Pull 1 commit from origin/dev">↓1</button>');
  }
});

test('another op running there (a commit, a push): the button is off and says why', () => {
  gitActions('on');
  running('/p/docs', 'commit');
  const html = render([repo('docs', { branch: 'main', upstream: 'origin/main', behind: 3 })]);
  expect(html).toContain('aria-disabled="true" data-tip="Pull · Committing…" aria-label="Pull · Committing…">↓3</button>');
});
