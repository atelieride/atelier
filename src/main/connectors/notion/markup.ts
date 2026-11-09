// Notion's MCP answers notion-fetch with "enhanced markdown": prose with XML-ish tags around JSON and Markdown (the
// exact shapes in tests/fixtures/notion/). These parsers
// read only the tags Atelier needs, anchored on their exact names, and never throw: odd input gives null or [] and the
// connector decides what that means.
//
// Everything here is untrusted: titles (a database's comes before its <ancestor-path> and <data-sources>), a data
// source's title, column names, and a page's <content>, which is the user's own Markdown. So:
// - a structural tag counts only at the start of a line: titles and names are one line inside Notion's prose, the
//   JSON blocks are one line, and the SQLite column lines start with a tab;
// - the parent data source is read only from a page fetch: the <ancestor-path> right after its <page url="…"> line
//   (the first line, or the second after Notion's one-line preamble). A database, or a page outside the chosen
//   databases, cannot claim one from a title or its body: the parent check relies on it;
// - <properties> must come before <content>, and the content runs to the last </content>;
// - JSON blocks try each closing tag in turn, so a name containing "</properties>" doesn't cut the JSON short.
import { oneLine } from '../text';
import { notionId } from './tools';

export type StatusGroup = 'to_do' | 'in_progress' | 'complete';
export const STATUS_GROUPS: readonly StatusGroup[] = Object.freeze(['to_do', 'in_progress', 'complete'] as const);

/** A select or status option; `color` is Notion's color name ("blue"), absent when Notion gives none. */
export interface SchemaOption { name: string; color?: string }

export interface SchemaProperty {
  /** Notion's type name: title, status, select, multi_select, person, date, auto_increment_id, … */
  type: string;
  options?: SchemaOption[];
  /** For a `status` property: its options by group (Notion's `current` and `future` groups are not used). */
  groups?: Record<StatusGroup, SchemaOption[]>;
}

/**
 * A data source's schema from its <data-source-state> JSON, keyed by property name. In memory only. Names
 * are raw, as Notion gives them (they are sent back to Notion verbatim): clean `name` before showing it, and check
 * column and option names with fields.ts `usableName`.
 */
export interface DataSourceSchema { name: string; properties: Record<string, SchemaProperty> }

export interface DataSourceRef {
  /** `collection://<uuid>`, as notion-query-data-sources takes it. */
  url: string;
  /** The uuid, lowercase and dashed (the form Notion gives). */
  id: string;
  /** One clean line, at most 200 characters. */
  name: string;
}

const MAX_JSON_TRIES = 64;
const MAX_NAME_CHARS = 200;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A Notion id as the lowercase dashed uuid; anything else → null. */
export function dashedId(s: string): string | null {
  const h = notionId(s);
  return h ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : null;
}

/** `collection://<id>` (with or without Notion's `{{ }}`) → the dashed id; anything else → null. */
function collectionId(url: string): string | null {
  const m = /^(?:\{\{)?collection:\/\/([^{}"]+?)(?:\}\})?$/.exec(url.trim());
  return m ? dashedId(m[1]!) : null;
}

/** Where `tag` first starts a line (the text's start, or right after a newline) at or after `from`; else -1. */
function lineIndexOf(text: string, tag: string, from = 0): number {
  let i = text.indexOf(tag, from);
  while (i > 0 && text[i - 1] !== '\n') i = text.indexOf(tag, i + 1);
  return i;
}

/**
 * The JSON object between `open` and a later `close`, both at the start of a line, trying each `close` in turn (a
 * string inside the JSON may contain the closing tag). `open` must start before `before`. Returns the object and where
 * its closing tag ends, or null.
 */
function jsonBlock(text: string, open: string, close: string, from = 0, before = text.length): { value: Record<string, unknown>; end: number } | null {
  const start = lineIndexOf(text, open, from);
  if (start < 0 || start >= before) return null;
  const body = start + open.length;
  let at = lineIndexOf(text, close, body);
  for (let i = 0; at >= 0 && i < MAX_JSON_TRIES; i++, at = lineIndexOf(text, close, at + close.length)) {
    try {
      const value: unknown = JSON.parse(text.slice(body, at));
      if (isObject(value)) return { value, end: at + close.length };
      return null; // valid JSON, wrong shape: a longer slice won't fix it
    } catch { /* the closing tag was inside a string: try the next one */ }
  }
  return null;
}

// ── Databases and data sources ──────────────────────────────────────────────────────────────────────────────────────

const SOURCES_HEADER = "Here are the Database's Data Sources:";

/**
 * A database fetch's data sources: the `<data-sources>` block after Notion's header line → each
 * `<data-source url="{{collection://…}}">` line, deduplicated. Names from "The title of this Data Source is:", else the
 * state JSON's name. The header is taken at its last occurrence: the database's title and its ancestors come before it
 * and may span lines, while what follows the real block (the views) is one-line JSON.
 */
export function parseDataSources(text: string): DataSourceRef[] {
  const at = text.lastIndexOf(`\n${SOURCES_HEADER}\n`);
  const header = at >= 0 ? at + 1 : text.startsWith(`${SOURCES_HEADER}\n`) ? 0 : -1;
  if (header < 0) return [];
  const start = lineIndexOf(text, '<data-sources>', header);
  if (start < 0) return [];
  const end = lineIndexOf(text, '</data-sources>', start);
  if (end < 0) return [];
  const inner = text.slice(start + '<data-sources>'.length, end);
  const out: DataSourceRef[] = [];
  const opens = [...inner.matchAll(/(?<=^|\n)<data-source url="([^"\n]*)">(?=\n|$)/g)];
  opens.forEach((m, i) => {
    const id = collectionId(m[1]!);
    if (!id || out.some((s) => s.id === id)) return;
    const own = inner.slice(m.index! + m[0].length, opens[i + 1]?.index ?? inner.length);
    const titled = /^\n?The title of this Data Source is:([^\n]*)/.exec(own)?.[1];
    const fromState = titled?.trim() ? undefined : jsonBlock(own, '<data-source-state>', '</data-source-state>')?.value.name;
    out.push({ url: `collection://${id}`, id, name: oneLine(titled?.trim() ? titled : typeof fromState === 'string' ? fromState : '', MAX_NAME_CHARS) });
  });
  return out;
}

function option(v: unknown): SchemaOption | null {
  if (!isObject(v) || typeof v.name !== 'string') return null;
  return typeof v.color === 'string' ? { name: v.name, color: v.color } : { name: v.name };
}
const options = (v: unknown): SchemaOption[] => (Array.isArray(v) ? v.flatMap((o) => option(o) ?? []) : []);

function property(v: unknown): SchemaProperty | null {
  if (!isObject(v) || typeof v.type !== 'string' || !v.type) return null;
  const p: SchemaProperty = { type: v.type };
  if (Array.isArray(v.options)) p.options = options(v.options);
  if (v.type === 'status') {
    const g = isObject(v.groups) ? v.groups : {};
    p.groups = { to_do: options(g.to_do), in_progress: options(g.in_progress), complete: options(g.complete) };
  }
  return p;
}

/** The first `<data-source-state>` JSON as a schema; malformed properties skipped; no usable JSON → null. */
export function parseDataSourceState(text: string): DataSourceSchema | null {
  const state = jsonBlock(text, '<data-source-state>', '</data-source-state>')?.value;
  if (!state || !isObject(state.schema)) return null;
  // fromEntries defines own properties: a column named "__proto__" stays a column, never the object's prototype.
  const properties: Record<string, SchemaProperty> = Object.fromEntries(
    Object.entries(state.schema).flatMap(([name, raw]) => { const p = property(raw); return p ? [[name, p]] : []; }));
  return { name: typeof state.name === 'string' ? state.name : '', properties };
}

// ── Pages ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const PROPERTIES = '<properties>';
const CONTENT = '<content>';

/** The page's `<properties>` JSON (it must open before `<content>`); none → null. */
export function parsePageProperties(text: string): Record<string, unknown> | null {
  return pageProperties(text)?.value ?? null;
}

function pageProperties(text: string): { value: Record<string, unknown>; end: number } | null {
  const content = lineIndexOf(text, CONTENT);
  return jsonBlock(text, PROPERTIES, '</properties>', 0, content < 0 ? text.length : content);
}

/** The page's `<content>` Markdown, verbatim (one newline trimmed at each end); none → ''. */
export function parsePageContent(text: string): string {
  const start = lineIndexOf(text, CONTENT, pageProperties(text)?.end ?? 0);
  if (start < 0) return '';
  const body = start + CONTENT.length;
  const pageEnd = text.lastIndexOf('\n</content>\n</page>');
  const lastClose = text.lastIndexOf('\n</content>');
  const end = pageEnd + 1 >= body ? pageEnd + 1 : lastClose + 1 >= body ? lastClose + 1 : -1;
  if (end < 0) return '';
  return text.slice(body, end).replace(/^\n/, '').replace(/\n$/, '');
}

/** Where a page fetch's `<page url="…">` line starts: the first line, or the second after a one-line preamble. */
function pageLine(text: string): number {
  const PAGE = '<page url="';
  if (text.startsWith(PAGE)) return 0;
  const nl = text.indexOf('\n');
  return nl >= 0 && !text.startsWith('<') && text.startsWith(PAGE, nl + 1) ? nl + 1 : -1;
}

/**
 * The row's data source (32 hex): the first entry of the `<ancestor-path>` right after a page fetch's `<page>` line.
 * Not a page fetch, or a page that isn't a database row → null.
 */
export function parseParentDataSource(text: string): string | null {
  const at = pageLine(text);
  if (at < 0) return null;
  const m = /^<page url="[^"\n]*">\n<ancestor-path>\n<parent-data-source url="([^"\n]*)"/.exec(text.slice(at));
  const id = m ? collectionId(m[1]!) : null;
  return id ? id.replace(/-/g, '') : null;
}

// ── Pasted links (Review Focus 2) ───────────────────────────────────────────────────────────────────────────────────

// The rule lives in src/shared/notion-link.ts: the Settings picker reads a pasted link with the very same one.
export { notionIdFromLink } from '@shared/notion-link';
