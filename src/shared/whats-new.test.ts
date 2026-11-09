import { expect, test } from 'vitest';
import { MAX_WHATS_NEW, changeCount, changelogSections, inlineMarkdown, noteBlocks, whatsNewSections } from './whats-new';

const md = `# Changelog

Release notes for Atelier.

## 0.3.0-beta.1

- **Big thing**: it works.

## 0.2.0

- Stable.

## 0.2.0-beta.9

- Nine.

## 0.2.0-beta.8

- Eight.
`;

test('the changelog sections ("## <version>"), in file order, the intro left out', () => {
  expect(changelogSections(md)).toEqual([
    { version: '0.3.0-beta.1', body: '- **Big thing**: it works.' },
    { version: '0.2.0', body: '- Stable.' },
    { version: '0.2.0-beta.9', body: '- Nine.' },
    { version: '0.2.0-beta.8', body: '- Eight.' }
  ]);
  expect(changelogSections('')).toEqual([]);
});

test('what is new: the versions after the previous launch up to the running one, newest first', () => {
  const r = whatsNewSections(md, '0.2.0-beta.8', '0.2.0');
  expect(r.sections.map((s) => s.version)).toEqual(['0.2.0', '0.2.0-beta.9']);
  expect(r.more).toBe(0);
  // A newer section (written for the next release) is not this app's news.
  expect(whatsNewSections(md, '0.2.0-beta.9', '0.2.0').sections.map((s) => s.version)).toEqual(['0.2.0']);
  // No previous version (opened from the menu): the running version's section.
  expect(whatsNewSections(md, null, '0.2.0-beta.9').sections.map((s) => s.version)).toEqual(['0.2.0-beta.9']);
  // Not in the changelog (a local build): nothing.
  expect(whatsNewSections(md, null, '9.9.9').sections).toEqual([]);
});

test('what is new: a long gap shows the latest few and counts the rest', () => {
  const r = whatsNewSections(md, '0.1.0', '0.3.0-beta.1', 2);
  expect(r.sections.map((s) => s.version)).toEqual(['0.3.0-beta.1', '0.2.0']);
  expect(r.more).toBe(2);
  // By default the latest six (the e2e that relaunched across a long gap moved here).
  const many = Array.from({ length: 9 }, (_, i) => `## 0.${9 - i}.0\n\n- change ${i}\n`).join('\n');
  const d = whatsNewSections(many, '0.0.1', '0.9.0');
  expect(d.sections).toHaveLength(MAX_WHATS_NEW);
  expect(MAX_WHATS_NEW).toBe(6);
  expect(d.more).toBe(3);
});

test('inline Markdown: bold and code spans as tokens, everything else plain text (never HTML)', () => {
  expect(inlineMarkdown('**Fetch** in `git/fetch.ts` <b>x</b> ** not closed')).toEqual([
    { kind: 'bold', text: 'Fetch' }, { kind: 'text', text: ' in ' }, { kind: 'code', text: 'git/fetch.ts' }, { kind: 'text', text: ' <b>x</b> ** not closed' }
  ]);
  expect(inlineMarkdown('')).toEqual([]);
});

test('note blocks: a bullet carries its wrapped lines, paragraphs join their lines, headings stand alone', () => {
  expect(noteBlocks('Intro line\nstill intro.\n\n### Fixes\n- **One**: wraps\n  onto two lines.\n- Two.\n\nAfter.')).toEqual([
    { kind: 'p', text: 'Intro line still intro.' },
    { kind: 'h', text: 'Fixes' },
    { kind: 'ul', items: ['**One**: wraps onto two lines.', 'Two.'] },
    { kind: 'p', text: 'After.' }
  ]);
});

test('a section counts its bullets (what a collapsed version says it holds)', () => {
  expect(changeCount('- one\n  wrapped\n- two\n\n### Fixes\n- three')).toBe(3);
  expect(changeCount('Just a paragraph.')).toBe(0);
});
