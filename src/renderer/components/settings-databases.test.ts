import { expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { Databases } from './Settings';
import { Icon } from './Icon';

// Settings › Databases.
const html = () => renderToStaticMarkup(createElement(Databases, { s: DEFAULT_SETTINGS }));

/** The options of one Segmented, as [text, aria-checked]. */
const group = (h: string, label: string): [string, string][] => {
  const start = h.indexOf(`role="radiogroup" aria-label="${label}"`);
  expect(start).toBeGreaterThan(-1);
  const body = h.slice(start, h.indexOf('</div>', start));
  return [...body.matchAll(/aria-checked="(true|false)"[^>]*>([^<]*)</g)].map((m): [string, string] => [m[2] ?? '', m[1] ?? '']);
};

test('the section shows the four rows with their hints and note', () => {
  const h = html();
  for (const text of ['Show Databases', 'Times in', 'Rows per fetch', 'Query timeout']) expect(h).toContain(text);
  // Nothing is looked for in the project; Auto is about saved connections only.
  expect(h).toContain('Auto: when a connection is saved for this project or every project');
  expect(h).toContain('Rows load as you scroll, this many at a time');
  expect(h).toContain('Connections live in the Databases sidebar. Every query runs in a read-only transaction.');
});

test('each option exists and the defaults are the selected ones', () => {
  const h = html();
  expect(group(h, 'Show Databases')).toEqual([['Auto', 'true'], ['Always', 'false'], ['Never', 'false']]);
  expect(group(h, 'Times in')).toEqual([['Local', 'true'], ['UTC', 'false'], ['As stored', 'false']]);
  expect(group(h, 'Rows per fetch')).toEqual([['50', 'false'], ['100', 'true'], ['250', 'false'], ['500', 'false']]);
  expect(h).toMatch(/<span class="mono"[^>]*>15 s<\/span>/);
});

test('the database icon draws the cylinder: ellipse and both paths', () => {
  const h = renderToStaticMarkup(createElement(Icon, { name: 'databases' }));
  expect(h).toContain('<ellipse cx="10" cy="5.2" rx="6" ry="2.2"');
  expect(h).toContain('<path d="M4 5.2v9.6c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2V5.2"');
  expect(h).toContain('<path d="M4 10c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2"');
});
