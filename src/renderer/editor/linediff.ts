import { diffLines, diffWordsWithSpace } from 'diff';

export type GutterMark = 'add' | 'mod' | 'del';

// Myers diff is nearly quadratic when almost everything changes: past this time we give up
// (the window must not freeze on a regenerated package-lock.json).
const DIFF_TIMEOUT_MS = 150;
const diff = (a: string, b: string) => diffLines(a, b, { timeout: DIFF_TIMEOUT_MS }) as ReturnType<typeof diffLines> | undefined;

const split = (s: string) => { const l = s.split('\n'); if (l.at(-1) === '') l.pop(); return l; };

export function gutterMarks(original: string, current: string): Map<number, GutterMark> | null {
  const marks = new Map<number, GutterMark>();
  const parts = diff(original, current);
  if (!parts) return null;
  let line = 1;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const n = split(p.value).length;
    if (p.removed) {
      const next = parts[i + 1];
      if (next?.added) {
        // Removal followed by addition = modification; extra lines are additions, missing ones get a removal marker.
        const m = split(next.value).length;
        for (let k = 0; k < m; k++) marks.set(line + k, k < n ? 'mod' : 'add');
        line += m;
        i++;
      } else {
        const at = Math.max(1, line);
        if (!marks.has(at)) marks.set(at, 'del');
      }
      continue;
    }
    if (p.added) { for (let k = 0; k < n; k++) marks.set(line + k, 'add'); line += n; continue; }
    line += n;
  }
  return marks;
}

export interface DiffDoc { text: string; lines: { kind: 'ctx' | 'add' | 'del'; newNo: number | null; oldNo: number | null }[] }

export function unifiedDoc(original: string, current: string): DiffDoc | null {
  const parts = diff(original, current);
  if (!parts) return null;
  const out: string[] = [];
  const lines: DiffDoc['lines'] = [];
  let o = 1; let c = 1;
  for (const p of parts) {
    for (const l of split(p.value)) {
      out.push(l);
      if (p.added) lines.push({ kind: 'add', oldNo: null, newNo: c++ });
      else if (p.removed) lines.push({ kind: 'del', oldNo: o++, newNo: null });
      else lines.push({ kind: 'ctx', oldNo: o++, newNo: c++ });
    }
  }
  return { text: out.join('\n'), lines };
}

/** A changed word (or run of words) on a Diff view row: `line` indexes `DiffDoc.lines`, `from`/`to` are offsets in it. */
export interface WordMark { line: number; from: number; to: number; kind: 'add' | 'del' }

/** Rows longer than this are left whole; past this many pairs, or this many ms, a file gets no more word marks. */
const WORD_LINE_MAX = 1000;
const WORD_PAIRS_MAX = 2000;
const WORD_BUDGET_MS = 150;
/** Rows sharing less than this part of the longer one's non-blank characters changed whole. */
const WORD_ALIKE = 0.3;

const nonBlank = (s: string) => s.replace(/\s/g, '').length;
type Span = [number, number];

/** Spans without their edge spaces; neighbours closer than two characters of punctuation or space merge. */
function tidy(spans: Span[], text: string): Span[] {
  const out: Span[] = [];
  for (let [from, to] of spans) {
    while (from < to && /\s/.test(text[from]!)) from++;
    while (to > from && /\s/.test(text[to - 1]!)) to--;
    if (from === to) continue;
    const last = out.at(-1);
    if (last && /^[\s\p{P}\p{S}]{0,2}$/u.test(text.slice(last[1], from))) last[1] = to;
    else out.push([from, to]);
  }
  return out;
}

function pairMarks(a: string, b: string, la: number, lb: number): WordMark[] {
  if (a === b || a.length > WORD_LINE_MAX || b.length > WORD_LINE_MAX) return [];
  const parts = diffWordsWithSpace(a, b, { timeout: 20 }) as ReturnType<typeof diffWordsWithSpace> | undefined;
  if (!parts) return [];
  const del: Span[] = [];
  const add: Span[] = [];
  let oa = 0; let ob = 0; let common = 0;
  for (const p of parts) {
    const n = p.value.length;
    if (p.added) { add.push([ob, ob + n]); ob += n; } else if (p.removed) { del.push([oa, oa + n]); oa += n; } else { common += nonBlank(p.value); oa += n; ob += n; }
  }
  const longer = Math.max(nonBlank(a), nonBlank(b));
  if (!longer || common / longer < WORD_ALIKE) return [];
  return [
    ...tidy(del, a).map(([from, to]): WordMark => ({ line: la, from, to, kind: 'del' })),
    ...tidy(add, b).map(([from, to]): WordMark => ({ line: lb, from, to, kind: 'add' }))
  ];
}

/**
 * The Diff view's changed words: in each block of removed rows followed by added rows, the
 * rows are paired in order; a pair alike enough gets its removed words marked on the old row and its added words on
 * the new one.
 */
export function wordMarks(d: DiffDoc): WordMark[] {
  const rows = d.text.split('\n');
  const out: WordMark[] = [];
  const t0 = performance.now();
  let pairs = 0;
  for (let i = 0; i < d.lines.length;) {
    if (d.lines[i]!.kind !== 'del') { i++; continue; }
    let j = i;
    while (j < d.lines.length && d.lines[j]!.kind === 'del') j++;
    let k = j;
    while (k < d.lines.length && d.lines[k]!.kind === 'add') k++;
    for (let p = 0; p < Math.min(j - i, k - j); p++) {
      if (++pairs > WORD_PAIRS_MAX || performance.now() - t0 > WORD_BUDGET_MS) return out;
      out.push(...pairMarks(rows[i + p] ?? '', rows[j + p] ?? '', i + p, j + p));
    }
    i = Math.max(k, i + 1);
  }
  return out;
}

/** The minimal change that turns `a` into `b` (common prefix and suffix left intact), or null if they are equal. */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) { endA--; endB--; }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}
