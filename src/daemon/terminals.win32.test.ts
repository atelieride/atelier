import { afterEach, expect, test, vi } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import type { PtyProcess, PtySpawnOptions } from './session-pty';

// Folders that exist in this fake Windows: C:/p and its sub folder (node:fs accepts either separator there).
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const dirs = new Set(['C:/p', 'C:/p/sub']);
  const known = (p: unknown) => typeof p === 'string' && dirs.has(p.replace(/\\/g, '/'));
  return {
    ...fs,
    existsSync: (p: string) => known(p) || fs.existsSync(p),
    statSync: ((p: string, o?: object) => (known(p) ? { isDirectory: () => true } : fs.statSync(p, o))) as typeof fs.statSync
  };
});
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return {
    ...os,
    homedir: () => (process.env.ATL_FAKE_WIN === '1' ? 'C:\\Users\\mario' : os.homedir()),
    release: () => process.env.ATL_FAKE_RELEASE ?? os.release()
  };
});
// The options each headless screen is made with.
const screens = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock('@xterm/headless', async (importOriginal) => {
  const m = await importOriginal<typeof import('@xterm/headless')>();
  class Recorded extends m.Terminal {
    constructor(o?: ConstructorParameters<typeof m.Terminal>[0]) { screens.options.push({ ...o }); super(o); }
  }
  return { ...m, Terminal: Recorded };
});
const { TerminalManager } = await import('./terminals');
type TerminalManagerOptions = ConstructorParameters<typeof TerminalManager>[0];

// The terminal manager on Windows, with a fake pty: node-pty's ConPTY throws on a signal
// name, so a terminal closes with a plain kill(); macOS keeps SIGHUP.

interface Fake { proc: PtyProcess; kills: (string | undefined)[]; spawned: { file: string; args: string[]; o: PtySpawnOptions }; emit(data: string): void; exit(code: number): void }

function manager(env: () => Record<string, string> = () => ({}), log?: (msg: string) => void, isAlive?: (pid: number) => boolean, extra: Partial<TerminalManagerOptions> = {}): { tm: InstanceType<typeof TerminalManager>; fakes: Fake[] } {
  const fakes: Fake[] = [];
  const tm = new TerminalManager({
    ...extra,
    ...(log ? { log } : {}),
    ...(isAlive ? { isAlive } : {}),
    launch: extra.launch ?? (() => ({ file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoLogo'], env: env() })),
    spawnFor: () => (file, args, o) => {
      const kills: (string | undefined)[] = [];
      const data: ((d: string) => void)[] = [];
      const exits: ((e: { exitCode: number }) => void)[] = [];
      const proc: PtyProcess = {
        pid: 4242 + fakes.length, process: 'xterm-256color',
        onData: (l) => { data.push(l); return { dispose() {} }; }, onExit: (l) => { exits.push(l); return { dispose() {} }; },
        write() {}, resize() {},
        kill: (...a: [string?]) => { kills.push(...(a.length ? a : [undefined])); }
      };
      fakes.push({ proc, kills, spawned: { file, args, o }, emit: (d) => { for (const l of [...data]) l(d); }, exit: (exitCode) => { for (const l of [...exits]) l({ exitCode }); } });
      return proc;
    }
  });
  return { tm, fakes };
}

afterEach(() => { resetPlatformForTests(); delete process.env.ATL_FAKE_WIN; delete process.env.ATL_FAKE_RELEASE; vi.useRealTimers(); screens.options = []; });

test('Windows: closing a terminal kills it without a signal, at the user’s request and at shutdown', () => {
  initPlatform('win32');
  const { tm, fakes } = manager();
  const a = tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24 });
  tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24 });
  tm.kill(a.id);
  tm.disposeAll();
  expect(fakes.map((f) => f.kills)).toEqual([[undefined], [undefined]]);
});

// Before Windows 11 24H2 closing the console waits for every program in it, and Claude's SessionEnd hook waits on atelierd
// meanwhile. taskkill starts first, then the console closes at once: the close waits only for taskkill ending them. Not
// taskkill first and the close after: node-pty forgets a console whose shell exited, so it was never closed (a
// conhost.exe left for each close, measured on 25H2). The tree is the shell's only while its image is the shell's.
test('Windows, console close that waits: the shell’s tree is ended (its pid, its image), then the console closes, once', () => {
  initPlatform('win32');
  const order: string[] = [];
  const { tm, fakes } = manager(undefined, undefined, undefined, { endTree: (pid, image) => order.push(`end ${pid} ${image}`) });
  const a = tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24 });
  fakes[0]!.proc.kill = () => { order.push('kill'); };
  const resized: number[][] = [];
  fakes[0]!.proc.resize = (c, r) => { resized.push([c, r]); };
  tm.kill(a.id);
  expect(order).toEqual(['end 4242 pwsh.exe', 'kill']);
  // Closing already: not ended or killed again, not resized.
  tm.kill(a.id);
  tm.resize(a.id, 100, 30);
  tm.disposeAll();
  expect(order).toEqual(['end 4242 pwsh.exe', 'kill']);
  expect(resized).toEqual([]);
});

test('Windows, console close that waits: at shutdown every terminal’s tree is ended, each console closed', () => {
  initPlatform('win32');
  const ends: number[] = [];
  const { tm, fakes } = manager(undefined, undefined, undefined, { endTree: (pid) => ends.push(pid) });
  tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24 });
  tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24 });
  tm.disposeAll();
  expect(ends).toEqual([4242, 4243]);
  expect(fakes.map((f) => f.kills)).toEqual([[undefined], [undefined]]);
});

test('Windows, console close that waits: a tree end that throws still closes the console', () => {
  initPlatform('win32');
  const { tm, fakes } = manager(undefined, undefined, undefined, { endTree: () => { throw new Error('no taskkill'); } });
  const a = tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24 });
  expect(() => tm.kill(a.id)).not.toThrow();
  expect(fakes[0]!.kills).toEqual([undefined]);
});

// node-pty's ConPTY kill frees the console; a second one before the shell exits frees it again and the process dies
// (0xC0000374, measured on Windows 11 25H2), so does a resize: a closing terminal is never killed, resized or typed into.
test('Windows: a terminal already closing is never killed, resized or written to again', () => {
  initPlatform('win32');
  const { tm, fakes } = manager();
  const a = tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24 });
  const resized: number[][] = [];
  const written: string[] = [];
  fakes[0]!.proc.resize = (c, r) => { resized.push([c, r]); };
  fakes[0]!.proc.write = (d) => { written.push(d); };
  tm.kill(a.id);
  tm.kill(a.id);
  tm.resize(a.id, 100, 30);
  tm.input(a.id, 'x');
  expect(fakes[0]!.kills).toEqual([undefined]);
  expect(resized).toEqual([]);
  expect(written).toEqual([]);
});

test('macOS: SIGHUP, as before', () => {
  initPlatform('darwin');
  const { tm, fakes } = manager();
  const a = tm.create({ projectRoot: '/p', cwd: '/p', cols: 80, rows: 24 });
  tm.kill(a.id);
  tm.disposeAll();
  expect(fakes[0]!.kills).toEqual(['SIGHUP']);
});

test('Windows: a terminal started with another account’s PowerShell command is a session while Claude starts', () => {
  initPlatform('win32');
  const { tm } = manager();
  const cmd = "& { $p = $env:CLAUDE_CONFIG_DIR; $env:CLAUDE_CONFIG_DIR = 'C:/Users/m/.claude-o''x'; try { claude --resume 'abc' } finally { $env:CLAUDE_CONFIG_DIR = $p } }";
  expect(tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24, command: cmd }).title).toBe('Claude · p');
  expect(tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24, command: "claude --name='x'" }).title).toBe('Claude · p');
  expect(tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24, command: '& { claude-like }' }).title).toBe('Terminal 1');
  tm.disposeAll();
});

test('Windows: the foreground is the shell, or claude while a session runs in it (node-pty reports a fixed name)', () => {
  initPlatform('win32');
  const { tm } = manager();
  const a = tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24 });
  expect(a.foreground).toBe('pwsh');
  tm.applyHook(a.id, { hook_event_name: 'SessionStart', session_id: '0a1b2c3d-1111-2222-3333-444455556666', cwd: 'C:/p', source: 'startup' });
  tm.pollForeground();
  expect(tm.list()[0]!.foreground).toBe('claude');
  tm.applyHook(a.id, { hook_event_name: 'SessionEnd', session_id: '0a1b2c3d-1111-2222-3333-444455556666', reason: 'exit' });
  tm.pollForeground();
  expect(tm.list()[0]!.foreground).toBe('pwsh');
  tm.disposeAll();
});

test('Windows: the shell starts in the native folder; the app sees the canonical one', () => {
  initPlatform('win32');
  process.env.ATL_FAKE_WIN = '1';
  const { tm, fakes } = manager();
  const a = tm.create({ projectRoot: 'C:/p', cwd: 'C:/p/sub', cols: 80, rows: 24 });
  expect(fakes[0]!.spawned.o.cwd).toBe('C:\\p\\sub');
  expect(a.cwd).toBe('C:/p/sub');
  // Folder gone: the project, then the user's home (canonical too).
  const b = tm.create({ projectRoot: 'C:/p', cwd: 'C:/p/gone', cols: 80, rows: 24 });
  expect(b.cwd).toBe('C:/p');
  const c = tm.create({ projectRoot: 'C:/q', cwd: 'C:/q', cols: 80, rows: 24 });
  expect(fakes[2]!.spawned.o.cwd).toBe('C:\\Users\\mario');
  expect(c.cwd).toBe('C:/Users/mario');
});

test('Windows: Claude killed without SessionEnd — the shell’s own prompt mark (with the terminal’s nonce) ends the session', () => {
  initPlatform('win32');
  const { tm, fakes } = manager();
  const a = tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24, profile: 'atelier' });
  const nonce = fakes[0]!.spawned.o.env.ATELIER_MARK_NONCE!;
  expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  tm.applyHook(a.id, { hook_event_name: 'SessionStart', session_id: '0a1b2c3d-1111-2222-3333-444455556666', cwd: 'C:/p', source: 'startup' });
  // A program printing a mark without the nonce changes nothing.
  fakes[0]!.emit('\x1b]133;A\x07');
  fakes[0]!.emit('\x1b]133;A;atelier=' + 'f'.repeat(32) + '\x07');
  expect(tm.list()[0]!.session).not.toBe(null);
  // The prompt comes back (split across two chunks): Claude is gone.
  fakes[0]!.emit('\x1b]133;A;atelier=' + nonce.slice(0, 10));
  fakes[0]!.emit(nonce.slice(10) + '\x07PS C:\\p> ');
  expect(tm.list()[0]!.session).toBe(null);
  expect(tm.list()[0]!.foreground).toBe('pwsh');
  tm.disposeAll();
});

test('Windows: PowerShell (your profile) has no command marks, yet a Claude killed there ends its session at the next prompt', () => {
  initPlatform('win32');
  const { tm, fakes } = manager();
  const a = tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24, profile: 'user' });
  const env = fakes[0]!.spawned.o.env;
  // No marks for the app (no nonce in the terminal's info): only a prompt signal atelierd alone reads.
  expect(env.ATELIER_MARK_NONCE).toBeUndefined();
  expect(a.markNonce).toBeUndefined();
  const nonce = env.ATELIER_PROMPT_NONCE!;
  expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  tm.applyHook(a.id, { hook_event_name: 'SessionStart', session_id: '0a1b2c3d-1111-2222-3333-444455556666', cwd: 'C:/p', source: 'startup' });
  // A program printing the signal without the nonce, or a command mark, changes nothing.
  fakes[0]!.emit('\x1b]133;P\x07\x1b]133;A\x07');
  fakes[0]!.emit('\x1b]133;P;atelier=' + 'f'.repeat(32) + '\x07');
  expect(tm.list()[0]!.session).not.toBe(null);
  fakes[0]!.emit('\x1b]133;P;atelier=' + nonce.slice(0, 7));
  fakes[0]!.emit(nonce.slice(7) + '\x07PS C:\\p> ');
  expect(tm.list()[0]!.session).toBe(null);
  tm.disposeAll();
});

test('Windows: both PowerShell profiles get the PATH they start with, so atelier.ps1 adds only folders new since then', () => {
  initPlatform('win32');
  const { tm, fakes } = manager(() => ({ Path: 'C:\\a;C:\\b', ATELIER_HOME: 'C:\\h' }));
  for (const profile of ['user', 'atelier'] as const) tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24, profile });
  tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24, profile: { shell: 'C:/WINDOWS/System32/cmd.exe' } });
  expect(fakes.map((f) => f.spawned.o.env.ATELIER_START_PATH)).toEqual(['C:\\h\\bin;C:\\a;C:\\b', 'C:\\h\\bin;C:\\a;C:\\b', undefined]);
  tm.disposeAll();
});

test('Windows: Atelier’s bin comes first on PATH (the bridge by name: never another Atelier’s, nor a project’s)', () => {
  initPlatform('win32');
  // Started from another Atelier's terminal: its bin is already on PATH, and a relative entry would search the project.
  const { tm, fakes } = manager(() => ({ PATH: 'C:\\outer\\bin;.;C:\\h\\bin;C:\\a', ATELIER_HOME: 'C:\\h' }));
  tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24, profile: 'user' });
  const env = fakes[0]!.spawned.o.env;
  expect(env.PATH).toBe('C:\\h\\bin;C:\\outer\\bin;.;C:\\a');
  expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['PATH']);
  tm.disposeAll();
});

test('Windows: Git Bash with Atelier’s integration gets the prompt signal and Atelier’s bin first, no command marks', () => {
  initPlatform('win32');
  const gitBash = () => ({ file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--rcfile', 'C:/h/shell/atelier.bash', '-i'], env: { Path: 'C:\\a;C:\\h\\bin', ATELIER_HOME: 'C:\\h' }, promptSignal: true });
  const { tm, fakes } = manager(undefined, undefined, undefined, { launch: gitBash });
  const a = tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24, profile: { shell: 'C:/Program Files/Git/bin/bash.exe' } });
  const env = fakes[0]!.spawned.o.env;
  expect(env.ATELIER_MARK_NONCE).toBeUndefined();
  expect(a.markNonce).toBeUndefined();
  // atelier.ps1's registry refresh only: Git Bash keeps atelierd's environment.
  expect(env.ATELIER_START_PATH).toBeUndefined();
  expect(env.Path).toBe('C:\\h\\bin;C:\\a');
  const nonce = env.ATELIER_PROMPT_NONCE!;
  expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  tm.applyHook(a.id, { hook_event_name: 'SessionStart', session_id: '0a1b2c3d-1111-2222-3333-444455556666', cwd: 'C:/p', source: 'startup' });
  fakes[0]!.emit('\x1b]133;P;atelier=' + 'f'.repeat(32) + '\x07');
  expect(tm.list()[0]!.session).not.toBe(null);
  fakes[0]!.emit('\x1b]133;P;atelier=' + nonce + '\x07$ ');
  expect(tm.list()[0]!.session).toBe(null);
  expect(tm.list()[0]!.foreground).toBe('bash');
  tm.disposeAll();
});

test('Windows: a shell without Atelier’s integration (cmd, Git Bash, WSL) gets neither nonce', () => {
  initPlatform('win32');
  const { tm, fakes } = manager();
  tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24, profile: { shell: 'C:/WINDOWS/System32/cmd.exe' } });
  expect(fakes[0]!.spawned.o.env.ATELIER_MARK_NONCE).toBeUndefined();
  expect(fakes[0]!.spawned.o.env.ATELIER_PROMPT_NONCE).toBeUndefined();
  tm.disposeAll();
});

test('a kill that throws (the shell exited a moment before) is not an error: its exit removes it', () => {
  initPlatform('win32');
  const { tm, fakes } = manager();
  const a = tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24 });
  fakes[0]!.proc.kill = () => { throw new Error('Cannot kill: process exited'); };
  expect(() => tm.kill(a.id)).not.toThrow();
});

// A field report: sessions stuck "Starting…" on a Store user's PC, the status line reaching atelierd but no hook. A
// session is never made from a status line (both platforms would change); the log says why.
test('status lines for a session no hook ever announced: logged once per terminal, after the hooks had time to arrive', () => {
  initPlatform('win32');
  vi.useFakeTimers({ now: 1_000_000 });
  const logs: string[] = [];
  const { tm } = manager(() => ({}), (m) => logs.push(m));
  const a = tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24 });
  const status = { session_id: 's1', model: { display_name: 'Opus' } };
  tm.applyStatus(a.id, status);
  // The status line may win the race against SessionStart: not yet.
  vi.setSystemTime(1_000_000 + 5_000);
  tm.applyStatus(a.id, status);
  expect(logs).toEqual([]);
  vi.setSystemTime(1_000_000 + 11_000);
  tm.applyStatus(a.id, status);
  vi.setSystemTime(1_000_000 + 30_000);
  tm.applyStatus(a.id, status);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain(a.id);
  expect(logs[0]).toContain("status line without SessionStart: Claude's hooks are not reaching atelierd");
  expect(tm.list().find((t) => t.id === a.id)!.session).toBeNull();
  tm.disposeAll();
});

test('a status line that only beat its SessionStart, or a late one from an ended session, is not logged', () => {
  initPlatform('win32');
  vi.useFakeTimers({ now: 1_000_000 });
  const logs: string[] = [];
  const { tm } = manager(() => ({}), (m) => logs.push(m));
  const a = tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24 });
  tm.applyStatus(a.id, { session_id: 's1' });
  tm.applyHook(a.id, { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup', cwd: 'C:/p' });
  vi.setSystemTime(1_000_000 + 20_000);
  tm.applyStatus(a.id, { session_id: 's1' });
  tm.applyHook(a.id, { hook_event_name: 'SessionEnd', session_id: 's1', cwd: 'C:/p' });
  // The ended session's last status line, then a new claude whose status line comes first again.
  tm.applyStatus(a.id, { session_id: 's1' });
  vi.setSystemTime(1_000_000 + 80_000);
  tm.applyStatus(a.id, { session_id: 's2' });
  tm.applyHook(a.id, { hook_event_name: 'SessionStart', session_id: 's2', source: 'startup', cwd: 'C:/p' });
  expect(logs).toEqual([]);
  tm.disposeAll();
});

// A hang-up that throws while the shell still runs left the terminal "closing" for good: never typed into, resized or
// closed again, its row "Closing…" forever. On POSIX a signal can't free anything twice: the terminal is open again.
test('macOS: a hang-up that throws while the shell still runs does not leave the terminal closing', () => {
  initPlatform('darwin');
  const { tm, fakes } = manager(() => ({}), undefined, () => true);
  const a = tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24 });
  const resized: number[][] = [];
  fakes[0]!.proc.resize = (c, r) => { resized.push([c, r]); };
  let throws = true;
  fakes[0]!.proc.kill = (sig?: string) => { if (throws) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); fakes[0]!.kills.push(sig); };
  tm.kill(a.id);
  tm.resize(a.id, 100, 30);
  throws = false;
  tm.kill(a.id);
  expect(resized).toEqual([[100, 30]]);
  expect(fakes[0]!.kills).toEqual(['SIGHUP']);
});

test('macOS: a hang-up that throws because the shell already exited still counts as closing', () => {
  initPlatform('darwin');
  const { tm, fakes } = manager(() => ({}), undefined, () => false);
  const a = tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24 });
  fakes[0]!.proc.kill = () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); };
  tm.kill(a.id);
  const resized: number[][] = [];
  fakes[0]!.proc.resize = (c, r) => { resized.push([c, r]); };
  tm.resize(a.id, 100, 30);
  expect(resized).toEqual([]);
});

// node-pty may throw after it freed the ConPTY console (its kill does more once ClosePseudoConsole returned), while the
// shell still runs for a moment: a second free kills atelierd with every terminal, so a throw there stays closing.
test('Windows: a kill that throws stays closing even with the shell still running (the console may be freed)', () => {
  initPlatform('win32');
  const { tm, fakes } = manager(() => ({}), undefined, () => true);
  const a = tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24 });
  let calls = 0;
  fakes[0]!.proc.kill = () => { calls += 1; throw new Error('boom'); };
  tm.kill(a.id);
  tm.kill(a.id);
  tm.disposeAll();
  expect(calls).toBe(1);
});

// Without windowsPty xterm reflows on a resize, which ConPTY doesn't expect: atelierd's screen (what a window gets when
// it attaches) came out with lines twice or missing.
test('Windows: atelierd’s screen knows it is fed by ConPTY, with the build number', () => {
  initPlatform('win32');
  process.env.ATL_FAKE_RELEASE = '10.0.26200';
  const { tm } = manager();
  tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24 });
  expect(screens.options.at(-1)!.windowsPty).toEqual({ backend: 'conpty', buildNumber: 26200 });
  tm.disposeAll();
});

test('macOS: the screen’s options are as before (no windowsPty)', () => {
  initPlatform('darwin');
  const { tm } = manager();
  tm.create({ projectRoot: 'C:/p', cwd: 'C:/p', cols: 80, rows: 24 });
  expect(screens.options.at(-1)).toEqual({ cols: 80, rows: 24, scrollback: 10000, allowProposedApi: true });
  tm.disposeAll();
});
