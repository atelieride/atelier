// The ClickUp connector: what is ClickUp's in the
// generic status machine (../task-connector.ts, which owns sign-in, statuses, cache, timers and refresh rules).
//
// - Who: the account is resolve_assignees "me" (ids only; the name comes from that id among the fetched tasks'
//   assignees); the workspace is the hierarchy root, named after its spaces when ClickUp calls it "Workspace".
// - Tasks: filter_tasks assigned to the user, updated first, up to 3 pages; get_task for a detail; clickup_search.
// - No access: ClickUp also says it in tool errors ("403 Forbidden: Team not authorized…"); a gone workspace → re-read
//   the hierarchy; another root → use it; none → `unavailable`.
// - The saved connection (ATELIER_HOME/connectors/clickup.bin) is v1 as before the connectors core: ClickUp issues no
//   refresh token, so it never gains the refresh fields, and the base's token refresh never runs for it.
import { z } from 'zod';
import type { WatchedTask, WatchResult } from '@shared/automations';
import type { TaskDetail, TaskSummary } from '@shared/tasks';
import { SchemaChanged, ToolError } from '../errors';
import type { McpClient } from '../mcp/client';
import type { OAuthTokens } from '../oauth/oauth';
import { SAVED_TOKEN_FIELDS, TaskConnector, message, type Failure, type TaskConnectorDeps } from '../task-connector';
import { clickupTaskUrl, hexColor, oneLine, toTaskDetail, toTaskSummary, toWatchedTask } from './map';
import { CLICKUP_ID, CLICKUP_TOOLS, type ClickUpTask, type HierarchyNode } from './tools';

export { BACKOFF_MS, CONNECT_TIMEOUT_MS, OP_DEADLINE_MS, POLL_MS, STALE_MS } from '../task-connector';

const MAX_PAGES = 3;
/** Compact replies: a list's status colors are read again after this long. */
export const LIST_COLORS_TTL_MS = 30 * 60_000;
/** …for at most this many lists per refresh, within this much time for all of them (colors never cost the tasks). */
const MAX_LISTS_PER_REFRESH = 10;
export const LIST_COLORS_BUDGET_MS = 5_000;

export type ClickUpDeps = TaskConnectorDeps;
type Client = McpClient<typeof CLICKUP_TOOLS>;

/** The saved connection, encrypted by the secret store (ATELIER_HOME/connectors/clickup.bin). `token: null` = signed out. */
const savedSchema = z.object({
  v: z.literal(1),
  ...SAVED_TOKEN_FIELDS,
  userId: z.string().regex(CLICKUP_ID),
  account: z.string().max(200).optional(),
  workspace: z.object({ id: z.string().regex(CLICKUP_ID), name: z.string().max(200) }),
  options: z.object({ includeClosed: z.boolean() })
});
type Saved = z.infer<typeof savedSchema>;

/** ClickUp's MCP names every hierarchy root "Workspace" (seen 2026-10-12), never the workspace's real name. */
const genericRoot = (name: string) => name.trim().toLowerCase() === 'workspace';

/**
 * The workspace's name on the card: the root's, unless it is the generic "Workspace" (or empty); then its spaces, two
 * at most and "+N" for the rest (`total` counts spaces beyond the first page). No spaces either: empty.
 */
export function workspaceLabel(rootName: string, spaces: string[], total?: number): string {
  const root = oneLine(rootName, 200);
  if (root && !genericRoot(root)) return root;
  const names = spaces.map((s) => oneLine(s, 100)).filter(Boolean);
  const rest = Math.max(total ?? 0, names.length) - Math.min(names.length, 2);
  return names.length ? `${names.slice(0, 2).join(', ')}${rest > 0 ? ` +${rest}` : ''}` : '';
}

/** ClickUp's way of saying "no access to this workspace" in a tool error ("403 Forbidden: Team not authorized…"). */
const ACCESS_TEXT = /\b403\b|forbidden|not authori[sz]ed|no access|access denied/i;

/** A person's name on the editor's chips: the username, else the e-mail's local part; none without either. */
function personName(a: { username?: string | null; email?: string | null }): string {
  return oneLine(a.username, 100) || oneLine(a.email?.split('@')[0], 100);
}

/** resolve_assignees gives ids only; the name comes from that id's entry among the fetched tasks' assignees. */
function accountNameOf(tasks: readonly ClickUpTask[], userId: string): string | undefined {
  for (const t of tasks) {
    for (const a of t.assignees ?? []) {
      if (a.id !== userId) continue;
      const name = oneLine(a.username, 100);
      if (name) return name;
    }
  }
  return undefined;
}

export class ClickUpConnector extends TaskConnector<Saved, typeof CLICKUP_TOOLS> {
  readonly id = 'clickup' as const;
  readonly name = 'ClickUp';
  protected readonly tools = CLICKUP_TOOLS;
  /**
   * List id → its statuses (name, `#rrggbb` color when it has one, type) and when they were read (memory only): the
   * tasks' colors and the automation editor's statuses.
   */
  private readonly listStatuses = new Map<string, { at: number; statuses: { name: string; color?: string; type?: string }[] }>();

  constructor(deps: ClickUpDeps) {
    super(deps);
  }

  protected parseSaved(raw: unknown): Saved | null {
    const r = savedSchema.safeParse(raw);
    return r.success ? r.data : null;
  }

  protected override classify(e: unknown): Failure {
    if (e instanceof ToolError && ACCESS_TEXT.test(e.text)) return 'access';
    return super.classify(e);
  }

  // ── Who, tasks ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** The account (resolve_assignees "me") and the workspace (hierarchy root). */
  protected async identify(client: Client, tokens: OAuthTokens, signal: AbortSignal): Promise<Saved> {
    const { userIds } = await this.op(signal, (s) => client.callTool('clickup_resolve_assignees', { assignees: ['me'] }, { signal: s }));
    const userId = userIds[0];
    if (!userId) throw new SchemaChanged('no user id for "me"');
    const workspace = await this.workspaceOf(client, signal);
    return { v: 1, token: tokens.accessToken, userId, workspace, options: { includeClosed: this.options.includeClosed } };
  }

  /** The tasks assigned to the user; the account's name when they carry it and it changed. */
  protected async fetchTasks(client: Client, saved: Saved, signal: AbortSignal): Promise<{ tasks: TaskSummary[]; update?: Partial<Saved> }> {
    const raw = await this.fetchRaw(client, saved.userId, signal);
    await this.readListColors(client, raw, signal);
    const account = accountNameOf(raw, saved.userId);
    return { tasks: raw.map((t) => toTaskSummary(this.colored(t))), ...(account && account !== saved.account ? { update: { account } } : {}) };
  }

  protected async getTask(client: Client, _saved: Saved, id: string, signal: AbortSignal): Promise<TaskDetail> {
    return toTaskDetail(await client.callTool('clickup_get_task', { task_id: id }, { signal }));
  }

  /** clickup_search. Its reply shape is not confirmed: any failure is "no results" (the base's rule for search). */
  protected async searchTasks(client: Client, _saved: Saved, keywords: string, signal: AbortSignal): Promise<TaskSummary[]> {
    const r = await client.callTool('clickup_search', { keywords }, { signal });
    return r.results.map((t) => toTaskSummary(this.colored(t)));
  }

  // ── Status colors (compact replies) ─────────────────────────────────────────────────────────────────────────────

  /**
   * Since October 2026 a listed task's status is its name alone; the color is in its list's statuses
   * (clickup_get_list, optional). Reads the lists that have uncolored tasks and no fresh colors, best effort: a list
   * that fails or doesn't answer within the budget just leaves its tasks without a color until the next read.
   */
  private async readListColors(client: Client, raw: readonly ClickUpTask[], signal: AbortSignal): Promise<void> {
    await this.readLists(client, raw.flatMap((t) => (t.status && !t.status.color && t.list?.id ? [t.list.id] : [])), signal);
  }

  /**
   * Reads the statuses of these lists that have none fresh (at most 10, within the 5 s budget), best effort: a list
   * that fails or doesn't answer in time counts as read with none, so a server without the tool isn't asked again
   * before 30 minutes; the lists the budget never got to are asked next time.
   */
  private async readLists(client: Client, lists: readonly string[], signal: AbortSignal): Promise<void> {
    const now = this.clock.now();
    const stale = (id: string) => { const c = this.listStatuses.get(id); return !c || now - c.at >= LIST_COLORS_TTL_MS; };
    const ids = [...new Set(lists)].filter(stale).slice(0, MAX_LISTS_PER_REFRESH);
    if (ids.length === 0) return;
    const ctl = new AbortController();
    const timer = this.clock.setTimeout(() => ctl.abort(), LIST_COLORS_BUDGET_MS);
    const onParent = () => ctl.abort();
    signal.addEventListener('abort', onParent, { once: true });
    try {
      for (const id of ids) {
        // Past the budget, the rest isn't asked, and isn't stamped: the next read asks it.
        if (ctl.signal.aborted) break;
        let statuses: { name: string; color?: string; type?: string }[] = [];
        try {
          const r = await client.callTool('clickup_get_list', { list_id: id }, { signal: ctl.signal });
          statuses = (r.statuses ?? []).flatMap((s) => {
            const name = oneLine(s.status, 100);
            const color = hexColor(s.color);
            return name ? [{ name, ...(color ? { color } : {}), ...(s.type ? { type: s.type } : {}) }] : [];
          });
        } catch (e) {
          if (signal.aborted) throw e;
          this.log(`list statuses not read: ${message(e)}`);
        }
        this.listStatuses.set(id, { at: now, statuses });
      }
    } finally {
      this.clock.clearTimeout(timer);
      signal.removeEventListener('abort', onParent);
    }
  }

  /** The task with its list's color for its status, when the reply had none and the list's colors are known. */
  private colored<T extends ClickUpTask>(t: T): T {
    if (!t.status || t.status.color || !t.list?.id) return t;
    const name = t.status.status.toLowerCase();
    const color = this.listStatuses.get(t.list.id)?.statuses.find((s) => s.name.toLowerCase() === name)?.color;
    return color ? { ...t, status: { ...t.status, color } } : t;
  }

  /**
   * Automations: the open tasks of these lists, whoever they are assigned to; 100 lists a call, up to 3 pages each (not
   * complete when a fourth was there).
   */
  protected override async watchTasks(client: Client, _saved: Saved, scopes: readonly string[], signal: AbortSignal): Promise<WatchResult> {
    const out: WatchedTask[] = [];
    const people = new Map<string, string>();
    let complete = true;
    const lists = scopes.filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s));
    for (let i = 0; i < lists.length; i += 100) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await client.callTool('clickup_filter_tasks', {
          list_ids: lists.slice(i, i + 100), include_closed: false, order_by: 'updated', ...(page > 0 ? { page } : {})
        }, { signal });
        for (const t of r.tasks) {
          const w = toWatchedTask(t);
          if (w) out.push(w);
          for (const a of t.assignees ?? []) { const name = personName(a); if (name && !people.has(a.id)) people.set(a.id, name); }
        }
        if (!r.has_more) break;
        if (page === MAX_PAGES - 1) complete = false;
      }
    }
    return { tasks: out, complete, people: [...people].map(([id, name]) => ({ id, name })) };
  }

  /** Automations' editor: the lists' statuses but the closed ones (the watch read leaves closed tasks out). */
  protected override async listDefinedStatuses(client: Client, _saved: Saved, scopes: readonly string[], signal: AbortSignal): Promise<{ name: string; color?: string }[]> {
    const lists = scopes.filter((s) => CLICKUP_ID.test(s));
    await this.readLists(client, lists, signal);
    const out: { name: string; color?: string }[] = [];
    for (const id of lists) {
      for (const st of this.listStatuses.get(id)?.statuses ?? []) {
        if (st.type === 'closed' || out.some((o) => o.name.toLowerCase() === st.name.toLowerCase())) continue;
        out.push({ name: st.name, ...(st.color ? { color: st.color } : {}) });
      }
    }
    return out;
  }

  /** Every list of the workspace (the hierarchy, depth 2): "Space › Folder › List", or "Space › List" folderless. */
  protected override async listScopes(client: Client, _saved: Saved, signal: AbortSignal): Promise<{ id: string; label: string }[]> {
    const r = await client.callTool('clickup_get_workspace_hierarchy', { max_depth: '2' }, { signal });
    const out: { id: string; label: string }[] = [];
    const walk = (nodes: readonly HierarchyNode[], path: string[]) => {
      for (const n of nodes) {
        const name = oneLine(n.name, 100);
        if (n.type === 'list') out.push({ id: n.id, label: [...path, name].join(' › ') });
        else walk(n.children ?? [], [...path, name]);
      }
    };
    walk(r.hierarchy.root.children ?? [], []);
    return out.slice(0, 500);
  }

  protected override async taskCreator(client: Client, _saved: Saved, id: string, signal: AbortSignal): Promise<{ id: string; name: string } | null> {
    const t = await client.callTool('clickup_get_task', { task_id: id }, { signal });
    if (!t.creator) return null;
    return { id: t.creator.id, name: oneLine(t.creator.username, 100) || t.creator.id };
  }

  isTaskId(id: string): boolean {
    return CLICKUP_ID.test(id);
  }

  taskUrlFor(id: string): string {
    return clickupTaskUrl(id);
  }

  appUrl(id: string): string | null {
    return typeof id === 'string' && CLICKUP_ID.test(id) ? `clickup://t/${id}` : null;
  }

  // ── Workspace ───────────────────────────────────────────────────────────────────────────────────────────────────

  protected override async afterRefresh(client: Client, signal: AbortSignal): Promise<void> {
    if (this.saved && genericRoot(this.saved.workspace.name)) await this.nameWorkspace(client, signal);
  }

  /** Workspace gone or no access: read the hierarchy again; another root → use it; none → unavailable. */
  protected override async onAccessLost(client: Client, signal: AbortSignal): Promise<void> {
    const saved = this.saved;
    if (!saved) return;
    let ws: Saved['workspace'] | null = null;
    try { ws = await this.workspaceOf(client, signal); } catch { ws = null; }
    if (signal.aborted || this.client !== client) return;
    if (ws && ws.id !== saved.workspace.id) {
      this.log('workspace changed: using the hierarchy root');
      this.saved = { ...saved, workspace: ws };
      this.persist();
      try {
        const raw = await this.fetchRaw(client, saved.userId, signal);
        if (signal.aborted) return;
        await this.readListColors(client, raw, signal);
        this.applyTasks(raw.map((t) => toTaskSummary(this.colored(t))));
        this.backOnline();
        return;
      } catch (e) {
        this.log(`task list fetch failed after a workspace change: ${message(e)}`);
      }
    }
    this.clearCache();
    this.toUnavailable('workspace-gone');
  }

  private async workspaceOf(client: Client, signal: AbortSignal): Promise<Saved['workspace']> {
    const r = await this.op(signal, (s) => client.callTool('clickup_get_workspace_hierarchy', { max_depth: '0' }, { signal: s }));
    const root = r.hierarchy.root;
    return { id: root.id, name: workspaceLabel(root.name, (root.children ?? []).map((c) => c.name), r.total_spaces) };
  }

  /** A connection saved before the root's "Workspace" was known to be generic: name it after its spaces, once. */
  private async nameWorkspace(client: Client, signal: AbortSignal): Promise<void> {
    try {
      const ws = await this.workspaceOf(client, signal);
      if (signal.aborted || this.client !== client || !this.saved || ws.id !== this.saved.workspace.id) return;
      this.saved = { ...this.saved, workspace: ws };
      this.persist();
    } catch (e) {
      this.log(`workspace name not read: ${message(e)}`);
    }
  }

  private async fetchRaw(client: Client, userId: string, signal: AbortSignal): Promise<ClickUpTask[]> {
    const out: ClickUpTask[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await this.op(signal, (s) => client.callTool('clickup_filter_tasks', {
        assignees: [userId], include_closed: this.options.includeClosed, order_by: 'updated', ...(page > 0 ? { page } : {})
      }, { signal: s }));
      out.push(...r.tasks);
      if (!r.has_more) break;
    }
    return out;
  }
}
