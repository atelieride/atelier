import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runDaemon, type RunDaemonOptions, type RunningDaemon } from '../../src/daemon/main';
import type { TerminalProfile } from '../../src/shared/protocol';
import { connectControl } from './helpers';
import type { ServerMessage, TerminalInfo } from '../../src/shared/protocol';

// Every shell here runs in temporary homes: fake HOME, fake user ZDOTDIR, temporary ATELIER_HOME.

const running: RunningDaemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

const until = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 30)); }
};

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

/** A fake user: HOME with a project folder and their own zsh config. */
function fakeUser(zshrc = 'PS1="USER-PROMPT$ "\n') {
  const home = tmp('atl-ph-');
  mkdirSync(join(home, 'proj'));
  const zdot = tmp('atl-pz-');
  writeFileSync(join(zdot, '.zshrc'), zshrc);
  return { home, zdot, proj: join(home, 'proj') };
}

async function start(u: { home: string; zdot: string }, o: Partial<RunDaemonOptions> = {}) {
  const d = await runDaemon({
    // A space, like the real "Application Support": every path in the rc must be quoted.
    home: join(tmp('atl-pd-'), 'A S'), version: 't', userClaudeSettings: '/nonexistent/x.json',
    userZdotdir: u.zdot, ...o, extraEnv: { HOME: u.home, ...o.extraEnv }
  });
  running.push(d);
  return d;
}

function open(d: RunningDaemon, cwd: string, profile?: TerminalProfile, command?: string, aliases?: boolean) {
  const info = d.terminals.create({ projectRoot: cwd, cwd, cols: 200, rows: 40, profile, command, aliases });
  let out = '';
  d.terminals.attach(info.id, () => {}, (x) => { out += x; });
  return { info, type: (s: string) => d.terminals.input(info.id, s + '\r'), get out() { return out; } };
}

const rgb = (hex: string) => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
const DIM = rgb('#646285');
const VIOLET = rgb('#C4B5FD');
const ROSE = rgb('#FB7185');

test('Atelier profile: Aurora prompt, no branch outside a repo, rose › after a failure, user .zshrc not loaded', async () => {
  const u = fakeUser('PS1="USER-PROMPT$ "\nexport FROM_USER_RC=1\n');
  const d = await start(u);
  const t = open(d, u.proj, 'atelier');
  expect(t.info.profile).toBe('atelier');
  await until(() => t.out.includes(`${DIM}~/proj\x1b[39m ${DIM}›`));
  expect(t.out).not.toContain(VIOLET);
  expect(t.out).not.toContain('USER-PROMPT');
  t.type('echo "U=${FROM_USER_RC-none} Z=${ZDOTDIR-unset}"; false');
  await until(() => t.out.includes(`U=none Z=${u.zdot}`) && t.out.includes(`${ROSE}›`));
});

test('Atelier profile: git branch in bold violet, short hash when detached, worktrees too', async () => {
  const u = fakeUser();
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' });
  git(u.proj, 'init', '-q', '-b', 'feat/x');
  git(u.proj, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one');
  mkdirSync(join(u.proj, 'sub'));
  const d = await start(u);
  const t = open(d, join(u.proj, 'sub'), 'atelier');
  await until(() => t.out.includes(`${DIM}~/proj/sub\x1b[39m \x1b[1m${VIOLET}feat/x\x1b[39m`));
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: u.proj, encoding: 'utf8' }).trim();
  git(u.proj, 'checkout', '-q', '--detach');
  t.type('cd ..');
  await until(() => t.out.includes(`${VIOLET}${sha.slice(0, 7)}\x1b[39m`));
  git(u.proj, 'worktree', 'add', '-q', '-b', 'wt-branch', join(u.home, 'wt'));
  t.type('cd ~/wt');
  await until(() => t.out.includes(`${VIOLET}wt-branch\x1b[39m`));
});

test('Atelier profile: private shared history in ATELIER_HOME, initial command, claude with the hooks', async () => {
  const u = fakeUser();
  const fake = join(u.home, 'fake-claude');
  writeFileSync(fake, '#!/bin/sh\necho "ARGS:$*"\n');
  chmodSync(fake, 0o755);
  const d = await start(u, { extraEnv: { ATELIER_CLAUDE_BIN: fake } });
  const t = open(d, u.proj, 'atelier', 'echo INIT-$((2+2))');
  await until(() => t.out.includes('INIT-4'));
  t.type('echo "H=$HISTFILE"; claude --model haiku');
  const hist = join(d.paths.shell, 'history');
  await until(() => t.out.includes(`H=${hist}`) && t.out.includes(`ARGS:--settings ${d.paths.settings} --model haiku`));
  await until(() => existsSync(hist) && readFileSync(hist, 'utf8').includes('claude --model haiku'));
  expect(statSync(hist).mode & 0o777).toBe(0o600);
});

test('Atelier profile: the captured environment arrives (PATH order included), the user rc\'s prompt does not', async () => {
  const u = fakeUser([
    'export FAKE_NVM_DIR=/fake/nvm', 'export PATH=/fake/nvm/bin:$PATH', 'alias gs="git status"',
    'PS1="USER-PROMPT$ "', 'NOT_EXPORTED=1', 'print "noise from the user rc"', ''
  ].join('\n'));
  const d = await start(u, { captureShellEnv: true });
  // Captured in the background at start (the same capture, still in flight).
  const captured = (await d.reloadEnv()).env;
  expect(captured.FAKE_NVM_DIR).toBe('/fake/nvm');
  for (const k of ['PWD', 'SHLVL', 'ZDOTDIR', 'PS1', 'NOT_EXPORTED', 'DISABLE_AUTO_UPDATE']) expect(captured[k], k).toBeUndefined();
  const t = open(d, u.proj, 'atelier');
  t.type('echo "N=$FAKE_NVM_DIR P1=${path[1]} X=${NOT_EXPORTED-no}"');
  await until(() => t.out.includes('N=/fake/nvm P1=/fake/nvm/bin X=no'));
  expect(t.out).not.toContain('USER-PROMPT');
  expect(t.out).not.toContain('noise from the user rc');
});

// The captured environment drops ATELIER_*: without carrying atelierd's own, `claude` in tests resolved to the
// real Claude Code on PATH instead of the fake one.
test('Atelier profile with a captured environment keeps atelierd\'s ATELIER_* overrides (the fake claude in tests)', async () => {
  const u = fakeUser('export FAKE_NVM_DIR=/fake/nvm\n');
  const prev = process.env.ATELIER_CLAUDE_BIN;
  process.env.ATELIER_CLAUDE_BIN = '/fake/claude-bin';
  try {
    const d = await start(u, { captureShellEnv: true });
    await d.reloadEnv();
    const t = open(d, u.proj, 'atelier');
    t.type('echo "B=${ATELIER_CLAUDE_BIN-none} N=$FAKE_NVM_DIR"');
    await until(() => t.out.includes('B=/fake/claude-bin N=/fake/nvm'));
  } finally {
    if (prev === undefined) delete process.env.ATELIER_CLAUDE_BIN; else process.env.ATELIER_CLAUDE_BIN = prev;
  }
});

test('reloadEnv captures again on request; every atelierd start captures afresh (nothing cached)', async () => {
  const u = fakeUser('export FAKE_VER=1\n');
  const d = await start(u, { captureShellEnv: true });
  await d.reloadEnv();
  writeFileSync(join(u.zdot, '.zshrc'), 'export FAKE_VER=2\n');
  const c = await connectControl(d.paths.sock, d.info.token);
  const w = await c.next((m) => m.t === 'welcome');
  expect(w).toMatchObject({ capabilities: ['profiles', 'states2', 'background', 'toolcalls', 'aliases', 'names', 'lastmessage', 'config-dirs', 'resume-config-dir', 'schedules', 'kill-resumable', 'signals'] });
  c.send({ t: 'reloadEnv', rid: 7 });
  const r = await c.next((m) => m.t === 'reply' && m.rid === 7, 15000) as Extract<ServerMessage, { t: 'reply' }>;
  expect(r).toMatchObject({ ok: true, result: { capturedAt: expect.any(Number) } });
  const t = open(d, u.proj, 'atelier');
  t.type('echo "V=$FAKE_VER"');
  await until(() => t.out.includes('V=2'));
  c.close();
  // Next start: per-boot values (SSH_AUTH_SOCK…) must not come back from an old capture.
  writeFileSync(join(u.zdot, '.zshrc'), 'export FAKE_VER=3\n');
  await d.stop();
  const d2 = await start(u, { home: d.paths.home, captureShellEnv: true });
  await d2.reloadEnv();
  const t2 = open(d2, u.proj, 'atelier');
  t2.type('echo "V=$FAKE_VER"');
  await until(() => t2.out.includes('V=3'));
});

// The environment holds secrets (tokens in variables) and per-boot values: memory only, never a file.
test('the captured environment never reaches the disk; a cache left by an earlier build is removed', async () => {
  const secret = `s3cr3t-${Date.now()}`;
  const u = fakeUser(`export FAKE_TOKEN=${secret}\n`);
  const home = join(tmp('atl-pd-'), 'A S');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'shell-env.json'), JSON.stringify({ v: 1, capturedAt: 1, env: { OLD_TOKEN: 'old' } }), { mode: 0o600 });
  const d = await start(u, { home, captureShellEnv: true });
  expect((await d.reloadEnv()).env.FAKE_TOKEN).toBe(secret);
  const t = open(d, u.proj, 'atelier');
  t.type('echo "T=$FAKE_TOKEN O=${OLD_TOKEN-none}"');
  await until(() => t.out.includes(`T=${secret} O=none`));
  await d.stop();
  expect(existsSync(join(home, 'shell-env.json'))).toBe(false);
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p) : e.isFile() ? [p] : [];
  });
  const leaks = files(home).filter((f) => readFileSync(f).includes(secret));
  expect(leaks).toEqual([]);
});

test('without capture (tests, first launch) the Atelier profile uses atelierd\'s own environment', async () => {
  const u = fakeUser('export FAKE_NVM_DIR=/fake/nvm\n');
  const d = await start(u, { extraEnv: { FROM_DAEMON: 'yes' } });
  const t = open(d, u.proj, 'atelier');
  t.type('echo "D=$FROM_DAEMON N=${FAKE_NVM_DIR-none}"');
  await until(() => t.out.includes('D=yes N=none'));
});

test('user profile (explicit or absent) is unchanged: the user config is loaded', async () => {
  const u = fakeUser('PS1="USER-PROMPT$ "\nexport FROM_USER_RC=1\n');
  const d = await start(u);
  for (const profile of [undefined, 'user' as const]) {
    const t = open(d, u.proj, profile);
    expect(t.info.profile).toBe('user');
    t.type('echo "U=$FROM_USER_RC"');
    await until(() => t.out.includes('USER-PROMPT') && t.out.includes('U=1'));
  }
});

test('{ shell }: a shell listed in /etc/shells, login, Atelier variables, initial command typed when ready', async () => {
  const u = fakeUser();
  writeFileSync(join(u.home, '.bash_profile'), 'export FROM_BASH_PROFILE=1\nPS1="bash$ "\n');
  const etc = join(u.home, 'shells');
  writeFileSync(etc, '# test\n/bin/bash\n');
  const d = await start(u, { etcShells: etc });
  const t = open(d, u.proj, { shell: '/bin/bash' }, 'echo "B-$((1+2)) $FROM_BASH_PROFILE ${ATELIER_TERMINAL_ID:+id} $TERM_PROGRAM"');
  expect(t.info.profile).toEqual({ shell: '/bin/bash' });
  await until(() => t.out.includes('B-3 1 id Atelier'));
  expect(t.out).not.toContain('default interactive shell is now zsh');
});

test('{ shell } not listed, or not a shell: refused with a clear error over the protocol', async () => {
  const u = fakeUser();
  const etc = join(u.home, 'shells');
  writeFileSync(etc, '/bin/bash\n');
  const d = await start(u, { etcShells: etc });
  const c = await connectControl(d.paths.sock, d.info.token);
  await c.next((m) => m.t === 'welcome');
  const base = { t: 'create', projectRoot: u.proj, cwd: u.proj, cols: 80, rows: 24 };
  c.send({ ...base, rid: 1, profile: { shell: '/bin/ksh' } });
  c.send({ ...base, rid: 2, profile: { shell: '/usr/bin/env' } });
  c.send({ ...base, rid: 3, profile: 'bogus' });
  c.send({ ...base, rid: 4, profile: { shell: '/bin/bash', args: ['-c', 'touch x'] } });
  const reply = (rid: number) => c.next((m) => m.t === 'reply' && m.rid === rid);
  expect(await reply(1)).toMatchObject({ ok: false, error: expect.stringMatching(/not listed in \/etc\/shells/) });
  expect(await reply(2)).toMatchObject({ ok: false, error: expect.stringMatching(/not listed/) });
  expect(await reply(3)).toMatchObject({ ok: false, error: 'invalid request' });
  expect(await reply(4)).toMatchObject({ ok: false, error: 'invalid request' });
  expect(d.terminals.list()).toEqual([]);
  c.close();
});

test('compat: an older app\'s create (no profile) gets today\'s shell; reloadEnv without capture is refused', async () => {
  const u = fakeUser('PS1="USER-PROMPT$ "\n');
  const d = await start(u);
  const c = await connectControl(d.paths.sock, d.info.token);
  await c.next((m) => m.t === 'welcome');
  c.send({ t: 'create', rid: 1, projectRoot: u.proj, cwd: u.proj, cols: 80, rows: 24 });
  const r = await c.next((m) => m.t === 'reply' && m.rid === 1) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
  expect((r.result as TerminalInfo).profile).toBe('user');
  c.send({ t: 'reloadEnv', rid: 2 });
  expect(await c.next((m) => m.t === 'reply' && m.rid === 2)).toMatchObject({ ok: false, error: expect.stringMatching(/capture is off/) });
  c.close();
});

test('Atelier profile: completion dump cached in ATELIER_HOME, rebuilt quietly in the background once a day', async () => {
  const u = fakeUser();
  const d = await start(u);
  const dump = join(d.paths.shell, 'zcompdump');
  const t1 = open(d, u.proj, 'atelier');
  await until(() => existsSync(dump) && t1.out.includes('›'));
  const old = Date.now() / 1000 - 2 * 86400;
  utimesSync(dump, old, old);
  const t2 = open(d, u.proj, 'atelier');
  await until(() => statSync(dump).mtimeMs / 1000 > old + 86400);
  await new Promise((r) => setTimeout(r, 200));
  expect(t2.out).not.toMatch(/\[\d+\]|done|compinit/);
});

test('resume: keeps the profile it ran with unless the app asks for another; a refused shell keeps the session resumable', async () => {
  const u = fakeUser('PS1="USER-PROMPT$ "\n');
  const home = join(tmp('atl-pd-'), 'A S');
  mkdirSync(home, { recursive: true });
  const fake = join(u.home, 'claude');
  writeFileSync(fake, '#!/bin/sh\necho "RESUMED:$*"\n');
  chmodSync(fake, 0o755);
  const term = (id: string, sessionId: string, profile?: TerminalProfile) => ({ id, projectRoot: u.proj, cwd: u.proj, name: null, title: id, color: '#fff', sessionId, state: 'done', createdAt: 1, ...(profile ? { profile } : {}) });
  writeFileSync(join(home, 'registry.json'), JSON.stringify({ v: 1, resumables: [], attributions: [], terminals: [
    term('a', '11111111-1111-1111-1111-111111111111', 'atelier'),
    term('b', '22222222-2222-2222-2222-222222222222', { shell: '/bin/ksh' })
  ] }));
  const etc = join(u.home, 'shells');
  writeFileSync(etc, '/bin/bash\n');
  const d = await start(u, { home, etcShells: etc, extraEnv: { ATELIER_CLAUDE_BIN: fake } });
  const c = await connectControl(d.paths.sock, d.info.token);
  await c.next((m) => m.t === 'welcome');
  c.send({ t: 'resume', rid: 1, id: 'a', cols: 80, rows: 24 });
  const r1 = await c.next((m) => m.t === 'reply' && m.rid === 1) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
  expect(r1).toMatchObject({ ok: true });
  expect((r1.result as TerminalInfo).profile).toBe('atelier');
  c.send({ t: 'resume', rid: 2, id: 'b', cols: 80, rows: 24 });
  expect(await c.next((m) => m.t === 'reply' && m.rid === 2)).toMatchObject({ ok: false, error: expect.stringMatching(/not listed/) });
  c.send({ t: 'resume', rid: 3, id: 'b', cols: 80, rows: 24, profile: 'user' });
  const r3 = await c.next((m) => m.t === 'reply' && m.rid === 3) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
  expect((r3.result as TerminalInfo).profile).toBe('user');
  c.close();
});

test('Atelier profile: ⌥←/⌥→ by word (xterm.js sequences) and Home/End to the line ends, even with EDITOR=vim', async () => {
  for (const [profile, works] of [['atelier', true], ['user', false]] as const) {
    const u = fakeUser('PS1="$ "\n');
    const d = await start(u, { extraEnv: { EDITOR: 'vim' } });
    const t = open(d, u.proj, profile);
    await until(() => t.out.includes(profile === 'atelier' ? '›' : '$ '));
    // "cho 'A-B", Home, "e" → "echo 'A-B"; End, ⌥← (word start: - is a word character), "Z", ⌥→ (word end), "X'" → prints ZA-BX.
    for (const k of ["cho 'A-B", '\x1b[H', 'e', '\x1b[F', '\x1b[1;3D', 'Z', '\x1b[1;3C', "X'\r"]) d.terminals.input(t.info.id, k);
    // The Atelier profile's OSC 133 marks are invisible: left out of the comparison.
    const visible = () => t.out.replace(/\x1b\]133;[^\x07]*\x07/g, '');
    if (works) await until(() => visible().includes('\r\nZA-BX\r\n'));
    else { await new Promise((r) => setTimeout(r, 800)); expect(visible()).not.toContain('\r\nZA-BX\r\n'); }
    await d.stop();
  }
});

// v2.0 command blocks: OSC 133 shell integration marks (A prompt start, B command start, C output start, D;exit end).
// Every mark carries the terminal's nonce last (`;atelier=<nonce>`): checked, then left out of the comparisons.
const marks = (out: string) => [...out.matchAll(/\x1b\]133;([^\x07\x1b]*)\x07/g)].map((m) => {
  const n = /^(.*);atelier=([0-9a-f]{32})$/.exec(m[1]!);
  return n ? n[1]! : `${m[1]} (no nonce)`;
});
const promptsDrawn = (out: string) => marks(out).filter((m) => m === 'B').length;
const nonces = (out: string) => new Set([...out.matchAll(/\x1b\]133;[^\x07\x1b]*;atelier=([^\x07\x1b;]*)\x07/g)].map((m) => m[1]));

test('Atelier profile: every OSC 133 mark carries the terminal\'s own nonce, which its programs never see', async () => {
  const u = fakeUser();
  const d = await start(u);
  const t = open(d, u.proj, 'atelier');
  const t2 = open(d, u.proj, 'atelier');
  expect(t.info.markNonce).toMatch(/^[0-9a-f]{32}$/);
  expect(t2.info.markNonce).not.toBe(t.info.markNonce);
  expect(d.terminals.list().find((x) => x.id === t.info.id)?.markNonce).toBe(t.info.markNonce);
  await until(() => promptsDrawn(t.out) === 1);
  t.type('echo "NONCE=${ATELIER_MARK_NONCE:-none}" "ENV=$(env | grep -c ATELIER_MARK_NONCE)"');
  await until(() => promptsDrawn(t.out) === 2);
  expect(t.out).toContain('NONCE=none ENV=0');
  expect([...nonces(t.out)]).toEqual([t.info.markNonce]);
  expect(marks(t.out).some((m) => m.endsWith('(no nonce)'))).toBe(false);
  // The user profile has none.
  expect(open(d, u.proj, 'user').info.markNonce).toBeUndefined();
});

test('Atelier profile: a multi-line command marks B after each PS2 continuation prompt', async () => {
  const u = fakeUser();
  const d = await start(u);
  const t = open(d, u.proj, 'atelier');
  await until(() => promptsDrawn(t.out) === 1);
  t.type('for i in 1 2; do');
  await until(() => promptsDrawn(t.out) === 2);
  t.type('echo item-$i');
  await until(() => promptsDrawn(t.out) === 3);
  t.type('done');
  await until(() => promptsDrawn(t.out) === 4);
  expect(marks(t.out)).toEqual(['A', 'B', 'B', 'B', 'C', 'D;0', 'A', 'B']);
  // The continuation prompt (for>) comes before its B: the typed text after it is the command's.
  const out = t.out;
  const second = out.indexOf('\x1b]133;B', out.indexOf('\x1b]133;B') + 1);
  expect(out.lastIndexOf('for>', second)).toBeGreaterThan(-1);
});

test('Atelier profile: OSC 133 marks around every command, in order, with the exit code', async () => {
  const u = fakeUser();
  const d = await start(u);
  const t = open(d, u.proj, 'atelier');
  await until(() => promptsDrawn(t.out) === 1);
  for (const [i, cmd] of ['echo out-1', 'false', '(exit 3)'].entries()) {
    t.type(cmd);
    await until(() => promptsDrawn(t.out) === i + 2);
  }
  // An empty line runs nothing: a new prompt, no C/D.
  t.type('');
  await until(() => promptsDrawn(t.out) === 5);
  expect(marks(t.out)).toEqual(['A', 'B', 'C', 'D;0', 'A', 'B', 'C', 'D;1', 'A', 'B', 'C', 'D;3', 'A', 'B', 'A', 'B']);
  // A and B wrap the prompt; the command's output sits between C and D.
  const out = t.out;
  const mk = (m: string) => `\x1b]133;${m};atelier=${t.info.markNonce}\x07`;
  const c1 = out.indexOf(mk('C'));
  expect(out.indexOf('out-1\r\n', c1)).toBeGreaterThan(c1);
  expect(out.indexOf('out-1\r\n', c1)).toBeLessThan(out.indexOf(mk('D;0')));
  const a = out.indexOf(mk('A'));
  const b = out.indexOf(mk('B'));
  expect(out.slice(a, b)).toContain(`${DIM}~/proj`);
  expect(out.slice(a, b)).toContain('›');
});

test('Atelier profile: OSC 133 with an initial command — no stray C/D for it, marks from the first prompt on', async () => {
  const u = fakeUser();
  const d = await start(u);
  const t = open(d, u.proj, 'atelier', 'echo INIT-RAN');
  await until(() => promptsDrawn(t.out) === 1);
  expect(t.out.indexOf('INIT-RAN\r\n')).toBeLessThan(t.out.indexOf(`\x1b]133;A;atelier=${t.info.markNonce}\x07`));
  t.type('false');
  await until(() => promptsDrawn(t.out) === 2);
  expect(marks(t.out)).toEqual(['A', 'B', 'C', 'D;1', 'A', 'B']);
});

test('OSC 133: none from the user profile, none from a non-interactive or scripted Atelier zsh', async () => {
  const u = fakeUser('PS1="$ "\n');
  const d = await start(u);
  const t = open(d, u.proj, 'user');
  await until(() => t.out.includes('$ '));
  t.type('false; echo USER-DONE');
  await until(() => t.out.includes('USER-DONE\r\n'));
  await new Promise((r) => setTimeout(r, 300));
  expect(t.out).not.toContain('\x1b]133;');
  const env = { PATH: '/usr/bin:/bin', HOME: u.home, ATELIER_HOME: d.paths.home, ZDOTDIR: join(d.paths.shell, 'atelier') };
  for (const args of [['-c', 'false; echo SCRIPTED'], ['-i', '-c', 'false; echo SCRIPTED']]) {
    const out = execFileSync('/bin/zsh', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toBe('SCRIPTED\n');
  }
});

// A crafted .git/HEAD (cloned or unpacked repo) must not inject terminal escapes through the prompt.
test('Atelier profile: control characters in the branch name are dropped from the prompt', async () => {
  const u = fakeUser();
  mkdirSync(join(u.proj, '.git'));
  writeFileSync(join(u.proj, '.git', 'HEAD'), 'ref: refs/heads/ev\x1b]0;PWNED\x07il\x1b[2Jx\n');
  const d = await start(u);
  const t = open(d, u.proj, 'atelier');
  await until(() => t.out.includes(`${VIOLET}ev]0;PWNEDil[2Jx\x1b[39m`));
  expect(t.out).not.toContain('\x1b]0;PWNED');
  expect(t.out).not.toContain('\x1b[2J');
});

// ⌘←/⌘→ arrive as Home/End: a plain zsh config (emacs or vi mode) has no binding for them, and in vi mode the ESC
// would even drop to command mode.
test('user profile: Home/End reach the line ends in a plain emacs or vi-mode zsh config, the user\'s own bindings stay', async () => {
  const cases = [
    ['plain', 'PS1="$ "\n'],
    ['vi', 'PS1="$ "\nbindkey -v\n'],
    ['own', 'PS1="$ "\nbindkey "^[[H" backward-char\n']
  ] as const;
  for (const [name, rc] of cases) {
    for (const [home, end] of [['\x1b[H', '\x1b[F'], ['\x1bOH', '\x1bOF']] as const) {
      const u = fakeUser(rc);
      const d = await start(u);
      const t = open(d, u.proj, 'user');
      await until(() => t.out.includes('$ '));
      for (const k of ["cho 'X", home, 'e', end, "Y'\r"]) d.terminals.input(t.info.id, k);
      if (name === 'own' && home === '\x1b[H') {
        // The user's binding wins: Home is backward-char here, so the line stays "cho …" and fails.
        await until(() => t.out.includes('command not found: cho'));
        expect(t.out, name).not.toContain('\r\nXY\r\n');
      } else {
        await until(() => t.out.includes('\r\nXY\r\n'), 4000).catch(() => { throw new Error(`${name} ${JSON.stringify(home)}: ${JSON.stringify(t.out.slice(-300))}`); });
      }
      await d.stop();
    }
  }
});

// The Atelier profile doesn't load the user's rc, so their `claude` alias (e.g. alias claude=~/.claude/local/claude)
// is captured with the environment. Every claude here is a fake: the alias target, or fakebin first on PATH (the fake
// user's .zprofile puts it back in front after path_helper).
test('Atelier profile: the user\'s claude alias from the capture is used (with the hooks); one calling claude itself, or setting variables in front, too', async () => {
  for (const [alias, expected] of [
    ['ALIAS', (s: string) => `ALIAS-CLAUDE:--settings ${s} -n x`],
    ['claude --from-alias', (s: string) => `PATH-CLAUDE:--from-alias --settings ${s} -n x`],
    ['ATL_X=1 claude --from-alias', (s: string) => `PATH-CLAUDE:--from-alias --settings ${s} -n x\r\nX=1`]
  ] as const) {
    const u = fakeUser('PS1="USER-PROMPT$ "\n');
    const fakebin = join(u.home, 'fakebin');
    mkdirSync(fakebin);
    writeFileSync(join(fakebin, 'claude'), '#!/bin/sh\necho "PATH-CLAUDE:$*"\n[ -n "$ATL_X" ] && echo "X=$ATL_X"\nexit 0\n');
    chmodSync(join(fakebin, 'claude'), 0o755);
    const aliasBin = join(u.home, 'alias claude');
    writeFileSync(aliasBin, '#!/bin/sh\necho "ALIAS-CLAUDE:$*"\n');
    chmodSync(aliasBin, 0o755);
    writeFileSync(join(u.zdot, '.zprofile'), `path=(${fakebin} $path)\n`);
    writeFileSync(join(u.zdot, '.zshrc'), `alias claude=${alias === 'ALIAS' ? `'${aliasBin.replace(/ /g, '\\ ')}'` : `'${alias}'`}\n`);
    const d = await start(u, { captureShellEnv: true, extraEnv: { PATH: `${fakebin}:/usr/bin:/bin` } });
    await d.reloadEnv();
    const t = open(d, u.proj, 'atelier');
    t.type('claude -n x');
    await until(() => t.out.includes(expected(d.paths.settings))).catch(() => { throw new Error(`${alias}: ${JSON.stringify(t.out.slice(-400))}`); });
    await d.stop();
  }
});

// Before the first capture (or after a failed one) atelierd's own environment is launchd's minimal one for an app
// opened from the Dock: an Atelier terminal there can't find claude, node… It waits for the capture instead, and
// without one it opens the user's own zsh (their environment), reported as such.
test('Atelier profile before the first capture: create waits for the capture in flight', async () => {
  const u = fakeUser('sleep 0.6\nexport FAKE_NVM_DIR=/fake/nvm\n');
  const d = await start(u, { captureShellEnv: true });
  const c = await connectControl(d.paths.sock, d.info.token);
  await c.next((m) => m.t === 'welcome');
  c.send({ t: 'create', rid: 1, projectRoot: u.proj, cwd: u.proj, cols: 80, rows: 24, profile: 'atelier' });
  const r = await c.next((m) => m.t === 'reply' && m.rid === 1, 8000) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
  const info = r.result as TerminalInfo;
  expect(info.profile).toBe('atelier');
  let out = '';
  d.terminals.attach(info.id, () => {}, (x) => { out += x; });
  d.terminals.input(info.id, 'echo "N=${FAKE_NVM_DIR-none}"\r');
  await until(() => /N=\/fake\/nvm|N=none/.test(out.replace('N=${FAKE_NVM_DIR-none}', '')));
  expect(out).toContain('N=/fake/nvm');
  c.close();
});

test('failed capture: Atelier terminals open in the user\'s zsh (profile user), and the app is told why', async () => {
  // The capture has no terminal (stdin is /dev/null): this config fails only there.
  const u = fakeUser('[[ -t 0 ]] || exit 3\nPS1="USER-PROMPT$ "\n');
  const d = await start(u, { captureShellEnv: true });
  const c = await connectControl(d.paths.sock, d.info.token);
  await c.next((m) => m.t === 'welcome');
  await expect(d.reloadEnv()).rejects.toThrow(/exited \(3\)/);
  expect(await c.next((m) => m.t === 'shellEnv' && m.state === 'failed')).toMatchObject({ error: expect.stringMatching(/exited \(3\)/) });
  c.send({ t: 'create', rid: 1, projectRoot: u.proj, cwd: u.proj, cols: 80, rows: 24, profile: 'atelier' });
  const r = await c.next((m) => m.t === 'reply' && m.rid === 1) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
  const info = r.result as TerminalInfo;
  expect(info.profile).toBe('user');
  let out = '';
  d.terminals.attach(info.id, () => {}, (x) => { out += x; });
  await until(() => out.includes('USER-PROMPT'));
  // A new connection learns the state right after welcome.
  const c2 = await connectControl(d.paths.sock, d.info.token);
  await c2.next((m) => m.t === 'welcome');
  expect(await c2.next((m) => m.t === 'shellEnv')).toMatchObject({ state: 'failed' });
  c.close();
  c2.close();
});

test('a capture slower than the wait: the Atelier terminal opens in the user\'s zsh, the next one gets the capture', async () => {
  const u = fakeUser('[[ -t 0 ]] || sleep 1.5\nexport FAKE_NVM_DIR=/fake/nvm\nPS1="USER-PROMPT$ "\n');
  const d = await start(u, { captureShellEnv: true, envWaitMs: 200 });
  const c = await connectControl(d.paths.sock, d.info.token);
  await c.next((m) => m.t === 'welcome');
  expect(await c.next((m) => m.t === 'shellEnv')).toMatchObject({ state: 'capturing' });
  const t0 = Date.now();
  c.send({ t: 'create', rid: 1, projectRoot: u.proj, cwd: u.proj, cols: 80, rows: 24, profile: 'atelier' });
  const r = await c.next((m) => m.t === 'reply' && m.rid === 1) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
  expect(Date.now() - t0).toBeLessThan(1200);
  expect((r.result as TerminalInfo).profile).toBe('user');
  expect(await c.next((m) => m.t === 'shellEnv' && m.state === 'ready', 8000)).toMatchObject({ capturedAt: expect.any(Number) });
  c.send({ t: 'create', rid: 2, projectRoot: u.proj, cwd: u.proj, cols: 80, rows: 24, profile: 'atelier' });
  const r2 = await c.next((m) => m.t === 'reply' && m.rid === 2) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
  expect((r2.result as TerminalInfo).profile).toBe('atelier');
  c.close();
});

test('resume before the first capture waits too; a resumed terminal whose shell dies at once keeps the session resumable', async () => {
  const u = fakeUser('sleep 0.6\nexport FAKE_NVM_DIR=/fake/nvm\n');
  const home = join(tmp('atl-pd-'), 'A S');
  mkdirSync(home, { recursive: true });
  const fake = join(u.home, 'claude');
  writeFileSync(fake, '#!/bin/sh\necho "RESUMED:$* N=$FAKE_NVM_DIR"\n');
  chmodSync(fake, 0o755);
  const dead = join(u.home, 'dead-shell');
  writeFileSync(dead, '#!/bin/sh\nexit 1\n');
  chmodSync(dead, 0o755);
  const etc = join(u.home, 'shells');
  writeFileSync(etc, `${dead}\n`);
  const term = (id: string, sessionId: string) => ({ id, projectRoot: u.proj, cwd: u.proj, name: null, title: id, color: '#fff', sessionId, state: 'done', createdAt: 1, profile: 'atelier' });
  writeFileSync(join(home, 'registry.json'), JSON.stringify({ v: 1, resumables: [], attributions: [], terminals: [
    term('a', '11111111-1111-1111-1111-111111111111'), term('b', '22222222-2222-2222-2222-222222222222')
  ] }));
  const d = await start(u, { home, etcShells: etc, captureShellEnv: true, extraEnv: { ATELIER_CLAUDE_BIN: fake } });
  const c = await connectControl(d.paths.sock, d.info.token);
  await c.next((m) => m.t === 'welcome');
  c.send({ t: 'resume', rid: 1, id: 'a', cols: 80, rows: 24 });
  const r1 = await c.next((m) => m.t === 'reply' && m.rid === 1, 8000) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
  const info = r1.result as TerminalInfo;
  expect(info.profile).toBe('atelier');
  let out = '';
  d.terminals.attach(info.id, () => {}, (x) => { out += x; });
  await until(() => out.includes('RESUMED:'));
  expect(out).toContain('N=/fake/nvm');
  c.send({ t: 'resume', rid: 2, id: 'b', cols: 80, rows: 24, profile: { shell: dead } });
  const r2 = await c.next((m) => m.t === 'reply' && m.rid === 2) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
  expect(r2).toMatchObject({ ok: true });
  const b = (r2.result as TerminalInfo).id;
  // Back once its shell died, under the resumed terminal's id (the app moved the task link and pin there): a new
  // connection gets the current list right after welcome.
  const current = async () => {
    const c3 = await connectControl(d.paths.sock, d.info.token);
    const m = await c3.next((x) => x.t === 'resumables') as Extract<ServerMessage, { t: 'resumables' }>;
    c3.close();
    return m.list.map((x) => [x.id, x.sessionId]);
  };
  let list: string[][] = [];
  const t0 = Date.now();
  while (!list.some(([id]) => id === b) && Date.now() - t0 < 5000) { list = await current(); await new Promise((r) => setTimeout(r, 100)); }
  expect(list).toEqual([[b, '22222222-2222-2222-2222-222222222222']]);
  c.close();
});

// Spec aliases: the Atelier profile gets the aliases of the user's own zsh config, captured live with the environment.
test('Atelier profile: the user\'s aliases arrive (regular, global, suffix), claude stays Atelier\'s function, the variable is gone', async () => {
  const u = fakeUser([
    "alias acme='echo ACME-RAN'", "alias -g UPPER='| tr a-z A-Z'", 'alias -s txt=cat', "alias q='echo \"it'\\''s\" $((1+1))'",
    "alias claude='claude --from-alias'", ''
  ].join('\n'));
  writeFileSync(join(u.proj, 'n.txt'), 'SUFFIX-OK\n');
  const d = await start(u, { captureShellEnv: true });
  await d.reloadEnv();
  // zsh's own (run-help, which-command) count too.
  expect(d.getShellEnv().state).toBe('ready');
  expect(d.getShellEnv().aliases).toBeGreaterThanOrEqual(4);
  const t = open(d, u.proj, 'atelier');
  t.type('acme; echo low UPPER; ./n.txt; q; whence -w claude; echo "V=${ATELIER_USER_ALIASES-unset}"; env | grep -c ATELIER_USER_ALIASES');
  await until(() => ['ACME-RAN', 'LOW', 'SUFFIX-OK', "it's 2", 'claude: function', 'V=unset'].every((x) => t.out.includes(x)))
    .catch(() => { throw new Error(JSON.stringify(t.out.slice(-600))); });
  await until(() => /\r\n0\r\n/.test(t.out));
});

test('Atelier profile: aliases: false leaves them out', async () => {
  const u = fakeUser("alias acme='echo ACME-RAN'\n");
  const d = await start(u, { captureShellEnv: true });
  await d.reloadEnv();
  const t = open(d, u.proj, 'atelier', undefined, false);
  // Computed markers: the typed line is echoed, the results only appear as output.
  t.type('alias acme >/dev/null && echo HAS-$((1+1)) || echo NO-$((2+2))');
  await until(() => t.out.includes('NO-4') || t.out.includes('HAS-2'));
  expect(t.out).toContain('NO-4');
});

// Aliases expand when code is parsed (global ones anywhere on a line): defined last, they can't touch Atelier's code.
test('Atelier profile: aliases shadowing words of Atelier\'s own code break neither the prompt nor the command marks', async () => {
  const u = fakeUser([
    "alias print='echo HIJACK'", "alias unset='echo HIJACK'", "alias local='echo HIJACK'", "alias -g then='; echo HIJACK;'",
    "alias -g fi='; echo HIJACK;'", "alias -g REPLY='HIJACK'", "alias -g ZDOTDIR='HIJACK'", ''
  ].join('\n'));
  const d = await start(u, { captureShellEnv: true });
  await d.reloadEnv();
  const t = open(d, u.proj, 'atelier');
  await until(() => t.out.includes(`${DIM}~/proj\x1b[39m ${DIM}›`));
  t.type('echo MARKS-$((3*3))');
  await until(() => t.out.includes('MARKS-9') && t.out.includes(`\x1b]133;D;0;atelier=${t.info.markNonce}\x07`));
  expect(t.out).not.toContain('HIJACK');
});
