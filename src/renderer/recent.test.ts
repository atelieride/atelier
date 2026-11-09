import { expect, test } from 'vitest';
import { dropRecent, pushRecent, recentForPalette, renameRecent } from './recent';

const f = (p: string) => ({ path: `/r/${p}`, rel: p });

test('on top, no duplicates, at most 12', () => {
  let l: { path: string; rel: string }[] = [];
  for (let i = 0; i < 15; i++) l = pushRecent(l, f(`f${i}`));
  l = pushRecent(l, f('f5'));
  expect(l[0]!.rel).toBe('f5');
  expect(l).toHaveLength(12);
  expect(new Set(l.map((x) => x.path)).size).toBe(12);
});

test('in the palette: up to 6, without the active file (including files outside the index, like .env)', () => {
  const l = ['.env', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(f);
  expect(recentForPalette(l, '/r/b').map((x) => x.rel)).toEqual(['.env', 'c', 'd', 'e', 'f', 'g']);
});

test('rename and trash update the recents (files and folders)', () => {
  const l = [f('src/a.ts'), f('src/sub/b.ts'), f('x.md')];
  expect(renameRecent(l, '/r/src', '/r/lib', '/r').map((x) => x.rel)).toEqual(['lib/a.ts', 'lib/sub/b.ts', 'x.md']);
  expect(renameRecent(l, '/r/x.md', '/r/y.md', '/r').map((x) => x.path)).toEqual(['/r/src/a.ts', '/r/src/sub/b.ts', '/r/y.md']);
  expect(dropRecent(l, '/r/src').map((x) => x.rel)).toEqual(['x.md']);
});
