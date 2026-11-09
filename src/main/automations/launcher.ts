// How a run's session starts: three files in ATELIER_HOME/automations/runs/<run> (0700 folder,
// 0600 files) and a dot command typed into the new terminal. The script is sourced, so Atelier's `claude` function and
// its hooks start Claude (as for accounts: an assignment, never `env …`), and the guard's exports stay on that shell
// after Claude exits. The task's text and the system prompt reach Claude through `$(cat …)`: never in the script itself.
// On Windows the script is PowerShell's, and both go through their files: --append-system-prompt-file, and a
// first message that points at prompt.md (a command line holds 32 767 characters; PowerShell 5.1 mangles `"`).
import { chmodSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AutomationMode } from '@shared/automations';
import { toNative } from '@shared/paths';
import { currentPlatform } from '@shared/platform';
import type { ClaudeModel } from '@shared/settings';
import { claudeCommand, shellQuote, withConfigDir } from '@shared/shell';

/** Always denied in automated sessions (first line of the guard; the git guard is the one that holds). */
export const BASE_DENY: readonly string[] = Object.freeze([
  'Bash(git merge *)', 'Bash(git push *)', 'Bash(git rebase *)', 'Bash(git tag *)', 'Bash(gh pr merge *)', 'Bash(gh pr create *)'
]);

const SERVER = /^[A-Za-z0-9_-]{1,100}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const FILES = ['launch.sh', 'launch.ps1', 'system.md', 'prompt.md'] as const;
const onWindows = () => currentPlatform() === 'win32';

/** The script's file name: PowerShell's on Windows. */
export const launchScriptName = (): string => (onWindows() ? 'launch.ps1' : 'launch.sh');

/** The tools denied in a run: the base list, AskUserQuestion when Claude decides alone, each denied MCP server. */
export function disallowedTools(o: { decideAlone: boolean; denyServers: readonly string[] }): string[] {
  return [...BASE_DENY, ...(o.decideAlone ? ['AskUserQuestion'] : []), ...o.denyServers.filter((s) => SERVER.test(s)).map((s) => `mcp__${s}`)];
}

export interface LaunchSpec {
  /** ATELIER_HOME/automations/runs/<run id>. */
  runDir: string;
  /** The session's name. */
  name: string;
  model: ClaudeModel;
  mode: AutomationMode;
  /** Another account's config dir; undefined for the default account. */
  configDir?: string;
  /** The guard's environment, in order (guard.ts guardEnv). */
  guard: readonly (readonly [string, string])[];
  /** The guard's git folder, first on the session's PATH (guard.ts guardBin). */
  pathPrefix?: string;
  disallowed: readonly string[];
  system: string;
  prompt: string;
}

/** The script the session's shell sources. */
export function launchScript(s: LaunchSpec): string {
  for (const [k, v] of s.guard) if (!ENV_NAME.test(k) || /[\x00-\x1f\x7f]/.test(v)) throw new Error('invalid guard environment');
  if (onWindows()) return powerShellScript(s);
  const claude = claudeCommand(s.name, { model: s.model, permissionMode: s.mode, ...(s.configDir ? { configDir: s.configDir } : {}) });
  const file = (f: string) => `"$(cat ${shellQuote(join(s.runDir, f))})"`;
  return [
    '# Atelier automation run: sourced by the session\'s shell. The guard stays on in this terminal.',
    // Before the guard's GIT_CONFIG_* hide it: the repository's own hooks folder, which the guard's hooks chain to.
    'ATELIER_USER_HOOKS="$(git config --get core.hooksPath 2>/dev/null)"; export ATELIER_USER_HOOKS',
    ...s.guard.map(([k, v]) => `export ${k}=${shellQuote(v)}`),
    ...(s.pathPrefix ? [`export PATH=${shellQuote(s.pathPrefix)}:"$PATH"`] : []),
    `${claude} --disallowedTools ${s.disallowed.map((t) => shellQuote(t)).join(' ')} --append-system-prompt ${file('system.md')} ${file('prompt.md')}`,
    ''
  ].join('\n');
}

/** Windows: the same steps in PowerShell; paths the shell or Claude reads are native. */
function powerShellScript(s: LaunchSpec): string {
  const q = (v: string) => shellQuote(v, 'powershell');
  const file = (f: string) => toNative(join(s.runDir, f), 'win32');
  const first = `Your task is in ${file('prompt.md')}. Read that file first, all of it: it is the task you were started for.`;
  // The run's folder is a working directory, so reading prompt.md never asks (seen on a Windows PC: "Read prompt.md?").
  const claude = `${claudeCommand(s.name, { model: s.model, permissionMode: s.mode })} --disallowedTools ${s.disallowed.map(q).join(' ')} `
    + `--add-dir ${q(toNative(s.runDir, 'win32'))} --append-system-prompt-file ${q(file('system.md'))} ${q(first)}`;
  return [
    '# Atelier automation run: dot-sourced by the session\'s PowerShell. The guard stays on in this terminal.',
    "$env:ATELIER_USER_HOOKS = try { & git config --get core.hooksPath 2>$null } catch { '' }",
    ...s.guard.map(([k, v]) => `$env:${k} = ${q(v)}`),
    ...(s.pathPrefix ? [
      `$env:PATH = ${q(`${toNative(s.pathPrefix, 'win32')};`)} + $env:PATH`,
      // Git Bash (Claude Code's Bash tool) puts its own git before the inherited PATH; bash imports an exported
      // function from the environment, and a function wins over PATH: git is the guard's there too.
      `[Environment]::SetEnvironmentVariable('BASH_FUNC_git%%', ${q(`() { ${shellQuote(`${s.pathPrefix.replace(/\\/g, '/')}/git.exe`)} "$@"; }`)}, 'Process')`
    ] : []),
    withConfigDir(claude, s.configDir),
    ''
  ].join('\n');
}

/** The command typed into the new terminal: the shell's dot-source, quoted its way. */
export const launchCommand = (script: string): string => `. ${shellQuote(script, onWindows() ? 'powershell' : 'posix')}`;

/** Writes the run's three files; returns the script's path. */
export function writeLaunchFiles(s: LaunchSpec): { script: string } {
  mkdirSync(s.runDir, { recursive: true, mode: 0o700 });
  chmodSync(s.runDir, 0o700);
  const put = (f: string, text: string) => writeFileSync(join(s.runDir, f), text, { mode: 0o600 });
  put('system.md', s.system);
  put('prompt.md', s.prompt);
  // Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page: an accented title or user folder
  // (C:\Users\Zoë) would reach claude and the guard's PATH mangled.
  put(launchScriptName(), `${onWindows() ? '\ufeff' : ''}${launchScript(s)}`);
  return { script: join(s.runDir, launchScriptName()) };
}

/** Once Claude has read them (its first state, or 60 s): the three files and their folder, nothing else. */
export function removeLaunchFiles(runDir: string): void {
  for (const f of FILES) {
    try { unlinkSync(join(runDir, f)); } catch { /* not there */ }
  }
  try { rmdirSync(runDir); } catch { /* not there, or not empty: left as is */ }
}
