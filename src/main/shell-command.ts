import { dirname } from 'node:path';
import type { ShellCommandResult } from '@shared/api';

export type { ShellCommandResult };

// "Install 'atelier' Command": a link /usr/local/bin/atelier → the script inside Atelier.app,
// as an editor's own command does. Pure: the disk and the administrator prompt come in through ShellCommandDeps.

export const SHELL_COMMAND_LINK = '/usr/local/bin/atelier';
/** Where the script sits in any copy of Atelier.app: a link to another copy is ours to replace. */
const SCRIPT_TAIL = '.app/Contents/Resources/bin/atelier';

export interface ShellCommandDeps {
  packaged: boolean;
  /** The script in this app. */
  script: string;
  link: string;
  /** What is at `p`: nothing (null), a link and its target, or something else (link: null). */
  entry(p: string): { link: string | null } | null;
  makeLink(target: string, p: string): void;
  removeLink(p: string): void;
  makeDir(dir: string): void;
  /** Runs an AppleScript with administrator privileges (macOS asks for the password); false when cancelled. */
  admin(appleScript: string): Promise<boolean>;
}

const denied = (e: unknown) => ['EACCES', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '');

/** An AppleScript string literal. */
const asString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The administrator command: fixed programs, both paths quoted for the shell (quoted form of) and for AppleScript. */
export function adminScript(op: 'install' | 'uninstall', script: string, link: string): string {
  const q = (s: string) => `quoted form of ${asString(s)}`;
  const shell = op === 'install'
    ? `"/bin/mkdir -p " & ${q(dirname(link))} & " && /bin/ln -sfn " & ${q(script)} & " " & ${q(link)}`
    : `"/bin/rm -f " & ${q(link)}`;
  return `do shell script ${shell} with administrator privileges`;
}

function ownership(d: ShellCommandDeps): 'none' | 'this' | 'other-atelier' | 'foreign' {
  const e = d.entry(d.link);
  if (!e) return 'none';
  if (e.link === d.script) return 'this';
  return e.link?.endsWith(SCRIPT_TAIL) ? 'other-atelier' : 'foreign';
}

export async function installShellCommand(d: ShellCommandDeps): Promise<ShellCommandResult> {
  if (!d.packaged) return { error: 'dev' };
  const own = ownership(d);
  if (own === 'this') return { ok: 'already' };
  if (own === 'foreign') return { error: 'foreign', detail: d.link };
  try {
    d.makeDir(dirname(d.link));
    if (own === 'other-atelier') d.removeLink(d.link);
    d.makeLink(d.script, d.link);
    return { ok: 'installed' };
  } catch (e) {
    if (!denied(e)) return { error: 'failed', detail: (e as Error).message };
    return (await d.admin(adminScript('install', d.script, d.link))) ? { ok: 'installed' } : { error: 'cancelled' };
  }
}

export async function uninstallShellCommand(d: ShellCommandDeps): Promise<ShellCommandResult> {
  // A dev build's script is another copy: the installed app's link would count as ours to remove.
  if (!d.packaged) return { error: 'dev' };
  const own = ownership(d);
  if (own === 'none') return { error: 'not-installed' };
  if (own === 'foreign') return { error: 'foreign', detail: d.link };
  try {
    d.removeLink(d.link);
    return { ok: 'uninstalled' };
  } catch (e) {
    if (!denied(e)) return { error: 'failed', detail: (e as Error).message };
    return (await d.admin(adminScript('uninstall', d.script, d.link))) ? { ok: 'uninstalled' } : { error: 'cancelled' };
  }
}
