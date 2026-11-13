// Include/exclude path filter for Find in Files: comma-separated glob lists matched against project-relative paths
// (always `/`-separated), case-insensitively because the file systems the app runs on are.

const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|/]/g;

function escapeChar(c: string): string {
  return c.replace(REGEX_SPECIAL, '\\$&');
}

/** Index of the `close` matching the bracket at `open`, or -1 when it never closes. */
function findClose(glob: string, open: number): number {
  const opener = glob[open];
  if (opener === '[') {
    let i = open + 1;
    if (glob[i] === '!' || glob[i] === '^') i++;
    if (glob[i] === ']') i++;
    for (; i < glob.length; i++) if (glob[i] === ']') return i;
    return -1;
  }
  let depth = 0;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === '{') depth++;
    else if (glob[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Splits `a,b{c,d}` on the commas that are not inside braces. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    // A brace that never closes is plain text: it must not hide the commas after it.
    if (c === '{' && findClose(text, i) >= 0) depth++;
    else if (c === '}' && depth > 0) depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}

function validRegExp(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/** Expands every `{a,b}` group into separate patterns, each alternative trimmed, so that each one is judged on
 *  its own (anchored or anywhere). Groups that never close stay as written; a pattern that would expand past a
 *  few hundred alternatives is left unexpanded (`globToRegExp` still reads its braces). */
function expandBraces(pattern: string): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    if (out.length > 256) return;
    const open = [...p].findIndex((c, i) => c === '{' && findClose(p, i) >= 0);
    if (open < 0) {
      out.push(p);
      return;
    }
    const close = findClose(p, open);
    for (const alt of splitTopLevel(p.slice(open + 1, close))) walk(p.slice(0, open) + alt.trim() + p.slice(close + 1));
  };
  walk(pattern);
  return out.length > 256 ? [pattern] : out;
}

function body(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob[i + 1] === '*') {
        let j = i + 2;
        while (glob[j] === '*') j++;
        const atStart = i === 0 || glob[i - 1] === '/';
        if (atStart && glob[j] === '/') {
          out += '(?:.*/)?'; // zero or more whole directories
          i = j;
        } else if (atStart && j === glob.length && i > 0) {
          if (out.endsWith('(?:.*/)?')) out += '.*';
          else out = out.replace(/\\\/$/, '') + '(?:/.*)?';
          i = j - 1;
        } else {
          out += '.*';
          i = j - 1;
        }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = findClose(glob, i);
      if (end < 0) out += '\\[';
      else {
        let cls = glob.slice(i + 1, end);
        let neg = false;
        if (cls[0] === '!' || cls[0] === '^') {
          neg = true;
          cls = cls.slice(1);
        }
        const cooked = `[${neg ? '^' : ''}${cls.replace(/[\\\]^[]/g, '\\$&')}${neg ? '/' : ''}]`;
        if (validRegExp(cooked)) {
          out += cooked;
          i = end;
        } else out += '\\['; // e.g. a reversed range: the bracket is plain text
      }
    } else if (c === '{') {
      const end = findClose(glob, i);
      if (end < 0) out += '\\{';
      else {
        out += `(?:${splitTopLevel(glob.slice(i + 1, end)).map(body).join('|')})`;
        i = end;
      }
    } else out += escapeChar(c);
  }
  return out;
}

/** A regular expression that matches a whole relative path against `glob`: `*` and `?` stay inside a path
 *  segment, `**` crosses segments, `{a,b}` and `[...]` work, and case is ignored. `orBelow`: every path under one
 *  it matches too, as if the glob were followed by a trailing `**` segment. */
export function globToRegExp(glob: string, orBelow = false): RegExp {
  // A suffix on the expression rather than a glob that ends in a slash and two stars: the live demo's bundle carries
  // this module, and a check of that bundle reads a slash followed by two stars as the start of a comment.
  const below = orBelow ? '(?:/.*)?' : '';
  try {
    return new RegExp(`^${body(glob)}${below}$`, 'i');
  } catch {
    return new RegExp(`^${[...glob].map(escapeChar).join('')}${below}$`, 'i'); // never throw while the user types
  }
}

/** The globs one user pattern stands for. Without a `/` (once a leading `./` and a trailing `/` are dropped) a
 *  pattern matches anywhere in the tree; with one it is anchored at the project root. Either way it also matches
 *  everything under a directory it names (compiled with `orBelow`), so a plain `src` is a name or path prefix. */
function expand(pattern: string): string[] {
  return expandBraces(pattern.trim()).flatMap(expandOne);
}

function expandOne(pattern: string): string[] {
  let p = pattern.trim();
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!p) return [];
  return [p.includes('/') ? p : `**/${p}`];
}

function compileList(text: string): RegExp[] {
  return splitTopLevel(text).flatMap(expand).map((glob) => globToRegExp(glob, true));
}

/** A predicate over project-relative paths: true when the path matches the include list (or it is empty) and
 *  does not match the exclude list. */
export function compilePathFilter(include: string, exclude: string): (rel: string) => boolean {
  const inc = compileList(include);
  const exc = compileList(exclude);
  if (!inc.length && !exc.length) return () => true;
  return (rel) => (inc.length === 0 || inc.some((r) => r.test(rel))) && !exc.some((r) => r.test(rel));
}
