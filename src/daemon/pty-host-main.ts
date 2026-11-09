import net from 'node:net';
import { runPtyHost } from './pty-host-entry';

// Bundled alone as out/main/pty-host.js (electron.vite.daemon.config.ts): argv = [Atelier, pty-host.js, host, sock, token].
void runPtyHost(process.argv.slice(2), {
  connect: (path) => net.createConnection(path),
  execve: (file, args, env) => {
    if (!process.execve) throw new Error('process.execve is unavailable in this runtime');
    process.execve(file, args, env);
  },
  fail: (message) => { process.stderr.write(`atelier pty-host: ${message}\n`); process.exit(1); }
});
