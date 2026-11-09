import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { posixRel } from '../support/platform';
import { ALLOWED_TOOLS } from '../../src/main/connectors/clickup/tools';
import { ALLOWED_TOOLS as NOTION_ALLOWED } from '../../src/main/connectors/notion/tools';
import { ALLOWED_TOOLS as JIRA_ALLOWED } from '../../src/main/connectors/jira/tools';

// No connector write path exists in code. The tokens ClickUp and Notion issue can write
// (ClickUp ignores scope=read; Notion has no scopes), so the allowlist is the only barrier: the client's
// `tools.isAllowed` check plus each connector's private Set in its tools.ts. These guards keep everything else from
// going around it:
// - each ToolSet (the TOOLSETS table) is exactly its expected read-only list;
// - `tools/call` (the MCP method) is spelled only in mcp/client.ts, and `callTool` is used only inside a connector
//   directory (no generic "call tool" IPC, nothing in preload/renderer/shared/ipc);
// - no tool name of a connector's family appears anywhere in src/ unless it is on that connector's allowlist (a write
//   tool's name in code is a bug even if unreachable);
// - every file that names a family's tools sits in that connector's directory;
// - only the two transports make HTTP requests from the app: update-net.ts and connectors/net.ts (Electron's net, each
//   with its own session and host allowlist). The one other http user is the OAuth loopback listener (loopback.ts): it
//   only listens, on 127.0.0.1, and never makes a request (checked below). The Docker engine client
//   (src/main/docker/engine.ts) imports node:http too, for GETs over the Unix socket only (its own guards:
//   tests/integration/docker-readonly.test.ts).
const root = join(__dirname, '..', '..');
// Six read tools since 2026-10-19: clickup_get_list (optional) gives the statuses' colors that compact replies lack.
const READ_TOOLS = ['clickup_resolve_assignees', 'clickup_filter_tasks', 'clickup_get_task', 'clickup_get_workspace_hierarchy', 'clickup_search', 'clickup_get_list'];
const MCP_FILE = 'src/main/connectors/mcp/client.ts';
const CONNECTORS_DIR = 'src/main/connectors/';
const NOTION_READ_TOOLS = ['notion-get-self', 'notion-search', 'notion-fetch', 'notion-query-data-sources'];
const JIRA_READ_TOOLS = ['getAccessibleAtlassianResources', 'getJiraCurrentUser', 'listJiraProjects', 'listJiraFilters', 'searchJiraIssuesUsingJql', 'getJiraIssue'];
/** Quoted `notion-…` strings that are not Notion tool names (none today; add each with the reason). */
const NOTION_IGNORED: string[] = [];
/** One row per connector: its directory, the shape of its tool names, its reads. */
const TOOLSETS: { dir: string; pattern: RegExp; allowed: string[]; ignored?: string[] }[] = [
  { dir: 'src/main/connectors/clickup/', pattern: /clickup_[A-Za-z0-9_]+/g, allowed: READ_TOOLS },
  // Quoted strings only: Notion's names have dashes, so a bare pattern would hit CSS classes and imports (`./notion-id`).
  // A catch-all on purpose: any quoted `notion-<words>` in src/ that is not a read tool fails, so a write tool whose
  // verb we never listed cannot slip through. A non-tool string of that shape goes in `ignored`, with a reason.
  { dir: 'src/main/connectors/notion/', allowed: NOTION_READ_TOOLS, ignored: NOTION_IGNORED, pattern: /['"`]notion-[a-z0-9_]+(?:-[a-z0-9_]+)*['"`]/g },
  // Atlassian's names are camelCase: any quoted name of a Jira/Confluence/… tool, and the
  // discover/execute family (a generic call by another name) — none of which Atelier may send.
  { dir: 'src/main/connectors/jira/', allowed: JIRA_READ_TOOLS, pattern: /['"`](?:[a-z][A-Za-z]*(?:Jira|Confluence|Compass|Atlassian|Rovo|Loom|Bitbucket)[A-Za-z]*|discover|execute(?:Read|Write|Destructive))['"`]/g }
];
const LOOPBACK_FILE = 'src/main/connectors/oauth/loopback.ts';
const DOCKER_ENGINE = 'src/main/docker/engine.ts';
const HTTP_ALLOWED = new Set(['src/main/update-net.ts', 'src/main/connectors/net.ts', LOOPBACK_FILE, DOCKER_ENGINE]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx|mts|cts|js|mjs)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

type Source = { path: string; text: string };
/** A match without its quotes (Notion's pattern includes them). */
const bare = (m: string): string => m.replace(/^['"`]|['"`]$/g, '');

/** Each rule returns the offending paths (with what they did), so a test below can prove the rules catch violations. */
const rules = {
  toolsCall: (files: Source[]) => files.filter((f) => f.path !== MCP_FILE && /tools\/call/.test(f.text)).map((f) => f.path),
  callTool: (files: Source[]) => files.filter((f) => !f.path.startsWith(CONNECTORS_DIR) && /\bcallTool\b/.test(f.text)).map((f) => f.path),
  toolNames: (files: Source[], sets = TOOLSETS) => files.flatMap((f) => sets.flatMap((t) =>
    [...f.text.matchAll(t.pattern)].map((m) => m[0]).filter((n) => !t.allowed.includes(bare(n)) && !(t.ignored ?? []).includes(bare(n))).map((n) => `${f.path}: ${n}`))),
  /** A file that names an allowed tool must live in that connector's directory (its tools.ts, its tests, its fakes). */
  toolHomes: (files: Source[]) => files.flatMap((f) => TOOLSETS.filter((t) => !f.path.startsWith(t.dir)
    && [...f.text.matchAll(t.pattern)].some((m) => t.allowed.includes(bare(m[0])))).map((t) => `${f.path}: ${t.dir}`)),
  /** A file under a connector directory that uses the client must hand it a ToolSet. */
  toolSetLess: (files: Source[]) => files.filter((f) => f.path.startsWith(CONNECTORS_DIR) && f.path !== MCP_FILE
    && /\bcreateMcpClient\s*\(/.test(f.text) && !/\btools\s*:/.test(f.text)).map((f) => f.path),
  http: (files: Source[]) => files.filter((f) => !HTTP_ALLOWED.has(f.path) && (
    /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|\bnet\.request\b/.test(f.text)
    || /from\s+['"](node:)?(https?|http2|undici)['"]|require\(\s*['"](node:)?(https?|http2|undici)['"]\s*\)/.test(f.text)
    || /import\s*\{[^}]*\bnet\b[^}]*\}\s*from\s*['"]electron['"]/.test(f.text)
  )).map((f) => f.path)
};

const all = (): Source[] => sources(join(root, 'src')).map((p) => ({ path: posixRel(root, p), text: readFileSync(p, 'utf8') }));

describe('Connectors stay read-only', () => {
  test('the allowlist is exactly the six read tools', () => {
    expect([...ALLOWED_TOOLS].sort()).toEqual([...READ_TOOLS].sort());
    expect(TOOLSETS[0]!.allowed).toBe(READ_TOOLS);
    expect(readFileSync(join(root, MCP_FILE), 'utf8')).toContain('if (!o.tools.isAllowed(name)) throw new NotAllowed();');
  });

  test('Notion\'s allowlist is exactly the four read tools', () => {
    expect([...NOTION_ALLOWED].sort()).toEqual([...NOTION_READ_TOOLS].sort());
    expect(TOOLSETS[1]!.allowed).toBe(NOTION_READ_TOOLS);
  });

  test('Jira\'s allowlist is exactly the six read tools', () => {
    expect([...JIRA_ALLOWED].sort()).toEqual([...JIRA_READ_TOOLS].sort());
    expect(TOOLSETS[2]!.allowed).toBe(JIRA_READ_TOOLS);
    const jira = TOOLSETS[2]!;
    for (const bad of ["'createJiraIssue'", '"transitionJiraIssue"', "'executeRead'", "'discover'", "'createConfluencePage'", "'getAccessibleAtlassianResources'"]) {
      expect([...bad.matchAll(jira.pattern)].map((m) => m[0]), bad).toEqual([bad]);
    }
  });

  test('tools/call is spelled only in mcp/client.ts', () => {
    expect(rules.toolsCall(all())).toEqual([]);
  });

  test('callTool is used only inside a connector directory (no generic "call tool" bridge)', () => {
    expect(rules.callTool(all())).toEqual([]);
  });

  test('no tool of a connector family other than its read ones is named anywhere in src/', () => {
    expect(rules.toolNames(all())).toEqual([]);
  });

  test('a connector\'s tool names appear only in its own directory, and every client gets a ToolSet', () => {
    expect(rules.toolHomes(all())).toEqual([]);
    expect(rules.toolSetLess(all())).toEqual([]);
  });

  test('only update-net.ts and connectors/net.ts make HTTP requests (and the Docker client, to its Unix socket)', () => {
    expect(rules.http(all())).toEqual([]);
    expect(readFileSync(join(root, DOCKER_ENGINE), 'utf8')).toMatch(/request\(\{ socketPath: socket, path, method: 'GET'/);
  });

  test('the OAuth loopback listener only listens, on 127.0.0.1, and never makes a request', () => {
    const text = readFileSync(join(root, LOOPBACK_FILE), 'utf8');
    const httpImports = [...text.matchAll(/from\s+['"](?:node:)?https?['"]/g)];
    expect(httpImports).toHaveLength(1);
    expect(text).toContain("import { createServer, type Server } from 'node:http';");
    // The port is the OS's pick (0) or one a CIMD document lists; the host never changes.
    expect([...text.matchAll(/\.listen\(([^)]*)\)/g)].map((m) => m[1])).toEqual(["port, '127.0.0.1'"]);
    expect(text).not.toMatch(/\bfetch\s*\(|\brequest\s*\(|\bhttp\.get\b|\bnet\.request\b|\bconnect\s*\(/);
  });

  test('the rules catch what they guard against', () => {
    const bad: Source[] = [
      { path: 'src/main/ipc.ts', text: "ipcMain.handle('x', () => client.callTool(name, args)); post({ method: 'tools/call' })" },
      { path: 'src/renderer/x.ts', text: "const t = 'clickup_update_task'; fetch('https://x.test')" },
      { path: 'src/main/other.ts', text: "import { net } from 'electron';" },
      { path: 'src/main/other2.ts', text: "import https from 'node:https';" },
      { path: 'src/main/connectors/clickup/clickup.ts', text: "client.callTool('clickup_get_task', {}); const op = 'clickup_execute_operator';" },
      { path: 'src/main/connectors/other/other.ts', text: "const c = createMcpClient({ mcpUrl, allow, transport, token }); c.callTool('x', {});" },
      { path: 'src/main/ipc2.ts', text: "const t = 'clickup_get_task';" }
    ];
    const notion: Source[] = [
      { path: 'src/renderer/x.tsx', text: "const c = 'notion-row'; import { id } from './notion-id'; const k = `notion-card`;" },
      { path: 'src/main/connectors/notion/notion.ts', text: "client.callTool('notion-update-page', {}); const ok = 'notion-fetch';" },
      { path: 'src/main/ipc3.ts', text: 'const t = "notion-search";' }
    ];
    // The catch-all flags every quoted notion-<words> that is not a read tool: a class name too, unless it is ignored.
    expect(rules.toolNames(notion)).toEqual([
      "src/renderer/x.tsx: 'notion-row'", 'src/renderer/x.tsx: `notion-card`', "src/main/connectors/notion/notion.ts: 'notion-update-page'"]);
    const listed = [{ ...TOOLSETS[1]!, ignored: ['notion-row', 'notion-card'] }];
    expect(rules.toolNames(notion, listed)).toEqual(["src/main/connectors/notion/notion.ts: 'notion-update-page'"]);
    expect(NOTION_IGNORED).toEqual([]);
    expect(rules.toolNames([{ path: 'src/main/a.ts', text: "x('notion-add-comment'); y(\"notion-archive-page\")" }]))
      .toEqual(["src/main/a.ts: 'notion-add-comment'", 'src/main/a.ts: "notion-archive-page"']);
    // Digits and underscores too: a future `notion-create_page2` or `notion-v2-delete` must not slip past the shape.
    expect(rules.toolNames([{ path: 'src/main/b.ts', text: "x('notion-create_page2'); y(`notion-v2-delete`)" }]))
      .toEqual(["src/main/b.ts: 'notion-create_page2'", 'src/main/b.ts: `notion-v2-delete`']);
    expect(rules.toolHomes(notion)).toEqual(['src/main/ipc3.ts: src/main/connectors/notion/']);
    expect(rules.toolsCall(bad)).toEqual(['src/main/ipc.ts']);
    expect(rules.callTool(bad)).toEqual(['src/main/ipc.ts']);
    expect(rules.toolNames(bad)).toEqual(['src/renderer/x.ts: clickup_update_task', 'src/main/connectors/clickup/clickup.ts: clickup_execute_operator']);
    expect(rules.toolHomes(bad)).toEqual(['src/main/ipc2.ts: src/main/connectors/clickup/']);
    expect(rules.toolSetLess(bad)).toEqual(['src/main/connectors/other/other.ts']);
    expect(rules.http(bad)).toEqual(['src/renderer/x.ts', 'src/main/other.ts', 'src/main/other2.ts']);
  });
});

// Each connector's transport has its own Electron session (a session has one request filter, so a shared one would
// let the last allowlist installed win): index.ts passes distinct, non-persistent partitions.
describe('connector transports', () => {
  test('main gives each connector its own non-persistent session partition', () => {
    const src = readFileSync(join(root, 'src/main/index.ts'), 'utf8');
    const parts = [...src.matchAll(/connectorDeps\(\w+, '([^']+)'\)/g)].map((m) => m[1]!);
    expect(parts).toHaveLength(3);
    expect(new Set(parts).size).toBe(3);
    for (const p of parts) expect(p.startsWith('persist:')).toBe(false);
  });
});
