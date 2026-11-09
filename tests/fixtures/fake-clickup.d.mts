// Types for fake-clickup.mjs (the fake ClickUp OAuth server + MCP endpoint used by tests). Behavior: see that file's header.

export type FakeScenario =
  | 'normal'
  | 'mcp-401' | 'mcp-403' | 'mcp-500' | 'mcp-429' | 'mcp-network-error' | 'slow' | 'oversized'
  | 'schema-changed' | 'tool-missing' | 'workspace-gone' | 'workspace-gone-403'
  | 'authorize-denied' | 'authorize-error' | 'authorize-wrong-state' | 'authorize-wrong-iss'
  | 'discovery-no-s256' | 'discovery-no-dcr' | 'discovery-no-none' | 'discovery-network-error'
  | 'token-network-error' | 'task-gone' | 'compact' | 'list-tool-missing';

export interface FakeScenarioOptions {
  /** mcp-429: x-ratelimit-reset = now + this many seconds (unix seconds). Default 30. */
  resetInSeconds?: number;
  /** slow: answer after this many ms; omitted = never answer. */
  delayMs?: number;
  /** oversized: size of the tool result text. Default 5 MiB. */
  bytes?: number;
  /** authorize-error: the error_description. */
  description?: string;
  /** task-gone: the task (its id) that is still listed but can no longer be got. */
  taskId?: string;
}

export interface FakeClickUpOptions {
  /** Every tools/call name is appended here, one per line. */
  logFile?: string;
  scenario?: FakeScenario;
  scenarioOptions?: FakeScenarioOptions;
  /** Reply to MCP requests as text/event-stream instead of application/json. */
  sse?: boolean;
  /** clickup_filter_tasks page size. Default 100. */
  pageSize?: number;
}

export interface FakeUser {
  id: number; username: string; email: string; color: string; initials: string; profilePicture: null;
}
export interface FakeListRef { id: string; name: string }
/** A clickup_get_workspace_hierarchy node (confirmed shape). Folderless lists are `list` children of their space. */
export interface FakeHierarchyNode {
  id: string; name: string; type: 'space' | 'folder' | 'list'; children: FakeHierarchyNode[];
}
/** The hierarchy root: the one workspace (no multi-workspace). */
export interface FakeWorkspace { id: string; name: string; children: FakeHierarchyNode[] }
export interface FakeTask {
  id: string; custom_id: string | null; name: string;
  status: { status: string; color: string; type: string };
  url: string;
  priority: { id: string; priority: string; color: string; orderindex: string } | null;
  assignees: FakeUser[];
  tags: { name: string; tag_fg: string; tag_bg: string }[];
  due_date: string | null; date_updated: string; date_closed: string | null;
  list: FakeListRef;
  markdown_description: string; text_content: string; creator: FakeUser; parent: string | null;
  folder: { id: string; name: string; hidden: boolean }; space: { id: string }; date_created: string;
  counts: { subtasks: number; checklists: number; attachments: number; comments: number };
}
/** A clickup_get_list reply (seen 2026-10-19). */
export interface FakeList {
  id: string; name: string; content: string; space: { id: string; name: string }; url: string;
  statuses: { id: string; status: string; color: string; orderindex: number; type: string }[];
}
export interface FakeFixtures {
  lists: FakeList[];
  user: FakeUser;
  otherUser: FakeUser;
  workspace: FakeWorkspace;
  tasks: FakeTask[];
  ids: {
    withCustomId: string; withoutCustomId: string; withDue: string;
    /** Its markdown_description has a ``` fence, a prompt-injection line and control characters. */
    fenced: string;
    /** status.type "closed": only listed with include_closed. */
    closed: string;
    /** Assigned to otherUser only, subtask of withCustomId. */
    otherAssignee: string;
    /** Not in the data: clickup_get_task → isError. */
    gone: string;
  };
}

export interface FakeToolCall { name: string; arguments: unknown }

export interface FakeClickUp {
  /** http://127.0.0.1:<port>, also the OAuth issuer; the MCP endpoint is `${url}/mcp`. */
  url: string;
  port: number;
  issuer: string;
  fixtures: FakeFixtures;
  /** Throws on an unknown name. Options replace the previous scenario's. */
  setScenario(name: FakeScenario, opts?: FakeScenarioOptions): void;
  scenario(): FakeScenario;
  setSse(on: boolean): void;
  /** Every tools/call name received, in order (write tools and refused calls included). */
  calls(): string[];
  callDetails(): FakeToolCall[];
  /** A valid Bearer token without the OAuth dance (for MCP-only tests). */
  issueToken(): string;
  /** Every issued token stops working (like a token revoked in ClickUp). */
  revokeTokens(): void;
  /** Ends the server: held (slow) requests and keep-alive sockets are destroyed. Idempotent. */
  close(): Promise<void>;
}

export const PROTOCOL_VERSION: '2025-06-18';
export const SCENARIOS: readonly FakeScenario[];
export const READ_TOOLS: readonly string[];
export const WRITE_TOOLS: readonly string[];
export function makeFixtures(): FakeFixtures;
export function startFakeClickUp(opts?: FakeClickUpOptions): Promise<FakeClickUp>;
