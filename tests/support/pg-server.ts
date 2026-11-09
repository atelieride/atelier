// The test Postgres: a real Postgres 18 engine (PGlite, compiled to WASM) for integration
// tests and e2e, reached over TCP on 127.0.0.1 like any server, seeded with the acme world (./pg-fixtures.ts).
//
// PGlite and the front proxy run in a worker thread (./pg-worker.mjs, which documents the proxy): a WASM
// pg_sleep holds the thread it runs on, and the test's own event loop (client-side timeouts, Playwright) must keep
// turning. The test side talks to it through the port and these methods.
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ACME_SQL } from './pg-fixtures';

export interface PgServerOptions {
  /** Asks for this password (cleartext auth); a wrong one gets FATAL 28P01. Without it, any client gets in. */
  password?: string;
  /** Accepts TLS (the self-signed fixture certificate, CN localhost) when the client asks; plain connections still work. */
  tls?: boolean;
  /** Loads the acme world (default true). */
  seed?: boolean;
}

type Reply = { id: number; ok: true; value?: unknown } | { id: number; ok: false; error: string };
type Ready = { ready: true; port: number } | { failed: string };
interface Waiter { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class PgServer {
  /** postgres://postgres@127.0.0.1:<port>/postgres (no password in it, even when one is set). */
  readonly url: string;
  private nextId = 1;
  private readonly waiting = new Map<number, Waiter>();
  private gone: Error | null = null;

  private constructor(private readonly worker: Worker, readonly port: number) {
    this.url = `postgres://postgres@127.0.0.1:${port}/postgres`;
    // The worker never holds the test process open (a file that forgets stop() still ends), except while a call waits
    // for its answer (call refs it).
    worker.unref();
    worker.on('message', (m: Reply) => {
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (this.waiting.size === 0) worker.unref();
      if (m.ok) w.resolve(m.value);
      else w.reject(new Error(m.error));
    });
    const fail = (e: Error) => {
      this.gone = e;
      for (const w of this.waiting.values()) w.reject(e);
      this.waiting.clear();
    };
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`the test Postgres stopped (worker exit ${code})`)));
  }

  static async start(o: PgServerOptions = {}): Promise<PgServer> {
    const worker = new Worker(join(__dirname, 'pg-worker.mjs'), {
      workerData: {
        password: o.password ?? null,
        tls: o.tls === true,
        seed: o.seed === false ? null : ACME_SQL,
        tlsDir: join(__dirname, '../fixtures/pg-tls')
      }
    });
    const port = await new Promise<number>((resolve, reject) => {
      const onMessage = (m: Ready) => {
        cleanup();
        if ('ready' in m) resolve(m.port);
        else reject(new Error(`the test Postgres didn't start: ${m.failed}`));
      };
      const onError = (e: Error) => { cleanup(); reject(e); };
      const onExit = (code: number) => { cleanup(); reject(new Error(`the test Postgres didn't start (worker exit ${code})`)); };
      const cleanup = () => { worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit); };
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
    });
    return new PgServer(worker, port);
  }

  private call<T = void>(op: string, sql?: string): Promise<T> {
    if (this.gone) return Promise.reject(this.gone);
    const id = this.nextId++;
    if (this.waiting.size === 0) this.worker.ref();
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, op, sql });
    });
  }

  /** Every Query and Parse text the front proxy forwarded since the start (or the last clearLog), in order. */
  statementsLog(): Promise<string[]> { return this.call<string[]>('log'); }
  /** The parameters of every StartupMessage the proxy let through (user, database, application_name, options…), in order. */
  startupsLog(): Promise<Record<string, string>[]> { return this.call<Record<string, string>[]>('startups'); }
  /** Empties both logs. */
  clearLog(): Promise<void> { return this.call('clearLog'); }
  /**
   * Runs on the PGlite instance itself, not through the proxy (setup: not logged, not read-only), in its turn: after
   * a client's open transaction ends. Rejects with "<message> (<SQLSTATE>)".
   */
  exec(sql: string): Promise<void> { return this.call('exec', sql); }
  /** Drops every connection and stops accepting new ones (connection-lost tests). */
  stopListening(): Promise<void> { return this.call('stopListening'); }
  /** Listens again on the same port. */
  resume(): Promise<void> { return this.call('resume'); }
  /**
   * Ends every connection as a restarting server does: FATAL 57P01 "terminating connection due to administrator
   * command" to each client, then close (open transactions roll back). Keeps listening. In the worker's turn: a
   * running pg_sleep delays it, so a request "in flight" in a test is one waiting behind another client's transaction.
   */
  terminate(): Promise<void> { return this.call('terminate'); }
  /** Ends the worker, and with it PGlite and every socket, even in the middle of a pg_sleep. */
  async stop(): Promise<void> {
    if (this.gone) return;
    this.gone = new Error('the test Postgres was stopped');
    for (const w of this.waiting.values()) w.reject(this.gone);
    this.waiting.clear();
    await this.worker.terminate();
  }
}
