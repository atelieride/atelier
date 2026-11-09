import { expect, test } from 'vitest';
import { bento, rows, yourMac } from '../../src/content/features';
import { llmsTxt } from '../../src/lib/llms';

// /llms.txt for AI assistants, built from the site's own copy.
const txt = llmsTxt({ siteUrl: 'https://useatelier.dev', minMacOS: '13 Ventura' }, { yourMac, rows, bento });

test('llms.txt: title, summary quote, then sections (llmstxt.org layout)', () => {
  expect(txt).toMatch(/^# Atelier\n\n> .+\n/);
  expect(txt).toContain('macOS 13 Ventura or later');
  expect(txt.endsWith('\n')).toBe(true);
});

test('it follows the site copy: the home\'s "your Mac" cells, every feature row, bullet and bento title', () => {
  for (const c of yourMac) expect(txt).toContain(`- ${c.title}: ${c.text}`);
  for (const r of rows) { expect(txt).toContain(r.title); for (const b of r.bullets) expect(txt).toContain(b); }
  for (const b of bento) expect(txt).toContain(b.title);
});

test('links are absolute and point at real pages, the features page first', () => {
  const links = [...txt.matchAll(/\]\((https:\/\/[^)]+)\)/g)].map((m) => new URL(m[1]!).pathname);
  expect(links).toEqual(['/features', '/download', '/changelog', '/support', '/privacy', '/atelieride/atelier']);
});
