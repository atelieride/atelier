import { afterEach, expect, test, vi } from 'vitest';
import { createClipboard } from './clipboard';
import type { DemoContext } from './context';

const ctx = () => ({ state: { clipboard: null } }) as unknown as DemoContext;

afterEach(() => vi.unstubAllGlobals());

test("a formatted copy (Ask's) reaches the browser's clipboard with its HTML flavour; the demo keeps the text", async () => {
  const written: Record<string, string>[] = [];
  class Item { constructor(readonly parts: Record<string, Blob>) {} }
  vi.stubGlobal('ClipboardItem', Item);
  vi.stubGlobal('navigator', { clipboard: {
    write: async (items: Item[]) => {
      for (const i of items) written.push(Object.fromEntries(await Promise.all(Object.entries(i.parts).map(async ([k, b]) => [k, await b.text()]))));
    },
    writeText: async () => { throw new Error('plain write for a formatted copy'); }
  } });
  const c = ctx();
  expect(await createClipboard(c).write('**a**', '<p><strong>a</strong></p>')).toBe(true);
  await vi.waitFor(() => expect(written).toEqual([{ 'text/plain': '**a**', 'text/html': '<p><strong>a</strong></p>' }]));
  expect(await createClipboard(c).read()).toBe('**a**');
});

test('a plain copy stays a plain write; no browser clipboard at all still copies inside the demo', async () => {
  const texts: string[] = [];
  vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => { texts.push(t); } } });
  const c = ctx();
  expect(await createClipboard(c).write('x')).toBe(true);
  expect(texts).toEqual(['x']);
  vi.stubGlobal('navigator', {});
  expect(await createClipboard(c).write('y', '<p>y</p>')).toBe(true);
  expect(await createClipboard(c).read()).toBe('y');
});

test("the browser refusing the formatted write (or ClipboardItem missing its way): the text still goes, as before", async () => {
  const texts: string[] = [];
  vi.stubGlobal('ClipboardItem', class { constructor() { throw new Error('unsupported'); } });
  vi.stubGlobal('navigator', { clipboard: { write: async () => {}, writeText: async (t: string) => { texts.push(t); } } });
  expect(await createClipboard(ctx()).write('a', '<p>a</p>')).toBe(true);
  await vi.waitFor(() => expect(texts).toEqual(['a']));
  class Item { constructor(readonly parts: Record<string, Blob>) {} }
  vi.stubGlobal('ClipboardItem', Item);
  vi.stubGlobal('navigator', { clipboard: { write: async () => { throw new Error('NotAllowedError'); }, writeText: async (t: string) => { texts.push(t); } } });
  expect(await createClipboard(ctx()).write('b', '<p>b</p>')).toBe(true);
  await vi.waitFor(() => expect(texts).toEqual(['a', 'b']));
});
