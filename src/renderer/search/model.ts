// Find in Files, the pure part: the rows the list shows, stepping through them, a line's preview, the text sent to a
// session, the nearest match after a file changed, and the merge of unsaved buffers into the disk results.
import { SEARCH_LIMITS, type SearchFile, type SearchLine, type SearchSpec } from '@shared/search';

export type Row =
  | { kind: 'file'; key: string; file: SearchFile; count: number; collapsed: boolean }
  | { kind: 'match'; key: string; file: SearchFile; line: SearchLine; index: number };

export const fileKey = (path: string): string => `f:${path}`;
export const matchKey = (path: string, line: number, index: number): string => `m:${path}:${line}:${index}`;

/** The rows to show: a row per file, then a row per match range unless the file is collapsed; dismissed ones are absent. */
export function buildRows(files: SearchFile[], collapsed: ReadonlySet<string>, dismissed: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  for (const file of files) {
    const fk = fileKey(file.path);
    if (dismissed.has(fk)) continue;
    const matches: Row[] = [];
    for (const line of file.lines) {
      for (let index = 0; index < line.ranges.length; index++) {
        const key = matchKey(file.path, line.line, index);
        if (!dismissed.has(key)) matches.push({ kind: 'match', key, file, line, index });
      }
    }
    if (matches.length === 0) continue;
    const isCollapsed = collapsed.has(fk);
    rows.push({ kind: 'file', key: fk, file, count: matches.length, collapsed: isCollapsed });
    if (!isCollapsed) rows.push(...matches);
  }
  return rows;
}

/** Whether a match is left to walk to (F4): any not dismissed, a collapsed file's included. */
export function anyResult(files: SearchFile[], dismissed: ReadonlySet<string>): boolean {
  for (const file of files) {
    if (dismissed.has(fileKey(file.path))) continue;
    for (const line of file.lines) {
      for (let i = 0; i < line.ranges.length; i++) if (!dismissed.has(matchKey(file.path, line.line, i))) return true;
    }
  }
  return false;
}

/**
 * The match row after (or before) the selected row, in list order and wrapping at the ends. Nothing selected, or a
 * selection no longer in the rows, starts at the first (or last) match; a selected file row steps from its place.
 */
export function stepResult(rows: Row[], selected: string | null, dir: 1 | -1): string | null {
  const matchIdx: number[] = [];
  rows.forEach((r, i) => { if (r.kind === 'match') matchIdx.push(i); });
  if (matchIdx.length === 0) return null;
  const at = selected === null ? -1 : rows.findIndex((r) => r.key === selected);
  if (at < 0) return rows[matchIdx[dir === 1 ? 0 : matchIdx.length - 1]!]!.key;
  if (dir === 1) {
    const next = matchIdx.find((i) => i > at);
    return rows[next ?? matchIdx[0]!]!.key;
  }
  let prev: number | undefined;
  for (const i of matchIdx) if (i < at) prev = i;
  return rows[prev ?? matchIdx[matchIdx.length - 1]!]!.key;
}

const LEAD_DEFAULT = 20;
/** Characters a row shows at most: a row is a glance at its match, not the line (Copy Line gives the line). */
export const PREVIEW_CHARS = 250;

/**
 * What a match row shows: the kept text from its first non-blank character, or from `lead` characters before the row's
 * own match when that is further along (`cut`), at most PREVIEW_CHARS of it (`cutEnd` when the line goes on). Ranges
 * are line columns, so they move by the kept text's start and are clamped to what is shown; a row whose own range lies
 * outside the kept text has nothing to mark and shows "…".
 */
export function previewWindow(line: SearchLine, index: number, lead: number = LEAD_DEFAULT): { text: string; marks: [number, number][]; strong: number; cut: boolean; cutEnd: boolean } {
  const text = line.text;
  const local = line.ranges.map(([a, b]): [number, number] => [a - line.start, b - line.start]);
  const own = local[index];
  if (!own || own[1] <= 0 || own[0] >= text.length || own[1] <= own[0]) return { text: '…', marks: [], strong: -1, cut: false, cutEnd: false };
  let begin = text.length - text.trimStart().length;
  let cut = line.cutStart;
  const ownFrom = Math.max(0, own[0]);
  if (ownFrom - begin > lead) {
    begin = ownFrom - lead;
    // Never start inside a surrogate pair.
    const c = text.charCodeAt(begin);
    if (c >= 0xdc00 && c <= 0xdfff) begin++;
    cut = true;
  }
  let end = Math.min(text.length, begin + PREVIEW_CHARS);
  // Never end inside a surrogate pair either.
  if (end < text.length && end > begin) {
    const c = text.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end--;
  }
  const marks: [number, number][] = [];
  let strong = -1;
  local.forEach(([a, b], i) => {
    const from = Math.max(a, begin);
    const to = Math.min(b, end);
    if (to <= from) return;
    if (i === index) strong = marks.length;
    marks.push([from - begin, to - begin]);
  });
  return { text: text.slice(begin, end), marks, strong, cut, cutEnd: line.cutEnd || end < text.length };
}

/**
 * Whether the field takes the keyboard when the view mounts: an open on purpose (the activity item holds the keyboard,
 * as a click or Enter gives it in most browsers), nothing holding it (where a click gives buttons no focus), or a focus
 * request since the last one answered; never from a terminal or an editor that has it.
 */
export function takesFocusOnMount(active: 'activity' | 'none' | 'other', requested: boolean): boolean {
  return requested || active !== 'other';
}

/** A line as Copy Line gives it: the whole line, or its kept text with "…" where the line goes on. */
export function lineCopy(line: SearchLine): string {
  return `${line.cutStart ? '…' : ''}${line.text}${line.cutEnd ? '…' : ''}`;
}

/** A file's size as the files-not-searched list shows it: "24 B", "1.5 KB", "50 MB" (a round figure without ".0"). */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const [n, unit] = bytes < 1024 * 1024 ? [bytes / 1024, 'KB'] : [bytes / (1024 * 1024), 'MB'];
  return `${n.toFixed(1).replace(/\.0$/, '')} ${unit}`;
}

/** A file's match count in its pill: past 999, "999+" (the exact number is in the pill's tip). */
export const pillCount = (n: number): string => (n > 999 ? '999+' : n.toLocaleString('en-US'));

/** Results and files of rows already built (a collapsed file's row carries its count): `totals` without a second pass. */
export function rowTotals(rows: Row[]): { results: number; files: number } {
  let results = 0;
  let files = 0;
  for (const r of rows) {
    if (r.kind !== 'file') continue;
    files++;
    results += r.count;
  }
  return { results, files };
}

/** Whether a file shown is open: Collapse All then, else Expand All (the head and the list's menu agree). */
export const anyExpanded = (rows: Row[]): boolean => rows.some((r) => r.kind === 'file' && !r.collapsed);

/** Each row's place in the tree: a file among the files, a match among its file's matches (aria-posinset / setsize). */
export function treePositions(rows: Row[]): { pos: number; size: number }[] {
  const out: { pos: number; size: number }[] = [];
  let files = 0;
  for (const r of rows) if (r.kind === 'file') files++;
  let file = 0;
  let inFile = 0;
  let size = 0;
  for (const r of rows) {
    if (r.kind === 'file') {
      out.push({ pos: ++file, size: files });
      inFile = 0;
      size = r.count;
    } else out.push({ pos: ++inFile, size });
  }
  return out;
}

/** Results and files that remain once dismissed rows are left out. */
export function totals(files: SearchFile[], dismissed: ReadonlySet<string>): { results: number; files: number } {
  let results = 0;
  let count = 0;
  for (const row of buildRows(files, new Set(), dismissed)) {
    if (row.kind === 'match') results++;
    else count++;
  }
  return { results, files: count };
}

const onOff = (v: boolean): string => (v ? 'on' : 'off');
const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * The block sent to a session or copied: a header, then `path:line  text` per matching line, at most `cap` lines
 * (the rest counted), dismissed rows left out.
 */
export function resultsText(spec: SearchSpec, files: SearchFile[], dismissed: ReadonlySet<string>, cap: number = SEARCH_LIMITS.sendLines): string {
  const t = totals(files, dismissed);
  const out = [`Search "${spec.query}" (match case ${onOff(spec.matchCase)}, whole word ${onOff(spec.wholeWord)}, regex ${onOff(spec.regex)}) — ${plural(t.results, 'result', 'results')} in ${plural(t.files, 'file', 'files')}`];
  // A line with several matches is one line of text but several results.
  const perLine = new Map<SearchLine, { file: SearchFile; results: number }>();
  for (const row of buildRows(files, new Set(), dismissed)) {
    if (row.kind !== 'match') continue;
    const entry = perLine.get(row.line);
    if (entry) entry.results++;
    else perLine.set(row.line, { file: row.file, results: 1 });
  }
  let shown = 0;
  let listed = 0;
  for (const [line, { file, results }] of perLine) {
    if (listed >= cap) break;
    out.push(`${file.rel}:${line.line}  ${line.cutStart ? '…' : ''}${line.text.trimStart()}${line.cutEnd ? '…' : ''}`);
    listed++;
    shown += results;
  }
  if (t.results > shown) out.push(`…and ${plural(t.results - shown, 'more result', 'more results')}`);
  return out.join('\n');
}

/**
 * The match nearest to where a result was recorded after the file changed, within `maxDistance` lines: the recorded
 * line first, then one line away either side, and so on. `line` and the result are 1-based; on a line the range
 * starting nearest `from` wins.
 */
export function nearestMatch(lines: string[], ranges: (l: string) => [number, number][], line: number, from: number, maxDistance = 5): { line: number; from: number; to: number } | null {
  const at = (n: number): { line: number; from: number; to: number } | null => {
    const text = lines[n - 1];
    if (text === undefined) return null;
    let best: [number, number] | null = null;
    for (const r of ranges(text)) if (!best || Math.abs(r[0] - from) < Math.abs(best[0] - from)) best = r;
    return best ? { line: n, from: best[0], to: best[1] } : null;
  };
  for (let d = 0; d <= maxDistance; d++) {
    const up = at(line - d);
    if (up) return up;
    if (d > 0) {
      const down = at(line + d);
      if (down) return down;
    }
  }
  return null;
}
