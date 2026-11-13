// The last queries of each project with their options, kept in localStorage (the way panel widths are).
import type { SearchSpec } from '@shared/search';

const KEY = 'atelier.search.recent';
const PER_PROJECT = 10;

function isSpec(v: unknown): v is SearchSpec {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return typeof s.query === 'string' && s.query !== '' && typeof s.matchCase === 'boolean' && typeof s.wholeWord === 'boolean' && typeof s.regex === 'boolean';
}

function readAll(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function listOf(all: Record<string, unknown>, root: string): SearchSpec[] {
  const v = all[root];
  if (!Array.isArray(v)) return [];
  return v.filter(isSpec).map((s) => ({ query: s.query, matchCase: s.matchCase, wholeWord: s.wholeWord, regex: s.regex })).slice(0, PER_PROJECT);
}

/** The project's recent searches, newest first. */
export function loadRecent(root: string): SearchSpec[] {
  return listOf(readAll(), root);
}

/** Puts a search first in the project's list (the same query and options move up instead of repeating); returns the list. */
export function pushRecent(root: string, s: SearchSpec): SearchSpec[] {
  const all = readAll();
  const entry: SearchSpec = { query: s.query, matchCase: s.matchCase, wholeWord: s.wholeWord, regex: s.regex };
  if (!entry.query) return listOf(all, root);
  const same = (o: SearchSpec): boolean => o.query === entry.query && o.matchCase === entry.matchCase && o.wholeWord === entry.wholeWord && o.regex === entry.regex;
  const next = [entry, ...listOf(all, root).filter((o) => !same(o))].slice(0, PER_PROJECT);
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...all, [root]: next }));
  } catch {
    // Storage may be unavailable; the list just isn't kept.
  }
  return next;
}
