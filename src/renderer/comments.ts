// Line comments to a session: drafts anchored to a file's lines, typed into the session's prompt as
// one bracketed paste. Pure functions and per-project storage.
import type { TerminalInfo } from '@shared/protocol';
import type { Attribution } from '@shared/attribution';
import { mentionPath, mentionTarget } from './mention';
import { remoteAvailability, type RemoteAvailability } from './remote';
import { isAbsPath } from '@shared/paths';

export interface LineComment {
  id: string;
  /** Absolute path of the file (the form of tree and git paths). */
  path: string;
  /** New-file lines, 1-based, inclusive. */
  start: number;
  end: number;
  text: string;
  /** The commented lines when the comment was written (their first MAX_SNIPPET characters): a different text there marks it outdated. */
  snippet: string;
  /** Present when the lines were longer than MAX_SNIPPET: length and hash of all of them. */
  hash?: string;
  /** The file went to the Trash: set aside (not pending, not sent) until kept. */
  gone?: boolean;
  /** The terminal id it goes to (null: no Claude session to send it to yet). */
  target: string | null;
  createdAt: number;
}

export const MAX_COMMENT = 4000;
const MAX_COMMENTS = 500;
/** Characters of the commented lines kept with a comment; past it, a hash of all of them tells a change. */
export const MAX_SNIPPET = 4096;

type Row = { newNo: number | null };

/** The new-file lines a selection of document lines start..end covers (rows: a diff's lines; null: the file itself). */
export function newLineRange(rows: Row[] | null, start: number, end: number): { start: number; end: number } | null {
  if (!rows) return { start, end };
  const picked = rows.slice(start - 1, end).map((r) => r.newNo).filter((n): n is number => n !== null);
  if (picked.length) return { start: Math.min(...picked), end: Math.max(...picked) };
  // Only removed rows: the new line right after them, else the one before.
  const after = rows.slice(end).find((r) => r.newNo !== null)?.newNo;
  const before = [...rows.slice(0, start - 1)].reverse().find((r) => r.newNo !== null)?.newNo;
  const n = after ?? before;
  return n === undefined || n === null ? null : { start: n, end: n };
}

/** The document line showing new-file line n (null: not in this view). */
export function docLineOf(rows: Row[] | null, n: number, docLines: number): number | null {
  if (!rows) return n >= 1 && n <= docLines ? n : null;
  const i = rows.findIndex((r) => r.newNo === n);
  return i < 0 ? null : i + 1;
}

const linesOf = (text: string) => { const l = text.split('\n'); if (l.at(-1) === '') l.pop(); return l; };

/** Lines start..end of a text (null when they are not all there). */
export function snippetOf(text: string, start: number, end: number): string | null {
  const l = linesOf(text);
  if (start < 1 || end > l.length || start > end) return null;
  return l.slice(start - 1, end).join('\n');
}

/** cyrb53: a fast 53-bit string hash (not cryptographic; it only tells whether commented lines changed). */
function hash53(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const fingerprint = (s: string) => `${s.length}:${hash53(s)}`;

/** What a comment stores of its lines: all of them up to MAX_SNIPPET, else the start plus a fingerprint of the whole. */
export function snippetFields(full: string): { snippet: string; hash?: string } {
  return full.length <= MAX_SNIPPET ? { snippet: full } : { snippet: full.slice(0, MAX_SNIPPET), hash: fingerprint(full) };
}

/** The file changed under the comment (its lines differ or are gone). Unknown text: not outdated. */
export function isOutdated(c: Pick<LineComment, 'start' | 'end' | 'snippet' | 'hash'>, text: string | null): boolean {
  if (text === null) return false;
  const now = snippetOf(text, c.start, c.end);
  if (now === null) return true;
  return c.hash ? fingerprint(now) !== c.hash : now !== c.snippet;
}

/** The comment counts for that session's review: aimed at it and not set aside (file in the Trash). */
export function isPending(c: Pick<LineComment, 'target' | 'gone'>, id: string): boolean {
  return c.target === id && !c.gone;
}

const isClaude = (x: TerminalInfo | undefined): x is TerminalInfo => !!x?.session;

/**
 * Where a new comment goes: the one live Claude session the file is attributed to (not when unclear or maybe); with
 * none or several, the session last selected (else the first Claude session) and the comment asks with a picker.
 */
export function defaultTarget(path: string, attributions: Attribution[], terminals: TerminalInfo[], lastSession: string | null): { target: string | null; ambiguous: boolean } {
  const live = new Set(terminals.filter(isClaude).map((x) => x.id));
  const mine = attributions.filter((a) => a.path === path);
  const by = [...new Set(mine.filter((a) => live.has(a.terminalId)).map((a) => a.terminalId))];
  // An unclear file may be any candidate's, a maybe one may be nobody's: always ask.
  if (by.length === 1) return { target: by[0]!, ambiguous: mine.some((a) => a.unclear || a.maybe) };
  const last = isClaude(terminals.find((x) => x.id === lastSession)) ? lastSession : null;
  return { target: last ?? terminals.find(isClaude)?.id ?? null, ambiguous: true };
}

/** CRLF, CR and the Unicode line and paragraph separators (U+2028, U+2029): one newline each. */
const LINE_BREAKS = new RegExp(`\\r\\n?|[${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

/** A comment's text as it may reach a prompt: no control characters (C0 but newlines, DEL, C1), tabs as two spaces. */
export function sanitizeComment(text: string): string {
  return text.replace(LINE_BREAKS, '\n').replace(/\t/g, '  ').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '').trim();
}

/**
 * "Review comments:" and one line per comment, `@path#L10-24 text` (the mention format, relative to the session's
 * folder), in file and line order; a comment's further lines are indented under it.
 */
export function composeReview(comments: LineComment[], where: { cwd: string | null; root: string; realRoot: string }): string {
  const sorted = [...comments].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start || a.end - b.end));
  const lines = sorted.map((c) => {
    const file = mentionTarget(c.path, where.root, where.realRoot);
    const [first, ...rest] = sanitizeComment(c.text).split('\n');
    return [mentionPath(file, where.cwd, where.root, { start: c.start, end: c.end }) + (first ?? ''), ...rest.map((l) => `  ${l}`)].join('\n');
  });
  return ['Review comments:', ...lines].join('\n');
}

/**
 * The block as ONE bracketed paste: newlines inside it are not a submit, and nothing in it can close the paste early
 * (no escape character survives). Newlines go as CR, like a terminal's own paste. No Enter after it.
 */
export function reviewPaste(text: string): string {
  const body = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '').trimEnd().replace(/\n/g, '\r');
  return `\x1b[200~${body}\x1b[201~`;
}

/** Same rule as Continue on Phone (Claude's prompt free, Claude in front), plus bracketed paste on in that terminal. */
export function sendAvailability(term: TerminalInfo | undefined, bracketed: boolean): RemoteAvailability {
  const a = remoteAvailability(term);
  return a === 'ok' && !bracketed ? 'busy' : a;
}

const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** Stored drafts, checked one by one (broken ones dropped), text bounded. */
export function parseComments(raw: unknown): LineComment[] {
  if (!Array.isArray(raw)) return [];
  const out: LineComment[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    if (!str(o.id, 64) || !o.id || !str(o.path, 4096) || !isAbsPath(o.path) || !posInt(o.start) || !posInt(o.end) || o.end < o.start) continue;
    if (typeof o.text !== 'string' || typeof o.snippet !== 'string' || (o.target !== null && !str(o.target, 64)) || typeof o.createdAt !== 'number') continue;
    if (o.hash !== undefined && !str(o.hash, 64)) continue;
    // Entries written before the cap: the whole snippet becomes its fingerprint.
    const kept = typeof o.hash === 'string' ? { snippet: o.snippet.slice(0, MAX_SNIPPET), hash: o.hash } : snippetFields(o.snippet);
    out.push({
      id: o.id, path: o.path, start: o.start, end: o.end, text: o.text.slice(0, MAX_COMMENT), ...kept,
      target: o.target as string | null, createdAt: o.createdAt, ...(o.gone === true ? { gone: true } : {})
    });
    if (out.length >= MAX_COMMENTS) break;
  }
  return out;
}

export const KEY = 'atelier.comments';
const MAX_PROJECTS = 50;

function readAll(): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}

export function loadComments(root: string): LineComment[] {
  return parseComments(readAll()[root]);
}

/** false: not saved (storage full or unavailable); the drafts stay for this session and the caller says so. */
export function saveComments(root: string, list: LineComment[]): boolean {
  try {
    const rest = Object.entries(readAll()).filter(([r]) => r !== root);
    if (list.length) rest.push([root, list]);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(rest.slice(-MAX_PROJECTS))));
    return true;
  } catch { return false; }
}
