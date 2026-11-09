// What Jira shows in Settings › Connectors and in the automations editor: its list row and status block on top
// of the generic ones (connectors-view.ts), a project
// row's sub-line, the picker's rows and refusals, the saved filter's value, the API-token form (checks mirror main's
// schema, ipc-schemas.ts tokenConnectSchema), and the service-project rule's words. Main decides what is valid; this
// only says what to show and what to send. Pure: tested alone.
import { serviceProjectBlocked, type Automation } from '@shared/automations';
import { MAX_PROJECTS, type AddSourceResult, type ConnectorInfo, type FilterPick, type JiraProjectType, type ProjectInfo, type SourcePick } from '@shared/tasks';
import { t } from './i18n/en';
import { agoLower, connectorRow, connectorView, reasonText, type ConnectorRowView, type ConnectorView } from './connectors-view';
import { searchText, type PickerRow } from './notion-view';

const j = () => t.conn.jira;

/** Where Atlassian users create (and revoke) their API tokens: Atlassian's link for the Rovo MCP server (the
 * "Atlassian MCP V2" app, its scopes, the longest expiry). */
export const API_TOKENS_PAGE = 'https://id.atlassian.com/manage-profile/security/api-tokens?appId=mcp-v2&expiryDays=max&selectedScopes=all';

// ── The list row and the status block ─────────────────────────────────────────────────────────────────────────────

/** "2 projects · 9 open issues · updated 2 min ago" (done issues included: "9 issues"). */
function projectsLine(c: ConnectorInfo, projects: readonly ProjectInfo[], now: number): string {
  const counts = projects.flatMap((p) => (p.count === undefined ? [] : [p.count]));
  const total = counts.reduce((a, b) => a + b, 0);
  return [
    j().projects(projects.length),
    ...(counts.length ? [c.options.includeClosed ? j().issues(total) : j().openIssues(total)] : []),
    ...(c.updatedAt !== undefined ? [t.conn.updatedLower(agoLower(c.updatedAt, now))] : [])
  ].join(' · ');
}

/** Board 2: "Choose projects" while none is chosen, the projects line, "1 project needs attention"; else the generic row. */
export function jiraRow(c: ConnectorInfo, now: number): ConnectorRowView {
  if (c.status !== 'connected' || !c.projects) return connectorRow(c, now);
  if (c.projects.length === 0) return { chip: { tone: 'setup', label: t.conn.chips.chooseProjects }, line: j().noProjects(c.account) };
  const line = projectsLine(c, c.projects, now);
  if (c.attention && c.attention > 0) return { chip: { tone: 'warn', label: t.conn.chips.attentionProjects(c.attention) }, line };
  return { chip: { tone: 'ok', label: c.workspace ? t.conn.connectedTo(c.workspace) : t.conn.connected }, line };
}

/**
 * Boards 3 and 9. `tokenFlow`: the connecting attempt is an API token (no browser: only Cancel). `tokenForm`: the
 * token form is open and says the last attempt's error itself.
 */
export function jiraView(c: ConnectorInfo, now: number, o: { tokenFlow?: boolean; tokenForm?: boolean } = {}): ConnectorView {
  const v = connectorView(c, now);
  switch (c.status) {
    case 'connecting':
      if (o.tokenFlow) return { tone: 'busy', line: j().checkingToken, actions: v.actions.filter((a) => a.id === 'cancel') };
      return { ...v, sub: j().connectingHint, subTone: 'muted' };
    case 'connected':
      if (c.projects?.length === 0) return { tone: 'setup', line: v.line, sub: j().chooseWhere, subTone: 'muted', actions: v.actions.filter((a) => a.id === 'disconnect') };
      return v;
    case 'disconnected': case 'reconnect': {
      if (!o.tokenForm || v.subTone !== 'err') return v;
      const { sub: _sub, subTone: _tone, ...rest } = v;
      return rest;
    }
    default:
      return v;
  }
}

// ── Project rows ────────────────────────────────────────────────────────────────────────────────────────

export function projectTypeLabel(type: JiraProjectType): string {
  return j().types[type];
}

/** "Assigned to me · 6 open" / "Everyone · 14 open", "Loading…" while listed or while a Mine | Everyone change refreshes. */
export function projectSubLine(p: ProjectInfo, o: { includeClosed: boolean; saving?: boolean }): string {
  if (p.loading || o.saving) return j().loading;
  const who = p.everyone ? j().everyoneLine : j().assignedToMe;
  if (p.count === undefined) return who;
  return `${who} · ${o.includeClosed ? j().issues(p.count) : j().open(p.count)}`;
}

// ── The picker ────────────────────────────────────────────────────────────────────────────────────────

const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,19}-[1-9][0-9]{0,8}$/;

/**
 * A pasted link, or an issue key ("ATL-12"): what "Add this project" sends (main reads the project from it and refuses
 * another site's). A bare word is a search: a project key matches there by itself.
 */
export function jiraLinkRef(query: string): string | null {
  const q = query.trim();
  if (/^https?:\/\//i.test(q)) return q;
  return ISSUE_KEY.test(q) ? q.toUpperCase() : null;
}

/** ms before the search runs: at once for the empty field (the first 20 projects), after a pause while typing; null: no search. */
export function jiraSearchDelay(query: string): number | null {
  if (jiraLinkRef(query)) return null;
  return query.trim() === '' ? 0 : 250;
}

/** The picker's rows: a link is one "Add this project" row, anything else the projects main listed. */
export function jiraPickerRows(query: string, picks: readonly SourcePick[]): PickerRow[] {
  const ref = jiraLinkRef(query);
  if (ref) return [{ kind: 'link', key: 'link', ref }];
  return picks.map((pick) => ({ kind: 'pick', key: pick.id, pick }));
}

/** What the search sends: trimmed and bounded like Notion's. */
export const jiraSearchText = searchText;

export function jiraAddErrorText(reason: Extract<AddSourceResult, { ok: false }>['reason']): string {
  switch (reason) {
    case 'not-found': return j().notFound;
    case 'other-site': return j().otherSite;
    case 'not-database': return j().notProject;
    case 'too-many': return j().tooMany(MAX_PROJECTS);
    case 'offline': return t.conn.reasons.network('Jira');
    case 'failed': case 'unsupported': return j().addFailed;
  }
}

// ── The saved filter ──────────────────────────────────────────────────────────────────────────────────

export function filterValue(c: ConnectorInfo): string {
  return c.filter?.name || j().filterNone;
}

export type FilterChoice = { id: string | null; label: string; on: boolean };

/** The filter menu: None, then the user's filters (main's order), the chosen one checked; `none-left`: none saved. */
export function filterChoices(filters: readonly FilterPick[], c: ConnectorInfo): (FilterChoice | 'none-left')[] {
  const chosen = c.filter?.id ?? null;
  return [
    { id: null, label: j().filterNone, on: chosen === null },
    ...(filters.length ? filters.map((f) => ({ id: f.id, label: f.name, on: f.id === chosen })) : ['none-left' as const])
  ];
}

// ── The API-token sign-in ───────────────────────────────────────────────────────────────────────

export interface TokenDraft { site: string; user: string; secret: string }

/** The form's start: empty, or after an expired token the e-mail and site it used (never the secret). */
export function tokenDraftFor(c: ConnectorInfo): TokenDraft {
  return { site: c.signIn === 'token' || c.reason === 'token-expired' ? c.workspace ?? '' : '', user: c.tokenUser ?? '', secret: '' };
}

/** Reconnect asks for a new token instead of opening the browser: a connection that signed in with one. */
export function opensTokenForm(c: Pick<ConnectorInfo, 'id' | 'status' | 'signIn' | 'reason'>): boolean {
  return c.id === 'jira' && c.status === 'reconnect' && (c.signIn === 'token' || c.reason === 'token-expired');
}

const SITE = /^(?:https:\/\/)?([a-z0-9][a-z0-9-]{0,62}\.atlassian\.net)\/?$/i;
// As main's schema: no `:` in the user (it would split the Basic credentials), printable ASCII only.
const USER = /^[\x21-\x39\x3b-\x7e]{1,64}@[\x21-\x39\x3b-\x7e]{1,189}$/;
const SECRET = /^[\x21-\x7e]{16,512}$/;

/** What is sent: trimmed, the site's host alone, lower case. */
export function tokenCreds(d: TokenDraft): { site: string; user: string; secret: string } {
  const site = d.site.trim();
  return { site: (SITE.exec(site)?.[1] ?? site).toLowerCase(), user: d.user.trim(), secret: d.secret.trim() };
}

/** The first field main would refuse, in the form's order; null when it can be sent. */
export function tokenFormError(d: TokenDraft): 'site' | 'user' | 'secret' | null {
  const c = tokenCreds(d);
  if (!SITE.test(d.site.trim())) return 'site';
  if (!USER.test(c.user)) return 'user';
  if (!SECRET.test(c.secret)) return 'secret';
  return null;
}

/** The form's error line: why the last sent attempt failed (token refused, network…), once the attempt is over. */
export function tokenFormMessage(c: ConnectorInfo, sent: boolean): string | null {
  if (!sent || !c.reason || (c.status !== 'disconnected' && c.status !== 'reconnect') || c.reason === 'slowing-down') return null;
  return reasonText(c.name, c.reason, c.detail);
}

// ── Service projects in automations ────────────────────────────────────────────────────────────

/** The keys of the service-desk projects among an automation's scopes (project ids), in the scopes' order. */
export function serviceScopeKeys(scopes: readonly string[], projects: readonly ProjectInfo[] | undefined): string[] {
  return scopes.flatMap((id) => {
    const p = projects?.find((x) => x.id === id);
    return p && p.type === 'service_desk' ? [p.key] : [];
  });
}

/** The service projects that keep a Jira automation off (no Created by naming people); empty when it may turn on. */
export function automationServiceKeys(a: Pick<Automation, 'source' | 'conditions'>, connectors: readonly ConnectorInfo[]): string[] {
  if (a.source.connector !== 'jira') return [];
  const keys = serviceScopeKeys(a.source.scopes, connectors.find((c) => c.id === 'jira')?.projects);
  return serviceProjectBlocked(a.conditions, keys) ? keys : [];
}
