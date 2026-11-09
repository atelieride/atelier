import type { ClaudeModel, ClaudePermissionMode } from './settings';
import type { LaunchFlag } from './claude-flags';
import { SESSION_ID } from './history';
import { isCleanAbsPath } from './clean-path';
import { powerShellQuote, sessionShellKind, type ShellKind } from './shell-kind';

export { profileShellKind, sessionShellKind, type ShellKind } from './shell-kind';

/**
 * Quotes so the content is never interpreted. sh/zsh: single quotes. PowerShell: single quotes, every single-quote
 * character doubled (it ends a string on ‘ ’ ‚ ‛ too). cmd: double quotes, refusing what cmd still expands inside them.
 */
export function shellQuote(s: string, kind: ShellKind = 'posix'): string {
  if (kind === 'powershell') return powerShellQuote(s);
  if (kind === 'cmd') {
    if (/["%!\x00-\x1f\x7f]/.test(s)) throw new Error('cannot be quoted for cmd');
    return `"${s}"`;
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A hand-typed name: tabs and line breaks become a space, other control characters (C0, DEL, C1) go away. */
export function cleanName(name: string): string {
  return name.replace(/[\t\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
}

/**
 * The command that the "New session" button writes into the terminal. No control characters (in the terminal they
 * would be a keystroke) and the --name=<value> form as a single argument: a name like "-p" never becomes an option.
 */
export function claudeCommand(name?: string, opts?: ClaudeOpts): string {
  const kind = sessionShellKind();
  // Windows PowerShell 5.1 passes an argument's double quotes to claude.exe mangled, and a trailing backslash escapes
  // the quote it adds (the next flags would join the name); % would reach npm's claude.cmd as a variable, and & | < > ^
  // as cmd's own in a word with no space (PowerShell quotes only those with one): they go.
  const n = kind === 'powershell' ? cleanName((name ?? '').replace(/["\\%&|<>^]/g, '')) : cleanName(name ?? '');
  const parts = ['claude'];
  if (n) parts.push(`--name=${shellQuote(n, kind)}`);
  // Only values from the settings' closed list: nothing else enters the command.
  if (opts && MODELS.has(opts.model)) parts.push(`--model ${opts.model}`);
  // The skip flag is the explicit choice: two contradicting modes never share a command line.
  // Checked here, not with claude-flags.ts: atelierd bundles this module and nothing more of the launch flags.
  const skips = !!opts?.flags?.some((f) => f[0]!.split('=', 1)[0] === '--dangerously-skip-permissions');
  if (opts && MODES.has(opts.permissionMode) && !skips) parts.push(`--permission-mode ${opts.permissionMode}`);
  // Launch flags, already validated and expanded by main: every token quoted on its own, so each is one argument.
  for (const token of opts?.flags?.flat() ?? []) parts.push(shellQuote(token, kind));
  return withConfigDir(parts.join(' '), opts?.configDir);
}

/** `claude --resume <id>` for a conversation from Claude's history, with the same settings flags as a new session. */
export function claudeResumeCommand(sessionId: string, opts?: ClaudeOpts): string {
  if (!SESSION_ID.test(sessionId)) throw new Error('invalid session id');
  const flags = claudeCommand(undefined, opts && { model: opts.model, permissionMode: opts.permissionMode, ...(opts.flags ? { flags: opts.flags } : {}) }).slice('claude'.length);
  return withConfigDir(`claude --resume ${shellQuote(sessionId, sessionShellKind())}${flags}`, opts?.configDir);
}

/**
 * `configDir`: another Claude account's config dir, absent for the default account, which
 * starts exactly as before (an explicit default dir could read as another, signed-out account).
 */
type ClaudeOpts = { model: ClaudeModel; permissionMode: ClaudePermissionMode; configDir?: string; flags?: readonly LaunchFlag[] };

/**
 * The command for another account: `CLAUDE_CONFIG_DIR='<dir>' claude …`. An assignment, not `env …`: the command still
 * goes through Atelier's zsh `claude` function, so the hooks come along. Anything but a clean absolute dir is refused.
 */
export function withConfigDir(command: string, configDir: string | undefined): string {
  if (configDir === undefined) return command;
  if (!isCleanAbsPath(configDir)) throw new Error('invalid Claude config dir');
  // PowerShell: an assignment would stay in the shell; set for this command only, then given back.
  if (sessionShellKind() === 'powershell') {
    return `& { $p = $env:CLAUDE_CONFIG_DIR; $env:CLAUDE_CONFIG_DIR = ${shellQuote(configDir, 'powershell')}; try { ${command} } finally { $env:CLAUDE_CONFIG_DIR = $p } }`;
  }
  return `CLAUDE_CONFIG_DIR=${shellQuote(configDir)} ${command}`;
}

const MODELS = new Set<string>(['opus', 'sonnet', 'haiku']);
// 'inherit' passes nothing (the user's setting in Claude applies); 'default' is "Ask" and must really be passed.
const MODES = new Set<string>(['default', 'auto', 'acceptEdits', 'plan']);
