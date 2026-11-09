import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Attribution } from '@shared/attribution';
import type { FileChange, RepoStatus } from '@shared/git';
import type { GitOpResult } from '@shared/git-write';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { useApp } from '../store';
import { discardTargets } from './actions';
import { discardPlan, discardTitle, discardToast, liveNotice } from './discard';
import type { LiveBy } from './live';

// Discard: what the sheet lists and asks, who wrote the lines, the session editing them now, and
// the one toast after it (how many went to the Trash, the files main kept and why; no Undo).

const ch = (rel: string, o: Partial<FileChange> = {}): FileChange => ({ path: `/p/a/${rel}`, rel, kind: 'M', stage: 'none', added: 1, removed: 0, ...o });
const repo = (root: string, changes: FileChange[], truncated = 0): Pick<RepoStatus, 'root' | 'name' | 'changes' | 'truncated'> => ({ root, name: root.split('/').pop()!, changes, truncated });
const attr = (path: string, terminalId: string, title: string, o: Partial<Attribution> = {}): Attribution => ({ path, terminalId, sessionId: 's1', color: '#c0ffee', title, at: 1, ...o });
const none = new Map<string, LiveBy>();

describe('discardPlan', () => {
  const a = repo('/p/a', [ch('src/cart.ts'), ch('src/moved.ts', { kind: 'R', origRel: 'src/old.ts', stage: 'all' }), ch('README.md', { kind: '?' })]);

  test('a file row: that file; a rename by both its paths is one file', () => {
    expect(discardPlan([{ root: '/p/a', rels: ['src/cart.ts'] }], [a], [], none).files.map((f) => f.rel)).toEqual(['src/cart.ts']);
    const r = discardPlan([{ root: '/p/a', rels: ['src/moved.ts', 'src/old.ts'] }], [a], [], none);
    expect(r.files.map((f) => [f.rel, f.origRel])).toEqual([['src/moved.ts', 'src/old.ts']]);
    expect(r.count).toBe(1);
  });

  test('a repository: every listed change, and "+N not listed" past the status cap', () => {
    const r = discardPlan([{ root: '/p/a', rels: 'all' }], [repo('/p/a', a.changes, 2400)], [], none);
    expect(r.files).toHaveLength(3);
    expect(r.notListed).toBe(2400);
    expect(r.count).toBe(2403);
  });

  test('several repositories (a session header); a path no longer listed still counts, by its path', () => {
    const b = repo('/p/b', [ch('x.ts', { path: '/p/b/x.ts' })]);
    const r = discardPlan([{ root: '/p/a', rels: ['src/cart.ts', 'gone.ts'] }, { root: '/p/b', rels: ['x.ts'] }], [a, b], [], none);
    expect(r.files.map((f) => f.path)).toEqual(['/p/a/src/cart.ts', '/p/a/gone.ts', '/p/b/x.ts']);
    expect(r.count).toBe(3);
  });

  test('who wrote the lines: the sessions that surely did, once each; unsure ones are not named', () => {
    const r = discardPlan([{ root: '/p/a', rels: ['src/cart.ts'] }], [a], [
      attr('/p/a/src/cart.ts', 't1', 'auth-refactor'), attr('/p/a/src/cart.ts', 't1', 'auth-refactor', { at: 2 }), attr('/p/a/src/cart.ts', 't2', 'api', { color: '#0f0' }),
      attr('/p/a/src/cart.ts', 't3', 'maybe', { maybe: true }), attr('/p/a/src/cart.ts', 't4', 'either', { unclear: ['t4', 't5'] })
    ], none);
    expect(r.files[0]!.by).toEqual([{ terminalId: 't1', title: 'auth-refactor', color: '#c0ffee' }, { terminalId: 't2', title: 'api', color: '#0f0' }]);
  });
});

describe('the sheet\'s words', () => {
  const a = repo('/p/a', [ch('src/welcome.tsx'), ch('src/a.ts'), ch('src/b.ts'), ch('src/c.ts')]);
  test('"Discard changes to welcome.tsx?" / "…to 4 files?"', () => {
    expect(discardTitle(discardPlan([{ root: '/p/a', rels: ['src/welcome.tsx'] }], [a], [], none))).toBe('Discard changes to welcome.tsx?');
    expect(discardTitle(discardPlan([{ root: '/p/a', rels: 'all' }], [a], [], none))).toBe('Discard changes to 4 files?');
    expect(discardTitle(discardPlan([{ root: '/p/a', rels: 'all' }], [repo('/p/a', a.changes, 1996)], [], none))).toBe('Discard changes to 2,000 files?');
    // One file not listed (past the status cap), or nothing at all: never "1 files", never "0 files".
    expect(discardTitle(discardPlan([{ root: '/p/a', rels: 'all' }], [repo('/p/a', [], 1)], [], none))).toBe('Discard changes to 1 file?');
    expect(discardTitle(discardPlan([{ root: '/p/a', rels: 'all' }], [repo('/p/a', [])], [], none))).toBe('Discard these changes?');
  });

  test('the live notice: who is editing it (or how many of them) right now; none without a live file', () => {
    const live = new Map<string, LiveBy>([['/p/a/src/a.ts', { terminalId: 't1', title: 'auth-refactor', color: '#60a5fa' }], ['/p/a/src/b.ts', { terminalId: 't1', title: 'auth-refactor', color: '#60a5fa' }],
      ['/p/a/src/c.ts', { terminalId: 't2', title: 'api', color: '#f00' }]]);
    expect(liveNotice(discardPlan([{ root: '/p/a', rels: ['src/a.ts'] }], [a], [], live))).toEqual({ text: 'auth-refactor is editing it right now', color: '#60a5fa' });
    expect(liveNotice(discardPlan([{ root: '/p/a', rels: ['src/a.ts', 'src/b.ts', 'src/welcome.tsx'] }], [a], [], live))!.text).toBe('auth-refactor is editing 2 of them right now');
    expect(liveNotice(discardPlan([{ root: '/p/a', rels: 'all' }], [a], [], live))!.text).toBe('auth-refactor and api are editing 3 of them right now');
    expect(liveNotice(discardPlan([{ root: '/p/a', rels: ['src/welcome.tsx'] }], [a], [], live))).toBeNull();
  });
});

describe('discardToast', () => {
  const ok = (message: string, files?: string[]): GitOpResult => ({ outcome: 'ok', message, ...(files ? { files } : {}) });
  test('how many went to the Trash, an info toast with no action', () => {
    expect(discardToast([{ name: 'acme', r: ok('3 files moved to the Trash'), fail: '' }])).toEqual({ text: '3 files moved to the Trash', tone: 'info' });
  });

  test('kept files are named where main says they were kept, with its reason; the toast stays longer', () => {
    const r = ok("1 file moved to the Trash · 1 file kept: it has staged changes that aren't in your working copy — unstage or commit them first", ['src/notes.ts']);
    expect(discardToast([{ name: 'acme', r, fail: '' }])).toEqual({
      text: "1 file moved to the Trash · 1 file kept (notes.ts): it has staged changes that aren't in your working copy — unstage or commit them first", tone: 'info', ms: 10000
    });
  });

  test('everything kept (outcome state): main\'s reason with the names, not "Discard failed"', () => {
    const r: GitOpResult = { outcome: 'state', message: "2 files kept: they have staged changes that aren't in your working copy — unstage or commit them first", files: ['a.ts', 'src/b.ts'] };
    expect(discardToast([{ name: 'acme', r, fail: 'Discard failed: …' }])).toEqual({ text: "2 files kept (a.ts, b.ts): they have staged changes that aren't in your working copy — unstage or commit them first", ms: 10000 });
  });

  test('kept and left alone together: the names at the end; a failure says the failure; several repositories by name', () => {
    expect(discardToast([{ name: 'acme', r: ok('0 files moved to the Trash · 1 file kept: … · 1 file left alone (conflicts, submodules, folders)', ['k.ts', 'u.ts']), fail: '' }]).text)
      .toBe('0 files moved to the Trash · 1 file kept: … · 1 file left alone (conflicts, submodules, folders) (k.ts, u.ts)');
    expect(discardToast([{ name: 'acme', r: { outcome: 'busy' }, fail: 'Git is busy' }])).toEqual({ text: 'Git is busy', ms: 10000 });
    expect(discardToast([{ name: 'acme', r: ok('1 file moved to the Trash'), fail: '' }, { name: 'billing', r: ok('2 files moved to the Trash'), fail: '' }]).text)
      .toBe('acme: 1 file moved to the Trash; billing: 2 files moved to the Trash');
  });
});

// ── The run, over a fake window.atelier ───────────────────────────────────────────────────────────────────────────────

const g = globalThis as { window?: unknown };
let calls: unknown[][];
let answers: Record<string, GitOpResult>;
beforeEach(() => {
  calls = []; answers = {};
  g.window = { atelier: { git: { discard: async (root: string, rels: unknown) => { calls.push([root, rels]); return answers[root] ?? { outcome: 'ok', message: '1 file moved to the Trash' }; } } } };
  useApp.setState({ settings: DEFAULT_SETTINGS, repos: [repo('/p/a', []), repo('/p/b', [])] as RepoStatus[], scmRepos: null, toast: null });
});
afterEach(() => { delete g.window; });

describe('discardTargets', () => {
  test('each repository in turn, then one toast', async () => {
    await discardTargets([{ root: '/p/a', rels: ['x.ts'] }, { root: '/p/b', rels: 'all' }]);
    expect(calls).toEqual([['/p/a', ['x.ts']], ['/p/b', 'all']]);
    expect(useApp.getState().toast).toMatchObject({ text: 'a: 1 file moved to the Trash; b: 1 file moved to the Trash', tone: 'info' });
    expect(useApp.getState().toast?.action).toBeUndefined();
  });

  test('a failure stops there; everything kept goes on to the next repository', async () => {
    answers['/p/a'] = { outcome: 'state', message: '1 file kept: …', files: ['k.ts'] };
    answers['/p/b'] = { outcome: 'busy' };
    await discardTargets([{ root: '/p/a', rels: ['k.ts'] }, { root: '/p/b', rels: ['x.ts'] }, { root: '/p/a', rels: ['y.ts'] }]);
    expect(calls.map((c) => c[0])).toEqual(['/p/a', '/p/b']);
    expect(useApp.getState().toast?.text).toMatch(/^a: 1 file kept \(k\.ts\): …; b: /);
  });

  test('Read-only: nothing runs', async () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' } });
    await discardTargets([{ root: '/p/a', rels: ['x.ts'] }]);
    expect(calls).toEqual([]);
    expect(useApp.getState().toast).toBeNull();
  });
});
