// files.* on the demo's in-memory working tree: reading, listing, the ⌘K index and terminal
// path resolution, and the editor's and the tree's writes with main's semantics (src/main/fs/write.ts): a save checks
// the content it was read with and answers a conflict, never creates a file unless forced; names are validated; a
// duplicate is "name copy.ext"; a folder stays when emptied. Every change goes through the worktree, which tells the
// renderer (fsChanged, git) as main's watcher would.
import type { AtelierApi, SaveResult } from '@shared/api';
import type { DirEntry, FileContent, Stamp } from '@shared/files';
import { notInDemo } from './not-in-demo';
import { relOf, resolved, type DemoContext } from './context';

/** main's DEFAULT_HIDDEN (src/main/fs/files.ts): folders the tree hides unless asked. */
export const HIDDEN: ReadonlySet<string> = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.next', 'coverage', '.turbo', '.cache', '.DS_Store']);
/** main's MAX_BYTES for a save. */
const MAX_BYTES = 5 * 1024 * 1024;

/** A short, stable content hash (FNV-1a): the save conflict check only compares it with itself. */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const utf8 = new TextEncoder();
const isGitName = (c: string) => c.normalize('NFC').toLowerCase() === '.git';
/** main's validName: no separators, NUL, "." "..", ".git", nor names that are too long. */
const validName = (name: string) => name.length > 0 && name.length <= 255 && !/[/\0]/.test(name) && name !== '.' && name !== '..' && !isGitName(name);
const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const join = (dir: string, rel: string) => (dir ? `${dir}/${rel}` : rel);

export function createFiles(ctx: DemoContext): AtelierApi['files'] {
  const root = ctx.world.project.root;
  const started = ctx.now();
  /** When the demo last wrote each path (the stamp's mtime); untouched files date from the start. */
  const mtimes = new Map<string, number>();
  const abs = (rel: string) => (rel ? `${root}/${rel}` : root);
  const files = () => ctx.state.files;
  const dirs = () => ctx.state.dirs;
  const isFile = (rel: string) => files()[rel] !== undefined;
  const isDir = (rel: string) => rel === '' || dirs().has(rel) || Object.keys(files()).some((f) => f.startsWith(`${rel}/`));
  const exists = (rel: string) => isFile(rel) || isDir(rel);
  /** A project entry (not the root, nothing inside .git), or null. */
  const entry = (path: string): string | null => {
    const rel = relOf(root, path.replace(/\/+$/, ''));
    return rel && !rel.split('/').some(isGitName) ? rel : null;
  };
  const stampOf = (rel: string): Stamp => {
    const text = files()[rel]!;
    return { mtimeMs: mtimes.get(rel) ?? started, size: utf8.encode(text).length, hash: contentHash(text) };
  };
  const write = (rel: string, text: string | null) => {
    if (text === null) mtimes.delete(rel); else mtimes.set(rel, ctx.now());
    ctx.worktree.write(rel, text);
  };
  /** A folder emptied by a move or a deletion stays, as on disk. */
  const keepParent = (rel: string) => { const p = parentOf(rel); if (p) dirs().add(p); };
  /** Every file and folder at or under `rel`, moved to `to` (null: deleted). */
  const move = (rel: string, to: string | null) => {
    const under = (f: string) => f === rel || f.startsWith(`${rel}/`);
    for (const f of Object.keys(files()).filter(under)) {
      const text = files()[f]!;
      if (to !== null) write(to + f.slice(rel.length), text);
      write(f, null);
    }
    for (const d of [...dirs()].filter(under)) {
      dirs().delete(d);
      if (to !== null) dirs().add(to + d.slice(rel.length));
    }
    keepParent(rel);
  };

  return {
    list(dir, showHidden) {
      const d = relOf(root, dir);
      if (d === null) return resolved([]);
      const names = new Map<string, boolean>();
      const add = (path: string, folder: boolean) => {
        if (d && !path.startsWith(`${d}/`)) return;
        const rest = d ? path.slice(d.length + 1) : path;
        const [first, ...more] = rest.split('/');
        names.set(first!, (names.get(first!) ?? false) || more.length > 0 || folder);
      };
      for (const f of Object.keys(files())) add(f, false);
      for (const f of dirs()) add(f, true);
      const entries: DirEntry[] = [...names].flatMap(([name, dirFlag]) => {
        const hidden = HIDDEN.has(name);
        if (hidden && !showHidden) return [];
        const rel = join(d, name);
        return [{ name, path: abs(rel), rel, dir: dirFlag, hidden }];
      });
      return resolved(entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name))));
    },
    read(path) {
      const rel = relOf(root, path);
      if (rel === null) return resolved<FileContent>({ kind: 'outside', path, rel: path });
      const text = files()[rel];
      if (text === undefined) return resolved<FileContent>({ kind: 'missing', path, rel });
      return resolved<FileContent>({ kind: 'text', path, rel, text, ...stampOf(rel) });
    },
    // The world has no images.
    readImage: (path) => resolved({ kind: 'missing', path, rel: relOf(root, path) ?? path }),
    // The fictional world has no file past 5 MB: inert.
    readLarge: (path) => resolved({ kind: 'missing', path, rel: relOf(root, path) ?? path }),
    // No videos in the fictional world, and no atelier-media: scheme in a browser: inert.
    openVideo: (path) => resolved({ kind: 'missing', path, rel: relOf(root, path) ?? path }),
    resolve(candidate, cwd) {
      const tries = candidate.startsWith('/') ? [candidate] : [`${cwd}/${candidate}`, `${root}/${candidate}`];
      for (const t of tries) {
        const rel = relOf(root, t.replace(/\/\.\//g, '/'));
        if (rel && exists(rel)) return resolved({ path: abs(rel), rel });
      }
      return resolved(null);
    },
    // No Claude temp folder in the world.
    claudeTemp: { resolve: () => resolved(null), open: () => resolved(null), reveal: () => resolved(false) },
    // Nothing outside the fictional project either.
    outside: { resolve: () => resolved(null), open: () => resolved(null) },
    index: () => resolved(Object.keys(files()).sort().map((rel) => ({ path: abs(rel), rel }))),
    save(path, text, base, eol, create = false) {
      const out = (r: SaveResult) => resolved(r);
      const rel = entry(path);
      if (rel === null) return out({ kind: 'error', reason: 'outside' });
      const present = isFile(rel);
      if (!present && isDir(rel)) return out({ kind: 'error', reason: 'not-a-file' });
      if (!present && !create) return out({ kind: 'error', reason: 'missing' });
      const data = eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text;
      if (utf8.encode(data).length > MAX_BYTES) return out({ kind: 'error', reason: 'too-large' });
      // A conflict is about content: what the editor read is no longer what is there (Claude wrote meanwhile).
      // Recreating (`create`) a file that is back, with nothing to compare it to, is one too.
      if (present && (base ? contentHash(files()[rel]!) !== base.hash : create)) return out({ kind: 'conflict', disk: files()[rel]!, stamp: stampOf(rel) });
      if (!isDir(parentOf(rel))) return out({ kind: 'error', reason: 'ENOENT' });
      write(rel, data);
      return out({ kind: 'saved', stamp: stampOf(rel) });
    },
    create(dir, name, kind) {
      if (!validName(name)) return resolved({ error: 'invalid-name' });
      const d = relOf(root, dir.replace(/\/+$/, ''));
      if (d === null || d.split('/').some(isGitName)) return resolved({ error: 'outside' });
      if (!isDir(d)) return resolved({ error: isFile(d) ? 'outside' : 'missing' });
      const rel = join(d, name);
      if (exists(rel)) return resolved({ error: 'exists' });
      if (kind === 'folder') {
        dirs().add(rel);
        ctx.events.emit('fsChanged', [abs(rel)]);
      } else write(rel, '');
      return resolved({ path: abs(rel) });
    },
    saveAs(rel, text) {
      const parts = rel.split('/');
      if (rel.startsWith('/')) return resolved({ error: 'absolute' });
      if (parts.includes('..')) return resolved({ error: 'outside' });
      if (parts.some((c) => c === '' || c === '.')) return resolved({ error: 'invalid-name' });
      if (parts.some(isGitName)) return resolved({ error: 'in-git' });
      if (!parts.every(validName)) return resolved({ error: 'invalid-name' });
      const dir = parts.slice(0, -1).join('/');
      if (!isDir(dir)) return resolved({ error: isFile(dir) ? 'not-a-folder' : 'missing-folder' });
      if (exists(rel)) return resolved({ error: 'exists' });
      if (utf8.encode(text).length > MAX_BYTES) return resolved({ error: 'too-large' });
      write(rel, text);
      return resolved({ path: abs(rel) });
    },
    rename(path, name) {
      if (!validName(name)) return resolved({ error: 'invalid-name' });
      const rel = entry(path);
      if (rel === null || !exists(rel)) return resolved({ error: 'outside' });
      const dest = join(parentOf(rel), name);
      if (dest === rel) return resolved({ path: abs(dest) });
      if (exists(dest)) return resolved({ error: 'exists' });
      move(rel, dest);
      return resolved({ path: abs(dest) });
    },
    duplicate(path) {
      const rel = entry(path);
      if (rel === null) return resolved({ error: 'outside' });
      if (!isFile(rel)) return resolved({ error: isDir(rel) ? 'not-a-file' : 'missing' });
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      const dot = name.lastIndexOf('.');
      // As main: a dotfile without another dot (".env") has no extension.
      const ext = dot > 0 ? name.slice(dot) : '';
      const stem = name.slice(0, name.length - ext.length);
      for (let n = 1; n < 1000; n++) {
        const dest = join(parentOf(rel), `${stem} copy${n === 1 ? '' : ` ${n}`}${ext}`);
        if (exists(dest)) continue;
        write(dest, files()[rel]!);
        return resolved({ path: abs(dest) });
      }
      return resolved({ error: 'too-many-copies' });
    },
    // The page asks in the tree row with this: a folder's files, counted in memory.
    trashInfo(path) {
      const rel = entry(path);
      if (rel === null || !exists(rel)) return resolved({ error: 'outside' });
      if (isFile(rel)) return resolved({ kind: 'file' as const, files: 1 });
      return resolved({ kind: 'folder' as const, files: Object.keys(files()).filter((f) => f.startsWith(`${rel}/`)).length });
    },
    // Asked in the row first; in memory nothing is lost for good (a reload brings the world back).
    trash(path) {
      const rel = entry(path);
      if (rel === null || !exists(rel)) return resolved({ error: 'outside' });
      move(rel, null);
      if (!isFile(rel)) ctx.events.emit('fsChanged', [abs(rel)]);
      return resolved({ ok: true as const });
    },
    openDropped: () => { notInDemo('Open dropped files'); return resolved(undefined); },
    openPicker: () => { notInDemo('Open File'); return resolved(undefined); },
    // No save panel in a browser: the sheet stays as it was.
    saveAsOutside: () => { notInDemo('Save Outside the Project'); return resolved({ canceled: true as const }); },
    openReady: () => resolved([])
  };
}
