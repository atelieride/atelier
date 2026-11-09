// The test Postgres's worker thread (tests/support/pg-server.ts). Plain JS: vitest's
// and Playwright's TypeScript transforms don't reach a `new Worker(path)`.
//
// PGlite (Postgres 18 in WASM) is served by @electric-sql/pglite-socket on an internal port, behind our front proxy on
// the public one. The proxy speaks just enough of the wire protocol for what tests need from a real server:
// - SSLRequest → 'N', or 'S' and a TLS upgrade with the fixture certificate when `tls` is on (pglite-socket only says
//   'N'); GSSENCRequest → 'N'; CancelRequest → closed (PGlite can't cancel a running statement);
// - with a `password`, AuthenticationCleartextPassword and the check of the reply (wrong → FATAL 28P01, as Postgres
//   says it); then the client's original StartupMessage goes to PGlite, which answers AuthenticationOk;
// - the text of every Query ('Q') and Parse ('P') message it forwards, in order (statementsLog), and the parameters of
//   every StartupMessage it lets through (startupsLog: user, database, application_name, options…);
// - stopListening drops every connection and stops accepting; resume listens again on the same port;
// - terminate ends every connection as a restarting server does (FATAL 57P01, then close) and keeps listening.
//
// One backend serves every connection: pglite-socket runs one message at a time and, inside a transaction block, only
// the messages of the connection that opened it (a dropped connection's transaction is rolled back). Outside a
// transaction, two clients' extended-protocol messages can interleave: concurrent clients should wrap their reads in
// BEGIN … ROLLBACK, as the app's client does. A running statement holds the backend to its end (a timed-out
// pg_sleep keeps the next connection waiting until it's done). The proxy forwards with backpressure (./pg-relay.mjs).
//
// Pinned: @electric-sql/pglite-socket 0.2.18 (package.json names it exactly). Two of PGLiteSocketServer's private members
// are used, neither part of its API: `queryQueue` (QueryQueueManager: enqueue(handlerId, message, onData), exec's turn
// in the queue) and `server` (the net.Server: the inner port). Before a version bump, check both again in its dist/ and
// update this line (pg-server.test.ts holds it to the installed version).
import { readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';
import { parentPort, workerData } from 'node:worker_threads';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { relay } from './pg-relay.mjs';

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const PROTOCOL_3 = 196608;
const MAX_STARTUP = 10_000;
/** exec's place in pglite-socket's queue (its connections count up from 1). */
const EXEC_HANDLER = -1;

// ── Wire protocol ──────────────────────────────────────────────────────────────────────────────────────────────────

const message = (type, body) => {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(4 + body.length, 1);
  return Buffer.concat([head, body]);
};
const int32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const cstring = (b, from) => {
  const end = b.indexOf(0, from);
  return b.subarray(from, end < 0 ? b.length : end).toString('utf8');
};
const AUTH_CLEARTEXT = message('R', int32(3));
const fatal = (code, text) =>
  message('E', Buffer.concat([...[['S', 'FATAL'], ['V', 'FATAL'], ['C', code], ['M', text]].map(([f, v]) => Buffer.from(`${f}${v}\0`)), Buffer.from([0])]));

/** The StartupMessage's parameters (user, database, …). */
function startupParams(msg) {
  const params = {};
  let at = 8;
  while (at < msg.length && msg[at] !== 0) {
    const k = cstring(msg, at);
    at += Buffer.byteLength(k) + 1;
    const v = cstring(msg, at);
    at += Buffer.byteLength(v) + 1;
    params[k] = v;
  }
  return params;
}

/** The first ErrorResponse in a stream of backend messages, as an Error ("message (SQLSTATE)"), or null. */
function firstError(out) {
  for (let at = 0; at + 5 <= out.length; at += 1 + out.readInt32BE(at + 1)) {
    if (out[at] !== 0x45) continue; // 'E'
    const fields = {};
    const end = at + 1 + out.readInt32BE(at + 1);
    for (let f = at + 5; f < end && out[f] !== 0; ) {
      const v = cstring(out, f + 1);
      fields[String.fromCharCode(out[f])] = v;
      f += 2 + Buffer.byteLength(v);
    }
    return new Error(`${fields.M} (${fields.C})`);
  }
  return null;
}

// ── State ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** @type {{ password: string | null; tls: boolean; seed: string | null; tlsDir: string }} */
const { password, tls, seed, tlsDir } = workerData;
const key = tls ? readFileSync(join(tlsDir, 'server.key')) : null;
const cert = tls ? readFileSync(join(tlsDir, 'server.crt')) : null;

/** Every Query/Parse text the proxy forwarded, in order. */
const statements = [];
/** The parameters of every StartupMessage the proxy forwarded, in order. */
const startups = [];
/** Client sockets (plain and TLS) and their upstream sockets, dropped by stopListening. */
const live = new Set();
/** One entry per open client connection: { terminate() }. */
const conns = new Set();
let db = null;
let inner = null;
let innerPort = 0;
let front = null;
let frontPort = 0;

// ── The front proxy ────────────────────────────────────────────────────────────────────────────────────────────────

async function listen(port) {
  if (front) return;
  const server = createServer(serve);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  front = server;
  frontPort = server.address().port;
}

async function stopListening() {
  const server = front;
  if (!server) return;
  front = null;
  const closed = new Promise((resolve) => server.close(() => resolve()));
  for (const s of live) s.destroy();
  live.clear();
  await closed;
}

/** Splits the frontend stream into messages (a chunk can hold several, a message can span chunks) and logs Q and P. */
function frontendLogger() {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let at = 0;
    while (buf.length - at >= 5) {
      const len = buf.readInt32BE(at + 1);
      if (buf.length - at < 1 + len) break;
      const type = String.fromCharCode(buf[at]);
      const body = buf.subarray(at + 5, at + 1 + len);
      if (type === 'Q') statements.push(cstring(body, 0));
      else if (type === 'P') statements.push(cstring(body, body.indexOf(0) + 1)); // statement name, then the query
      at += 1 + len;
    }
    buf = buf.subarray(at);
  };
}

function serve(raw) {
  raw.setNoDelay(true);
  live.add(raw);
  let sock = raw; // the TLSSocket once an SSLRequest was accepted
  let upstream = null;
  let pending = Buffer.alloc(0);
  let phase = 'startup'; // → 'password' when one is set → 'proxy' (or 'refused')
  let startup = null;
  let closed = false;
  const log = frontendLogger();

  const conn = {
    /**
     * As Postgres on a fast shutdown: FATAL 57P01 to the client, then the connection ends (upstream first, so its
     * open transaction rolls back). Sent between messages only in tests: a client waiting on its answer.
     */
    terminate() {
      if (closed) return;
      if (phase !== 'proxy') return close();
      closed = true;
      conns.delete(conn);
      phase = 'refused';
      upstream.destroy();
      for (const s of [raw, sock, upstream]) live.delete(s);
      sock.end(fatal('57P01', 'terminating connection due to administrator command'));
    }
  };
  conns.add(conn);
  const close = () => {
    if (closed) return;
    closed = true;
    conns.delete(conn);
    for (const s of [raw, sock, upstream]) {
      if (!s) continue;
      s.destroy();
      live.delete(s);
    }
  };
  raw.on('error', close);
  raw.on('close', close);

  const onData = (chunk) => {
    if (phase === 'proxy') {
      log(chunk);
      relay(chunk, sock, upstream);
      return;
    }
    if (phase === 'refused') return;
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    advance();
  };
  raw.on('data', onData);

  function advance() {
    for (;;) {
      if (phase === 'startup') {
        if (pending.length < 8) return;
        const len = pending.readInt32BE(0);
        if (len < 8 || len > MAX_STARTUP) return close();
        if (pending.length < len) return;
        const code = pending.readInt32BE(4);
        const msg = Buffer.from(pending.subarray(0, len));
        pending = pending.subarray(len);
        if (code === SSL_REQUEST && tls && sock === raw) return upgrade();
        if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
          sock.write('N');
          continue;
        }
        if (code !== PROTOCOL_3) return close(); // a CancelRequest, or a protocol we don't speak
        startup = msg;
        if (password === null) return forward();
        sock.write(AUTH_CLEARTEXT);
        phase = 'password';
      } else if (phase === 'password') {
        if (pending.length < 5) return;
        const len = pending.readInt32BE(1);
        if (pending.length < 1 + len) return;
        const isPassword = pending[0] === 0x70; // 'p'
        const given = isPassword ? cstring(pending.subarray(5, 1 + len), 0) : null;
        pending = pending.subarray(1 + len);
        if (given === password) return forward();
        phase = 'refused';
        const user = startupParams(startup).user ?? 'postgres';
        sock.end(fatal('28P01', `password authentication failed for user "${user}"`));
        return;
      } else return;
    }
  }

  function upgrade() {
    raw.removeListener('data', onData);
    raw.write('S');
    pending = Buffer.alloc(0);
    const secure = new TLSSocket(raw, { isServer: true, key, cert });
    sock = secure;
    live.add(secure);
    secure.on('data', onData);
    secure.on('error', close);
    secure.on('close', close);
  }

  function forward() {
    phase = 'proxy';
    startups.push(startupParams(startup));
    upstream = connect(innerPort, '127.0.0.1');
    upstream.setNoDelay(true);
    live.add(upstream);
    upstream.on('data', (d) => relay(d, upstream, sock));
    upstream.on('error', close);
    upstream.on('close', close);
    upstream.write(startup);
    if (pending.length) {
      log(pending);
      upstream.write(pending);
      pending = Buffer.alloc(0);
    }
  }
}

// ── Requests from the test side ────────────────────────────────────────────────────────────────────────────────────

/**
 * exec takes its turn in pglite-socket's queue, as one more connection would: a client's open transaction (the app's
 * ROLLBACK goes out after its result resolves) ends first, instead of the setup running inside it.
 */
async function execQueued(sql) {
  const replies = [];
  await inner.queryQueue.enqueue(EXEC_HANDLER, message('Q', Buffer.from(`${sql}\0`)), (d) => replies.push(Buffer.from(d)));
  const err = firstError(Buffer.concat(replies));
  if (err) throw err;
}

async function handle(op, sql) {
  if (op === 'exec') return execQueued(sql);
  if (op === 'log') return [...statements];
  if (op === 'startups') return startups.map((p) => ({ ...p }));
  if (op === 'clearLog') return void ((statements.length = 0), (startups.length = 0));
  if (op === 'stopListening') return stopListening();
  if (op === 'terminate') return void [...conns].forEach((c) => c.terminate());
  if (op === 'resume') return listen(frontPort);
  throw new Error(`unknown op ${op}`);
}

// ── Start ──────────────────────────────────────────────────────────────────────────────────────────────────────────

try {
  db = await PGlite.create({ extensions: { citext } });
  if (seed) await db.exec(seed);
  // One backend, many connections: a generous cap (past it pglite-socket answers plain text a client can't parse).
  inner = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 64 });
  await inner.start();
  innerPort = inner.server.address().port;
  await listen(0);
} catch (err) {
  parentPort.postMessage({ failed: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
parentPort.on('message', async ({ id, op, sql }) => {
  try {
    parentPort.postMessage({ id, ok: true, value: await handle(op, sql) });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
parentPort.postMessage({ ready: true, port: frontPort });
