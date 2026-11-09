import { expect, test } from 'vitest';
import { activeOnLoad, fontChoices, readInstalledFonts } from './installed-fonts';

const mono = new Set(['Menlo', 'Monaco', 'Fira Code', 'JetBrains Mono', 'Courier New']);
const source = (list: string[] | null | Error) => ({
  list: () => (list instanceof Error ? Promise.reject(list) : Promise.resolve(list)),
  monospaced: (f: string) => mono.has(f)
});

test('readInstalledFonts: every family for the "not installed" check, the monospaced ones for the list', async () => {
  const fonts = await readInstalledFonts(source(['Menlo', 'Helvetica', 'Monaco', 'JetBrains Mono', '.SF NS Mono', 'Fira Code']));
  expect(fonts).toEqual({ all: ['Menlo', 'Helvetica', 'Monaco', 'JetBrains Mono', '.SF NS Mono', 'Fira Code'], mono: ['Fira Code', 'Menlo', 'Monaco'] });
});

test('readInstalledFonts: unreadable (null or a failure) is "failed", never an empty list', async () => {
  expect(await readInstalledFonts(source(null))).toBe('failed');
  expect(await readInstalledFonts(source(new Error('denied')))).toBe('failed');
});

test('fontChoices: Atelier\'s font first, then the installed ones, in one order the keys walk', () => {
  const c = fontChoices(['Courier New', 'Fira Code', 'Menlo'], '');
  expect(c.bundled.map((f) => f.family)).toEqual(['JetBrains Mono']);
  expect(c.installed.map((f) => f.family)).toEqual(['Courier New', 'Fira Code', 'Menlo']);
  expect(c.flat.map((f) => f.family)).toEqual(['JetBrains Mono', 'Courier New', 'Fira Code', 'Menlo']);
  expect(c.flat[0]!.bundled).toBe(true);
  expect(c.flat[1]!.bundled).toBe(false);
});

test('fontChoices: a query keeps the matches of each section, best first', () => {
  const c = fontChoices(['Courier New', 'Fira Code', 'Menlo', 'Monaco'], 'mo');
  expect(c.bundled.map((f) => f.family)).toEqual(['JetBrains Mono']);
  expect(c.installed.map((f) => f.family)).toEqual(['Monaco', 'Menlo']);
  expect(fontChoices(['Fira Code'], 'fira').flat.map((f) => f.family)).toEqual(['Fira Code']);
  expect(fontChoices(['Fira Code'], 'operator').flat).toEqual([]);
});

test('activeOnLoad: a query typed before the list arrived selects its best match once it does', () => {
  const flat = fontChoices(['Cascadia Mono', 'Menlo'], 'cas').flat;
  expect(activeOnLoad('cas', flat, 'JetBrains Mono')).toBe('Cascadia Mono');
  // Already on a listed font, or nothing typed: the selection stays where it is.
  expect(activeOnLoad('cas', flat, 'Cascadia Mono')).toBeNull();
  expect(activeOnLoad('', fontChoices(['Menlo'], '').flat, 'Berkeley Mono')).toBeNull();
  expect(activeOnLoad('zz', [], 'JetBrains Mono')).toBeNull();
});
