// Which shell reads a terminal's command line, and quoting for it. Shared by the renderer (files
// dropped on a terminal) and the backend (shell.ts: session commands), so it holds nothing but this.
import { pathStyle } from './platform';
import type { TerminalProfile } from './protocol';

/** How a shell reads a command line: sh-like (zsh, bash, Git Bash, WSL), PowerShell, or cmd. */
export type ShellKind = 'posix' | 'powershell' | 'cmd';

/** The shell of Atelier's own terminals (the built-in profiles), where sessions start: PowerShell on Windows, else zsh. */
export function sessionShellKind(): ShellKind {
  return pathStyle() === 'win32' ? 'powershell' : 'posix';
}

/** How a terminal's shell reads a command line, from its profile (absent: the built-in one). */
export function profileShellKind(profile: TerminalProfile | undefined): ShellKind {
  if (profile === undefined || typeof profile === 'string') return sessionShellKind();
  if (pathStyle() !== 'win32') return 'posix';
  const name = (profile.shell.split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.exe$/, '');
  return name === 'pwsh' || name === 'powershell' ? 'powershell' : name === 'cmd' ? 'cmd' : 'posix';
}

/** PowerShell single quotes, every single-quote character doubled (it ends a string on ‘ ’ ‚ ‛ too). */
export function powerShellQuote(s: string): string {
  return `'${s.replace(/['‘’‚‛]/g, '$&$&')}'`;
}
