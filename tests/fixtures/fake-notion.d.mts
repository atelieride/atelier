// Types for fake-notion.mjs (the fake Notion OAuth server + MCP endpoint used by tests). Behavior: see that file's header.

export type FakeNotionScenario = 'normal' | 'mcp-401' | 'mcp-500' | 'unshare-backlog' | 'rename-stage';

/** No scenario takes options yet; the parameter mirrors the fake ClickUp's API. */
export type FakeNotionScenarioOptions = Record<string, never>;

export interface FakeNotionOptions {
  /** Every tools/call name is appended here, one per line. */
  logFile?: string;
  scenario?: FakeNotionScenario;
  scenarioOptions?: FakeNotionScenarioOptions;
  /** Reply to MCP requests as text/event-stream instead of application/json. */
  sse?: boolean;
}

export interface FakeNotionToolCall { name: string; arguments: unknown }

/** One POST to the revocation endpoint (RFC 7009). */
export interface FakeNotionRevocation { token: string; tokenTypeHint: string | null; clientId: string | null }

/** One per data source: Roadmap's two (roadmap-web, roadmap-mobile) share the database id. */
export interface FakeNotionDatabaseRef { key: 'sprint' | 'backlog' | 'roadmap-web' | 'roadmap-mobile'; id: string; collectionId: string; title: string }

export interface FakeNotion {
  /** http://127.0.0.1:<port>, also the OAuth issuer; the MCP endpoint is `${url}/mcp`. */
  url: string;
  port: number;
  issuer: string;
  fixtures: {
    /** The fake user's id ("me" in filters). */
    userId: string;
    databases: FakeNotionDatabaseRef[];
    /** The Pricing page (a Backlog row with the prompt-injection body), dashed. */
    pricingPageId: string;
  };
  /** Throws on an unknown name. Options replace the previous scenario's. */
  setScenario(name: FakeNotionScenario, opts?: FakeNotionScenarioOptions): void;
  scenario(): FakeNotionScenario;
  setSse(on: boolean): void;
  /** Every tools/call name received, in order (write tools and refused calls included). */
  calls(): string[];
  callDetails(): FakeNotionToolCall[];
  /** The revocation endpoint's log, in order. */
  revoked(): FakeNotionRevocation[];
  /** A valid access token without the OAuth dance (for MCP-only tests). */
  issueToken(): string;
  /** Every access token stops working (next MCP call → 401); refresh tokens still work. */
  expireAccessTokens(): void;
  /** Every refresh token dies: the next refresh answers invalid_grant. */
  revokeRefresh(): void;
  /** expires_in of the tokens issued from now on (seconds, default 3600); the access token really expires then. */
  setExpiresIn(seconds: number): void;
  /** Ends the server: held requests and keep-alive sockets are destroyed. Idempotent. */
  close(): Promise<void>;
}

export const PROTOCOL_VERSION: '2025-06-18';
export const SCENARIOS: readonly FakeNotionScenario[];
export const READ_TOOLS: readonly string[];
export const WRITE_TOOLS: readonly string[];
export function startFakeNotion(opts?: FakeNotionOptions): Promise<FakeNotion>;
