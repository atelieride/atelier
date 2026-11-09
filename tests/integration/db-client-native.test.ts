// NODE_PG_FORCE_NATIVE makes pg's index load pg-native: libpq, which reads ~/.pgpass, PGOPTIONS, PGSSLMODE… on its own,
// and isn't installed (so the import itself would throw, taking the main process down). The client imports pg's
// JS client directly, so the variable can't switch it. A file of its own: the variable is set before anything in this
// process loads pg.
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NODE_PG_FORCE_NATIVE = '1';
});

import { postgresDriver } from '../../src/main/databases/postgres/client';
import { PgServer } from '../support/pg-server';

let s: PgServer;
beforeAll(async () => { s = await PgServer.start({ seed: false }); });
afterAll(async () => { await s?.stop(); });

test('the client loads and connects through the JS client with NODE_PG_FORCE_NATIVE set', async () => {
  expect(process.env.NODE_PG_FORCE_NATIVE).toBe('1');
  const db = await postgresDriver.connect({
    host: '127.0.0.1', port: s.port, database: 'postgres', user: 'postgres', password: '', tls: 'off', timeoutSec: 15
  });
  expect((await db.run({ text: 'select 1', values: [], shape: 'test' })).rows).toEqual([['1']]);
  db.close();
  expect(await s.startupsLog()).toEqual([{ user: 'postgres', database: 'postgres', application_name: 'atelier', client_encoding: 'UTF8' }]);
});
