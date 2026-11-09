// Jira's read-only tool allowlist: the six Rovo MCP v2 tools Atelier may call, each with a
// strict argument schema (only what Atelier sends) and a lenient reply schema. READ-ONLY: Atlassian grants every scope
// the user can consent to, writes included (no scope can be asked), so this list is the barrier together with
// the client's `tools.isAllowed` check (mcp/client.ts); tests/integration/connectors-readonly.test.ts keeps every other
// Atlassian tool name — the discover/execute family above all — out of src/.
//
// Replies (as observed): everything under `data`; issue lists as `data.issues[]` with
// `nextPageToken`/`isLast` on Atelier's `?tools=all`, but `issues.nodes[]` + `pageInfo` (no `data`) as Claude Code's
// client saw them, so both are read. Unknown fields are dropped — user e-mails and avatar URLs never get past these
// schemas — malformed items are skipped, and a non-empty list with no valid item means the shape changed.
import { z } from 'zod';
import { defineToolSet, frozenSet } from '../mcp/toolset';

// ── Ids ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A site's cloud id (a uuid). */
export const CLOUD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A Jira Cloud site: `https://<label>.atlassian.net`, nothing after the host. */
export const SITE_URL = /^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/;
/** Numeric ids: issues, projects, filters. */
export const NUMERIC_ID = /^[1-9][0-9]{0,17}$/;
export const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,19}$/;
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,8}$/;
/** Atlassian account ids ("712020:uuid", "qm:…", legacy hex). */
export const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;

const opt = <T extends z.ZodType>(s: T) => s.optional().catch(undefined);
const keepValid = <T extends z.ZodType>(item: T, items: unknown[]): z.output<T>[] =>
  items.flatMap((i) => { const r = item.safeParse(i); return r.success ? [r.data as z.output<T>] : []; });
const lenientArray = <T extends z.ZodType>(item: T) => z.array(z.unknown()).transform((items) => keepValid(item, items));
const confirmedList = <T extends z.ZodType>(item: T) => z.array(z.unknown()).transform((items, ctx) => {
  const ok = keepValid(item, items);
  if (items.length > 0 && ok.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'no item has the expected shape' });
    return z.NEVER;
  }
  return ok;
});
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** `{data: X}` → X; anything else as is. */
const inData = <T extends z.ZodType>(s: T) => z.preprocess((v) => (isObj(v) && isObj(v.data) ? v.data : v), s);

const numericId = z.union([z.string(), z.number().int().positive()]).transform(String).pipe(z.string().regex(NUMERIC_ID));
const accountId = z.string().regex(ACCOUNT_ID);
const user = z.object({ accountId, displayName: opt(z.string()), accountType: opt(z.string()) });

// ── Issues ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const statusCategory = z.object({ key: z.string(), name: opt(z.string()) });
const issueFields = z.object({
  summary: z.string(),
  status: opt(z.object({ name: z.string(), statusCategory: opt(statusCategory) })),
  project: z.object({ id: numericId, key: z.string().regex(PROJECT_KEY), name: z.string(), projectTypeKey: opt(z.string()) }),
  issuetype: opt(z.object({ name: z.string(), subtask: opt(z.boolean()) })),
  assignee: opt(user.nullable()),
  creator: opt(user.nullable()),
  duedate: opt(z.string().nullable()),
  priority: opt(z.object({ name: z.string() }).nullable()),
  labels: opt(lenientArray(z.string())),
  updated: opt(z.string()),
  created: opt(z.string()),
  description: opt(z.string().nullable())
});
const issue = z.object({ id: numericId, key: z.string().regex(ISSUE_KEY), fields: issueFields });
export type JiraIssue = z.output<typeof issue>;

/** Both envelopes of a JQL search, as one shape: the issues and the next page's token (none: the last page). */
const searchReply = z.preprocess((v) => {
  const d = isObj(v) && isObj(v.data) ? v.data : v;
  if (!isObj(d)) return d;
  // Claude Code's shape: {issues: {nodes, pageInfo: {hasNextPage, endCursor}}}.
  if (isObj(d.issues) && Array.isArray(d.issues.nodes)) {
    const page = isObj(d.issues.pageInfo) ? d.issues.pageInfo : {};
    return { issues: d.issues.nodes, next: page.hasNextPage === true && typeof page.endCursor === 'string' ? page.endCursor : undefined, format: d.appliedContentFormat };
  }
  return { issues: d.issues, next: d.isLast === false && typeof d.nextPageToken === 'string' ? d.nextPageToken : undefined, format: d.appliedContentFormat };
}, z.object({ issues: confirmedList(issue), next: opt(z.string().max(4096)), format: opt(z.string()) }));

/** One issue: `{data: {appliedContentFormat, id, key, fields}}`, or one node of the other envelope. */
const issueReply = z.preprocess((v) => {
  const d = isObj(v) && isObj(v.data) ? v.data : v;
  if (isObj(d) && isObj(d.issues) && Array.isArray(d.issues.nodes)) return d.issues.nodes[0];
  return d;
}, issue.extend({ appliedContentFormat: opt(z.string()) }));

// ── Arguments (strict: only what Atelier sends) ─────────────────────────────────────────────────────────────────────

/** The saved site: its uuid, or (API-token connections the account listing didn't name) its URL. */
const cloudId = z.string().refine((s) => CLOUD_ID.test(s) || SITE_URL.test(s));

/** The fields a list or search asks for; a detail adds the description. */
export const LIST_FIELDS = ['summary', 'status', 'project', 'issuetype', 'assignee', 'duedate', 'priority', 'labels', 'creator', 'updated'] as const;
export const DETAIL_FIELDS = [...LIST_FIELDS, 'description'] as const;
const field = z.enum(DETAIL_FIELDS);
/**
 * Issue reads always ask for the "full" view: since 2026-10-20 the default, "compact", ignores `fields`
 * and drops the project, the creator, the due date and every account id, so nothing could be checked or shown.
 */
const FULL = z.literal('full');

const ARGS = {
  getAccessibleAtlassianResources: z.strictObject({}),
  getJiraCurrentUser: z.strictObject({ cloudId }),
  listJiraProjects: z.strictObject({
    cloudId, query: z.string().min(1).max(100).optional(), maxResults: z.number().int().min(1).max(50).optional(),
    startAt: z.number().int().min(0).max(1000).optional()
  }),
  listJiraFilters: z.strictObject({
    cloudId, filterName: z.string().min(1).max(255).optional(), id: z.array(z.string().regex(NUMERIC_ID)).min(1).max(20).optional(),
    maxResults: z.number().int().min(1).max(50).optional()
  }),
  // The JQL is built by jql.ts only; the schema still holds it to the bounded shape the builder makes.
  searchJiraIssuesUsingJql: z.strictObject({
    cloudId, jql: z.string().min(1).max(4000).refine((q) => q.startsWith('project in (')),
    fields: z.array(field).min(1).max(DETAIL_FIELDS.length), maxResults: z.number().int().min(1).max(100),
    nextPageToken: z.string().min(1).max(4096).optional(), responseContentFormat: z.literal('markdown').optional(), view: FULL
  }),
  getJiraIssue: z.strictObject({
    cloudId, issueIdOrKey: z.string().refine((s) => NUMERIC_ID.test(s) || ISSUE_KEY.test(s)),
    fields: z.array(field).min(1).max(DETAIL_FIELDS.length), fieldsByKeys: z.literal(true), responseContentFormat: z.literal('markdown'), view: FULL
  })
};

// ── Replies ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const REPLIES = {
  // Seen 2026-10-19: {data:{resources:[{cloudId, url, products:[{id, access}]}]}} (no site name).
  getAccessibleAtlassianResources: inData(z.object({
    resources: confirmedList(z.object({ cloudId: z.string().regex(CLOUD_ID), url: z.string(), products: opt(lenientArray(z.object({ id: z.string() }))) }))
  })),
  // Seen 2026-10-19: {data:{accountId, displayName, emailAddress, …}} — the e-mail is dropped here.
  getJiraCurrentUser: inData(z.object({ accountId, displayName: opt(z.string()) })),
  // Seen 2026-10-19: {data:{values:[{id, key, name, projectTypeKey, style}], isLast, total, startAt, maxResults}}.
  listJiraProjects: inData(z.object({
    values: confirmedList(z.object({ id: numericId, key: z.string().regex(PROJECT_KEY), name: z.string(), projectTypeKey: opt(z.string()) })),
    isLast: opt(z.boolean()), total: opt(z.number())
  })),
  // Seen 2026-10-19 (empty): {data:{startAt, maxResults, total, isLast, values}}.
  listJiraFilters: inData(z.object({ values: confirmedList(z.object({ id: numericId, name: z.string() })), isLast: opt(z.boolean()) })),
  searchJiraIssuesUsingJql: searchReply,
  getJiraIssue: issueReply
};

export const JIRA_TOOLS = defineToolSet({
  getAccessibleAtlassianResources: { args: ARGS.getAccessibleAtlassianResources, reply: REPLIES.getAccessibleAtlassianResources },
  getJiraCurrentUser: { args: ARGS.getJiraCurrentUser, reply: REPLIES.getJiraCurrentUser },
  listJiraProjects: { args: ARGS.listJiraProjects, reply: REPLIES.listJiraProjects },
  // Optional: only the saved-filter picker needs it (the row says the filters can't be listed).
  listJiraFilters: { args: ARGS.listJiraFilters, reply: REPLIES.listJiraFilters, optional: true },
  searchJiraIssuesUsingJql: { args: ARGS.searchJiraIssuesUsingJql, reply: REPLIES.searchJiraIssuesUsingJql },
  getJiraIssue: { args: ARGS.getJiraIssue, reply: REPLIES.getJiraIssue }
});

export type JiraTool = (typeof JIRA_TOOLS)['names'][number];

/** The read-only allowlist, for display and tests. A copy: changing it (if one ever could) changes no check. */
export const ALLOWED_TOOLS: ReadonlySet<string> = frozenSet<string>(JIRA_TOOLS.names);
