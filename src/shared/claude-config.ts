// What the Session panel shows as "Configured": the MCP servers, skills and plugins Claude Code's config
// files set up for a folder, read in main. Names and enabled state only: never commands, args, env, headers or URLs.

/** Where it is set: user (~/.claude), project (the folder's own files), local (~/.claude.json's entry for the folder), plugin. */
export type ConfigScope = 'user' | 'project' | 'local' | 'plugin';

/** 'approval': a project MCP server (.mcp.json) Claude Code asks about before using it. */
export type ConfigState = 'enabled' | 'disabled' | 'approval';

export interface ConfiguredItem {
  name: string;
  scope: ConfigScope;
  state: ConfigState;
}

export interface ClaudeConfig {
  mcpServers: ConfiguredItem[];
  skills: ConfiguredItem[];
  plugins: ConfiguredItem[];
  /** A config file is there but couldn't be read (unreadable, malformed, too big): the lists may be incomplete. */
  unreadable: boolean;
  /**
   * The folder's own settings were read. False when main refused the folder (outside the window's project, gone, inside
   * .git): only the user scope is listed.
   */
  project: boolean;
}

/** New MCP servers: by terminal id, the servers added since its session started (none: absent). */
export type McpAdded = Readonly<Record<string, readonly string[]>>;

/** The servers a session started now would load: enabled, or waiting for its approval at start; sorted. */
export function loadableMcp(config: ClaudeConfig): string[] {
  return config.mcpServers.filter((s) => s.state !== 'disabled').map((s) => s.name).sort();
}

/** What is new against the session's baseline: additions only, never what went away. */
export function addedMcp(baseline: readonly string[], now: readonly string[]): string[] {
  const had = new Set(baseline);
  return now.filter((n) => !had.has(n));
}
