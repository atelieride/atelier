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
  for (const c of text) {
    if (c === '{') depth++;
    else if (c === '}' && depth > 0) depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  return parts;
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
          out = out.replace(/\\\/$/, '') + '(?:/.*)?';
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
        out += `[${neg ? '^' : ''}${cls.replace(/[\\\]^]/g, '\\$&')}]`;
        i = end;
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
 *  segment, `**` crosses segments, `{a,b}` and `[...]` work, and case is ignored. */
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${body(glob)}$`, 'i');
}

/** The globs one user pattern stands for. Without a `/` (once a leading `./` and a trailing `/` are dropped) a
 *  pattern matches anywhere in the tree; with one it is anchored at the project root. Either way it also matches
 *  everything under a directory it names, so a plain `src` is a name or path prefix. */
function expand(pattern: string): string[] {
  let p = pattern.trim();
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!p) return [];
  const anchored = p.includes('/');
  const base = anchored ? p : `**/${p}`;
  return [base, `${base}/**`];
}

function compileList(text: string): RegExp[] {
  return splitTopLevel(text).flatMap(expand).map(globToRegExp);
}

/** A predicate over project-relative paths: true when the path matches the include list (or it is empty) and
 *  does not match the exclude list. */
export function compilePathFilter(include: string, exclude: string): (rel: string) => boolean {
  const inc = compileList(include);
  const exc = compileList(exclude);
  if (!inc.length && !exc.length) return () => true;
  return (rel) => (inc.length === 0 || inc.some((r) => r.test(rel))) && !exc.some((r) => r.test(rel));
}
