import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { posixRel } from '../support/platform';
import { READ_COMMANDS, WRITE_COMMANDS } from '../../src/main/redis/commands';
import { QUEUE_SCRIPTS } from '../../src/main/redis/queue-scripts';

// Atelier writes to Redis only through the write path, only what the tables allow, only to local
// servers, and only the fixed queue scripts:
// - the read and write tables are exactly these (a new command is a test edit, made on purpose);
// - unsafeWrite / unsafeWritePipeline are called only by src/main/redis/writes.ts;
// - only client.ts opens connections to Redis (node:net elsewhere: the daemon socket and the OAuth loopback, listed);
// - client.ts names no host but the loopback constants;
// - Lua (`redis.call`) is spelled only in queue-scripts.ts, and its scripts are exactly the five known ones;
// - write command names (upper case, as commands are written) appear as string literals under src/main/ only in
//   commands.ts, writes.ts and queue-scripts.ts.
const root = join(__dirname, '..', '..');
const CLIENT = 'src/main/redis/client.ts';
const WRITES = 'src/main/redis/writes.ts';
const SCRIPTS = 'src/main/redis/queue-scripts.ts';
const COMMANDS = 'src/main/redis/commands.ts';
/** node:net users other than the Redis client, with why. */
const NET_ALLOWED = new Map([
  ['src/daemon/main.ts', 'atelierd listens on its Unix socket'],
  ['src/daemon/server.ts', 'atelierd serves its Unix socket'],
  ['src/main/daemon-client.ts', 'the app talks to atelierd over its Unix socket'],
  ['src/main/daemon-launcher.ts', 'probes the atelierd socket before starting it'],
  ['src/main/connectors/oauth/loopback.ts', 'the OAuth loopback listener (listens only)'],
  ['src/main/git/trace2.ts', 'listens on a private Unix socket per git write op for its trace2 events (listens only)'],
  ['src/daemon/pty-host-server.ts', 'atelierd serves the terminals\' launchd hosts on a private Unix socket (session coalitions)'],
  ['src/daemon/pty-host-entry.ts', 'pty-host.js fetches its launch from atelierd\'s host socket'],
  ['src/daemon/pty-host-main.ts', 'pty-host.js connects to atelierd\'s host socket'],
  ['src/main/databases/ssh-tunnel.ts', 'the SSH tunnel: a free-port bind and the ready probe, 127.0.0.1 only']
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}
type Source = { path: string; text: string };
const all = (): Source[] => sources(join(root, 'src')).map((p) => ({ path: posixRel(root, p), text: readFileSync(p, 'utf8') }));

const WRITE_NAMES = Object.keys(WRITE_COMMANDS);
const literal = (name: string) => new RegExp(`['"\`]${name.replace('.', '\\.')}['"\`]`);

const rules = {
  unsafeCallers: (files: Source[]) => files.filter((f) => f.path !== CLIENT && f.path !== WRITES && /\.unsafeWrite(Pipeline)?\s*\(/.test(f.text)).map((f) => f.path),
  netImports: (files: Source[]) => files.filter((f) => f.path !== CLIENT && !NET_ALLOWED.has(f.path) && /from\s+['"](node:)?net['"]|require\(\s*['"](node:)?net['"]\s*\)/.test(f.text)).map((f) => f.path),
  hosts: (files: Source[]) => files.filter((f) => f.path === CLIENT && (/['"`](localhost|0\.0\.0\.0)['"`]|host:\s*['"`](?!127\.0\.0\.1|::1)/.test(f.text))).map((f) => f.path),
  lua: (files: Source[]) => files.filter((f) => f.path !== SCRIPTS && /redis\.call\s*\(|\bredis\.pcall\s*\(/.test(f.text)).map((f) => f.path),
  writeLiterals: (files: Source[]) => files.filter((f) => f.path.startsWith('src/main/') && ![COMMANDS, WRITES, SCRIPTS].includes(f.path)).flatMap((f) =>
    WRITE_NAMES.filter((n) => literal(n).test(f.text)).map((n) => `${f.path}: ${n}`))
};

describe('Redis writes stay where they belong', () => {
  test('the command tables are exactly these', () => {
    expect(Object.keys(READ_COMMANDS).sort()).toEqual([
      'ACL', 'AUTH', 'CLIENT', 'CONFIG', 'DBSIZE', 'DUMP', 'EXISTS', 'GET', 'GETRANGE', 'HGET', 'HGETALL', 'HLEN', 'HMGET', 'HSCAN', 'INFO',
      'JSON.GET', 'JSON.TYPE', 'LINDEX', 'LLEN', 'LRANGE', 'MEMORY', 'MONITOR', 'OBJECT', 'PING', 'PTTL', 'SCAN', 'SCARD', 'SELECT', 'SLOWLOG',
      'SMEMBERS', 'SSCAN', 'STRLEN', 'TIME', 'TTL', 'TYPE', 'VCARD', 'VDIM', 'VINFO', 'XINFO', 'XLEN', 'XRANGE', 'XREVRANGE', 'ZCARD', 'ZCOUNT',
      'ZRANGE', 'ZRANGEBYSCORE', 'ZREVRANGE', 'ZSCORE'
    ]);
    expect({ MEMORY: READ_COMMANDS.MEMORY, OBJECT: READ_COMMANDS.OBJECT, CLIENT: READ_COMMANDS.CLIENT, SLOWLOG: READ_COMMANDS.SLOWLOG, CONFIG: READ_COMMANDS.CONFIG, XINFO: READ_COMMANDS.XINFO, ACL: READ_COMMANDS.ACL })
      .toEqual({ MEMORY: ['USAGE'], OBJECT: ['ENCODING', 'IDLETIME', 'FREQ'], CLIENT: ['LIST', 'SETNAME'], SLOWLOG: ['GET', 'LEN'], CONFIG: ['GET'], XINFO: ['GROUPS'], ACL: ['WHOAMI'] });
    expect([...WRITE_NAMES].sort()).toEqual(['DEL', 'EVAL', 'EVALSHA', 'EXPIRE', 'FLUSHDB', 'HSET', 'JSON.SET', 'LPUSH', 'LREM', 'LSET', 'PERSIST', 'PEXPIRE', 'RESTORE', 'SADD', 'SET', 'UNLINK', 'ZADD', 'ZREM']);
    expect(WRITE_COMMANDS.FLUSHDB).toEqual(['ASYNC']);
    expect(Object.keys(QUEUE_SCRIPTS).sort()).toEqual(['bullmqRemove', 'bullmqRetry', 'bullmqUnretry', 'sidekiqRetry', 'sidekiqUnretry']);
  });
  test('only writes.ts uses the write path', () => { expect(rules.unsafeCallers(all())).toEqual([]); });
  test('only client.ts (and the listed socket users) import node:net', () => { expect(rules.netImports(all())).toEqual([]); });
  test('client.ts names no host but loopback', () => {
    expect(rules.hosts(all())).toEqual([]);
    expect(readFileSync(join(root, CLIENT), 'utf8')).toContain("export const LOOPBACK = ['127.0.0.1', '::1'] as const;");
  });
  test('Lua only in queue-scripts.ts', () => { expect(rules.lua(all())).toEqual([]); });
  test('write commands are spelled only by the write path', () => { expect(rules.writeLiterals(all())).toEqual([]); });

  test('the rules catch what they guard against', () => {
    const bad: Source[] = [
      { path: 'src/main/redis/hub.ts', text: "await c.unsafeWrite(['FLUSHDB', 'ASYNC']); const x = 'UNLINK';" },
      { path: 'src/main/other.ts', text: "import { connect } from 'node:net'; redis.call('DEL', k)" },
      { path: CLIENT, text: "createConnection({ host: 'localhost', port })" }
    ];
    expect(rules.unsafeCallers(bad)).toEqual(['src/main/redis/hub.ts']);
    expect(rules.netImports(bad)).toEqual(['src/main/other.ts']);
    expect(rules.hosts(bad)).toEqual([CLIENT]);
    expect(rules.lua(bad)).toEqual(['src/main/other.ts']);
    expect(rules.writeLiterals(bad)).toEqual(['src/main/redis/hub.ts: UNLINK', 'src/main/redis/hub.ts: FLUSHDB', 'src/main/other.ts: DEL']);
  });
});
