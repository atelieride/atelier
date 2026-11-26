import { describe, expect, it } from 'vitest';
import { chunks, pageOf, PAGE_BYTES, PAGE_ENTRIES } from './pages';
import type { Entry } from './types';

const reply = (n: number, text: string): Entry => ({ n, at: null, k: 'reply', text });
const bytes = (es: Entry[]) => Buffer.byteLength(JSON.stringify(es));
// A `chat` message as the host sends it, with long identifiers: the whole message must stay within PAGE_BYTES.
const wrapped = (es: Entry[]) =>
  Buffer.byteLength(JSON.stringify({ t: 'chat', id: 'x'.repeat(64), rid: 'r'.repeat(64), conversation: 'c'.repeat(128), entries: es, start: true, pending: true }));

describe('pages', () => {
  it('pages chain from the newest to the first: no gap, no duplicate, each within its caps', () => {
    const all = Array.from({ length: 5000 }, (_, i) => reply(i + 1, 'a'.repeat(1024 + ((i * 7919) % (29 * 1024)))));
    const seen: number[] = [];
    let before: number | undefined;
    for (;;) {
      const page = pageOf(all, before);
      expect(page.entries.length).toBeGreaterThan(0);
      expect(page.entries.length).toBeLessThanOrEqual(PAGE_ENTRIES);
      expect(bytes(page.entries)).toBeLessThanOrEqual(PAGE_BYTES);
      expect(wrapped(page.entries)).toBeLessThanOrEqual(PAGE_BYTES);
      seen.unshift(...page.entries.map((e) => e.n));
      if (page.start) break;
      before = page.entries[0]!.n;
    }
    expect(seen).toEqual(all.map((e) => e.n));
  });

  it('an empty conversation is one empty page, at the start', () => {
    expect(pageOf([])).toEqual({ entries: [], start: true });
  });

  it('one entry larger than a page still goes, alone', () => {
    const all = [reply(1, 'a'), reply(2, 'b'.repeat(PAGE_BYTES + 10)), reply(3, 'c')];
    const p = pageOf(all, 3);
    expect(p.entries.map((e) => e.n)).toEqual([2]);
    expect(p.start).toBe(false);
    expect(chunks(all).map((c) => c.map((e) => e.n))).toEqual([[1], [2], [3]]);
  });

  it('counts UTF-8 bytes, not characters', () => {
    // 60 000 CJK characters are 180 000 bytes: three of them cannot share a page.
    const all = [1, 2, 3, 4].map((n) => reply(n, '漢'.repeat(60000)));
    const p = pageOf(all);
    expect(p.entries.map((e) => e.n)).toEqual([3, 4]);
    expect(p.entries.length).toBe(2);
    expect(wrapped(p.entries)).toBeLessThanOrEqual(PAGE_BYTES);
    expect(chunks(all).every((c) => wrapped(c) <= PAGE_BYTES)).toBe(true);
    const emoji = Array.from({ length: 50 }, (_, i) => reply(i + 1, '😀'.repeat(8000)));
    expect(pageOf(emoji).entries.length).toBeLessThan(50);
    expect(wrapped(pageOf(emoji).entries)).toBeLessThanOrEqual(PAGE_BYTES);
  });

  it('start is true when the page holds entry 1, and before filters', () => {
    const all = [1, 2, 3].map((n) => reply(n, 'x'));
    expect(pageOf(all)).toMatchObject({ start: true });
    expect(pageOf(all, 3).entries.map((e) => e.n)).toEqual([1, 2]);
    expect(pageOf(all, 1)).toEqual({ entries: [], start: true });
  });

  it('live chunks keep the order and the cap', () => {
    const all = Array.from({ length: 300 }, (_, i) => reply(i + 1, 'é'.repeat(5000 + (i % 13) * 3000)));
    const cs = chunks(all);
    expect(cs.length).toBeGreaterThan(1);
    expect(cs.flat().map((e) => e.n)).toEqual(all.map((e) => e.n));
    for (const c of cs) {
      expect(c.length).toBeGreaterThan(0);
      expect(wrapped(c)).toBeLessThanOrEqual(PAGE_BYTES);
    }
    expect(chunks([])).toEqual([]);
  });
});
