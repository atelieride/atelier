import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { descendants, readArgs, readEstablished, readListening, readProcessTree, useWindowsProcs } from '../../src/main/procs/exec';
import { isWin, useMachinePlatform } from '../support/platform';
import { createConnection } from 'node:net';

// atelier-procs.exe for real: a child of this test listening on a port is in the process tree
// under this process, with its command line and its port; a connection to it from here is ours. Needs the binary
// (`npm run build` on Windows).

useMachinePlatform();
const BIN = resolve('vendor', 'bin', 'atelier-procs.exe');
beforeAll(() => { if (isWin) useWindowsProcs(BIN); });
afterAll(() => { useWindowsProcs(null); });

test.runIf(isWin)('tree, args, a listening port and a loopback connection, read with atelier-procs', async () => {
  const script = "require('net').createServer(()=>{}).listen(0,'127.0.0.1',function(){console.log(this.address().port)})";
  const child = spawn(process.execPath, ['-e', script, 'atelier-procs-marker'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  try {
    const port = await new Promise<number>((r) => child.stdout!.once('data', (d) => r(Number(String(d).trim()))));
    const tree = await readProcessTree();
    expect(descendants(tree, process.pid)).toContain(child.pid);
    const [args] = await readArgs([child.pid!]);
    expect(args?.args).toContain('atelier-procs-marker');
    expect((await readListening([child.pid!])).get(child.pid!)).toMatchObject({ ports: [port] });
    const sock = createConnection(port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    try {
      const mine = await readEstablished(port, [process.pid]);
      expect([...mine.values()]).toEqual([process.pid]);
      expect([...mine.keys()]).toEqual([sock.localPort]);
    } finally {
      sock.destroy();
    }
  } finally {
    child.kill();
  }
}, 20_000);
