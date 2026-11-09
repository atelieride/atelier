import { afterEach, expect, test, vi } from 'vitest';
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
import { spawn, type ChildProcess } from 'node:child_process';
import type { TerminalInfo } from '../../src/shared/protocol';
import type { PortsMap } from '../../src/shared/ports';
import { PortsHub } from '../../src/main/ports-hub';
import { readListening, readProcessTree } from '../../src/main/procs/exec';

// Only processes this test starts: the tree is rooted at its own child, never at anything of the user's.
const children: ChildProcess[] = [];
const hubs: PortsHub[] = [];
afterEach(() => {
  hubs.splice(0).forEach((h) => h.dispose());
  for (const c of children.splice(0)) { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ } }
});

const until = async <T>(get: () => T | undefined, ms = 8000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('a node server under a shell: its port is reported for that terminal, then gone after it is killed', async () => {
  // sh → node (a descendant, as a dev server under a terminal's shell); `; :` keeps sh from exec-ing node.
  const server = "const s=require('http').createServer(()=>{}).listen(0,'127.0.0.1',()=>console.log('PORT='+s.address().port))";
  const sh = spawn('/bin/sh', ['-c', `'${process.execPath}' -e "${server}"; :`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  children.push(sh);
  let out = '';
  sh.stdout!.on('data', (d) => { out += String(d); });
  const port = Number(await until(() => /PORT=(\d+)/.exec(out)?.[1]));

  const sent: PortsMap[] = [];
  // listen(0) picks an ephemeral port: hidden by default, shown with the setting.
  const hub = new PortsHub({ readTree: () => readProcessTree(), readListening: (p) => readListening(p), enabled: () => true, focused: () => true, showEphemeral: () => true });
  hubs.push(hub);
  hub.open('/p', { id: 1, send: (_c, m) => { sent.push(m); }, isDestroyed: () => false, once: () => {} });
  const term: TerminalInfo = { id: 't1', projectRoot: '/p', cwd: '/p', title: 'T', name: null, color: '#fff', foreground: 'sh', createdAt: 0, session: null, pid: sh.pid! };
  hub.setTerminals([term]);
  const ports = await until(() => sent.at(-1)?.t1);
  expect(ports).toEqual([{ port, name: 'node' }]);
  expect(hub.openTarget('/p', 't1', port)).toBe(`http://localhost:${port}/`);

  process.kill(-sh.pid!, 'SIGKILL');
  // The next scans (on refresh, as on window focus) find it gone.
  await until(() => { hub.refresh(); return sent.at(-1) && !sent.at(-1)!.t1 ? true : undefined; });
  expect(hub.portsOf('/p')).toEqual({});
});
