import { describe, expect, test } from 'vitest';
import { checksUrl, ciSummary, parseGhPr, prKey } from './pr';

const run = (name: string, status: string, conclusion = '') => ({ __typename: 'CheckRun', name, status, conclusion, workflowName: 'CI' });
const ctx = (context: string, state: string) => ({ __typename: 'StatusContext', context, state });

describe('ciSummary', () => {
  test.each([
    ['empty: no checks', [], { state: 'none', passed: 0, failed: 0, pending: 0, failing: [] }],
    ['all passing (success, neutral and skipped count as passed)', [run('build', 'COMPLETED', 'SUCCESS'), run('lint', 'COMPLETED', 'NEUTRAL'), run('docs', 'COMPLETED', 'SKIPPED'), ctx('ci/x', 'SUCCESS')],
      { state: 'passing', passed: 4, failed: 0, pending: 0, failing: [] }],
    ['a failed run', [run('build', 'COMPLETED', 'FAILURE'), run('lint', 'COMPLETED', 'SUCCESS')], { state: 'failing', passed: 1, failed: 1, pending: 0, failing: ['build'] }],
    ['timed out, cancelled, action required, startup failure all fail', [run('a', 'COMPLETED', 'TIMED_OUT'), run('b', 'COMPLETED', 'CANCELLED'), run('c', 'COMPLETED', 'ACTION_REQUIRED'), run('d', 'COMPLETED', 'STARTUP_FAILURE')],
      { state: 'failing', passed: 0, failed: 4, pending: 0, failing: ['a', 'b', 'c'] }],
    ['status contexts: failure and error fail', [ctx('ci/one', 'FAILURE'), ctx('ci/two', 'ERROR'), ctx('ci/three', 'SUCCESS')],
      { state: 'failing', passed: 1, failed: 2, pending: 0, failing: ['ci/one', 'ci/two'] }],
    ['a run in progress is pending', [run('build', 'IN_PROGRESS'), run('lint', 'COMPLETED', 'SUCCESS')], { state: 'pending', passed: 1, failed: 0, pending: 1, failing: [] }],
    ['queued and waiting runs are pending', [run('a', 'QUEUED'), run('b', 'WAITING'), run('c', 'PENDING')], { state: 'pending', passed: 0, failed: 0, pending: 3, failing: [] }],
    ['contexts pending or expected are pending', [ctx('a', 'PENDING'), ctx('b', 'EXPECTED')], { state: 'pending', passed: 0, failed: 0, pending: 2, failing: [] }],
    ['mixed: failing wins over pending', [run('build', 'COMPLETED', 'FAILURE'), run('e2e', 'IN_PROGRESS'), ctx('deploy', 'PENDING'), run('lint', 'COMPLETED', 'SUCCESS')],
      { state: 'failing', passed: 1, failed: 1, pending: 2, failing: ['build'] }]
  ])('%s', (_name, rollup, expected) => {
    expect(ciSummary(rollup as never)).toEqual(expected);
  });

  test('unknown entries are ignored; failing names capped at three and at 100 characters', () => {
    const r = ciSummary([{ __typename: 'Other' }, run('x'.repeat(300), 'COMPLETED', 'FAILURE'), run('b', 'COMPLETED', 'FAILURE'), run('c', 'COMPLETED', 'FAILURE'), run('d', 'COMPLETED', 'FAILURE')] as never);
    expect(r.failed).toBe(4);
    expect(r.failing).toHaveLength(3);
    expect(r.failing[0]).toHaveLength(100);
  });
});

const gh = (o: Record<string, unknown> = {}) => ({
  number: 7, title: 'Add the thing', url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED',
  statusCheckRollup: [run('build', 'COMPLETED', 'SUCCESS')], somethingNew: 1, ...o
});

describe('parseGhPr', () => {
  test('reads gh pr view JSON into a PR with its CI summary; unknown fields are ignored', () => {
    expect(parseGhPr(JSON.stringify(gh()))).toEqual({
      number: 7, title: 'Add the thing', url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED',
      ci: { state: 'passing', passed: 1, failed: 0, pending: 0, failing: [] }
    });
  });

  test('titles truncated to 200 characters; empty or missing review decision is null; no rollup is no checks', () => {
    const p = parseGhPr(JSON.stringify(gh({ title: 'é'.repeat(500), reviewDecision: '', statusCheckRollup: undefined })))!;
    expect(p.title).toHaveLength(200);
    expect(p.reviewDecision).toBeNull();
    expect(p.ci.state).toBe('none');
    expect(parseGhPr(JSON.stringify(gh({ statusCheckRollup: null })))!.ci.state).toBe('none');
  });

  test('refuses non-https URLs, bad numbers, unknown states, broken JSON', () => {
    expect(parseGhPr(JSON.stringify(gh({ url: 'http://github.com/o/r/pull/7' })))).toBeNull();
    expect(parseGhPr(JSON.stringify(gh({ url: 'javascript:alert(1)' })))).toBeNull();
    expect(parseGhPr(JSON.stringify(gh({ url: 'https://github.com/o/r/pull/7\nx' })))).toBeNull();
    expect(parseGhPr(JSON.stringify(gh({ number: -1 })))).toBeNull();
    expect(parseGhPr(JSON.stringify(gh({ number: 1.5 })))).toBeNull();
    expect(parseGhPr(JSON.stringify(gh({ state: 'WEIRD' })))).toBeNull();
    expect(parseGhPr('{')).toBeNull();
    expect(parseGhPr('[]')).toBeNull();
  });

  test('a huge rollup is summarized over every entry (a failure past the first hundred still fails)', () => {
    const many = [...Array.from({ length: 150 }, (_, i) => run(`ok${i}`, 'COMPLETED', 'SUCCESS')), run('late', 'COMPLETED', 'FAILURE')];
    const p = parseGhPr(JSON.stringify(gh({ statusCheckRollup: many })))!;
    expect(p.ci).toEqual({ state: 'failing', passed: 150, failed: 1, pending: 0, failing: ['late'] });
  });
});

test('keys and the checks URL', () => {
  expect(prKey('/r', 'feature/x')).toBe('/r\nfeature/x');
  expect(checksUrl('https://github.com/o/r/pull/7')).toBe('https://github.com/o/r/pull/7/checks');
});
