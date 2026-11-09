import { afterEach, beforeEach, expect, test } from 'vitest';
import type { FileChange, RepoStatus } from '@shared/git';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { MenuItem } from '../menu-model';
import { changeMenu, popoutBarMenu, tabMenu, worktreeMenu } from '../menus';
import { repoMenu } from '../scm/actions';
import { useApp } from '../store';
import { fileGitItems, repoGitItems, sessionGitItems } from './menu-items';
import type { StageRow } from './staging';

// Context menus of Changes: Stage/Unstage and Discard on a file, Stage All… on a repository,
// Commit <name>'s Work… on a session; none of them in Read-only, none of them opens the drawer by staging.

type Entry = Exclude<MenuItem, 'sep'>;
const g = globalThis as { window?: unknown; localStorage?: unknown };
let calls: unknown[][];
const tick = () => new Promise((r) => setTimeout(r, 0));
const ids = (items: MenuItem[]) => items.map((i) => (i === 'sep' ? '—' : i.id));
const item = (items: MenuItem[], id: string) => items.find((i): i is Entry => i !== 'sep' && i.id === id)!;

const row = (rel: string, stage: FileChange['stage'], o: Partial<StageRow> = {}): StageRow => ({ repo: '/p/a', rel, kind: 'M', stage, ...o });
const ch = (rel: string, stage: FileChange['stage'], o: Partial<FileChange> = {}): FileChange => ({ path: `/p/a/${rel}`, rel, kind: 'M', stage, added: 1, removed: 0, ...o });
const repo = (root: string, changes: FileChange[], truncated = 0): RepoStatus => ({
  root, name: root.split('/').pop()!, branch: 'main', detached: false, ahead: 0, behind: 0, changes, oid: 'a'.repeat(40), checkedAt: 0, truncated
});

beforeEach(() => {
  calls = [];
  const ok = (name: string) => async (...a: unknown[]) => { calls.push([name, ...a]); return { outcome: 'ok' }; };
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.window = { atelier: { git: { stage: ok('stage'), unstage: ok('unstage') } } };
  useApp.setState({
    settings: DEFAULT_SETTINGS, project: { root: '/p', name: 'p', realRoot: '/p' }, terminals: [], toast: null, activeTab: 'term',
    repos: [repo('/p/a', [ch('x.ts', 'none'), ch('y.ts', 'all')])], gitSheet: null, commitAll: null, gitDrafts: {},
    gitDrawer: { open: false, height: null, unfolded: [], openedFor: null }, gitTarget: null, gitLastStaged: null
  });
});
afterEach(() => { delete g.window; delete g.localStorage; });

test('a file: Stage when nothing is staged, Unstage when all is, both when part is; then Discard Changes…', () => {
  expect(ids(fileGitItems(row('a.ts', 'none')))).toEqual(['git-stage', 'git-discard', '—']);
  expect(ids(fileGitItems(row('a.ts', 'all')))).toEqual(['git-unstage', 'git-discard', '—']);
  expect(ids(fileGitItems(row('a.ts', 'partial')))).toEqual(['git-stage', 'git-unstage', 'git-discard', '—']);
  expect(item(fileGitItems(row('a.ts', 'none')), 'git-stage').label).toBe('Stage');
  expect(item(fileGitItems(row('a.ts', 'none')), 'git-discard')).toMatchObject({ label: 'Discard Changes…', danger: true });
});

test("a file that can't stage: Stage and Discard disabled with the reason (a submodule is never trashed whole)", () => {
  const u = fileGitItems(row('a.ts', 'none', { kind: 'U' }));
  expect(item(u, 'git-stage')).toMatchObject({ disabled: true, tip: 'Resolve the conflict first' });
  expect(item(u, 'git-discard')).toMatchObject({ disabled: true, tip: 'Resolve the conflict first' });
  const sub = fileGitItems(row('lib', 'all', { submodule: true }));
  expect(ids(sub)).toEqual(['git-stage', 'git-discard', '—']);
  expect(item(sub, 'git-discard')).toMatchObject({ disabled: true, tip: "Submodules aren't committed from Atelier yet" });
});

test('a file: Stage and Unstage run on its paths (a rename: both), never opening the drawer; Discard opens its sheet', async () => {
  item(fileGitItems(row('new.ts', 'none', { kind: 'R', origRel: 'old.ts' })), 'git-stage').run();
  await tick();
  item(fileGitItems(row('y.ts', 'all')), 'git-unstage').run();
  await tick();
  expect(calls).toEqual([['stage', '/p/a', ['new.ts', 'old.ts']], ['unstage', '/p/a', ['y.ts']]]);
  expect(useApp.getState().gitDrawer.open).toBe(false);
  item(fileGitItems(row('new.ts', 'none', { kind: 'R', origRel: 'old.ts' })), 'git-discard').run();
  expect(useApp.getState().gitSheet).toEqual({ kind: 'discard', targets: [{ root: '/p/a', rels: ['new.ts', 'old.ts'] }] });
});

test('a repository: Stage All and Unstage All on the whole repository, Commit… opens the drawer on it, Discard All…', async () => {
  const items = repoGitItems('/p/a');
  expect(ids(items)).toEqual(['git-stage-all', 'git-unstage-all', 'git-commit', 'git-discard-all', '—']);
  expect(items.filter((i): i is Entry => i !== 'sep').map((i) => i.label)).toEqual(['Stage All', 'Unstage All', 'Commit…', 'Discard All Changes…']);
  item(items, 'git-stage-all').run();
  await tick();
  item(items, 'git-unstage-all').run();
  await tick();
  expect(calls).toEqual([['stage', '/p/a', 'all'], ['unstage', '/p/a', 'all']]);
  expect(useApp.getState().gitDrawer.open).toBe(false);
  item(items, 'git-discard-all').run();
  expect(useApp.getState().gitSheet).toEqual({ kind: 'discard', targets: [{ root: '/p/a', rels: 'all' }] });
  item(items, 'git-commit').run();
  expect(useApp.getState().gitDrawer).toMatchObject({ open: true, openedFor: { root: '/p/a' } });
  expect(useApp.getState().gitTarget).toBe('/p/a');
});

test('a repository: Stage All off when everything listed is staged, Unstage All off when nothing is; a truncated list says so', () => {
  useApp.setState({ repos: [repo('/p/a', [ch('y.ts', 'all')]), repo('/p/b', [ch('x.ts', 'none')]), repo('/p/c', [ch('x.ts', 'all')], 2400)] });
  expect(item(repoGitItems('/p/a'), 'git-stage-all').disabled).toBe(true);
  expect(item(repoGitItems('/p/a'), 'git-unstage-all').disabled).toBe(false);
  expect(item(repoGitItems('/p/b'), 'git-unstage-all').disabled).toBe(true);
  // Past the status cap nothing is known about the rest: both offered, with how many aren't listed.
  const c = repoGitItems('/p/c');
  expect(item(c, 'git-stage-all')).toMatchObject({ disabled: false, tip: '+2400 files not listed' });
  expect(item(c, 'git-discard-all').tip).toBe('+2400 files not listed');
});

test("a session: Commit <name>'s Work…, Stage Its Files, Unstage Its Files, Discard Its Changes… on its listed files", async () => {
  const rows = [row('x.ts', 'none'), row('y.ts', 'all'), row('z.ts', 'none', { repo: '/p/b' }), row('c.ts', 'none', { kind: 'U' })];
  const items = sessionGitItems({ key: 't1', title: 'auth-refactor', rows });
  expect(ids(items)).toEqual(['git-commit-work', 'git-stage-its', 'git-unstage-its', 'git-discard-its', '—']);
  expect(item(items, 'git-commit-work').label).toBe("Commit auth-refactor's Work…");
  item(items, 'git-stage-its').run();
  await tick(); await tick();
  expect(calls).toEqual([['stage', '/p/a', ['x.ts']], ['stage', '/p/b', ['z.ts']]]);
  calls = [];
  item(items, 'git-unstage-its').run();
  await tick();
  expect(calls).toEqual([['unstage', '/p/a', ['y.ts']]]);
  item(items, 'git-discard-its').run();
  expect(useApp.getState().gitSheet).toEqual({ kind: 'discard', targets: [{ root: '/p/a', rels: ['x.ts', 'y.ts'] }, { root: '/p/b', rels: ['z.ts'] }] });
  // Unknown origin: no session to commit the work of.
  expect(ids(sessionGitItems({ key: 'unknown', title: 'Unknown origin', rows }))).toEqual(['git-stage-its', 'git-unstage-its', 'git-discard-its', '—']);
  expect(item(sessionGitItems({ key: 't1', title: 'a', rows: [row('y.ts', 'all')] }), 'git-stage-its').disabled).toBe(true);
  expect(item(sessionGitItems({ key: 't1', title: 'a', rows: [row('x.ts', 'none')] }), 'git-unstage-its').disabled).toBe(true);
  expect(sessionGitItems({ key: 't1', title: 'a', rows: [] })).toEqual([]);
});

test('Read-only: no git item anywhere, the menus are as before', () => {
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' } });
  expect(fileGitItems(row('a.ts', 'none'))).toEqual([]);
  expect(repoGitItems('/p/a')).toEqual([]);
  expect(sessionGitItems({ key: 't1', title: 'a', rows: [row('a.ts', 'none')] })).toEqual([]);
  expect(ids(changeMenu({ path: '/p/a/x.ts', rel: 'x.ts', deleted: false, git: row('x.ts', 'none') }))[0]).toBe('open');
  expect(ids(repoMenu('/p/a', { staging: true }))[0]).toBe('show-history');
});

test("the menus put the git items first, then today's items; the Source Control switcher's repository menu has none", () => {
  expect(ids(changeMenu({ path: '/p/a/x.ts', rel: 'x.ts', deleted: false, git: row('x.ts', 'none') })).slice(0, 4)).toEqual(['git-stage', 'git-discard', '—', 'open']);
  expect(ids(changeMenu({ path: '/p/a/x.ts', rel: 'x.ts', deleted: false }))[0]).toBe('open');
  expect(ids(repoMenu('/p/a', { staging: true })).slice(0, 6)).toEqual(['git-stage-all', 'git-unstage-all', 'git-commit', 'git-discard-all', '—', 'show-history']);
  expect(ids(repoMenu('/p/a'))[0]).toBe('show-history');
  const wt = repo('/p/a', []);
  expect(ids(worktreeMenu(wt)).slice(0, 5)).toEqual(['git-stage-all', 'git-unstage-all', 'git-commit', 'git-discard-all', '—']);
});

test('a Changes row: Reveal in Finder right after Reveal in Files, on the file itself; disabled when the file is deleted', () => {
  const revealed: string[] = [];
  g.window = { atelier: { reveal: async (p: string) => void revealed.push(p) } };
  const items = changeMenu({ path: '/p/a/x.ts', rel: 'x.ts', deleted: false });
  const at = ids(items).indexOf('reveal-tree');
  expect(ids(items)[at + 1]).toBe('reveal-finder');
  expect(item(items, 'reveal-finder')).toMatchObject({ label: 'Reveal in Finder', disabled: false });
  item(items, 'reveal-finder').run();
  expect(revealed).toEqual(['/p/a/x.ts']);
  expect(item(changeMenu({ path: '/p/a/x.ts', rel: 'x.ts', deleted: true }), 'reveal-finder').disabled).toBe(true);
});

test('a file tab with changes ends with Discard Changes…, which opens the sheet on its row; not without changes, not in Read-only, not in a pop-out', () => {
  useApp.setState({ repos: [repo('/p/a', [ch('x.ts', 'none'), ch('new.ts', 'all', { kind: 'R', origRel: 'old.ts' }), ch('u.ts', 'none', { kind: 'U' })])] });
  const items = tabMenu('f:/p/a/x.ts');
  expect(ids(items).slice(-2)).toEqual(['—', 'git-discard']);
  expect(item(items, 'git-discard')).toMatchObject({ label: 'Discard Changes…', danger: true });
  item(tabMenu('f:/p/a/new.ts'), 'git-discard').run();
  expect(useApp.getState().gitSheet).toEqual({ kind: 'discard', targets: [{ root: '/p/a', rels: ['new.ts', 'old.ts'] }] });
  expect(item(tabMenu('f:/p/a/u.ts'), 'git-discard')).toMatchObject({ disabled: true, tip: 'Resolve the conflict first' });
  expect(ids(tabMenu('f:/p/a/clean.ts'))).not.toContain('git-discard');
  expect(ids(popoutBarMenu('f:/p/a/x.ts'))).not.toContain('git-discard');
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' } });
  expect(ids(tabMenu('f:/p/a/x.ts'))).not.toContain('git-discard');
});
