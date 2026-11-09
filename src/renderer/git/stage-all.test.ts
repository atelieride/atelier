import { expect, test } from 'vitest';
import type { FileChange } from '@shared/git';
import { MAX_STAGE_RELS, stageAllPlan } from './stage-all';

// What "stage everything" means for the drawer's target.

const ROOT = '/p/acme';
const ch = (rel: string, kind: FileChange['kind'] = 'M', stage: FileChange['stage'] = 'none', extra: Partial<FileChange> = {}): FileChange =>
  ({ path: `${ROOT}/${rel}`, rel, kind, stage, added: 1, removed: 0, ...extra });
const repo = (...changes: FileChange[]) => ({ root: ROOT, changes });
const shown = (...rels: string[]) => rels.map((rel) => ({ repo: ROOT, rel }));

test('the whole repository: Stage All, with its counts', () => {
  expect(stageAllPlan({ repo: repo(ch('a.ts'), ch('b.ts', 'D'), ch('new.ts', '?')), shown: null, writes: true }))
    .toEqual({ offered: true, plan: { what: 'all', changes: 3, newFiles: 1 } });
});

test('This workspace: only the rows shown, both sides of a rename', () => {
  const r = repo(ch('a.ts'), ch('b.ts'), ch('c2.ts', 'R', 'none', { origRel: 'c.ts' }), ch('mine.ts', '?'));
  expect(stageAllPlan({ repo: r, shown: [...shown('a.ts', 'c2.ts', 'mine.ts'), { repo: '/p/other', rel: 'b.ts' }], writes: true }))
    .toEqual({ offered: true, plan: { what: ['a.ts', 'c.ts', 'c2.ts', 'mine.ts'], changes: 3, newFiles: 1 } });
});

test('something staged already (all or partial): not offered', () => {
  expect(stageAllPlan({ repo: repo(ch('a.ts'), ch('b.ts', 'M', 'all')), shown: null, writes: true })).toEqual({ offered: false, why: 'staged' });
  expect(stageAllPlan({ repo: repo(ch('a.ts'), ch('b.ts', 'M', 'partial')), shown: null, writes: true })).toEqual({ offered: false, why: 'staged' });
});

test('nothing stageable: only submodules and nested repositories, or no change at all', () => {
  expect(stageAllPlan({ repo: repo(ch('lib', 'M', 'none', { submodule: true }), ch('vendor/tool/', '?')), shown: null, writes: true })).toEqual({ offered: false, why: 'nothing' });
  expect(stageAllPlan({ repo: repo(), shown: null, writes: true })).toEqual({ offered: false, why: 'nothing' });
  // This workspace shows none of the repository's rows.
  expect(stageAllPlan({ repo: repo(ch('a.ts')), shown: [], writes: true })).toEqual({ offered: false, why: 'nothing' });
});

test('an unmerged file anywhere in the repository: conflicts (main refuses Stage All then)', () => {
  expect(stageAllPlan({ repo: repo(ch('a.ts'), ch('b.ts', 'U')), shown: null, writes: true })).toEqual({ offered: false, why: 'conflicts' });
  expect(stageAllPlan({ repo: repo(ch('a.ts'), ch('b.ts', 'U')), shown: shown('a.ts'), writes: true })).toEqual({ offered: false, why: 'conflicts' });
});

test('Read-only: never offered', () => {
  expect(stageAllPlan({ repo: repo(ch('a.ts')), shown: null, writes: false })).toEqual({ offered: false, why: 'writes' });
});

test('more paths shown than one stage takes: too-many', () => {
  const rels = Array.from({ length: MAX_STAGE_RELS + 1 }, (_, i) => `f${i}.ts`);
  expect(stageAllPlan({ repo: repo(...rels.map((r) => ch(r))), shown: shown(...rels), writes: true })).toEqual({ offered: false, why: 'too-many' });
});
