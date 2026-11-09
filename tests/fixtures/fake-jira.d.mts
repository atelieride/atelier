// Types for fake-jira.mjs (the fake Atlassian Rovo MCP v2 server + its OAuth authorization server used by tests).
// Behavior: see that file's header.

export type FakeJiraScenario =
  | 'normal' | 'mcp-401' | 'mcp-500' | 'rate-limited' | 'no-cimd' | 'two-sites' | 'no-jira-site' | 'project-gone'
  | 'filter-gone' | 'nodes-envelope' | 'tokens-disabled' | 'token-unscoped';

/** No scenario takes options yet; the parameter mirrors the other fakes' API. */
export type FakeJiraScenarioOptions = Record<string, never>;

export interface FakeJiraApiToken { email: string; token: string }

export interface FakeJiraOptions {
  /** Every tools/call name is appended here, one per line. */
  logFile?: string;
  scenario?: FakeJiraScenario;
  /** Reply to MCP requests as text/event-stream instead of application/json. */
  sse?: boolean;
  /** Accepted as `Authorization: Basic base64(email:token)` on the MCP endpoint (not with `tokens-disabled`). */
  apiTokens?: FakeJiraApiToken[];
}

export interface FakeJiraToolCall {
  name: string;
  arguments: unknown;
  /** `all` when the MCP URL had `?tools=all`. */
  exposure: 'all' | 'primary';
  /** What the request's Authorization header carried (valid or not). */
  auth: 'bearer' | 'basic' | 'none';
}

/** One POST to /oauth/revoke. `ok` false = refused with 401 access_denied (the CIMD client, or an unknown one). */
export interface FakeJiraRevocation { token: string; tokenTypeHint: string | null; client: 'cimd' | 'dcr' | 'unknown'; ok: boolean }

/** One DCR registration. */
export interface FakeJiraRegistration { clientId: string; clientName: string | null; redirectUris: string[]; tokenEndpointAuthMethod: string }

/** One GET /authorize: its query parameters and what the fake did. */
export interface FakeJiraAuthorizeRequest {
  query: Record<string, string>;
  outcome: 'code' | 'scope-refused' | 'bad-request' | 'unknown-client';
}

export interface FakeJiraUser {
  self: string;
  accountId: string;
  accountType: 'atlassian' | 'customer' | 'app';
  /** Present on purpose: the connector must drop it. */
  emailAddress: string;
  /** Present on purpose: the connector must drop them. */
  avatarUrls: Record<'48x48' | '24x24' | '16x16' | '32x32', string>;
  displayName: string;
  active: boolean;
  timeZone: string;
}

export interface FakeJiraStatusCategory { id: number; key: 'new' | 'indeterminate' | 'done'; colorName: 'blue-gray' | 'yellow' | 'green'; name: string }
export interface FakeJiraStatus { name: string; id: string; statusCategory: FakeJiraStatusCategory }
export interface FakeJiraIssueType { id: string; name: string; subtask: boolean; hierarchyLevel: number }
export interface FakeJiraPriority { id: string; name: string; iconUrl: string }

export interface FakeJiraProject { id: string; key: string; name: string; projectTypeKey: 'software' | 'business' | 'service_desk' | string; style: 'next-gen' | 'classic' }
export interface FakeJiraFilter { id: string; name: string; jql: string; owner: { accountId: string; displayName: string; active: boolean } }

export interface FakeJiraIssueFields {
  summary: string;
  status: FakeJiraStatus;
  project: { id: string; key: string; name: string; projectTypeKey: string; simplified: boolean };
  issuetype: FakeJiraIssueType;
  assignee: FakeJiraUser | null;
  creator: FakeJiraUser | null;
  reporter: FakeJiraUser | null;
  /** yyyy-MM-dd or null. */
  duedate: string | null;
  priority: FakeJiraPriority;
  labels: string[];
  /** Jira's shape: 2026-10-18T09:12:44.123+0200. */
  created: string;
  updated: string;
  /** Markdown, or HTML when the issue's `format` is 'html'. */
  description: string | null;
  parent?: { id: string; key: string };
  [field: string]: unknown;
}

export interface FakeJiraIssue {
  /** Numeric string. */
  id: string;
  key: string;
  fields: FakeJiraIssueFields;
  /** Not sent: 'html' makes the description come back as HTML with appliedContentFormat 'html'. */
  format?: 'html';
}

export interface FakeJiraSite { cloudId: string; url: string; projects: FakeJiraProject[]; filters: FakeJiraFilter[]; issues: FakeJiraIssue[] }

/** The fake's live data (a fresh copy per server, read on every reply: tests may mutate it). */
export interface FakeJiraData {
  /** The main site, https://acme.atlassian.net. */
  cloudId: string;
  url: string;
  /** Ada Lovelace: currentUser() in JQL. */
  me: FakeJiraUser;
  users: { me: FakeJiraUser; grace: FakeJiraUser; customer: FakeJiraUser };
  /** getJiraCurrentUser's reply data. */
  currentUser: {
    accountId: string; accountType: string; displayName: string; emailAddress: string; active: boolean; timeZone: string; locale: string;
    groups: { items: unknown[]; size: number }; applicationRoles: { items: unknown[]; size: number };
  };
  statuses: Record<'todo' | 'progress' | 'review' | 'done' | 'waiting' | 'resolved', FakeJiraStatus>;
  issueTypes: Record<'task' | 'bug' | 'story' | 'epic' | 'subtask' | 'request', FakeJiraIssueType>;
  priorities: string[];
  projects: FakeJiraProject[];
  filters: FakeJiraFilter[];
  issues: FakeJiraIssue[];
  /** https://acme-sandbox.atlassian.net, reachable only with the `two-sites` scenario. */
  sandbox: FakeJiraSite;
}

export interface FakeJira {
  /** The resource server's origin, http://127.0.0.1:<port>; the MCP endpoint is `${url}/v2/mcp`. */
  url: string;
  port: number;
  /** The authorization server's origin (authorize, token, revoke), another 127.0.0.1 port. */
  authUrl: string;
  authPort: number;
  /** `${authUrl}/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3`. */
  issuer: string;
  /** `${url}/v2/mcp`. */
  resource: string;
  /** https://useatelier.dev/oauth/client.json */
  cimdClientId: string;
  data: FakeJiraData;
  /** Throws on an unknown name. */
  setScenario(name: FakeJiraScenario, opts?: FakeJiraScenarioOptions): void;
  scenario(): FakeJiraScenario;
  setSse(on: boolean): void;
  /** Every tools/call name received, in order (write tools and refused calls included). */
  calls(): string[];
  callDetails(): FakeJiraToolCall[];
  /** The revocation endpoint's log, in order. */
  revoked(): FakeJiraRevocation[];
  registrations(): FakeJiraRegistration[];
  authorizeRequests(): FakeJiraAuthorizeRequest[];
  /** A valid access token without the OAuth dance (for MCP-only tests). */
  issueToken(): string;
  /** Every access token stops working (next MCP call → 401); refresh tokens still work. */
  expireAccessTokens(): void;
  /** expires_in of the tokens issued from now on (seconds, default 28800); the access token really expires then. */
  setExpiresIn(seconds: number): void;
  /** Ends both servers: held requests and keep-alive sockets are destroyed. Idempotent. */
  close(): Promise<void>;
}

export const PROTOCOL_VERSION: '2025-06-18';
export const SCENARIOS: readonly FakeJiraScenario[];
export const READ_TOOLS: readonly string[];
/** Write tools plus the meta tools (discover, executeRead, executeWrite, executeDestructive). */
export const WRITE_TOOLS: readonly string[];
export const META_TOOLS: readonly string[];
export const ISSUER_PATH: '/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3';
export const CIMD_CLIENT_ID: 'https://useatelier.dev/oauth/client.json';
export function makeJiraData(now?: number): FakeJiraData;
export function startFakeJira(opts?: FakeJiraOptions): Promise<FakeJira>;
