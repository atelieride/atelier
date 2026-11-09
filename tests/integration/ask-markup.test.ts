import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Ask: what assistive technology hears, pinned in the markup (the renderer has no DOM tests; the
// e2e checks the same from outside).

const src = (rel: string) => readFileSync(join(__dirname, '../../src/renderer/components/companion', rel), 'utf8');

test('the sidebar mark of a popped-out row says what its click does (show its window), as its tooltip does', () => {
  const row = readFileSync(join(__dirname, '../../src/renderer/components/SessionRow.tsx'), 'utf8');
  expect(row).toMatch(/aria-label=\{popped \? t\.companion\.markLabelWindow\(term\.title\) : t\.companion\.markLabel\(term\.title\)\}/);
  const en = readFileSync(join(__dirname, '../../src/renderer/i18n/en.ts'), 'utf8');
  expect(en).toContain("markLabelWindow: (title: string) => `Ask answered while you were away: show the window of ${title}`");
});

test('the composer saves a half-typed question as it is typed, never only when it unmounts (a remounting host reads it first)', () => {
  const composer = src('Composer.tsx');
  expect(composer).toMatch(/useEffect\(\(\) => \{ useApp\.getState\(\)\.setAskDraft\(sid, text\); \}, \[sid, text\]\);/);
  expect(composer).not.toMatch(/latest\.current/);
});

test('"Catching up…" is announced once: a stable label in the status, the visible copy hidden from screen readers', () => {
  const card = src('CatchUpCard.tsx');
  const body = card.slice(card.indexOf('export function CatchingUp'));
  // The label screen readers hear never remounts: not keyed by the trace.
  expect(body).toMatch(/<span className="sr-only">\{run\.queued \? t\.companion\.waitingTurn : t\.companion\.catchingUp\}<\/span>/);
  // The visible copy (no sweep any more) and the trace line: for the eyes only.
  expect(body).toMatch(/<span className="ask-catching-t" aria-hidden="true">\{t\.companion\.catchingUp\}<\/span>/);
  expect(body).toMatch(/<span className="ask-catching-t" aria-hidden="true">\{t\.companion\.waitingTurn\}<\/span>/);
  expect(body).not.toMatch(/key=\{run\.trace\.length\}(?![^>]*aria-hidden="true")/);
});
