import { pathStyle, type PathStyle } from './platform';

export interface FileLink { start: number; end: number; path: string; line: number | null; col: number | null }

// A path: absolute, home (~/), relative (./ ../) or with at least one slash, or a name with an extension.
// It must contain an extension or be a known name without one (Dockerfile, Makefile).
const PATH_RE = /(?<![\w/.:~-])((?:\.{1,2}\/|~\/|\/)?(?:[\w@.+-]+\/)*(?:[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,10}|\.[\w.-]+|Dockerfile[\w.-]*|Makefile))(?::(\d+)(?::(\d+))?)?(?![\w/])/g;
// Windows: the same, with a drive (`C:\`, `C:/`) and either separator.
const PATH_RE_WIN32 = /(?<![\w/\\.:~-])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|[\\/])?(?:[\w@.+-]+[\\/])*(?:[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,10}|\.[\w.-]+|Dockerfile[\w.-]*|Makefile))(?::(\d+)(?::(\d+))?)?(?![\w/\\])/g;

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

export function findFileLinks(text: string, style: PathStyle = pathStyle()): FileLink[] {
  // Areas occupied by URLs contain no file links.
  const blocked: [number, number][] = [];
  for (const m of text.matchAll(URL_RE)) blocked.push([m.index!, m.index! + m[0].length]);
  const out: FileLink[] = [];
  for (const m of text.matchAll(style === 'win32' ? PATH_RE_WIN32 : PATH_RE)) {
    let start = m.index!;
    let path = m[1]!;
    if (blocked.some(([a, b]) => start >= a && start < b)) continue;
    // Claude's mentions (@src/a.ts): the @ is not part of the path, nor of the link.
    if (path.startsWith('@')) { path = path.slice(1); start += 1; }
    // Versions and numbers (v1.2.3, 3.14) aren't files.
    if (/^v?\d+(\.\d+)+$/.test(path)) continue;
    // Sentence-ending period with no line: "fine." isn't a file.
    if (!m[2] && /\.$/.test(path)) continue;
    const end = m.index! + m[0].length;
    out.push({ start, end, path, line: m[2] ? Number(m[2]) : null, col: m[3] ? Number(m[3]) : null });
  }
  return out;
}

export function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * What a click on a terminal link does.
 * - intercept: ⌘-click; Atelier opens the link itself and the program never sees the click (with the mouse captured,
 *   Claude's redraw between press and release would otherwise lose the link);
 * - default: plain click with the mouse free; xterm opens the link;
 * - ignore: plain click while the program captures the mouse; the click is the program's, the link stays closed.
 */
export type LinkClick = 'intercept' | 'default' | 'ignore';

export function linkClickAction(o: { metaKey: boolean; mouseTracking: boolean }): LinkClick {
  if (o.metaKey) return 'intercept';
  return o.mouseTracking ? 'ignore' : 'default';
}
