import { afterEach, describe, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { WRITE_CONFIG, writeEnv } from './write-env';

const pairs = (env: NodeJS.ProcessEnv) => Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));

describe('writeEnv', () => {
  const base = {
    PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/x', SSH_AUTH_SOCK: '/tmp/agent', GPG_TTY: '/dev/ttys001',
    GIT_DIR: '/elsewhere/.git', GIT_INDEX_FILE: '/elsewhere/index', GIT_WORK_TREE: '/elsewhere', GIT_SSH_COMMAND: 'evil',
    GIT_ASKPASS: '/bin/askpass', GIT_CONFIG_GLOBAL: '/x', GIT_TRACE2_EVENT: '/tmp/someone-elses.log', GIT_EDITOR: 'vim'
  };
  afterEach(() => { delete process.env.ATELIER_TEST_GIT_ISOLATED; });

  test('no inherited GIT_* variable (a hook started from a terminal would otherwise point git elsewhere)', () => {
    const env = writeEnv(base, { isolated: false });
    for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_SSH_COMMAND', 'GIT_CONFIG_GLOBAL', 'GIT_TRACE2_EVENT']) expect(env[k]).toBeUndefined();
    // The user's own variables stay: hooks need PATH, agents need their sockets.
    expect(env).toMatchObject({ PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/x', SSH_AUTH_SOCK: '/tmp/agent', GPG_TTY: '/dev/ttys001' });
  });

  test('no prompt of any kind, no editor; literal pathspecs left to runWrite (only path ops get them, never a hook)', () => {
    const env = writeEnv({ ...base, GIT_LITERAL_PATHSPECS: '1' }, { isolated: false });
    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never',
      GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':', GIT_MERGE_AUTOEDIT: 'no'
    });
    expect(env.GIT_LITERAL_PATHSPECS).toBeUndefined();
    // Empty, not unset: git then skips core.askPass and SSH_ASKPASS too.
    expect(env.GIT_ASKPASS).toBe('');
  });

  test("git's messages in English (classification reads them), the user's character set kept for hooks", () => {
    const env = writeEnv({ ...base, LANG: 'it_IT.UTF-8', LC_CTYPE: 'it_IT.UTF-8' }, { isolated: false });
    expect(env).toMatchObject({ LC_MESSAGES: 'C', LANGUAGE: 'C', LANG: 'it_IT.UTF-8', LC_CTYPE: 'it_IT.UTF-8' });
    expect(env.LC_ALL).toBeUndefined();
    // An LC_ALL of the user's would override LC_MESSAGES: its value moves to every other category instead.
    const all = writeEnv({ ...base, LC_ALL: 'it_IT.UTF-8' }, { isolated: false });
    expect(all.LC_ALL).toBeUndefined();
    expect(all).toMatchObject({ LC_MESSAGES: 'C', LANGUAGE: 'C', LC_CTYPE: 'it_IT.UTF-8', LC_COLLATE: 'it_IT.UTF-8', LC_NUMERIC: 'it_IT.UTF-8', LC_TIME: 'it_IT.UTF-8', LC_MONETARY: 'it_IT.UTF-8' });
  });

  test('forced settings through GIT_CONFIG_COUNT, never -c', () => {
    const cfg = pairs(writeEnv(base, { isolated: false }));
    expect(cfg).toEqual(Object.fromEntries(WRITE_CONFIG));
    expect(cfg).toMatchObject({
      'core.fsmonitor': 'false', 'protocol.ext.allow': 'never', 'gc.auto': '0', 'maintenance.auto': 'false',
      'credential.interactive': 'false', 'commit.verbose': 'false', 'advice.pushNonFFCurrent': 'false', 'advice.statusHints': 'false',
      'advice.detachedHead': 'false', 'advice.mergeConflict': 'false', 'advice.waitingForEditor': 'false',
      // A pull --rebase moves only the current branch and never stashes on its own (our flags say so too).
      'rebase.updateRefs': 'false', 'rebase.autoStash': 'false'
    });
  });

  test('hooks run: core.hooksPath is never forced (unlike fetch), isolated or not', () => {
    for (const isolated of [false, true]) {
      const env = writeEnv(base, { isolated });
      expect(Object.keys(pairs(env)).map((k) => k?.toLowerCase())).not.toContain('core.hookspath');
      expect(Object.values(env).join('\n')).not.toMatch(/hooksPath/i);
    }
  });

  test('isolated (tests): no global or system config, no credential helper', () => {
    const env = writeEnv(base, { isolated: true });
    expect(env).toMatchObject({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    expect(pairs(env)['credential.helper']).toBe('');
    const real = writeEnv(base, { isolated: false });
    expect(real.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(real.GIT_CONFIG_NOSYSTEM).toBeUndefined();
    expect(pairs(real)['credential.helper']).toBeUndefined();
  });

  test('isolated by default only when ATELIER_TEST_GIT_ISOLATED=1 (e2eEnv)', () => {
    expect(writeEnv(base).GIT_CONFIG_GLOBAL).toBeUndefined();
    process.env.ATELIER_TEST_GIT_ISOLATED = '1';
    expect(writeEnv(base).GIT_CONFIG_GLOBAL).toBe('/dev/null');
  });

  test('trace2 to the op\'s Unix socket when given, nothing otherwise', () => {
    expect(writeEnv(base, { isolated: false, trace2: '/t/atelier-1/3.sock' }).GIT_TRACE2_EVENT).toBe('af_unix:stream:/t/atelier-1/3.sock');
    expect(writeEnv(base, { isolated: false, trace2: '' }).GIT_TRACE2_EVENT).toBeUndefined();
    expect(writeEnv(base, { isolated: false }).GIT_TRACE2_EVENT).toBeUndefined();
  });

  test('the base environment is not modified', () => {
    const copy = { ...base };
    writeEnv(copy, { isolated: true, trace2: '/t/1.sock' });
    expect(copy).toEqual(base);
  });
});

describe('writeEnv on Windows', () => {
  afterEach(() => { resetPlatformForTests(); });
  test('core.longpaths on: a worktree\'s checkout passes MAX_PATH; never on macOS', () => {
    initPlatform('win32');
    expect(pairs(writeEnv({ PATH: 'C:\\Windows' }, { isolated: false }))['core.longpaths']).toBe('true');
    resetPlatformForTests();
    expect(pairs(writeEnv({ PATH: '/usr/bin' }, { isolated: false }))['core.longpaths']).toBeUndefined();
  });
});
