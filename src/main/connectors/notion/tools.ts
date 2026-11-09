// Notion's read-only tool allowlist: the four tools Atelier may call, each with a strict
// argument schema (only the shapes Atelier sends) and a
// lenient reply schema (unknown fields dropped, core fields required, malformed items skipped). READ-ONLY: Notion's
// token can write, so this list is the barrier together with the client's `tools.isAllowed` check (mcp/client.ts);
// tests/integration/connectors-readonly.test.ts keeps every other `notion-<verb>` name out of src/. SQL and view modes
// of notion-query-data-sources are not representable here: only `mode: 'rows'` with a closed set of filter shapes.
// Limits: a column or option name over 100/200 characters (propertyName, exact) is InvalidArguments; the connector
// (notion.ts) turns that into the database's `unreadable` state, never a connector-wide failure.
import { z } from 'zod';
import { NOTION_ID } from '@shared/notion-link';
import { defineToolSet, frozenSet } from '../mcp/toolset';

// ── Ids ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

// The id rule is shared with the Settings picker (src/shared/notion-link.ts).
export { NOTION_ID, notionId } from '@shared/notion-link';
const COLLECTION_URL = /^collection:\/\/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

// ── Reply helpers ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A non-core field: missing or malformed → undefined (never fails the reply). */
const opt = <T extends z.ZodType>(s: T) => s.optional().catch(undefined);
const keepValid = <T extends z.ZodType>(item: T, items: unknown[]): z.output<T>[] =>
  items.flatMap((i) => { const r = item.safeParse(i); return r.success ? [r.data as z.output<T>] : []; });
/** Lenient, but a non-empty list with no valid item at all means the shape changed → the reply fails (SchemaChanged). */
const confirmedList = <T extends z.ZodType>(item: T) => z.array(z.unknown()).transform((items, ctx) => {
  const ok = keepValid(item, items);
  if (items.length > 0 && ok.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'no item has the expected shape' });
    return z.NEVER;
  }
  return ok;
});

// ── Arguments (strict: only what Atelier sends) ─────────────────────────────────────────────────────────────────────

/** A column name as Notion gives it: one to 100 characters, no control character. */
const propertyName = z.string().min(1).max(100).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/);
const exact = z.strictObject({ type: z.literal('exact'), value: z.string().min(1).max(200) });

const filterItem = z.union([
  z.strictObject({ type: z.literal('property'), property: propertyName, propertyType: z.literal('person'), operator: z.literal('person_contains'),
    value: z.strictObject({ type: z.literal('relative'), value: z.literal('me') }) }),
  z.strictObject({ type: z.literal('property'), property: propertyName, propertyType: z.literal('status'), operator: z.literal('status_is_not'),
    value: z.strictObject({ type: z.literal('is_group'), value: z.literal('complete') }) }),
  z.strictObject({ type: z.literal('property'), property: propertyName, propertyType: z.literal('select'), operator: z.literal('enum_is_not'), value: exact }),
  z.strictObject({ type: z.literal('property'), property: propertyName, propertyType: z.literal('title'), operator: z.literal('string_contains'), value: exact })
]);

const ARGS = {
  'notion-get-self': z.strictObject({}),
  'notion-search': z.strictObject({
    query: z.string().min(1).max(200),
    page_size: z.number().int().min(1).max(25).optional(),
    max_highlight_length: z.literal(0).optional()
  }),
  // Only an id or collection://<id>: Atelier extracts the id from a pasted link itself, a URL is never forwarded.
  'notion-fetch': z.strictObject({ id: z.string().max(80).refine((s) => NOTION_ID.test(s) || COLLECTION_URL.test(s)) }),
  'notion-query-data-sources': z.strictObject({
    data: z.strictObject({
      mode: z.literal('rows'),
      data_source_url: z.string().max(80).regex(COLLECTION_URL),
      filter: z.strictObject({ type: z.literal('group'), operator: z.literal('and'), filters: z.array(filterItem).min(1).max(12) }).optional(),
      sort: z.array(z.strictObject({ property: propertyName, direction: z.literal('ascending') })).max(1).optional(),
      limit: z.number().int().min(1).max(100).optional()
    })
  })
};

// ── Replies ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const searchResult = z.object({ id: z.string().min(1), title: z.string(), url: opt(z.string()), type: z.string(), path: opt(z.string()) });
const row = z.record(z.string(), z.unknown()).refine((r) => typeof r.url === 'string');

const REPLIES = {
  // Spike: {"workspace":{"id","name"},"user":{"type":"person","id","name","email"}}.
  'notion-get-self': z.object({
    workspace: z.object({ id: z.string().min(1), name: z.string() }),
    user: z.object({ id: z.string().min(1), name: opt(z.string()), type: opt(z.string()) })
  }),
  // Spike: {"results":[{id,title,url,type,highlight,timestamp,path,…}],"type":"workspace_search"}.
  'notion-search': z.object({ results: confirmedList(searchResult) }),
  // Spike: {metadata:{type},title,url,text,…}; `text` is the enhanced markdown (parsed in the connector).
  'notion-fetch': z.object({ metadata: z.object({ type: z.string() }), title: opt(z.string()), url: opt(z.string()), text: z.string() }),
  // Spike: {"results":[{<column>: value, …, "url"}],"has_more":bool}; no cursor in rows mode.
  'notion-query-data-sources': z.object({ results: confirmedList(row), has_more: opt(z.boolean()) })
};

export const NOTION_TOOLS = defineToolSet({
  'notion-get-self': { args: ARGS['notion-get-self'], reply: REPLIES['notion-get-self'] },
  'notion-search': { args: ARGS['notion-search'], reply: REPLIES['notion-search'] },
  'notion-fetch': { args: ARGS['notion-fetch'], reply: REPLIES['notion-fetch'] },
  'notion-query-data-sources': { args: ARGS['notion-query-data-sources'], reply: REPLIES['notion-query-data-sources'] }
});

export type NotionTool = (typeof NOTION_TOOLS)['names'][number];
export type NotionSearchResult = z.output<typeof searchResult>;
export type NotionRow = Record<string, unknown> & { url: string };

/** The read-only allowlist, for display and tests. A copy: changing it (if one ever could) changes no check. */
export const ALLOWED_TOOLS: ReadonlySet<string> = frozenSet<string>(NOTION_TOOLS.names);
