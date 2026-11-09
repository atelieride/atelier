import { afterEach, describe, expect, test } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { TerminalManager } from '../../src/daemon/terminals';
import { buildTerminalEnv } from '../../src/daemon/env';

const managers: TerminalManager[] = [];
function make() {
  const m = new TerminalManager({
    launch: (id) => ({ file: '/bin/zsh', args: ['-f'], env: buildTerminalEnv({ ...process.env, PS1: '$ ' }, { ATELIER_TERMINAL_ID: id }) })
  });
  managers.push(m);
  return m;
}
afterEach(() => managers.splice(0).forEach((m) => m.disposeAll()));

const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 30));
  }
};

describe('TerminalManager', () => {
  test('creates, receives output, color and title', async () => {
    const m = make();
    const info = m.create({ projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24 });
    expect(info.title).toBe('Terminal 1');
    expect(info.color).toMatch(/^#[0-9A-F]{6}$/);
    let out = '';
    m.attach(info.id, () => {}, (d) => { out += d; });
    m.input(info.id, 'echo ciao-$ATELIER_TERMINAL_ID\r');
    await until(() => out.includes(`ciao-${info.id}`));
  });

  test('the screen survives detach and comes back with attach', async () => {
    const m = make();
    const info = m.create({ projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24 });
    const detachA = m.attach(info.id, () => {}, () => {});
    detachA();
    m.input(info.id, 'echo mentre-$((1+1))-staccato\r');
    await new Promise((r) => setTimeout(r, 400));
    let snap = '';
    const detachB = m.attach(info.id, (s) => { snap = s; }, () => {});
    await until(() => snap.includes('mentre-2-staccato'));
    detachB();
  });

  test('nonexistent folder → starts in the home', async () => {
    const m = make();
    const info = m.create({ projectRoot: '/non/esiste', cwd: '/non/esiste/sub', cols: 80, rows: 24 });
    expect(info.cwd).toBe(homedir());
    let out = '';
    m.attach(info.id, () => {}, (d) => { out += d; });
    m.input(info.id, 'pwd\r');
    await until(() => out.includes(homedir()));
  });

  test('command is written into the terminal', async () => {
    const m = make();
    let out = '';
    const info = m.create({ projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24, command: 'echo dal-$((1+1))-comando' });
    m.attach(info.id, () => {}, (d) => { out += d; });
    await until(() => out.includes('dal-2-comando'));
  });

  test('shell exit → exit event and it disappears from the list', async () => {
    const m = make();
    const info = m.create({ projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24 });
    let exited: string | null = null;
    m.on('exit', (id: string) => { exited = id; });
    m.input(info.id, 'exit\r');
    await until(() => exited === info.id);
    expect(m.has(info.id)).toBe(false);
  });

  test('foreground process', async () => {
    const m = make();
    const info = m.create({ projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24 });
    m.input(info.id, 'sleep 3\r');
    await until(() => { m.pollForeground(); return m.list()[0]?.foreground === 'sleep'; });
  });

  test('promptState follows input (a draft, then sent), output, bracketed paste; atelierd\'s own writes are no input', async () => {
    const m = make();
    const info = m.create({ projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24 });
    let out = '';
    m.attach(info.id, () => {}, (d) => { out += d; });
    await until(() => out.length > 0);
    const t0 = Date.now();
    expect(m.promptState(info.id)).toMatchObject({ draft: false, lastInputAt: 0 });
    m.input(info.id, 'echo draft');
    expect(m.promptState(info.id)!.draft).toBe(true);
    expect(m.promptState(info.id)!.lastInputAt).toBeGreaterThanOrEqual(t0);
    m.input(info.id, '\x15');
    m.input(info.id, '\r');
    expect(m.promptState(info.id)!.draft).toBe(false);
    const inputAt = m.promptState(info.id)!.lastInputAt;
    expect(m.writeOwn(info.id, "printf '\\033[?2004h'; echo own-$((2+3))\r")).toBe(true);
    await until(() => out.includes('own-5'));
    await until(() => m.promptState(info.id)!.bracketed);
    expect(m.promptState(info.id)).toMatchObject({ draft: false, lastInputAt: inputAt });
    expect(m.promptState(info.id)!.lastOutputAt).toBeGreaterThanOrEqual(t0);
    // A focus report or a wheel event over Claude is no typing; atelierd's own paste left without its Enter is a draft.
    await new Promise((r) => setTimeout(r, 5));
    m.input(info.id, '\x1b[I');
    m.input(info.id, '\x1b[<64;10;5M');
    expect(m.promptState(info.id)!.lastInputAt).toBe(inputAt);
    m.writeOwn(info.id, '\x1b[200~stray\x1b[201~');
    expect(m.promptState(info.id)!.draft).toBe(true);
    m.writeOwn(info.id, '\x15\r');
    expect(m.promptState('nope')).toBeNull();
    expect(m.writeOwn('nope', 'x')).toBe(false);
  });

  test('a subagent with no event for 2 hours is dropped by the sweep, without any new event', () => {
    const m = make();
    const info = m.create({ projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24 });
    for (const e of [
      { hook_event_name: 'SessionStart', session_id: 's1' },
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'x' },
      { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: 'Explore' },
      { hook_event_name: 'Stop', session_id: 's1' }
    ]) m.applyHook(info.id, e);
    expect(m.list()[0]?.session).toMatchObject({ state: 'done', subagents: 1 });
    let changed = 0;
    m.on('changed', () => { changed += 1; });
    m.sweepSessions(Date.now() + 60 * 60 * 1000);
    expect(changed).toBe(0);
    m.sweepSessions(Date.now() + 2 * 60 * 60 * 1000 + 60_000);
    expect(changed).toBe(1);
    expect(m.list()[0]?.session).toMatchObject({ state: 'done', subagents: 0 });
  });

  test('a background task no snapshot or event confirmed for 24 hours is dropped by the sweep', () => {
    const m = make();
    const info = m.create({ projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24 });
    for (const e of [
      { hook_event_name: 'SessionStart', session_id: 's1' },
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'x' },
      { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true }, tool_response: { backgroundTaskId: 'b1' } },
      { hook_event_name: 'Stop', session_id: 's1', background_tasks: [{ id: 'b1', type: 'shell', status: 'running', command: 'npm test' }] }
    ]) m.applyHook(info.id, e);
    expect(m.list()[0]?.session?.background?.items.map((i) => i.id)).toEqual(['b1']);
    let changed = 0;
    m.on('changed', () => { changed += 1; });
    m.sweepSessions(Date.now() + 23 * 60 * 60 * 1000);
    expect(changed).toBe(0);
    m.sweepSessions(Date.now() + 24 * 60 * 60 * 1000 + 60_000);
    expect(changed).toBe(1);
    expect(m.list()[0]?.session?.background?.items).toEqual([]);
  });

  test('pid: the shell\'s own pid, in create and in list (the app reads listening ports from its process tree)', async () => {
    const m = make();
    const info = m.create({ projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24 });
    expect(info.pid).toEqual(expect.any(Number));
    expect(info.pid).toBeGreaterThan(1);
    expect(m.list()[0]?.pid).toBe(info.pid);
    let out = '';
    m.attach(info.id, () => {}, (d) => { out += d; });
    m.input(info.id, 'echo shell-pid-$$\r');
    await until(() => out.includes(`shell-pid-${info.pid}`));
  });

  test('colors rotate', () => {
    const m = make();
    const a = m.create({ projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24 });
    const b = m.create({ projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24, name: 'Mio' });
    expect(a.color).not.toBe(b.color);
    expect(b.title).toBe('Mio');
  });
});

describe('default terminal numbers (smallest free per project, held only while shown)', () => {
  // The command goes into an unused variable: never typed, so nothing (least of all a real `claude`) ever runs.
  function makeQuiet(startingMs?: number) {
    const m = new TerminalManager({
      launch: (id) => ({ file: '/bin/zsh', args: ['-f'], env: buildTerminalEnv({ ...process.env, PS1: '$ ' }, { ATELIER_TERMINAL_ID: id }), initCommandEnv: 'ATELIER_TEST_UNUSED_COMMAND' }),
      ...(startingMs !== undefined ? { startingMs } : {})
    });
    managers.push(m);
    return m;
  }
  const root = tmpdir();
  const plain = (m: TerminalManager, projectRoot = root) => m.create({ projectRoot, cwd: projectRoot, cols: 80, rows: 24 });
  const titleOf = (m: TerminalManager, id: string) => m.list().find((x) => x.id === id)?.title;
  const closeAll = async (m: TerminalManager, ids: string[]) => {
    for (const id of ids) m.kill(id);
    await until(() => ids.every((id) => !m.has(id)));
  };

  test('closing every terminal: the next one is Terminal 1 again', async () => {
    const m = makeQuiet();
    const a = plain(m); const b = plain(m);
    expect([a.title, b.title]).toEqual(['Terminal 1', 'Terminal 2']);
    await closeAll(m, [a.id, b.id]);
    expect(plain(m).title).toBe('Terminal 1');
  });

  test('with Terminal 1 and 3 alive, the next one is Terminal 2', async () => {
    const m = makeQuiet();
    const a = plain(m); const b = plain(m); const c = plain(m);
    await closeAll(m, [b.id]);
    expect(plain(m).title).toBe('Terminal 2');
    expect([titleOf(m, a.id), titleOf(m, c.id)]).toEqual(['Terminal 1', 'Terminal 3']);
  });

  test('another project\'s numbers don\'t count', () => {
    const m = makeQuiet();
    plain(m, root); plain(m, root);
    expect(plain(m, homedir()).title).toBe('Terminal 1');
  });

  test('a terminal launched as a Claude session takes no number while it starts and once its session runs', () => {
    const m = makeQuiet();
    const s = m.create({ projectRoot: root, cwd: root, cols: 80, rows: 24, command: 'claude --model opus' });
    expect(s.title).not.toMatch(/^Terminal/);
    expect(plain(m).title).toBe('Terminal 1');
    m.applyHook(s.id, { hook_event_name: 'SessionStart', session_id: 's1' });
    expect(plain(m).title).toBe('Terminal 2');
  });

  test('a terminal running Claude holds no number: the next plain one takes it', () => {
    const m = makeQuiet();
    const a = plain(m);
    m.applyHook(a.id, { hook_event_name: 'SessionStart', session_id: 's1' });
    expect(titleOf(m, a.id)).not.toBe('Terminal 1');
    expect(plain(m).title).toBe('Terminal 1');
  });

  test('a named terminal holds no number', () => {
    const m = makeQuiet();
    const a = plain(m);
    m.rename(a.id, 'api');
    expect(plain(m).title).toBe('Terminal 1');
  });

  test('a session that ends gets its old number back while it is free', () => {
    const m = makeQuiet();
    plain(m);
    const a = plain(m);
    m.applyHook(a.id, { hook_event_name: 'SessionStart', session_id: 's1' });
    m.applyHook(a.id, { hook_event_name: 'SessionEnd', session_id: 's1', reason: 'other' });
    expect(titleOf(m, a.id)).toBe('Terminal 2');
  });

  test('a session that ends while another terminal shows its number takes the smallest free one; the other keeps it', () => {
    const m = makeQuiet();
    const a = plain(m);
    m.applyHook(a.id, { hook_event_name: 'SessionStart', session_id: 's1' });
    const b = plain(m);
    expect(b.title).toBe('Terminal 1');
    m.applyHook(a.id, { hook_event_name: 'SessionEnd', session_id: 's1', reason: 'other' });
    expect(titleOf(m, a.id)).toBe('Terminal 2');
    expect(titleOf(m, b.id)).toBe('Terminal 1');
  });

  test('a name removed while another terminal shows its number: the other keeps it', () => {
    const m = makeQuiet();
    const a = plain(m);
    m.rename(a.id, 'api');
    const b = plain(m);
    expect(b.title).toBe('Terminal 1');
    m.rename(a.id, null);
    expect(m.list().map((x) => x.title)).toEqual(['Terminal 2', 'Terminal 1']);
  });

  test('the one that kept showing its number keeps it even when listed before the one coming back', () => {
    const m = makeQuiet();
    const f = plain(m);
    m.rename(f.id, 'x');
    const z = plain(m);
    expect(z.title).toBe('Terminal 1');
    m.rename(z.id, 'y');
    m.rename(f.id, null);
    expect(titleOf(m, f.id)).toBe('Terminal 1');
    m.rename(z.id, null);
    expect(m.list().map((x) => x.title)).toEqual(['Terminal 1', 'Terminal 2']);
  });

  test('/clear in a launched session takes no number', () => {
    const m = makeQuiet();
    const s = m.create({ projectRoot: root, cwd: root, cols: 80, rows: 24, command: 'claude' });
    m.applyHook(s.id, { hook_event_name: 'SessionStart', session_id: 's1' });
    m.applyHook(s.id, { hook_event_name: 'SessionEnd', session_id: 's1', reason: 'clear' });
    m.applyHook(s.id, { hook_event_name: 'SessionStart', session_id: 's2', source: 'clear' });
    expect(plain(m).title).toBe('Terminal 1');
  });

  test('a launched session that ends takes the smallest free number then, and keeps it', () => {
    const m = makeQuiet();
    const s = m.create({ projectRoot: root, cwd: root, cols: 80, rows: 24, command: 'claude' });
    plain(m);
    m.applyHook(s.id, { hook_event_name: 'SessionStart', session_id: 's1' });
    m.applyHook(s.id, { hook_event_name: 'SessionEnd', session_id: 's1', reason: 'other' });
    expect(titleOf(m, s.id)).toBe('Terminal 2');
    plain(m);
    expect(titleOf(m, s.id)).toBe('Terminal 2');
  });

  test('another account\'s launch (CLAUDE_CONFIG_DIR=\'…\' claude) is a launched session too; other commands are not', () => {
    const m = makeQuiet();
    const a = m.create({ projectRoot: root, cwd: root, cols: 80, rows: 24, command: `CLAUDE_CONFIG_DIR='/d x/it'\\''s' claude --name='x'` });
    expect(titleOf(m, a.id)).not.toMatch(/^Terminal/);
    for (const command of [`CLAUDE_CONFIG_DIR='/d' vim`, 'FOO=1 claude', 'CLAUDE_CONFIG_DIR=/d claude', `CLAUDE_CONFIG_DIR='/d' claudex`]) {
      const t = m.create({ projectRoot: root, cwd: root, cols: 80, rows: 24, command });
      expect(titleOf(m, t.id), command).toMatch(/^Terminal/);
    }
  });

  test('a launched session with no session after the starting window falls back to a number (and says so)', async () => {
    const m = makeQuiet(150);
    const s = m.create({ projectRoot: root, cwd: root, cols: 80, rows: 24, command: 'claude' });
    let changed = 0;
    m.on('changed', () => { changed += 1; });
    expect(titleOf(m, s.id)).not.toMatch(/^Terminal/);
    await until(() => changed > 0 && titleOf(m, s.id) === 'Terminal 1', 2000);
  });
});

test('attach in the middle of a stream: no data lost between screen and streaming', async () => {
  const m = make();
  const info = m.create({ projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24 });
  let a = '';
  let snapshotB: string | null = null;
  let streamB = '';
  let triggered = false;
  m.attach(info.id, () => {}, (d) => {
    a += d;
    // At the exact moment a chunk arrives (written but not yet interpreted) a second client attaches.
    if (!triggered && d.includes('MARCA')) {
      triggered = true;
      m.attach(info.id, (s) => { snapshotB = s; }, (x) => { streamB += x; });
    }
  });
  m.input(info.id, 'echo MARCA-$((7*6))\r');
  await until(() => snapshotB !== null && a.includes('MARCA-42'));
  await new Promise((r) => setTimeout(r, 300));
  expect(snapshotB! + streamB).toContain('MARCA-42');
});

test('the initial command is written when the shell is ready: echoed only once', async () => {
  const m = new TerminalManager({
    launch: (id) => ({ file: '/bin/zsh', args: ['-f', '-c', 'sleep 0.4; PS1="$ " exec zsh -f -i'], env: buildTerminalEnv({ ...process.env }, { ATELIER_TERMINAL_ID: id }) })
  });
  managers.push(m);
  let out = '';
  const info = m.create({ projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24, command: 'echo una-$((2+3))-volta' });
  m.attach(info.id, () => {}, (d) => { out += d; });
  await until(() => out.includes('una-5-volta'));
  await new Promise((r) => setTimeout(r, 300));
  expect(out.split('echo una-$((2+3))-volta').length - 1).toBe(1);
});
