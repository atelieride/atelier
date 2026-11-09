// What the Databases view types into a Claude session: rows, a table's DDL and
// relations, a running query. Pure. Rows are exactly what Copy as JSON writes (grid-copy.ts: numbers and JSON as
// Postgres printed them; masked as the grid shows them with Mask values on; the columns shown, in the grid's
// order), as a JSON array, at most ROWS_MAX rows and BYTES_MAX bytes. Nothing is filtered (no
// redactSecrets): what is on screen is what is sent, and the environment in the first line is production's cue.
import type { DbActivity, DbConnection, DbFk, DbRelations } from '@shared/databases';
import type { FormatOpts } from '@shared/pg-format';
import { tdb } from '../i18n/db';
import { cutCount, inGridOrder, jsonArray, jsonObject, type GridSource } from './grid-copy';
import { fmtDuration } from './overview';

export const ROWS_MAX = 100;
export const BYTES_MAX = 200 * 1024;
/** A first row over this (UTF-8 bytes of its JSON) isn't sent at all — Copy instead. */
export const ROW_CEILING = 512 * 1024;

/** A send's rows: the text; none of the rows asked loaded; or a first row over ROW_CEILING (its size). */
export type RowsPrompt = { kind: 'text'; text: string } | { kind: 'none' } | { kind: 'tooLarge'; bytes: number };

type Conn = Pick<DbConnection, 'name' | 'env'>;
type Table = { schema: string; name: string };

const utf8 = (s: string) => new TextEncoder().encode(s).length;
const rowsText = (n: number) => (n === 1 ? '1 row' : `${n.toLocaleString('en-US')} rows`);
const from = (conn: Conn, what: string) => `From ${conn.name} (${tdb.sheet.envs[conn.env]}) · ${what}`;

/** A fenced block, its fence longer than any run of backticks inside (a value may hold one). */
function fence(text: string, lang: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

/**
 * Send to <session> (⌥↩, the action bar, the cell menu): "From <connection> (<env>) · <schema>.<table>, N rows:" and
 * the rows' JSON array, in the grid's order. Over ROWS_MAX rows or BYTES_MAX bytes (UTF-8, of the array), the rows that
 * fit — the first always, a row is the unit, up to ROW_CEILING (over it, `tooLarge`) — and "(first N rows)".
 * Values main cut at 64 KB: one line says how many. None of `sel` loaded: `none`.
 */
export function rowsPrompt(a: { conn: Conn; table: Table; src: GridSource; sel: readonly number[]; o: FormatOpts }): RowsPrompt {
  const order = inGridOrder(a.src, a.sel);
  if (order.length === 0) return { kind: 'none' };
  const objects: string[] = [];
  // "[\n" and "\n]", then each object two spaces in, ",\n" between them.
  let bytes = 4;
  for (const i of order.slice(0, ROWS_MAX)) {
    const obj = jsonObject(a.src, i, a.o);
    const size = utf8(obj);
    if (objects.length === 0 && size > ROW_CEILING) return { kind: 'tooLarge', bytes: size };
    const more = size + 2 + (objects.length > 0 ? 2 : 0);
    if (objects.length > 0 && bytes + more > BYTES_MAX) break;
    objects.push(obj);
    bytes += more;
  }
  const n = objects.length;
  const cut = cutCount(a.src, order.slice(0, n), 'json', a.o);
  const head = from(a.conn, `${a.table.schema}.${a.table.name}, ${rowsText(order.length)}${n < order.length ? ` (first ${rowsText(n)})` : ''}:`);
  const note = cut === 0 ? '' : `\n${cut === 1 ? '1 value was' : `${cut.toLocaleString('en-US')} values were`} cut at 64 KB`;
  return { kind: 'text', text: `${head}\n${fence(jsonArray(objects), 'json')}${note}` };
}

const cols = (c: readonly string[]) => c.join(', ');
const fkLine = (f: DbFk) => {
  const src = `${f.from.schema}.${f.from.table} (${cols(f.from.columns)})`;
  return `- ${src} → ${f.to.schema}.${f.to.table} (${cols(f.to.columns)})${f.indexed ? '' : `, no index on ${src}`}`;
};

function relationsText(rel: DbRelations): string {
  if (rel.out.length + rel.in.length === 0) return 'No foreign keys point to or from it.';
  return [
    ...(rel.out.length ? ['References:', ...rel.out.map(fkLine)] : []),
    ...(rel.in.length ? ['Referenced by:', ...rel.in.map(fkLine)] : [])
  ].join('\n');
}

/**
 * Send Schema to <session>: the DDL as Postgres gives it, then the foreign keys both ways (one line each, an unindexed
 * one said so). `rel` null (its read failed): the DDL alone.
 */
export function schemaPrompt(a: { conn: Conn; table: Table; ddl: string; rel: DbRelations | null }): string {
  const head = from(a.conn, `${a.table.schema}.${a.table.name}, its DDL${a.rel ? ' and relations' : ''}:`);
  return `${head}\n${fence(a.ddl.trimEnd(), 'sql')}${a.rel ? `\n${relationsText(a.rel)}` : ''}`;
}

/**
 * A new session about a table: Ask About This Table — what Send Schema sends: the DDL, its relations —, or Ask in New
 * Session on rows — the rows as Send gives them (`rows`, rowsPrompt's text), then the table's DDL (null when its read
 * failed). One of the two shapes: no rows and no DDL is no prompt.
 */
export function askTablePrompt(a: { conn: Conn; table: Table } & (
  | { ddl: string; rel: DbRelations | null; rows?: undefined }
  | { ddl: string | null; rows: string; rel?: undefined }
)): string {
  if (a.rows === undefined) return schemaPrompt(a);
  return a.ddl === null ? a.rows : `${a.rows}\n\nThe DDL of ${a.table.schema}.${a.table.name}:\n${fence(a.ddl.trimEnd(), 'sql')}`;
}

/** Overview's ✦ Ask Claude: the query as shown (masked with Mask values on), how long it has run, who runs it. */
export function askQueryPrompt(a: { conn: Conn; activity: DbActivity; query: string }): string {
  const x = a.activity;
  const who = [`pid ${x.pid}`, ...(x.role ? [`role ${x.role}`] : []), ...(x.app ? [`application ${x.app}`] : [])].join(', ');
  const head = from(a.conn, `a query ${x.state ?? 'running'} for ${fmtDuration(x.seconds ?? 0)} (${who}):`);
  return `${head}\n${fence(a.query, 'sql')}\nWhy is this query taking so long, and what would make it faster?`;
}
