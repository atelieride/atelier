import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { capUtf8, oneLine } from './text';

// The connectors handle untrusted text, and their tests and cleaners name bidi overrides, zero-width characters and
// separators on purpose. Raw, those are invisible in review (a cleaner's character class could silently lose one), so
// every file under src/main/connectors/ spells them as \u escapes.
const INVISIBLE = new RegExp('[\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\u2028\\u2029\\ufeff]');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : /\.[cm]?[jt]sx?$/.test(n) ? [p] : []; });

describe('connector text', () => {
  test('every source and test under src/main/connectors/ spells invisible characters as escapes, never raw', () => {
    const found = files(__dirname).filter((f) => INVISIBLE.test(readFileSync(f, 'utf8'))).map((f) => relative(__dirname, f));
    expect(found).toEqual([]);
  });

  test('the guard sees a raw character', () => {
    expect(INVISIBLE.test(`a${String.fromCharCode(0x202e)}b`)).toBe(true);
    expect(INVISIBLE.test('a\\u202eb')).toBe(false);
  });

  test('oneLine and capUtf8 (shared by the connectors)', () => {
    expect(oneLine(' a\n b ')).toBe('a b');
    expect(oneLine(undefined)).toBe('');
    expect(Buffer.byteLength(capUtf8('é'.repeat(10), 5))).toBe(4);
  });
});
