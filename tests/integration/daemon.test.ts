import { constants, copyFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { isSocketAlive, runDaemon, type RunningDaemon } from '../../src/daemon/main';
import { connectControl, connectRaw } from './helpers';
import { encode, type ServerMessage, type TerminalInfo } from '../../src/shared/protocol';

const running: RunningDaemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'atl-d-'));
  const d = await runDaemon({ home, version: '0.0.0-test', shellArgs: ['-f'] });
  running.push(d);
  return d;
}

describe('atelierd', () => {
  test('folder, socket and info file permissions', async () => {
    const d = await start();
    expect(statSync(d.paths.home).mode & 0o777).toBe(0o700);
    expect(statSync(d.paths.sock).mode & 0o777).toBe(0o600);
    expect(statSync(d.paths.info).mode & 0o777).toBe(0o600);
    const info = JSON.parse(readFileSync(d.paths.info, 'utf8'));
    expect(info.token).toBe(d.info.token);
    expect(info.pid).toBe(process.pid);
  });

  test('wrong token → connection closed without welcome', async () => {
    const d = await start();
    const c = await connectControl(d.paths.sock, 'x'.repeat(64));
    await c.closed;
    expect(c.messages).toEqual([]);
  });

  test('the hook token does not open the control channel', async () => {
    const d = await start();
    const c = await connectControl(d.paths.sock, d.hookToken);
    await c.closed;
    expect(c.messages).toEqual([]);
  });

  test('silence beyond 2s without a header → closed', async () => {
    const d = await start();
    const s = net.createConnection(d.paths.sock);
    const t0 = Date.now();
    await new Promise((r) => s.on('close', r));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
  });

  test('full flow: create, attach, input, detach, reattach with the screen', async () => {
    const d = await start();
    const c = await connectControl(d.paths.sock, d.info.token);
    const w = await c.next((m) => m.t === 'welcome');
    expect(w).toMatchObject({ t: 'welcome', v: 1, version: '0.0.0-test' });

    c.send({ t: 'create', rid: 1, projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24 });
    const created = await c.next((m) => m.t === 'reply' && m.rid === 1) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
    const term = created.result as TerminalInfo;
    await c.next((m) => m.t === 'terminals' && m.list.some((x) => x.id === term.id));

    c.send({ t: 'attach', rid: 2, id: term.id });
    await c.next((m) => m.t === 'snapshot' && m.id === term.id);
    c.send({ t: 'input', id: term.id, data: 'echo first-$((1+1))\r' });
    await c.next((m) => m.t === 'data' && m.data.includes('first-2'));

    c.send({ t: 'detach', rid: 3, id: term.id });
    await c.next((m) => m.t === 'reply' && m.rid === 3);
    c.close();

    // A new client (the reopened app) finds the screen again.
    const c2 = await connectControl(d.paths.sock, d.info.token);
    await c2.next((m) => m.t === 'welcome');
    c2.send({ t: 'attach', rid: 1, id: term.id });
    const snap = await c2.next((m) => m.t === 'snapshot') as Extract<ServerMessage, { t: 'snapshot' }>;
    expect(snap.data).toContain('first-2');
    c2.close();
  });

  test('invalid request → error reply, connection stays alive', async () => {
    const d = await start();
    const c = await connectControl(d.paths.sock, d.info.token);
    await c.next((m) => m.t === 'welcome');
    c.send({ t: 'create', rid: 9, projectRoot: 'relative', cwd: '/', cols: 80, rows: 24 });
    const r = await c.next((m) => m.t === 'reply' && m.rid === 9);
    expect(r).toMatchObject({ ok: false });
    c.send({ t: 'list', rid: 10 });
    await c.next((m) => m.t === 'reply' && m.rid === 10);
    c.close();
  });

  test('hook with hook token → delivered and connection closed by the service', async () => {
    const home = mkdtempSync(join(tmpdir(), 'atl-d-'));
    const got: unknown[] = [];
    const d = await runDaemon({ home, version: 't', shellArgs: ['-f'], onHook: (term, p) => got.push({ term, p }) });
    running.push(d);
    const c = await connectRaw(d.paths.sock, encode({ t: 'hook', token: d.hookToken, term: 'abc' }) + '{"hook_event_name":"Stop",\n"session_id":"s"}');
    await c.closed;
    expect(got).toEqual([{ term: 'abc', p: { hook_event_name: 'Stop', session_id: 's' } }]);
  });

  test('hook with wrong token → ignored', async () => {
    const home = mkdtempSync(join(tmpdir(), 'atl-d-'));
    const got: unknown[] = [];
    const d = await runDaemon({ home, version: 't', shellArgs: ['-f'], onHook: (_term, p) => got.push(p) });
    running.push(d);
    const c = await connectRaw(d.paths.sock, encode({ t: 'hook', token: 'nope', term: 'abc' }) + '{}');
    await c.closed;
    expect(got).toEqual([]);
  });

  test('scheduled prompts: capability, list, refusals, and a prompt typed and sent at once into a free Claude', async () => {
    const d = await start();
    const c = await connectControl(d.paths.sock, d.info.token);
    const w = await c.next((m) => m.t === 'welcome') as Extract<ServerMessage, { t: 'welcome' }>;
    expect(w.capabilities).toContain('schedules');
    expect(await c.next((m) => m.t === 'schedules')).toEqual({ t: 'schedules', list: [] });
    c.send({ t: 'create', rid: 1, projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24 });
    const id = ((await c.next((m) => m.t === 'reply' && m.rid === 1)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
    c.send({ t: 'schedAdd', rid: 2, terminalId: id.id, text: 'hello', at: Date.now(), ifBusy: 'wait' });
    expect(await c.next((m) => m.t === 'reply' && m.rid === 2)).toMatchObject({ ok: false, error: 'not a Claude session' });
    // A "Claude" in front: cat, with bracketed paste on, and a session from the hooks.
    c.send({ t: 'attach', rid: 3, id: id.id });
    await c.next((m) => m.t === 'snapshot');
    c.send({ t: 'input', id: id.id, data: "printf '\\033[?2004h'; cat\r" });
    for (const e of [{ hook_event_name: 'SessionStart', session_id: 's1' }, { hook_event_name: 'Stop', session_id: 's1' }]) {
      const h = await connectRaw(d.paths.sock, encode({ t: 'hook', token: d.hookToken, term: id.id }) + JSON.stringify(e));
      await h.closed;
    }
    await c.next((m) => m.t === 'terminals' && m.list.some((x) => x.id === id.id && x.session?.state === 'done' && x.foreground === 'cat'), 5000);
    // Past the typing gate's quiet (the input above): scheduled now, fired now.
    await new Promise((r) => setTimeout(r, 10_200));
    c.send({ t: 'schedAdd', rid: 4, terminalId: id.id, text: 'run the tests\nplease', at: Date.now(), ifBusy: 'wait' });
    const added = await c.next((m) => m.t === 'reply' && m.rid === 4) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
    const pid = (added.result as { id: string }).id;
    c.send({ t: 'schedAdd', rid: 5, terminalId: id.id, text: 'again', at: Date.now(), ifBusy: 'wait' });
    expect(await c.next((m) => m.t === 'reply' && m.rid === 5)).toMatchObject({ ok: false, error: 'time taken' });
    c.send({ t: 'schedFire', rid: 6, id: pid });
    await c.next((m) => m.t === 'reply' && m.rid === 6);
    await c.next((m) => m.t === 'data' && m.data.includes('please'), 5000);
    const sent = await c.next((m) => m.t === 'schedules' && m.list.some((x) => x.id === pid && x.status === 'sent'), 5000) as Extract<ServerMessage, { t: 'schedules' }>;
    expect(sent.list.find((x) => x.id === pid)).toMatchObject({ terminalId: id.id, sessionId: 's1', text: 'run the tests\nplease' });
    c.send({ t: 'schedRemove', rid: 7, id: pid });
    await c.next((m) => m.t === 'schedules' && m.list.length === 0);
    await d.stop();
    running.splice(running.indexOf(d), 1);
    expect(JSON.parse(readFileSync(d.paths.schedules, 'utf8'))).toEqual({ v: 1, list: [] });
    expect(statSync(d.paths.schedules).mode & 0o777).toBe(0o600);
    c.close();
  }, 30_000);

  // Claude Code will continue at the reset, so the session reads as paused.
  test('usage-limit pause: a rate_limit stop and a status line at 100 % list the session as paused; quota_auto_resume_fired runs it again', async () => {
    const d = await start();
    const c = await connectControl(d.paths.sock, d.info.token);
    await c.next((m) => m.t === 'welcome');
    c.send({ t: 'create', rid: 1, projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24 });
    const term = ((await c.next((m) => m.t === 'reply' && m.rid === 1)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
    // A "Claude" in front (cat): with the shell back in front, atelierd would take the session as gone.
    c.send({ t: 'attach', rid: 2, id: term.id });
    await c.next((m) => m.t === 'snapshot');
    c.send({ t: 'input', id: term.id, data: 'cat\r' });
    await c.next((m) => m.t === 'terminals' && m.list.some((x) => x.id === term.id && x.foreground === 'cat'), 5000);
    // Claude's config dir under the run's temp root, without settings.json: auto-continue is on (Claude Code's default).
    const dir = mkdtempSync(join(tmpdir(), 'atl-claude-'));
    const transcript = join(dir, 'projects', '-tmp', 's1.jsonl');
    const send = async (t: 'hook' | 'status', payload: object) => {
      const h = await connectRaw(d.paths.sock, encode({ t, token: d.hookToken, term: term.id }) + JSON.stringify(payload));
      await h.closed;
    };
    const resetsAt = Math.floor(Date.now() / 1000) + 7200;
    const session = (m: ServerMessage) => (m.t === 'terminals' ? m.list.find((x) => x.id === term.id)?.session ?? null : null);
    await send('hook', { hook_event_name: 'SessionStart', session_id: 's1', transcript_path: transcript, source: 'startup' });
    await send('hook', { hook_event_name: 'StopFailure', session_id: 's1', transcript_path: transcript, error: 'rate_limit', last_assistant_message: 'API Error: Request rejected (429)' });
    await send('status', { session_id: 's1', transcript_path: transcript, rate_limits: { five_hour: { used_percentage: 100, resets_at: resetsAt } } });
    const paused = session(await c.next((m) => session(m)?.limitPause?.resetsAt === resetsAt * 1000, 5000));
    expect(paused).toMatchObject({ state: 'error', errorReason: 'rate_limit', limitPause: { resetsAt: resetsAt * 1000 } });
    expect(paused!.limitPause!.over).toBeUndefined();
    await send('hook', { hook_event_name: 'Notification', session_id: 's1', transcript_path: transcript, notification_type: 'quota_auto_resume_fired' });
    const resumed = session(await c.next((m) => session(m)?.state === 'running', 5000));
    expect(resumed).toMatchObject({ state: 'running', errorReason: null });
    expect('limitPause' in resumed!).toBe(false);
    c.close();
  }, 15_000);

  test('usage-limit pause: the account’s limits from another terminal count, another account’s never; Claude Code’s setting off leaves today’s error', async () => {
    const d = await start();
    const c = await connectControl(d.paths.sock, d.info.token);
    await c.next((m) => m.t === 'welcome');
    // Two "Claudes" in front (cat): with the shell back in front, atelierd would take their sessions as gone.
    const terms: TerminalInfo[] = [];
    for (const rid of [1, 2]) {
      c.send({ t: 'create', rid, projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24 });
      const term = ((await c.next((m) => m.t === 'reply' && m.rid === rid)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
      c.send({ t: 'input', id: term.id, data: 'cat\r' });
      terms.push(term);
    }
    await c.next((m) => m.t === 'terminals' && terms.every((t) => m.list.some((x) => x.id === t.id && x.foreground === 'cat')), 5000);
    const [a, b] = terms as [TerminalInfo, TerminalInfo];
    const send = async (id: string, t: 'hook' | 'status', payload: object) => {
      const h = await connectRaw(d.paths.sock, encode({ t, token: d.hookToken, term: id }) + JSON.stringify(payload));
      await h.closed;
    };
    const session = (m: ServerMessage, id: string) => (m.t === 'terminals' ? m.list.find((x) => x.id === id)?.session ?? null : null);
    const resetsAt = Math.floor(Date.now() / 1000) + 7200;
    // Account A at its limit, as terminal a's status line says; account B with no limits known and Claude Code's default
    // (auto-continue on); account C whose settings.json turns auto-continue off.
    const limited = mkdtempSync(join(tmpdir(), 'atl-claude-'));
    const other = mkdtempSync(join(tmpdir(), 'atl-claude-'));
    const off = mkdtempSync(join(tmpdir(), 'atl-claude-'));
    writeFileSync(join(off, 'settings.json'), JSON.stringify({ autoContinueAtUsageLimit: false }));
    const transcript = (dir: string, sid: string) => join(dir, 'projects', '-tmp', `${sid}.jsonl`);
    const stop = async (id: string, dir: string, sid: string) => {
      await send(id, 'hook', { hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript(dir, sid), source: 'startup' });
      await send(id, 'hook', { hook_event_name: 'StopFailure', session_id: sid, transcript_path: transcript(dir, sid), error: 'rate_limit' });
      return session(await c.next((m) => session(m, id)?.sessionId === sid && session(m, id)?.state === 'error', 5000), id)!;
    };
    await send(a.id, 'status', { session_id: 'sa', transcript_path: transcript(limited, 'sa'), rate_limits: { five_hour: { used_percentage: 100, resets_at: resetsAt } } });
    // b runs on account A and has no limits of its own: atelierd's merged ones prove its stop a usage limit.
    expect((await stop(b.id, limited, 'sb')).limitPause).toEqual({ since: expect.any(Number), resetsAt: resetsAt * 1000 });
    // a's own limits are A's: its Claude now on account B is only checking, never armed with A's reset.
    expect((await stop(a.id, other, 'sc')).limitPause).toEqual({ since: expect.any(Number), resetsAt: null });
    // b's Claude on account C, which doesn't continue by itself: today's error, no pause at all.
    const stopped = await stop(b.id, off, 'sd');
    expect(stopped).toMatchObject({ state: 'error', errorReason: 'rate_limit' });
    expect('limitPause' in stopped).toBe(false);
    c.close();
  }, 15_000);

  // What Claude Code sends that Atelier doesn't recognize, kept content-free.
  test('signals notebook: unknown values from hooks and the status line reach the app and claude-signals.json; Clear empties it at once', async () => {
    const d = await start();
    const c = await connectControl(d.paths.sock, d.info.token);
    const w = await c.next((m) => m.t === 'welcome') as Extract<ServerMessage, { t: 'welcome' }>;
    expect(w.capabilities).toContain('signals');
    expect(await c.next((m) => m.t === 'signals')).toEqual({ t: 'signals', book: { lastVersion: null, since: expect.any(Number), entries: [] } });
    // A "Claude Code 2.1.320" in front: its native binary is named after its version. Here node under that name, waiting
    // on its input: a link would run under its target's name, and macOS kills a copy of a system binary like cat.
    const bin = mkdtempSync(join(tmpdir(), 'atl-bin-'));
    const claude = join(bin, '2.1.320');
    copyFileSync(process.execPath, claude, constants.COPYFILE_FICLONE);
    c.send({ t: 'create', rid: 1, projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24 });
    const term = ((await c.next((m) => m.t === 'reply' && m.rid === 1)) as Extract<ServerMessage, { t: 'reply'; ok: true }>).result as TerminalInfo;
    c.send({ t: 'input', id: term.id, data: `${claude} -e 'process.stdin.resume()'\r` });
    await c.next((m) => m.t === 'terminals' && m.list.some((x) => x.id === term.id && x.foreground === '2.1.320'), 5000);
    const send = async (id: string, t: 'hook' | 'status', payload: object) => {
      const h = await connectRaw(d.paths.sock, encode({ t, token: d.hookToken, term: id }) + JSON.stringify(payload));
      await h.closed;
    };
    await send(term.id, 'hook', { hook_event_name: 'Notification', session_id: 's1', notification_type: 'quota_new_thing', message: 'secret text' });
    await send(term.id, 'status', { session_id: 's1', rate_limits: { five_hour: { used_percentage: '100%' } } });
    // A terminal the reducer doesn't know: noted all the same (before the reducer), with no version.
    await send('nope', 'hook', { hook_event_name: 'Notification', session_id: 's2', notification_type: 'quota_new_thing' });
    // One message after the 2 s debounce, with the three findings.
    const noted = await c.next((m) => m.t === 'signals' && m.book.entries.length > 0, 5000) as Extract<ServerMessage, { t: 'signals' }>;
    const entry = (kind: string, event: string | null, value: string, version: string | null) =>
      ({ kind, event, value, version, first: expect.any(Number), last: expect.any(Number), count: 1 });
    expect(noted.book).toEqual({
      lastVersion: '2.1.320', since: expect.any(Number),
      entries: [
        entry('notification', 'Notification', 'quota_new_thing', '2.1.320'),
        entry('status', null, 'rate_limits.five_hour', '2.1.320'),
        entry('notification', 'Notification', 'quota_new_thing', null)
      ]
    });
    expect(JSON.parse(readFileSync(d.paths.claudeSignals, 'utf8'))).toEqual(noted.book);
    expect(statSync(d.paths.claudeSignals).mode & 0o777).toBe(0o600);
    expect(readFileSync(d.paths.claudeSignals, 'utf8')).not.toContain('secret');
    // Clear: the empty book comes before the reply, not after the debounce; the last version stays.
    c.send({ t: 'signalsClear', rid: 2 });
    expect(await c.next((m) => m.t === 'reply' && m.rid === 2)).toEqual({ t: 'reply', rid: 2, ok: true });
    const cleared = c.messages.find((m) => m.t === 'signals') as Extract<ServerMessage, { t: 'signals' }> | undefined;
    expect(cleared?.book).toEqual({ lastVersion: '2.1.320', since: expect.any(Number), entries: [] });
    // Saved at stop, debounce or not.
    await d.stop();
    running.splice(running.indexOf(d), 1);
    expect(JSON.parse(readFileSync(d.paths.claudeSignals, 'utf8'))).toEqual(cleared!.book);
    c.close();
  }, 15_000);

  test('second instance with a live service → refuses and does not touch the socket', async () => {
    const d = await start();
    await expect(runDaemon({ home: d.paths.home, version: 'x', shellArgs: ['-f'] })).rejects.toThrow(/already running/);
    expect(await isSocketAlive(d.paths.sock)).toBe(true);
  });

  test('a client that does not read is disconnected beyond the threshold', async () => {
    const home = mkdtempSync(join(tmpdir(), 'atl-d-'));
    const d = await runDaemon({ home, version: 't', shellArgs: ['-f'], maxQueuedBytes: 256 * 1024 });
    running.push(d);
    const c = await connectControl(d.paths.sock, d.info.token);
    await c.next((m) => m.t === 'welcome');
    c.send({ t: 'create', rid: 1, projectRoot: tmpdir(), cwd: tmpdir(), cols: 80, rows: 24 });
    const r = await c.next((m) => m.t === 'reply' && m.rid === 1) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
    const id = (r.result as TerminalInfo).id;
    c.send({ t: 'attach', rid: 2, id });
    await c.next((m) => m.t === 'snapshot');
    c.socket.pause(); // the client stops reading
    c.send({ t: 'input', id, data: 'yes | head -c 5000000\r' });
    // A paused socket does not see the close until it reads: resume after the service has decided.
    await new Promise((r) => setTimeout(r, 1500));
    c.socket.resume();
    await c.closed;
  });
});

test('stop with a connected client → stops and closes the connection', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-d-'));
  const d = await runDaemon({ home, version: 't', shellArgs: ['-f'] });
  const c = await connectControl(d.paths.sock, d.info.token);
  await c.next((m) => m.t === 'welcome');
  const stopped = await Promise.race([d.stop().then(() => 'ok'), new Promise((r) => setTimeout(() => r('hung'), 3000))]);
  expect(stopped).toBe('ok');
  await c.closed;
});

test('hello with a different protocol version → incompatible reply, then close', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atl-d-'));
  const d = await runDaemon({ home, version: 't', shellArgs: ['-f'] });
  running.push(d);
  const c = await connectRaw(d.paths.sock, encode({ t: 'hello', token: d.info.token, v: 99 }));
  await c.closed;
  expect(c.messages).toEqual([{ t: 'incompatible', v: 1 }]);
});
