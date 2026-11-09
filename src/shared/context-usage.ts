// Context usage: what fills a Claude session's context, as Claude Code itself counts it.
// Main asks a private copy of the session (`claude -p … --resume <id> --fork-session --no-session-persistence`) over
// Claude Code's stream-json control protocol (`mcp_status`, then `get_context_usage`) and reads the answer here,
// leniently: a missing or malformed part is empty, never a crash; nothing but names, scopes, statuses and token counts
// survives (never a server's config, URL or command).

export type ContextGroupId = 'system' | 'messages' | 'mcp' | 'memory' | 'skills';

/** The donut's fixed order (colour follows the group, never its rank). */
export const GROUP_ORDER: readonly ContextGroupId[] = ['messages', 'mcp', 'memory', 'skills', 'system'];

export interface ContextRow { name: string; tokens: number }

export interface ContextServer {
  /** As Claude Code shows it ("claude.ai Tasks"). */
  name: string;
  /** Its tools' prefix (`mcp__<key>__`). */
  key: string;
  /** From `mcp_status`: user, project, local, claudeai, plugin, dynamic, enterprise…; null when unknown. */
  scope: string | null;
  instructions: number;
  /** Tools in the context (Claude searched for them, or tool search is off), short names, largest first. */
  loaded: ContextRow[];
  /** Tools waiting outside the context until Claude searches for them. */
  deferredCount: number;
  deferredTokens: number;
  /** instructions + loaded tools. */
  inContext: number;
  /** The file that sets it up, when main can tell: the session folder's .mcp.json, the account's .claude.json. */
  configFile: string | null;
  /** configFile as shown (~ for the home, put by main). */
  configShown: string | null;
}

export interface ContextSkills {
  kind: 'skill' | 'agent';
  /** built-in, claude.ai, plugin, user, project, local, managed, bundled, mcp, or Claude Code's own word. */
  source: string;
  plugin: string | null;
  count: number;
  tokens: number;
}

export interface ContextMessages {
  /** Tool calls plus their results, by tool, the five largest. */
  tools: ContextRow[];
  otherTools: number;
  toolsTotal: number;
  user: number;
  assistant: number;
  attachments: number;
  other: number;
}

export interface ContextReport {
  /** When it was analysed (ms). */
  at: number;
  model: string | null;
  total: number;
  max: number;
  /** The total where auto-compact runs; null when it is off. */
  autoCompactAt: number | null;
  /** The last API call's input (input + cache creation + cache read), for counting what came after; null without one. */
  apiTotal: number | null;
  /** The copy read the session's conversation (main sets it; false: analysed without it, Messages not counted). */
  resumed: boolean;
  groups: Record<ContextGroupId, number>;
  /** The System group's parts, largest first. */
  system: ContextRow[];
  deferred: { mcp: number; system: number };
  buffer: number;
  free: number;
  servers: ContextServer[];
  offline: { name: string; status: string }[];
  /** `shown`: the path with ~ for the home (main puts it; the path itself until then). */
  memory: { path: string; shown: string; type: string; tokens: number }[];
  skills: ContextSkills[];
  messages: ContextMessages;
}

export interface McpServerStatus { name: string; status: string; scope: string | null }

export type ContextErrorKind = 'not-found' | 'no-session' | 'account' | 'unsupported' | 'timeout' | 'exit';
export type ContextResult = { ok: true; report: ContextReport } | { ok: false; kind: ContextErrorKind; message: string };
export interface ContextProgress { terminalId: string; phase: 'start' | 'mcp' | 'count'; connected?: number; total?: number }

const MAX_TOOLS = 500;
const MAX_SERVERS = 100;
const MAX_MEMORY = 200;
const MAX_SKILLS = 500;
const MAX_MESSAGE_TOOLS = 100;
const TOP_TOOLS = 5;
/** A name shown as it is: printable, at most 200 characters (else dropped). */
const NAME = /^[^\x00-\x1f\x7f-\x9f]{1,200}$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const MODELS = ['opus', 'sonnet', 'haiku'] as const;
export type ContextModel = (typeof MODELS)[number];

/**
 * The private copy's argv: stream-json both ways, never saved, the user's hooks off; `--resume <id>
 * --fork-session` when the session has a transcript; `--model <alias>` when its model is known. Throws on anything else.
 */
export function contextArgs(o: { resume: string | null; model: ContextModel | null }): string[] {
  if (o.resume !== null && !SESSION_ID.test(o.resume)) throw new Error('bad session id');
  if (o.model !== null && !(MODELS as readonly string[]).includes(o.model)) throw new Error('bad model');
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--settings', '{"disableAllHooks":true}',
    ...(o.resume !== null ? ['--resume', o.resume, '--fork-session'] : []),
    ...(o.model !== null ? ['--model', o.model] : [])
  ];
}

/** The model alias in the status line's name ("Opus 5.5" → opus), for the copy's window size; null when unknown. */
export function contextModel(display: string | null | undefined): ContextModel | null {
  const m = /\b(opus|sonnet|haiku)\b/i.exec((display ?? '').replace(/[-_]/g, ' '));
  return m ? (m[1]!.toLowerCase() as ContextModel) : null;
}

export function controlLine(id: string, subtype: 'initialize' | 'mcp_status' | 'get_context_usage'): string {
  return `${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } })}\n`;
}

/** Claude Code names a server's tools `mcp__<key>__…`: anything not a letter, digit, `_` or `-` becomes `_`. */
export function serverKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
const name = (v: unknown): string | null => (typeof v === 'string' && NAME.test(v) ? v : null);
const word = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/.test(v) ? v : null);
const byTokens = <T extends { tokens: number }>(a: T, b: T) => b.tokens - a.tokens;

/** `mcp_status`'s answer: each server's name, status and scope — nothing else of it is kept. */
export function parseMcpStatus(raw: unknown): McpServerStatus[] {
  if (!isObj(raw)) return [];
  const out: McpServerStatus[] = [];
  for (const s of list(raw.mcpServers, MAX_SERVERS)) {
    if (!isObj(s)) continue;
    const n = name(s.name);
    const status = word(s.status);
    if (n === null || status === null) continue;
    out.push({ name: n, status, scope: word(s.scope) });
  }
  return out;
}

const SKILL_SOURCES: Record<string, string> = {
  'built-in': 'built-in', syncedSkills: 'claude.ai', plugin: 'plugin', userSettings: 'user', projectSettings: 'project',
  localSettings: 'local', policySettings: 'managed', bundled: 'bundled', mcp: 'mcp'
};

function groupSkills(kind: 'skill' | 'agent', items: unknown[]): ContextSkills[] {
  const by = new Map<string, ContextSkills>();
  for (const s of items) {
    if (!isObj(s) || name(kind === 'skill' ? s.name : (s.agentType ?? s.name)) === null) continue;
    const raw = word(s.source) ?? 'other';
    const source = SKILL_SOURCES[raw] ?? raw;
    const plugin = source === 'plugin' ? name(s.pluginName) : null;
    const key = `${source}\u0000${plugin ?? ''}`;
    const g = by.get(key) ?? { kind, source, plugin, count: 0, tokens: 0 };
    g.count++;
    g.tokens += count(s.tokens);
    by.set(key, g);
  }
  return [...by.values()];
}

/**
 * `get_context_usage`'s answer with `mcp_status`'s servers, as the view needs it; null when it has no total,
 * no window or no categories (not an answer to read).
 */
export function parseContextUsage(raw: unknown, status: readonly McpServerStatus[], at: number): ContextReport | null {
  if (!isObj(raw)) return null;
  const total = count(raw.totalTokens);
  const max = count(raw.maxTokens);
  const cats = list(raw.categories, 100).filter(isObj);
  if (max === 0 || cats.length === 0) return null;

  const groups: Record<ContextGroupId, number> = { system: 0, messages: 0, mcp: 0, memory: 0, skills: 0 };
  const system: ContextRow[] = [];
  const deferred = { mcp: 0, system: 0 };
  let buffer = 0;
  let free = 0;
  for (const c of cats) {
    const id = typeof c.id === 'string' ? c.id : '';
    const tokens = count(c.tokens);
    switch (id) {
      case 'system_prompt': case 'system_tools': groups.system += tokens; system.push({ name: name(c.name) ?? id, tokens }); break;
      case 'messages': groups.messages += tokens; break;
      case 'mcp_tools': case 'mcp_instructions': groups.mcp += tokens; break;
      case 'memory_files': groups.memory += tokens; break;
      case 'skills': case 'custom_agents': groups.skills += tokens; break;
      case 'mcp_tools_deferred': deferred.mcp += tokens; break;
      case 'system_tools_deferred': deferred.system += tokens; break;
      case 'autocompact_buffer': buffer += tokens; break;
      case 'free_space': free += tokens; break;
      default: {
        // A category this version doesn't know: in System by its own name when it is in use; anything else is ignored.
        const n = name(c.name);
        if (c.kind === 'used' && n !== null && tokens > 0) { groups.system += tokens; system.push({ name: n, tokens }); }
      }
    }
  }

  // MCP servers: mcp_status's names and scopes, instructions and tools joined by the tool prefix.
  const servers = new Map<string, ContextServer>();
  const offline: { name: string; status: string }[] = [];
  const server = (key: string, shown: string | null): ContextServer | null => {
    let s = servers.get(key);
    if (!s) {
      if (servers.size >= MAX_SERVERS) return null;
      s = { name: shown ?? key, key, scope: null, instructions: 0, loaded: [], deferredCount: 0, deferredTokens: 0, inContext: 0, configFile: null, configShown: null };
      servers.set(key, s);
    } else if (shown !== null && s.name === s.key) s.name = shown;
    return s;
  };
  const down = new Set<string>();
  for (const st of status) {
    if (st.status !== 'connected') { offline.push({ name: st.name, status: st.status }); down.add(serverKey(st.name)); continue; }
    const s = server(serverKey(st.name), st.name);
    if (s) s.scope = st.scope;
  }
  for (const i of list(raw.mcpInstructions, MAX_SERVERS)) {
    if (!isObj(i)) continue;
    const n = name(i.serverName);
    if (n === null || down.has(serverKey(n))) continue;
    const s = server(serverKey(n), n);
    if (s) s.instructions += count(i.tokens);
  }
  for (const t of list(raw.mcpTools, MAX_TOOLS)) {
    if (!isObj(t)) continue;
    const full = name(t.name);
    const srv = name(t.serverName);
    if (full === null || srv === null) continue;
    const key = serverKey(srv);
    if (down.has(key)) continue;
    const s = server(key, null);
    if (!s) continue;
    const tokens = count(t.tokens);
    if (t.isLoaded === true) s.loaded.push({ name: full.startsWith(`mcp__${key}__`) ? full.slice(key.length + 7) || full : full, tokens });
    else { s.deferredCount++; s.deferredTokens += tokens; }
  }
  for (const s of servers.values()) {
    s.loaded.sort(byTokens);
    s.inContext = s.instructions + s.loaded.reduce((n, t) => n + t.tokens, 0);
  }

  const memory: ContextReport['memory'] = [];
  for (const m of list(raw.memoryFiles, MAX_MEMORY * 2)) {
    if (!isObj(m) || memory.length >= MAX_MEMORY) continue;
    const path = typeof m.path === 'string' && m.path.length <= 4096 && !/[\x00-\x1f\x7f-\x9f]/.test(m.path) ? m.path : null;
    if (path === null || !(path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path))) continue;
    memory.push({ path, shown: path, type: word(m.type) ?? 'Other', tokens: count(m.tokens) });
  }

  const skillsRaw = isObj(raw.skills) ? list(raw.skills.skillFrontmatter, MAX_SKILLS) : [];
  const skills = [...groupSkills('skill', skillsRaw), ...groupSkills('agent', list(raw.agents, MAX_SKILLS))].sort(byTokens);

  const mb = isObj(raw.messageBreakdown) ? raw.messageBreakdown : {};
  const tools: ContextRow[] = [];
  for (const t of list(mb.toolCallsByType, MAX_MESSAGE_TOOLS)) {
    if (!isObj(t)) continue;
    const n = name(t.name);
    if (n !== null) tools.push({ name: n, tokens: count(t.callTokens) + count(t.resultTokens) });
  }
  tools.sort(byTokens);
  const messages: ContextMessages = {
    tools: tools.slice(0, TOP_TOOLS),
    otherTools: tools.slice(TOP_TOOLS).reduce((n, t) => n + t.tokens, 0),
    toolsTotal: count(mb.toolCallTokens) + count(mb.toolResultTokens),
    user: count(mb.userMessageTokens),
    assistant: count(mb.assistantMessageTokens),
    attachments: count(mb.attachmentTokens),
    other: count(mb.unattributedTokens) + count(mb.redirectedContextTokens)
  };

  const api = isObj(raw.apiUsage) ? raw.apiUsage : null;
  const apiTotal = api ? count(api.input_tokens) + count(api.cache_creation_input_tokens) + count(api.cache_read_input_tokens) : null;
  const threshold = count(raw.autoCompactThreshold);

  return {
    at,
    model: name(raw.model),
    total,
    max,
    autoCompactAt: raw.isAutoCompactEnabled === true && threshold > 0 ? threshold : null,
    apiTotal: apiTotal === 0 ? null : apiTotal,
    resumed: false,
    groups,
    system: system.sort(byTokens),
    deferred,
    buffer,
    free,
    servers: [...servers.values()].sort((a, b) => b.inContext - a.inContext || b.deferredTokens - a.deferredTokens),
    offline,
    memory: memory.sort(byTokens),
    skills,
    messages
  };
}
