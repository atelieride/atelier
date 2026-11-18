import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { isWin, posixTest, useMachinePlatform } from '../../tests/support/platform';
import { createHiddenRepos } from './hidden-repos';

// The repositories each project hides: ATELIER_HOME/hidden-repos.json, by project root, read back after a restart.

const homes: string[] = [];
const home = () => { const h = mkdtempSync(join(tmpdir(), 'atl-hidden-')); homes.push(h); return h; };
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const file = (h: string) => join(h, 'hidden-repos.json');
// The machine's own roots (C:\ on Windows), checked as the app checks them there.
useMachinePlatform();
const P = isWin ? 'C:\\projects\\site' : '/projects/site';

test('nothing hidden without a file; what a project hides is kept, sorted, once, and read back by the next start', () => {
  const h = home();
  const s = createHiddenRepos(h);
  expect(s.list(P)).toEqual([]);
  expect(s.add(P, 'agent/data/repo')).toEqual(['agent/data/repo']);
  expect(s.add(P, 'b/cache')).toEqual(['agent/data/repo', 'b/cache']);
  expect(s.add(P, 'b/cache')).toEqual(['agent/data/repo', 'b/cache']);
  expect(s.list(isWin ? 'C:\\projects\\other' : '/projects/other')).toEqual([]);
  expect(JSON.parse(readFileSync(file(h), 'utf8'))).toEqual({ version: 1, projects: { [P]: ['agent/data/repo', 'b/cache'] } });
  expect(createHiddenRepos(h).list(P)).toEqual(['agent/data/repo', 'b/cache']);
});

posixTest('the file is private to the user', () => {
  const h = home();
  createHiddenRepos(h).add(P, 'a');
  expect(statSync(file(h)).mode & 0o777).toBe(0o600);
});

test('shown again: the path leaves the list, and a project with none left leaves the file', () => {
  const h = home();
  const s = createHiddenRepos(h);
  s.add(P, 'a');
  s.add(P, 'b');
  expect(s.remove(P, 'a')).toEqual(['b']);
  expect(s.remove(P, 'missing')).toEqual(['b']);
  expect(s.remove(P, 'b')).toEqual([]);
  expect(JSON.parse(readFileSync(file(h), 'utf8'))).toEqual({ version: 1, projects: {} });
});

test('a path that is not inside the project, or a project that is not a folder path, is refused and nothing is written', () => {
  const h = home();
  const s = createHiddenRepos(h);
  for (const rel of ['', '../up', '/abs', 'a\\b']) expect(() => s.add(P, rel)).toThrow();
  expect(() => s.add('relative/root', 'a')).toThrow();
  expect(() => statSync(file(h))).toThrow();
});

test('a damaged file, another version or bad entries: those are dropped, what is good is kept, and the next change writes a sound file', () => {
  const h = home();
  writeFileSync(file(h), '{ not json');
  expect(createHiddenRepos(h).list(P)).toEqual([]);
  writeFileSync(file(h), JSON.stringify({ version: 2, projects: { [P]: ['a'] } }));
  expect(createHiddenRepos(h).list(P)).toEqual([]);
  writeFileSync(file(h), JSON.stringify({ version: 1, projects: { [P]: ['ok', '../no', 7, 'ok'], 'not/abs': ['x'] } }));
  const s = createHiddenRepos(h);
  expect(s.list(P)).toEqual(['ok']);
  s.add(P, 'more');
  expect(JSON.parse(readFileSync(file(h), 'utf8'))).toEqual({ version: 1, projects: { [P]: ['more', 'ok'] } });
});

test('at most 200 hidden repositories per project', () => {
  const s = createHiddenRepos(home());
  for (let i = 0; i < 200; i++) s.add(P, `r${String(i).padStart(3, '0')}`);
  expect(() => s.add(P, 'one-more')).toThrow();
  expect(s.list(P)).toHaveLength(200);
});

test('500 projects at most: once full, the projects whose folder is gone make room; the ones still there keep theirs', () => {
  const h = home();
  const here = mkdtempSync(join(h, 'here-'));
  const projects: Record<string, string[]> = { [here]: ['kept'] };
  for (let i = 1; i < 500; i++) projects[join(h, `gone-${i}`)] = ['x'];
  writeFileSync(file(h), JSON.stringify({ version: 1, projects }));
  const s = createHiddenRepos(h);
  const fresh = mkdtempSync(join(h, 'new-'));
  expect(s.add(fresh, 'a')).toEqual(['a']);
  expect(JSON.parse(readFileSync(file(h), 'utf8'))).toEqual({ version: 1, projects: { [here]: ['kept'], [fresh]: ['a'] } });
  // Full of projects still on disk: refused, nothing written.
  const all: Record<string, string[]> = {};
  for (let i = 0; i < 500; i++) all[mkdtempSync(join(h, 'p-'))] = ['x'];
  writeFileSync(file(h), JSON.stringify({ version: 1, projects: all }));
  expect(() => createHiddenRepos(h).add(fresh, 'a')).toThrow();
  expect(Object.keys(JSON.parse(readFileSync(file(h), 'utf8')).projects)).toHaveLength(500);
});

test('a write that fails changes nothing, and says so', () => {
  const h = home();
  // ATELIER_HOME is a file: the store's file can't be written under it.
  const blocked = join(h, 'blocked');
  writeFileSync(blocked, '');
  const s = createHiddenRepos(blocked);
  expect(() => s.add(P, 'a')).toThrow();
  expect(s.list(P)).toEqual([]);
});
