import { pathStyle } from './platform';

// Names under which an interactive shell appears as the foreground process.
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'login']);
/** Windows: the shells Atelier starts there. */
const WINDOWS_SHELLS = new Set(['pwsh', 'powershell', 'cmd', 'bash', 'sh', 'zsh', 'fish', 'wsl']);

/** node-pty sometimes reports the full path (/bin/zsh) and login shells have a leading dash (-zsh). */
export function isShell(foreground: string): boolean {
  return (pathStyle() === 'win32' ? WINDOWS_SHELLS : SHELLS).has(processName(foreground));
}

/** Claude Code: it names its process after its version (2.1.42); `claude` when launched some other way. */
export function isClaudeProcess(foreground: string): boolean {
  const name = processName(foreground);
  return name === 'claude' || /^\d+(\.\d+)+$/.test(name);
}

/** The program's name: no path, no login dash; '' when none is known (see wellFormedTerminal). */
function processName(foreground: string | undefined): string {
  if (typeof foreground !== 'string') return '';
  // Windows: either separator, any case, without .exe.
  if (pathStyle() === 'win32') return (foreground.split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.exe$/, '');
  return foreground.replace(/^-/, '').split('/').at(-1) ?? '';
}

// Editors and pagers Claude can open in the foreground (Ctrl+G opens $EDITOR): keys go to them there, not to Claude.
const EDITORS = new Set(['vim', 'nvim', 'vi', 'view', 'nano', 'pico', 'emacs', 'hx', 'helix', 'micro', 'kak', 'ed', 'less', 'more', 'man']);

export function isEditorOrPager(foreground: string): boolean {
  return EDITORS.has(processName(foreground));
}
