import { expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RepoStatus } from '@shared/git';
import type { WtView } from '../worktrees';
import { CleanState } from './CleanState';

// Changes when everything is clean: one quiet line, then a row per
// repository with its branch, its worktrees under it; no ring, no pills.

const repo = (name: string, o: Partial<RepoStatus> = {}): RepoStatus => ({
  root: `/p/${name}`, name, branch: 'dev', detached: false, ahead: 0, behind: 0, oid: 'a'.repeat(40), changes: [], checkedAt: 0, truncated: 0, ...o
}) as RepoStatus;
const wt = (name: string, state: WtView['state'], commits = 0): WtView => ({
  status: repo(name, { root: `/p/web/.claude/worktrees/${name}`, branch: `worktree-${name}`, worktreeOf: '/p/web', merge: commits ? { commits, merged: false, base: 'dev' } : null } as Partial<RepoStatus>),
  name, rows: [], state
});
const render = (repos: RepoStatus[], wts: Record<string, WtView[]> = {}, hidden = 0) =>
  renderToStaticMarkup(createElement(CleanState, { repos, worktreesOf: (root: string) => wts[root] ?? [], hidden }));
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
