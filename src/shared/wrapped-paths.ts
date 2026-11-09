import { findFileLinks } from './links';
import { pathStyle } from './platform';

/**
 * A terminal row: its text (trailing spaces trimmed), whether xterm soft-wrapped the row above into it, and how many
 * cells the text takes (wide characters take two; the text's length when absent).
 */
export interface Row { text: string; wrapped: boolean; width?: number }

/** A row read from xterm's cells, with the cell where each code unit of its text starts and ends (end exclusive). */
export interface CellRow extends Row { width: number; startCell: number[]; endCell: number[] }

/**
 * Builds a row from its cells (xterm's getChars/getWidth): a wide character's empty second half (width 0) is skipped,
 * an empty cell is a space; trailing spaces are trimmed.
 */
export function rowFromCells(cells: readonly { chars: string; width: number }[], wrapped: boolean): CellRow {
  let text = '';
  const startCell: number[] = [];
  const endCell: number[] = [];
  let x = 0;
  for (const c of cells) {
    if (c.width === 0) continue;
    const chars = c.chars || ' ';
    for (let i = 0; i < chars.length; i++) { startCell.push(x); endCell.push(x + c.width); }
    text += chars;
    x += c.width;
  }
  const trimmed = text.trimEnd();
  startCell.length = trimmed.length;
  endCell.length = trimmed.length;
  return { text: trimmed, wrapped, width: endCell.at(-1) ?? 0, startCell, endCell };
}
/** Where a link lies on one row: string columns, end exclusive. */
export interface Piece { y: number; start: number; end: number }
export interface WrappedLink {
  /** A file path (or a file:// URL to one), or an absolute folder (ending in /, or a file:// URL to one). */
  kind: 'file' | 'folder';
  path: string;
  line: number | null;
  col: number | null;
  pieces: Piece[];
  /** The link spans several rows. */
  joined: boolean;
  /** For a joined link: the hovered row's own candidates under it, tried when the joined path resolves to nothing. */
  alone?: WrappedLink[];
}

/** Rows in one logical line at most: a path is never that long, and the walk stays cheap on every hover. */
export const MAX_ROWS = 8;

/**
 * Whether row `b` goes on from row `a`: xterm wrapped it, or Claude Code (Ink) hard-wrapped a full row (the cut
 * falls where the row is full: its last column or the one before) and went on after an indent.
 */
function continues(a: Row | undefined, b: Row | undefined, cols: number): boolean {
  if (!a || !b) return false;
  if (b.wrapped) return true;
  if (!/^ +\S/.test(b.text)) return false;
  return (a.width ?? a.text.length) >= cols - 1 || underImagePath(a, b);
}

/**
 * An `[image]` row isn't full: Claude keeps its right for the size and goes on exactly under the path's first
 * character.
 */
function underImagePath(a: Row, b: Row): boolean {
  const m = /\[image\](?=\S)/.exec(a.text);
  if (!m) return false;
  const at = m.index + m[0].length;
  const cell = (r: Row, i: number) => (r as Partial<CellRow>).startCell?.[i] ?? i;
  const indent = b.text.length - b.text.trimStart().length;
  return cell(b, indent) === cell(a, at);
}

const FILE_URL_RE = /\bfile:\/\/(\/[^\s()<>"'`]*)/g;
// Never a folder cut out of a longer name (…/claude-501/ in …/claude-501/-Users…, /a/b/ in /a/b/%20x or /a/b/'x):
// only the end, a space, or punctuation that itself ends there (a closing quote or parenthesis, a sentence's period).
const FOLDER_RE = /(?<![\w/.:~-])(\/(?:[\w@.+-]+\/)+)(?=$|\s|[)\]}>"'`,;:.](?:$|[\s)\]}>"'`,;:.]))/g;
// Windows: file:///C:/… names C:/…; a folder starts with a drive and either separator.
const FILE_URL_RE_WIN32 = /\bfile:\/\/\/([A-Za-z]:\/[^\s()<>"'`]*)/g;
const FOLDER_RE_WIN32 = /(?<![\w/\\.:~-])([A-Za-z]:[\\/](?:[\w@.+-]+[\\/])+)(?=$|\s|[)\]}>"'`,;:.](?:$|[\s)\]}>"'`,;:.]))/g;
const ANY_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

interface Candidate { kind: 'file' | 'folder'; path: string; line: number | null; col: number | null; start: number; end: number }

/** File links (findFileLinks), file:// URLs read as the path they name, and absolute folders. */
function candidatesIn(text: string): Candidate[] {
  const win = pathStyle() === 'win32';
  const out: Candidate[] = findFileLinks(text).map((f) => ({ kind: 'file' as const, path: f.path, line: f.line, col: f.col, start: f.start, end: f.end }));
  const urls: [number, number][] = [];
  for (const m of text.matchAll(ANY_URL_RE)) urls.push([m.index!, m.index! + m[0].length]);
  for (const m of text.matchAll(win ? FILE_URL_RE_WIN32 : FILE_URL_RE)) {
    // A sentence's punctuation after the URL isn't part of it.
    const raw = m[1]!.replace(/[.,;:]+$/, '');
    let path: string;
    try { path = decodeURIComponent(raw); } catch { continue; }
    const end = m.index! + m[0].length - (m[1]!.length - raw.length);
    out.push({ kind: path.endsWith('/') || (win && path.endsWith('\\')) ? 'folder' : 'file', path, line: null, col: null, start: m.index!, end });
  }
  for (const m of text.matchAll(win ? FOLDER_RE_WIN32 : FOLDER_RE)) {
    if (urls.some(([a, b]) => m.index! >= a && m.index! < b)) continue;
    out.push({ kind: 'folder', path: m[1]!, line: null, col: null, start: m.index!, end: m.index! + m[0].length });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Absolute folders written in the rows above `y` (their logical lines), nearest first: where a bare name may live. */
export function foldersAbove(row: (y: number) => Row | undefined, y: number, cols: number, rows = 30, max = 3): string[] {
  const out: string[] = [];
  for (let r = y - 1; r >= Math.max(0, y - rows) && out.length < max; r--) {
    for (const l of linksAt(row, r, cols).reverse()) {
      if (l.kind === 'folder' && !out.includes(l.path) && out.length < max) out.push(l.path);
    }
  }
  return out;
}

/**
 * The file links touching row `y`, found in its logical line: the rows Claude or xterm wrapped around it, joined
 * (Claude's indent dropped, xterm's cut kept as is). Each link maps back to one piece per row it covers.
 */
export function linksAt(row: (y: number) => Row | undefined, y: number, cols: number): WrappedLink[] {
  const here = row(y);
  if (!here) return [];
  let s = y;
  while (y - s < MAX_ROWS - 1 && continues(row(s - 1), row(s), cols)) s--;
  let e = s;
  // The walk up proved rows s…y continue each other, so this one passes y.
  while (e - s < MAX_ROWS - 1 && continues(row(e), row(e + 1), cols)) e++;

  // The logical text, and where each row's part starts in it (and in the row).
  const segs: { y: number; at: number; from: number; len: number }[] = [];
  let text = '';
  for (let r = s; r <= e; r++) {
    const cur = row(r)!;
    const next = row(r + 1);
    const from = r === s || cur.wrapped ? 0 : cur.text.length - cur.text.trimStart().length;
    // Before an xterm soft wrap the row is full: spaces trimmed at its end were real cells.
    const body = r < e && next?.wrapped ? cur.text + ' '.repeat(Math.max(0, cols - (cur.width ?? cur.text.length))) : cur.text;
    segs.push({ y: r, at: text.length, from, len: body.length - from });
    text += body.slice(from);
  }

  const piecesOf = (start: number, end: number): Piece[] => {
    const out: Piece[] = [];
    for (const g of segs) {
      const a = Math.max(start, g.at);
      const b = Math.min(end, g.at + g.len);
      if (a < b) out.push({ y: g.y, start: g.from + a - g.at, end: g.from + b - g.at });
    }
    return out;
  };

  const own = (): WrappedLink[] => candidatesIn(here.text).map((f) => (
    { kind: f.kind, path: f.path, line: f.line, col: f.col, joined: false, pieces: [{ y, start: f.start, end: f.end }] }
  ));
  const out: WrappedLink[] = [];
  for (const f of candidatesIn(text)) {
    const pieces = piecesOf(f.start, f.end);
    const mine = pieces.find((p) => p.y === y);
    if (!mine) continue;
    const link: WrappedLink = { kind: f.kind, path: f.path, line: f.line, col: f.col, joined: pieces.length > 1, pieces };
    // Files only: a path cut right after a slash would otherwise leave its parent folder as a link.
    if (link.joined) link.alone = own().filter((a) => a.kind === 'file' && a.pieces[0]!.start < mine.end && a.pieces[0]!.end > mine.start);
    out.push(link);
  }
  return out;
}
