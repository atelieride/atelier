// Which columns of a Notion data source mean title, status, assignee, due date and ID, and the
// rows query built from them. Pure: the schema comes from markup.ts, the query goes to notion-query-data-sources
// through NOTION_TOOLS' strict argument schema (tools.ts).
//
// Spike: Notion silently ignores a filter on a column that doesn't exist, so a renamed or deleted mapped column would
// list closed tasks or everyone's tasks with no error (Review Focus 1). `validateFields` re-guesses every mapped column
// that is gone or changed type, and `rowsQuery` runs it itself: a query never names a column the schema lacks, and
// there is no query at all without a title column (the connector marks that database unreadable).
// The closed options' cap (MAX_CLOSED_OPTIONS) is shared: the fields editor applies the same one (the filter holds 12
// items, tools.ts).
import { MAX_CLOSED_OPTIONS, type Column, type NotionFields } from '@shared/tasks';
import { guessClosed } from '@shared/notion-fields';
import type { ToolArgs } from '../mcp/toolset';
import { oneLine } from '../text';
import { STATUS_GROUPS, dashedId, type DataSourceSchema, type SchemaOption, type SchemaProperty } from './markup';
import { toneOf } from './map';
import type { NOTION_TOOLS } from './tools';

export type RowsArgs = ToolArgs<typeof NOTION_TOOLS, 'notion-query-data-sources'>;
export type RowsFilter = NonNullable<RowsArgs['data']['filter']>['filters'][number];
type Status = NonNullable<NotionFields['status']>;

/** The limits of NOTION_TOOLS' argument schema: a column name ≤ 100 characters, an option (exact value) ≤ 200. */
export const MAX_PROP_CHARS = 100;
export const MAX_OPTION_CHARS = 200;
export const LIST_LIMIT = 100;
export const SEARCH_LIMIT = 25;

/**
 * Characters that make a column or option name unusable: controls, bidi controls and line/paragraph separators. A
 * zero-width joiner stays allowed (emoji in column names use it). Escapes only: never a raw invisible character here.
 */
const UNSENDABLE = new RegExp('[\\p{Cc}\\p{Zl}\\p{Zp}\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]', 'u');

/** A name Atelier can send back to Notion unchanged (and show as is). */
export function usableName(name: string, max: number): boolean {
  return name.length >= 1 && name.length <= max && !UNSENDABLE.test(name);
}

/** A whole word (letters around it don't count: "Statement" is not a state; "task_status" is a status). */
const word = (words: string): RegExp => new RegExp(`(?:^|[^a-z])(?:${words})(?:$|[^a-z])`, 'i');
const STATUS_NAME = word('status(?:es)?|stages?|states?|phases?');
const ASSIGNEE_NAMES = [/assign|owner|responsible|\bdri\b|people/i];
/** Due-date names in order of preference: due/deadline before a generic date/when. */
const DUE_NAMES = [/due|deadline/i, /date|when/i];
/** Notion's unique-ID column types (the ID field). */
export const ID_TYPES: readonly string[] = Object.freeze(['auto_increment_id', 'unique_id']);

/** The schema's property of that name, own properties only ("constructor" is a column name like any other). */
export function propertyOf(schema: DataSourceSchema, name: string): SchemaProperty | undefined {
  return Object.hasOwn(schema.properties, name) ? schema.properties[name] : undefined;
}
const fits = (schema: DataSourceSchema, name: string, types: readonly string[]): boolean => {
  const p = propertyOf(schema, name);
  return !!p && types.includes(p.type);
};

/** The usable columns of these types, in schema order. */
const usable = (schema: DataSourceSchema, types: readonly string[]): [string, SchemaProperty][] =>
  Object.entries(schema.properties).filter(([n, p]) => types.includes(p.type) && usableName(n, MAX_PROP_CHARS));

/** The first usable column of these types named like the first pattern that matches one, else the first one. */
function pick(schema: DataSourceSchema, types: readonly string[], likes: readonly RegExp[] = []): string | undefined {
  const names = usable(schema, types).map(([n]) => n);
  for (const like of likes) {
    const hit = names.find((n) => like.test(n));
    if (hit) return hit;
  }
  return names[0];
}

/**
 * A select's sendable options that read as closed (done, shipped, won't do…), the first MAX_CLOSED_OPTIONS in option
 * order (the rule is shared with the fields editor: src/shared/notion-fields.ts).
 */
function closedOptions(p: SchemaProperty): string[] {
  return guessClosed((p.options ?? []).map((o) => o.name).filter((n) => usableName(n, MAX_OPTION_CHARS)));
}

/** The saved closed options this select still has, in the saved order, capped. */
function carriedOver(closed: readonly string[], p: SchemaProperty): string[] {
  const names = new Set((p.options ?? []).map((o) => o.name));
  return closed.filter((n) => names.has(n)).slice(0, MAX_CLOSED_OPTIONS);
}

function guessStatus(schema: DataSourceSchema): Status | undefined {
  const status = pick(schema, ['status'], [/^\s*status\s*$/i]);
  if (status) return { prop: status, kind: 'status', closed: [] };
  const select = usable(schema, ['select']).find(([n]) => STATUS_NAME.test(n));
  return select ? { prop: select[0], kind: 'select', closed: closedOptions(select[1]) } : undefined;
}

/**
 * The status column again after the saved one went away or changed type: the same column if it is now a `status` one
 * (Notion's Complete group); else the select that holds the most of the saved closed options (a renamed column keeps
 * its options), with those options; else the first guess.
 */
function reguessStatus(schema: DataSourceSchema, saved: Status): Status | undefined {
  if (propertyOf(schema, saved.prop)?.type === 'status' && usableName(saved.prop, MAX_PROP_CHARS)) {
    return { prop: saved.prop, kind: 'status', closed: [] };
  }
  if (saved.kind === 'select' && saved.closed.length > 0) {
    let best: { prop: string; closed: string[] } | undefined;
    for (const [prop, p] of usable(schema, ['select'])) {
      const closed = carriedOver(saved.closed, p);
      if (closed.length > (best?.closed.length ?? 0)) best = { prop, closed };
    }
    if (best) return { prop: best.prop, kind: 'select', closed: best.closed };
  }
  return guessStatus(schema);
}

/** Each field's guess on its own (a title-less schema still has the others, for validateFields). */
function guesses(schema: DataSourceSchema): Partial<NotionFields> {
  const out: Partial<NotionFields> = {};
  const title = pick(schema, ['title']);
  if (title) out.title = title;
  const status = guessStatus(schema);
  if (status) out.status = status;
  const assignee = pick(schema, ['person'], ASSIGNEE_NAMES);
  if (assignee) out.assignee = { prop: assignee, mine: true };
  const due = pick(schema, ['date'], DUE_NAMES);
  if (due) out.due = due;
  const id = pick(schema, ID_TYPES);
  if (id) out.id = id;
  return out;
}

/**
 * Atelier's first guess. A `status` column keeps `closed` empty: it always means Notion's Complete group
 * (read from the schema each time, never saved). Null when the data source has no usable title column.
 */
export function guessFields(schema: DataSourceSchema): NotionFields | null {
  const g = guesses(schema);
  return g.title ? { ...g, title: g.title } : null;
}

export interface Validated {
  fields: NotionFields;
  /** The fields differ from the saved ones: save them, log "fields re-guessed after a column change". */
  changed: boolean;
  /** The data source has no usable title column any more: no query is possible (the database is unreadable). */
  missingTitle: boolean;
}

/**
 * The saved fields checked against the current schema: a mapped column that is gone or changed type is guessed again
 * (or dropped when nothing fits); a field the user left at "None" stays None. For a `select` status, closed options
 * that no longer exist are dropped (guessed again when none is left), and a renamed column is found again by the
 * closed options it still holds. A title column that is gone and has no successor is reported (`missingTitle`).
 */
export function validateFields(fields: NotionFields, schema: DataSourceSchema): Validated {
  const guess = guesses(schema);
  let changed = false;
  let missingTitle = false;
  const out: NotionFields = { title: fields.title };
  if (!fits(schema, fields.title, ['title'])) {
    if (guess.title) { out.title = guess.title; changed = true; } else missingTitle = true;
  }

  const s = fields.status;
  if (s) {
    const p = propertyOf(schema, s.prop);
    if (p && p.type === s.kind && s.kind === 'select') {
      const kept = carriedOver(s.closed, p);
      out.status = { ...s, closed: kept.length > 0 || s.closed.length === 0 ? kept : closedOptions(p) };
      if (kept.length !== s.closed.length) changed = true;
    } else if (p && p.type === s.kind) {
      out.status = s;
    } else {
      changed = true;
      const g = reguessStatus(schema, s);
      if (g) out.status = g;
    }
  }

  if (fields.assignee) {
    if (fits(schema, fields.assignee.prop, ['person'])) out.assignee = fields.assignee;
    else {
      changed = true;
      if (guess.assignee) out.assignee = { prop: guess.assignee.prop, mine: fields.assignee.mine };
    }
  }

  for (const [key, types] of [['due', ['date']], ['id', ID_TYPES]] as const) {
    const name = fields[key];
    if (name === undefined) continue;
    if (fits(schema, name, types)) out[key] = name;
    else {
      changed = true;
      const g = guess[key];
      if (g !== undefined) out[key] = g;
    }
  }
  return { fields: out, changed, missingTitle };
}

/** The schema as the fields editor sees it: names as Notion gives them, Notion's colors as state tones. */
export function columnsOf(schema: DataSourceSchema): Column[] {
  const opts = (list: SchemaOption[] | undefined) =>
    (list ?? []).filter((o) => usableName(o.name, MAX_OPTION_CHARS)).map((o) => ({ name: o.name, tone: toneOf(o.color) }));
  return Object.entries(schema.properties).filter(([n]) => usableName(n, MAX_PROP_CHARS)).map(([name, p]): Column => {
    switch (p.type) {
      case 'title': case 'person': case 'date': return { name, type: p.type };
      case 'status': return { name, type: 'status', options: STATUS_GROUPS.flatMap((group) => opts(p.groups?.[group]).map((o) => ({ ...o, group }))) };
      case 'select': return { name, type: 'select', options: opts(p.options) };
      default: return { name, type: ID_TYPES.includes(p.type) ? 'unique_id' : 'other' };
    }
  });
}

/**
 * The filters that hide closed tasks: a `status` column → not in Notion's Complete group; a `select` → one
 * enum_is_not per closed option, at most MAX_CLOSED_OPTIONS (the filter holds 12 items). None when closed tasks are
 * included or the column doesn't fit the schema.
 */
export function closedFilter(fields: NotionFields, schema: DataSourceSchema, includeClosed: boolean): RowsFilter[] {
  const s = fields.status;
  if (includeClosed || !s || !fits(schema, s.prop, [s.kind])) return [];
  if (s.kind === 'status') {
    return [{ type: 'property', property: s.prop, propertyType: 'status', operator: 'status_is_not', value: { type: 'is_group', value: 'complete' } }];
  }
  return s.closed.filter((n) => usableName(n, MAX_OPTION_CHARS)).slice(0, MAX_CLOSED_OPTIONS).map((value) =>
    ({ type: 'property', property: s.prop, propertyType: 'select', operator: 'enum_is_not', value: { type: 'exact', value } }));
}

export interface RowsQueryOptions {
  /** The data source's current schema: the fields are validated against it first. */
  schema: DataSourceSchema;
  includeClosed: boolean;
  /** Palette search: adds `title contains` and lowers the limit to 25. */
  search?: string;
}

/**
 * One rows-mode query, in exactly the shapes verified against Notion: `and` of
 * "assigned to me" (when mine), the closed filter, the title search; sorted by due date ascending when there is one.
 * Null when the data source has no title column: a search would otherwise lose its title filter and a list would map
 * nothing (the connector reports the database unreadable).
 */
export function rowsQuery(source: string, fields: NotionFields, opts: RowsQueryOptions): RowsArgs | null {
  const { schema } = opts;
  const v = validateFields(fields, schema);
  const f = v.fields;
  if (v.missingTitle || !fits(schema, f.title, ['title'])) return null;
  const filters: RowsFilter[] = [];
  if (f.assignee?.mine && fits(schema, f.assignee.prop, ['person'])) {
    filters.push({ type: 'property', property: f.assignee.prop, propertyType: 'person', operator: 'person_contains', value: { type: 'relative', value: 'me' } });
  }
  filters.push(...closedFilter(f, schema, opts.includeClosed));
  const text = oneLine(opts.search, MAX_OPTION_CHARS).trim();
  if (text) {
    filters.push({ type: 'property', property: f.title, propertyType: 'title', operator: 'string_contains', value: { type: 'exact', value: text } });
  }
  const due = f.due !== undefined && fits(schema, f.due, ['date']) ? f.due : undefined;
  return {
    data: {
      mode: 'rows',
      data_source_url: `collection://${dashedId(source) ?? source}`,
      ...(filters.length > 0 ? { filter: { type: 'group', operator: 'and', filters } } : {}),
      ...(due !== undefined ? { sort: [{ property: due, direction: 'ascending' }] } : {}),
      limit: text ? SEARCH_LIMIT : LIST_LIMIT
    }
  };
}
