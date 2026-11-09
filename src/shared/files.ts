import { isInside } from './paths';

/** external: a file outside the project the user opened; its rel is the path with ~. */
export type FileContent = (
  // readOnly 'large': text past 5 MB opened through Open Anyway, shown plain.
  | { kind: 'text'; path: string; rel: string; text: string; size: number; mtimeMs: number; hash: string; readOnly?: 'not-utf8' | 'git-internal' | 'large'; external?: true }
  | { kind: 'binary' | 'too-large'; path: string; rel: string; size: number; external?: true }
  | { kind: 'missing' | 'outside' | 'unreadable'; path: string; rel: string; external?: true }
  // In Claude's temp folder; readGrant: the project holds it only through a read grant, i.e. a terminal link opened it,
  // so it is never edited, saved or recreated. Both checked at this read, whatever its kind.
) & { claudeTemp?: true; readGrant?: true };

/** Text opens in the editor up to this size; past it, Open Anyway. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Text past 5 MB opens up to this size through Open Anyway, read-only. */
export const MAX_LARGE_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Text past 5 MB (opened anyway): shown plain and read-only, whatever else already makes it read-only (Latin-1,
 * UTF-16, inside .git) — the size decides, not the reason.
 */
export function isLargeText(c: FileContent | null): boolean {
  return c?.kind === 'text' && c.size > MAX_FILE_BYTES;
}

/** An image opened in a tab: its bytes as base64 (shown as a data: URL, which the page's CSP allows). */
export type ImageContent = (
  | { kind: 'image'; path: string; rel: string; mime: string; data: string; size: number; mtimeMs: number; external?: true }
  | { kind: 'too-large'; path: string; rel: string; size: number; external?: true }
  | { kind: 'missing' | 'outside' | 'unreadable'; path: string; rel: string; external?: true }
  // In Claude's temp folder, checked at this read.
) & { claudeTemp?: true };

/**
 * A file to open in a tab: a project file, or an external one (rel = its path with ~). line:
 * where to go, when a pop-out asked its project window to open it.
 */
export interface OpenFileEntry { path: string; rel: string; external: boolean; line?: number }

/**
 * What main asks a window to open (drop, Open File…, Open With, `atelier`). reveal: a project folder to show in the
 * Files tree. skipped: paths that opened nothing. capped: how many files there were, over the limit. needsProject:
 * files that reached a window without a project.
 */
export interface OpenPathsEvent { files: OpenFileEntry[]; reveal: string | null; skipped: number; capped: number | null; needsProject: number }

/** A path as shown to the user: ~ for the home folder, otherwise as is. */
export function homeLabel(path: string, home: string): string {
  return home && home !== '/' && isInside(home, path) ? `~${path.slice(home.length)}` : path;
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  ico: 'image/x-icon', avif: 'image/avif'
};

/** The type of an image a tab shows instead of the editor, by extension; null for anything else (SVG is text). */
export function imageMime(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? IMAGE_MIME[name.slice(dot + 1).toLowerCase()] ?? null : null;
}

const VIDEO_MIME: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg' };

/** The type of a video a tab plays instead of the editor, by extension; null otherwise. */
export function videoMime(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? VIDEO_MIME[name.slice(dot + 1).toLowerCase()] ?? null : null;
}

/**
 * A video opened in a tab: `url` is an atelier-media: token main streams it through
 * (ranges for seeking), never its bytes in the page.
 */
export type VideoContent =
  | { kind: 'video'; path: string; rel: string; mime: string; url: string; size: number; mtimeMs: number; external?: true }
  | { kind: 'missing' | 'outside' | 'unreadable'; path: string; rel: string; external?: true };

export interface DirEntry { name: string; path: string; rel: string; dir: boolean; hidden: boolean }

/** Version of the file on disk when it was read: saving compares against it to detect conflicts. */
export interface Stamp { mtimeMs: number; size: number; hash: string }
