import { describe, expect, test } from 'vitest';
import { dbUrlRefusal, formatDbUrl, parseDbUrl, psqlCommand } from './databases-url';

describe('parseDbUrl', () => {
  test('full URL: percent-decoded password', () => {
    expect(parseDbUrl('postgres://app:s%40cret@localhost:5432/acme_dev')).toEqual({
      host: 'localhost', port: 5432, database: 'acme_dev', user: 'app', password: 's@cret', tls: null, extraHosts: 0
    });
  });
  test('defaults: port 5432, database = user', () => {
    const p = parseDbUrl('postgresql://u@h');
    expect(p).toMatchObject({ host: 'h', port: 5432, database: 'u', user: 'u', password: null });
  });
  test('IPv6 in brackets', () => {
    expect(parseDbUrl('postgres://u@[::1]:6543/d')).toMatchObject({ host: '::1', port: 6543, database: 'd' });
  });
  test('sslmode maps to TLS', () => {
    const tls = (m: string) => parseDbUrl(`postgres://u@h/d?sslmode=${m}`)!.tls;
    expect(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].map(tls))
      .toEqual(['off', 'prefer', 'prefer', 'require', 'verify', 'verify']);
  });
  test('host= socket directory and dbname/user params', () => {
    expect(parseDbUrl('postgres:///?host=/var/run/postgresql&dbname=x&user=y')).toMatchObject({
      socket: '/var/run/postgresql', database: 'x', user: 'y'
    });
  });
  test('a host= socket folder wins over the URL\'s host, as libpq reads it: the socket kept, the host cleared', () => {
    expect(parseDbUrl('postgresql://app@localhost:5433/acme?host=/var/run/postgresql')).toMatchObject({
      host: '', socket: '/var/run/postgresql', port: 5433, database: 'acme', user: 'app'
    });
    // A host= that is a name, with no host in the URL, is the host.
    expect(parseDbUrl('postgresql:///acme?host=db.internal')).toMatchObject({ host: 'db.internal', database: 'acme' });
    expect(parseDbUrl('postgresql:///acme?host=db.internal')).not.toHaveProperty('socket');
  });
  test('several hosts: the first, counting the rest', () => {
    expect(parseDbUrl('postgres://u@h1:1,h2:2/d')).toMatchObject({ host: 'h1', port: 1, extraHosts: 1, database: 'd' });
  });
  test('not postgres: null', () => {
    expect(parseDbUrl('mysql://u@h/d')).toBeNull();
    expect(parseDbUrl('not a url')).toBeNull();
  });
});

describe('parseDbUrl: what it refuses, and what it reads as libpq does', () => {
  test('an invalid ?port= is refused, like a bad port in the authority; an empty one is no port', () => {
    for (const u of ['postgres://u@h/d?port=abc', 'postgres://u@h/d?port=0', 'postgres://u@h/d?port=65536', 'postgres://u@h/d?port=-1',
      'postgres://u@h/d?port=1.5', 'postgres://u@h:5433/d?port=x']) {
      expect(parseDbUrl(u), u).toBeNull();
    }
    expect(parseDbUrl('postgres://u@h/d?port=6543')).toMatchObject({ port: 6543 });
    expect(parseDbUrl('postgres://u@h/d?port=')).toMatchObject({ port: 5432 });
  });
  test('bad %-encoding anywhere, a port out of range, an unclosed IPv6 bracket: null', () => {
    for (const u of ['postgres://u:%ZZ@h/d', 'postgres://%E0%A4%A@h/d', 'postgres://u@h%ZZ/d', 'postgres://u@h/%E0%A4%A', 'postgres://u@h/d?sslmode=%ZZ',
      'postgres://u@h/d?%ZZ=1', 'postgres://u@h:0/d', 'postgres://u@h:65536/d', 'postgres://u@h:123456/d', 'postgres://u@h:12a/d',
      'postgres://u@[::1/d', 'postgres://u@[::1:5432/d', 'postgres://u@[::1]x/d']) {
      expect(parseDbUrl(u), u).toBeNull();
    }
    expect(parseDbUrl('postgres://u@h:65535/d')).toMatchObject({ port: 65535 });
    expect(parseDbUrl('postgres://u@h:1/d')).toMatchObject({ port: 1 });
  });
  test("an empty database is the user's name, as libpq reads it (none without a user)", () => {
    expect(parseDbUrl('postgres://app@h/')).toMatchObject({ database: 'app', user: 'app' });
    expect(parseDbUrl('postgres://app@h/?dbname=')).toMatchObject({ database: 'app' });
    expect(parseDbUrl('postgres://h/')).toMatchObject({ database: '', user: '' });
  });
  test('a socket folder written %-encoded as the host is the socket, as libpq reads it', () => {
    expect(parseDbUrl('postgresql://app@%2Fvar%2Frun%2Fpostgresql:5433/acme')).toEqual({
      host: '', socket: '/var/run/postgresql', port: 5433, database: 'acme', user: 'app', password: null, tls: null, extraHosts: 0
    });
    expect(parseDbUrl('postgresql://app@%2ftmp/acme')).toMatchObject({ host: '', socket: '/tmp' });
    // A host= socket folder still wins.
    expect(parseDbUrl('postgresql://app@%2Ftmp/acme?host=/var/run/postgresql')).toMatchObject({ host: '', socket: '/var/run/postgresql' });
  });
  test('a password with a raw ? or # reads as libpq reads it; a raw / is refused, never read as another host', () => {
    expect(parseDbUrl('postgres://app:pa?ss@db.example.com:5433/acme')).toMatchObject({
      user: 'app', password: 'pa?ss', host: 'db.example.com', port: 5433, database: 'acme'
    });
    expect(parseDbUrl('postgres://app:pa#ss@db.example.com/acme?sslmode=require')).toMatchObject({
      password: 'pa#ss', host: 'db.example.com', database: 'acme', tls: 'require'
    });
    expect(parseDbUrl('postgres://app:p?w#x@h')).toMatchObject({ password: 'p?w#x', host: 'h', database: 'app' });
    // A raw / ends the authority: what follows holds an @, so the URL can't be read safely (a raw @ in a database name too).
    for (const u of ['postgres://app:pa/ss@db.example.com/acme', 'postgres://app:12/34@db.example.com/acme', 'postgres://app@h/my@db']) {
      expect(parseDbUrl(u), u).toBeNull();
    }
    // An @ in the query is the query's: the user named there.
    expect(parseDbUrl('postgres://h/d?user=a@corp')).toMatchObject({ host: 'h', user: 'a@corp', database: 'd' });
    expect(parseDbUrl('postgres://u@h/d#a@b')).toMatchObject({ host: 'h', user: 'u', database: 'd' });
  });

  // The rule: before the first /, the user info ends at the last @ whose text before it is
  // user[:password] — a raw ? or # there is the password's only after the user's colon, and never after a host:port
  // (digits) or an [IPv6] host. So with no path, an @ after a ? or # is the query's or the fragment's.
  test.each([
    ['postgres://h?user=a@corp', { host: 'h', user: 'a@corp', password: null }],
    ['postgres://h#x@y', { host: 'h', user: '', password: null }],
    ['postgres://h:5433?user=a@corp', { host: 'h', port: 5433, user: 'a@corp', password: null }],
    ['postgres://[::1]:5433?user=a@corp', { host: '::1', port: 5433, user: 'a@corp', password: null }],
    ['postgres://[::1]?user=a@corp', { host: '::1', user: 'a@corp', password: null }],
    ['postgres://me@h?user=a@corp', { host: 'h', user: 'a@corp' }],
    // After the user's colon a raw ?, # or @ is the password's (A2's last-@ reading): this one reads as host b.
    ['postgres://me:pw@h#a@b', { host: 'b', user: 'me', password: 'pw@h#a' }],
    // A2's: a raw ? or # inside a password, before the host, stays the password's.
    ['postgres://app:pa?ss@db.example.com:5433/acme', { host: 'db.example.com', port: 5433, user: 'app', password: 'pa?ss' }],
    ['postgres://app:p?w#x@h', { host: 'h', user: 'app', password: 'p?w#x' }],
    ['postgres://app:pa#ss@h', { host: 'h', user: 'app', password: 'pa#ss' }],
    ['postgres://app:p@ss?x@h?sslmode=require', { host: 'h', user: 'app', password: 'p@ss?x', tls: 'require' }],
    // The rule's one reading a password can't win: digits then a raw ? (encode it: %3F).
    ['postgres://u:12?34@h', { host: 'u', port: 12, user: '', password: null }]
  ] as const)('%s', (url, want) => {
    expect(parseDbUrl(url)).toMatchObject(want);
  });

  test('why a URL is refused: a raw / in the password (encode it as %2F), or anything else', () => {
    for (const u of ['postgres://app:pa/ss@db.example.com/acme', 'postgres://app:12/34@db.example.com/acme', 'postgresql://u:a/b/c@h']) {
      expect(dbUrlRefusal(u), u).toBe('slash');
    }
    for (const u of ['mysql://x', 'postgres://app@h/my@db', 'postgres://h/my@db', 'postgres://u:p@h:99999', 'nope']) expect(dbUrlRefusal(u), u).toBe('bad');
    expect(dbUrlRefusal('postgres://u:p@h/d')).toBeNull();
  });
});

describe('formatDbUrl / psqlCommand', () => {
  const c = { host: 'db.example.com', port: 5433, database: 'd', user: 'u', tls: 'require' as const };
  test('passwordless, sslmode for require/verify only', () => {
    expect(formatDbUrl(c)).toBe('postgresql://u@db.example.com:5433/d?sslmode=require');
    expect(formatDbUrl({ ...c, tls: 'prefer' })).toBe('postgresql://u@db.example.com:5433/d');
    expect(formatDbUrl({ ...c, tls: 'verify' })).toContain('sslmode=verify-full');
  });
  test('brackets IPv6', () => {
    expect(formatDbUrl({ ...c, host: '::1', tls: 'off' })).toBe('postgresql://u@[::1]:5433/d');
  });
  test('socket directory goes to host=; a port other than 5432 goes with it (the socket file is named after it)', () => {
    expect(formatDbUrl({ ...c, port: 5432, host: '', socket: '/var/run/postgresql', tls: 'prefer' }))
      .toBe('postgresql://u@/d?host=%2Fvar%2Frun%2Fpostgresql');
    expect(formatDbUrl({ ...c, host: '', socket: '/var/run/postgresql', tls: 'prefer' }))
      .toBe('postgresql://u@/d?host=%2Fvar%2Frun%2Fpostgresql&port=5433');
    expect(psqlCommand({ ...c, host: '', socket: '/tmp', tls: 'prefer' })).toBe("psql 'postgresql://u@/d?host=%2Ftmp&port=5433'");
  });
  test('what formatDbUrl writes, parseDbUrl reads back: host or socket, port, database, user, TLS', () => {
    const cases = [
      { host: 'db.example.com', port: 5433, database: 'd', user: 'u', tls: 'require' as const },
      { host: '::1', port: 6543, database: 'Kunden Ü', user: 'app user', tls: 'verify' as const },
      { host: '', socket: '/var/run/postgresql', port: 6543, database: 'd', user: 'u', tls: 'require' as const },
      { host: '', socket: '/tmp', port: 5432, database: 'd', user: 'u', tls: 'require' as const }
    ];
    for (const x of cases) {
      const back = parseDbUrl(formatDbUrl(x))!;
      expect({ host: back.host, socket: back.socket, port: back.port, database: back.database, user: back.user }, JSON.stringify(x))
        .toEqual({ host: x.host, socket: x.socket, port: x.port, database: x.database, user: x.user });
      expect(back.tls === 'verify' || back.tls === 'require' ? back.tls : null).toBe(x.tls);
    }
  });
  test('psql command quotes the URL', () => {
    expect(psqlCommand(c)).toBe("psql 'postgresql://u@db.example.com:5433/d?sslmode=require'");
  });
  test("psql command: an apostrophe (encodeURIComponent keeps it) closes the shell quote, is escaped, and reopens it", () => {
    expect(psqlCommand({ host: 'h', port: 5432, database: "o'neil", user: "it's", tls: 'prefer' })).toBe("psql 'postgresql://it'\\''s@h:5432/o'\\''neil'");
  });
});
