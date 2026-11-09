// The databases the user chooses for the Notion connector: the picker's results, the entries a
// database adds (one per data source), and the fields editor's changes checked against the data source's schema. Pure:
// notion.ts calls Notion and keeps the state; this file decides what a reply or an edit means.
//
// Everything a renderer sends here passed the IPC schema (ipc-schemas.ts), but it is still checked against Notion's own
// schema: a column that doesn't exist or has another type is refused (a filter on it would be ignored by Notion, so the
// list would quietly show closed or other people's tasks — Review Focus 1).
import { MAX_CLOSED_OPTIONS, type NotionFields, type SourcePick } from '@shared/tasks';
import { oneLine } from '../text';
import { ID_TYPES, MAX_OPTION_CHARS, MAX_PROP_CHARS, guessFields, propertyOf, usableName } from './fields';
import type { DatabaseConfig } from './map';
import { notionIdFromLink, type DataSourceRef, type DataSourceSchema, type SchemaOption } from './markup';
import { notionId, type NotionSearchResult } from './tools';

const MAX_NAME_CHARS = 200;
const UNTITLED = 'Untitled';

/**
 * notion-search's results as picker rows: databases only (pages, data sources and anything else dropped), 32-hex ids,
 * deduplicated, one clean line each; `added` for the ones already chosen.
 */
export function picksFrom(results: readonly NotionSearchResult[], chosen: ReadonlySet<string>): SourcePick[] {
  const picks: SourcePick[] = [];
  for (const r of results) {
    if (r.type !== 'database') continue;
    const id = notionId(r.id) ?? (r.url ? notionIdFromLink(r.url) : null);
    if (!id || picks.some((p) => p.id === id)) continue;
    const path = oneLine(r.path, MAX_NAME_CHARS);
    picks.push({ id, name: oneLine(r.title, MAX_NAME_CHARS) || UNTITLED, ...(path ? { path } : {}), added: chosen.has(id) });
  }
  return picks;
}

/**
 * The entries a database adds: one per data source whose schema was read and has a title column, with the guessed
 * fields, named "<database> · <data source>" when there are several. `schemas` maps each data source's
 * 32-hex id to its schema (null: unreadable).
 */
export function entriesFor(
  db: { id: string; title: string | undefined; path: string | undefined }, sources: readonly DataSourceRef[],
  schemas: ReadonlyMap<string, DataSourceSchema | null>
): DatabaseConfig[] {
  const name = oneLine(db.title, MAX_NAME_CHARS) || UNTITLED;
  const path = oneLine(db.path, MAX_NAME_CHARS);
  const out: DatabaseConfig[] = [];
  for (const ref of sources) {
    const source = notionId(ref.id);
    const schema = source ? schemas.get(source) : null;
    const fields = schema ? guessFields(schema) : null;
    if (!source || !fields || out.some((e) => e.source === source)) continue;
    const label = sources.length > 1 ? oneLine(`${name} · ${ref.name || UNTITLED}`, MAX_NAME_CHARS) : name;
    out.push({ id: db.id, source, name: label, ...(path ? { path } : {}), fields });
  }
  return out;
}

/**
 * A select's closed options as the fields editor sent them: matched to the column's options (exactly, else after
 * trimming), deduplicated, empty and unsendable ones dropped, at most MAX_CLOSED_OPTIONS (the rows filter's limit).
 */
export function normalizeClosed(closed: readonly string[], options: readonly SchemaOption[]): string[] {
  const out: string[] = [];
  for (const raw of closed) {
    const t = raw.trim();
    const name = options.find((o) => o.name === raw)?.name ?? (t ? options.find((o) => o.name.trim() === t)?.name : undefined);
    if (name !== undefined && usableName(name, MAX_OPTION_CHARS) && !out.includes(name)) out.push(name);
  }
  return out.slice(0, MAX_CLOSED_OPTIONS);
}

/** The same fields, compared field by field (shared: the fields editor spots a refused edit with it). */
export { sameNotionFields as sameFields } from '@shared/notion-fields';

/**
 * The fields editor's fields checked against the data source's current schema: every named column must exist with
 * the field's type (title, the status kind, person, date, unique ID) and be sendable; else null (refused, nothing
 * saved). A `status` column keeps no closed options (Notion's Complete group), a `select` keeps normalized ones.
 */
export function checkedFields(f: NotionFields, schema: DataSourceSchema): NotionFields | null {
  const is = (name: string, types: readonly string[]) => usableName(name, MAX_PROP_CHARS) && types.includes(propertyOf(schema, name)?.type ?? '');
  if (!is(f.title, ['title'])) return null;
  const out: NotionFields = { title: f.title };
  if (f.status) {
    const { prop, kind } = f.status;
    if (!is(prop, [kind])) return null;
    out.status = { prop, kind, closed: kind === 'select' ? normalizeClosed(f.status.closed, propertyOf(schema, prop)?.options ?? []) : [] };
  }
  if (f.assignee) {
    if (!is(f.assignee.prop, ['person'])) return null;
    out.assignee = { prop: f.assignee.prop, mine: f.assignee.mine };
  }
  if (f.due !== undefined) {
    if (!is(f.due, ['date'])) return null;
    out.due = f.due;
  }
  if (f.id !== undefined) {
    if (!is(f.id, ID_TYPES)) return null;
    out.id = f.id;
  }
  return out;
}
