import { expect, test } from 'vitest';
import { posixTest } from '../../../tests/support/platform';
import { KeepSet } from './keep-set';

test('kept paths of a root, from every holder, until each releases', () => {
  const k = new KeepSet();
  expect(k.paths('/r')).toEqual([]);
  const undo = k.hold('/r', ['/r/a.ts', '/r/b.ts']);
  const pull = k.hold('/r', ['/r/b.ts', '/r/c.ts']);
  k.hold('/s', ['/s/x.ts']);
  expect(k.paths('/r').sort()).toEqual(['/r/a.ts', '/r/b.ts', '/r/c.ts']);
  undo();
  // b.ts is still held by the other holder.
  expect(k.paths('/r').sort()).toEqual(['/r/b.ts', '/r/c.ts']);
  pull();
  expect(k.paths('/r')).toEqual([]);
  expect(k.paths('/s')).toEqual(['/s/x.ts']);
});

test('release is idempotent: a second call never drops another holder\'s paths', () => {
  const k = new KeepSet();
  const a = k.hold('/r', ['/r/a.ts']);
  const b = k.hold('/r', ['/r/a.ts']);
  a();
  a();
  expect(k.paths('/r')).toEqual(['/r/a.ts']);
  b();
  expect(k.paths('/r')).toEqual([]);
});

// POSIX: POSIX path fixtures through node:path.
posixTest('relative paths are taken inside the root; absolute ones as given', () => {
  const k = new KeepSet();
  k.hold('/r', ['src/a.ts', '/r/b.ts']);
  expect(k.paths('/r').sort()).toEqual(['/r/b.ts', '/r/src/a.ts']);
});

test('withKept: the dirty list a prune sends, with the kept paths it lacks', () => {
  expect(KeepSet.withKept(['/r/a.ts'], ['/r/a.ts', '/r/b.ts'])).toEqual(['/r/a.ts', '/r/b.ts']);
  const dirty = ['/r/a.ts'];
  expect(KeepSet.withKept(dirty, [])).toBe(dirty);
});
