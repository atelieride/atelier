// The Context usage sheet's fictional numbers in the live demo: what the private
// copy of a session would count. Every session of the fictional user has the same setup — Claude Code's system prompt
// and tools, four MCP servers (and one that failed to start), two memory files, skills — and a conversation as large as
// its status line says (its context %). Data only: the app's parser runs in main, never in the demo. Loaded with the
// sheet (bridge/context-usage.ts), never in the first paint. Relative imports, types only, as the rest of the world.
import { encodeProjectPath } from '../../shared/history';
import type { ContextMessages, ContextReport, ContextRow, ContextServer, ContextSkills } from '../../shared/context-usage';

/** Opus 5.5's window in Claude Code; auto-compact keeps the last 33k free, as it does by default. */
export const CONTEXT_MAX = 1_000_000;
const COMPACT_AT = 967_000;
const BUFFER = CONTEXT_MAX - COMPACT_AT;

const SYSTEM: readonly ContextRow[] = [{ name: 'System tools', tokens: 19_600 }, { name: 'System prompt', tokens: 11_800 }];
const SYSTEM_DEFERRED = 25_400;

type Server = Omit<ContextServer, 'inContext' | 'configFile' | 'configShown'>;
/** Largest in the context first, as main sorts them; tool search keeps most tools outside. */
const SERVERS: readonly Server[] = [
  { name: 'acme-docs', key: 'acme-docs', scope: 'local', instructions: 4_200, loaded: [{ name: 'get_page', tokens: 3_700 }, { name: 'search', tokens: 1_300 }], deferredCount: 2, deferredTokens: 28_200 },
  { name: 'claude.ai Tasks', key: 'claude_ai_Tasks', scope: 'claudeai', instructions: 520, loaded: [{ name: 'search', tokens: 6_100 }], deferredCount: 4, deferredTokens: 41_300 },
  {
    name: 'playwright', key: 'playwright', scope: 'user', instructions: 0,
    loaded: [{ name: 'browser_snapshot', tokens: 2_600 }, { name: 'browser_click', tokens: 1_400 }, { name: 'browser_navigate', tokens: 1_100 }], deferredCount: 18, deferredTokens: 24_600
  },
  { name: 'postgres', key: 'postgres', scope: 'user', instructions: 180, loaded: [{ name: 'query', tokens: 1_900 }], deferredCount: 3, deferredTokens: 4_100 }
];
const OFFLINE = [{ name: 'staging-logs', status: 'failed' }];

const SKILLS: readonly ContextSkills[] = [
  { kind: 'skill', source: 'plugin', plugin: 'review-kit', count: 5, tokens: 3_100 },
  { kind: 'skill', source: 'built-in', plugin: null, count: 2, tokens: 2_300 },
  { kind: 'agent', source: 'built-in', plugin: null, count: 3, tokens: 800 },
  { kind: 'skill', source: 'project', plugin: null, count: 1, tokens: 500 }
];
const AUTO_MEMORY = 4_700;
const USER_MEMORY = 1_200;

const sum = (xs: readonly { tokens: number }[]) => xs.reduce((n, x) => n + x.tokens, 0);
const inContext = (s: Server) => s.instructions + sum(s.loaded);

/** What every session carries before its first prompt: system, MCP servers, memory, skills. */
export const CONTEXT_SETUP = sum(SYSTEM) + SERVERS.reduce((n, s) => n + inContext(s), 0) + AUTO_MEMORY + USER_MEMORY + sum(SKILLS);

const hundreds = (n: number) => Math.round(n / 100) * 100;

/** The context a session at `pct` % uses (its last call's input): never under the setup, never past auto-compact. */
export function contextTokens(pct: number): number {
  return Math.min(COMPACT_AT, Math.max(CONTEXT_SETUP, hundreds((pct / 100) * CONTEXT_MAX)));
}

/** The conversation's parts, in Claude Code's words: tool calls and results by tool, then the rest. */
const TOOL_SHARES: readonly [string, number][] = [['Read', 0.26], ['Bash', 0.19], ['Edit', 0.09], ['Grep', 0.06], ['Glob', 0.03]];
const OTHER_TOOLS = 0.05;

function messagesOf(total: number): ContextMessages {
  if (total === 0) return { tools: [], otherTools: 0, toolsTotal: 0, user: 0, assistant: 0, attachments: 0, other: 0 };
  // Floored, so the parts never pass the whole.
  const part = (share: number) => Math.floor((total * share) / 100) * 100;
  const tools = TOOL_SHARES.map(([name, share]) => ({ name, tokens: part(share) }));
  const otherTools = part(OTHER_TOOLS);
  const toolsTotal = sum(tools) + otherTools;
  const user = part(0.07);
  const attachments = part(0.06);
  const other = part(0.02);
  // The assistant's own words take what rounding left over, so the parts add up to the whole.
  return { tools, otherTools, toolsTotal, user, assistant: total - toolsTotal - user - attachments - other, attachments, other };
}

const shownFrom = (home: string) => (path: string) => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/**
 * The report for a session at `pct` % of the window, on the account whose folder is `configDir` (the default one's
 * settings file sits beside its folder, in the home; another account's inside its own folder, as in main).
 */
export function contextReport(o: { pct: number; configDir: string; home: string; root: string; at: number }): ContextReport {
  const shown = shownFrom(o.home);
  const total = contextTokens(o.pct);
  const settings = o.configDir === `${o.home}/.claude` ? `${o.home}/.claude.json` : `${o.configDir}/.claude.json`;
  const servers: ContextServer[] = SERVERS.map((s) => {
    const configFile = s.scope === 'user' || s.scope === 'local' ? settings : null;
    return { ...s, loaded: s.loaded.map((t) => ({ ...t })), inContext: inContext(s), configFile, configShown: configFile ? shown(configFile) : null };
  });
  const memory = [
    { path: `${o.configDir}/projects/${encodeProjectPath(o.root)}/memory/MEMORY.md`, type: 'AutoMem', tokens: AUTO_MEMORY },
    { path: `${o.configDir}/CLAUDE.md`, type: 'User', tokens: USER_MEMORY }
  ].map((m) => ({ ...m, shown: shown(m.path) }));
  const messages = messagesOf(total - CONTEXT_SETUP);
  const groups = {
    system: sum(SYSTEM),
    messages: total - CONTEXT_SETUP,
    mcp: servers.reduce((n, s) => n + s.inContext, 0),
    memory: AUTO_MEMORY + USER_MEMORY,
    skills: sum(SKILLS)
  };
  return {
    at: o.at,
    model: 'claude-opus-5-5',
    total,
    max: CONTEXT_MAX,
    autoCompactAt: COMPACT_AT,
    apiTotal: total,
    resumed: true,
    groups,
    system: SYSTEM.map((r) => ({ ...r })),
    deferred: { mcp: SERVERS.reduce((n, s) => n + s.deferredTokens, 0), system: SYSTEM_DEFERRED },
    buffer: BUFFER,
    free: CONTEXT_MAX - total - BUFFER,
    servers,
    offline: OFFLINE.map((x) => ({ ...x })),
    memory,
    skills: SKILLS.map((s) => ({ ...s })),
    messages
  };
}
