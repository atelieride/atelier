// Notion's rows and pages → the source-neutral TaskSummary / TaskDetail the renderer sees
// (src/shared/tasks.ts). Everything here is untrusted text, treated like ClickUp's (clickup/map.ts): titles and names are
// one clean line, bodies are cleaned and capped at 32 KB (a page's Markdown stays verbatim otherwise: the prompt
// builder fences it as data), status colors pass only as one of our state hexes, and a task link is Notion's own
// https page on app.notion.com / www.notion.so / notion.so (query and hash dropped) or one built from the id.
import { cleanText } from '@shared/clean-text';
import { MAX_TASK_BODY_BYTES, type NotionFields, type SourceError, type TaskDetail, type TaskSummary, type TaskTone } from '@shared/tasks';
import { capUtf8, oneLine } from '../text';
import { STATUS_GROUPS, notionIdFromLink, parsePageContent, parsePageProperties, type DataSourceSchema } from './markup';

/** A chosen database as saved in notion.bin. */
export interface DatabaseConfig {
  /** The database, 32 hex. */
  id: string;
  /** Its data source, 32 hex (dashless; `collection://<dashed>` in queries): also SourceInfo.id and the IPC sourceId. */
  source: string;
  name: string;
  path?: string;
  fields: NotionFields;
  /** The ID column's prefix ("ENG"), learned from the first fetched row (rows give the bare number). */
  idPrefix?: string;
  error?: SourceError;
}

/**
 * Notion's color names as the `#rrggbb` a TaskStatus carries: exactly the state tokens of theme.css, so the
 * renderer's nearest-tone match (task-view.ts statusTone) lands on the intended tone. Gray, brown, default and
 * unknown colors have none (idle).
 */
export const NOTION_COLOR_TONE = Object.freeze({
  blue: '#60A5FA', green: '#34D399', yellow: '#FBBF24', orange: '#FBBF24', red: '#FB7185', purple: '#8B5CF6', pink: '#8B5CF6'
} as const);

const COLOR_STATE: Readonly<Record<string, TaskTone>> = Object.freeze({
  blue: 'working', green: 'done', yellow: 'waiting', orange: 'waiting', red: 'error', purple: 'violet', pink: 'violet'
});

/** A Notion color name → the state tone the fields editor shows (never a raw color); anything else → idle. */
export function toneOf(color: string | undefined): TaskTone {
  return color !== undefined && Object.hasOwn(COLOR_STATE, color) ? COLOR_STATE[color]! : 'idle';
}

function colorHex(color: string | undefined): string | undefined {
  return color !== undefined && Object.hasOwn(NOTION_COLOR_TONE, color) ? NOTION_COLOR_TONE[color as keyof typeof NOTION_COLOR_TONE] : undefined;
}

const UNTITLED = 'Untitled';
const TASK_HOSTS = new Set(['app.notion.com', 'www.notion.so', 'notion.so']);

/** The task's page on Notion's web app, built from its id. */
export function notionTaskUrl(id: string): string {
  return `https://www.notion.so/${encodeURIComponent(id)}`;
}

/** Notion's own link for this task (https, Notion's hosts, the same id), without query or hash; else one from the id. */
function taskUrl(raw: string | undefined, id: string): string {
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:' && TASK_HOSTS.has(u.hostname) && u.port === '' && u.username === '' && u.password === ''
        && notionIdFromLink(raw) === id) return `${u.origin}${u.pathname}`;
    } catch { /* fall through */ }
  }
  return notionTaskUrl(id);
}

const cell = (row: Record<string, unknown>, key: string): unknown => (Object.hasOwn(row, key) ? row[key] : undefined);
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** "ENG-2" → "ENG" (the unique ID column's prefix); anything else → null. */
export function idPrefixFrom(value: string): string | null {
  return /^([A-Za-z][A-Za-z0-9]{0,15})-\d{1,12}$/.exec(value.trim())?.[1] ?? null;
}

/** The ID cell: rows give the bare number ("2"), a page fetch the prefixed value ("ENG-2"). */
function displayIdOf(v: unknown, prefix: string | undefined): string {
  const raw = typeof v === 'number' && Number.isInteger(v) && v >= 0 ? String(v) : text(v)?.trim() ?? '';
  if (/^\d{1,12}$/.test(raw)) {
    const p = prefix !== undefined ? idPrefixFrom(`${prefix}-0`) : null;
    return p ? `${p}-${raw}` : `#${raw}`;
  }
  return oneLine(raw, 64).trim();
}

/** `date:<col>:start`: a date at local midnight (what the palette's day labels expect), a date-time as given. */
function dueOf(v: unknown): number | undefined {
  const s = text(v)?.trim();
  if (!s) return undefined;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    const at = new Date(y, m - 1, day);
    return at.getFullYear() === y && at.getMonth() === m - 1 && at.getDate() === day ? at.getTime() : undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Automations' editor: the status column's options a watch read can return, with
 * their state hex — a `status` column's groups but Complete, a `select`'s options but the saved closed ones. None
 * without a status column the schema still has. Names as one clean line, at most 100 characters.
 */
export function openStatuses(schema: DataSourceSchema, fields: NotionFields): { name: string; color?: string }[] {
  const st = fields.status;
  if (!st || !Object.hasOwn(schema.properties, st.prop)) return [];
  const p = schema.properties[st.prop]!;
  const options = p.type === 'status' ? STATUS_GROUPS.filter((g) => g !== 'complete').flatMap((g) => p.groups?.[g] ?? [])
    : p.type === 'select' ? (p.options ?? []).filter((o) => !st.closed.includes(o.name)) : [];
  return options.flatMap((o) => {
    // As the chips compare names: one clean line, the model's 100 characters.
    const name = oneLine(o.name, 100);
    const color = colorHex(o.color);
    return name ? [{ name, ...(color ? { color } : {}) }] : [];
  });
}

/** The color of the status option named `value` (its select options, or every status group), as a state hex. */
function statusColor(schema: DataSourceSchema | null, prop: string, value: string): string | undefined {
  if (!schema || !Object.hasOwn(schema.properties, prop)) return undefined;
  const p = schema.properties[prop]!;
  const all = [...(p.options ?? []), ...STATUS_GROUPS.flatMap((g) => p.groups?.[g] ?? [])];
  return colorHex(all.find((o) => o.name === value)?.color);
}

/**
 * One row of a rows-mode query (or a page's properties) → a TaskSummary. The id is the 32 hex of the row's `url`;
 * no id → null (the row is skipped). `schema` gives the status colors (rows don't carry them).
 */
export function rowToSummary(row: Record<string, unknown>, db: DatabaseConfig, schema: DataSourceSchema | null): TaskSummary | null {
  const url = text(cell(row, 'url'));
  const id = url ? notionIdFromLink(url) : null;
  if (!id) return null;
  const f = db.fields;
  let status: TaskSummary['status'] = { name: '' };
  if (f.status) {
    const raw = text(cell(row, f.status.prop)) ?? '';
    const color = statusColor(schema, f.status.prop, raw);
    status = color ? { name: oneLine(raw, 100), color } : { name: oneLine(raw, 100) };
  }
  const out: TaskSummary = {
    id,
    displayId: f.id !== undefined ? displayIdOf(cell(row, f.id), db.idPrefix) : '',
    title: oneLine(text(cell(row, f.title))) || UNTITLED,
    status,
    url: taskUrl(url, id)
  };
  const due = f.due !== undefined ? dueOf(cell(row, `date:${f.due}:start`)) : undefined;
  if (due !== undefined) out.due = due;
  const listName = oneLine(db.name, 200);
  if (listName) out.listName = listName;
  return out;
}

/** A notion-fetch reply (as tools.ts parses it). */
export interface FetchReply { title?: string; url?: string; text: string }

/**
 * A fetched row page → TaskDetail: its <properties> mapped like a row (the ID comes prefixed: "ENG-2"), its <content>
 * as the body. The parent check (the page must belong to a chosen data source) is the connector's, before this.
 * The id and link come from the reply's own `url`, never from <properties> (its "url" key could be a column's);
 * no id there → null.
 */
export function pageToDetail(reply: FetchReply, db: DatabaseConfig, schema: DataSourceSchema | null): TaskDetail | null {
  const props = parsePageProperties(reply.text) ?? {};
  if (!reply.url || notionIdFromLink(reply.url) === null) return null;
  const summary = rowToSummary({ ...props, url: reply.url }, db, schema)!;
  if (!oneLine(text(cell(props, db.fields.title)))) summary.title = oneLine(reply.title) || UNTITLED;
  return { ...summary, body: capUtf8(cleanText(parsePageContent(reply.text)), MAX_TASK_BODY_BYTES) };
}
