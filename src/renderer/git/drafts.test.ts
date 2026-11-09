import { afterEach, beforeEach, expect, test } from 'vitest';
import { MAX_DRAFT_PROJECTS, capDraft, loadGitDrafts, loadGitPrefs, parseGitDrafts, parseGitPrefs, saveDrawerHeight, saveGitDraft, saveGitPrefs } from './drafts';

// Commit message drafts per working tree, the drawer's height per project, and the
// remembered Commit all / Publish choices, in localStorage.

const store = new Map<string, string>();
const g = globalThis as { localStorage?: unknown };
beforeEach(() => {
  store.clear();
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
});
afterEach(() => { delete g.localStorage; });

test('nothing saved, or garbage: no drafts, natural height', () => {
  expect(loadGitDrafts('/p')).toEqual({ drafts: {}, height: null });
  expect(parseGitDrafts('not json')).toEqual({});
  expect(parseGitDrafts('[1]')).toEqual({});
  expect(parseGitDrafts(JSON.stringify({ relative: { drafts: { '/p': 'x' } }, '/p': { drafts: { rel: 'x', '/p/a': 7, '/p/b': '' }, height: -3 } }))).toEqual({});
});

test('a draft per working tree survives a reload; an empty one is forgotten', () => {
  saveGitDraft('/p', '/p/a', 'feat: totals');
  saveGitDraft('/p', '/p/b', 'fix: rounding');
  saveGitDraft('/q', '/q', 'docs: readme');
  expect(loadGitDrafts('/p').drafts).toEqual({ '/p/a': 'feat: totals', '/p/b': 'fix: rounding' });
  saveGitDraft('/p', '/p/a', '   \n');
  expect(loadGitDrafts('/p').drafts).toEqual({ '/p/b': 'fix: rounding' });
  expect(loadGitDrafts('/q').drafts).toEqual({ '/q': 'docs: readme' });
});

test("the drawer's height is kept with the project's drafts; null goes back to the natural height", () => {
  saveGitDraft('/p', '/p/a', 'x');
  saveDrawerHeight('/p', 312);
  expect(loadGitDrafts('/p')).toEqual({ drafts: { '/p/a': 'x' }, height: 312 });
  saveDrawerHeight('/p', null);
  expect(loadGitDrafts('/p')).toEqual({ drafts: { '/p/a': 'x' }, height: null });
});

test('a draft is cut at 64 KB (never mid-character)', () => {
  expect(capDraft('abc')).toBe('abc');
  // One byte, then two-byte characters: the cap falls in the middle of one.
  const long = `a${'é'.repeat(40_000)}`;
  const cut = capDraft(long);
  expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(64 * 1024);
  expect(cut).toBe(`a${'é'.repeat(32 * 1024 - 1)}`);
  saveGitDraft('/p', '/p', long);
  expect(loadGitDrafts('/p').drafts['/p']).toBe(cut);
});

test(`at most ${MAX_DRAFT_PROJECTS} projects: the least recently written goes`, () => {
  for (let i = 0; i <= MAX_DRAFT_PROJECTS; i++) saveGitDraft(`/p${i}`, `/p${i}`, `m${i}`);
  expect(loadGitDrafts('/p0').drafts).toEqual({});
  expect(loadGitDrafts('/p1').drafts).toEqual({ '/p1': 'm1' });
  expect(loadGitDrafts(`/p${MAX_DRAFT_PROJECTS}`).drafts).toEqual({ [`/p${MAX_DRAFT_PROJECTS}`]: `m${MAX_DRAFT_PROJECTS}` });
});

test('storage that throws: nothing saved, nothing breaks', () => {
  g.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  expect(() => saveGitDraft('/p', '/p', 'x')).not.toThrow();
  expect(loadGitDrafts('/p')).toEqual({ drafts: {}, height: null });
  expect(loadGitPrefs()).toEqual({ mode: 'per-repo', pushAfter: false, openPr: false });
});

test('Commit all and Publish choices are remembered; unknown values fall back to the defaults', () => {
  expect(loadGitPrefs()).toEqual({ mode: 'per-repo', pushAfter: false, openPr: false });
  saveGitPrefs({ mode: 'one' });
  saveGitPrefs({ pushAfter: true, openPr: true });
  expect(loadGitPrefs()).toEqual({ mode: 'one', pushAfter: true, openPr: true });
  expect(parseGitPrefs(JSON.stringify({ mode: 'all', pushAfter: 'yes', openPr: 1 }))).toEqual({ mode: 'per-repo', pushAfter: false, openPr: false });
  expect(parseGitPrefs('{')).toEqual({ mode: 'per-repo', pushAfter: false, openPr: false });
});
