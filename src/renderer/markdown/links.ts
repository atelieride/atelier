// Links in the Markdown preview: what a click does depends only on the href's shape.
import { isSafeUrl } from '@shared/links';
import { isAbsPath } from '@shared/paths';
import { pathStyle } from '@shared/platform';

export type Href =
  | { kind: 'anchor'; id: string }
  | { kind: 'url'; url: string }
  | { kind: 'file'; path: string; line: number | null; end: number | null }
  | { kind: 'inert' };

const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

/** `#id` scrolls, http(s) goes to the browser, any other scheme (javascript:, file:, mailto:…) does nothing, the rest
 * is a project file, with `#L42` / `#L10-L20` lines. */
export function classifyHref(href: string): Href {
  const h = href.trim();
  if (!h) return { kind: 'inert' };
  if (h.startsWith('#')) return { kind: 'anchor', id: decode(h.slice(1)) };
  // A Windows drive (`C:/…`) is a path, not a one-letter scheme.
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) && !isDrivePath(h)) return /^https?:/i.test(h) && isSafeUrl(h) ? { kind: 'url', url: h } : { kind: 'inert' };
  if (h.startsWith('//')) return { kind: 'inert' };
  const hash = h.indexOf('#');
  const fragment = hash >= 0 ? h.slice(hash + 1) : '';
  const path = decode((hash >= 0 ? h.slice(0, hash) : h).replace(/\?.*$/, ''));
  if (!path) return fragment ? { kind: 'anchor', id: decode(fragment) } : { kind: 'inert' };
  const m = /^L(\d+)(?:-L?(\d+))?$/.exec(fragment);
  return { kind: 'file', path, line: m ? Number(m[1]) : null, end: m?.[2] ? Number(m[2]) : null };
}

/** What `files.resolve` gets for a file link: relative to the Markdown file's folder; a leading slash (GitHub's
 * repository root) and untitled tabs use the project root. */
export function linkCandidate(path: string, file: string, root: string): { candidate: string; cwd: string } {
  if (path.startsWith('/')) return { candidate: path.replace(/^\/+/, ''), cwd: root };
  if (!isAbsPath(file)) return { candidate: path, cwd: root };
  return { candidate: path, cwd: folderOf(file) };
}

const isDrivePath = (p: string) => pathStyle() === 'win32' && isAbsPath(p);

/** The folder of an absolute (canonical) file path: `/` or `C:/` for a file at the root. */
function folderOf(file: string): string {
  const dir = file.slice(0, file.lastIndexOf('/'));
  return dir === '' ? '/' : /^[A-Za-z]:$/.test(dir) ? `${dir}/` : dir;
}

/** The absolute path of a local image (`![](./a.png)`): against the file's folder, or the project root for a leading
 * slash and untitled tabs; `.` and `..` folded (main still confines it to the project). Null for URLs and schemes. */
export function imagePath(src: string, file: string, root: string): string | null {
  const s = src.trim();
  if (!s || /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//') || s.startsWith('#')) return null;
  const clean = decode(s.replace(/[?#].*$/, ''));
  if (!clean) return null;
  const dir = isAbsPath(file) ? folderOf(file) : root;
  const full = clean.startsWith('/') ? `${root}/${clean}` : `${dir}/${clean}`;
  // A Windows drive stays in front: `..` never climbs above it.
  const drive = /^[A-Za-z]:(?=\/)/.exec(full)?.[0] ?? '';
  const parts: string[] = [];
  for (const seg of full.slice(drive.length).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return `${drive}/${parts.join('/')}`;
}
