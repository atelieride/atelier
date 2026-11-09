// ClickUp's read-only tool allowlist: the five tools Atelier may call, each with a
// strict argument schema (only what Atelier sends) and a lenient reply schema (unknown fields dropped, only core fields
// required, a malformed optional field dropped). READ-ONLY: the token ClickUp issues can write (it ignores
// scope=read), so this list is the barrier together with the client's `tools.isAllowed` check
// (mcp/client.ts); tests/integration/connectors-readonly.test.ts keeps every other ClickUp tool name out of src/.
import { z } from 'zod';
import { defineToolSet, frozenSet } from '../mcp/toolset';

// ── Reply helpers ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A non-core field: missing or malformed → undefined (never fails the reply). */
const opt = <T extends z.ZodType>(s: T) => s.optional().catch(undefined);
/**
 * ClickUp ids: plain [A-Za-z0-9_-]{1,64} (task ids are alphanumeric, user/list/workspace ids digits), strings or
 * numbers in, strings out. Ids reach the renderer, session names and the prompt: no control, bidi or invisible
 * character, no space or separator gets through one.
 */
export const CLICKUP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const id = z.union([z.string(), z.number().int().nonnegative()]).transform(String).pipe(z.string().regex(CLICKUP_ID));
const dateLike = z.union([z.string(), z.number()]).nullable();
const keepValid = <T extends z.ZodType>(item: T, items: unknown[]): z.output<T>[] =>
  items.flatMap((i) => { const r = item.safeParse(i); return r.success ? [r.data as z.output<T>] : []; });
/** An array whose malformed items are skipped instead of failing the whole reply. */
const lenientArray = <T extends z.ZodType>(item: T) => z.array(z.unknown()).transform((items) => keepValid(item, items));
/**
 * Like lenientArray, for a list whose shape is confirmed: one malformed item is skipped (a task with a bad id), but a
 * non-empty list with no valid item at all means the shape changed → the reply fails (SchemaChanged).
 */
const confirmedList = <T extends z.ZodType>(item: T) => z.array(z.unknown()).transform((items, ctx) => {
  const ok = keepValid(item, items);
  if (items.length > 0 && ok.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'no item has the expected shape' });
    return z.NEVER;
  }
  return ok;
});

const assignee = z.object({ id, username: opt(z.string().nullable()), email: opt(z.string().nullable()) });

const statusObject = z.object({ status: z.string(), color: opt(z.string()), type: opt(z.string()) });
// Since October 2026 ClickUp's replies are compact: `status` is the name and its color is `status_color` on the task.
const status = z.union([statusObject, z.string().transform((name): z.output<typeof statusObject> => ({ status: name }))]);

/** A compact task's string status with its status_color becomes the object shape, color included. */
const withStatusColor = <T extends z.ZodType>(s: T) => z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const t = raw as { status?: unknown; status_color?: unknown };
  return typeof t.status === 'string' && typeof t.status_color === 'string' ? { ...t, status: { status: t.status, color: t.status_color } } : raw;
}, s);

const taskFields = z.object({
  id,
  name: z.string(),
  custom_id: opt(z.string().nullable()),
  status: opt(status),
  url: opt(z.string()),
  priority: opt(z.object({ priority: z.string(), color: opt(z.string()) }).nullable()),
  assignees: opt(lenientArray(assignee)),
  due_date: opt(dateLike),
  date_updated: opt(dateLike),
  date_closed: opt(dateLike),
  list: opt(z.object({ id: opt(id), name: z.string() })),
  // Seen on filter_tasks and get_task (2026-10-19): [{name, tag_fg, tag_bg, …}]; automations' "Tag" condition.
  tags: opt(lenientArray(z.object({ name: z.string() })))
});
const task = withStatusColor(taskFields);

const count = opt(z.number().int().nonnegative());
const taskDetail = withStatusColor(taskFields.extend({
  markdown_description: opt(z.string().nullable()),
  text_content: opt(z.string().nullable()),
  parent: opt(id.nullable()),
  counts: opt(z.object({ subtasks: count, checklists: count, attachments: count, comments: count })),
  // Seen 2026-10-19: {id: <number>, username}; only get_task has it (automations' "Created by").
  creator: opt(z.object({ id, username: opt(z.string().nullable()) }))
}));

const isTaskResult = (i: unknown): boolean =>
  typeof i === 'object' && i !== null && !Array.isArray(i) && ((i as { type?: unknown }).type ?? 'task') === 'task';
const searchResult = withStatusColor(taskFields.extend({ type: opt(z.string()) }));

export interface HierarchyNode { id: string; name: string; type?: string; children?: HierarchyNode[] }
const node: z.ZodType<HierarchyNode> = z.lazy(() => z.object({ id, name: z.string(), type: opt(z.string()), children: opt(lenientArray(node)) }));

// ── Arguments (strict: only what Atelier sends) ─────────────────────────────────────────────────────────────────────

const ARGS = {
  clickup_resolve_assignees: z.strictObject({ assignees: z.array(z.string().min(1).max(200)).min(1).max(20) }),
  clickup_filter_tasks: z.strictObject({
    assignees: z.array(z.string().min(1).max(64)).max(20).optional(),
    include_closed: z.boolean().optional(),
    list_ids: z.array(z.string().min(1).max(64)).max(100).optional(),
    order_by: z.enum(['updated', 'created', 'due_date']).optional(),
    page: z.number().int().min(0).max(1000).optional()
  }),
  clickup_get_task: z.strictObject({ task_id: z.string().min(1).max(64) }),
  clickup_get_workspace_hierarchy: z.strictObject({ max_depth: z.enum(['0', '1', '2']).optional() }),
  clickup_search: z.strictObject({ keywords: z.string().min(1).max(500) }),
  clickup_get_list: z.strictObject({ list_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })
};

// ── Replies ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const REPLIES = {
  // Confirmed 2026-10-11: {"userIds":["<digits>"]}.
  clickup_resolve_assignees: z.object({ userIds: z.array(id) }),
  // Confirmed fields (observed): {tasks, count, page, has_more, next_page}.
  clickup_filter_tasks: z.object({
    tasks: confirmedList(task), count: opt(z.number()), page: opt(z.number()), has_more: opt(z.boolean()), next_page: opt(z.number().nullable())
  }),
  // Seen in real replies (markdown_description, text_content, parent, counts); inner shapes assumed.
  clickup_get_task: taskDetail,
  // Confirmed 2026-10-11: {hierarchy:{root:{id,name,children}}, next_cursor, has_more, total_spaces}.
  clickup_get_workspace_hierarchy: z.object({
    hierarchy: z.object({ root: z.object({ id, name: z.string(), children: opt(lenientArray(node)) }) }),
    next_cursor: opt(z.string().nullable()), has_more: opt(z.boolean()), total_spaces: opt(z.number())
  }),
  // Assumed (not re-checked): {results:[{type:"task", …task}], count}. Every result that isn't a well-formed task is
  // skipped, never fatal: an unconfirmed item shape must not make the whole connector `unavailable`. Only a reply
  // without a `results` array is SchemaChanged.
  clickup_search: z.object({
    results: z.array(z.unknown())
      .transform((items) => keepValid(searchResult, items.filter((i) => isTaskResult(i)))),
    count: opt(z.number())
  }),
  // Seen 2026-10-19: {id, name, content, space, url, statuses:[{id, status, color, orderindex, type}]}; a color may be
  // a CSS variable ("var(--cu-status-open)"). Only the statuses matter: their names and colors.
  clickup_get_list: z.object({
    id, name: z.string(),
    statuses: opt(lenientArray(z.object({ status: z.string(), color: opt(z.string()), type: opt(z.string()) })))
  })
};

export const CLICKUP_TOOLS = defineToolSet({
  clickup_resolve_assignees: { args: ARGS.clickup_resolve_assignees, reply: REPLIES.clickup_resolve_assignees },
  clickup_filter_tasks: { args: ARGS.clickup_filter_tasks, reply: REPLIES.clickup_filter_tasks },
  clickup_get_task: { args: ARGS.clickup_get_task, reply: REPLIES.clickup_get_task },
  clickup_get_workspace_hierarchy: { args: ARGS.clickup_get_workspace_hierarchy, reply: REPLIES.clickup_get_workspace_hierarchy },
  clickup_search: { args: ARGS.clickup_search, reply: REPLIES.clickup_search },
  // Optional: only the statuses' colors depend on it (compact replies carry the name alone).
  clickup_get_list: { args: ARGS.clickup_get_list, reply: REPLIES.clickup_get_list, optional: true }
});

export type ClickUpTool = (typeof CLICKUP_TOOLS)['names'][number];
export type ClickUpTask = z.output<typeof task>;
export type ClickUpTaskDetail = z.output<typeof taskDetail>;

/** The read-only allowlist, for display and tests. A copy: changing it (if one ever could) changes no check. */
export const ALLOWED_TOOLS: ReadonlySet<string> = frozenSet<string>(CLICKUP_TOOLS.names);
