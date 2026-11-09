// The site shots' Postgres: the live demo's world (src/demo/world/databases.ts)
// loaded into the test Postgres (./pg-server.ts: PGlite behind the proxy, on a free loopback port), so the Databases
// shot shows the very database the demo plays. The world is already SQL-shaped: each relation's DDL as Atelier rebuilds
// it (comments included, in creation order), the function's definition, every value as Postgres prints it — so the
// seed is those texts in order, then the rows as text literals Postgres casts to each column's type.
import { acmeDatabase, type AcmeDatabase, type PgText } from '../../src/demo/world/databases';
import { PgServer } from './pg-server';

const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const literal = (v: PgText): string => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);

/**
 * The world as one SQL script: the schemas besides public, the enums, each relation's DDL, the functions, the tables'
 * rows (a view's come from its query), then ANALYZE, so the view's estimates are the row counts.
 */
export function demoSeedSql(db: AcmeDatabase): string {
  const out: string[] = [];
  for (const s of db.schemas) if (s !== 'public') out.push(`CREATE SCHEMA ${ident(s)};`);
  for (const e of db.enums) out.push(`CREATE TYPE ${ident(e.schema)}.${ident(e.name)} AS ENUM (${e.values.map(literal).join(', ')});`);
  for (const r of db.relations) out.push(r.ddl.trimEnd());
  for (const f of db.functions) out.push(`${f.def.trimEnd()};`);
  for (const r of db.relations) {
    if (r.kind !== 'table' || r.rows.length === 0) continue;
    const columns = r.columns.map((c) => ident(c.name)).join(', ');
    const values = r.rows.map((row) => `  (${row.map(literal).join(', ')})`).join(',\n');
    out.push(`INSERT INTO ${ident(r.schema)}.${ident(r.name)} (${columns}) VALUES\n${values};`);
  }
  out.push('ANALYZE;');
  return `${out.join('\n\n')}\n`;
}

/** A test Postgres holding the demo world at `nowMs` (its times are offsets from it). Stop it with stop(). */
export async function startDemoPostgres(nowMs: number): Promise<PgServer> {
  const server = await PgServer.start({ seed: false });
  try {
    await server.exec(demoSeedSql(acmeDatabase(nowMs)));
  } catch (e) {
    await server.stop();
    throw e;
  }
  return server;
}
