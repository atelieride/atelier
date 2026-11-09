// The SSH tunnel (src/main/databases/ssh-tunnel.ts) run for real against
// a fake ssh (tests/support/fake-ssh.mjs): the argv reaches it exactly as sshArgs builds it, the forward on 127.0.0.1
// carries the client to the test Postgres, a failure is kind 'ssh' with ssh's own words, close() stops the process
// (SIGKILL when SIGTERM isn't enough), and the hub opens one tunnel per session, closes it on disconnect, opens a new one
// when the old one dies, and keeps TLS naming the real server. The real ssh never runs here.
import { mkdtempSync, readFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import tls from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { DbConnectionForm, DbProblem, DbResult, DbSnapshot, DbSsh } from '../../src/shared/databases';
import { DbError, type DbConnectConfig, type DbDriver, type Tunnel } from '../../src/main/databases/driver';
import { DB_CHANNELS, DbHub, type DbHubWindow } from '../../src/main/databases/hub';
import { postgresDriver } from '../../src/main/databases/postgres/client';
import { HOST_KEY_MESSAGE, closeAllTunnels, createTunnelFactory, killLiveTunnels, sshArgs } from '../../src/main/databases/ssh-tunnel';
import { createDbStore } from '../../src/main/databases/store';
import { PgServer } from '../support/pg-server';

const FAKE = resolve(__dirname, '../support/fake-ssh.mjs');
const SECRET = 'Zq9-atelier-ssh-pw';
const BASTION: DbSsh = { host: 'bastion.test', port: 2222, user: 'me' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
}

// Every start of the fake: its pid and argv (FAKE_SSH_LOG, inherited by the process the factory spawns).
let logFile = '';
const starts = (): { pid: number; argv: string[] }[] => {
  try {
    return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { pid: number; argv: string[] });
  } catch {
    return [];
  }
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Whether 127.0.0.1:port takes a connection now. */
const accepts = (port: number): Promise<boolean> => new Promise((done) => {
  const s = connect({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); done(true); });
  s.once('error', () => { s.destroy(); done(false); });
});
async function problemOf(p: Promise<unknown>): Promise<DbProblem> {
  const e = await p.then(() => new Error('expected a rejection'), (x: unknown) => x);
  expect(e).toBeInstanceOf(DbError);
  return (e as DbError).problem;
}
const cfg = (port: number, o: Partial<DbConnectConfig> = {}): DbConnectConfig => ({
  host: '127.0.0.1', port, database: 'postgres', user: 'postgres', password: SECRET, tls: 'off', timeoutSec: 15, ...o
});

let server: PgServer;
beforeAll(async () => {
  logFile = join(mkdtempSync(join(tmpdir(), 'atl-fakessh-')), 'starts.jsonl');
  process.env.FAKE_SSH_LOG = logFile;
  server = await PgServer.start({ password: SECRET });
});
afterAll(async () => {
  // Nothing outlives the file: a fake still running (a test that failed half way) is killed, then every start is gone.
  for (const s of starts()) if (alive(s.pid)) process.kill(s.pid, 'SIGKILL');
  await until(() => starts().every((s) => !alive(s.pid)));
  delete process.env.FAKE_SSH_LOG;
  await server?.stop();
});

describe('the tunnel factory', () => {
  const open: Tunnel[] = [];
  afterEach(() => { for (const t of open.splice(0)) t.close(); });

  test('forwards 127.0.0.1:localPort to the target through ssh started with exactly sshArgs; close() stops it', async () => {
    const target = { host: '127.0.0.1', port: server.port };
    const t = await createTunnelFactory({ bin: FAKE })(BASTION, target);
    open.push(t);
    expect(t.closed).toBe(false);
    const run = starts().at(-1)!;
    expect(run.argv).toEqual(sshArgs(BASTION, target, t.localPort));
    expect(run.argv.slice(-2)).toEqual(['--', 'me@bastion.test']);
    const db = await postgresDriver.connect(cfg(t.localPort));
    expect((await db.run({ text: 'select count(*) from customers', values: [], shape: 'test' })).rows[0]![0]).toMatch(/^\d+$/);
    db.close();
    t.close();
    expect(t.closed).toBe(true);
    t.close(); // idempotent
    await until(() => !alive(run.pid));
    expect(await accepts(t.localPort)).toBe(false);
  });

  test('each tunnel gets its own free local port', async () => {
    const f = createTunnelFactory({ bin: FAKE });
    const [a, b] = await Promise.all([f(BASTION, { host: '127.0.0.1', port: server.port }), f(BASTION, { host: '127.0.0.1', port: server.port })]);
    open.push(a, b);
    expect(a.localPort).not.toBe(b.localPort);
    expect(await accepts(a.localPort)).toBe(true);
    expect(await accepts(b.localPort)).toBe(true);
  });

  test('keys refused: kind ssh with ssh\'s own line, and nothing left running', async () => {
    const n = starts().length;
    expect(await problemOf(createTunnelFactory({ bin: FAKE })({ ...BASTION, user: 'denied' }, { host: '127.0.0.1', port: server.port })))
      .toEqual({ kind: 'ssh', message: 'Permission denied (publickey).' });
    expect(starts()).toHaveLength(n + 1);
    await until(() => !alive(starts().at(-1)!.pid));
  });

  test('a host key ssh does not trust: the line and what to do', async () => {
    expect(await problemOf(createTunnelFactory({ bin: FAKE })({ ...BASTION, user: 'unknownhost' }, { host: '127.0.0.1', port: server.port })))
      .toEqual({ kind: 'ssh', message: HOST_KEY_MESSAGE });
  });

  test('stderr is kept bounded: the last line of a flood, cut to the last 4 KB', async () => {
    const p = await problemOf(createTunnelFactory({ bin: FAKE })({ ...BASTION, user: 'noisy' }, { host: '127.0.0.1', port: server.port }));
    expect(p.kind).toBe('ssh');
    expect(p.message).toMatch(/^y+$/);
    expect(p.message.length).toBeLessThanOrEqual(4096);
  });

  test('no forward within readyMs: kind ssh with the actual seconds, ssh stopped', async () => {
    const t0 = Date.now();
    expect(await problemOf(createTunnelFactory({ bin: FAKE, readyMs: 500 })({ ...BASTION, user: 'slow' }, { host: '127.0.0.1', port: server.port })))
      .toEqual({ kind: 'ssh', message: "The SSH tunnel didn't open in 0.5 s" });
    expect(Date.now() - t0).toBeLessThan(3000);
    const pid = starts().at(-1)!.pid;
    await until(() => !alive(pid));
  });

  test('an ssh that ignores SIGTERM is killed with SIGKILL 2 s later', async () => {
    const t = await createTunnelFactory({ bin: FAKE })({ ...BASTION, user: 'stubborn' }, { host: '127.0.0.1', port: server.port });
    const pid = starts().at(-1)!.pid;
    t.close();
    expect(t.closed).toBe(true);
    await sleep(1000);
    expect(alive(pid)).toBe(true);
    await until(() => !alive(pid), 4000);
    expect(await accepts(t.localPort)).toBe(false);
  });

  test('a tunnel whose ssh exits on its own marks itself closed', async () => {
    const t = await createTunnelFactory({ bin: FAKE })(BASTION, { host: '127.0.0.1', port: server.port });
    open.push(t);
    process.kill(starts().at(-1)!.pid, 'SIGKILL');
    await until(() => t.closed);
  });

  test('ssh missing: kind ssh, says so', async () => {
    const missing = join(tmpdir(), 'atl-no-such-ssh');
    expect(await problemOf(createTunnelFactory({ bin: missing })(BASTION, { host: '127.0.0.1', port: server.port })))
      .toEqual({ kind: 'ssh', message: `ssh isn't installed (${missing})` });
  });

  test('an SSH user or host ssh would read as an option: kind ssh, nothing started', async () => {
    const n = starts().length;
    const f = createTunnelFactory({ bin: FAKE });
    for (const bad of [{ ...BASTION, user: '-oProxyCommand=true' }, { ...BASTION, host: '-oProxyCommand=true' }]) {
      const p = await problemOf(f(bad, { host: '127.0.0.1', port: server.port }));
      expect(p.kind).toBe('ssh');
    }
    expect(starts()).toHaveLength(n);
  });

  test('hosts that are not a name or an IP literal, and users outside [A-Za-z0-9._-]: kind ssh, nothing started', async () => {
    const n = starts().length;
    const f = createTunnelFactory({ bin: FAKE });
    const bad = ['me@b', 'a;b', '$(x)', '`x`', "a'b", 'a b', '${HOME}', 'a/b', 'a\\b'];
    for (const h of bad) {
      expect((await problemOf(f({ ...BASTION, host: h }, { host: '127.0.0.1', port: server.port }))).kind, h).toBe('ssh');
      expect((await problemOf(f(BASTION, { host: h, port: server.port }))).kind, h).toBe('ssh');
      expect((await problemOf(f({ ...BASTION, user: h }, { host: '127.0.0.1', port: server.port }))).kind, h).toBe('ssh');
    }
    expect(starts()).toHaveLength(n);
  });

  test('port and user left to ~/.ssh/config: no -p, the host alone after --', async () => {
    const target = { host: '127.0.0.1', port: server.port };
    // An alias with '_', as ~/.ssh/config allows.
    const alias = { host: 'prod_bastion', port: null, user: '' };
    const t = await createTunnelFactory({ bin: FAKE })(alias, target);
    open.push(t);
    const run = starts().at(-1)!;
    expect(run.argv).toEqual(sshArgs(alias, target, t.localPort));
    expect(run.argv).not.toContain('-p');
    expect(run.argv.slice(-2)).toEqual(['--', 'prod_bastion']);
    const db = await postgresDriver.connect(cfg(t.localPort));
    expect((await db.run({ text: 'select 1', values: [], shape: 'test' })).rows).toEqual([['1']]);
    db.close();
  });

  test('closeAllTunnels (quit) stops an ssh still opening: its factory rejects, the process is gone', async () => {
    const n = starts().length;
    const opening = createTunnelFactory({ bin: FAKE })({ ...BASTION, user: 'slow' }, { host: '127.0.0.1', port: server.port });
    await until(() => starts().length > n);
    const pid = starts().at(-1)!.pid;
    closeAllTunnels();
    expect(await problemOf(opening)).toEqual({ kind: 'ssh', message: 'The SSH tunnel was closed' });
    await until(() => !alive(pid));
  });

  test('on process exit, every ssh still alive gets SIGKILL at once (even one that ignores SIGTERM)', async () => {
    const t = await createTunnelFactory({ bin: FAKE })({ ...BASTION, user: 'stubborn' }, { host: '127.0.0.1', port: server.port });
    const pid = starts().at(-1)!.pid;
    expect(process.listeners('exit')).toContain(killLiveTunnels);
    closeAllTunnels();
    await sleep(300);
    expect(alive(pid)).toBe(true);
    killLiveTunnels();
    // Well before close()'s own SIGKILL, 2 s after its SIGTERM.
    await until(() => !alive(pid), 1000);
    expect(t.closed).toBe(true);
  });
});

// —— through the hub ——

const A = '/code/acme';
interface FakeWindow extends DbHubWindow { last(): DbSnapshot | undefined }
function win(id: number): FakeWindow {
  const sent: { ch: string; p: unknown }[] = [];
  return {
    id,
    send: (ch, p) => { sent.push({ ch, p }); },
    isDestroyed: () => false,
    once: () => {},
    last: () => [...sent].reverse().find((x) => x.ch === DB_CHANNELS.snapshot)?.p as DbSnapshot | undefined
  };
}
function ok<T>(r: DbResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.problem.kind}: ${r.problem.message}`);
  return r.value;
}

describe('the hub with the real tunnel factory', () => {
  let hub: DbHub | null = null;
  let configs: DbConnectConfig[] = [];
  afterEach(() => { hub?.dispose(); hub = null; });

  async function setup(): Promise<void> {
    configs = [];
    const driver: DbDriver = { connect: (c) => { configs.push(c); return postgresDriver.connect(c); } };
    const secrets = new Map<string, string>();
    hub = new DbHub({
      settings: () => ({ showDatabases: 'auto', dbTimeoutSec: 15 }),
      store: createDbStore(mkdtempSync(join(tmpdir(), 'atl-dbssh-'))),
      secrets: { read: (id) => secrets.get(id) ?? null, write: (id, v) => { secrets.set(id, v); }, remove: (id) => { secrets.delete(id); } },
      driver,
      tunnel: createTunnelFactory({ bin: FAKE }),
      timing: { idleCloseMs: 60_000 }
    });
    const w = win(1);
    hub.open(A, w);
    await until(() => w.last() !== undefined);
  }
  const form = (o: Partial<DbConnectionForm> = {}): DbConnectionForm => ({
    name: 'acme via bastion', engine: 'postgres', env: 'prod', host: '127.0.0.1', port: server.port, database: 'postgres', user: 'postgres',
    tls: 'off', ssh: BASTION, scope: { kind: 'project', root: A }, ...o
  });
  const page = (connId: string) => hub!.page(1, { ref: { connId, schema: 'public', name: 'customers' }, columns: [], derived: [], filters: [], sort: [], page: 0, size: 5 });

  test('a connection with ssh connects through the tunnel, reads, and disconnect stops ssh', async () => {
    await setup();
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    const n = starts().length;
    ok(await hub!.connect(1, id));
    expect(starts()).toHaveLength(n + 1);
    const run = starts().at(-1)!;
    const local = Number(/^127\.0\.0\.1:(\d+):/.exec(run.argv[2]!)![1]);
    expect(configs.at(-1)).toMatchObject({ host: '127.0.0.1', port: local });
    expect(ok(await page(id)).rows.length).toBeGreaterThan(0);
    hub!.disconnect(1, id);
    await until(() => !alive(run.pid));
    expect(await accepts(local)).toBe(false);
  });

  test('ssh killed mid-session: the next read reconnects through a new tunnel', async () => {
    await setup();
    const id = ok(await hub!.save(1, { form: form(), password: SECRET, id: null })).id;
    ok(await hub!.connect(1, id));
    ok(await page(id));
    const first = starts().at(-1)!;
    process.kill(first.pid, 'SIGKILL');
    await until(() => !alive(first.pid));
    expect(ok(await page(id)).rows.length).toBeGreaterThan(0);
    const second = starts().at(-1)!;
    expect(second.pid).not.toBe(first.pid);
    expect(alive(second.pid)).toBe(true);
    hub!.dispose();
    hub = null;
    await until(() => !alive(second.pid));
  });

  test('the bastion can\'t reach the database: kind ssh with ssh\'s channel line, naming the target, never 127.0.0.1:<local>', async () => {
    await setup();
    const closed = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
    });
    const id = ok(await hub!.save(1, { form: form({ port: closed }), password: SECRET, id: null })).id;
    const r = await hub!.connect(1, id);
    expect(r).toEqual({ ok: false, problem: { kind: 'ssh', message: `The bastion couldn't reach 127.0.0.1:${closed}: connect failed: Connection refused` } });
    // The tunnel it opened is gone.
    await until(() => !alive(starts().at(-1)!.pid));
  });

  test('a Test Connection whose tunnel opens after dispose: closed, no ssh left, the server never contacted', async () => {
    await setup();
    const n = starts().length;
    const testing = hub!.test(1, { form: form({ ssh: { ...BASTION, user: 'late' } }), password: SECRET, id: null });
    await until(() => starts().length > n);
    const pid = starts().at(-1)!.pid;
    hub!.dispose();
    expect(await testing).toMatchObject({ ok: false });
    await until(() => !alive(pid));
    expect(configs).toEqual([]);
  });

  test('a refused key: the connection shows kind ssh with ssh\'s line, and no session was tried', async () => {
    await setup();
    const id = ok(await hub!.save(1, { form: form({ ssh: { ...BASTION, user: 'denied' } }), password: SECRET, id: null })).id;
    expect(await hub!.connect(1, id)).toEqual({ ok: false, problem: { kind: 'ssh', message: 'Permission denied (publickey).' } });
    expect(configs).toEqual([]);
  });

  describe('TLS through the tunnel', () => {
    let secure: PgServer;
    beforeAll(async () => { secure = await PgServer.start({ tls: true, seed: false }); });
    afterAll(async () => { await secure?.stop(); });

    test('pg dials 127.0.0.1 and TLS still names the real server (SNI)', async () => {
      await setup();
      const spy = vi.spyOn(tls, 'connect');
      try {
        const id = ok(await hub!.save(1, { form: form({ host: 'localhost', port: secure.port, tls: 'require' }), password: '', id: null })).id;
        const info = ok(await hub!.connect(1, id));
        expect(info.tls).toBe(true);
        expect(configs.at(-1)).toMatchObject({ host: '127.0.0.1', servername: 'localhost' });
        const opts = spy.mock.calls.map((c) => c[0] as tls.ConnectionOptions).at(-1)!;
        expect(opts).toMatchObject({ host: '127.0.0.1', servername: 'localhost' });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

test('main wires the real factory (the test ssh through devEnv, else the system one) and stops every ssh on quit', () => {
  const index = readFileSync(resolve(__dirname, '../../src/main/index.ts'), 'utf8');
  expect(index).toMatch(/tunnel: createTunnelFactory\(\{ bin: devEnv\('ATELIER_TEST_SSH_BIN'\) \?\? sshBinary\(process\.platform, process\.env\) \}\)/);
  expect(index).toMatch(/app\.on\('will-quit', \(\) => \{ dbHub\.dispose\(\); closeAllTunnels\(\); \}\)/);
});
