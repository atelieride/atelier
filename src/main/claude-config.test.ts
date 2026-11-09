import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { posixTest } from '../../tests/support/platform';
import { MAX_CONFIG_BYTES, MAX_ITEMS, claudeConfigFor, claudeConfigRoots, claudeReducesMotion, claudeTrusts, configRoots, configRootsFor, mcpConfigFiles, readClaudeConfig, sourceInClaude } from './claude-config';

// Secrets as they sit in real configs: in env, args, headers and URLs. None may ever leave main.
const SECRETS = ['sk-live-ENV-SECRET-1', 'ARG-SECRET-2', 'Bearer HEADER-SECRET-3', 'https://user:URL-SECRET-4@mcp.example.com/sse', 'LOCAL-ENV-SECRET-5', 'PROJECT-HEADER-SECRET-6', 'npx-COMMAND-SECRET-7'];

const put = (path: string, data: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };
const skill = (dir: string) => put(join(dir, 'SKILL.md'), '---\nname: x\n---\n');

/** A fake home (~/.claude, ~/.claude.json) and a project folder, never the user's. */
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'atl-claude-config-')));
  const home = join(base, 'home');
  const project = join(base, 'project');
  mkdirSync(project, { recursive: true });
  const configDir = join(home, '.claude');
  const globalFile = join(home, '.claude.json');
  return { base, home, project, configDir, globalFile, roots: { configDir, globalFile } };
}

function full() {
  const f = fixture();
  put(f.globalFile, {
    numStartups: 12,
    mcpServers: {
      github: { type: 'stdio', command: SECRETS[6], args: ['-y', SECRETS[1]], env: { GITHUB_TOKEN: SECRETS[0] } },
      linear: { type: 'sse', url: SECRETS[3], headers: { Authorization: SECRETS[2] } }
    },
    projects: {
      [f.project]: {
        mcpServers: { postgres: { command: 'pg', env: { PGPASSWORD: SECRETS[4] } } },
        disabledMcpServers: ['linear'],
        enabledMcpjsonServers: ['sentry'],
        history: [{ display: 'old prompt' }]
      },
      '/elsewhere': { mcpServers: { 'other-project-only': { command: 'x' } } }
    }
  });
  put(join(f.configDir, 'settings.json'), { model: 'opus', enabledPlugins: { 'review-tools@official': true, 'old-thing@official': false } });
  put(join(f.project, '.mcp.json'), {
    mcpServers: {
      sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp', headers: { Authorization: SECRETS[5] } },
      figma: { type: 'http', url: 'https://figma.example/mcp' },
      noisy: { command: 'n' }
    }
  });
  put(join(f.project, '.claude', 'settings.json'), { disabledMcpjsonServers: ['noisy'], enabledPlugins: { 'project-tool@team': true } });
  put(join(f.project, '.claude', 'settings.local.json'), { enabledPlugins: { 'review-tools@official': false } });
  skill(join(f.configDir, 'skills', 'release-notes'));
  skill(join(f.configDir, 'skills', 'deploy'));
  mkdirSync(join(f.configDir, 'skills', 'not-a-skill'), { recursive: true });
  put(join(f.configDir, 'skills', 'README.md'), 'a file, not a skill');
  skill(join(f.project, '.claude', 'skills', 'house-style'));
  const installed = join(f.configDir, 'plugins', 'cache', 'official', 'review-tools', '5.0.0');
  skill(join(installed, 'skills', 'brainstorming'));
  skill(join(installed, 'skills', 'writing-plans'));
  put(join(f.configDir, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'review-tools@official': [{ scope: 'user', installPath: installed, version: '5.0.0' }],
      'old-thing@official': [{ scope: 'user', installPath: join(f.configDir, 'plugins', 'cache', 'official', 'old-thing', '1.0.0') }]
    }
  });
  return f;
}

const names = (l: { name: string }[]) => l.map((x) => x.name);

describe('claudeConfigRoots', () => {
  // POSIX: POSIX home fixtures through node:path.
  posixTest('~/.claude and ~/.claude.json by default', () => {
    expect(claudeConfigRoots({}, '/Users/me')).toEqual({ configDir: '/Users/me/.claude', globalFile: '/Users/me/.claude.json' });
  });
  // POSIX: POSIX home fixtures through node:path.
  posixTest('CLAUDE_CONFIG_DIR moves both (Claude Code keeps .claude.json inside it then)', () => {
    expect(claudeConfigRoots({ CLAUDE_CONFIG_DIR: '/cfg/claude' }, '/Users/me')).toEqual({ configDir: '/cfg/claude', globalFile: '/cfg/claude/.claude.json' });
    expect(claudeConfigRoots({ CLAUDE_CONFIG_DIR: '' }, '/Users/me').configDir).toBe('/Users/me/.claude');
  });
  // POSIX: POSIX home fixtures through node:path.
  posixTest('configRootsFor: another account\'s dir holds both; none is the default', () => {
    expect(configRootsFor('/Users/me/.claude_ops')).toEqual({ configDir: '/Users/me/.claude_ops', globalFile: '/Users/me/.claude_ops/.claude.json' });
    expect(configRootsFor(undefined)).toEqual(configRoots());
  });
  // POSIX: POSIX home fixtures through node:path.
  posixTest('mcpConfigFiles: the files that set up a folder\'s MCP servers; no folder, the user\'s', () => {
    const roots = { configDir: '/Users/me/.claude', globalFile: '/Users/me/.claude.json' };
    expect(mcpConfigFiles(roots, '/p/app')).toEqual(['/Users/me/.claude.json', '/Users/me/.claude/settings.json', '/p/app/.claude/settings.json', '/p/app/.claude/settings.local.json', '/p/app/.mcp.json']);
    expect(mcpConfigFiles(roots, null)).toEqual(['/Users/me/.claude.json', '/Users/me/.claude/settings.json']);
  });
  test('tests read a fake home (ATELIER_TEST_CLAUDE_HOME, set for every unit test), never the user\'s', () => {
    expect(process.env.ATELIER_TEST_CLAUDE_HOME).toBeTruthy();
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/should/not/be/used';
    try {
      expect(configRoots()).toEqual({ configDir: join(process.env.ATELIER_TEST_CLAUDE_HOME!, '.claude'), globalFile: join(process.env.ATELIER_TEST_CLAUDE_HOME!, '.claude.json') });
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });
});

describe('readClaudeConfig', () => {
  test('MCP servers of every scope, with their state; the project entry of ~/.claude.json only for this folder', async () => {
    const f = full();
    const c = await readClaudeConfig(f.roots, f.project);
    expect(c.unreadable).toBe(false);
    expect(c.mcpServers).toEqual([
      { name: 'figma', scope: 'project', state: 'approval' },
      { name: 'github', scope: 'user', state: 'enabled' },
      { name: 'linear', scope: 'user', state: 'disabled' },
      { name: 'noisy', scope: 'project', state: 'disabled' },
      { name: 'postgres', scope: 'local', state: 'enabled' },
      { name: 'sentry', scope: 'project', state: 'enabled' }
    ]);
    expect(names(c.mcpServers)).not.toContain('other-project-only');
  });

  test('enableAllProjectMcpServers approves every .mcp.json server not disabled', async () => {
    const f = full();
    put(join(f.project, '.claude', 'settings.local.json'), { enableAllProjectMcpServers: true });
    const c = await readClaudeConfig(f.roots, f.project);
    expect(c.mcpServers.filter((x) => x.scope === 'project')).toEqual([
      { name: 'figma', scope: 'project', state: 'enabled' },
      { name: 'noisy', scope: 'project', state: 'disabled' },
      { name: 'sentry', scope: 'project', state: 'enabled' }
    ]);
  });

  // POSIX: POSIX home fixtures through node:path.
  posixTest('skills: folders with a SKILL.md, user and project, plus the skills of installed plugins (named plugin:skill)', async () => {
    const f = full();
    const c = await readClaudeConfig(f.roots, f.project);
    expect(c.skills).toEqual([
      { name: 'deploy', scope: 'user', state: 'enabled' },
      { name: 'house-style', scope: 'project', state: 'enabled' },
      { name: 'release-notes', scope: 'user', state: 'enabled' },
      // review-tools is turned off for this folder (settings.local.json): its skills too.
      { name: 'review-tools:brainstorming', scope: 'plugin', state: 'disabled' },
      { name: 'review-tools:writing-plans', scope: 'plugin', state: 'disabled' }
    ]);
  });

  test('plugins: installed or named in enabledPlugins, local over project over user', async () => {
    const f = full();
    const c = await readClaudeConfig(f.roots, f.project);
    expect(c.plugins).toEqual([
      { name: 'old-thing@official', scope: 'user', state: 'disabled' },
      { name: 'project-tool@team', scope: 'project', state: 'enabled' },
      { name: 'review-tools@official', scope: 'local', state: 'disabled' }
    ]);
  });

  test('never a command, an arg, an env value, a header or a URL in what goes to the renderer', async () => {
    const f = full();
    const out = JSON.stringify(await readClaudeConfig(f.roots, f.project));
    for (const s of [...SECRETS, 'mcp.sentry.dev', 'figma.example', 'GITHUB_TOKEN', 'PGPASSWORD', 'Authorization', 'old prompt', f.configDir, 'installPath']) expect(out).not.toContain(s);
    // Only these keys, all the way down.
    const keys = new Set<string>();
    JSON.parse(out, (k, v) => { if (k && !/^\d+$/.test(k)) keys.add(k); return v as unknown; });
    expect([...keys].sort()).toEqual(['mcpServers', 'name', 'plugins', 'project', 'scope', 'skills', 'state', 'unreadable']);
  });

  test('nothing configured: empty lists, not an error', async () => {
    const f = fixture();
    expect(await readClaudeConfig(f.roots, f.project)).toEqual({ mcpServers: [], skills: [], plugins: [], unreadable: false, project: true });
  });

  // POSIX: POSIX home fixtures through node:path.
  posixTest('a folder main refuses (outside the project, gone, inside .git): the user scope only, and it says so — not "unreadable"', async () => {
    const f = full();
    const outside = join(f.base, 'elsewhere');
    put(join(outside, '.mcp.json'), { mcpServers: { outsider: { command: 'x' } } });
    for (const cwd of [outside, join(f.project, 'gone'), join(f.project, '.git')]) {
      if (cwd.endsWith('.git')) put(join(cwd, '.mcp.json'), { mcpServers: { gitty: { command: 'x' } } });
      const c = await claudeConfigFor(f.roots, f.project, cwd);
      expect(c.project).toBe(false);
      expect(c.unreadable).toBe(false);
      expect(c.mcpServers).toEqual([{ name: 'github', scope: 'user', state: 'enabled' }, { name: 'linear', scope: 'user', state: 'enabled' }]);
      expect(names(c.skills)).toEqual(['deploy', 'release-notes', 'review-tools:brainstorming', 'review-tools:writing-plans']);
      expect(names(c.plugins)).toEqual(['old-thing@official', 'review-tools@official']);
    }
    // Inside the project: everything, as before.
    const inside = await claudeConfigFor(f.roots, f.project, f.project);
    expect(inside.project).toBe(true);
    expect(names(inside.mcpServers)).toContain('postgres');
  });

  test.each([
    ['broken JSON', '{ "mcpServers": { "a": '],
    ['the wrong shape', JSON.stringify({ mcpServers: ['a', 'b'] })],
    ['not an object', '[1, 2, 3]']
  ])('a malformed file (%s) is reported, the others still read', async (_label, text) => {
    const f = full();
    put(join(f.project, '.mcp.json'), text);
    const c = await readClaudeConfig(f.roots, f.project);
    expect(c.unreadable).toBe(true);
    expect(names(c.mcpServers)).toEqual(['github', 'linear', 'postgres']);
    expect(names(c.plugins)).toContain('project-tool@team');
  });

  test('an oversized file is skipped unread and reported', async () => {
    const f = full();
    put(join(f.configDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'big@x': true }, pad: 'x'.repeat(MAX_CONFIG_BYTES) }));
    const c = await readClaudeConfig(f.roots, f.project);
    expect(c.unreadable).toBe(true);
    expect(names(c.plugins)).not.toContain('big@x');
  });

  // POSIX: POSIX home fixtures through node:path.
  posixTest('an unreadable file is reported', async () => {
    const f = full();
    const p = join(f.project, '.claude', 'settings.json');
    chmodSync(p, 0o000);
    try {
      const c = await readClaudeConfig(f.roots, f.project);
      expect(c.unreadable).toBe(true);
      expect(names(c.plugins)).not.toContain('project-tool@team');
    } finally { chmodSync(p, 0o644); }
  });

  test('names that are not plain text are dropped; every list is capped', async () => {
    const f = fixture();
    const many = Object.fromEntries(Array.from({ length: MAX_ITEMS + 50 }, (_, i) => [`s${String(i).padStart(4, '0')}`, { command: 'x' }]));
    put(f.globalFile, { mcpServers: { ...many, ['bad' + String.fromCharCode(27) + '[31m']: { command: 'x' }, ['x'.repeat(300)]: { command: 'x' } } });
    const c = await readClaudeConfig(f.roots, f.project);
    expect(c.mcpServers).toHaveLength(MAX_ITEMS);
    expect(c.mcpServers.some((x) => x.name.includes(String.fromCharCode(27)) || x.name.length > 100)).toBe(false);
  });

  test('a plugin installPath outside the plugins folder is never listed', async () => {
    const f = full();
    const outside = join(f.base, 'outside-plugin');
    skill(join(outside, 'skills', 'sneaky'));
    put(join(f.configDir, 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'evil@x': [{ installPath: outside }] } });
    put(join(f.configDir, 'settings.json'), { enabledPlugins: { 'evil@x': true } });
    const c = await readClaudeConfig(f.roots, f.project);
    expect(names(c.skills).some((n) => n.includes('sneaky'))).toBe(false);
    // Through a symlink inside the plugins folder too.
    symlinkSync(outside, join(f.configDir, 'plugins', 'link'));
    put(join(f.configDir, 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'evil@x': [{ installPath: join(f.configDir, 'plugins', 'link') }] } });
    const d = await readClaudeConfig(f.roots, f.project);
    expect(names(d.skills).some((n) => n.includes('sneaky'))).toBe(false);
  });

  // POSIX: POSIX home fixtures through node:path.
  posixTest('installed_plugins.json version 1 (one entry per plugin)', async () => {
    const f = full();
    const installed = join(f.configDir, 'plugins', 'cache', 'official', 'review-tools', '5.0.0');
    put(join(f.configDir, 'plugins', 'installed_plugins.json'), { version: 1, plugins: { 'review-tools@official': { installPath: installed } } });
    put(join(f.project, '.claude', 'settings.local.json'), {});
    const c = await readClaudeConfig(f.roots, f.project);
    expect(c.skills.filter((x) => x.scope === 'plugin')).toEqual([
      { name: 'review-tools:brainstorming', scope: 'plugin', state: 'enabled' },
      { name: 'review-tools:writing-plans', scope: 'plugin', state: 'enabled' }
    ]);
  });

  test('~/.claude.json\'s entry is found under the folder\'s real path too', async () => {
    const f = full();
    const link = join(f.base, 'linked-project');
    symlinkSync(f.project, link);
    const c = await readClaudeConfig(f.roots, link);
    expect(c.mcpServers.find((x) => x.name === 'postgres')).toEqual({ name: 'postgres', scope: 'local', state: 'enabled' });
  });
});

describe('claudeTrusts: the trust dialog was accepted for the folder or a parent', () => {
  test('the folder itself, or a parent (a run\'s worktree inherits its project\'s trust)', async () => {
    const f = fixture();
    put(f.globalFile, { projects: { [f.project]: { hasTrustDialogAccepted: true }, '/elsewhere': { hasTrustDialogAccepted: true } } });
    const wt = join(f.project, '.claude', 'worktrees', 'auto-cu-1');
    mkdirSync(wt, { recursive: true });
    expect(await claudeTrusts(f.roots, f.project)).toBe('trusted');
    expect(await claudeTrusts(f.roots, wt)).toBe('trusted');
  });

  test('a git repository: its own root decides, never a folder above it (Claude Code asks there even then)', async () => {
    // Measured with Claude Code 2.1.302 (2026-10-19): a repository inside a trusted folder still shows the dialog; its
    // worktrees, wherever they are, follow the main checkout's root once that is trusted.
    const f = fixture();
    put(f.globalFile, { projects: { [f.base]: { hasTrustDialogAccepted: true } } });
    expect(await claudeTrusts(f.roots, f.project, { gitRoot: true })).toBe('untrusted');
    expect(await claudeTrusts(f.roots, f.project)).toBe('trusted');
    put(f.globalFile, { projects: { [f.project]: { hasTrustDialogAccepted: true } } });
    expect(await claudeTrusts(f.roots, f.project, { gitRoot: true })).toBe('trusted');
  });

  test('Windows: the keys as Claude Code writes them (C:/…) match any case and either separator', async () => {
    const f = fixture();
    put(f.globalFile, { projects: { 'C:/dev/p2-proj/acme': { hasTrustDialogAccepted: true } } });
    initPlatform('win32');
    try {
      expect(await claudeTrusts(f.roots, 'c:\\Dev\\P2-proj\\acme', { gitRoot: true })).toBe('trusted');
      expect(await claudeTrusts(f.roots, 'C:/dev/p2-proj/acme/sub')).toBe('trusted');
      expect(await claudeTrusts(f.roots, 'C:/dev/p2-proj/other', { gitRoot: true })).toBe('untrusted');
    } finally {
      resetPlatformForTests();
    }
  });

  test('not accepted, accepted false, or no entry: untrusted; no file at all: untrusted', async () => {
    const f = fixture();
    put(f.globalFile, { projects: { [f.project]: { hasTrustDialogAccepted: false }, [f.base]: { allowedTools: [] } } });
    expect(await claudeTrusts(f.roots, f.project)).toBe('untrusted');
    expect(await claudeTrusts(fixture().roots, f.project)).toBe('untrusted');
  });

  test('a file Atelier can\'t read: unknown (the run may still start; the runner watches for it)', async () => {
    const f = fixture();
    put(f.globalFile, '{ not json');
    expect(await claudeTrusts(f.roots, f.project)).toBe('unknown');
  });

  posixTest('the project reached through a link: its real path counts too', async () => {
    const f = fixture();
    put(f.globalFile, { projects: { [f.project]: { hasTrustDialogAccepted: true } } });
    const link = join(f.base, 'link');
    symlinkSync(f.project, link);
    expect(await claudeTrusts(f.roots, link)).toBe('trusted');
  });
});

describe('sourceInClaude: the task source in Claude Code, for one account and project', () => {
  test('a claude.ai connector the account connected: found, with the server name its tools carry', async () => {
    const f = fixture();
    put(f.globalFile, { claudeAiMcpEverConnected: ['claude.ai Claude Docs', 'claude.ai ClickUp'] });
    expect(await sourceInClaude(f.roots, f.project, 'clickup')).toEqual({ state: 'found', name: 'claude.ai ClickUp', servers: ['claude_ai_ClickUp'] });
    expect(await sourceInClaude(f.roots, f.project, 'notion')).toEqual({ state: 'notFound', servers: [] });
  });

  test('a server in the user\'s or the project\'s config: found too (names only, never URLs)', async () => {
    const f = fixture();
    put(f.globalFile, { mcpServers: { 'clickup-mcp': { type: 'http', url: 'https://mcp.clickup.com/mcp' } }, projects: { [f.project]: { mcpServers: { notion: { command: 'x' } } } } });
    expect(await sourceInClaude(f.roots, f.project, 'clickup')).toEqual({ state: 'found', name: 'clickup-mcp', servers: ['clickup-mcp'] });
    expect(await sourceInClaude(f.roots, f.project, 'notion')).toEqual({ state: 'found', name: 'notion', servers: ['notion'] });
  });

  test('a server named otherwise is found by its URL\'s host (only the host is read; a look-alike isn\'t)', async () => {
    const f = fixture();
    put(f.globalFile, { mcpServers: {
      tasks: { type: 'http', url: 'https://mcp.clickup.com/mcp' }, docs: { type: 'sse', url: 'https://user:URL-SECRET-4@mcp.notion.com/sse' },
      fake: { type: 'http', url: 'https://clickup.com.attacker.example/mcp' }, local: { command: 'clickup' }
    } });
    expect(await sourceInClaude(f.roots, f.project, 'clickup')).toEqual({ state: 'found', name: 'tasks', servers: ['tasks'] });
    expect(await sourceInClaude(f.roots, f.project, 'notion')).toEqual({ state: 'found', name: 'docs', servers: ['docs'] });
  });

  test('nothing anywhere: not found; a file that can\'t be read: unknown', async () => {
    const f = fixture();
    put(f.globalFile, { numStartups: 3 });
    expect(await sourceInClaude(f.roots, f.project, 'clickup')).toEqual({ state: 'notFound', servers: [] });
    put(f.globalFile, '{ not json');
    expect(await sourceInClaude(f.roots, f.project, 'clickup')).toEqual({ state: 'unknown', servers: [] });
  });
});

describe('claudeReducesMotion: Claude Code\'s spinner stands still while it works', () => {
  test('prefersReducedMotion true in the account\'s settings.json → true', async () => {
    const f = fixture();
    put(join(f.configDir, 'settings.json'), { prefersReducedMotion: true, model: 'opus' });
    expect(await claudeReducesMotion(f.roots, null)).toBe(true);
  });

  test('or in the folder\'s .claude/settings.json or settings.local.json (Claude Code merges them): any true counts', async () => {
    for (const file of ['settings.json', 'settings.local.json']) {
      const f = fixture();
      put(join(f.configDir, 'settings.json'), { prefersReducedMotion: false });
      put(join(f.project, '.claude', file), { prefersReducedMotion: true });
      expect(await claudeReducesMotion(f.roots, f.project), file).toBe(true);
      // No folder (refused by the caller): the project's files are never read.
      expect(await claudeReducesMotion(f.roots, null), file).toBe(false);
    }
  });

  test('no file, no key, any other value, a broken or oversized file, a folder → false (Claude Code\'s default)', async () => {
    const f = fixture();
    expect(await claudeReducesMotion(f.roots, f.project)).toBe(false);
    const file = join(f.configDir, 'settings.json');
    for (const text of ['{}', '{"prefersReducedMotion":false}', '{"prefersReducedMotion":"true"}', '{"prefersReducedMotion":1}', '{', '', 'true', '[true]']) {
      put(file, text);
      expect(await claudeReducesMotion(f.roots, f.project), text).toBe(false);
    }
    put(file, JSON.stringify({ prefersReducedMotion: true, pad: 'x'.repeat(MAX_CONFIG_BYTES) }));
    expect(await claudeReducesMotion(f.roots, f.project)).toBe(false);
    const g = fixture();
    mkdirSync(join(g.configDir, 'settings.json'), { recursive: true });
    expect(await claudeReducesMotion(g.roots, g.project)).toBe(false);
  });
});
