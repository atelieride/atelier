import { powerShellQuote, sessionShellKind, type ShellKind } from '@shared/shell-kind';

// Git refuses to read a repository another user owns (safe.directory): every read fails with "detected dubious
// ownership", and the views showed such a repository as clean. They say why instead, with the command that trusts it
// to copy: Atelier never runs it (it changes the user's global git config, and git writes are only git/write.ts's ops).

/** git's refusal (reads run with LC_ALL=C: always in English), with the path it names (null when it names none). */
export function dubiousOwnership(error: string | null | undefined): { path: string | null } | null {
  if (!error || !error.includes('detected dubious ownership')) return null;
  return { path: /detected dubious ownership in repository at '(.*)'$/m.exec(error)?.[1] ?? null };
}

/**
 * The command that trusts `path`, as git's own hint gives it (the path in git's form: `C:/…` on Windows), quoted for
 * the shell of Atelier's terminals (zsh, PowerShell: never cmd). shared/shell.ts's shellQuote is the backend's.
 */
export function safeDirectoryCommand(path: string, kind: ShellKind = sessionShellKind()): string {
  const quoted = kind === 'powershell' ? powerShellQuote(path) : `'${path.replace(/'/g, `'\\''`)}'`;
  return `git config --global --add safe.directory ${quoted}`;
}
