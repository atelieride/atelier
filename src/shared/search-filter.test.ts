import { describe, expect, it } from 'vitest';
import { compilePathFilter, globToRegExp } from './search-filter';

const ok = (inc: string, exc: string, rel: string): boolean => compilePathFilter(inc, exc)(rel);

describe('compilePathFilter', () => {
  it('accepts everything when both fields are empty', () => {
    expect(ok('', '', 'a/b.ts')).toBe(true);
    expect(ok('  ', ' , ', 'x')).toBe(true);
  });

  it('treats a plain pattern as a name or path prefix anywhere', () => {
    for (const p of ['src/', 'src']) {
      expect(ok(p, '', 'src/a.ts')).toBe(true);
      expect(ok(p, '', 'src/x/y.ts')).toBe(true);
      expect(ok(p, '', 'lib/src/z.ts')).toBe(true);
      expect(ok(p, '', 'srcx/a.ts')).toBe(false);
    }
  });

  it('matches globs', () => {
    expect(ok('*.md', '', 'README.md')).toBe(true);
    expect(ok('*.md', '', 'docs/a.md')).toBe(true);
    expect(ok('*.md', '', 'a.mdx')).toBe(false);
    expect(ok('**/fixtures/**', '', 'tests/fixtures/a.json')).toBe(true);
    expect(ok('**/fixtures/**', '', 'fixtures/a.json')).toBe(true);
    expect(ok('**/fixtures/**', '', 'tests/other/a.json')).toBe(false);
  });

  it('splits on commas, with spaces, but not inside braces', () => {
    expect(ok('src/, *.md', '', 'src/a.ts')).toBe(true);
    expect(ok('src/, *.md', '', 'docs/a.md')).toBe(true);
    expect(ok('src/, *.md', '', 'lib/a.ts')).toBe(false);
    expect(ok('*.{ts,tsx}', '', 'a.tsx')).toBe(true);
    expect(ok('*.{ts,tsx}', '', 'a.js')).toBe(false);
  });

  it('lets exclude win over include', () => {
    expect(ok('src/', '**/*.test.ts', 'src/a.test.ts')).toBe(false);
    expect(ok('src/', '**/*.test.ts', 'src/a.ts')).toBe(true);
    expect(ok('', 'node_modules', 'a/node_modules/x.js')).toBe(false);
  });

  it('ignores case', () => {
    expect(ok('*.MD', '', 'a.md')).toBe(true);
    expect(ok('SRC/', '', 'src/a.ts')).toBe(true);
  });

  it('supports ? and character classes', () => {
    expect(ok('a?.ts', '', 'ab.ts')).toBe(true);
    expect(ok('a?.ts', '', 'a/.ts')).toBe(false);
    expect(ok('[ab].ts', '', 'a.ts')).toBe(true);
    expect(ok('[ab].ts', '', 'c.ts')).toBe(false);
    expect(ok('[!ab].ts', '', 'c.ts')).toBe(true);
    expect(ok('[!ab].ts', '', 'a.ts')).toBe(false);
  });

  it('handles a leading ./ and a trailing /', () => {
    expect(ok('./src/', '', 'src/a.ts')).toBe(true);
    expect(ok('./src', '', 'src/a.ts')).toBe(true);
    expect(ok('src/x/', '', 'src/x/y.ts')).toBe(true);
    expect(ok('src/x/', '', 'src/xy.ts')).toBe(false);
  });

  it('anchors a pattern with a slash and a glob at the root', () => {
    expect(ok('src/*.ts', '', 'src/a.ts')).toBe(true);
    expect(ok('src/*.ts', '', 'src/x/a.ts')).toBe(false);
    expect(ok('src/*.ts', '', 'lib/src/a.ts')).toBe(false);
  });

  it('survives unbalanced brackets and braces as literals', () => {
    expect(ok('a[b', '', 'a[b')).toBe(true);
    expect(ok('a{b', '', 'a{b')).toBe(true);
  });
});

describe('compilePathFilter edge cases', () => {
  it('never throws on a reversed range; the class is literal text', () => {
    expect(() => compilePathFilter('[z-a]', '')).not.toThrow();
    expect(() => compilePathFilter('', '[9-0]')).not.toThrow();
    expect(ok('[z-a]', '', 'x/[z-a]')).toBe(true);
    expect(ok('[z-a]', '', 'x/a')).toBe(false);
    expect(ok('[9-0]x', '', '5x')).toBe(false);
  });

  it('a trailing ** after ** matches any path', () => {
    expect(ok('**/**', '', 'a/b')).toBe(true);
    expect(ok('a/**/**', '', 'a/b/c')).toBe(true);
    expect(ok('**', '', 'a/b')).toBe(true);
    expect(ok('src/**', '', 'src/a/b.ts')).toBe(true);
    expect(ok('src/**', '', 'lib/a.ts')).toBe(false);
  });

  it('a negated class never matches a slash', () => {
    expect(ok('a[!x]b', '', 'a/b')).toBe(false);
    expect(ok('a[!x]b', '', 'acb')).toBe(true);
    expect(ok('a[^x]b', '', 'a/b')).toBe(false);
  });

  it('decides anchoring per brace alternative and trims them', () => {
    expect(ok('{src/a,lib}', '', 'src/a/b.ts')).toBe(true);
    expect(ok('{src/a,lib}', '', 'x/lib/a.ts')).toBe(true);
    expect(ok('{src/a,lib}', '', 'x/src/a/b.ts')).toBe(false);
    expect(ok('*.{ts, tsx}', '', 'a.tsx')).toBe(true);
    expect(ok('*.{ts, tsx}', '', 'a.ts')).toBe(true);
    expect(ok('{**/a,b}', '', 'x/y/a')).toBe(true);
  });

  it('does not blow up on many brace groups', () => {
    const many = '{a,b}'.repeat(40);
    expect(() => compilePathFilter(many, '')).not.toThrow();
  });

  it('drops a leading ./ or / and then judges the pattern by its remaining slashes', () => {
    expect(ok('./src', '', 'lib/src/a.ts')).toBe(true);
    expect(ok('./src/x', '', 'lib/src/x/a.ts')).toBe(false);
    expect(ok('/src/x', '', 'src/x/a.ts')).toBe(true);
  });

  it('an unclosed { does not swallow the commas after it', () => {
    expect(() => compilePathFilter('src/{, *.md', '')).not.toThrow();
    expect(ok('src/{, *.md', '', 'docs/a.md')).toBe(true);
    expect(ok('src/{, *.md', '', 'src/a.ts')).toBe(false);
    expect(ok('src/{, *.md', '', 'src/{/a.ts')).toBe(true);
  });

  it('treats $ ^ | as literal text', () => {
    expect(ok('a$b', '', 'a$b')).toBe(true);
    expect(ok('a$b', '', 'ab')).toBe(false);
    expect(ok('a^b', '', 'a^b')).toBe(true);
    expect(ok('a|b', '', 'a|b')).toBe(true);
    expect(ok('a|b', '', 'a')).toBe(false);
  });

  it('a ** inside braces crosses segments', () => {
    expect(ok('{a/**,b}', '', 'a/x/y')).toBe(true);
    expect(ok('{a/**,b}', '', 'c/a/x')).toBe(false);
  });
});

describe('globToRegExp', () => {
  it('* stays inside a segment, ** crosses them', () => {
    expect(globToRegExp('a/*/c').test('a/b/c')).toBe(true);
    expect(globToRegExp('a/*/c').test('a/b/x/c')).toBe(false);
    expect(globToRegExp('a/**/c').test('a/b/x/c')).toBe(true);
    expect(globToRegExp('a/**/c').test('a/c')).toBe(true);
  });
  it('escapes regex characters', () => {
    expect(globToRegExp('a.b').test('axb')).toBe(false);
    expect(globToRegExp('a+(b)').test('a+(b)')).toBe(true);
  });
  it('orBelow: every path under a match too, never a sibling that only starts the same', () => {
    expect(globToRegExp('src', true).test('src')).toBe(true);
    expect(globToRegExp('src', true).test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('src', true).test('srcs/a.ts')).toBe(false);
    expect(globToRegExp('src').test('src/a.ts')).toBe(false);
    expect(globToRegExp('src/**', true).test('src')).toBe(true);
    expect(globToRegExp('**/build', true).test('a/build/out.js')).toBe(true);
    // An expression that cannot compile still matches its own text, and what is under it.
    expect(globToRegExp('[z-a]', true).test('[z-a]/x')).toBe(true);
  });
});
