import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import path, { basename } from 'node:path';
import { samePath, toCanonical, toNative } from '@shared/paths';
import { pathStyle } from '@shared/platform';
import type { ShellKind } from '@shared/shell';

/** Shells from /etc/shells: one absolute path per line, # starts a comment. */
export function parseEtcShells(text: string): string[] {
  return text.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter((l) => l.startsWith('/'));
}

/**
 * The shell of a { shell } profile, checked at request time: only shells the system lists in /etc/shells
 * (exact path) and that exist as executables. Anything else is refused, so the app can't make atelierd run an
 * arbitrary program.
 */
export function listedShell(path: string, etcShells = '/etc/shells', win: WindowsProbe = machineProbe()): string {
  if (pathStyle() === 'win32') {
    const found = windowsShells(win.env, win.exists).find((s) => samePath(s.path, toCanonical(path)));
    if (!found) throw new Error(`shell not allowed: ${path}`);
    return toNative(found.path);
  }
  let listed: string[] = [];
  try { listed = parseEtcShells(readFileSync(etcShells, 'utf8')); } catch { /* no list: nothing is allowed */ }
  if (!listed.includes(path)) throw new Error(`shell not listed in /etc/shells: ${path}`);
  try {
    if (!statSync(path).isFile()) throw new Error('not a file');
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(`shell not found: ${path}`);
  }
  return path;
}

// Shells that accept -l to start as a login shell (reading /etc/profile, ~/.bash_profile…, as a terminal app does).
const LOGIN_FLAG = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh', 'mksh', 'fish', 'tcsh', 'csh']);

export function loginArgs(shell: string): string[] {
  if (pathStyle() === 'win32') {
    const name = path.win32.basename(shell).toLowerCase().replace(/\.exe$/, '');
    return name === 'bash' ? ['-l'] : name === 'pwsh' || name === 'powershell' ? ['-NoLogo'] : [];
  }
  return LOGIN_FLAG.has(basename(shell)) ? ['-l'] : [];
}

/** A shell found on Windows: canonical path, display name, how it reads a command line. */
export interface WindowsShell { path: string; name: string; kind: ShellKind }
export interface WindowsProbe { env: Record<string, string | undefined>; exists(path: string): boolean }

const machineProbe = (): WindowsProbe => ({ env: process.env, exists: (p) => existsSync(toNative(p)) });

/**
 * The shells Windows has, where their installers put them: there is no /etc/shells. PowerShell 7
 * from Program Files or as a Store App Execution Alias, Windows PowerShell 5.1, cmd, Git Bash, WSL (its default
 * distribution). Canonical paths, PowerShell 7 first.
 */
export function windowsShells(env: Record<string, string | undefined>, exists: (path: string) => boolean): WindowsShell[] {
  const dir = (v: string | undefined, fallback: string) => toCanonical(v || fallback, 'win32').replace(/\/+$/, '');
  const pf = dir(env.ProgramFiles, 'C:\\Program Files');
  const sys = `${dir(env.SystemRoot, 'C:\\Windows')}/System32`;
  const local = env.LOCALAPPDATA ? dir(env.LOCALAPPDATA, '') : null;
  const candidates: [string, string[], ShellKind][] = [
    ['PowerShell 7', [`${pf}/PowerShell/7/pwsh.exe`, ...(local ? [`${local}/Microsoft/WindowsApps/pwsh.exe`] : [])], 'powershell'],
    ['Windows PowerShell', [`${sys}/WindowsPowerShell/v1.0/powershell.exe`], 'powershell'],
    ['Command Prompt', [`${sys}/cmd.exe`], 'cmd'],
    // Git for Windows installs for the user only without admin rights (or with winget --scope user).
    ['Git Bash', [`${pf}/Git/bin/bash.exe`, ...(local ? [`${local}/Programs/Git/bin/bash.exe`] : [])], 'posix'],
    ['WSL', [`${sys}/wsl.exe`], 'posix']
  ];
  return candidates.flatMap(([name, paths, kind]) => {
    const found = paths.find((p) => exists(p));
    return found ? [{ path: found, name, kind }] : [];
  });
}

/** Whether a shell is Git for Windows' Git Bash (it gets Atelier's integration; WSL, posix too, doesn't). */
export function isGitBash(file: string, win: WindowsProbe = machineProbe()): boolean {
  return windowsShells(win.env, win.exists).some((s) => s.name === 'Git Bash' && samePath(s.path, toCanonical(file, 'win32'), 'win32'));
}

/** The PowerShell the built-in profiles run: 7 when installed, else Windows PowerShell (always there). */
export function defaultPowerShell(list: WindowsShell[]): WindowsShell | undefined {
  return list.find((s) => s.kind === 'powershell');
}
