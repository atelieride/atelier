import { describe, expect, test } from 'vitest';
import { clock, foldTraces, frameOf, hostPath, httpOf, isFrame, jsonSummary, lineLevel, splitTimestamp } from './docker-logs';

describe('splitTimestamp: the RFC 3339 prefix `timestamps=1` adds', () => {
  test('nanoseconds, Z', () => {
    expect(splitTimestamp('2026-10-15T07:41:02.118123456Z server listening')).toEqual({ at: Date.parse('2026-10-15T07:41:02.118Z'), text: 'server listening' });
  });
  test('an offset and no fraction', () => {
    expect(splitTimestamp('2026-10-15T09:41:02+02:00 x')).toEqual({ at: Date.parse('2026-10-15T07:41:02Z'), text: 'x' });
  });
  test('no prefix: unknown time, text as is', () => {
    expect(splitTimestamp('plain line')).toEqual({ at: null, text: 'plain line' });
    expect(splitTimestamp('2026-10-15T07:41:02.1Z')).toEqual({ at: Date.parse('2026-10-15T07:41:02.100Z'), text: '' });
  });
});

test('clock: local HH:MM:SS.mmm', () => {
  const d = new Date(2026, 9, 15, 9, 4, 5, 7);
  expect(clock(d.getTime())).toBe('09:04:05.007');
});

describe('httpOf: access log lines', () => {
  test.each([
    ['GET /api/products 200 18.123 ms - 512', { method: 'GET', path: '/api/products', status: 200, duration: '18.123 ms' }],
    ['POST /api/checkout 500 1.2 s', { method: 'POST', path: '/api/checkout', status: 500, duration: '1.2 s' }],
    ['172.19.0.1 - - [15/Oct/2026:07:42:15 +0000] "GET /index.html HTTP/1.1" 404 153 "-" "curl/8.7.1"', { method: 'GET', path: '/index.html', status: 404, duration: null }],
    ['info: HTTP DELETE /items/3 → 204 (3ms)', { method: 'DELETE', path: '/items/3', status: 204, duration: '3ms' }]
  ])('%s', (line, http) => {
    expect(httpOf(line)).toEqual(http);
  });
  test('not an access line', () => {
    expect(httpOf('GET request failed: timeout')).toBeNull();
    expect(httpOf('connected to postgres (pool 10)')).toBeNull();
    expect(httpOf('GET /x 999 2 ms')).toBeNull();
  });
});

describe('stack frames', () => {
  test.each([
    '    at verify (src/auth/session.ts:42:11)',
    '    at /app/dist/server.js:10:3',
    '\tat com.acme.Main.run(Main.java:42)',
    '  File "/app/worker.py", line 12, in main',
    '\t... 9 more'
  ])('%s is a frame', (l) => {
    expect(isFrame(l)).toBe(true);
  });
  test('not frames', () => {
    expect(isFrame('at last, done')).toBe(false);
    expect(isFrame('    connected')).toBe(false);
  });
  test('frameOf: file and line', () => {
    expect(frameOf('    at verify (/app/src/auth/session.ts:42:11)')).toEqual({ path: '/app/src/auth/session.ts', line: 42 });
    expect(frameOf('    at /app/dist/server.js:10:3')).toEqual({ path: '/app/dist/server.js', line: 10 });
    expect(frameOf('  File "/app/worker.py", line 12, in main')).toEqual({ path: '/app/worker.py', line: 12 });
    expect(frameOf('    at node:net:1607:16')).toBeNull();
    expect(frameOf('    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1607:16)')).toBeNull();
  });
  test('hostPath: through a bind mount, inside the project only', () => {
    const mounts = [{ type: 'bind', name: null, source: '/Users/me/acme/src', target: '/app/src', rw: true }, { type: 'bind', name: null, source: '/etc/hosts', target: '/etc/hosts', rw: false }];
    expect(hostPath('/app/src/auth/session.ts', mounts, '/Users/me/acme')).toBe('/Users/me/acme/src/auth/session.ts');
    expect(hostPath('/app/srcx/a.ts', mounts, '/Users/me/acme')).toBeNull();
    expect(hostPath('/etc/hosts', mounts, '/Users/me/acme')).toBeNull();
    expect(hostPath('/app/src/../../etc/passwd', mounts, '/Users/me/acme')).toBeNull();
  });
});

describe('foldTraces: frames after two fold into "… N more frames"', () => {
  const lines = ['ok', 'Error: boom', '    at a (x.ts:1:1)', '    at b (x.ts:2:1)', '    at c (x.ts:3:1)', '    at d (x.ts:4:1)', 'next'];
  test('folded', () => {
    expect(foldTraces(lines, () => false)).toEqual([
      { kind: 'line', index: 0 }, { kind: 'line', index: 1 }, { kind: 'line', index: 2 }, { kind: 'line', index: 3 },
      { kind: 'fold', index: 4, hidden: 2 }, { kind: 'line', index: 6 }
    ]);
  });
  test('opened (by the first hidden frame)', () => {
    expect(foldTraces(lines, (i) => i === 4).map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  test('three frames or fewer never fold', () => {
    expect(foldTraces(['E', '  at a (x:1:1)', '  at b (x:1:1)', '  at c (x:1:1)'], () => false).every((r) => r.kind === 'line')).toBe(true);
  });
});

describe('jsonSummary: one-line JSON logs', () => {
  test('the message and the other keys', () => {
    expect(jsonSummary('{"level":"warn","time":"2026-10-15T07:42:19Z","msg":"slow query","ms":412,"sql":"SELECT 1"}')).toEqual({ message: 'slow query', keys: 2 });
    expect(jsonSummary('{"message":"hi"}')).toEqual({ message: 'hi', keys: 0 });
  });
  test('no message key: the object is the message', () => {
    expect(jsonSummary('{"a":1,"b":2}')).toEqual({ message: null, keys: 2 });
  });
  test('not JSON', () => {
    expect(jsonSummary('plain')).toBeNull();
    expect(jsonSummary('[1,2]')).toBeNull();
  });
});

describe('lineLevel', () => {
  test('the logger\'s level, stderr does not make an error on its own', () => {
    expect(lineLevel('ERROR checkout failed', 'out')).toBe('error');
    expect(lineLevel('WARN slow query', 'out')).toBe('warn');
    expect(lineLevel('server listening on :3000', 'err')).toBe('info');
    expect(lineLevel('{"level":50,"msg":"x"}', 'out')).toBe('error');
    expect(lineLevel('DEBUG cache hit', 'out')).toBe('debug');
    expect(lineLevel('GET /x 200 3 ms', 'out')).toBe('http');
    expect(lineLevel('POST /x 500 3 ms', 'out')).toBe('error');
    expect(lineLevel('GET /x 404 3 ms', 'out')).toBe('warn');
  });
});
