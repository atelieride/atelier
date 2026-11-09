import { expect, test } from 'vitest';
import { buildTerminalEnv, defaultLang } from './env';

test('strips Electron variables and sets the terminal ones', () => {
  const env = buildTerminalEnv({ PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1', HOME: '/Users/x' }, { ATELIER_TERMINAL_ID: 't1' });
  expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  expect(env.ELECTRON_NO_ASAR).toBeUndefined();
  expect(env.TERM).toBe('xterm-256color');
  expect(env.COLORTERM).toBe('truecolor');
  expect(env.TERM_PROGRAM).toBe('Atelier');
  expect(env.ATELIER_TERMINAL_ID).toBe('t1');
  expect(env.HOME).toBe('/Users/x');
});
test('missing LANG → UTF-8 from the system language', () => {
  const env = buildTerminalEnv({ PATH: '/usr/bin' }, {});
  expect(env.LANG).toMatch(/^[a-z]{2}_[A-Z]{2}\.UTF-8$/);
});
test('existing LANG → respected', () => {
  expect(buildTerminalEnv({ LANG: 'it_IT.UTF-8' }, {}).LANG).toBe('it_IT.UTF-8');
});
test('defaultLang has the right shape', () => {
  expect(defaultLang()).toMatch(/\.UTF-8$/);
});

test('does not inherit variables from other terminals, Claude Code and Node', () => {
  const env = buildTerminalEnv({
    PATH: '/var/folders/x/T/cmux-cli-shims/ABC:/Users/x/.local/bin:/usr/bin',
    HOME: '/Users/x', SSH_AUTH_SOCK: '/s', CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '1', CLAUDE_PROJECT_DIR: '/p',
    CLAUDE_CODE_MESSAGING_SOCKET: '/s', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_CODE_CHILD_SESSION: '1',
    CMUX_SOCKET: '/c', TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%1', VSCODE_PID: '1', VSCODE_IPC_HOOK: 'x',
    TERM_SESSION_ID: 'w0', TERM_PROGRAM_VERSION: '3.5', ITERM_SESSION_ID: 'i', NODE_OPTIONS: '--inspect',
    KITTY_WINDOW_ID: '1', WEZTERM_PANE: '1', GHOSTTY_RESOURCES_DIR: '/g', ALACRITTY_WINDOW_ID: '1'
  }, {});
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_CHILD_SESSION', 'CMUX_SOCKET', 'TMUX', 'TMUX_PANE', 'VSCODE_PID', 'VSCODE_IPC_HOOK',
    'TERM_SESSION_ID', 'TERM_PROGRAM_VERSION', 'ITERM_SESSION_ID', 'NODE_OPTIONS', 'KITTY_WINDOW_ID', 'WEZTERM_PANE',
    'GHOSTTY_RESOURCES_DIR', 'ALACRITTY_WINDOW_ID']) {
    expect(env[k], k).toBeUndefined();
  }
  expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1'); // user settings stay
  expect(env.SSH_AUTH_SOCK).toBe('/s');
  expect(env.PATH).toBe('/Users/x/.local/bin:/usr/bin');
});

test('Atelier\'s per-terminal variables are never inherited (app launched from an Atelier terminal)', () => {
  const env = buildTerminalEnv({ HOME: '/h', ATELIER_USER_ALIASES: "alias -- 'x=y'", ATELIER_MARK_NONCE: 'n', ATELIER_INIT_CMD: 'c' }, {});
  for (const k of ['ATELIER_USER_ALIASES', 'ATELIER_MARK_NONCE', 'ATELIER_INIT_CMD']) expect(env[k], k).toBeUndefined();
});

test('Claude Code\'s and other terminals\' session variables that change command behavior', () => {
  const env = buildTerminalEnv({
    PATH: '/Applications/cmux.app/Contents/Resources/bin:/usr/bin', GIT_EDITOR: 'true', CLAUDE_EFFORT: 'high',
    CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_BRIDGE_SESSION_ID: 'b', CLAUDE_CODE_EXECPATH: '/x', CLAUDE_CODE_SESSION_ATTENDED: '1',
    CLAUDE_PID: '1', NoDefaultCurrentDirectoryInExePath: '1', CLAUDE_CONFIG_DIR: '/c'
  }, {});
  for (const k of ['GIT_EDITOR', 'CLAUDE_EFFORT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID', 'NoDefaultCurrentDirectoryInExePath']) expect(env[k], k).toBeUndefined();
  expect(env.CLAUDE_CONFIG_DIR).toBe('/c');
  expect(env.PATH).toBe('/usr/bin');
});
test('GIT_EDITOR set by the user (not "true") stays', () => {
  expect(buildTerminalEnv({ GIT_EDITOR: 'nvim' }, {}).GIT_EDITOR).toBe('nvim');
});
