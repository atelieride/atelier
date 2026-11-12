import { MAX_FILE_BYTES, MAX_LARGE_FILE_BYTES } from './files';

/** What a search looks for: the same four fields the editor's find card has. */
export interface SearchSpec { query: string; matchCase: boolean; wholeWord: boolean; regex: boolean }

export interface SearchRequest extends SearchSpec {
  searchId: number;
  include: string;
  exclude: string;
  includeIgnored: boolean;
  /** Absolute paths of the window's files with unsaved changes: the page searches their buffers, main marks their place. */
  unsaved: string[];
}

/** A line with matches: `text` is the kept slice of the line starting at column `start`; ranges are line columns (UTF-16). */
export interface SearchLine { line: number; text: string; start: number; ranges: [number, number][] }

/** `unsaved`: a placeholder for a file the page searches itself (its buffer differs from the disk); it has no lines. */
export interface SearchFile { path: string; rel: string; size: number; lines: SearchLine[]; unsaved?: true }

export interface SkippedFile { path: string; rel: string; size: number; reason: 'too-large' | 'unreadable' }

export type SearchEvent =
  | { kind: 'batch'; searchId: number; files: SearchFile[]; searched: number; total: number }
  | { kind: 'done'; searchId: number; searched: number; total: number; skipped: SkippedFile[]; limitHit: boolean; fileCap: number | null; stopped: boolean }
  | { kind: 'error'; searchId: number; message: string; rel: string | null }
  | { kind: 'stale'; searchId: number };

export const SEARCH_LIMITS = {
  /** Matches kept per search. */
  maxResults: 20_000,
  /** Files listed per search. */
  maxFiles: 100_000,
  /** Files up to this size are read whole. */
  wholeReadBytes: MAX_FILE_BYTES,
  /** Files up to this size are searched by streaming; larger ones are skipped and listed. */
  maxBytes: MAX_LARGE_FILE_BYTES,
  /** Characters of a matching line that are kept. */
  keptLineChars: 2_000,
  queryMax: 1_000,
  globMax: 2_000,
  /** Lines in a result list sent to a session or copied. */
  sendLines: 200,
} as const;
