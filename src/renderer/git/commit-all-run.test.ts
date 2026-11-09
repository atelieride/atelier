import { afterEach, beforeEach, expect, test } from 'vitest';
import type { FileChange, RepoStatus } from '@shared/git';
import type { GitOpResult, ScmMessageEvent } from '@shared/git-write';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { useApp } from '../store';
import { openCommitAll } from './actions';
import { closeCommitAll, commitAllNow, doneCommitAll, setMode, undoAll, writeAll } from './commit-all-run';

// Commit all's effects over a fake window.atelier: the run goes on
// whatever opens meanwhile, ✦ Write All never lands in another sheet, Undo All gives the messages back as drafts.

const g = globalThis as { window?: unknown; localStorage?: unknown };
let calls: [string, ...unknown[]][];
let answers: Record<string, unknown>;
let emit: ((e: ScmMessageEvent) => void) | null;
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const ch = (rel: string, stage: FileChange['stage']): FileChange => ({ path: `/x/${rel}`, rel, kind: 'M', stage, added: 1, removed: 0 });
const repo = (root: string, name: string, ...stages: FileChange['stage'][]): RepoStatus => ({
  root, name, branch: 'main', detached: false, ahead: 0, behind: 0, changes: stages.map((s, i) => ch(`f${i}`, s)), oid: 'a'.repeat(40), checkedAt: 0, truncated: 0
});
const all = () => useApp.getState().commitAll;
const commits = () => calls.filter((c) => c[0] === 'commit').map((c) => (c[1] as { root: string }).root);

beforeEach(() => {
  calls = []; answers = {}; emit = null;
  const method = (name: string) => async (...args: unknown[]) => {
    calls.push([name, ...args]);
    const a = answers[name];
    return typeof a === 'function' ? (a as (...x: unknown[]) => unknown)(...args) : a ?? { outcome: 'ok' };
  };
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  g.window = {
    atelier: {
      git: Object.fromEntries(['commit', 'undoCommit', 'push', 'facts', 'message', 'messageCancel', 'unstage'].map((n) => [n, method(n)])),
      on: { scmMessage: (cb: (e: ScmMessageEvent) => void) => { emit = cb; return () => { emit = null; }; } }
    }
  };
  useApp.setState({
    settings: DEFAULT_SETTINGS, project: { root: '/p', name: 'p', realRoot: '/p' }, attributions: [], terminals: [],
    repos: [repo('/p/a', 'acme-store', 'all'), repo('/p/b', 'billing', 'all'), repo('/p/c', 'checkout', 'all')],
    gitDrawer: { open: false, height: null, unfolded: [], openedFor: null }, gitTarget: null, gitLastStaged: null,
    gitDrafts: { '/p/a': 'fix: a', '/p/b': 'fix: b', '/p/c': 'fix: c' }, gitOps: {}, gitResult: {}, gitSheet: null, commitAll: null, gitFacts: {}, toast: null
  });
});
afterEach(async () => {
  doneCommitAll();
  await ticks();
  delete g.window; delete g.localStorage;
});

test('Commit all… opened again while it runs brings that run back: nothing is replaced, the next commit still happens', async () => {
  let release!: (r: GitOpResult) => void;
  answers.commit = (o: { root: string }) => (o.root === '/p/a' ? new Promise<GitOpResult>((r) => { release = r; }) : { outcome: 'ok', sha: `${o.root.slice(3)}1234567` });
  openCommitAll(['/p/a', '/p/c']);
  commitAllNow();
  await ticks();
  expect(all()).toMatchObject({ phase: 'running' });
  closeCommitAll();
  expect(all()).toMatchObject({ open: false, phase: 'running' });
  // The drawer's "Commit all…" (or the menu's) while /p/a's hook still runs.
  openCommitAll(['/p/b']);
  expect(all()).toMatchObject({ open: true, phase: 'running', cards: [{ root: '/p/a' }, { root: '/p/c' }] });
  release({ outcome: 'ok', sha: 'a1234567' });
  await ticks();
  expect(commits()).toEqual(['/p/a', '/p/c']);
  expect(all()).toMatchObject({ phase: 'results', cards: [{ root: '/p/a', run: { kind: 'committed' } }, { root: '/p/c', run: { kind: 'committed' } }] });
});

// A checkbox shows its click before git ran (stage-intents.ts): a card's ✦ asks main once that click reached git.
test('✦ Write All right after a checkbox click: that card asks main once the click reached git, the others at once', async () => {
  useApp.setState({ gitDrafts: {}, gitStageIntents: [], gitReposSeen: [] });
  answers.message = (o: { root: string }) => ({ id: `w${o.root.slice(3)}` });
  const id = useApp.getState().addStageIntent('/p/a', ['f0'], 'all');
  openCommitAll(['/p/a', '/p/c']);
  writeAll();
  await ticks();
  expect(all()?.cards.map((c) => c.write)).toEqual(['writing', 'writing']);
  expect(calls.filter((c) => c[0] === 'message').map((c) => (c[1] as { root: string }).root)).toEqual(['/p/c']);
  useApp.getState().endStageIntent(id, 5);
  await ticks();
  expect(calls.filter((c) => c[0] === 'message').map((c) => (c[1] as { root: string }).root)).toEqual(['/p/c', '/p/a']);
  useApp.setState({ gitStageIntents: [], gitReposSeen: [] });
});

test("a new sheet in place of one whose ✦ Write All is writing: main stops those writes, and they never land in it", async () => {
  useApp.setState({ gitDrafts: {} });
  answers.message = (o: { root: string }) => ({ id: `w${o.root.slice(3)}` });
  openCommitAll(['/p/a', '/p/c']);
  writeAll();
  await ticks();
  expect(all()?.cards.map((c) => c.write)).toEqual(['writing', 'writing']);
  openCommitAll(['/p/a', '/p/b']);
  expect(calls.filter((c) => c[0] === 'messageCancel').map((c) => c[1]).sort()).toEqual(['wa', 'wc']);
  emit?.({ id: 'wa', chunk: 'feat: old' });
  emit?.({ id: 'wa', done: { text: 'feat: old', model: 'haiku', ms: 1, notes: [] } });
  expect(all()?.cards).toEqual([{ root: '/p/a', include: true, message: '' }, { root: '/p/b', include: true, message: '' }]);
  expect(useApp.getState().gitDrafts).toEqual({});
});

test('Undo All in One message mode gives the message back as each repository\'s draft', async () => {
  openCommitAll(['/p/a', '/p/c']);
  setMode('one');
  useApp.getState().updateCommitAll((s) => ({ ...s, message: 'chore: bump everything' }));
  answers.commit = (o: { root: string }) => ({ outcome: 'ok', sha: `${o.root.slice(3)}1234567`, undo: { oid: `${o.root.slice(3)}1234567` } });
  commitAllNow();
  await ticks();
  expect(all()).toMatchObject({ phase: 'results' });
  expect(useApp.getState().gitDrafts).toEqual({ '/p/b': 'fix: b' });
  answers.undoCommit = { outcome: 'ok' };
  await undoAll();
  expect(all()).toMatchObject({ phase: 'edit', mode: 'one', message: 'chore: bump everything' });
  expect(useApp.getState().gitDrafts).toEqual({ '/p/a': 'chore: bump everything', '/p/b': 'fix: b', '/p/c': 'chore: bump everything' });
});
