// The editor find's matching, on one line at a time, without the editor: the same query semantics as
// `SearchQuery` as the find card builds it, so a result in the list is a match in the file.
import { CharCategory, EditorState, findClusterBreak } from '@codemirror/state';
import type { SearchLine, SearchSpec } from './search';

/**
 * A line's matches, in order, the first `max` of them at most (all when left out): a caller with a budget never has
 * the millions of matches of a minified line built only to throw them away.
 */
export type LineRanges = (line: string, max?: number) => [number, number][];

export type Compiled =
  | { kind: 'ok'; ranges: LineRanges }
  | { kind: 'empty' | 'invalid' | 'multiline' };

// The editor's regex flags: multiline and unicode, plus case-insensitive when match case is off.
const BASE_FLAGS = 'gmu';

type Categorizer = (ch: string) => CharCategory;
let categorizer: Categorizer | null = null;
/** The default word characters: letters, digits and `_` (no language adds its own across files). */
function wordCategory(): Categorizer {
  return (categorizer ??= EditorState.create({}).charCategorizer(0));
}

function isWord(cat: Categorizer, ch: string): boolean {
  return cat(ch) === CharCategory.Word;
}

function charBefore(str: string, index: number): string {
  return str.slice(findClusterBreak(str, index, false), index);
}

function charAfter(str: string, index: number): string {
  return str.slice(index, findClusterBreak(str, index));
}

/** Whether the match `[from, to)` neither starts nor ends inside a word. */
function atWordEdges(cat: Categorizer, line: string, from: number, to: number): boolean {
  return (!isWord(cat, charBefore(line, from)) || !isWord(cat, charAfter(line, from))) &&
    (!isWord(cat, charAfter(line, to)) || !isWord(cat, charBefore(line, to)));
}

/** Plain mode reads `\n`, `\r`, `\t` and `\\` as escapes. */
function unquote(text: string): string {
  return text.replace(/\\([nrt\\])/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : '\\'));
}

/** Whether a regex source can match a line break: `\n`, `\r` or a literal one outside an escaped backslash. */
function regexHasLineBreak(source: string): boolean {
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\n' || c === '\r') return true;
    if (c === '\\') {
      const next = source[i + 1];
      if (next === 'n' || next === 'r') return true;
      i++;
    }
  }
  return false;
}

function validRegExp(source: string): boolean {
  try {
    new RegExp(source, BASE_FLAGS);
    return true;
  } catch {
    return false;
  }
}

function regexRanges(re: RegExp, wholeWord: boolean): LineRanges {
  const cat = wordCategory();
  return (line, max = Infinity) => {
    const out: [number, number][] = [];
    re.lastIndex = 0;
    while (out.length < max) {
      const m = re.exec(line);
      if (!m) break;
      const from = m.index;
      const to = from + m[0].length;
      if (to === from) {
        // Never stuck on an empty match, and never inside a surrogate pair.
        re.lastIndex = findClusterBreak(line, to);
        if (re.lastIndex <= to) break;
        continue;
      }
      if (!wholeWord || atWordEdges(cat, line, from, to)) out.push([from, to]);
    }
    return out;
  };
}

const ASCII_ONLY = /^[\x00-\x7F]*$/;

function norm(caseOff: boolean, text: string): string {
  const n = text.normalize('NFKD');
  return caseOff ? n.toLowerCase() : n;
}

/**
 * A string search over one line, the way the editor's string cursor does it: both sides are normalised (NFKD, and
 * lower-cased when match case is off) one code point at a time, so a character that expands to several still maps
 * back to its own place in the line; matches don't overlap.
 */
function stringRanges(unquoted: string, matchCase: boolean, wholeWord: boolean): LineRanges {
  const query = norm(!matchCase, unquoted);
  const cat = wordCategory();
  // NFKD and lower-casing leave ASCII alone, one unit for one unit: when the query and the line are both ASCII the
  // normalisation changes nothing and a plain `indexOf` finds exactly the same matches.
  const asciiQuery = ASCII_ONLY.test(query);
  const needle = matchCase ? query : query.toLowerCase();
  return (line, max = Infinity) => {
    const out: [number, number][] = [];
    if (max <= 0) return out;
    if (asciiQuery && ASCII_ONLY.test(line)) {
      const hay = matchCase ? line : line.toLowerCase();
      for (let at = hay.indexOf(needle); at >= 0 && out.length < max;) {
        const to = at + needle.length;
        if (!wholeWord || atWordEdges(cat, line, at, to)) {
          out.push([at, to]);
          at = hay.indexOf(needle, to);
        } else {
          // A rejected candidate leaves the next start open, as the string cursor's partial matches do.
          at = hay.indexOf(needle, at + 1);
        }
      }
      return out;
    }
    let partials: { from: number; index: number }[] = [];
    let pos = 0;
    while (pos < line.length) {
      const cp = line.codePointAt(pos)!;
      const str = String.fromCodePoint(cp);
      const start = pos;
      pos += str.length;
      const n = norm(!matchCase, str);
      let from = start;
      let precise = true;
      let found: [number, number] | null = null;
      for (let i = 0; i < n.length; i++) {
        const code = n.charCodeAt(i);
        // Continue partial matches with this unit of text.
        let match: [number, number] | null = null;
        for (let k = 0; k < partials.length;) {
          const p = partials[k]!;
          let keep = false;
          if (query.charCodeAt(p.index) === code) {
            if (p.index === query.length - 1) match = [p.from, pos];
            else { p.index++; keep = true; }
          }
          if (keep) k++; else partials.splice(k, 1);
        }
        if (query.charCodeAt(0) === code) {
          if (query.length === 1) match = [from, pos];
          else partials.push({ from, index: 1 });
        }
        if (match && wholeWord && !atWordEdges(cat, line, match[0], match[1])) match = null;
        if (match) { found = match; break; }
        if (precise && i < str.length && str.charCodeAt(i) === code) from++;
        else precise = false;
      }
      if (found) {
        out.push(found);
        if (out.length >= max) break;
        partials = [];
      }
    }
    return out;
  };
}

export function compileSearch(spec: SearchSpec): Compiled {
  if (!spec.query) return { kind: 'empty' };
  if (spec.regex) {
    if (!validRegExp(spec.query)) return { kind: 'invalid' };
    if (regexHasLineBreak(spec.query)) return { kind: 'multiline' };
    const re = new RegExp(spec.query, BASE_FLAGS + (spec.matchCase ? '' : 'i'));
    return { kind: 'ok', ranges: regexRanges(re, spec.wholeWord) };
  }
  const unquoted = unquote(spec.query);
  if (/[\n\r]/.test(unquoted)) return { kind: 'multiline' };
  return { kind: 'ok', ranges: stringRanges(unquoted, spec.matchCase, spec.wholeWord) };
}

const CONTEXT_CHARS = 40;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * The kept slice of a line for its matches: the whole line when it fits in `keptLineChars`; a longer one from 40
 * characters before the first match (no later than its last `keptLineChars`) on, at most `keptLineChars`, never
 * splitting a surrogate pair. `cutStart` / `cutEnd` say whether the line goes on before or after it (a row shows "…"
 * there, a copy of it too).
 */
export function lineResult(line: number, text: string, ranges: [number, number][], keptLineChars: number): SearchLine {
  const first = ranges[0]?.[0] ?? 0;
  let start = text.length <= keptLineChars ? 0 : Math.max(0, Math.min(first - CONTEXT_CHARS, text.length - keptLineChars));
  if (start > 0 && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1))) start--;
  let end = Math.min(text.length, start + keptLineChars);
  if (end < text.length && end > start && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) end--;
  return { line, text: text.slice(start, end), start, ranges, cutStart: start > 0, cutEnd: end < text.length };
}
