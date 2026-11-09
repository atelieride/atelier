import { describe, expect, test } from 'vitest';
import { posixTest } from '../../../tests/support/platform';
import { PANE_FORMAT, findTmux, tmuxEnv, validateTmuxArgs } from './exec';

describe('validateTmuxArgs', () => {
  test.each([
    [['list-panes', '-a', '-F', PANE_FORMAT]],
    [['capture-pane', '-p', '-e', '-J', '-S', '-2000', '-t', '%3']],
  ])('allowed: %j', (a) => expect(() => validateTmuxArgs(a)).not.toThrow());
  test.each([
    [['attach']], [['attach-session', '-t', 'acme']], [['-C']], [['send-keys', '-t', '%0', 'ls', 'Enter']], [['kill-session']],
    [['kill-server']], [['set-option', 'mouse', 'on']], [['pipe-pane', '-t', '%0', 'cat']], [['new-session']],
    [['capture-pane', '-p', '-t', 'acme:0']],
    [['list-panes', '-a', '-F', '#{pane_id}#(touch /tmp/x)']], [['list-panes', '-a', '-F', '#{pane_id}']],
    [['display-message', '-p', '-t', '%0', '#{pane_current_command}']], [['capture-pane', '-p', '-t', '%0;kill-server']], [['list-panes', '-a', '-F', 'x', ';', 'kill-server']], [[]]
  ])('forbidden: %j', (a) => expect(() => validateTmuxArgs(a)).toThrow());
});

test('tmuxEnv: TMUX and TMUX_PANE are not passed through (otherwise the server the app was launched from would be read)', () => {
  const env = tmuxEnv({ PATH: '/usr/bin', TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%3', TMUX_TMPDIR: '/t', HOME: '/h' });
  expect(env.TMUX).toBeUndefined();
  expect(env.TMUX_PANE).toBeUndefined();
  expect(env.TMUX_TMPDIR).toBe('/t');
  expect(env.HOME).toBe('/h');
});

// POSIX: POSIX PATH fixtures through node:path.
posixTest('findTmux: PATH first, then known locations (Homebrew) even with the Finder\'s minimal PATH', () => {
  const exists = (p: string) => p === '/opt/homebrew/bin/tmux';
  expect(findTmux('/usr/bin:/bin:/usr/sbin:/sbin', exists)).toBe('/opt/homebrew/bin/tmux');
  expect(findTmux('/my/bin:/usr/bin', (p) => p === '/my/bin/tmux' || p === '/opt/homebrew/bin/tmux')).toBe('/my/bin/tmux');
  expect(findTmux('/usr/bin', () => false)).toBeNull();
});
