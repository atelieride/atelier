import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbStore, dbConnectionSchema, secretIdOf } from './store';
import type { DbConnection } from '@shared/databases';
import { expectMode, posixTest } from '../../../tests/support/platform';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'atl-dbstore-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const conn = (n: number, over: Partial<DbConnection> = {}): DbConnection => ({
  id: `c${n.toString(16).padStart(12, '0')}`, name: `db ${n}`, engine: 'postgres', env: 'dev', host: 'localhost', port: 5432,
  database: 'app', user: 'me', tls: 'prefer', ssh: null, scope: { kind: 'all' }, mask: false, writeNoted: false, createdAt: 1, ...over
});
const file = () => join(home, 'databases.json');

test('put, list, get and remove round-trip, across a new store', () => {
  const s = createDbStore(home);
  s.put(conn(1)); s.put(conn(2)); s.put(conn(1, { name: 'renamed' }));
  expect(s.list().map((c) => c.name)).toEqual(['renamed', 'db 2']);
  expect(s.get(conn(2).id)?.name).toBe('db 2');
  expect(s.get('cffffffffffff')).toBeNull();
  expect(createDbStore(home).list()).toHaveLength(2);
  s.remove(conn(1).id);
  expect(createDbStore(home).list().map((c) => c.id)).toEqual([conn(2).id]);
});

test('the file is 0600 and never holds a password', () => {
  const s = createDbStore(home);
  s.put(conn(1));
  expect(() => s.put({ ...conn(2), password: 'hunter2' } as unknown as DbConnection)).toThrow();
  expectMode(file(), 0o600);
  expect(readFileSync(file(), 'utf8')).not.toMatch(/password|hunter2/);
  expect(s.list()).toHaveLength(1);
});

test('an invalid entry on disk is dropped, the others load; junk keys are ignored', () => {
  writeFileSync(file(), JSON.stringify({ version: 1, junk: 1, connections: [conn(1), conn(2, { port: 0 }), 'x', conn(3)], picks: {} }));
  expect(createDbStore(home).list().map((c) => c.id)).toEqual([conn(1).id, conn(3).id]);
});

test('another version, or a corrupt file, loads empty', () => {
  writeFileSync(file(), JSON.stringify({ version: 2, connections: [conn(1)] }));
  expect(createDbStore(home).list()).toEqual([]);
  writeFileSync(file(), '{nope');
  expect(createDbStore(home).list()).toEqual([]);
});

test('picks per project root', () => {
  const s = createDbStore(home);
  s.put(conn(1)); s.put(conn(2));
  expect(s.pick('/p/a')).toBeNull();
  s.setPick('/p/a', conn(1).id); s.setPick('/p/b', conn(2).id);
  expect(createDbStore(home).pick('/p/a')).toBe(conn(1).id);
  s.setPick('/p/a', null);
  expect(createDbStore(home).pick('/p/a')).toBeNull();
  expect(createDbStore(home).pick('/p/b')).toBe(conn(2).id);
  s.setPick('relative', conn(1).id);
  s.setPick('/p/c', 'nope');
  expect(s.pick('relative')).toBeNull();
  expect(s.pick('/p/c')).toBeNull();
});

test('removing a connection drops the picks that point at it', () => {
  const s = createDbStore(home);
  s.put(conn(1)); s.setPick('/p/a', conn(1).id); s.remove(conn(1).id);
  expect(s.pick('/p/a')).toBeNull();
  expect(createDbStore(home).pick('/p/a')).toBeNull();
});

test('the 65th connection throws; replacing at the limit works', () => {
  const s = createDbStore(home);
  for (let i = 1; i <= 64; i++) s.put(conn(i));
  expect(() => s.put(conn(65))).toThrow();
  expect(() => s.put(conn(7, { name: 'again' }))).not.toThrow();
  expect(s.list()).toHaveLength(64);
});

test('put refuses an invalid connection', () => {
  expect(() => createDbStore(home).put(conn(1, { port: 0 }))).toThrow();
});

test('a failed write keeps the memory', () => {
  const s = createDbStore(join(home, 'missing', 'dir'));
  s.put(conn(1));
  expect(s.list()).toHaveLength(1);
});

test('secretIdOf matches the secret store id rule', () => {
  expect(secretIdOf(conn(1).id)).toBe('db-c000000000001');
  expect(secretIdOf(conn(1).id)).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
});

const bad: [string, Partial<DbConnection>][] = [
  ['empty user', { user: '' }], ['empty database', { database: '' }], ['empty host', { host: '' }],
  ['relative socket', { socket: 'tmp/s' }], ['empty socket', { socket: '' }], ['port 0', { port: 0 }],
  ['port 65536', { port: 65536 }], ['fractional port', { port: 5432.5 }], ['long name', { name: 'x'.repeat(121) }],
  ['long host', { host: 'h'.repeat(256) }], ['long database', { database: 'd'.repeat(129) }], ['long user', { user: 'u'.repeat(129) }],
  ['relative scope root', { scope: { kind: 'project', root: 'rel' } }], ['ssh empty host', { ssh: { host: '', port: 22, user: 'u' } }],
  ['ssh port 0', { ssh: { host: 'h', port: 0, user: 'u' } }], ['ssh port missing', { ssh: { host: 'h', user: 'u' } as never }],
  ['long schema', { schema: 's'.repeat(129) }], ['bad id', { id: 'c123' }], ['empty name', { name: '' }]
];
test.each(bad)('schema rejects %s', (_n, over) => {
  expect(dbConnectionSchema.safeParse(conn(1, over)).success).toBe(false);
});

// An SSH host or user ssh would read as an option (`-oProxyCommand=…`), or with whitespace or control
// characters in it, never reaches the file (nor the IPC, which builds its form from the same fields).
const sshUnsafe = ['-oProxyCommand=touch /tmp/x', '-v', 'a b', 'a\tb', 'a\nb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a b'];
test.each(sshUnsafe)('schema rejects the SSH host or user %j', (v) => {
  expect(dbConnectionSchema.safeParse(conn(1, { ssh: { host: v, port: 22, user: 'u' } })).success).toBe(false);
  expect(dbConnectionSchema.safeParse(conn(1, { ssh: { host: 'bastion', port: 22, user: v } })).success).toBe(false);
});

test('schema accepts dashes inside SSH names, and rejects ssh with a socket (a tunnel forwards TCP)', () => {
  expect(dbConnectionSchema.safeParse(conn(1, { ssh: { host: 'bastion-1.example.com', port: 22, user: 'deploy-bot' } })).success).toBe(true);
  expect(dbConnectionSchema.safeParse(conn(1, { ssh: { host: 'b', port: 22, user: 'u' }, socket: '/tmp' })).success).toBe(false);
  expect(dbConnectionSchema.safeParse(conn(1, { ssh: { host: 'b', port: 22, user: 'u' }, socket: '/tmp', host: '' })).success).toBe(false);
});

// With ssh on, the SSH host and the database host are host names or IP literals, the user [A-Za-z0-9._-].
const notAHost = ['me@bastion', 'a;b', '$(x)', '`x`', "a'b", 'a"b', '${HOME}', 'a/b', 'a\\b', 'bastion:22', 'fe80::1%', ''];
test.each(notAHost)('with ssh, schema rejects %j as the SSH host and as the database host', (h) => {
  const via = { host: 'bastion', port: 22, user: 'u' };
  expect(dbConnectionSchema.safeParse(conn(1, { ssh: { ...via, host: h } })).success).toBe(false);
  expect(dbConnectionSchema.safeParse(conn(1, { ssh: via, host: h })).success).toBe(false);
});
test.each(['me@x', 'a;b', '$(x)', '`x`', "a'b", '${HOME}', 'a/b', 'a\\b', 'a:b'])('with ssh, schema rejects the SSH user %j', (u) => {
  expect(dbConnectionSchema.safeParse(conn(1, { ssh: { host: 'bastion', port: 22, user: u } })).success).toBe(false);
});
test('without ssh, the database host keeps its own rule; with ssh, names and IP literals pass', () => {
  expect(dbConnectionSchema.safeParse(conn(1, { host: 'db primary' })).success).toBe(true);
  expect(dbConnectionSchema.safeParse(conn(1, { host: 'db primary', ssh: { host: 'bastion', port: 22, user: 'u' } })).success).toBe(false);
  // '_' passes in both hosts (a ~/.ssh/config alias, a compose service behind the bastion).
  expect(dbConnectionSchema.safeParse(conn(1, { host: 'postgres_db', ssh: { host: 'prod_bastion', port: null, user: '' } })).success).toBe(true);
  expect(dbConnectionSchema.safeParse(conn(1, { host: '_db', ssh: { host: '_bastion', port: 22, user: 'u' } })).success).toBe(true);
  for (const h of ['db-1.internal', '10.0.0.5', '::1', 'fe80::1%en0']) {
    expect(dbConnectionSchema.safeParse(conn(1, { host: h, ssh: { host: h, port: 22, user: 'first.last_2' } })).success, h).toBe(true);
  }
});

// SSH port and user are optional (null, ''): ~/.ssh/config decides, so a host alias works.
test('schema accepts an SSH port of null and an empty SSH user', () => {
  for (const ssh of [{ host: 'prod-bastion', port: null, user: '' }, { host: 'prod-bastion', port: null, user: 'me' }, { host: 'prod-bastion', port: 2222, user: '' }]) {
    expect(dbConnectionSchema.safeParse(conn(1, { ssh })).success, JSON.stringify(ssh)).toBe(true);
  }
});

test('schema accepts a socket connection without a host, and ssh', () => {
  expect(dbConnectionSchema.safeParse(conn(1, { host: '', socket: '/tmp/.s.PGSQL.5432' })).success).toBe(true);
  expect(dbConnectionSchema.safeParse(conn(1, { ssh: { host: 'b', port: 22, user: 'u' }, schema: 'public', scope: { kind: 'project', root: '/p' } })).success).toBe(true);
  expect(dbConnectionSchema.safeParse({ ...conn(1), extra: 1 }).success).toBe(false);
});

const bads = () => readdirSync(home).filter((n) => n.startsWith('databases.json.bad-'));
const quiet = () => { const logs: string[] = []; return { logs, log: (m: string) => logs.push(m) }; };

test('a version 2 file is kept aside, byte for byte, before the first save', () => {
  const raw = JSON.stringify({ version: 2, connections: [conn(1)], newer: true });
  writeFileSync(file(), raw);
  const q = quiet(); const s = createDbStore(home, q.log);
  expect(s.list()).toEqual([]);
  expect(bads()).toEqual([]);
  s.put(conn(2));
  expect(bads()).toHaveLength(1);
  expect(readFileSync(join(home, bads()[0]!), 'utf8')).toBe(raw);
  expect(createDbStore(home).list().map((c) => c.id)).toEqual([conn(2).id]);
  s.put(conn(3));
  expect(bads()).toHaveLength(1);
  expect(q.logs).toHaveLength(1);
});

test('a corrupt file is kept aside before the first save', () => {
  writeFileSync(file(), '{nope');
  const s = createDbStore(home, quiet().log);
  s.put(conn(1));
  expect(bads()).toHaveLength(1);
  expect(readFileSync(join(home, bads()[0]!), 'utf8')).toBe('{nope');
});

test('dropped entries: the valid ones load, the original is kept aside, the count is logged', () => {
  const raw = JSON.stringify({ version: 1, connections: [conn(1), conn(2, { port: 0 }), conn(3)], picks: {} });
  writeFileSync(file(), raw);
  const q = quiet(); const s = createDbStore(home, q.log);
  expect(s.list().map((c) => c.id)).toEqual([conn(1).id, conn(3).id]);
  s.put(conn(4));
  expect(readFileSync(join(home, bads()[0]!), 'utf8')).toBe(raw);
  expect(q.logs).toHaveLength(1);
  expect(q.logs[0]).toContain('1');
});

test('a clean file is never set aside', () => {
  const s = createDbStore(home, quiet().log);
  s.put(conn(1)); s.setPick('/p/a', conn(1).id);
  const s2 = createDbStore(home, quiet().log);
  s2.put(conn(2)); s2.remove(conn(2).id);
  expect(bads()).toEqual([]);
});

test('a file over 2 MB is unusable and kept aside', () => {
  const raw = JSON.stringify({ version: 1, connections: [conn(1)], pad: 'x'.repeat(2 * 1024 * 1024) });
  writeFileSync(file(), raw);
  const s = createDbStore(home, quiet().log);
  expect(s.list()).toEqual([]);
  s.put(conn(2));
  expect(bads()).toHaveLength(1);
});

test('pick uses own properties only', () => {
  const s = createDbStore(home);
  expect(s.pick('constructor')).toBeNull();
  expect(s.pick('__proto__')).toBeNull();
  expect(s.pick('toString')).toBeNull();
});

test('pick is null once the picked connection is gone', () => {
  writeFileSync(file(), JSON.stringify({ version: 1, connections: [conn(1)], picks: { '/p/a': conn(1).id, '/p/b': conn(2).id } }));
  const s = createDbStore(home);
  expect(s.pick('/p/a')).toBe(conn(1).id);
  expect(s.pick('/p/b')).toBeNull();
});

test.each(['name', 'host', 'user', 'database', 'schema'] as const)('control characters are refused in %s', (k) => {
  for (const ch of ['\u0000', '\n', '\u007f']) expect(dbConnectionSchema.safeParse(conn(1, { [k]: `a${ch}b` })).success).toBe(false);
});

test('load caps: 64 connections and 500 picks; duplicate ids collapse', () => {
  const many = Array.from({ length: 70 }, (_, i) => conn(i + 1));
  const picks = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`/p/${i}`, conn(1).id]));
  writeFileSync(file(), JSON.stringify({ version: 1, connections: [...many, conn(1)], picks }));
  const s = createDbStore(home, quiet().log);
  expect(s.list()).toHaveLength(64);
  expect(s.pick('/p/0')).toBe(conn(1).id);
  expect(s.pick('/p/499')).toBe(conn(1).id);
  expect(s.pick('/p/500')).toBeNull();
  writeFileSync(file(), JSON.stringify({ version: 1, connections: [conn(1), conn(1, { name: 'dup' })] }));
  const d = createDbStore(home, quiet().log);
  expect(d.list().map((c) => c.name)).toEqual(['db 1']);
});

test('the mode stays 0600 after a rewrite', () => {
  const s = createDbStore(home);
  s.put(conn(1));
  chmodSync(file(), 0o644);
  s.put(conn(2));
  expectMode(file(), 0o600);
});

test('list returns a copy', () => {
  const s = createDbStore(home);
  s.put(conn(1));
  s.list().pop();
  expect(s.list()).toHaveLength(1);
});

// A read-only folder (mode bits): NTFS ignores them, the write would succeed there.
posixTest('a failed write leaves the previous file intact', () => {
  const s = createDbStore(home, quiet().log);
  s.put(conn(1));
  const before = readFileSync(file(), 'utf8');
  chmodSync(home, 0o500);
  try { s.put(conn(2)); } finally { chmodSync(home, 0o700); }
  expect(readFileSync(file(), 'utf8')).toBe(before);
  expect(s.list()).toHaveLength(2);
});

test('when the rename aside fails nothing is overwritten; the next save retries', () => {
  const raw = JSON.stringify({ version: 2, connections: [conn(1)] });
  writeFileSync(file(), raw);
  let fail = true;
  const q = quiet();
  const s = createDbStore(home, q.log, (from, to) => { if (fail) throw new Error('EPERM'); renameSync(from, to); });
  s.put(conn(2));
  expect(readFileSync(file(), 'utf8')).toBe(raw);
  expect(s.list().map((c) => c.id)).toEqual([conn(2).id]);
  expect(q.logs.some((m) => m.includes('EPERM'))).toBe(true);
  fail = false;
  s.put(conn(3));
  expect(readFileSync(join(home, bads()[0]!), 'utf8')).toBe(raw);
  expect(createDbStore(home).list().map((c) => c.id)).toEqual([conn(2).id, conn(3).id]);
});

test('a rename aside that keeps failing is said once, not on every save', () => {
  writeFileSync(file(), '{nope');
  const q = quiet();
  const s = createDbStore(home, q.log, () => { throw new Error('EPERM'); });
  for (let n = 1; n <= 4; n++) s.put(conn(n));
  expect(q.logs.filter((m) => m.includes('could not be set aside'))).toHaveLength(1);
  expect(readFileSync(file(), 'utf8')).toBe('{nope');
});

// A folder the process may not search (mode bits): its file can't even be looked at. NTFS ignores them.
posixTest('a file that can\'t be looked at (EACCES) is still kept aside once it can, never written over', () => {
  writeFileSync(file(), '{nope');
  const s = createDbStore(home, quiet().log);
  expect(s.list()).toEqual([]);
  chmodSync(home, 0o000);
  try { s.put(conn(1)); } finally { chmodSync(home, 0o700); }
  expect(readFileSync(file(), 'utf8')).toBe('{nope');
  s.put(conn(2));
  expect(bads()).toHaveLength(1);
  expect(readFileSync(join(home, bads()[0]!), 'utf8')).toBe('{nope');
  expect(createDbStore(home).list().map((c) => c.id)).toEqual([conn(1).id, conn(2).id]);
});

test('the aside name never collides', () => {
  writeFileSync(file(), '{nope');
  const now = Date.now();
  const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    writeFileSync(`${file()}.bad-${now}`, 'older');
    createDbStore(home, quiet().log).put(conn(1));
    expect(readFileSync(`${file()}.bad-${now}`, 'utf8')).toBe('older');
    expect(readFileSync(`${file()}.bad-${now}-1`, 'utf8')).toBe('{nope');
  } finally { spy.mockRestore(); }
});
