#!/usr/bin/env node
// A fake `ssh` for tests: the real one never runs in a test. It takes the argv
// src/main/databases/ssh-tunnel.ts builds — -N, -L 127.0.0.1:<local>:<host>:<port>, -p <port> (optional), -o <option>…,
// then `--` and [<user>@]<host> — and does what `ssh -N -L` does once signed in: forwards 127.0.0.1:<local> to the
// target, one TCP connection per connection it accepts. It listens on 127.0.0.1 only and forwards to loopback targets
// only (127.0.0.1, localhost, ::1), so whatever argv it gets, it reaches nothing outside the machine. A forwarded
// connection it can't open (a closed port, a target that isn't loopback) is closed with OpenSSH's line on stderr:
// `channel N: open failed: connect failed: <reason>`.
//
// It is started directly (an executable script, git mode 100755, `#!/usr/bin/env node`), as the app starts ssh: POSIX
// only (tests/support/posix-only.ts lists the test file that runs it).
//
// The user picks a behaviour (no user — a ~/.ssh/config alias — forwards):
//   denied       "Permission denied (publickey)." on stderr, exit 255 (keys refused)
//   unknownhost  OpenSSH's two lines for a host key it doesn't know under BatchMode, exit 255
//   slow         signs in but never opens the forward (the tunnel's ready timeout)
//   late         opens the forward 300 ms after it starts
//   stubborn     forwards, and ignores SIGTERM: only SIGKILL stops it
//   noisy        20 000 characters of stderr, then a last line of 20 000 without a newline, exit 255
//   anyone else  forwards
// An argv it doesn't expect (an unknown option, no `--` before the destination, a command after it, no -N, BatchMode,
// ExitOnForwardFailure, ControlMaster=no or ControlPath=none missing (never a shared or lingering master), a
// forward not bound to 127.0.0.1) is an exit 255 with the reason on stderr, so a test sees an argv that drifted.
// FAKE_SSH_LOG: each start appends { pid, argv } to that file as one JSON line.
import { appendFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';

const argv = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify({ pid: process.pid, argv })}\n`);

const LOOPBACK = new Map([['127.0.0.1', '127.0.0.1'], ['localhost', '127.0.0.1'], ['::1', '::1']]);
/** What OpenSSH says for the errors a forwarded connect meets. */
const REASONS = { ECONNREFUSED: 'Connection refused', ETIMEDOUT: 'Operation timed out', EHOSTUNREACH: 'No route to host' };

/** The argv as ssh-tunnel.ts builds it, or the reason it isn't. */
function parse(args) {
  let forward = null;
  let noCommand = false;
  const options = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      if (args.length !== i + 2) return { error: 'fake ssh: one destination after --, and no remote command' };
      const dest = args[i + 1];
      const at = dest.lastIndexOf('@');
      if (at === 0 || at === dest.length - 1) return { error: `fake ssh: destination ${dest} is not [user@]host` };
      if (!noCommand) return { error: 'fake ssh: -N missing' };
      for (const o of ['BatchMode=yes', 'ExitOnForwardFailure=yes', 'ControlMaster=no', 'ControlPath=none']) {
        if (!options.includes(o)) return { error: `fake ssh: -o ${o} missing` };
      }
      if (!forward) return { error: 'fake ssh: -L missing' };
      const m = /^127\.0\.0\.1:(\d+):(\[[^\]]+\]|[^:[\]]+):(\d+)$/.exec(forward);
      if (!m) return { error: `fake ssh: the forward ${forward} must be 127.0.0.1:<port>:<host>:<port>` };
      return {
        user: at < 0 ? '' : dest.slice(0, at), host: dest.slice(at + 1), local: Number(m[1]),
        target: { host: m[2].replace(/^\[|\]$/g, ''), port: Number(m[3]) }
      };
    }
    if (a === '-N') { noCommand = true; continue; }
    if (a === '-L' || a === '-p' || a === '-o') {
      const v = args[++i];
      if (v === undefined) return { error: `fake ssh: option requires an argument -- ${a.slice(1)}` };
      if (a === '-L') forward = v;
      else if (a === '-o') options.push(v);
      continue;
    }
    return { error: `fake ssh: unexpected argument ${a} (the destination follows --)` };
  }
  return { error: 'fake ssh: no -- before the destination' };
}

/** Exits 255 once `text` is written to stderr (a pipe on macOS is written asynchronously). */
function fail(text) {
  process.exitCode = 255;
  process.stderr.write(text);
}

/** Forwards 127.0.0.1:<local> to the target, one upstream connection per connection accepted. */
function forward(p) {
  let channel = 1;
  const server = createServer((inbound) => {
    channel++;
    const host = LOOPBACK.get(p.target.host);
    const refuse = (reason) => {
      process.stderr.write(`channel ${channel}: open failed: connect failed: ${reason}\n`);
      inbound.destroy();
    };
    if (!host) return refuse(`the fake ssh forwards to loopback only (${p.target.host})`);
    const upstream = connect({ host, port: p.target.port });
    let opened = false;
    upstream.once('connect', () => {
      opened = true;
      inbound.pipe(upstream);
      upstream.pipe(inbound);
    });
    const close = () => { inbound.destroy(); upstream.destroy(); };
    upstream.on('error', (e) => (opened ? close() : refuse(REASONS[e.code] ?? e.code)));
    upstream.on('close', () => { if (opened) close(); });
    inbound.on('error', close);
    inbound.on('close', () => { if (opened) close(); else upstream.destroy(); });
  });
  // ExitOnForwardFailure=yes: a port it can't listen on ends ssh, as OpenSSH words it.
  server.on('error', (e) => fail(`bind [127.0.0.1]:${p.local}: ${e.code}\nchannel_setup_fwd_listener_tcpip: cannot listen to port: ${p.local}\nCould not request local forwarding.\n`));
  server.listen({ host: '127.0.0.1', port: p.local });
}

const p = parse(argv);
if (p.error) fail(`${p.error}\n`);
else if (p.user === 'denied') fail('Permission denied (publickey).\n');
else if (p.user === 'unknownhost') fail(`No ED25519 host key is known for ${p.host} and you have requested strict checking.\nHost key verification failed.\n`);
else if (p.user === 'noisy') fail(`${'x'.repeat(20_000)}\n${'y'.repeat(20_000)}`);
else if (p.user === 'slow') setInterval(() => {}, 60_000);
else if (p.user === 'late') setTimeout(() => forward(p), 300);
else {
  if (p.user === 'stubborn') process.on('SIGTERM', () => {});
  forward(p);
}
