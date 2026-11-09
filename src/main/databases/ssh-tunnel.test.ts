// The SSH tunnel's pure parts: the argv handed to ssh, the
// binary per platform, the problem an ssh failure shows, a forwarded connection ssh couldn't open, and stderr kept
// bounded. The process itself runs against a fake ssh in tests/integration/db-ssh.test.ts.
import { describe, expect, test } from 'vitest';
import { HOST_KEY_MESSAGE, STDERR_MAX, channelFailure, keepTail, readyTimeoutMessage, sshArgs, sshBinary, sshFailure } from './ssh-tunnel';

const ssh = { host: 'bastion.example.com', port: 2222, user: 'deploy' };
const target = { host: 'db.internal', port: 5432 };

describe('sshArgs', () => {
  test('-N, the forward bound to 127.0.0.1, the port, BatchMode and the options, then -- and the destination', () => {
    // The brief's array plus '--' before the destination: ssh's getopt stops reading options there.
    // Never a ControlMaster — a tunnel neither joins the user's master (its forward would live in that process,
    // out of our reach) nor leaves one behind (ControlPersist would keep the bastion connection after close()).
    expect(sshArgs(ssh, target, 54321)).toEqual([
      '-N', '-L', '127.0.0.1:54321:db.internal:5432', '-p', '2222', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o',
      'ConnectTimeout=8', '-o', 'ServerAliveInterval=30', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '--', 'deploy@bastion.example.com'
    ]);
  });

  // Port and user are optional, so a ~/.ssh/config alias's Port and User apply.
  test('port null: no -p; user empty: the host alone as destination, still after --', () => {
    const opts = [
      '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=30', '-o', 'ControlMaster=no',
      '-o', 'ControlPath=none'
    ];
    const fwd = ['-N', '-L', '127.0.0.1:54321:db.internal:5432'];
    expect(sshArgs({ host: 'prod-bastion', port: null, user: 'deploy' }, target, 54321)).toEqual([...fwd, ...opts, '--', 'deploy@prod-bastion']);
    expect(sshArgs({ host: 'prod-bastion', port: 2222, user: '' }, target, 54321)).toEqual([...fwd, '-p', '2222', ...opts, '--', 'prod-bastion']);
    expect(sshArgs({ host: 'prod-bastion', port: null, user: '' }, target, 54321)).toEqual([...fwd, ...opts, '--', 'prod-bastion']);
  });

  test('an IPv6 target is bracketed in the forward; an IPv4 one and a name are not', () => {
    expect(sshArgs(ssh, { host: '::1', port: 5432 }, 6000)[2]).toBe('127.0.0.1:6000:[::1]:5432');
    expect(sshArgs(ssh, { host: 'fd00::5', port: 6543 }, 6000)[2]).toBe('127.0.0.1:6000:[fd00::5]:6543');
    expect(sshArgs(ssh, { host: 'fe80::1%en0', port: 5432 }, 6000)[2]).toBe('127.0.0.1:6000:[fe80::1%en0]:5432');
    expect(sshArgs(ssh, { host: '::ffff:10.0.0.5', port: 5432 }, 6000)[2]).toBe('127.0.0.1:6000:[::ffff:10.0.0.5]:5432');
    expect(sshArgs(ssh, { host: '10.0.0.5', port: 5432 }, 6000)[2]).toBe('127.0.0.1:6000:10.0.0.5:5432');
    expect(sshArgs(ssh, { host: 'localhost', port: 5432 }, 6000)[2]).toBe('127.0.0.1:6000:localhost:5432');
  });

  // Hosts are host names, IPv4 or IPv6 literals ([A-Za-z0-9.-], no leading '-'; hex, ':', '.' and
  // an optional %zone), users [A-Za-z0-9._-] with no leading '-'. ssh would read a leading '-' as an option
  // (`-oProxyCommand=…` runs a command); '@' would move the destination; the rest has no place in a name.
  const badHosts = [
    '-oProxyCommand=touch /tmp/pwned', '-v', 'a b', 'a\tb', 'a\nb', 'a\rb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a\u00a0b', 'a\u2028b', '',
    'me@bastion', 'a;b', '$(x)', '`x`', "a'b", 'a"b', '${HOME}', 'a/b', 'a\\b', 'bastion:22', 'fe80::1%en 0', 'fe80::1%', 'x'.repeat(256)
  ];
  const badUsers = ['-oProxyCommand=x', '-v', 'a b', 'a\tb', 'a\nb', 'a\u0000b', 'a\u00a0b', 'me@x', 'a;b', '$(x)', '`x`', "a'b", '${HOME}', 'a/b', 'a\\b', 'a:b', 'u'.repeat(129)];
  test.each(badHosts)('refuses the SSH host %j (RangeError)', (host) => {
    expect(() => sshArgs({ ...ssh, host }, target, 6000)).toThrow(RangeError);
  });
  test.each(badHosts)('refuses the database host %j through a tunnel (RangeError)', (host) => {
    expect(() => sshArgs(ssh, { host, port: 5432 }, 6000)).toThrow(RangeError);
  });
  test.each(badUsers)('refuses the SSH user %j (RangeError)', (user) => {
    expect(() => sshArgs({ ...ssh, user }, target, 6000)).toThrow(RangeError);
  });

  test('names, addresses and users the rules allow', () => {
    expect(sshArgs({ host: 'bastion-1.example.com', port: 22, user: 'deploy-bot' }, target, 6000).at(-1)).toBe('deploy-bot@bastion-1.example.com');
    expect(sshArgs({ host: '10.0.0.1', port: 22, user: 'first.last_2' }, target, 6000).at(-1)).toBe('first.last_2@10.0.0.1');
    expect(sshArgs({ host: 'fd00::1', port: 22, user: '_svc' }, target, 6000).at(-1)).toBe('_svc@fd00::1');
    expect(sshArgs({ host: 'B4STION', port: 22, user: '.x' }, { host: 'db-1.internal', port: 5432 }, 6000).at(-1)).toBe('.x@B4STION');
  });

  // '_' is neither a shell nor an ssh metacharacter; ~/.ssh/config aliases and compose service names use it.
  test("'_' in the SSH host (an alias) and the database host (a compose service)", () => {
    expect(sshArgs({ host: 'prod_bastion', port: null, user: '' }, { host: 'postgres_db', port: 5432 }, 6000)).toEqual([
      '-N', '-L', '127.0.0.1:6000:postgres_db:5432', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=8', '-o',
      'ServerAliveInterval=30', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '--', 'prod_bastion'
    ]);
    expect(sshArgs({ host: '_bastion', port: 22, user: 'me' }, { host: '_db', port: 5432 }, 6000).at(-1)).toBe('me@_bastion');
  });

  test('refuses ports outside 1–65535', () => {
    for (const port of [0, 65536, 22.5, Number.NaN]) {
      expect(() => sshArgs({ ...ssh, port }, target, 6000)).toThrow(RangeError);
      expect(() => sshArgs(ssh, { ...target, port }, 6000)).toThrow(RangeError);
      expect(() => sshArgs(ssh, target, port)).toThrow(RangeError);
    }
  });
});

describe('sshBinary', () => {
  test("the system's ssh: /usr/bin/ssh on macOS (and Linux), OpenSSH under SystemRoot on Windows", () => {
    expect(sshBinary('darwin', {})).toBe('/usr/bin/ssh');
    expect(sshBinary('linux', {})).toBe('/usr/bin/ssh');
    expect(sshBinary('win32', { SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\OpenSSH\\ssh.exe');
    expect(sshBinary('win32', { SystemRoot: 'D:\\WINNT' })).toBe('D:\\WINNT\\System32\\OpenSSH\\ssh.exe');
    expect(sshBinary('win32', { SystemRoot: 'C:\\Windows\\' })).toBe('C:\\Windows\\System32\\OpenSSH\\ssh.exe');
    expect(sshBinary('win32', {})).toBe('C:\\Windows\\System32\\OpenSSH\\ssh.exe');
  });
});

describe('sshFailure: what the view shows when ssh exits before the tunnel opens', () => {
  test("ssh's last non-empty stderr line", () => {
    expect(sshFailure('Permission denied (publickey).\n', 255, null)).toBe('Permission denied (publickey).');
    expect(sshFailure("Warning: Permanently added 'b' (ED25519) to the list of known hosts.\r\nme@b: Permission denied (publickey).\r\n\r\n", 255, null))
      .toBe('me@b: Permission denied (publickey).');
    expect(sshFailure('ssh: Could not resolve hostname nope: nodename nor servname provided, or not known\n', 255, null))
      .toBe('ssh: Could not resolve hostname nope: nodename nor servname provided, or not known');
  });

  test('a host key ssh does not trust: the line, and what to do about it', () => {
    expect(HOST_KEY_MESSAGE).toBe('Host key verification failed. Connect once with ssh in a terminal to trust this host.');
    expect(sshFailure('No ED25519 host key is known for b and you have requested strict checking.\r\nHost key verification failed.\r\n', 255, null)).toBe(HOST_KEY_MESSAGE);
  });

  test('control characters are dropped from the line', () => {
    expect(sshFailure('\u001b[31mboom\u001b[0m\u0007\n', 255, null)).toBe('[31mboom[0m');
  });

  test('no stderr: the exit code, or the signal that stopped it', () => {
    expect(sshFailure('', 255, null)).toBe('ssh exited with code 255');
    expect(sshFailure(' \n\r\n', 1, null)).toBe('ssh exited with code 1');
    expect(sshFailure('', null, 'SIGKILL')).toBe('ssh stopped (SIGKILL)');
  });
});

describe('channelFailure: why ssh could not open a forwarded connection', () => {
  test('the reason of the last `channel N: open failed:` line, or null', () => {
    expect(channelFailure('')).toBeNull();
    expect(channelFailure('Warning: Permanently added b.\n')).toBeNull();
    expect(channelFailure('channel 2: open failed: connect failed: Connection refused\n')).toBe('connect failed: Connection refused');
    expect(channelFailure('channel 2: open failed: connect failed: Connection refused\r\nchannel 3: open failed: administratively prohibited: open failed\r\n'))
      .toBe('administratively prohibited: open failed');
    expect(channelFailure('channel 2: open failed: connect failed: Name or service not known\nsomething else\n')).toBe('connect failed: Name or service not known');
    expect(channelFailure('channel 2: open failed: \u001b[1mx\u0007\n')).toBe('[1mx');
  });
});

test('keepTail keeps only the last STDERR_MAX characters of stderr', () => {
  expect(STDERR_MAX).toBe(4096);
  expect(keepTail('abc', 'def')).toBe('abcdef');
  const t = keepTail('x'.repeat(STDERR_MAX), 'yz');
  expect(t).toHaveLength(STDERR_MAX);
  expect(t.endsWith('xyz')).toBe(true);
  expect(keepTail('', 'q'.repeat(3 * STDERR_MAX))).toHaveLength(STDERR_MAX);
});

test('readyTimeoutMessage says the actual seconds', () => {
  expect(readyTimeoutMessage(8000)).toBe("The SSH tunnel didn't open in 8 s");
  expect(readyTimeoutMessage(500)).toBe("The SSH tunnel didn't open in 0.5 s");
  expect(readyTimeoutMessage(12_000)).toBe("The SSH tunnel didn't open in 12 s");
});
