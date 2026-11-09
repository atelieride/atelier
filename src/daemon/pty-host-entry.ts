import net from 'node:net';

/**
 * pty-host.js, run by a terminal's launchd job with Atelier's own executable in
 * node mode: `Atelier pty-host.js <native host> <host socket> <token>`. Starting the job as Atelier makes its
 * responsible process carry Atelier's identity (the privacy grants: Documents…); execve() keeps the pid, and with it
 * that identity, while the native host replaces the node runtime at once (a few hundred KB per terminal, not a runtime).
 *
 * atelierd copies this file into ATELIER_HOME/bin at start, so it must stay self-contained: node built-ins only.
 */
export interface PtyHostDeps {
  connect(path: string): net.Socket;
  execve(file: string, args: string[], env: Record<string, string>): void;
  fail(message: string): void;
  timeoutMs?: number;
}

const HOST_PROTO = '1';
const TOKEN = /^[0-9a-f]{32}$/;
const MAX_REPLY = 8 * 1024 * 1024;

const plain = (s: unknown): s is string => typeof s === 'string' && !s.includes('\0');

interface Launch { slave: string; cwd: string; file: string; args: string[]; env: Record<string, string> }

function parseLaunch(line: string): Launch | null {
  let m: Record<string, unknown>;
  try { m = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (!m || m.t !== 'launch' || !plain(m.slave) || !plain(m.cwd) || !plain(m.file) || !m.file) return null;
  if (!Array.isArray(m.args) || !m.args.every(plain)) return null;
  const env = m.env as Record<string, unknown> | null;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  if (!Object.entries(env).every(([k, v]) => plain(k) && k.length > 0 && !k.includes('=') && plain(v))) return null;
  return { slave: m.slave, cwd: m.cwd, file: m.file, args: m.args as string[], env: env as Record<string, string> };
}

function reportFailure(deps: PtyHostDeps, sock: string, token: string, done: () => void): void {
  let over = false;
  const end = () => { if (!over) { over = true; clearTimeout(t); r.destroy(); done(); } };
  const t = setTimeout(end, 1000);
  const r = deps.connect(sock);
  r.on('connect', () => {
    r.write(JSON.stringify({ t: 'hello', token }) + '\n');
    r.write(JSON.stringify({ t: 'failed', step: 2, errno: 0 }) + '\n');
    r.end?.();
    setTimeout(end, 50);
  });
  r.on('error', end);
}

export function runPtyHost(argv: string[], deps: PtyHostDeps): Promise<void> {
  return new Promise((resolve) => {
    const [host, sock, token] = argv;
    if (!plain(host) || !host || !plain(sock) || !sock || !TOKEN.test(token ?? '')) {
      deps.fail('usage: pty-host.js <host> <socket> <token>');
      resolve();
      return;
    }
    let reply = '';
    let finished = false;
    const s = deps.connect(sock);
    const finish = (message: string | null, launch?: Launch) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      s.destroy();
      if (!launch) { deps.fail(message ?? 'no launch'); resolve(); return; }
      try {
        deps.execve(host, [host, HOST_PROTO, sock, token!, launch.slave, launch.cwd, launch.file, ...launch.args], launch.env);
      } catch (err) {
        // The native host could not run (missing, not executable): say so as the host would, so atelierd falls back
        // to node-pty now rather than after its timeout.
        reportFailure(deps, sock, token!, () => { deps.fail(`cannot start the native host: ${(err as Error).message}`); resolve(); });
        return;
      }
      resolve();
    };
    const timer = setTimeout(() => finish('atelierd did not answer'), deps.timeoutMs ?? 5000);
    s.setEncoding?.('utf8');
    s.on('connect', () => s.write(JSON.stringify({ t: 'fetch', token }) + '\n'));
    s.on('data', (d: string | Buffer) => {
      reply += String(d);
      if (reply.length > MAX_REPLY) { finish('launch too large'); return; }
      const i = reply.indexOf('\n');
      if (i < 0) return;
      const launch = parseLaunch(reply.slice(0, i));
      finish(launch ? null : 'malformed launch', launch ?? undefined);
    });
    s.on('error', (err: Error) => finish(`cannot reach atelierd: ${err.message}`));
    s.on('end', () => finish('atelierd sent no launch'));
    s.on('close', () => finish('atelierd sent no launch'));
  });
}
