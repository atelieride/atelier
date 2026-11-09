import { isBelow, samePath } from '@shared/paths';
import { pathStyle } from '@shared/platform';

/**
 * `to` relative to the folder `from`. On Windows names compare in any case, and a folder on another drive than the
 * file has no relative path to it: null.
 */
function relative(from: string, to: string): string | null {
  const win = pathStyle() === 'win32';
  const split = (p: string) => p.split(win ? /[\\/]/ : '/').filter(Boolean);
  const a = split(from);
  const b = split(to);
  const same = (x: string, y: string) => (win ? x.toLowerCase() === y.toLowerCase() : x === y);
  if (win && (a.length === 0 || b.length === 0 || !same(a[0]!, b[0]!))) return null;
  let i = 0;
  while (i < a.length && i < b.length && same(a[i]!, b[i]!)) i++;
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/') || '.';
}

export interface LineRange { start: number; end: number }

/**
 * "@path " to write in Claude's prompt: relative to the session folder, quoted if it has spaces.
 * With lines as Claude Code writes them from the IDE: @path#L10-24 (a single line: #L7).
 */
export function mentionPath(file: string, sessionCwd: string | null, root: string, lines?: LineRange | null): string {
  // A file outside the project (opened from Finder or Open File…): its absolute path, not one climbing out of the root.
  const base = root.replace(/\/$/, '');
  const rel = (samePath(base, file) || isBelow(base, file) ? relative(sessionCwd ?? root, file) : null) ?? file;
  const ref = lines ? `${rel}#L${lines.start}${lines.end !== lines.start ? `-${lines.end}` : ''}` : rel;
  return /\s/.test(ref) ? `@"${ref}" ` : `@${ref} `;
}

/**
 * The file to mention in the project root's form (the terminals' one). The tree and git give real paths:
 * with a project opened through a symlink (/var → /private/var) the real prefix goes back to the root's.
 */
export function mentionTarget(path: string, root: string, realRoot: string): string {
  if (root === realRoot) return path;
  const real = realRoot.replace(/\/$/, '');
  return isBelow(real, path) ? root.replace(/\/$/, '') + path.slice(real.length) : path;
}

/** Lines covered by the selection (from..to); null if empty. If it ends at the start of a line, that line doesn't count. */
export function selectionLines(doc: { lineAt(pos: number): { number: number; from: number } }, from: number, to: number): LineRange | null {
  if (from === to) return null;
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  const start = doc.lineAt(a).number;
  const last = doc.lineAt(b);
  const end = last.from === b && last.number > start ? last.number - 1 : last.number;
  return { start, end };
}

/** Long text in pieces (Paste in the terminal: each send stays under the term:input limit). */
export function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    // Never between the two halves of a surrogate pair (an emoji would arrive as two broken characters).
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end = end - 1 > i ? end - 1 : end + 1;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}
