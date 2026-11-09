// What Atelier may send to Redis: one table of reads and one of writes, each with the subcommands
// allowed. The client checks every command against them before a byte is written; writes only through the write path
// (writes.ts), scripts only the fixed queue scripts. tests/integration/redis-readonly.test.ts keeps the tables exact.
import { SCRIPT_SHAS, scriptSha } from './queue-scripts';
import type { Arg } from './resp';

/** Command → allowed subcommands (null: any arguments). */
export const READ_COMMANDS: Readonly<Record<string, readonly string[] | null>> = {
  PING: null, AUTH: null, SELECT: null, INFO: null, DBSIZE: null, TIME: null, SCAN: null, TYPE: null, PTTL: null, TTL: null,
  EXISTS: null, STRLEN: null, GET: null, GETRANGE: null, HLEN: null, HSCAN: null, HGET: null, HMGET: null, HGETALL: null,
  LLEN: null, LRANGE: null, LINDEX: null, SCARD: null, SSCAN: null, SMEMBERS: null, ZCARD: null, ZRANGE: null,
  ZREVRANGE: null, ZRANGEBYSCORE: null, ZSCORE: null, ZCOUNT: null, XLEN: null, XRANGE: null, XREVRANGE: null,
  MONITOR: null, DUMP: null, 'JSON.GET': null, 'JSON.TYPE': null, VCARD: null, VDIM: null, VINFO: null,
  MEMORY: ['USAGE'], OBJECT: ['ENCODING', 'IDLETIME', 'FREQ'], CLIENT: ['LIST', 'SETNAME'], SLOWLOG: ['GET', 'LEN'],
  CONFIG: ['GET'], XINFO: ['GROUPS'], ACL: ['WHOAMI']
};

export const WRITE_COMMANDS: Readonly<Record<string, readonly string[] | null>> = {
  UNLINK: null, DEL: null, EXPIRE: null, PEXPIRE: null, PERSIST: null, SET: null, HSET: null, LSET: null, ZADD: null,
  ZREM: null, LPUSH: null, LREM: null, SADD: null, RESTORE: null, 'JSON.SET': null, FLUSHDB: ['ASYNC'],
  EVAL: null, EVALSHA: null
};

const name = (a: Arg | undefined) => (a === undefined ? '' : String(a).toUpperCase());

function inTable(table: Readonly<Record<string, readonly string[] | null>>, args: readonly Arg[]): boolean {
  const cmd = name(args[0]);
  if (!Object.hasOwn(table, cmd)) return false;
  const subs = table[cmd];
  return subs === null || subs === undefined || subs.includes(name(args[1]));
}

function allowedScript(args: readonly Arg[]): boolean {
  const cmd = name(args[0]);
  if (cmd !== 'EVAL' && cmd !== 'EVALSHA') return true;
  const s = args[1];
  if (s === undefined) return false;
  const sha = cmd === 'EVAL' ? scriptSha(Buffer.isBuffer(s) ? s.toString('utf8') : String(s)) : String(s).toLowerCase();
  return SCRIPT_SHAS.has(sha);
}

export function assertRead(args: readonly Arg[]): void {
  if (!inTable(READ_COMMANDS, args)) throw new Error(`redis command not allowed: ${name(args[0])}`);
}

/** The write path may also read (DUMP before a delete, SCAN for a pattern). */
export function assertWrite(args: readonly Arg[]): void {
  if (inTable(READ_COMMANDS, args)) return;
  if (!inTable(WRITE_COMMANDS, args) || !allowedScript(args)) throw new Error(`redis command not allowed: ${name(args[0])}`);
}

export function commandKind(cmd: string): 'read' | 'write' | 'unknown' {
  const c = cmd.toUpperCase();
  return Object.hasOwn(READ_COMMANDS, c) ? 'read' : Object.hasOwn(WRITE_COMMANDS, c) ? 'write' : 'unknown';
}
