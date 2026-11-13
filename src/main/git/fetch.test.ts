import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { linearBudget } from '../../../tests/support/platform';
import { bestTime } from '../../../tests/support/timing';
import { FETCH_ARGS, classifyFetch, fetchEnv, fetchMessage } from './fetch';

const pairs = (env: NodeJS.ProcessEnv) => Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));

test('the one fetch form: every remote, no submodules, no maintenance, quiet', () => {
  expect(FETCH_ARGS).toEqual(['fetch', '--all', '--no-recurse-submodules', '--no-auto-maintenance', '--no-show-forced-updates', '--quiet']);
});

describe('fetchEnv', () => {
  const base = { PATH: '/usr/bin', HOME: '/Users/x', SSH_AUTH_SOCK: '/tmp/agent', GIT_DIR: '/elsewhere/.git', GIT_SSH_COMMAND: 'evil', GIT_ASKPASS: '/bin/askpass', GIT_CONFIG_GLOBAL: '/x' };

  test('no inherited GIT_* variable, no prompt of any kind, the user\'s agent and HOME kept', () => {
    const env = fetchEnv(base, false);
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/Users/x', SSH_AUTH_SOCK: '/tmp/agent', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never', LC_ALL: 'C' });
    // Empty, not unset: git then skips core.askPass and SSH_ASKPASS too (git < 2.46 ignores credential.interactive).
    expect(env.GIT_ASKPASS).toBe('');
  });

  test('forced settings: no hook, no fsmonitor, no ext:: remote, no submodule, no gc or maintenance, no interactive credentials', () => {
    expect(pairs(fetchEnv(base, false))).toEqual({
      'core.hooksPath': '/dev/null', 'core.fsmonitor': 'false', 'protocol.ext.allow': 'never', 'fetch.recurseSubmodules': 'false',
      'fetch.writeCommitGraph': 'false', 'gc.auto': '0', 'maintenance.auto': 'false', 'credential.interactive': 'false'
    });
  });

  test('isolated (tests): no credential helper, no global or system config', () => {
    const env = fetchEnv(base, true);
    expect(pairs(env)['credential.helper']).toBe('');
    expect(env).toMatchObject({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    expect(pairs(fetchEnv(base, false))['credential.helper']).toBeUndefined();
  });
});

describe('classifyFetch', () => {
  test.each([
    ["fatal: Authentication failed for 'https://github.com/a/b.git/'", 'auth'],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'auth'],
    ["fatal: could not read Password for 'https://x@github.com': Device not configured", 'auth'],
    // No terminal (detached) and an askpass in the environment that can't answer.
    ["error: unable to read askpass response from '/x/askpass'\nfatal: unable to get password from user", 'auth'],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'auth'],
    ['Host key verification failed.\nfatal: Could not read from remote repository.', 'auth'],
    ["fatal: unable to access 'https://h/x.git/': The requested URL returned error: 403", 'auth'],
    ["fatal: unable to access 'https://h/x.git/': The requested URL returned error: 401", 'auth'],
    ['remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed', 'auth'],
    ["error: cannot lock ref 'refs/remotes/origin/main': is at 1234 but expected 5678", 'busy'],
    ["error: Unable to create '/r/.git/refs/remotes/origin/main.lock': File exists.", 'busy'],
    ["fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com", 'network'],
    ["fatal: unable to access 'https://h/': Failed to connect to h port 443 after 3 ms: Couldn't connect to server", 'network'],
    ['ssh: connect to host github.com port 22: Operation timed out\nfatal: Could not read from remote repository.', 'network'],
    ['ssh: connect to host h port 22: Connection refused', 'network'],
    ['ssh: Could not resolve hostname h: nodename nor servname provided, or not known', 'network'],
    ['kex_exchange_identification: read: Connection reset by peer', 'network'],
    ["fatal: unable to access 'https://h/': Network is unreachable", 'network'],
    ["fatal: unable to access 'https://h/x.git/': The requested URL returned error: 500", 'error'],
    ['remote: Repository not found.\nfatal: repository \'https://github.com/a/gone.git/\' not found', 'error'],
    ["fatal: transport 'ext' not allowed", 'error'],
    ['', 'error']
  ])('%s → %s', (stderr, outcome) => expect(classifyFetch(stderr)).toBe(outcome));
});

describe('fetchMessage', () => {
  test('the fatal/error line, without its prefix', () => {
    expect(fetchMessage('hint: something\nfatal: Authentication failed for \'https://github.com/a/b.git/\'\n')).toBe("Authentication failed for 'https://github.com/a/b.git/'");
    expect(fetchMessage('Host key verification failed.\nfatal: Could not read from remote repository.\n\nPlease make sure…')).toBe('Host key verification failed.');
  });
  test('never a credential: user:token@ removed from URLs', () => {
    const m = fetchMessage("fatal: unable to access 'https://ada:ghp_SECRET123@github.com/a/b.git/': The requested URL returned error: 403");
    expect(m).not.toContain('SECRET');
    expect(m).not.toContain('ada:');
    expect(m).toContain('https://github.com/a/b.git/');
    expect(fetchMessage("fatal: Authentication failed for 'https://ghp_TOKEN@github.com/x'")).not.toContain('ghp_TOKEN');
  });
  test('a megabyte on one line is answered at once (the scrub is linear, lines cut to 4 KB first)', () => {
    for (const line of ['x'.repeat(1_000_000), 'npm-run-build.v1.2.3-'.repeat(50_000), 'a://'.repeat(250_000)]) {
      expect(fetchMessage(`fatal: ${line}`).length).toBeLessThanOrEqual(200);
      expect(bestTime(() => fetchMessage(`fatal: ${line}`), 3)).toBeLessThan(linearBudget(200));
    }
    // A credential past the first 4 KB of a line never shows: the message is cut at 200 characters anyway.
    expect(fetchMessage(`fatal: ${'x'.repeat(5000)} https://u:SECRET@h/x`)).not.toContain('SECRET');
  });
  test('at most 200 characters; empty stays empty', () => {
    expect(fetchMessage(`fatal: ${'x'.repeat(500)}`).length).toBeLessThanOrEqual(200);
    expect(fetchMessage('')).toBe('');
  });
});

test('static: one process, git with the fixed argv in the root, nothing else', () => {
  const src = readFileSync(join(__dirname, 'fetch.ts'), 'utf8');
  expect([...src.matchAll(/\b(spawn|execFile|exec|fork|spawnSync|execFileSync|execSync)\s*\(/g)].map((m) => m[0])).toEqual(['spawn(']);
  expect(src).toContain("spawn('git', ['-C', root, ...FETCH_ARGS], { env: fetchEnv(process.env, o.isolated), ...childOptions(), stdio: ['ignore', 'ignore', 'pipe'] })");
});
