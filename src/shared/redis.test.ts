import { describe, expect, test } from 'vitest';
import {
  cliCommand, displayKey, endpointKey, fmtBytes, fmtTtl, fmtTtlLong, fmtUptime, frameworkPrefix, groupNamespaces, hints, infoOf, keyFromWire,
  maskEmails, maskField, namespaceOf, normalizeCustom, parseEnvFile, parseInfo, parseRedisUrl, redisFromEnv, isRedisImage, keyPrompt, NO_NAMESPACE,
  globOf, shortCount, keyToWire
} from './redis';

describe('.env and URLs', () => {
  test('parseEnvFile: export, quotes, comments, inline comments', () => {
    expect(parseEnvFile('# c\nexport REDIS_URL="redis://:p%40ss@127.0.0.1:6380/2"\nREDIS_HOST=localhost # local\nEMPTY=\nQ=\'a b\'\n')).toEqual({
      REDIS_URL: 'redis://:p%40ss@127.0.0.1:6380/2', REDIS_HOST: 'localhost', EMPTY: '', Q: 'a b'
    });
  });
  test('parseRedisUrl: user, password (decoded), db, tls, unix, defaults', () => {
    expect(parseRedisUrl('redis://:p%40ss@127.0.0.1:6380/2')).toEqual({ kind: 'tcp', host: '127.0.0.1', port: 6380, password: 'p@ss', db: 2, tls: false });
    expect(parseRedisUrl('rediss://app:x@localhost')).toEqual({ kind: 'tcp', host: 'localhost', port: 6379, user: 'app', password: 'x', db: 0, tls: true });
    expect(parseRedisUrl('unix:///tmp/redis.sock')).toEqual({ kind: 'unix', path: '/tmp/redis.sock', db: 0, tls: false });
    expect(parseRedisUrl('/var/run/redis.sock')).toEqual({ kind: 'unix', path: '/var/run/redis.sock', db: 0, tls: false });
    expect(parseRedisUrl('http://x')).toBeNull();
    expect(parseRedisUrl('redis://h:99999')).toBeNull();
  });
  test('redisFromEnv: URL vars and Laravel host/port vars, the variable named', () => {
    const got = redisFromEnv({ REDIS_URL: 'redis://127.0.0.1:6379/1', CELERY_BROKER_URL: 'redis://localhost:6380/0', REDIS_HOST: 'redis', REDIS_PORT: '6381', REDIS_PASSWORD: 'pw', REDIS_PREFIX: 'shop_database_', DATABASE_URL: 'postgres://x' });
    expect(got.map((c) => [c.var, c.host, c.port, c.db, c.password ?? null])).toEqual([
      ['REDIS_URL', '127.0.0.1', 6379, 1, null],
      ['CELERY_BROKER_URL', 'localhost', 6380, 0, null],
      ['REDIS_HOST', 'redis', 6381, 0, 'pw']
    ]);
    expect(got[2]!.prefix).toBe('shop_database_');
  });
  test('normalizeCustom: loopback URLs and absolute sockets, passwordless; anything else refused', () => {
    expect(normalizeCustom('redis://:secret@127.0.0.1:6390/3')).toBe('redis://127.0.0.1:6390/3');
    expect(normalizeCustom('redis://localhost:6390')).toBe('redis://127.0.0.1:6390');
    expect(normalizeCustom('/tmp/redis.sock')).toBe('/tmp/redis.sock');
    expect(normalizeCustom('unix:///tmp/r.sock')).toBe('/tmp/r.sock');
    expect(normalizeCustom('redis://10.0.0.5:6379')).toBeNull();
    expect(normalizeCustom('rediss://127.0.0.1:6379')).toBeNull();
    expect(normalizeCustom('tmp/redis.sock')).toBeNull();
  });
  test('endpointKey', () => {
    expect(endpointKey({ kind: 'tcp', port: 6379 })).toBe('tcp:6379');
    expect(endpointKey({ kind: 'unix', path: '/tmp/r.sock' })).toBe('unix:/tmp/r.sock');
  });
  test('isRedisImage', () => {
    for (const i of ['redis:7', 'redis', 'valkey/valkey:8.1', 'redis/redis-stack-server:latest', 'eqalpha/keydb', 'docker.dragonflydb.io/dragonflydb/dragonfly', 'bitnami/redis:7.2', 'library/redis:alpine']) expect(isRedisImage(i), i).toBe(true);
    for (const i of ['postgres:16', 'redis-commander', 'rediscommander/redis-commander', 'myredisapp']) expect(isRedisImage(i), i).toBe(false);
  });
});

describe('INFO', () => {
  const text = '# Server\r\nredis_version:8.4.0\r\nredis_mode:standalone\r\nuptime_in_seconds:316707\r\nexecutable:/opt/homebrew/opt/redis/bin/redis-server\r\n# Memory\r\nused_memory:2642344\r\nused_memory_peak:4299161\r\nmaxmemory:0\r\nmaxmemory_policy:noeviction\r\n# Stats\r\ninstantaneous_ops_per_sec:41\r\nkeyspace_hits:178651\r\nkeyspace_misses:380817\r\nexpired_keys:25309\r\nevicted_keys:0\r\n# Persistence\r\nrdb_last_save_time:1792018783\r\nrdb_changes_since_last_save:0\r\nrdb_last_bgsave_status:ok\r\naof_enabled:0\r\n# Clients\r\nconnected_clients:7\r\n# Keyspace\r\ndb0:keys=1284,expires=1071,avg_ttl=0\r\ndb1:keys=12,expires=0,avg_ttl=0\r\n';
  test('parseInfo + infoOf', () => {
    const i = infoOf(parseInfo(text));
    expect(i).toMatchObject({ name: 'redis', version: '8.4.0', mode: 'standalone', uptime: 316707, usedMemory: 2642344, peakMemory: 4299161, maxmemory: 0, policy: 'noeviction', ops: 41, hits: 178651, misses: 380817, expired: 25309, evicted: 0, clients: 7, aof: false, rdbStatus: 'ok', brew: true });
    expect(i.keyspace).toEqual([{ db: 0, keys: 1284, expires: 1071 }, { db: 1, keys: 12, expires: 0 }]);
  });
  test('server names: valkey, dragonfly, keydb; cluster from INFO cluster', () => {
    expect(infoOf(parseInfo('valkey_version:8.1.1\r\nredis_version:7.2.4\r\n'))).toMatchObject({ name: 'valkey', version: '8.1.1' });
    expect(infoOf(parseInfo('dragonfly_version:df-v1.24.0\r\nredis_version:7.2.0\r\n'))).toMatchObject({ name: 'dragonfly', version: '1.24.0' });
    expect(infoOf(parseInfo('redis_version:6.3.4\r\nredis_build_id:keydb\r\n'))).toMatchObject({ name: 'keydb' });
    expect(infoOf(parseInfo('redis_version:7.4.1\r\nredis_mode:standalone\r\ncluster_enabled:1\r\n')).mode).toBe('cluster');
  });
});

describe('namespaces', () => {
  test('frameworkPrefix: Laravel and Django prefixes shared by most keys', () => {
    expect(frameworkPrefix(['shop_database_cache:a', 'shop_database_queues:default', 'shop_database_x', 'other'])).toBe('shop_database_');
    expect(frameworkPrefix([':1:views.decorators', ':1:session:abc', 'x'])).toBe(':1:');
    expect(frameworkPrefix(['cache:a', 'sess:b'])).toBeNull();
    expect(frameworkPrefix([])).toBeNull();
  });
  test('namespaceOf and groupNamespaces', () => {
    expect(namespaceOf('cache:products:1', null)).toBe('cache');
    expect(namespaceOf('plain', null)).toBe(NO_NAMESPACE);
    expect(namespaceOf('shop_database_cache:x', 'shop_database_')).toBe('cache');
    const g = groupNamespaces([
      { key: 'cache:a', type: 'string', ttl: 1000, size: 100 }, { key: 'cache:b', type: 'string', ttl: -1, size: 50 },
      { key: 'sess:1', type: 'hash', ttl: 5000, size: null }, { key: 'plain', type: 'string', ttl: -1, size: 1 }
    ], null);
    expect(g).toEqual([
      { name: 'cache', count: 2, bytes: 150, withTtl: 1 },
      { name: 'sess', count: 1, bytes: 0, withTtl: 1 },
      { name: NO_NAMESPACE, count: 1, bytes: 1, withTtl: 0 }
    ]);
  });
  test('globOf: plain text matches anywhere, globs as typed', () => {
    expect(globOf('')).toBe('*');
    expect(globOf('4021')).toBe('*4021*');
    expect(globOf('cache:*')).toBe('cache:*');
    expect(globOf('a[b]')).toBe('a[b]');
  });
  test('binary keys travel as an escape and come back as the same bytes', () => {
    const raw = Buffer.from([0x66, 0xff, 0x00]);
    const wire = keyFromWire(keyToWire(raw));
    expect(Buffer.from(wire).equals(raw)).toBe(true);
    expect(keyToWire(Buffer.from('città'))).toBe('città');
    expect(displayKey(keyToWire(raw))).toBe('f\\xff\\x00');
  });
});

describe('formatting', () => {
  test('TTLs', () => {
    expect(fmtTtl(-1)).toBe('none');
    expect(fmtTtl(54_000)).toBe('54s');
    expect(fmtTtl(192_000)).toBe('3m 12s');
    expect(fmtTtl(58 * 60_000)).toBe('58m');
    expect(fmtTtl(118 * 60_000)).toBe('1h 58m');
    expect(fmtTtl(7 * 3600_000)).toBe('7h');
    expect(fmtTtl(52 * 3600_000)).toBe('2d 4h');
    expect(fmtTtlLong(54_000)).toBe('54 s');
    expect(fmtTtlLong(192_000)).toBe('3 min 12 s');
    expect(fmtTtlLong(-1)).toBe('no expiry');
  });
  test('bytes, counts, uptime', () => {
    expect(fmtBytes(412)).toBe('412 B');
    expect(fmtBytes(2431)).toBe('2.4 KB');
    expect(fmtBytes(1_677_721)).toBe('1.6 MB');
    expect(shortCount(178_651)).toBe('178k');
    expect(shortCount(950)).toBe('950');
    expect(shortCount(2_148_903)).toBe('2.1M');
    expect(fmtUptime(316707)).toBe('up 3d 15h');
    expect(fmtUptime(4000)).toBe('up 1h 6m');
  });
});

describe('hints', () => {
  const base = { maxmemory: 0, policy: 'noeviction', hits: 178651, misses: 380817, evicted: 0, rdbStatus: 'ok' };
  test('queue polling, noeviction with cache keys without TTL, evictions, failing saves', () => {
    expect(hints(base, { queues: true, cacheOnly: null, cacheNoTtl: null }).map((h) => h.id)).toEqual(['queue-polling']);
    expect(hints(base, { queues: true, cacheOnly: 0.91, cacheNoTtl: { ns: 'cache', count: 14 } }).map((h) => [h.id, h.tone])).toEqual([['queue-polling', 'info'], ['no-ttl', 'amber']]);
    expect(hints({ ...base, hits: 90, misses: 10 }, { queues: true, cacheOnly: null, cacheNoTtl: null })).toEqual([]);
    expect(hints({ ...base, maxmemory: 100, policy: 'allkeys-lru', evicted: 12 }, { queues: false, cacheOnly: null, cacheNoTtl: null }).map((h) => h.id)).toEqual(['evicting']);
    expect(hints({ ...base, rdbStatus: 'err' }, { queues: false, cacheOnly: null, cacheNoTtl: null }).map((h) => h.id)).toEqual(['rdb-failing']);
  });
});

describe('commands and prompts', () => {
  test('cliCommand per type, socket, askpass, quoting', () => {
    expect(cliCommand({ kind: 'tcp', port: 6379 }, 0, 'cache:a', 'string', false)).toBe("redis-cli -p 6379 -n 0 GET 'cache:a'");
    expect(cliCommand({ kind: 'tcp', port: 6380 }, 2, "it's", 'hash', true)).toBe("redis-cli -p 6380 -n 2 --askpass HGETALL 'it'\\''s'");
    expect(cliCommand({ kind: 'unix', path: '/tmp/r.sock' }, 0, 'l', 'list', false)).toBe("redis-cli -s /tmp/r.sock -n 0 LRANGE 'l' 0 -1");
    expect(cliCommand({ kind: 'tcp', port: 6379 }, 0, 'z', 'zset', false)).toBe("redis-cli -p 6379 -n 0 ZRANGE 'z' 0 -1 WITHSCORES");
    expect(cliCommand({ kind: 'tcp', port: 6379 }, 0, 'j', 'ReJSON-RL', false)).toBe("redis-cli -p 6379 -n 0 JSON.GET 'j'");
    expect(cliCommand({ kind: 'unix', path: '/tmp/my redis.sock' }, 0, 'k', 'string', false)).toBe("redis-cli -s '/tmp/my redis.sock' -n 0 GET 'k'");
  });
  test('masking: secret-looking fields and emails', () => {
    expect(maskField('csrf', 'abc')).toBe(true);
    expect(maskField('api_key', 'abc')).toBe(true);
    expect(maskField('user_id', '4021')).toBe(false);
    expect(maskEmails('to m.rossi@example.com and a@b.test')).toBe('to m••••@example.com and a••••@b.test');
  });
  test('keyPrompt carries the key, its type and TTL, the value masked and redacted', () => {
    const p = keyPrompt({ instance: 'redis 8.4 · :6379', db: 0, key: 'sess:u:1', type: 'hash', ttl: 7_080_000, value: 'user_id: 4021\ncsrf: ••••\ntoken: ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(p).toContain('sess:u:1');
    expect(p).toContain('hash');
    expect(p).toContain('1h 58m');
    expect(p).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

test('Windows: a custom instance is a loopback URL only (no Unix sockets there)', () => {
  expect(normalizeCustom('/tmp/redis.sock', 'win32')).toBe(null);
  expect(normalizeCustom('unix:///tmp/redis.sock', 'win32')).toBe(null);
  expect(normalizeCustom('redis://localhost:6390', 'win32')).toBe('redis://127.0.0.1:6390');
  expect(normalizeCustom('/tmp/redis.sock', 'darwin')).toBe('/tmp/redis.sock');
});
