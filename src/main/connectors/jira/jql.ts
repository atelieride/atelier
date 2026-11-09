// The only JQL Atelier ever sends. Pure: every value comes from validated numeric ids or
// from words reduced to letters and digits, so nothing the user types (or a source's text) can change the query's
// structure. Every query starts with `project in (…)`: Atlassian refuses unbounded JQL, the argument schema in
// tools.ts requires that prefix, and the connector still re-checks every result's project.
import { NUMERIC_ID } from './tools';

export interface ProjectScope { id: string; everyone: boolean }

export interface ListQuery {
  projects: readonly ProjectScope[];
  includeDone: boolean;
  /** A saved filter that narrows the list (digits). */
  filterId?: string;
}

/** Words a title search keeps: at most this many. */
export const MAX_SEARCH_WORDS = 6;
const MAX_WORD = 40;

function ids(list: readonly string[]): string {
  for (const id of list) if (!NUMERIC_ID.test(id)) throw new TypeError('not a numeric Jira id');
  return list.join(', ');
}

/** The bounded part every query shares: the projects, whose issues (mine or everyone's), open ones, the filter. */
function scope(q: ListQuery): string | null {
  if (q.projects.length === 0) return null;
  const all = q.projects.map((p) => p.id);
  const everyone = q.projects.filter((p) => p.everyone).map((p) => p.id);
  let jql = `project in (${ids(all)})`;
  if (everyone.length === 0) jql += ' AND assignee = currentUser()';
  else if (everyone.length < all.length) jql += ` AND (project in (${ids(everyone)}) OR assignee = currentUser())`;
  if (!q.includeDone) jql += ' AND statusCategory != Done';
  if (q.filterId !== undefined) {
    if (!NUMERIC_ID.test(q.filterId)) throw new TypeError('not a numeric Jira filter id');
    jql += ` AND filter = ${q.filterId}`;
  }
  return jql;
}

/** The list: due first (no due date last, as Jira sorts), then the latest changes. Null: no project chosen. */
export function listJql(q: ListQuery): string | null {
  const s = scope(q);
  return s === null ? null : `${s} ORDER BY duedate ASC, updated DESC`;
}

/**
 * A search's words: letters and digits only (everything else separates words), at most 6, each at most 40 characters.
 * Lucene's special characters never survive, so nothing needs escaping.
 */
export function searchWords(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !OPERATORS.has(w.toUpperCase()))
    .slice(0, MAX_SEARCH_WORDS).map((w) => w.slice(0, MAX_WORD));
}

/** Lucene's operators: Jira's text search fails on them even inside quotes. */
const OPERATORS: ReadonlySet<string> = new Set(['AND', 'OR', 'NOT']);

/** Titles containing every word (as a prefix), within the list's own scope. Null: no project, or no word left. */
export function searchJql(q: ListQuery, text: string): string | null {
  const s = scope(q);
  const words = searchWords(text);
  if (s === null || words.length === 0) return null;
  return `${s} AND ${words.map((w) => `summary ~ "${w}*"`).join(' AND ')} ORDER BY updated DESC`;
}

/** Automations' watch read: the newest issues of these projects (open ones unless asked), everyone's. */
export function watchJql(projectIds: readonly string[], o: { includeDone: boolean }): string | null {
  if (projectIds.length === 0) return null;
  return `project in (${ids(projectIds)})${o.includeDone ? '' : ' AND statusCategory != Done'} ORDER BY created DESC`;
}
