// Ask companion: the answer Markdown the model writes (see rules.ts) as blocks the renderer draws.
// Deliberately tiny: verdict line, `:::detail` folds, paragraphs, lists, bold/italic/code, file references and
// http(s) links. HTML, images and any other link stay literal text. Never throws; input is capped so a runaway answer
// can't hang the renderer.
import { isSafeUrl } from '../links';

/** A run of text with at most one formatting: also what a link's label is made of. */
export type Span = { t: 'text' | 'bold' | 'italic' | 'code'; s: string };

export type Inline =
  | Span
  | { t: 'file'; path: string; from: number | null; to: number | null; raw: string }
  /** An http(s) link: `url` as the browser reads it (what opens, and what the tooltip shows), never the raw spelling. */
  | { t: 'link'; url: string; label: Span[] };

export type AnswerBlock =
  | { k: 'verdict'; state: 'done' | 'in-progress' | 'not-started' | 'unclear'; label: string; progress: { n: number; m: number } | null }
  | { k: 'para'; inline: Inline[] }
  | { k: 'list'; ordered: boolean; items: Inline[][] }
  | { k: 'detail'; title: string; body: AnswerBlock[] };

const MAX_INPUT = 64 * 1024;
const STATES = new Set(['done', 'in-progress', 'not-started', 'unclear']);

/**
 * A candidate project-relative reference from `path`, `path:58` or `path:41–77`; null when it is plain code. One written
 * with backslashes (the model does on Windows) is the same path with forward slashes, so a UNC or rooted one (`\\…`,
 * `\…`) is absolute and stays code; a drive (`C:\…`) never matches.
 */
function fileRef(code: string): Inline | null {
  const m = /^([^:\s]+)(?::(\d+)(?:[–-](\d+))?)?$/.exec(code);
  if (!m) return null;
  const path = m[1]!.replace(/\\/g, '/');
  if (path.length > 300 || path.startsWith('/') || path.startsWith('~') || path.endsWith('/')) return null;
  const segs = path.split('/');
  if (segs.includes('..') || segs.includes('')) return null;
  if (!path.includes('/') && !/\.[A-Za-z0-9]+$/.test(path)) return null;
  const from = m[2] !== undefined ? Number(m[2]) : null;
  const to = m[3] !== undefined ? Number(m[3]) : null;
  if (from !== null && (!Number.isSafeInteger(from) || from < 1)) return null;
  if (to !== null && (!Number.isSafeInteger(to) || to < from!)) return null;
  return { t: 'file', path, from, to, raw: code };
}

const isWord = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9]/.test(c);

// --- links -----------------------------------------------------------------------------------------------------------

/** The longest URL read as a link: a longer one stays text rather than link to a part of it. */
const URL_MAX = 2048;
/** The longest URL the app opens, as the browser spells it (non-ASCII grows ninefold once encoded). */
const HREF_MAX = 4096;
/** Invisible and direction marks: never in a URL, where they would hide or reorder what the text shows. */
const INVISIBLE = '\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2069\\uFEFF';
/** A delimited URL's characters (`<…>`, `(…)`): no blank, quote, backtick, angle or square bracket, invisible mark. */
const URL_CHAR = `[^\\s<>"\`[\\]${INVISIBLE}]`;
/**
 * A bare URL's: printable ASCII without those, so the text written right after one (Japanese, full-width punctuation,
 * no blank between) is never part of it.
 */
const BARE_CHAR = new RegExp('[\\x21\\x23-\\x3B\\x3D\\x3F-\\x5A\\x5C\\x5E\\x5F\\x61-\\x7E]');
const BARE = new RegExp(`https?://${BARE_CHAR.source}{1,${URL_MAX}}`, 'iy');
const AUTO = new RegExp(`<(https?://${URL_CHAR}{1,${URL_MAX}})>`, 'iy');
// `[label](url)`: one level of balanced parentheses in the URL (a wiki page's `Token_(auth)`), as GitHub reads it.
const P = `[^\\s<>"\`[\\]()${INVISIBLE}]`;
const MD_LINK = new RegExp(`\\[([^[\\]\\n]{0,300})\\]\\((https?://${P}{1,${URL_MAX}}(?:\\(${P}{0,${URL_MAX}}\\)${P}{0,${URL_MAX}})?)\\)`, 'iy');
/** What ends a sentence rather than a bare URL. */
const TRAILING = /[.,;:!?'*_~]/;
const VISIBLE = new RegExp(`[^\\s${INVISIBLE}]`);

/** A bare URL without the punctuation after it: a closing parenthesis only when the URL opened none for it. */
function trimBare(url: string): string {
  let opens = 0;
  let closes = 0;
  for (const ch of url) { if (ch === '(') opens++; else if (ch === ')') closes++; }
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (last !== undefined && TRAILING.test(last)) { end--; continue; }
    if (last === ')' && closes > opens) { end--; closes--; continue; }
    return url.slice(0, end);
  }
}

/**
 * The URL as the browser reads it; null when it isn't an http(s) one, is too long to be read whole, or opens another
 * host than the one written: credentials before it (`github.com@evil.test`), anything encoded in it.
 */
function target(raw: string): string | null {
  if (raw.length > `https://`.length + URL_MAX || !isSafeUrl(raw)) return null;
  const u = new URL(raw);
  const written = /^https?:\/\/([^/?#\\]*)/i.exec(raw)?.[1] ?? '';
  if (u.username || u.password || /[@%]/.test(written)) return null;
  return u.href.length > HREF_MAX ? null : u.href;
}

/** The hosts a label's words name (`github.com/acme`, `https://…`, `README.md`), as a URL spells them. */
function namedHosts(label: string): string[] {
  const out: string[] = [];
  for (const word of label.split(/[\s,;()<>"'`*]+/)) {
    const host = word.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#:@\\]/)[0]!.replace(/\.+$/, '');
    if (!/^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,63}$/u.test(host)) continue;
    try { out.push(new URL(`http://${host}`).hostname); } catch { /* not a host after all */ }
  }
  return out;
}

const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/** Whether `[label](…)` holds a code span that runs past it: code binds tighter than a link (`[a \`b](…)\``). */
function codeCrosses(src: string, label: string, after: number): boolean {
  return (label.split('`').length - 1) % 2 === 1 && src.indexOf('`', after) !== -1;
}

/**
 * A link at `i`: `[label](https://…)`, `<https://…>` or a bare http(s) URL at a word's start. `url` is null when it reads
 * as one but can't be opened: its whole run then stays text, and the scan goes on after it (each character is read by
 * one bounded match at most once, so the parse stays linear).
 */
function linkAt(src: string, i: number): { end: number; url: string | null; label: string | null } | null {
  const c = src[i];
  if (c === '[') {
    MD_LINK.lastIndex = i;
    const m = MD_LINK.exec(src);
    if (!m) return null;
    if (codeCrosses(src, m[1]!, i + m[1]!.length + 2)) return null;
    return { end: MD_LINK.lastIndex, url: target(m[2]!), label: m[1]! };
  }
  if (c === '<') {
    AUTO.lastIndex = i;
    const m = AUTO.exec(src);
    if (!m) return null;
    return { end: AUTO.lastIndex, url: target(m[1]!), label: null };
  }
  if ((c === 'h' || c === 'H') && !isWord(src[i - 1])) {
    BARE.lastIndex = i;
    const m = BARE.exec(src);
    if (!m) return null;
    // Cut at the cap with more URL after it: too long to be the address written; all of it stays text.
    if (BARE_CHAR.test(src[BARE.lastIndex] ?? ' ')) {
      let end = BARE.lastIndex;
      while (end < src.length && BARE_CHAR.test(src[end]!)) end++;
      return { end, url: null, label: null };
    }
    // The URL of a Markdown link not read as one (a title after it, or not closed yet while it streams): text, never a
    // live link to a part of it.
    if (src[i - 1] === '(' && src[i - 2] === ']') return { end: BARE.lastIndex, url: null, label: null };
    const raw = trimBare(m[0]);
    return { end: i + raw.length, url: target(raw), label: null };
  }
  return null;
}

/**
 * A link's spans: its label's (no link, no file chip inside one), or the URL as written; `as` formats the plain text.
 * A label with nothing to see, or naming another site than the one it opens, shows the URL instead.
 */
function linkOf(src: string, i: number, l: { end: number; url: string; label: string | null }, as: Span['t'] = 'text'): Inline {
  const auto = src[i] === '<' ? 1 : 0;
  let label: Span[] = l.label === null ? [{ t: 'text', s: src.slice(i + auto, l.end - auto) }] : parseInline(l.label, false) as Span[];
  if (l.label !== null) {
    const words = label.map((x) => x.s).join('');
    const host = new URL(l.url).hostname;
    if (!VISIBLE.test(words) || namedHosts(words).some((h) => !sameSite(h, host))) label = [{ t: 'text', s: l.url }];
  }
  return { t: 'link', url: l.url, label: label.map((x) => (x.t === 'text' ? { t: as, s: x.s } : x)) };
}

/**
 * A bold or italic run: plain, or cut around the links it holds (each a link with a label in that formatting). A code
 * span inside stays as written (emphasis holds plain text), never a link.
 */
function emphasized(as: 'bold' | 'italic', s: string, links: boolean): Inline[] {
  if (!links) return [{ t: as, s }];
  const out: Inline[] = [];
  let text = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end !== -1) { text += s.slice(i, end + 1); i = end + 1; continue; }
    }
    const l = linkAt(s, i);
    if (l) {
      if (l.url === null) text += s.slice(i, l.end);
      else { if (text) out.push({ t: as, s: text }); text = ''; out.push(linkOf(s, i, { ...l, url: l.url }, as)); }
      i = l.end;
      continue;
    }
    text += s[i];
    i++;
  }
  if (text) out.push({ t: as, s: text });
  return out;
}

/** Spans as they read, without their Markdown: a file reference as written, a link by its label. */
export function plainText(inline: readonly Inline[]): string {
  return inline.map((i) => (i.t === 'file' ? i.raw : i.t === 'link' ? plainText(i.label) : i.s)).join('');
}

// --- spans -----------------------------------------------------------------------------------------------------------

/**
 * One paragraph's spans (bold, italic, code, file references, links): also the Catch me up card's texts. `links` false
 * reads a link's label: no link inside it, and its code stays code (a file chip is a button: never inside a link).
 */
export function parseInline(src: string, links = true): Inline[] {
  const out: Inline[] = [];
  let text = '';
  // A failed closer search from `s` to the end of the line means no later opener on that line finds one either.
  const failed: Record<string, { from: number; to: number }> = {};
  const flush = (): void => { if (text) { out.push({ t: 'text', s: text }); text = ''; } };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const l = links ? linkAt(src, i) : null;
    if (l) {
      if (l.url === null) text += src.slice(i, l.end);
      else { flush(); out.push(linkOf(src, i, { ...l, url: l.url })); }
      i = l.end;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        const code = src.slice(i + 1, end);
        out.push((links ? fileRef(code) : null) ?? { t: 'code', s: code });
        i = end + 1;
        continue;
      }
    } else if (c === '*' && src[i + 1] === '*') {
      const end = src.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push(...emphasized('bold', src.slice(i + 2, end), links));
        i = end + 2;
        continue;
      }
    } else if ((c === '*' || c === '_') && src[i + 1] !== undefined && !/\s/.test(src[i + 1]!) && src[i + 1] !== c && !(c === '_' && isWord(src[i - 1]))) {
      const f = failed[c];
      if (!f || i + 2 < f.from || i + 2 > f.to) {
        const nl = src.indexOf('\n', i + 2);
        const lineEnd = nl === -1 ? src.length : nl;
        let end = src.indexOf(c, i + 2);
        while (end !== -1 && end < lineEnd && (/\s/.test(src[end - 1]!) || (c === '_' && isWord(src[end + 1])))) end = src.indexOf(c, end + 1);
        if (end !== -1 && end < lineEnd && end > i + 1) {
          flush();
          out.push(...emphasized('italic', src.slice(i + 1, end), links));
          i = end + 1;
          continue;
        }
        failed[c] = { from: i + 2, to: lineEnd };
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

const BULLET = /^\s{0,3}[-*] +(.*)$/;
const ORDERED = /^\s{0,3}\d+\. +(.*)$/;
const DETAIL = /^:::detail(?:\s+(.*))?$/;

function parseBlocks(lines: string[], allowDetail: boolean): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length > 0) blocks.push({ k: 'para', inline: parseInline(para.join('\n')) });
    para = [];
  };
  let noClose = false; // a search for `:::` that found none holds for every later opener too
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '') { flush(); i++; continue; }
    const d = allowDetail ? DETAIL.exec(trimmed) : null;
    if (d && !noClose) {
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) if (lines[j]!.trim() === ':::') { close = j; break; }
      if (close === -1) noClose = true;
      if (close !== -1) {
        flush();
        blocks.push({ k: 'detail', title: (d[1] ?? '').trim(), body: parseBlocks(lines.slice(i + 1, close), false) });
        i = close + 1;
        continue;
      }
    }
    const kind = BULLET.test(line) ? 'bullet' : ORDERED.test(line) ? 'ordered' : null;
    if (kind) {
      flush();
      const re = kind === 'bullet' ? BULLET : ORDERED;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]!);
        if (!m) break;
        items.push(parseInline(m[1]!));
        i++;
      }
      blocks.push({ k: 'list', ordered: kind === 'ordered', items });
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return blocks;
}

export function parseAnswer(md: string): AnswerBlock[] {
  try {
    const lines = md.slice(0, MAX_INPUT).replace(/\r\n?/g, '\n').split('\n');
    while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
    const blocks: AnswerBlock[] = [];
    const first = lines.length > 0 ? lines[0]!.slice(0, 500).trimEnd() : '';
    const m = /^Verdict:\s*(\S+)\s+[—–-]\s+(.+)$/.exec(first);
    if (m && STATES.has(m[1]!)) {
      const label = m[2]!;
      const p = /(\d{1,9})\s{0,3}\/\s{0,3}(\d{1,9})/.exec(label.slice(0, 200));
      const n = p ? Number(p[1]) : 0, mm = p ? Number(p[2]) : 0;
      blocks.push({ k: 'verdict', state: m[1] as 'done', label, progress: p && mm >= 1 && n <= mm ? { n, m: mm } : null });
      lines.shift();
    }
    return [...blocks, ...parseBlocks(lines, true)];
  } catch {
    return [];
  }
}
