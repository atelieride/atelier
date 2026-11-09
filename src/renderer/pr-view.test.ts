import { describe, expect, test } from 'vitest';
import type { PrEntry, PrInfo } from '@shared/pr';
import { prGlyph, prShown, prTip } from './pr-view';

const pr = (o: Partial<PrInfo> = {}, ci: Partial<PrInfo['ci']> = {}): PrInfo => ({
  number: 7, title: 'Add the thing', url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, reviewDecision: null,
  ...o, ci: { state: 'none', passed: 0, failed: 0, pending: 0, failing: [], ...ci }
});

describe('prTip', () => {
  test('title, state with review, checks with failing names', () => {
    expect(prTip(pr({ isDraft: true, reviewDecision: 'CHANGES_REQUESTED' }, { state: 'failing', passed: 12, failed: 1, failing: ['build'] })))
      .toEqual(['#7 · Add the thing', 'Draft · Review: changes requested', 'Checks: 12 passed, 1 failed (build)']);
  });
  test('pending checks; approved', () => {
    expect(prTip(pr({ reviewDecision: 'APPROVED' }, { state: 'pending', passed: 1, pending: 1 })))
      .toEqual(['#7 · Add the thing', 'Open · Review: approved', 'Checks: 1 passed, 1 pending']);
  });
  test('merged without checks: no checks line', () => {
    expect(prTip(pr({ state: 'MERGED' }))).toEqual(['#7 · Add the thing', 'Merged']);
    expect(prTip(pr({ state: 'CLOSED' }))).toEqual(['#7 · Add the thing', 'Closed']);
  });
  test('review required; several failing; all passing', () => {
    expect(prTip(pr({ reviewDecision: 'REVIEW_REQUIRED' }, { state: 'failing', failed: 2, failing: ['a', 'b'] })))
      .toEqual(['#7 · Add the thing', 'Open · Review required', 'Checks: 0 passed, 2 failed (a, b)']);
    expect(prTip(pr({}, { state: 'passing', passed: 3 }))[2]).toBe('Checks: 3 passed');
  });
});

test('glyph per state: draft wins over open', () => {
  expect(prGlyph(pr())).toBe('prOpen');
  expect(prGlyph(pr({ isDraft: true }))).toBe('prDraft');
  expect(prGlyph(pr({ state: 'MERGED' }))).toBe('prMerged');
  expect(prGlyph(pr({ state: 'CLOSED' }))).toBe('prClosed');
});

test('a chip only for an ok entry with the setting on', () => {
  const ok: PrEntry = { root: '/r', branch: 'b', status: 'ok', pr: pr() };
  expect(prShown(ok, true)).toEqual(pr());
  expect(prShown(ok, false)).toBeNull();
  expect(prShown(undefined, true)).toBeNull();
  for (const status of ['none', 'missing', 'auth'] as const) expect(prShown({ root: '/r', branch: 'b', status }, true)).toBeNull();
});
