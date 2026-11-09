import { describe, expect, test } from 'vitest';
import { trimMonitorLine, cacheOnlyRatio, classifyCommand, clientDisplayName, displayArgs, markMisses, parseClientList, parseMonitorLine, type MonitorLine } from './redis-monitor';

describe('MONITOR lines', () => {
  test('parse: time, db, address, command and quoted arguments with escapes', () => {
    expect(parseMonitorLine('1697371396.123456 [0 127.0.0.1:61366] "GET" "cache:products:page:1"')).toEqual({ at: 1697371396123, db: 0, addr: '127.0.0.1:61366', cmd: 'GET', args: ['cache:products:page:1'] });
    expect(parseMonitorLine('1697371396.5 [2 lua] "set" "a\\"b" "x\\ny\\x00\\\\"')).toEqual({ at: 1697371396500, db: 2, addr: 'lua', cmd: 'SET', args: ['a"b', 'x\ny\u0000\\'] });
    expect(parseMonitorLine('1697371396.5 [0 unix:/tmp/redis.sock] "PING"')).toMatchObject({ addr: 'unix:/tmp/redis.sock', cmd: 'PING', args: [] });
    expect(parseMonitorLine('OK')).toBeNull();
  });
  test('classify: read, write, delete, script, other', () => {
    expect(['GET', 'HGETALL', 'XRANGE', 'SCAN'].map(classifyCommand)).toEqual(['read', 'read', 'read', 'read']);
    expect(['SET', 'INCR', 'EXPIRE', 'ZINCRBY', 'BLMOVE', 'XADD'].map(classifyCommand)).toEqual(['write', 'write', 'write', 'write', 'write', 'write']);
    expect(['DEL', 'UNLINK', 'HDEL', 'FLUSHDB'].map(classifyCommand)).toEqual(['del', 'del', 'del', 'del']);
    expect(['EVALSHA', 'EVAL', 'FCALL'].map(classifyCommand)).toEqual(['script', 'script', 'script']);
    expect(['PING', 'INFO', 'CLIENT', 'MULTI'].map(classifyCommand)).toEqual(['other', 'other', 'other', 'other']);
  });
  test('displayArgs: scripts summarized, long values cut, secret values masked', () => {
    expect(displayArgs('EVALSHA', ['3f2a', '3', 'bull:email-queue:wait', 'bull:email-queue:active', 'bull:email-queue:events', 'x'])).toBe('script · bull:email-queue · 3 keys');
    expect(displayArgs('SET', ['cache:x', 'y'.repeat(200)])).toBe(`cache:x ${'y'.repeat(119)}…`);
    expect(displayArgs('HSET', ['sess:1', 'csrf', 'abc', 'locale', 'it'])).toBe('sess:1 csrf •••• locale it');
    expect(displayArgs('SET', ['api:token', 'ghp_x'])).toBe('api:token ••••');
  });
  test('misses: a GET followed within 2 s by a SET of the same key from the same client', () => {
    const L = (at: number, addr: string, cmd: string, ...args: string[]): MonitorLine => ({ at, db: 0, addr, cmd, args });
    const lines = [L(0, 'a', 'GET', 'k1'), L(100, 'a', 'SET', 'k1', 'v'), L(200, 'b', 'GET', 'k2'), L(300, 'a', 'SET', 'k2', 'v'), L(400, 'a', 'GET', 'k3'), L(3000, 'a', 'SET', 'k3', 'v'), L(3100, 'a', 'GET', 'k1')];
    expect([...markMisses(lines)]).toEqual([0]);
  });
  test('cacheOnlyRatio: GETs on non-queue keys in the window; null under 20 reads', () => {
    const now = 1_000_000;
    const lines: MonitorLine[] = [];
    for (let i = 0; i < 20; i++) lines.push({ at: now - 1000 - i, db: 0, addr: 'a', cmd: 'GET', args: [`cache:${i}`] });
    lines.push({ at: now - 900, db: 0, addr: 'a', cmd: 'SET', args: ['cache:0', 'v'] });
    lines.push({ at: now - 800, db: 0, addr: 'w', cmd: 'GET', args: ['bull:q:1'] });
    lines.sort((a, b) => a.at - b.at);
    expect(cacheOnlyRatio(lines, now, (k) => k.startsWith('bull:'))).toBeCloseTo(19 / 20);
    expect(cacheOnlyRatio(lines.slice(0, 5), now, () => false)).toBeNull();
  });
});

describe('trimMonitorLine', () => {
  test('at most 16 arguments of 200 characters each reach the window', () => {
    const l = trimMonitorLine({ at: 1, db: 0, addr: 'a', cmd: 'SET', args: ['k', 'v'.repeat(5000), ...Array.from({ length: 30 }, (_, i) => String(i))] });
    expect(l.args).toHaveLength(16);
    expect(l.args[1]!.length).toBe(200);
    expect(l.args[1]!.endsWith('…')).toBe(true);
    expect(l.args[0]).toBe('k');
  });
});

describe('CLIENT LIST', () => {
  test('parse every client, names decoded for BullMQ workers', () => {
    const text = 'id=3 addr=127.0.0.1:51234 laddr=127.0.0.1:6379 fd=8 name=atelier age=12 idle=0 flags=N db=0 cmd=client|list user=default lib-name=\n' +
      'id=4 addr=192.168.65.1:61366 laddr=172.17.0.2:6379 fd=9 name=bull:ZW1haWwtcXVldWU= age=40 idle=2 flags=b db=0 cmd=bzpopmin user=default lib-name=ioredis\n';
    const list = parseClientList(text);
    expect(list.map((c) => [c.id, c.addr, c.name, c.idle, c.db, c.cmd, c.lib])).toEqual([[3, '127.0.0.1:51234', 'atelier', 0, 0, 'client|list', ''], [4, '192.168.65.1:61366', 'bull:ZW1haWwtcXVldWU=', 2, 0, 'bzpopmin', 'ioredis']]);
    expect(clientDisplayName('bull:ZW1haWwtcXVldWU=')).toBe('bull:email-queue');
    expect(clientDisplayName('bull:ZW1haWwtcXVldWU=:w:mailer')).toBe('bull:email-queue · mailer');
    expect(clientDisplayName('')).toBe('unnamed');
    expect(clientDisplayName('api')).toBe('api');
  });
});
