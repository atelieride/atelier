// Commit detail helpers: the message split into subject, body and trailers; which
// sides of a file to read; the unified diff the Review's renderer shows. Pure functions.
import type { ScmBlob, ScmFileChange } from '@shared/scm';
import { unifiedDoc } from '../editor/linediff';
import { normalizeEol } from '../editor/conflict';
import { compactDoc, hunksOf, type ReviewDoc } from '../review';

/** Past this many lines on either side the diff isn't drawn. */
export const MAX_DIFF_LINES = 20000;
const TRAILER = /^([A-Za-z][A-Za-z0-9-]*):\s+(.+)$/;

export function splitTrailers(message: string): { subject: string; body: string; trailers: { key: string; value: string }[] } {
  const lines = message.replace(/\s+$/, '').split('\n');
  const subject = lines[0] ?? '';
  const rest = lines.slice(1).join('\n').replace(/^\n+/, '');
  const paras = rest.split(/\n\s*\n/);
  const last = paras.at(-1) ?? '';
  const tl = last.split('\n').filter(Boolean);
  if (paras.length > 0 && tl.length > 0 && tl.every((l) => TRAILER.test(l)) && (paras.length > 1 || !rest.includes('\n\n'))) {
    // A lone paragraph right after the subject is body unless it is all trailers.
    const trailers = tl.map((l) => { const m = TRAILER.exec(l)!; return { key: m[1]!, value: m[2]!.trim() }; });
    return { subject, body: paras.slice(0, -1).join('\n\n').trim(), trailers };
  }
  return { subject, body: rest.trim(), trailers: [] };
}

export type DiffPlan =
  | { kind: 'load'; base: { oid: string; rel: string } | null; head: { oid: string; rel: string } | null }
  | { kind: 'submodule'; to: string }
  | { kind: 'mode'; from: string; to: string };

export function diffPlan(f: ScmFileChange, base: string, oid: string): DiffPlan {
  if (f.oldMode === '160000' || f.newMode === '160000') return { kind: 'submodule', to: f.newOid.slice(0, 7) };
  if (f.oldOid === f.newOid && f.oldMode !== f.newMode) return { kind: 'mode', from: f.oldMode, to: f.newMode };
  return {
    kind: 'load',
    base: f.kind === 'A' ? null : { oid: base, rel: f.kind === 'R' && f.origRel ? f.origRel : f.rel },
    head: f.kind === 'D' ? null : { oid, rel: f.rel }
  };
}

/** What the detail's file list shows: still loading (the detail of another commit doesn't count), files, none, or a compare without a common ancestor. */
export function detailBody(o: { isWorktree: boolean; isCompare: boolean; detailOid: string | null; commitOid: string; headOid?: string | null; mergeBase: string | null | undefined; files: number }): 'loading' | 'files' | 'empty' | 'noCommonHistory' {
  if (o.isWorktree) return o.files ? 'files' : 'empty';
  if (o.isCompare) {
    if (o.mergeBase === null) return 'noCommonHistory';
    if (!o.mergeBase || !o.detailOid || o.detailOid !== o.headOid) return 'loading';
  } else if (o.detailOid !== o.commitOid) return 'loading';
  return o.files ? 'files' : 'empty';
}

export type DiffView = { kind: 'diff' | 'notUtf8'; doc: ReviewDoc } | { kind: 'tooLarge'; size?: number } | { kind: 'binary' | 'empty' };

/** "3.4 MB", "2.4 KB". */
export function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

const lineCount = (s: string) => (s ? s.split('\n').length : 0);

/** The unified diff of two sides (null: the side doesn't exist, an empty file). */
export function buildDiff(a: ScmBlob | null, b: ScmBlob | null): DiffView {
  if (a?.kind === 'tooLarge' || b?.kind === 'tooLarge') {
    const size = Math.max(a?.kind === 'tooLarge' ? a.size ?? 0 : 0, b?.kind === 'tooLarge' ? b.size ?? 0 : 0);
    return size ? { kind: 'tooLarge', size } : { kind: 'tooLarge' };
  }
  if (a?.kind === 'binary' || b?.kind === 'binary') return { kind: 'binary' };
  const at = a?.kind === 'text' ? normalizeEol(a.text) : '';
  const bt = b?.kind === 'text' ? normalizeEol(b.text) : '';
  if (lineCount(at) > MAX_DIFF_LINES || lineCount(bt) > MAX_DIFF_LINES) return { kind: 'tooLarge' };
  const doc = unifiedDoc(at, bt);
  if (!doc) return { kind: 'tooLarge' };
  const hunks = hunksOf(doc);
  if (!hunks.length) return { kind: 'empty' };
  const notUtf8 = (a?.kind === 'text' && a.notUtf8) || (b?.kind === 'text' && b.notUtf8);
  return { kind: notUtf8 ? 'notUtf8' : 'diff', doc: compactDoc(doc, hunks) };
}
