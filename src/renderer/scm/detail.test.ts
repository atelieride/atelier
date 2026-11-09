import { expect, test } from 'vitest';
import type { ScmFileChange } from '@shared/scm';
import { buildDiff, diffPlan, splitTrailers } from './detail';

test('splitTrailers: subject, body, the trailing block of trailers', () => {
  expect(splitTrailers('feat(x): add\n\nA body line.\nWith key: value inside.\n\nCo-authored-by: Claude <noreply@anthropic.com>\nSigned-off-by: Ada <f@x.test>'))
    .toEqual({ subject: 'feat(x): add', body: 'A body line.\nWith key: value inside.', trailers: [{ key: 'Co-authored-by', value: 'Claude <noreply@anthropic.com>' }, { key: 'Signed-off-by', value: 'Ada <f@x.test>' }] });
  expect(splitTrailers('just a subject')).toEqual({ subject: 'just a subject', body: '', trailers: [] });
  // A last paragraph that is not all trailers stays body.
  expect(splitTrailers('s\n\nNote: this is prose\nand more prose')).toEqual({ subject: 's', body: 'Note: this is prose\nand more prose', trailers: [] });
});

const f = (o: Partial<ScmFileChange>): ScmFileChange => ({ rel: 'a.ts', kind: 'M', added: 1, removed: 1, oldMode: '100644', newMode: '100644', oldOid: '1'.repeat(40), newOid: '2'.repeat(40), ...o });
const B = 'b'.repeat(40); const O = 'c'.repeat(40);

test('diffPlan: which sides to read for each kind', () => {
  expect(diffPlan(f({}), B, O)).toEqual({ kind: 'load', base: { oid: B, rel: 'a.ts' }, head: { oid: O, rel: 'a.ts' } });
  expect(diffPlan(f({ kind: 'A' }), B, O)).toEqual({ kind: 'load', base: null, head: { oid: O, rel: 'a.ts' } });
  expect(diffPlan(f({ kind: 'D' }), B, O)).toEqual({ kind: 'load', base: { oid: B, rel: 'a.ts' }, head: null });
  expect(diffPlan(f({ kind: 'R', rel: 'new.ts', origRel: 'old.ts' }), B, O)).toEqual({ kind: 'load', base: { oid: B, rel: 'old.ts' }, head: { oid: O, rel: 'new.ts' } });
  expect(diffPlan(f({ oldMode: '160000', newMode: '160000', newOid: 'abcdef1'.padEnd(40, '0') }), B, O)).toEqual({ kind: 'submodule', to: 'abcdef1' });
  expect(diffPlan(f({ oldMode: '100644', newMode: '100755', oldOid: '1'.repeat(40), newOid: '1'.repeat(40) }), B, O)).toEqual({ kind: 'mode', from: '100644', to: '100755' });
});

const txt = (text: string, notUtf8 = false) => ({ kind: 'text' as const, text, notUtf8 });

test('buildDiff: hunks; binary, too large, identical, a missing side, not UTF-8, CRLF', () => {
  const d = buildDiff(txt('a\nb\nc\n'), txt('a\nB\nc\n'));
  expect(d.kind).toBe('diff');
  if (d.kind === 'diff') { expect(d.doc.hunks).toHaveLength(1); expect(d.doc.lines.filter((l) => l.kind === 'add')).toHaveLength(1); }
  expect(buildDiff(txt('x'), { kind: 'binary', size: 3 }).kind).toBe('binary');
  expect(buildDiff({ kind: 'tooLarge' }, txt('x')).kind).toBe('tooLarge');
  expect(buildDiff(txt('same\n'), txt('same\n')).kind).toBe('empty');
  const added = buildDiff(null, txt('new\nfile\n'));
  expect(added.kind === 'diff' && added.doc.lines.every((l) => l.kind === 'add')).toBe(true);
  expect(buildDiff(txt('a\n'), txt('b\n', true)).kind).toBe('notUtf8');
  expect(buildDiff(txt('a\r\nb\r\n'), txt('a\nb\n')).kind).toBe('empty');
  const many = Array.from({ length: 20001 }, (_, i) => `l${i}`).join('\n');
  expect(buildDiff(txt(''), txt(many)).kind).toBe('tooLarge');
});

test('detailBody: loading until the detail of this very commit arrives; compares without a common ancestor say so', async () => {
  const { detailBody } = await import('./detail');
  const base = { isWorktree: false, isCompare: false, mergeBase: undefined, files: 0 };
  expect(detailBody({ ...base, detailOid: 'a', commitOid: 'b', files: 3 })).toBe('loading');
  expect(detailBody({ ...base, detailOid: null, commitOid: 'b' })).toBe('loading');
  expect(detailBody({ ...base, detailOid: 'b', commitOid: 'b' })).toBe('empty');
  expect(detailBody({ ...base, detailOid: 'b', commitOid: 'b', files: 2 })).toBe('files');
  expect(detailBody({ ...base, isWorktree: true, detailOid: null, commitOid: 'WORKTREE', files: 1 })).toBe('files');
  const cmp = { ...base, isCompare: true, commitOid: 'COMPARE' };
  expect(detailBody({ ...cmp, detailOid: null })).toBe('loading');
  expect(detailBody({ ...cmp, detailOid: null, mergeBase: null })).toBe('noCommonHistory');
  expect(detailBody({ ...cmp, detailOid: 'h', headOid: 'h', mergeBase: 'm', files: 4 })).toBe('files');
  expect(detailBody({ ...cmp, detailOid: 'old', headOid: 'h', mergeBase: 'm', files: 4 })).toBe('loading');
});

test('buildDiff: a too-large side carries its size for the notice', async () => {
  const { buildDiff, sizeLabel } = await import('./detail');
  expect(buildDiff({ kind: 'tooLarge', size: 3_565_158 }, { kind: 'text', text: 'x', notUtf8: false })).toEqual({ kind: 'tooLarge', size: 3_565_158 });
  expect(buildDiff({ kind: 'tooLarge' }, null)).toEqual({ kind: 'tooLarge' });
  expect(sizeLabel(3_565_158)).toBe('3.4 MB');
  expect(sizeLabel(2_500)).toBe('2.4 KB');
});
