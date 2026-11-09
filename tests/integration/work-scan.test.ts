import { afterEach, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { TerminalInfo } from '../../src/shared/protocol';
import type { BackgroundItem } from '../../src/shared/session';
import type { WorkScan } from '../../src/shared/background';
import { WorkHub } from '../../src/main/work-hub';
import { readArgs, readListening, readProcessTree } from '../../src/main/procs/exec';

// Only processes this test starts: each "terminal" is its own detached sh, never anything of the user's.
const children: ChildProcess[] = [];
const hubs: WorkHub[] = [];
afterEach(() => {
  hubs.splice(0).forEach((h) => h.dispose());
  for (const c of children.splice(0)) { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ } }
});

/** `what` (or what it returns at the timeout) says what was awaited in the failure. */
const until = async <T>(what: string | (() => string), get: () => T | undefined, ms = 10000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout after ${ms} ms waiting for ${typeof what === 'function' ? what() : what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** A free non-ephemeral port (20000–39999): listened on and closed here, then handed to the spawned server. */
const freePort = async (): Promise<number> => {
  const start = 20000 + Math.floor(Math.random() * 20000);
  for (let i = 0; i < 200; i++) {
    const port = 20000 + ((start - 20000 + i) % 20000);
    const ok = await new Promise<boolean>((resolve, reject) => {
      const s = createServer();
      s.once('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' ? resolve(false) : reject(err)));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error('no free port in 20000–39999 after 200 tries');
};

/** A terminal whose shell starts one background command the way Claude Code does (zsh, `eval '…'`, `'` as `'\''`). */
const terminal = (command: string): ChildProcess => {
  const script = `eval '${command.replace(/'/g, "'\\''")}' < /dev/null && pwd -P >| /dev/null`;
  const sh = spawn('/bin/sh', ['-c', '"$0" "$@" & wait', '/bin/zsh', '-f', '-c', script], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  children.push(sh);
  return sh;
};
const item = (id: string, command: string): BackgroundItem => ({ id, kind: 'shell', label: id, command, since: Date.now() });
const info = (id: string, pid: number, items: BackgroundItem[]): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'claude', createdAt: 0, pid,
  session: { sessionId: id, state: 'done', title: null, activity: null, contextPct: null, unread: true, updatedAt: 0, background: { items, crons: [] } }
});

test('real ps: the arguments of live pids; a pid already gone is just absent, all gone is no process', async () => {
  const live = terminal('sleep 30').pid!;
  const done = spawn('/usr/bin/true');
  await new Promise((r) => done.once('exit', r));
  const gone = done.pid!;
  const list = await readArgs([live, gone]);
  expect(list.map((p) => p.pid)).toEqual([live]);
  expect(list[0]!.args).toMatch(/^\/bin\/sh -c /);
  await expect(readArgs([gone])).resolves.toEqual([]);
});

test('a dev server started in the background is a server (its listener seen for 15 s); a sleeping shell is matched, then gone once killed', async () => {
  const port = await freePort();
  const dev = `"${process.execPath}" -e "require('http').createServer(() => {}).listen(${port}, '127.0.0.1')"`;
  const a = terminal(dev);
  const b = terminal('sleep 30');
  let scans: Record<string, WorkScan> = {};
  // The scans' clock runs 10× faster: two real scans 3 s apart see the listener for 30 s (the processes stay real).
  const t0 = Date.now();
  const hub = new WorkHub({ readTree: () => readProcessTree(), readArgs: (p) => readArgs(p), readListening: (p) => readListening(p), now: () => t0 + (Date.now() - t0) * 10 });
  hubs.push(hub);
  hub.onChange = (s) => { scans = s; };
  hub.update([info('a', a.pid!, [item('dev', dev)]), info('b', b.pid!, [item('slp', 'sleep 30')])]);
  await until(() => `the dev shell to be a server listening on ${port} (last scan: ${JSON.stringify(scans.a)})`, () => (scans.a?.servers.includes('dev') ? scans.a : undefined));
  const slp = await until('the sleep shell to be matched', () => scans.b?.matched.slp);
  expect(scans.b!.servers).toEqual([]);
  process.kill(slp, 'SIGKILL');
  await until('the killed sleep shell to be gone', () => (scans.b?.gone.includes('slp') ? true : undefined));
  expect(scans.b!.matched).toEqual({});
}, 30000);
