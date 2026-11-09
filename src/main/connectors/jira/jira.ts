// The Jira connector (Part B) on the generic base (task-connector.ts): Atlassian's Rovo MCP v2,
// one Jira Cloud site per connection, the projects the user chooses (sources), an optional saved filter, the
// API-token sign-in as an alternative to OAuth. Main only.
//
// - Who: getAccessibleAtlassianResources (the site: the one the user typed for an API token, else the first Jira one)
//   and getJiraCurrentUser (account id + display name). The same user on the same site signing in again keeps the
//   projects and the filter.
// - List: ONE searchJiraIssuesUsingJql per refresh (jql.ts), whatever the number of projects: Atlassian bills calls in
//   Rovo credits and caps them per site per hour. No project → no call. A project Jira says no longer exists is marked
//   unreadable and the query runs once more without it; a saved filter that is gone is dropped the same way.
// - Visibility: every issue read (list, search, detail, automations) must be in a chosen, readable project — checked
//   on the reply, whatever the query said — else it is dropped (`gone` for a detail).
// - Search: the list's scope plus the title words; a query shaped like an issue key also reads that issue (a JQL
//   `key = X` for a missing issue fails the whole query in Jira).
// - Links: `<site>/browse/<KEY>` built here from the saved site and a validated key, never taken from a reply.
import { z } from 'zod';
import type { WatchedTask, WatchResult } from '@shared/automations';
import {
  MAX_PROJECTS, type AddSourceResult, type ConnectorInfo, type ConnectorReason, type FilterPick, type ProjectInfo, type SourcePick, type TaskDetail,
  type TaskSummary
} from '@shared/tasks';
import { Forbidden, SchemaChanged, ToolError, Unauthorized, Unreachable } from '../errors';
import type { McpClient } from '../mcp/client';
import type { OAuthTokens } from '../oauth/oauth';
import { SAVED_TOKEN_FIELDS, TaskConnector, message, type Failure, type TaskConnectorDeps } from '../task-connector';
import { oneLine } from '../text';
import { listJql, searchJql, watchJql, type ListQuery } from './jql';
import { hostOf, issueUrl, priorityLevel, projectRef, projectType, siteOf, toDetail, toSummary } from './map';
import {
  ACCOUNT_ID, CLOUD_ID, DETAIL_FIELDS, ISSUE_KEY, JIRA_TOOLS, LIST_FIELDS, NUMERIC_ID, PROJECT_KEY, SITE_URL, type JiraIssue
} from './tools';

export type JiraDeps = TaskConnectorDeps;
type Client = McpClient<typeof JIRA_TOOLS>;

const projectSchema = z.object({
  id: z.string().regex(NUMERIC_ID), key: z.string().regex(PROJECT_KEY), name: z.string().max(200),
  type: z.enum(['software', 'business', 'service_desk', 'other']), everyone: z.boolean(), error: z.literal('unreadable').optional()
});
const savedSchema = z.object({
  v: z.literal(1), ...SAVED_TOKEN_FIELDS,
  userId: z.string().regex(ACCOUNT_ID), account: z.string().max(200).optional(),
  // The cloud id (a uuid), or the site URL for an API-token connection the account listing didn't name.
  workspace: z.object({ id: z.string().refine((s) => CLOUD_ID.test(s) || SITE_URL.test(s)), name: z.string().max(200) }),
  site: z.string().regex(SITE_URL),
  options: z.object({ includeClosed: z.boolean() }),
  projects: z.array(projectSchema).max(MAX_PROJECTS),
  filter: z.object({ id: z.string().regex(NUMERIC_ID), name: z.string().max(200) }).optional()
});
export type JiraSaved = z.infer<typeof savedSchema>;
type ProjectConfig = JiraSaved['projects'][number];

/** A task Atelier won't show: in no chosen project (or one it can't read any more). */
class NotChosen extends Forbidden {}
/** The account has no Jira site (or the API token's site isn't one): no access to name. */
class NoJiraSite extends Forbidden {}

const PROJECT_GONE = /The value '(\d{1,18})' does not exist for the field 'project'/g;
const FILTER_GONE = /does not exist for the field 'filter'/;
/** Rovo MCP's own words for a site the token can't open (the fake and the real service); a validation error naming cloudId isn't one. */
const SITE_GONE = /Site not found or not accessible/i;
const RESULTS = 100;
const PICKS = 20;
const FILTERS = 50;

export class JiraConnector extends TaskConnector<JiraSaved, typeof JIRA_TOOLS> {
  readonly id = 'jira' as const;
  readonly name = 'Jira';
  protected readonly tools = JIRA_TOOLS;
  protected override readonly tokenSignIn = true;
  /** The issues the last refresh listed, by project id (the rows' counts); null before the first one. */
  private listed: Map<string, number> | null = null;
  /** Task id → its project id, for dropping a removed project's tasks. */
  private readonly taskProject = new Map<string, string>();
  /** The picker's last results, by project id (adding a pick needs its key, name and type). */
  private readonly picks = new Map<string, Omit<ProjectConfig, 'everyone'>>();
  /** The filter picker's last results. */
  private readonly filters = new Map<string, string>();
  /** The saved filter was gone at the last refresh (the details say so once). */
  private filterGone = false;

  constructor(deps: JiraDeps) {
    super(deps);
  }

  protected parseSaved(raw: unknown): JiraSaved | null {
    const r = savedSchema.safeParse(raw);
    return r.success ? r.data : null;
  }

  protected override accessReason(e: unknown): ConnectorReason {
    return e instanceof NoJiraSite ? 'no-site' : 'workspace-gone';
  }

  protected override classify(e: unknown): Failure {
    if (e instanceof NotChosen) return 'access';
    if (e instanceof ToolError && SITE_GONE.test(e.text)) return 'access';
    return super.classify(e);
  }

  // ── Who ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The site and the account. An API token names its site; OAuth takes the first Jira site the grant lists. */
  protected async identify(client: Client, tokens: OAuthTokens, signal: AbortSignal, hint?: { site?: string }): Promise<JiraSaved> {
    const typed = hint?.site !== undefined ? siteOf(hint.site) : undefined;
    if (typed === null) throw new NoJiraSite();
    let sites: { cloudId: string; site: string }[] = [];
    try {
      const r = await this.op(signal, (s) => client.callTool('getAccessibleAtlassianResources', {}, { signal: s }));
      sites = r.resources.flatMap((x) => {
        const site = siteOf(x.url);
        return site && (x.products ?? []).some((p) => p.id === 'jira') ? [{ cloudId: x.cloudId, site }] : [];
      });
    } catch (e) {
      // An API token may not list resources; the site the user typed is then the cloud id (the tools take its URL).
      if (!(typed && e instanceof ToolError)) throw e;
    }
    const pick = typed ? sites.find((x) => x.site === typed) ?? { cloudId: typed, site: typed } : sites[0];
    if (!pick) throw new NoJiraSite();
    if (!typed && sites.length > 1) this.log(`${sites.length} Jira sites on this account: using the first`);
    const me = await this.op(signal, (s) => client.callTool('getJiraCurrentUser', { cloudId: pick.cloudId }, { signal: s }));
    const account = oneLine(me.displayName, 200);
    const prev = this.saved;
    const same = prev !== null && prev.userId === me.accountId && prev.site === pick.site;
    const saved: JiraSaved = {
      v: 1, token: tokens.accessToken, userId: me.accountId, ...(account ? { account } : {}),
      workspace: { id: pick.cloudId, name: hostOf(pick.site) }, site: pick.site,
      options: { includeClosed: this.options.includeClosed },
      projects: same ? prev.projects : [], ...(same && prev.filter ? { filter: prev.filter } : {})
    };
    if (!savedSchema.safeParse(saved).success) throw new SchemaChanged('unexpected Jira site or account ids');
    return saved;
  }

  // ── Tasks ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The projects as they are now (the user may add or remove one while a refresh runs). */
  private projectsNow(client: Client, saved: JiraSaved): readonly ProjectConfig[] {
    const now = this.saved;
    if (!now) return saved.projects;
    if (this.client === client) return now.projects;
    return now.userId === saved.userId && now.site === saved.site ? now.projects : saved.projects;
  }

  private query(projects: readonly ProjectConfig[], filter: JiraSaved['filter']): ListQuery {
    return {
      projects: projects.filter((p) => !p.error).map((p) => ({ id: p.id, everyone: p.everyone })),
      includeDone: this.options.includeClosed, ...(filter ? { filterId: filter.id } : {})
    };
  }

  /** One page of a search, its issues kept only when their project is chosen and readable. */
  private async runJql(client: Client, saved: JiraSaved, jql: string, signal: AbortSignal): Promise<{ issues: JiraIssue[]; more: boolean }> {
    const r = await client.callTool('searchJiraIssuesUsingJql', {
      cloudId: saved.workspace.id, jql, fields: [...LIST_FIELDS], maxResults: RESULTS, responseContentFormat: 'markdown', view: 'full'
    }, { signal });
    return { issues: r.issues.filter((i) => this.readable(client, saved, i)), more: r.next !== undefined };
  }

  private readable(client: Client, saved: JiraSaved, i: JiraIssue): boolean {
    return this.projectsNow(client, saved).some((p) => p.id === i.fields.project.id && !p.error);
  }

  /**
   * One search; a project or filter Jira says is gone → marked, and the search runs once more without it. What
   * the refresh learned (gone projects, renames, a gone filter) is applied by id onto the projects and filter as they
   * are when it ends: the user may have added, removed or switched one meanwhile, and that must not be undone.
   */
  protected async fetchTasks(client: Client, saved: JiraSaved, signal: AbortSignal): Promise<{ tasks: TaskSummary[]; update?: Partial<JiraSaved> }> {
    let projects = [...this.projectsNow(client, saved)];
    let filter = this.saved?.filter ?? saved.filter;
    /** By project id: what Jira said about it. */
    const learned = new Map<string, Partial<ProjectConfig>>();
    let goneFilter: string | null = null;
    let result: { issues: JiraIssue[]; more: boolean } | null = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      const jql = listJql(this.query(projects, filter));
      if (jql === null) { result = { issues: [], more: false }; break; }
      try {
        result = await this.runJql(client, { ...saved, projects }, jql, signal);
      } catch (e) {
        if (attempt > 0 || !(e instanceof ToolError)) throw e;
        const text = e.fullText ?? e.text;
        const gone = new Set([...text.matchAll(PROJECT_GONE)].map((m) => m[1]!));
        const filterGone = filter !== undefined && FILTER_GONE.test(text);
        if (gone.size === 0 && !filterGone) throw e;
        if (gone.size) {
          projects = projects.map((p) => (gone.has(p.id) ? { ...p, error: 'unreadable' as const } : p));
          for (const id of gone) learned.set(id, { error: 'unreadable' });
          this.log(`${gone.size} Jira project(s) no longer readable`);
        }
        if (filterGone) { goneFilter = filter!.id; filter = undefined; this.log('the saved Jira filter is gone'); }
      }
    }
    const issues = result!.issues;
    const listed = new Map<string, number>();
    this.taskProject.clear();
    for (const i of issues) {
      listed.set(i.fields.project.id, (listed.get(i.fields.project.id) ?? 0) + 1);
      this.taskProject.set(i.id, i.fields.project.id);
    }
    this.listed = listed;
    // Keys and names as Jira has them now (a renamed project keeps its id).
    for (const i of issues) {
      const p = i.fields.project;
      const was = projects.find((x) => x.id === p.id);
      if (was && (was.key !== p.key || was.name !== oneLine(p.name, 200))) learned.set(p.id, { ...learned.get(p.id), key: p.key, name: oneLine(p.name, 200) });
    }
    const tasks = issues.map((i) => toSummary(i, saved.site));
    // Onto the projects and the filter as they are now (no await from here on: nothing else can change them).
    const now = this.projectsNow(client, saved);
    const filterNow = this.saved && this.client === client ? this.saved.filter : saved.filter;
    const dropFilter = goneFilter !== null && filterNow?.id === goneFilter;
    if (dropFilter) this.filterGone = true;
    const touched = now.some((p) => learned.has(p.id));
    if (!touched && !dropFilter) return { tasks };
    const update: Partial<JiraSaved> = { projects: now.map((p) => (learned.has(p.id) ? { ...p, ...learned.get(p.id) } : p)) };
    if (dropFilter) Object.assign(update, { filter: undefined });
    return { tasks, update };
  }

  /** One issue of a chosen project, with its body; anything else is `gone`. */
  protected async getTask(client: Client, saved: JiraSaved, id: string, signal: AbortSignal): Promise<TaskDetail> {
    const r = await client.callTool('getJiraIssue', {
      cloudId: saved.workspace.id, issueIdOrKey: id, fields: [...DETAIL_FIELDS], fieldsByKeys: true, responseContentFormat: 'markdown', view: 'full'
    }, { signal });
    if (r.id !== id || !this.readable(client, saved, r)) throw new NotChosen();
    return toDetail(r, saved.site);
  }

  protected async searchTasks(client: Client, saved: JiraSaved, query: string, signal: AbortSignal): Promise<TaskSummary[]> {
    const out: TaskSummary[] = [];
    const key = query.trim().toUpperCase();
    if (ISSUE_KEY.test(key)) {
      try {
        const r = await client.callTool('getJiraIssue', {
          cloudId: saved.workspace.id, issueIdOrKey: key, fields: [...LIST_FIELDS], fieldsByKeys: true, responseContentFormat: 'markdown', view: 'full'
        }, { signal });
        if (this.readable(client, saved, r)) out.push(toSummary(r, saved.site));
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
      }
    }
    const jql = searchJql(this.query(this.projectsNow(client, saved), this.saved?.filter ?? saved.filter), query);
    if (jql !== null) {
      for (const i of (await this.runJql(client, saved, jql, signal)).issues) if (!out.some((t) => t.id === i.id)) out.push(toSummary(i, saved.site));
    }
    return out;
  }

  /**
   * Automations: the newest open issues of these chosen projects, everyone's, with what the
   * conditions read (creator and labels come with the search). A scope that isn't a chosen readable project is never read.
   */
  protected override async watchTasks(client: Client, saved: JiraSaved, scopes: readonly string[], signal: AbortSignal): Promise<WatchResult> {
    const chosen = this.projectsNow(client, saved);
    const ids = scopes.filter((s) => chosen.some((p) => p.id === s && !p.error));
    const complete = ids.length === scopes.length;
    const jql = watchJql(ids, { includeDone: false });
    if (jql === null) return { tasks: [], complete };
    const r = await this.runJql(client, saved, jql, signal);
    const read = r.issues.filter((i) => ids.includes(i.fields.project.id));
    const people = new Map<string, string>();
    for (const i of read) {
      for (const u of [i.fields.assignee, i.fields.creator]) {
        const name = u ? oneLine(u.displayName, 100) : '';
        if (u && name && !people.has(u.accountId)) people.set(u.accountId, name);
      }
    }
    const tasks = read.map((i): WatchedTask => {
      const s = toSummary(i, saved.site);
      const level = priorityLevel(i.fields.priority?.name);
      return {
        id: s.id, scope: i.fields.project.id, displayId: s.displayId, title: s.title, url: s.url, status: s.status.name,
        assignees: i.fields.assignee ? [i.fields.assignee.accountId] : [],
        ...(i.fields.creator ? { creatorId: i.fields.creator.accountId } : {}),
        tags: (i.fields.labels ?? []).map((l) => oneLine(l, 100)).filter(Boolean),
        ...(level ? { priority: level } : {}), ...(s.due !== undefined ? { due: s.due } : {})
      };
    });
    return { tasks, complete: complete && !r.more, people: [...people].map(([id, name]) => ({ id, name })) };
  }

  /** Automations' editor: the chosen projects, "KEY · Name". */
  protected override listScopes(client: Client, saved: JiraSaved): Promise<{ id: string; label: string }[]> {
    return Promise.resolve(this.projectsNow(client, saved).filter((p) => !p.error).map((p) => ({ id: p.id, label: `${p.key} · ${p.name}` })));
  }

  protected override async taskCreator(client: Client, saved: JiraSaved, id: string, signal: AbortSignal): Promise<{ id: string; name: string } | null> {
    const r = await client.callTool('getJiraIssue', {
      cloudId: saved.workspace.id, issueIdOrKey: id, fields: ['creator', 'project', 'summary'], fieldsByKeys: true, responseContentFormat: 'markdown', view: 'full'
    }, { signal });
    if (!this.readable(client, saved, r) || !r.fields.creator) return null;
    return { id: r.fields.creator.accountId, name: oneLine(r.fields.creator.displayName, 200) };
  }

  /** The service-desk projects among these (automations' rule). */
  override serviceScopes(ids: readonly string[]): string[] {
    return (this.saved?.projects ?? []).filter((p) => p.type === 'service_desk' && ids.includes(p.id)).map((p) => p.id);
  }

  isTaskId(id: string): boolean {
    return typeof id === 'string' && NUMERIC_ID.test(id);
  }

  /** No site saved (disconnected): no link of main's, so the chip opens the one it saved with the task. */
  override taskUrl(id: string): string | null {
    return this.saved ? super.taskUrl(id) : null;
  }

  /** Only when no listed task gave its link: Jira's issue search for that id (a browse link needs the key). */
  taskUrlFor(id: string): string {
    return `${this.saved!.site}/issues/?jql=${encodeURIComponent(`id = ${id}`)}`;
  }

  /** Jira Cloud has no desktop app (the Mac one was discontinued): issues open in the browser. */
  appUrl(): string | null {
    return null;
  }

  // ── Card ────────────────────────────────────────────────────────────────────────────────────────────────────────

  protected override infoExtra(): Partial<ConnectorInfo> {
    const saved = this.saved;
    if (!saved) return {};
    const projects = saved.projects.map((p): ProjectInfo => {
      const count = p.error || !this.listed ? undefined : this.listed.get(p.id) ?? 0;
      return {
        id: p.id, key: p.key, name: p.name, type: p.type, everyone: p.everyone, ...(count !== undefined ? { count } : {}),
        loading: this.refreshInFlight && count === undefined && !p.error, ...(p.error ? { error: p.error } : {})
      };
    });
    return {
      projects, attention: saved.projects.filter((p) => p.error).length,
      ...(saved.filter ? { filter: { ...saved.filter } } : {}), ...(this.filterGone ? { filterGone: true } : {})
    };
  }

  override disconnect(): void {
    this.listed = null;
    this.taskProject.clear();
    this.picks.clear();
    this.filters.clear();
    this.filterGone = false;
    super.disconnect();
  }

  // ── Projects ────────────────────────────────────────────────────────────────────────────────────────

  private live(): Client | null {
    return (this.status === 'connected' || this.status === 'offline') && this.saved?.token ? this.client : null;
  }

  /** A call from the details page: a 401 signs out; anything else rejects with a line the picker shows. */
  private async ask<R>(what: string, fn: (c: Client, saved: JiraSaved, s: AbortSignal) => Promise<R>): Promise<R> {
    const client = this.live();
    const saved = this.saved;
    if (!client || !saved) throw new Error('Jira isn\'t connected.');
    const signal = this.life.signal;
    try {
      return await this.op(signal, (s) => this.withClient(s, (c) => fn(c, saved, s)));
    } catch (e) {
      if (e instanceof Unauthorized && !signal.aborted && this.client === client) this.signOut();
      this.log(`${what} failed: ${message(e)}`);
      throw new Error(e instanceof Unreachable ? 'Can\'t reach Jira.' : `Couldn't ${what}.`);
    }
  }

  /** The picker: the projects the user can browse (the first 20, or those matching the query by key or name). */
  async searchSources(query: string): Promise<SourcePick[]> {
    const q = oneLine(query, 100);
    const site = this.saved?.site;
    if (!site) return [];
    // A pasted link or issue key: the project it names (looked up by its key). A bare word is a search by key or name
    // ("website" must find WEB): Jira's query matches keys too.
    const ref = q && !PROJECT_KEY.test(q.toUpperCase()) ? projectRef(q, site) : null;
    if (ref === 'other-site') return [];
    const lookup = ref ? ref.key : q;
    const r = await this.ask('list Jira projects', (c, saved, s) =>
      c.callTool('listJiraProjects', { cloudId: saved.workspace.id, ...(lookup ? { query: lookup } : {}), maxResults: PICKS }, { signal: s }));
    const chosen = new Set(this.saved?.projects.map((p) => p.id));
    const values = ref ? r.values.filter((v) => v.key === ref.key) : r.values;
    return values.slice(0, PICKS).map((v) => {
      const pick = { id: v.id, key: v.key, name: oneLine(v.name, 200), type: projectType(v.projectTypeKey) };
      this.picks.set(v.id, pick);
      return { id: v.id, name: pick.name, key: v.key, kind: pick.type, added: chosen.has(v.id) };
    });
  }

  /** A pick's id, or a pasted key or link (looked up first). Added as "Mine"; the list refreshes. */
  async addSource(ref: string): Promise<AddSourceResult> {
    const saved = this.saved;
    if (!saved || !this.live() || typeof ref !== 'string') return { ok: false, reason: 'failed' };
    let pick = NUMERIC_ID.test(ref) ? this.picks.get(ref) : undefined;
    if (!pick) {
      const named = projectRef(ref, saved.site);
      if (named === 'other-site') return { ok: false, reason: 'other-site' };
      if (!named) return { ok: false, reason: 'not-database' };
      let found: SourcePick[];
      try { found = await this.searchSources(named.key); } catch (e) { return { ok: false, reason: /reach/.test(message(e)) ? 'offline' : 'failed' }; }
      const hit = found.find((p) => p.key === named.key);
      pick = hit ? this.picks.get(hit.id) : undefined;
      if (!pick) return { ok: false, reason: 'not-found' };
    }
    const now = this.saved;
    if (!now) return { ok: false, reason: 'failed' };
    if (now.projects.some((p) => p.id === pick.id)) return { ok: true, sourceIds: [pick.id] };
    if (now.projects.length >= MAX_PROJECTS) return { ok: false, reason: 'too-many' };
    this.saved = { ...now, projects: [...now.projects, { ...pick, everyone: false }] };
    this.persist();
    this.refreshSoon();
    this.changed();
    return { ok: true, sourceIds: [pick.id] };
  }

  async removeSource(sourceId: string): Promise<ConnectorInfo> {
    const saved = this.saved;
    if (!saved || !saved.projects.some((p) => p.id === sourceId)) return this.info();
    this.saved = { ...saved, projects: saved.projects.filter((p) => p.id !== sourceId) };
    this.persist();
    this.dropTasks((t) => this.taskProject.get(t.id) !== sourceId);
    this.listed?.delete(sourceId);
    this.changed();
    return this.info();
  }

  /** "Mine | Everyone" on a project row: saved at once, the list refreshes. */
  async setSourceScope(sourceId: string, everyone: boolean): Promise<ConnectorInfo> {
    const saved = this.saved;
    if (!saved || typeof everyone !== 'boolean') return this.info();
    const at = saved.projects.findIndex((p) => p.id === sourceId);
    if (at < 0 || saved.projects[at]!.everyone === everyone) return this.info();
    const projects = saved.projects.map((p, i) => (i === at ? { ...p, everyone } : p));
    this.saved = { ...saved, projects };
    this.persist();
    this.refreshSoon();
    this.changed();
    return this.info();
  }

  // ── Saved filter ────────────────────────────────────────────────────────────────────────────────────

  async listFilters(): Promise<FilterPick[]> {
    const r = await this.ask('list your Jira filters', (c, saved, s) => c.callTool('listJiraFilters', { cloudId: saved.workspace.id, maxResults: FILTERS }, { signal: s }));
    this.filters.clear();
    return r.values.map((v) => {
      const name = oneLine(v.name, 200) || `Filter ${v.id}`;
      this.filters.set(v.id, name);
      return { id: v.id, name };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A filter from the last listing, or null for none; the list refreshes. */
  async setFilter(filterId: string | null): Promise<ConnectorInfo> {
    const saved = this.saved;
    if (!saved) return this.info();
    if (filterId === null) {
      if (!saved.filter && !this.filterGone) return this.info();
      const { filter: _drop, ...rest } = saved;
      this.saved = rest;
    } else {
      const name = typeof filterId === 'string' && NUMERIC_ID.test(filterId) ? this.filters.get(filterId) : undefined;
      if (!name || saved.filter?.id === filterId) return this.info();
      this.saved = { ...saved, filter: { id: filterId, name } };
    }
    this.filterGone = false;
    this.persist();
    this.refreshSoon();
    this.changed();
    return this.info();
  }

  /** The issue link for a key of this connection's site (the chip's fallback; null for anything else). */
  linkFor(key: string): string | null {
    return this.saved && ISSUE_KEY.test(key) ? issueUrl(this.saved.site, key) : null;
  }
}
