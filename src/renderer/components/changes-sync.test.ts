import { beforeEach, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FileChange, RepoStatus } from '@shared/git';
import type { Attribution } from '@shared/attribution';
import { useApp } from '../store';
import { groupKey } from '../changes-prefs';
import type { WorkspacesState } from '../workspaces';
import { ChangesPanel } from './ChangesPanel';

// Sync arrows in Changes: each working tree shows its ↓/↑ once, wherever
// Changes shows it, in every state — and nowhere when Changes hides it (collapsed, folded by the drawer, filtered out).
// What Changes asks to fetch, caught here at the hook (a server render runs no effect).

const asked = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock('../scm/view-fetch', async (orig) => ({ ...(await orig<typeof import('../scm/view-fetch')>()), useViewFetches: (key: string) => { asked.keys.push(key); } }));

const ch = (root: string, rel: string): FileChange => ({ path: `${root}/${rel}`, rel, kind: 'M', stage: 'none', added: 1, removed: 0 });
const repo = (root: string, branch: string, o: Partial<RepoStatus> = {}): RepoStatus => ({
  root, name: root.split('/').at(-1)!, branch, detached: false, upstream: `origin/${branch}`, ahead: 0, behind: 0, changes: [],
  oid: 'a'.repeat(40), checkedAt: 0, truncated: 0, worktreeOf: null, merge: null, ...o
});
const wt = (name: string, branch: string, o: Partial<RepoStatus> = {}) => repo(`/p/web/.claude/worktrees/${name}`, branch, { worktreeOf: '/p/web', ...o });

// api: dirty, 2 to push. docs: clean, 3 to pull. web: clean and in sync, with four worktrees: login (pushed, 1 to push,
// 5 to merge), idle (pushed, 4 to pull, nothing to merge), sketch (local only, 2 to merge), dirty (pushed, 6 to push, a
// changed file).
const REPOS: RepoStatus[] = [
  repo('/p/api', 'dev', { ahead: 2, changes: [ch('/p/api', 'a.ts')] }),
  repo('/p/docs', 'main', { behind: 3 }),
  repo('/p/web', 'trunk'),
  wt('login', 'login', { ahead: 1, merge: { commits: 5, merged: false, base: 'trunk', files: [], truncated: 0 } }),
  wt('idle', 'idle-b', { behind: 4 }),
  wt('sketch', 'sketch', { upstream: null, merge: { commits: 2, merged: false, base: 'trunk', files: [], truncated: 0 } }),
  wt('dirty', 'dwt', { ahead: 6, changes: [ch('/p/web/.claude/worktrees/dirty', 'd.ts')] })
];
const TIPS = {
  api: '2 to push to origin/dev', docs: '3 to pull from origin/main', login: '1 to push to origin/login',
  idle: '4 to pull from origin/idle-b', dirty: '6 to push to origin/dwt'
};

const html = () => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  return renderToStaticMarkup(createElement(ChangesPanel));
};
const count = (s: string, needle: string) => s.split(needle).length - 1;
const tipsIn = (s: string) => Object.fromEntries(Object.entries(TIPS).map(([k, tip]) => [k, count(s, `data-tip="${tip}"`)]));
const strip = (s: string) => s.match(/<div class="clean to-sync">[\s\S]*?<\/div>/)?.[0] ?? '';
const cleanLine = (s: string) => s.match(/<div class="clean">[\s\S]*?<\/div>/)?.[0] ?? '';
const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

beforeEach(() => {
  useApp.setState({
    project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, repos: REPOS, attributions: [], terminals: [], ws: null,
    changesGroup: 'repo', changesCollapsed: [], changesExpanded: true, changesScope: 'all', changesMaybeOpen: [],
    settings: { ...useApp.getState().settings, gitActions: 'read-only' }
  });
});

test('by repository: every working tree its arrows once — heads, worktree lines, Clean chips, idle worktree chips', () => {
  const out = html();
  expect(tipsIn(out)).toEqual({ api: 1, docs: 1, login: 1, idle: 1, dirty: 1 });
  // api's head: title, arrows, branch pill.
  expect(out).toMatch(/change-group-title">api<\/span><span class="sync-counts mono" role="img" data-tip="2 to push to origin\/dev"[^>]*><span class="git-sync-ahead">↑2<\/span><\/span><span class="branch mono"/);
  // login's line: name, arrows, then its "↑5 to merge" (grey, outlined) as before.
  expect(out).toMatch(/wt-name">login<\/span><span class="sync-counts[^>]*>.*?<\/span><span class="wt-ahead mono"[^>]*>↑5/);
  // dirty's head: name, arrows.
  expect(out).toMatch(/change-group-title wt-name">dirty<\/span><span class="sync-counts[^>]*><span class="git-sync-ahead">↑6/);
  // Clean: docs with ↓3, the idle worktree with ↓4; web is in sync (its head shows no arrows), sketch has no upstream.
  expect(text(cleanLine(out))).toBe('Clean docs ↓3 idle ↓4');
  expect(out).not.toContain('to-sync');
});

test('by session: "To sync" right above "Clean" with the dirty repo and the pushed worktrees (no "to merge"); Clean keeps the rest', () => {
  useApp.setState({ changesGroup: 'session' });
  const out = html();
  expect(tipsIn(out)).toEqual({ api: 1, docs: 1, login: 1, idle: 1, dirty: 1 });
  expect(text(strip(out))).toBe('To sync api ↑2 dirty ↑6 idle ↓4 login ↑1');
  expect(strip(out)).not.toContain('↑5');
  expect(text(cleanLine(out))).toBe('Clean docs ↓3 web');
  expect(out.indexOf('class="clean to-sync"')).toBeLessThan(out.indexOf('class="clean"'));
});

test('by session with nothing to sync among the dirty or the worktrees: no "To sync" strip at all', () => {
  useApp.setState({ changesGroup: 'session', repos: [repo('/p/api', 'dev', { changes: [ch('/p/api', 'a.ts')] }), repo('/p/docs', 'main', { behind: 3 })] });
  const out = html();
  expect(out).not.toContain('to-sync');
  expect(text(cleanLine(out))).toBe('Clean docs ↓3');
});

test('a collapsed repository hides its worktrees and their arrows; its head keeps its own', () => {
  useApp.setState({ changesCollapsed: [groupKey('repo', '/p/web'), groupKey('repo', '/p/api')] });
  const out = html();
  expect(tipsIn(out)).toEqual({ api: 1, docs: 1, login: 0, idle: 1, dirty: 0 });
});

test('This workspace leaving a repository out (its changes are other workspaces\' sessions\'): its arrows go too, in both groupings', () => {
  const ws: WorkspacesState = {
    on: true, active: 'A', members: { other: 'B' },
    list: [{ id: 'A', name: 'Auth', color: 1, folder: null, order: [], active: null, layout: null }, { id: 'B', name: 'Billing', color: 2, folder: null, order: ['t:other'], active: 't:other', layout: null }]
  };
  const by: Attribution = { path: '/p/api/a.ts', terminalId: 'other', sessionId: 's', color: '#B794F6', title: 'Other', at: 1 };
  useApp.setState({ ws, changesScope: 'ws', attributions: [by] });
  expect(tipsIn(html()).api).toBe(0);
  useApp.setState({ changesGroup: 'session' });
  expect(tipsIn(html()).api).toBe(0);
});

test('no changed file: every arrow once, no strip — the all-clean rows by session, the groups by repository (login has commits to merge)', () => {
  const clean = REPOS.map((r) => ({ ...r, changes: [] }));
  for (const group of ['repo', 'session'] as const) {
    useApp.setState({ changesGroup: group, repos: clean });
    const out = html();
    expect(out.includes('clean-state')).toBe(group === 'session');
    expect(tipsIn(out)).toEqual({ api: 1, docs: 1, login: 1, idle: 1, dirty: 1 });
    expect(out).not.toContain('to-sync');
  }
});

test('the commit drawer folding a family: its worktrees and their arrows go; the target repository keeps its own', () => {
  useApp.setState({
    settings: { ...useApp.getState().settings, gitActions: 'on' },
    gitDrawer: { open: true, height: null, unfolded: [], openedFor: { root: '/p/api' } }, gitTarget: '/p/api'
  });
  expect(tipsIn(html())).toEqual({ api: 1, docs: 1, login: 0, idle: 1, dirty: 0 });
});

test('Changes asks a view fetch for every readable main repository — shown by name or not — never a worktree', () => {
  const ws: WorkspacesState = {
    on: true, active: 'A', members: { other: 'B' },
    list: [{ id: 'A', name: 'Auth', color: 1, folder: null, order: [], active: null, layout: null }, { id: 'B', name: 'Billing', color: 2, folder: null, order: ['t:other'], active: 't:other', layout: null }]
  };
  const by: Attribution = { path: '/p/api/a.ts', terminalId: 'other', sessionId: 's', color: '#B794F6', title: 'Other', at: 1 };
  // By session, api's only change belongs to another workspace: Changes doesn't show api by name, yet asks for it.
  useApp.setState({ changesGroup: 'session', ws, changesScope: 'ws', attributions: [by], repos: [...REPOS, repo('/p/odd', 'main', { error: 'safe.directory' })] });
  asked.keys = [];
  const out = html();
  expect(out).not.toContain('>api<');
  expect(asked.keys).toEqual(['/p/api\n/p/docs\n/p/web']);
});
