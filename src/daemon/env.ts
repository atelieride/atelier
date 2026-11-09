import { envKey, pathListJoin, pathListSplit } from '@shared/env';
import { pathStyle } from '@shared/platform';

/** UTF-8 language from the system locale: apps launched from the Dock have no LANG. */
export function defaultLang(): string {
  const loc = Intl.DateTimeFormat().resolvedOptions().locale; // e.g. "it-IT"
  const m = /^([a-z]{2})-([A-Z]{2})/.exec(loc);
  return m ? `${m[1]}_${m[2]}.UTF-8` : 'en_US.UTF-8';
}

// Variables Claude Code sets for its child processes: a new terminal must not look "inside" Claude.
export const DROPPED = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PROJECT_DIR',
  // The terminal that launched the app (tmux, another terminal, an editor) is not the one the shell runs in.
  'TMUX', 'TMUX_PANE', 'TERM_SESSION_ID', 'TERM_PROGRAM_VERSION', 'NODE_OPTIONS',
  // Variables of a running Claude Code session (id, effort, path): a new session doesn't inherit them.
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID', 'CLAUDE_EFFORT', 'NoDefaultCurrentDirectoryInExePath',
  // Atelier's zsh files set them for each terminal: never inherited (e.g. app launched from an Atelier terminal).
  'ATELIER_USER_ZDOTDIR', 'ATELIER_INIT_CMD', 'ATELIER_INIT_PENDING', 'ATELIER_USER_CLAUDE', 'ATELIER_MARK_NONCE',
  'ATELIER_USER_ALIASES', 'ATELIER_PROMPT_NONCE', 'ATELIER_START_PATH'
]);
export const DROPPED_PREFIXES = ['ELECTRON_', 'CMUX_', 'VSCODE_', 'ITERM_', 'KITTY_', 'WEZTERM_', 'GHOSTTY_', 'ALACRITTY_'];

const DROPPED_UPPER = new Set([...DROPPED].map((k) => k.toUpperCase()));

/** False for variables a terminal must never inherit (see DROPPED and DROPPED_PREFIXES); any case on Windows. */
export function inherited(k: string): boolean {
  if (pathStyle() === 'win32') {
    const u = k.toUpperCase();
    return !DROPPED_UPPER.has(u) && !DROPPED_PREFIXES.some((p) => u.startsWith(p));
  }
  return !DROPPED.has(k) && !DROPPED_PREFIXES.some((p) => k.startsWith(p));
}

function cleanPath(p: string): string {
  // Other terminals' shims would intercept `claude` before Atelier's function.
  const shims = pathStyle() === 'win32' ? /[\\/]cmux-cli-shims/ : /\/cmux-cli-shims/;
  return pathListJoin(pathListSplit(p).filter((d) => d && !shims.test(d) && !d.includes('/cmux.app/Contents/Resources/bin')));
}

/** The key the environment uses for a variable: the exact name on POSIX, whichever spelling is there on Windows. */
const keyOf = (env: Record<string, string>, name: string): string | undefined => Object.keys(env).find((k) => envKey(k) === envKey(name));

export function buildTerminalEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || !inherited(k)) continue;
    env[k] = v;
  }
  const pathKey = keyOf(env, 'PATH');
  if (pathKey && env[pathKey]) env[pathKey] = cleanPath(env[pathKey]);
  // Claude Code sets GIT_EDITOR=true for its commands: in a real terminal git commit must open the editor.
  const editorKey = keyOf(env, 'GIT_EDITOR');
  if (editorKey && env[editorKey] === 'true') delete env[editorKey];
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Atelier';
  if (!env.LANG) env.LANG = defaultLang();
  return { ...env, ...extra };
}

/** atelierd's own ATELIER_* variables (dev and test overrides such as ATELIER_CLAUDE_BIN); per-terminal ones excluded. */
export function atelierOwn(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && k.startsWith('ATELIER_') && inherited(k)) out[k] = v;
  return out;
}
