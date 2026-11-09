// What a Notion database's fields mean on both sides: which select options read as done,
// and when two sets of fields are the same. Main guesses and checks with them (fields.ts, sources.ts); the fields
// editor fills a newly chosen select's done options and spots an edit main refused. Pure.
import { MAX_CLOSED_OPTIONS, type NotionFields } from './tasks';

const CLOSED_NAME = /^(?:done|complete|completed|closed|shipped|resolved|released|cancell?ed|archived|won['’]?t do)$/i;

/** The options that read as closed (done, shipped, won't do…), the first MAX_CLOSED_OPTIONS in option order. */
export function guessClosed(options: readonly string[]): string[] {
  return options.filter((n) => CLOSED_NAME.test(n.trim())).slice(0, MAX_CLOSED_OPTIONS);
}

/** The same fields, compared field by field (key order doesn't matter; closed options in order). */
export function sameNotionFields(a: NotionFields, b: NotionFields): boolean {
  const sa = a.status;
  const sb = b.status;
  const status = sa === undefined || sb === undefined ? sa === sb
    : sa.prop === sb.prop && sa.kind === sb.kind && sa.closed.length === sb.closed.length && sa.closed.every((c, i) => c === sb.closed[i]);
  const assignee = a.assignee === undefined || b.assignee === undefined ? a.assignee === b.assignee
    : a.assignee.prop === b.assignee.prop && a.assignee.mine === b.assignee.mine;
  return a.title === b.title && status && assignee && a.due === b.due && a.id === b.id;
}
