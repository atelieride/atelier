import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { EnvBlockScanner, aliasSnippet, captureShellEnv, filterCapturedEnv, parseCaptured, parseEnvBlock } from './shell-env';

const block = (entries: string[], m = 'MK') => `noise from .zshrc\n${m}S${entries.join('\0')}\0${m}E`;

test('parseEnvBlock: entries between the markers, values may contain = and newlines', () => {
  expect(parseEnvBlock(block(['A=1', 'B=x=y', 'C=line1\nline2', 'EMPTY=']), 'MK')).toEqual({ A: '1', B: 'x=y', C: 'line1\nline2', EMPTY: '' });
});

test('parseEnvBlock: missing or unterminated block → null', () => {
  expect(parseEnvBlock('A=1\0B=2\0', 'MK')).toBeNull();
  expect(parseEnvBlock('MKSA=1\0', 'MK')).toBeNull();
});

test('parseEnvBlock: names that are not variables (bash exported functions) are skipped', () => {
  expect(parseEnvBlock(block(['BASH_FUNC_f%%=() {  echo; }', '=x', '1A=2', 'OK_1=y']), 'MK')).toEqual({ OK_1: 'y' });
});

test('filterCapturedEnv drops per-shell, Atelier and foreign-terminal variables, keeps the user\'s tools', () => {
  const env = filterCapturedEnv({
    PATH: '/Users/x/.nvm/versions/node/v22/bin:/usr/bin', NVM_DIR: '/Users/x/.nvm', PYENV_SHELL: 'zsh', HOME: '/Users/x',
    LANG: 'it_IT.UTF-8', EDITOR: 'nvim', SSH_AUTH_SOCK: '/s',
    PWD: '/Users/x', OLDPWD: '/', SHLVL: '1', _: '/usr/bin/env', PS1: '%~ ', PROMPT: 'x', RPROMPT: 'y', ZDOTDIR: '/z',
    ATELIER_HOME: '/a', ATELIER_TERMINAL_ID: 't', TERM_SESSION_ID: 'w0', TERM_SESSION_KEY: 'k', GPG_TTY: 'not a tty',
    P9K_TTY: 'old', _P9K_TTY: '/dev/ttys001', CLAUDECODE: '1', ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '1'
  });
  expect(env).toEqual({
    PATH: '/Users/x/.nvm/versions/node/v22/bin:/usr/bin', NVM_DIR: '/Users/x/.nvm', PYENV_SHELL: 'zsh', HOME: '/Users/x',
    LANG: 'it_IT.UTF-8', EDITOR: 'nvim', SSH_AUTH_SOCK: '/s'
  });
});

function fakeShell(body: string): string {
  const f = join(mkdtempSync(join(tmpdir(), 'atl-fs-')), 'fake-zsh');
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
}

test('captureShellEnv: login+interactive, stdin at EOF (a startup question cannot hang), environment filtered', async () => {
  // $4 is the -c script: the fake shell answers a question first, then runs it like zsh would.
  const shell = fakeShell('read answer; echo "noise"; export ARGS="$1 $2 $3" ANSWER="[$answer]"; eval "$4"');
  const { env, claude } = await captureShellEnv({ shell, env: { PATH: '/usr/bin:/bin', HOME: '/h', SHLVL: '3', ATELIER_HOME: '/a' }, cwd: tmpdir() }).result;
  expect(claude).toBeNull();
  expect(env).toMatchObject({ PATH: '/usr/bin:/bin', HOME: '/h', ARGS: '-l -i -c', ANSWER: '[]' });
  expect(env.SHLVL).toBeUndefined();
  expect(env.ATELIER_HOME).toBeUndefined();
});

test('captureShellEnv: a shell that never prints its environment times out; one that exits fails at once', async () => {
  const t0 = Date.now();
  await expect(captureShellEnv({ shell: fakeShell('sleep 5'), env: { PATH: '/usr/bin:/bin' }, cwd: tmpdir(), timeoutMs: 300 }).result).rejects.toThrow(/not captured in 300 ms/);
  expect(Date.now() - t0).toBeLessThan(2000);
  await expect(captureShellEnv({ shell: fakeShell('exit 3'), env: { PATH: '/usr/bin:/bin' }, cwd: tmpdir() }).result).rejects.toThrow(/exited \(3\)/);
});

test('EnvBlockScanner: markers split across chunks, block found once complete', () => {
  const sc = new EnvBlockScanner('MK');
  const parts = ['noise M', 'KSA=1\0B=', '2\0M', 'KE trailing'];
  expect(parts.map((p) => sc.push(p))).toEqual([null, null, null, 'A=1\0B=2\0']);
  // One character at a time: every split of both markers.
  const one = new EnvBlockScanner('MK');
  const r = [...'xMMKSA=1\0MKX\0MKE'].map((c) => one.push(c));
  expect(r.filter((x) => x !== null)).toEqual(['A=1\0MKX\0']);
});

// atelierd has one thread: rescanning everything received on every chunk would be quadratic (up to 16 MB).
test('EnvBlockScanner: scanning is linear in the output, not quadratic', () => {
  const sc = new EnvBlockScanner('__ATELIER_ENV_0123456789abcdef_');
  const noise = 'x'.repeat(8 * 1024);
  const t0 = Date.now();
  for (let i = 0; i < 2048; i++) expect(sc.push(noise)).toBeNull();
  expect(sc.push('__ATELIER_ENV_0123456789abcdef_SA=1\0__ATELIER_ENV_0123456789abcdef_E')).toBe('A=1\0');
  expect(Date.now() - t0).toBeLessThan(300);
}, 60000);

test('captureShellEnv: on timeout the whole process group goes, background jobs of the config included', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-pg-'));
  const pidFile = join(dir, 'bg.pid');
  const shell = fakeShell(`sleep 30 & echo $! > '${pidFile}'; sleep 30`);
  // A timeout long enough for the background job to start even on a loaded machine.
  const run = captureShellEnv({ shell, env: { PATH: '/usr/bin:/bin' }, cwd: tmpdir(), timeoutMs: 3000 }).result;
  const t0 = Date.now();
  const readPid = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : 0);
  while (!(readPid() > 1) && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
  await expect(run).rejects.toThrow(/not captured/);
  const pid = readPid();
  expect(pid).toBeGreaterThan(1);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const t1 = Date.now();
  while (alive() && Date.now() - t1 < 2000) await new Promise((r) => setTimeout(r, 20));
  const still = alive();
  if (still) process.kill(pid, 'SIGKILL');
  expect(still).toBe(false);
});

test('parseCaptured: the claude alias as zsh words, a path quoted, nothing otherwise', () => {
  expect(parseCaptured('A=1\0MKCa:~/.claude/local/claude --x', 'MK')).toEqual({ env: { A: '1' }, claude: '~/.claude/local/claude --x', aliases: [] });
  expect(parseCaptured("A=1\0MKCp:/opt/it's/claude", 'MK').claude).toBe("'/opt/it'\\''s/claude'");
  expect(parseCaptured('A=1\0MKC', 'MK')).toEqual({ env: { A: '1' }, claude: null, aliases: [] });
  expect(parseCaptured('A=1\0', 'MK')).toEqual({ env: { A: '1' }, claude: null, aliases: [] });
  expect(parseCaptured('A=1\0MKCp:relative', 'MK').claude).toBeNull();
});

test('parseCaptured: aliases as kind/name/value triples after the claude part; malformed or empty names skipped', () => {
  const c = parseCaptured('A=1\0MKCa:claude --xMKAr\0ll\0ls -lh\0g\0G\0| grep\0s\0txt\0vim\0r\0multi\0a\nb\0x\0bad\0v\0r\0\0empty\0r\0dangling', 'MK');
  expect(c.claude).toBe('claude --x');
  expect(c.env).toEqual({ A: '1' });
  expect(c.aliases).toEqual([
    { kind: 'r', name: 'll', value: 'ls -lh' }, { kind: 'g', name: 'G', value: '| grep' },
    { kind: 's', name: 'txt', value: 'vim' }, { kind: 'r', name: 'multi', value: 'a\nb' }
  ]);
  expect(parseCaptured('A=1\0MKCMKA', 'MK').aliases).toEqual([]);
});

test('aliasSnippet: every name and value quoted by atelierd, claude left to Atelier\'s function, too large → null', () => {
  const s = aliasSnippet([
    { kind: 'r', name: 'acme', value: '/Users/x/acme/dev.sh' }, { kind: 'r', name: 'claude', value: 'claude --x' },
    { kind: 'g', name: 'G', value: '| grep' }, { kind: 's', name: 'txt', value: 'vim' },
    { kind: 'r', name: '-', value: 'cd -' }, { kind: 'r', name: "it's", value: "echo 'q' $(date) `id` \\ \n2" },
    { kind: 'r', name: 'a=b', value: 'no' }, { kind: 'g', name: 'claude', value: 'claude; echo INJECTED' }
  ]);
  expect(s).toEqual({
    count: 5,
    code: [
      "alias -- 'acme=/Users/x/acme/dev.sh'", "alias -g -- 'G=| grep'", "alias -s -- 'txt=vim'", "alias -- '-=cd -'",
      `alias -- 'it'\\''s=echo '\\''q'\\'' $(date) \`id\` \\ \n2'`
    ].join('\n')
  });
  expect(aliasSnippet([])).toEqual({ count: 0, code: '' });
  expect(aliasSnippet([{ kind: 'r', name: 'big', value: 'x'.repeat(300 * 1024) }])).toBeNull();
  // The limit is in bytes, as in the environment: 100k three-byte characters are 300 KB.
  expect(aliasSnippet([{ kind: 'r', name: 'big', value: '€'.repeat(100 * 1024) }])).toBeNull();
});

// zsh parses the whole -c script before running it, with the user's aliases already defined by their .zshrc.
test('captureShellEnv: aliases named like the capture script\'s own words don\'t break it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-al-'));
  writeFileSync(join(home, '.zshrc'), [
    "alias printf='echo HIJACK'", "alias print='echo HIJACK'", "alias local='echo HIJACK'", "alias eval='echo HIJACK'",
    "alias -g do='HIJACK'", "alias -g in='HIJACK'", "alias -g then='HIJACK'", 'export MINE=1', "alias acme='/x/dev.sh'", ''
  ].join('\n'));
  const { env, aliases } = await captureShellEnv({ env: { PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: home }, cwd: home }).result;
  expect(env.MINE).toBe('1');
  expect(aliases).toContainEqual({ kind: 'r', name: 'acme', value: '/x/dev.sh' });
  expect(aliases).toContainEqual({ kind: 'g', name: 'in', value: 'HIJACK' });
});

// The script runs with the options of the user's config: ksh_arrays made "${(@kv)aliases}" its first value only.
test('captureShellEnv: options of the user\'s config (ksh_arrays, sh_word_split, no_unset, err_exit) don\'t break it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-al-'));
  writeFileSync(join(home, '.zshrc'), "setopt ksh_arrays sh_word_split no_unset err_exit\nalias a='one'\nalias b='two words'\n");
  const { aliases } = await captureShellEnv({ env: { PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: home }, cwd: home }).result;
  expect(aliases).toEqual(expect.arrayContaining([{ kind: 'r', name: 'a', value: 'one' }, { kind: 'r', name: 'b', value: 'two words' }]));
  expect(aliases.every((x) => x.name !== 'one' && x.name !== '1')).toBe(true);
});

// The script is in the environment of everything the user's config runs: its text must not hold whole markers.
test('captureShellEnv: a config that prints its environment doesn\'t fake the block', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-al-'));
  writeFileSync(join(home, '.zshrc'), 'export MINE=1\n/usr/bin/env\n');
  const { env } = await captureShellEnv({ env: { PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: home }, cwd: home }).result;
  expect(env.MINE).toBe('1');
});

test('captureShellEnv: the aliases of the user\'s real zsh config, all three kinds', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-al-'));
  writeFileSync(join(home, '.zshrc'), "alias acme='/x/dev.sh'\nalias -g G='| grep'\nalias -s txt=vim\nalias claude='claude --y'\n");
  const { aliases } = await captureShellEnv({ env: { PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: home }, cwd: home }).result;
  expect(aliases).toEqual(expect.arrayContaining([
    { kind: 'r', name: 'acme', value: '/x/dev.sh' }, { kind: 'g', name: 'G', value: '| grep' },
    { kind: 's', name: 'txt', value: 'vim' }, { kind: 'r', name: 'claude', value: 'claude --y' }
  ]));
});
