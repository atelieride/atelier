import { toCanonical, toNative } from '@shared/paths';
import { powerShellQuote, sessionShellKind, type ShellKind } from '@shared/shell-kind';
import { pathStyle } from '@shared/platform';

/** Type of the data dragged from a file tree row. */
export const TREE_PATH_TYPE = 'text/x-atelier-path';

/** A path escaped like macOS Terminal does: every shell-special character preceded by \ (Claude strips them). */
function shellEscape(p: string): string {
  return p.replace(/([ \t'"\\$`!&*()[\]{};<>?|#~^=,])/g, '\\$1');
}

/**
 * Windows: quoted for the terminal's shell — PowerShell single quotes (`$` and `` ` `` stay
 * literal), cmd double quotes (a name with % or ! it would expand is left out; `"` can't be in a Windows name), a
 * POSIX shell (Git Bash, WSL) forward slashes escaped as on macOS. Null: left out.
 */
function windowsQuote(p: string, kind: ShellKind): string | null {
  if (kind === 'posix') return shellEscape(toCanonical(p));
  const n = toNative(p);
  if (kind === 'cmd') return /[%!"]/.test(n) ? null : /[^A-Za-z0-9_.\\:/-]/.test(n) ? `"${n}"` : n;
  return /[^A-Za-z0-9_.\\:/-]/.test(n) ? powerShellQuote(n) : n;
}

/**
 * Text to paste for files dragged onto the terminal: escaped paths, separated by spaces, one trailing space.
 * A path with control characters (a newline in the name) is skipped: in a shell without bracketed paste it would run the rest.
 * `kind`: the terminal's shell (Windows; macOS escapes as Terminal does whatever the shell).
 */
export function dropText(paths: string[], kind: ShellKind = sessionShellKind()): string {
  const ok = paths.filter((p) => !/[\x00-\x1f\x7f]/.test(p));
  const quoted = pathStyle() === 'win32' ? ok.flatMap((p) => windowsQuote(p, kind) ?? []) : ok.map(shellEscape);
  return quoted.length ? `${quoted.join(' ')} ` : '';
}

// Drag started from a tree row: the path lives here, not in the drag data (which a web page
// dragged into the window could imitate).
let treeDrag: string | null = null;
export function startTreeDrag(path: string): void { treeDrag = path; }
export function endTreeDrag(): void { treeDrag = null; }
export function treeDragPath(): string | null { return treeDrag; }
