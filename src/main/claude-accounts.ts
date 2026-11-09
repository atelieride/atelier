import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ACCOUNT_ID, accountById, accountOf, accountsFor, launchAccount, launchDir, type ClaudeAccount, type ClaudeAccounts } from '@shared/claude-accounts';
import { effectiveFlags, expandFlags, flagError, type LaunchFlag } from '@shared/claude-flags';
import type { HistoryRoot } from './claude-history';
import { encodeProjectPath } from '@shared/history';
import { toCanonical } from '@shared/paths';
import type { Resumable } from '@shared/protocol';
import type { Settings } from '@shared/settings';
import { claudeCommand, claudeResumeCommand } from '@shared/shell';
import { devEnv } from './dev-env';

// Claude accounts in main: main alone turns an account id into a dir, and alone knows which
// dir is the default one.

/**
 * The dir `claude` uses with no CLAUDE_CONFIG_DIR, as Claude Code resolves it for main's environment. Canonical
 * (`C:/Users/x/.claude` on Windows), the form the sessions' dirs arrive in.
 */
export function defaultConfigDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return toCanonical(env.CLAUDE_CONFIG_DIR || join(home, '.claude'));
}

/** The default dir on this machine; tests point it at a fake home (never the user's ~/.claude). */
export function defaultConfigDirNow(): string {
  const test = devEnv('ATELIER_TEST_CLAUDE_HOME');
  return test ? join(test, '.claude') : defaultConfigDir();
}

/** A regular file there, not followed through a symlink (as Claude history reads them). */
export async function isRegularFile(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}

/** The accounts as they apply here: one at the default dir is the default itself. */
export function accountsOf(s: Settings, defaultDir: string): ClaudeAccounts {
  return accountsFor(s.claudeAccounts, defaultDir);
}

/**
 * An account's launch flags as they go on its command line: `~` as the home folder, checked again
 * once expanded (a Windows home with ! or % in it would reach cmd), a flag that no longer passes left out.
 */
export function launchFlags(s: Settings, accountId: string, home: string = homedir()): LaunchFlag[] {
  return expandFlags(effectiveFlags(s.claudeFlags, accountId), home).filter((f) => flagError(f) === null);
}

/**
 * The command for a new Claude session with the settings' model and permission mode, in the account's dir, with its
 * launch flags (`noFlags`: New Session's ⌥↵).
 */
export function sessionCommand(s: Settings, defaultDir: string, accountId: string | undefined, name: string | undefined, opts: { noFlags?: boolean; home?: string } = {}): string {
  const { account, dir } = launchAccount(accountsOf(s, defaultDir), accountId);
  const flags = opts.noFlags ? [] : launchFlags(s, account.id, opts.home);
  return claudeCommand(name, { model: s.claudeModel, permissionMode: s.claudePermissionMode, configDir: dir, flags });
}

/**
 * A session's config dir when it belongs to a configured account other than the default; else undefined. Only these
 * dirs are ever read for a session or put in an environment: a dir from hook data alone never is.
 */
export function accountDirOf(configDir: string | undefined, a: ClaudeAccounts, defaultDir: string): string | undefined {
  const acc = accountOf(configDir, a, defaultDir);
  return acc ? launchDir(acc) : undefined;
}

/** Claude history's folders: the default account's (tests point it elsewhere), then each account's. */
export function historyRoots(a: ClaudeAccounts, defaultProjects: string): HistoryRoot[] {
  return a.list.map((acc) => ({ account: acc.id, dir: launchDir(acc) ? join(acc.dir, 'projects') : defaultProjects }));
}

/** The account a history conversation resumes with: the one it belongs to (none: the default), never another. */
export function historyResume(a: ClaudeAccounts, accountId: string | undefined): { account: string; dir: string | undefined } {
  const { account, dir } = launchAccount(a, accountId ?? DEFAULT_ACCOUNT_ID);
  return { account: account.id, dir };
}

/**
 * Restart Session: `claude --resume <id>` for a live session, typed into its own shell
 * — with the account it runs with (its config dir; a dir no account has any more: the default) and that account's
 * launch flags as they are now. No model or permission mode: Claude Code's resume restores the session's own.
 */
export function restartCommand(s: Settings, defaultDir: string, configDir: string | undefined, sessionId: string): string {
  const a = accountsOf(s, defaultDir);
  const account = accountOf(configDir, a, defaultDir) ?? a.list[0]!;
  return claudeResumeCommand(sessionId, { model: 'default', permissionMode: 'inherit', configDir: launchDir(account), flags: launchFlags(s, account.id) });
}

/** A resume message's account field: the dir (null: the default) only for an atelierd with 'resume-config-dir'. */
export function resumeFields(capable: boolean, configDir: string | null): { configDir?: string | null } {
  return capable ? { configDir } : {};
}

/**
 * The dir a resumable resumes with, null for the default account: its stored dir when that is an account's
 * (a removed account's falls back to the default); with none stored (an older atelierd), the first account whose
 * projects folder holds the conversation, the default first.
 */
export async function resumeConfigDir(r: Resumable, a: ClaudeAccounts, defaultDir: string, exists: (path: string) => Promise<boolean>): Promise<string | null> {
  if (r.configDir) return launchDir(accountOf(r.configDir, a, defaultDir) ?? a.list[0]!) ?? null;
  for (const acc of a.list) {
    const dir = launchDir(acc) ?? defaultDir;
    const file = join(dir, 'projects', encodeProjectPath(r.cwd), `${r.sessionId}.jsonl`);
    if (await exists(file).catch(() => false)) return launchDir(acc) ?? null;
  }
  return null;
}
