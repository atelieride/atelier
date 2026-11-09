import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parseChangelog } from '../../src/lib/changelog';

const md = [
  '# Changelog', '', 'Intro.', '',
  '## 0.3.0', '', '- **Stable**: first stable.', '',
  '## 0.3.0-beta.2', '', '<!-- Edit before releasing: user-facing, short. Commits since the last tag: -->', '- feat: wip', '',
  '## 0.2.0-beta.8', '', '- One', '  continued line', '  - nested `code`', '',
  '## 0.2.0-beta.5', '', 'Not published: built on a new build machine.', ''
].join('\n');

test('versions newest first, betas flagged, bodies kept as markdown', () => {
  expect(parseChangelog(md)).toEqual([
    { version: '0.3.0', beta: false, body: '- **Stable**: first stable.' },
    { version: '0.2.0-beta.8', beta: true, body: '- One\n  continued line\n  - nested `code`' }
  ]);
});

test('"Not published" sections and unedited release stubs never show', () => {
  const versions = parseChangelog(md).map((r) => r.version);
  expect(versions).not.toContain('0.2.0-beta.5');
  expect(versions).not.toContain('0.3.0-beta.2');
});

test('the real CHANGELOG.md parses and has at least one published version', () => {
  const real = parseChangelog(readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8'));
  expect(real.length).toBeGreaterThan(0);
  expect(real.every((r) => r.body.length > 0)).toBe(true);
});
