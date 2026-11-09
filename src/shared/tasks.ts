// Tasks from external sources: source-neutral shapes the renderer sees. Each connector maps its
// own data to these in main (ClickUp: src/main/connectors/clickup/map.ts). No token, no API URL: only task data and the
// task's web link, which main opens on request (connectors:openTask {source, id}).

/** The connectors Atelier knows. */
export type ConnectorId = 'clickup' | 'notion' | 'jira';
export const CONNECTOR_IDS: readonly ConnectorId[] = Object.freeze(['clickup', 'notion', 'jira'] as const);

/** A status as one of our state colors (never the source's own color); shared by the renderer and the sources' columns. */
export type TaskTone = 'idle' | 'working' | 'waiting' | 'done' | 'error' | 'violet';

export interface TaskStatus {
  /** As the source names it ("in progress"). */
  name: string;
  /** The source's color as `#rrggbb` (the UI maps it to the nearest state token, never shows the raw hex). */
  color?: string;
}

export interface TaskSummary {
  /** The source's own id (what `task(id)` takes). */
  id: string;
  /** What people call it: the custom id ("ENG-101") when there is one, else the id. */
  displayId: string;
  /** One line, no control characters. */
  title: string;
  status: TaskStatus;
  /** The source's priority name ("high"). */
  priority?: string;
  /** Due date, ms since the epoch. */
  due?: number;
  /** The list / project the task lives in. */
  listName?: string;
  /** The task's page in the source's web app. */
  url: string;
  /** Last change, ms since the epoch. */
  updatedAt?: number;
}

export interface TaskCounts {
  subtasks?: number;
  checklists?: number;
  attachments?: number;
  comments?: number;
}

export const MAX_TASK_BODY_BYTES = 32 * 1024;

export interface TaskDetail extends TaskSummary {
  /** Markdown, at most 32 KB (UTF-8), control characters removed (newlines and tabs kept). Untrusted text. */
  body: string;
  /** The parent task's id, for a subtask. */
  parent?: string;
  counts?: TaskCounts;
}

export type ConnectorStatus = 'disconnected' | 'connecting' | 'connected' | 'offline' | 'reconnect' | 'unavailable';

export interface ConnectorOptions {
  /** Whose tasks: v2.2 has only "assigned to me". */
  show: 'assigned';
  includeClosed: boolean;
}

export const DEFAULT_CONNECTOR_OPTIONS: Readonly<ConnectorOptions> = Object.freeze({ show: 'assigned', includeClosed: false });

/**
 * Why the card says what it says. The renderer turns each into copy (i18n/en.ts); main sends codes only.
 * - after a failed or refused Connect: `timeout`, `denied`, `oauth-error` (detail: ClickUp's description), `verify-failed`,
 *   `port-failed` (detail: the listen error code), `network`, `keychain-unavailable`, `fetch-failed` (the first task
 *   fetch failed for another reason)
 * - `unavailable`: `auth-unsupported` ("ClickUp changed how apps sign in"), `connector-changed` (a tool missing or a
 *   reply Atelier can't read), `workspace-gone`
 * - `reconnect`: `signed-out` (ClickUp refused the token), `unreadable` (the saved connection can't be decrypted)
 * - `connected` and rate limited for more than a minute: `slowing-down`
 */
export type ConnectorReason =
  | 'timeout' | 'denied' | 'oauth-error' | 'verify-failed' | 'port-failed' | 'network' | 'keychain-unavailable' | 'fetch-failed'
  | 'auth-unsupported' | 'connector-changed' | 'workspace-gone' | 'signed-out' | 'unreadable' | 'slowing-down'
  /** API-token sign-in: refused at Connect; refused later (expired or revoked); a token
   * that can't see the tools (made without scopes). */
  | 'token-refused' | 'token-expired' | 'token-scopes'
  /** Jira: the API token's site isn't a Jira Cloud site on that account; the account has no Jira site at all. */
  | 'token-site' | 'no-site';

/**
 * Which columns of a Notion database mean what. Property names as Notion gives them (≤ 100 chars,
 * no control characters). `closed` counts for `select` only: a `status` column always uses Notion's Complete group.
 */
export interface NotionFields {
  title: string;
  status?: { prop: string; kind: 'status' | 'select'; closed: string[] };
  assignee?: { prop: string; mine: boolean };
  due?: string;
  id?: string;
}

/**
 * At most this many closed options for a `select` status: Notion's rows filter holds 12 items, and a query adds
 * "assigned to me" and a title search to them. Main's guess keeps the first ones in option order and refuses more
 * (setSourceFields); the fields editor disables the other options once this many are chosen.
 */
export const MAX_CLOSED_OPTIONS = 10;

/** At most this many chosen sources (Notion: data sources); main refuses more ("too-many"). */
export const MAX_DATABASES = 20;

/** `unreadable`: Atelier can't read the source any more (removed, unshared). */
export type SourceError = 'unreadable';

/** One column of a source's schema, in memory only (never saved); `tone` is the state tone, never a raw color. */
export interface Column {
  name: string;
  type: 'title' | 'status' | 'select' | 'person' | 'date' | 'unique_id' | 'other';
  options?: { name: string; tone: TaskTone; group?: 'to_do' | 'in_progress' | 'complete' }[];
}

/** A chosen source (Notion: a database) in `ConnectorInfo.sources`. Text fields: one clean line, ≤ 200 characters. */
export interface SourceInfo {
  /** 32 hex, dashless. */
  id: string;
  name: string;
  path?: string;
  fields: NotionFields;
  columns?: Column[];
  count?: number;
  /** Its first listed task: the fields editor's preview (by source, never by name: two databases may share one). */
  preview?: TaskSummary;
  loading: boolean;
  error?: SourceError;
}

/** A chosen Jira project. `key` and `name` as last read; `id` never changes. */
export interface ProjectInfo {
  /** Digits. */
  id: string;
  key: string;
  name: string;
  type: JiraProjectType;
  /** Everyone's issues, not only the user's. */
  everyone: boolean;
  /** Open issues listed at the last refresh. */
  count?: number;
  loading: boolean;
  error?: SourceError;
}

export type JiraProjectType = 'software' | 'business' | 'service_desk' | 'other';

/** At most this many chosen Jira projects (main refuses more: "too-many"). */
export const MAX_PROJECTS = 20;

/** One of the user's saved Jira filters. */
export interface FilterPick { id: string; name: string }

/** A search result in the source picker. */
export interface SourcePick {
  id: string;
  name: string;
  path?: string;
  /** Jira: the project key and its type, for the picker's row. */
  key?: string;
  kind?: JiraProjectType;
  added: boolean;
}

/** connectors:addSource. `sourceIds`: what was added (one per data source). */
export type AddSourceResult =
  | { ok: true; sourceIds: string[] }
  | { ok: false; reason: 'not-database' | 'not-found' | 'too-many' | 'offline' | 'failed' | 'unsupported' | 'other-site' };

/** One Settings › Connectors card. Never carries a token, an auth URL or a code. */
export interface ConnectorInfo {
  id: ConnectorId;
  /** "ClickUp". */
  name: string;
  status: ConnectorStatus;
  /** The connected account's display name, when known ("Connected as <account>"; none → "Connected · <workspace>"). */
  account?: string;
  /**
   * The workspace's name (one per connection in v2.2). Present exactly when a connection is saved: the
   * renderer reads its absence as "nothing saved" (an unreadable `reconnect`; an `unavailable` whose Retry signs in).
   */
  workspace?: string;
  /** When the tasks were last fetched, ms since the epoch ("Updated 2 min ago", "showing tasks from 10:42"). */
  updatedAt?: number;
  /** Why (see ConnectorReason); absent when there is nothing to explain. */
  reason?: ConnectorReason;
  /** Display text for some reasons: ClickUp's error description (one line, ≤ 120 characters) or a listen error code. */
  detail?: string;
  /** While `connecting`: when the 5 minute wait ends, ms since the epoch. */
  connectingUntil?: number;
  /** A task fetch is running ("Loading tasks…" when there are none yet). */
  loading: boolean;
  /** Bumped whenever the task list changes: the renderer calls tasks:list again (no polling). */
  tasksVersion: number;
  options: ConnectorOptions;
  /** The connector's chosen sources (Notion: databases); absent for ClickUp. */
  sources?: SourceInfo[];
  /** How many sources need the user (a database Atelier can't read). */
  attention?: number;
  /** How the saved connection signed in, when it isn't OAuth. */
  signIn?: 'token';
  /** The API token's user (the e-mail the user typed): the Reconnect form starts from it. */
  tokenUser?: string;
  /** Jira: the chosen projects. */
  projects?: ProjectInfo[];
  /** Jira: the saved filter narrowing the list, when one is chosen. */
  filter?: FilterPick;
  /** Jira: the filter chosen before is gone (shown once). */
  filterGone?: boolean;
}

/**
 * A toast, sent to one window (the one that started Connect, else the focused one). `reconnect` and
 * `unavailable` come at most once per app launch; the others answer a Connect and always come. Cancel has none.
 */
export type ConnectorNoticeKind =
  | 'timeout' | 'denied' | 'oauth-error' | 'verify-failed' | 'port-failed' | 'network' | 'keychain-unavailable' | 'fetch-failed'
  | 'auth-unsupported' | 'reconnect' | 'unavailable' | 'token-refused' | 'token-scopes' | 'token-site';

export interface ConnectorNotice {
  id: ConnectorId;
  kind: ConnectorNoticeKind;
  /** As ConnectorInfo.detail. */
  detail?: string;
  /** `reconnect` and `unavailable`: which one (signed out or unreadable; connector changed, workspace gone…). */
  reason?: ConnectorReason;
}

/** tasks:list, per connector: what the palette shows. Tasks only while `connected` or `offline` (greyed, from `updatedAt`). */
export interface TaskList {
  source: ConnectorId;
  status: ConnectorStatus;
  loading: boolean;
  updatedAt?: number;
  tasks: TaskSummary[];
}

/** tasks:get. `gone`: "This task is no longer available in ClickUp." (removed, or no longer accessible). */
export type TaskGetResult =
  | { ok: true; task: TaskDetail }
  | { ok: false; reason: 'gone' | 'reconnect' | 'offline' | 'unavailable' | 'busy' | 'failed' | 'not-connected' };
