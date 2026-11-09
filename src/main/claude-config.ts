import { opendir, open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { z } from 'zod';
import type { ClaudeConfig, ConfigScope, ConfigState, ConfiguredItem } from '@shared/claude-config';
import { devEnv } from './dev-env';
import { terminalCwd } from './fs/files';
import { isBelow } from '@shared/paths';
import { pathStyle } from '@shared/platform';
import type { ConnectorId } from '@shared/tasks';

// The Session panel's "Configured" lists: Claude Code's own config files, read-only, in main. Only names
// and enabled state leave this module: commands, args, env, headers and URLs are never even kept (only keys are read).

/** Settings files, .mcp.json, installed_plugins.json: bigger than this is skipped unread (and reported). */
export const MAX_CONFIG_BYTES = 1024 * 1024;
/**
 * ~/.claude.json also holds Claude Code's per-project state (history of earlier versions, stats): it grows past 1 MB on
 * a long-used machine. The cap: 8 MB for that one file.
 */
export const MAX_GLOBAL_BYTES = 8 * 1024 * 1024;
/** At most this many entries per list, and per folder listed. */
export const MAX_ITEMS = 200;
const MAX_DIR_ENTRIES = 500;
/** A name shown as it is: printable, at most 100 characters (else dropped). */
const NAME = /^[^\x00-\x1f\x7f-\x9f]{1,100}$/u;

export interface ConfigRoots { configDir: string; globalFile: string }

/**
 * `CLAUDE_CONFIG_DIR` (main's own environment, never the renderer's) else `~/.claude`; `.claude.json` sits
 * next to `~/.claude` in the home, or inside CLAUDE_CONFIG_DIR when that is set (as Claude Code does).
 */
export function claudeConfigRoots(env: Record<string, string | undefined>, home: string): ConfigRoots {
  const custom = env.CLAUDE_CONFIG_DIR;
  if (custom) return { configDir: custom, globalFile: join(custom, '.claude.json') };
  return { configDir: join(home, '.claude'), globalFile: join(home, '.claude.json') };
}

/** Where the config is read from; tests point it at a fake home (never the user's ~/.claude). */
export function configRoots(): ConfigRoots {
  const test = devEnv('ATELIER_TEST_CLAUDE_HOME');
  return test ? claudeConfigRoots({}, test) : claudeConfigRoots(process.env, homedir());
}

/**
 * The roots of a session's Claude account: another account's dir holds its `.claude.json` (as
 * Claude Code does under CLAUDE_CONFIG_DIR); no dir is the default account's roots.
 */
export function configRootsFor(dir: string | undefined): ConfigRoots {
  return dir ? claudeConfigRoots({ CLAUDE_CONFIG_DIR: dir }, '') : configRoots();
}

// Only the fields used; everything else in the files is ignored. A field of the wrong type makes the file unreadable.
const names = z.array(z.string()).max(10_000);
const serverMap = z.record(z.string(), z.looseObject({}));
const settingsSchema = z.looseObject({
  enabledPlugins: z.record(z.string(), z.union([z.boolean(), z.array(z.string())])).optional(),
  enableAllProjectMcpServers: z.boolean().optional(),
  enabledMcpjsonServers: names.optional(),
  disabledMcpjsonServers: names.optional()
});
const projectEntrySchema = settingsSchema.extend({ mcpServers: serverMap.optional(), disabledMcpServers: names.optional() });
const globalSchema = z.looseObject({ mcpServers: serverMap.optional(), projects: z.record(z.string(), z.unknown()).optional() });
const mcpFileSchema = z.looseObject({ mcpServers: serverMap.optional() });
const installEntry = z.looseObject({ installPath: z.string().max(4096).optional() });
const installedSchema = z.looseObject({ plugins: z.record(z.string(), z.union([z.array(installEntry), installEntry])).optional() });

type Settings = z.infer<typeof settingsSchema>;
type ProjectEntry = z.infer<typeof projectEntrySchema>;

/** One read: what parsed, or why not ('missing' is not an error: nothing configured there). */
type Read<T> = { ok: true; value: T } | { ok: false; missing: boolean };

async function readJson<T>(path: string, schema: z.ZodType<T>, max = MAX_CONFIG_BYTES): Promise<Read<T>> {
  let fh;
  try { fh = await open(path, 'r'); } catch (err) { return { ok: false, missing: isMissing(err) }; }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > max) return { ok: false, missing: false };
    const text = await fh.readFile('utf8');
    if (text.length > max) return { ok: false, missing: false };
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, missing: false };
  } catch {
    return { ok: false, missing: false };
  } finally {
    await fh.close();
  }
}

const isMissing = (err: unknown) => ['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '');

/** The folder's skill names: subfolders (or links to them) with a SKILL.md, bounded. */
async function skillNames(dir: string): Promise<string[]> {
  const out: string[] = [];
  let d;
  try { d = await opendir(dir); } catch { return out; }
  let seen = 0;
  try {
    for await (const e of d) {
      if (++seen > MAX_DIR_ENTRIES || out.length >= MAX_ITEMS) break;
      if (!(e.isDirectory() || e.isSymbolicLink()) || !NAME.test(e.name) || e.name.startsWith('.')) continue;
      try { if ((await stat(join(dir, e.name, 'SKILL.md'))).isFile()) out.push(e.name); } catch { /* not a skill */ }
    }
  } catch { /* gone meanwhile */ }
  return out;
}

const keysOf = (m: Record<string, unknown> | undefined) => Object.keys(m ?? {}).filter((k) => NAME.test(k));
const byName = (a: ConfiguredItem, b: ConfiguredItem) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.name.localeCompare(b.name);
const capped = (l: ConfiguredItem[]) => l.sort(byName).slice(0, MAX_ITEMS);

/** Inside `root` (resolved, symlinks followed): a plugin's installPath may point nowhere else. */
async function inside(root: string, path: string): Promise<boolean> {
  try {
    const [r, p] = await Promise.all([realpath(root), realpath(resolve(path))]);
    return isBelow(r, p);
  } catch { return false; }
}

/**
 * The files readConfig reads that set up MCP servers, for the new-servers poll to stat:
 * the user's, then the folder's (none without a folder, as readConfig).
 */
export function mcpConfigFiles(roots: ConfigRoots, cwd: string | null): string[] {
  const user = [roots.globalFile, join(roots.configDir, 'settings.json')];
  if (cwd === null) return user;
  return [...user, join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'), join(cwd, '.mcp.json')];
}

const motionSchema = z.looseObject({ prefersReducedMotion: z.unknown().optional() });

/**
 * Claude Code's `prefersReducedMotion` for a session: its spinner then stands
 * still for seconds while it works, so quiet output says nothing. `true` in any file Claude Code merges it from — the
 * account's settings.json, the folder's `.claude/settings.json` or `settings.local.json` (`cwd` already checked by the
 * caller; null reads the account's only) — counts: a false "ready" is the costlier mistake. Managed settings aren't read.
 */
export async function claudeReducesMotion(roots: ConfigRoots, cwd: string | null): Promise<boolean> {
  const files = [join(roots.configDir, 'settings.json')];
  if (cwd !== null) files.push(join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'));
  const reads = await Promise.all(files.map((f) => readJson(f, motionSchema)));
  return reads.some((r) => r.ok && r.value.prefersReducedMotion === true);
}

/** Reads what Claude Code would set up for a session started in `cwd` (already checked by the caller). */
export async function readClaudeConfig(roots: ConfigRoots, cwd: string | null): Promise<ClaudeConfig> {
  return (await readConfig(roots, cwd)).config;
}

/** A server URL's host, lower-case (nothing else of the URL is kept); undefined for a command or a bad URL. */
function hostOf(server: Record<string, unknown>): string | undefined {
  const url = server.url;
  if (typeof url !== 'string' || url.length > 4096) return undefined;
  try { return new URL(url).hostname.toLowerCase() || undefined; } catch { return undefined; }
}

/** readClaudeConfig, plus each server's URL host for main's own use (sourceInClaude); hosts never reach a window. */
async function readConfig(roots: ConfigRoots, cwd: string | null): Promise<{ config: ClaudeConfig; hosts: Map<string, string> }> {
  let unreadable = false;
  const take = <T>(r: Read<T>): T | null => { if (r.ok) return r.value; if (!r.missing) unreadable = true; return null; };
  // No folder (main refused it): the user scope only, never a project file.
  const none: Promise<Read<never>> = Promise.resolve({ ok: false, missing: true });
  const projectDir = cwd === null ? null : join(cwd, '.claude');
  const [global, user, project, local, mcpFile, installed] = await Promise.all([
    readJson(roots.globalFile, globalSchema, MAX_GLOBAL_BYTES),
    readJson(join(roots.configDir, 'settings.json'), settingsSchema),
    projectDir ? readJson(join(projectDir, 'settings.json'), settingsSchema) : none,
    projectDir ? readJson(join(projectDir, 'settings.local.json'), settingsSchema) : none,
    cwd ? readJson(join(cwd, '.mcp.json'), mcpFileSchema) : none,
    readJson(join(roots.configDir, 'plugins', 'installed_plugins.json'), installedSchema)
  ]).then((l) => l.map(take)) as [z.infer<typeof globalSchema> | null, Settings | null, Settings | null, Settings | null, z.infer<typeof mcpFileSchema> | null, z.infer<typeof installedSchema> | null];

  // ~/.claude.json's entry for this folder (Claude Code keys it by the folder's path; the real one too).
  let entry: ProjectEntry | null = null;
  if (cwd !== null && global?.projects) {
    let real = cwd;
    try { real = await realpath(cwd); } catch { /* gone: the spelled path only */ }
    const raw = Object.hasOwn(global.projects, cwd) ? global.projects[cwd] : Object.hasOwn(global.projects, real) ? global.projects[real] : undefined;
    if (raw !== undefined) {
      const p = projectEntrySchema.safeParse(raw);
      if (p.success) entry = p.data; else unreadable = true;
    }
  }

  // MCP servers: local over project over user, one row per name.
  const servers = new Map<string, ConfiguredItem>();
  const hosts = new Map<string, string>();
  const disabledHere = new Set(entry?.disabledMcpServers ?? []);
  const add = (name: string, scope: ConfigScope, state: ConfigState, from?: Record<string, Record<string, unknown>>) => {
    if (servers.has(name)) return;
    servers.set(name, { name, scope, state });
    const host = from && Object.hasOwn(from, name) ? hostOf(from[name]!) : undefined;
    if (host) hosts.set(name, host);
  };
  for (const n of keysOf(entry?.mcpServers)) add(n, 'local', disabledHere.has(n) ? 'disabled' : 'enabled', entry?.mcpServers);
  const layered = [user, project, local, entry].filter((s): s is Settings => s !== null);
  const approved = new Set(layered.flatMap((s) => s.enabledMcpjsonServers ?? []));
  const refused = new Set(layered.flatMap((s) => s.disabledMcpjsonServers ?? []));
  const all = layered.some((s) => s.enableAllProjectMcpServers === true);
  for (const n of keysOf(mcpFile?.mcpServers)) add(n, 'project', refused.has(n) ? 'disabled' : approved.has(n) || all ? 'enabled' : 'approval', mcpFile?.mcpServers);
  for (const n of keysOf(global?.mcpServers)) add(n, 'user', disabledHere.has(n) ? 'disabled' : 'enabled', global?.mcpServers);

  // Plugins: enabledPlugins, local over project over user; installed ones not named anywhere are off.
  const pluginState = new Map<string, { scope: ConfigScope; on: boolean }>();
  for (const [s, scope] of [[local, 'local'], [project, 'project'], [user, 'user']] as const) {
    for (const [k, v] of Object.entries(s?.enabledPlugins ?? {})) if (NAME.test(k) && !pluginState.has(k)) pluginState.set(k, { scope, on: v !== false });
  }
  const installs = new Map<string, string[]>();
  for (const [k, v] of Object.entries(installed?.plugins ?? {})) {
    if (!NAME.test(k)) continue;
    installs.set(k, (Array.isArray(v) ? v : [v]).flatMap((x) => (x.installPath ? [x.installPath] : [])));
    if (!pluginState.has(k)) pluginState.set(k, { scope: 'user', on: false });
  }
  const plugins: ConfiguredItem[] = [...pluginState].map(([name, p]) => ({ name, scope: p.scope, state: p.on ? 'enabled' : 'disabled' }));

  // Skills: the user's and the project's folders, then each installed plugin's (named plugin:skill, its plugin's state).
  const skills: ConfiguredItem[] = [];
  for (const n of await skillNames(join(roots.configDir, 'skills'))) skills.push({ name: n, scope: 'user', state: 'enabled' });
  if (projectDir) for (const n of await skillNames(join(projectDir, 'skills'))) skills.push({ name: n, scope: 'project', state: 'enabled' });
  const pluginsDir = join(roots.configDir, 'plugins');
  for (const [key, paths] of installs) {
    const short = key.split('@')[0] || key;
    const state: ConfigState = pluginState.get(key)?.on ? 'enabled' : 'disabled';
    const seen = new Set<string>();
    for (const p of paths.slice(0, 4)) {
      if (!(await inside(pluginsDir, p))) continue;
      for (const n of await skillNames(join(p, 'skills'))) {
        if (seen.has(n)) continue;
        seen.add(n);
        skills.push({ name: `${short}:${n}`, scope: 'plugin', state });
      }
    }
    if (skills.length >= MAX_ITEMS * 2) break;
  }

  return { config: { mcpServers: capped([...servers.values()]), skills: capped(skills), plugins: capped(plugins), unreadable, project: cwd !== null }, hosts };
}

const everSchema = z.looseObject({ claudeAiMcpEverConnected: z.array(z.string().max(200)).max(500).optional() });
/** Claude Code names a server's tools `mcp__<name>__…`, with what isn't a letter, digit, `_` or `-` as `_`. */
const toolPrefix = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * Whether Claude Code has a task source for this account and project: a claude.ai connector
 * the account connected (`claudeAiMcpEverConnected`) or a configured server named like it (user, project, local; a
 * disabled one doesn't count), or one whose URL is the source's host. `servers`: the names its tools carry, to deny when
 * the automation doesn't allow it. Names out, never a URL or a command. A file that can't be read: 'unknown'.
 */
const SOURCE_HOST = { clickup: /(?:^|\.)clickup\.com$/, notion: /(?:^|\.)notion\.(?:com|so)$/, jira: /(?:^|\.)atlassian\.com$/ } as const;
/** The words a server's name carries (Jira: Atlassian's connector is "Atlassian", users often name theirs "jira"). */
const SOURCE_LABELS = { clickup: ['clickup'], notion: ['notion'], jira: ['atlassian', 'jira'] } as const;

export async function sourceInClaude(roots: ConfigRoots, project: string, source: ConnectorId): Promise<{ state: 'found' | 'notFound' | 'unknown'; name?: string; servers: string[] }> {
  const labels: readonly string[] = SOURCE_LABELS[source];
  const ever = await readJson(roots.globalFile, everSchema, MAX_GLOBAL_BYTES);
  if (!ever.ok && !ever.missing) return { state: 'unknown', servers: [] };
  const { config: cfg, hosts } = await readConfig(roots, project);
  const claudeAi = (ever.ok ? ever.value.claudeAiMcpEverConnected ?? [] : []).filter((n) => labels.some((l) => n.toLowerCase() === `claude.ai ${l}`));
  const ofSource = (name: string) => labels.some((l) => name.toLowerCase().includes(l)) || SOURCE_HOST[source].test(hosts.get(name) ?? '');
  const configured = cfg.mcpServers.filter((s) => s.state !== 'disabled' && ofSource(s.name)).map((s) => s.name);
  const names = [...claudeAi, ...configured];
  if (names.length === 0) return { state: cfg.unreadable ? 'unknown' : 'notFound', servers: [] };
  return { state: 'found', name: names[0]!, servers: [...new Set(names.map(toolPrefix))] };
}

/**
 * Whether Claude Code trusts `dir` for this account: its trust dialog accepted for the folder,
 * the spelled or the real path. Claude Code's own rule (measured with 2.1.302, 2026-10-19): inside a git repository
 * only the main checkout's root counts (`gitRoot`: pass that root; a folder above it doesn't, and its worktrees follow
 * it wherever they are); elsewhere a parent's trust counts too. Windows: the keys (`C:/…`) in any case and either
 * separator. A file that can't be read: 'unknown'.
 */
export async function claudeTrusts(roots: ConfigRoots, dir: string, o: { gitRoot?: boolean } = {}): Promise<'trusted' | 'untrusted' | 'unknown'> {
  const r = await readJson(roots.globalFile, globalSchema, MAX_GLOBAL_BYTES);
  if (!r.ok) return r.missing ? 'untrusted' : 'unknown';
  const win = pathStyle() === 'win32';
  const key = (p: string) => (win ? p.replace(/\\/g, '/').replace(/(?<=.)\/+$/, '').toLowerCase() : p);
  const trusted = new Set(Object.entries(r.value.projects ?? {})
    .filter(([, e]) => typeof e === 'object' && e !== null && (e as { hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted === true)
    .map(([k]) => key(k)));
  let real = dir;
  try { real = await realpath(dir); } catch { /* gone: the spelled path only */ }
  const up = win ? win32.dirname : dirname;
  for (const start of new Set([dir, real])) {
    for (let p = start; ; p = up(p)) {
      if (trusted.has(key(p))) return 'trusted';
      if (o.gitRoot || up(p) === p) break;
    }
  }
  return 'untrusted';
}

/**
 * What the IPC returns for a folder the renderer names: the folder must be an existing folder inside the window's
 * project's real root, never inside .git (terminalCwd, the check of new terminals); refused, only the user scope is
 * read and `project` says so.
 */
export function claudeConfigFor(roots: ConfigRoots, projectRoot: string, cwd: string): Promise<ClaudeConfig> {
  return readClaudeConfig(roots, terminalCwd(projectRoot, cwd));
}
