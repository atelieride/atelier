import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { contextArgs, contextModel, controlLine, parseContextUsage, parseMcpStatus, serverKey, type McpServerStatus } from './context-usage';

const fixture = () => JSON.parse(readFileSync(join(__dirname, '..', '..', 'tests', 'fixtures', 'context', 'usage.json'), 'utf8')) as Record<string, unknown>;

const STATUS: McpServerStatus[] = [
  { name: 'shop-docs', status: 'connected', scope: 'project' },
  { name: 'claude.ai Tasks', status: 'connected', scope: 'claudeai' },
  { name: 'workflows', status: 'connected', scope: 'user' },
  { name: 'postgres-readonly', status: 'connected', scope: 'local' },
  { name: 'analytics', status: 'connected', scope: 'user' },
  { name: 'claude.ai Mail', status: 'needs-auth', scope: 'claudeai' },
  { name: 'broken', status: 'failed', scope: 'user' }
];

describe('contextArgs', () => {
  test('a private copy of the session: stream-json both ways, forked, never saved, no hooks', () => {
    expect(contextArgs({ resume: '6f1c2a3b-0000-4000-8000-000000000001', model: 'opus' })).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--settings', '{"disableAllHooks":true}',
      '--resume', '6f1c2a3b-0000-4000-8000-000000000001', '--fork-session', '--model', 'opus'
    ]);
  });

  test('no transcript yet: no resume; no model known: the account default', () => {
    const args = contextArgs({ resume: null, model: null });
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--fork-session');
    expect(args).not.toContain('--model');
    expect(args).toContain('--no-session-persistence');
  });

  test('refuses an id that could read as a flag or carry anything else, and unknown models', () => {
    expect(() => contextArgs({ resume: '--dangerously-skip-permissions', model: null })).toThrow();
    expect(() => contextArgs({ resume: 'abc def', model: null })).toThrow();
    expect(() => contextArgs({ resume: null, model: 'opus --x' as 'opus' })).toThrow();
  });
});

test('contextModel: the alias in the status line\'s model name, else none', () => {
  expect(contextModel('Opus 5.5')).toBe('opus');
  expect(contextModel('Sonnet 5.5 (1M context)')).toBe('sonnet');
  expect(contextModel('claude-haiku-5-5')).toBe('haiku');
  expect(contextModel('Mystery 1')).toBeNull();
  expect(contextModel(null)).toBeNull();
});

test('controlLine: one JSON line per control request', () => {
  expect(controlLine('ctx-1', 'get_context_usage')).toBe('{"type":"control_request","request_id":"ctx-1","request":{"subtype":"get_context_usage"}}\n');
});

describe('parseMcpStatus', () => {
  test('names, statuses and scopes only: never a config, URL or command', () => {
    const raw = { mcpServers: [{ name: 'atlas', status: 'connected', config: { type: 'http', url: 'https://secret.example/mcp?token=x' }, transport: 'http', urlHost: 'secret.example', scope: 'user', source: 'user' }] };
    const out = parseMcpStatus(raw);
    expect(out).toEqual([{ name: 'atlas', status: 'connected', scope: 'user' }]);
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  test('anything malformed is dropped or empty, never a throw', () => {
    expect(parseMcpStatus(null)).toEqual([]);
    expect(parseMcpStatus({ mcpServers: 'x' })).toEqual([]);
    expect(parseMcpStatus({ mcpServers: [{ name: 3 }, { name: 'ok', status: 'pending' }] })).toEqual([{ name: 'ok', status: 'pending', scope: null }]);
  });
});

test('serverKey: Claude Code tool prefix rule (anything not a letter, digit, _ or - becomes _)', () => {
  expect(serverKey('claude.ai Tasks')).toBe('claude_ai_Tasks');
  expect(serverKey('postgres-readonly')).toBe('postgres-readonly');
});

describe('parseContextUsage', () => {
  const report = parseContextUsage(fixture(), STATUS, 1_000)!;

  test('totals, window, auto-compact and the last API call', () => {
    expect(report).toMatchObject({ at: 1_000, model: 'claude-opus-5-5', total: 103_300, max: 1_000_000, autoCompactAt: 967_000, buffer: 33_000, free: 863_700 });
    // Not resumed until main says it read the conversation.
    expect(report.resumed).toBe(false);
    expect(report.apiTotal).toBe(2 + 2501 + 99_351);
  });

  test('five groups from the categories; deferred tools stay out of them', () => {
    expect(report.groups).toEqual({ system: 31_400, messages: 26_700, mcp: 19_400, memory: 17_800, skills: 8_000 });
    expect(report.deferred).toEqual({ mcp: 128_700, system: 25_400 });
    expect(report.system).toEqual([{ name: 'System tools', tokens: 19_600 }, { name: 'System prompt', tokens: 11_800 }]);
  });

  test('an unknown used category counts in System by its own name; unknown kinds are ignored', () => {
    const raw = fixture();
    (raw.categories as unknown[]).push({ id: 'brand_new', name: 'Brand new', tokens: 500, kind: 'used' }, { id: 'weird', name: 'Weird', tokens: 9, kind: 'other' });
    const r = parseContextUsage(raw, STATUS, 0)!;
    expect(r.groups.system).toBe(31_900);
    expect(r.system).toContainEqual({ name: 'Brand new', tokens: 500 });
  });

  test('MCP servers: instructions and tools joined by the tool prefix, the pretty name kept, by what is in context', () => {
    expect(report.servers.map((s) => [s.name, s.scope, s.inContext, s.loaded.length, s.deferredCount, s.deferredTokens])).toEqual([
      ['shop-docs', 'project', 640 + 2400 + 1300 + 3700, 3, 2, 28_200],
      ['claude.ai Tasks', 'claudeai', 520 + 6100, 1, 1, 35_700],
      ['workflows', 'user', 410 + 2300, 1, 1, 47_000],
      ['postgres-readonly', 'local', 180 + 1400, 1, 1, 900],
      ['analytics', 'user', 450, 0, 1, 16_900]
    ]);
    const docs = report.servers[0]!;
    expect(docs.instructions).toBe(640);
    // Short tool names (the server's prefix dropped), largest first.
    expect(docs.loaded).toEqual([{ name: 'get_page', tokens: 3700 }, { name: 'query', tokens: 2400 }, { name: 'search', tokens: 1300 }]);
  });

  test('servers not connected are listed apart with their status, and cost nothing', () => {
    expect(report.offline).toEqual([{ name: 'claude.ai Mail', status: 'needs-auth' }, { name: 'broken', status: 'failed' }]);
    // A server still connecting when the copy was asked is listed as such (the view says it wasn't counted).
    const slow = parseContextUsage(fixture(), [...STATUS.slice(0, 4), { name: 'analytics', status: 'pending', scope: 'user' }], 0)!;
    expect(slow.offline).toEqual([{ name: 'analytics', status: 'pending' }]);
    expect(slow.servers.some((s) => s.name === 'analytics')).toBe(false);
    expect(report.servers.some((s) => s.name === 'broken')).toBe(false);
  });

  test('memory files with their type; a path that is not absolute or not printable is dropped', () => {
    // Shown as the path until main puts ~ for the home.
    expect(report.memory.every((m) => m.shown === m.path)).toBe(true);
    expect(report.servers.every((s) => s.configFile === null && s.configShown === null)).toBe(true);
    expect(report.memory.map((m) => [m.path, m.type, m.tokens])).toEqual([
      ['/Users/dev/Code/shop/CLAUDE.md', 'Project', 9800],
      ['/Users/dev/.claude/projects/-Users-dev-Code-shop/memory/MEMORY.md', 'AutoMem', 4700],
      ['/Users/dev/Code/shop/apps/sales/CLAUDE.md', 'Project', 2100],
      ['/Users/dev/.claude/CLAUDE.md', 'User', 1200]
    ]);
    const raw = fixture();
    (raw.memoryFiles as unknown[]).push({ path: 'relative/CLAUDE.md', type: 'Project', tokens: 1 }, { path: '/x\u0007y', type: 'Project', tokens: 1 });
    expect(parseContextUsage(raw, STATUS, 0)!.memory).toHaveLength(4);
  });

  test('skills by source (plugins by name) and agents, largest first', () => {
    expect(report.skills).toEqual([
      { kind: 'skill', source: 'claude.ai', plugin: null, count: 2, tokens: 3400 },
      { kind: 'skill', source: 'built-in', plugin: null, count: 1, tokens: 1900 },
      { kind: 'skill', source: 'plugin', plugin: 'review-tools', count: 1, tokens: 1600 },
      { kind: 'skill', source: 'project', plugin: null, count: 1, tokens: 500 },
      { kind: 'agent', source: 'project', plugin: null, count: 1, tokens: 400 },
      { kind: 'agent', source: 'user', plugin: null, count: 1, tokens: 200 }
    ]);
  });

  test('messages: tools by calls plus results (top five, the rest summed), then who wrote what', () => {
    expect(report.messages).toEqual({
      tools: [{ name: 'Bash', tokens: 6100 }, { name: 'Read', tokens: 5300 }, { name: 'mcp__shop-docs__query', tokens: 2800 }],
      otherTools: 0, toolsTotal: 14_200, user: 4900, assistant: 3800, attachments: 3800, other: 0
    });
    const raw = fixture();
    const mb = raw.messageBreakdown as { toolCallsByType: unknown[] };
    for (let i = 0; i < 4; i++) mb.toolCallsByType.push({ name: `T${i}`, callTokens: 10, resultTokens: 90 - i });
    const m = parseContextUsage(raw, STATUS, 0)!.messages;
    expect(m.tools.map((x) => x.name)).toEqual(['Bash', 'Read', 'mcp__shop-docs__query', 'T0', 'T1']);
    // The four weigh 100, 99, 98, 97: the last two are the rest.
    expect(m.otherTools).toBe(98 + 97);
  });

  test('auto-compact off: no threshold', () => {
    const raw = { ...fixture(), isAutoCompactEnabled: false };
    expect(parseContextUsage(raw, STATUS, 0)!.autoCompactAt).toBeNull();
  });

  test('missing parts are empty, never a crash; no categories or no total is no report', () => {
    const r = parseContextUsage({ categories: [{ id: 'messages', name: 'Messages', tokens: 10, kind: 'used' }], totalTokens: 10, maxTokens: 200_000 }, [], 0)!;
    expect(r).toMatchObject({ total: 10, max: 200_000, apiTotal: null, autoCompactAt: null, servers: [], memory: [], skills: [], offline: [] });
    expect(r.groups.messages).toBe(10);
    expect(parseContextUsage(null, [], 0)).toBeNull();
    expect(parseContextUsage({ categories: [] }, [], 0)).toBeNull();
    expect(parseContextUsage({ totalTokens: 5, maxTokens: 0, categories: [] }, [], 0)).toBeNull();
  });

  test('caps: at most 500 tools read, 100 servers, 200 memory files; names over 200 characters dropped', () => {
    const raw = fixture();
    raw.mcpTools = Array.from({ length: 700 }, (_, i) => ({ name: `mcp__s${i % 150}__t${i}`, serverName: `s${i % 150}`, tokens: 1, isLoaded: true }));
    raw.mcpInstructions = [];
    (raw.memoryFiles as unknown[]) = Array.from({ length: 300 }, (_, i) => ({ path: `/m/${i}.md`, type: 'Project', tokens: 1 }));
    (raw.skills as { skillFrontmatter: unknown[] }).skillFrontmatter.push({ name: 'x'.repeat(201), source: 'built-in', tokens: 5 });
    const r = parseContextUsage(raw, [], 0)!;
    expect(r.servers.length).toBeLessThanOrEqual(100);
    expect(r.servers.reduce((n, s) => n + s.loaded.length, 0)).toBeLessThanOrEqual(500);
    expect(r.memory).toHaveLength(200);
    expect(r.skills.find((s) => s.source === 'built-in')!.count).toBe(1);
  });
});
