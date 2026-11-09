import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { expectMode } from '../../tests/support/platform';

// Windows: a rename over a file an indexer or antivirus holds for a moment fails there (EPERM, EBUSY).
const held = vi.hoisted(() => ({ codes: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      const code = held.codes.shift();
      if (code) throw Object.assign(new Error(code), { code });
      fs.renameSync(from, to);
    }
  };
});
const { AppLog, redactCredentials } = await import('./app-log');
afterEach(() => { resetPlatformForTests(); held.codes = []; });

const tmp = () => join(mkdtempSync(join(tmpdir(), 'atl-applog-')), 'logs');
const at = (iso: string) => () => Date.parse(iso);

test('an entry is one timestamped line with its source and panel, then its stack indented; 0600 in a 0700 folder', () => {
  const dir = tmp();
  const log = new AppLog(join(dir, 'app.log'), { now: at('2026-10-11T09:30:00.000Z') });
  expect(log.write({ source: 'renderer:boundary', panel: 'Sidebar', message: "Cannot read properties of undefined (reading 'replace')", stack: 'TypeError: x\n    at displayCommand (index.js:1:2)' })).toBe(true);
  const text = readFileSync(join(dir, 'app.log'), 'utf8');
  expect(text).toBe("2026-10-11T09:30:00.000Z [renderer:boundary] (Sidebar) Cannot read properties of undefined (reading 'replace')\n    TypeError: x\n        at displayCommand (index.js:1:2)\n");
  expectMode(join(dir, 'app.log'), 0o600);
  expectMode(dir, 0o700);
});

test('bounded: past the limit the file rotates to app.log.1 (one backup), never growing without end', () => {
  const dir = tmp();
  const file = join(dir, 'app.log');
  const log = new AppLog(file, { maxBytes: 400, maxPerMinute: 1000 });
  for (let i = 0; i < 50; i++) log.write({ source: 'main', message: `entry ${i} ${'x'.repeat(40)}` });
  expect(statSync(file).size).toBeLessThanOrEqual(400);
  expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(400);
  expect(existsSync(`${file}.2`)).toBe(false);
  expect(readFileSync(file, 'utf8')).toContain('entry 49');
  expectMode(`${file}.1`, 0o600);
});

test('Windows: a backup held for a moment still rotates (the rename is tried again)', () => {
  initPlatform('win32');
  const file = join(tmp(), 'app.log');
  const log = new AppLog(file, { maxBytes: 200, maxPerMinute: 1000 });
  for (let i = 0; i < 2; i++) log.write({ source: 'main', message: `entry ${i} ${'x'.repeat(40)}` });
  held.codes = ['EBUSY'];
  expect(log.write({ source: 'main', message: `entry 2 ${'x'.repeat(40)}` })).toBe(true);
  expect(held.codes).toEqual([]);
  expect(readFileSync(`${file}.1`, 'utf8')).toContain('entry 0');
  expect(readFileSync(file, 'utf8')).toContain('entry 2');
});

test('no secrets nor terminal escapes: token-like runs are redacted, control characters dropped, long texts clipped', () => {
  const dir = tmp();
  const log = new AppLog(join(dir, 'app.log'));
  log.write({ source: 'renderer:error', message: `bad \u001b[31mred\u001b[0m ghp_${'A1b2'.repeat(8)} ${'y'.repeat(5000)}`, stack: `at f (sk-ant-api03-${'Zz9'.repeat(20)})` });
  const text = readFileSync(join(dir, 'app.log'), 'utf8');
  expect(text).not.toMatch(/ghp_|sk-ant|\u001b/);
  expect(text).toContain('bad [31mred[0m …');
  expect(text.split('\n')[0]!.length).toBeLessThan(2200);
});

test('connector credentials never reach the log: Bearer tokens, access/refresh tokens, PKCE verifiers and OAuth codes', () => {
  const dir = tmp();
  const log = new AppLog(join(dir, 'app.log'));
  // Short, lowercase values on purpose: the generic token-like rules alone would let them through.
  const message = [
    'POST /mcp Authorization: Bearer fkat_short-tok.1',
    'reply {"access_token":"tok_abc","token_type":"Bearer","refresh_token": "rt_xyz"}',
    'form grant_type=authorization_code&code=fake-code-1&code_verifier=ver_123&redirect_uri=http://127.0.0.1:1/cb',
    'callback /callback/x?code=c0de&state=s1 and access_token=plain_tok'
  ].join(' | ');
  log.write({ source: 'main:connector', message, stack: 'Error: 401\n    at call (Bearer stacktok)' });
  const text = readFileSync(join(dir, 'app.log'), 'utf8');
  for (const secret of ['fkat_short-tok.1', 'tok_abc', 'rt_xyz', 'fake-code-1', 'ver_123', 'c0de', 'plain_tok', 'stacktok']) {
    expect(text).not.toContain(secret);
  }
  // What surrounds them stays readable.
  expect(text).toContain('Bearer …');
  expect(text).toContain('"access_token":"…"');
  expect(text).toContain('code_verifier=…');
  expect(text).toContain('state=s1');
  expect(text).toContain('grant_type=authorization_code');
});

test('redactCredentials leaves ordinary text alone', () => {
  expect(redactCredentials('error_code=E42 decode=x postcode=10121')).toBe('error_code=E42 decode=x postcode=10121');
  expect(redactCredentials('{"code":-32602,"message":"Unknown tool"}')).toBe('{"code":-32602,"message":"Unknown tool"}');
});

test('a burst (an error on every frame) is cut at the per-minute cap, then logging resumes with a count of what was dropped', () => {
  const dir = tmp();
  let now = Date.parse('2026-10-11T09:00:00.000Z');
  const log = new AppLog(join(dir, 'app.log'), { maxPerMinute: 3, now: () => now });
  const results = Array.from({ length: 10 }, (_, i) => log.write({ source: 'renderer:error', message: `e${i}` }));
  expect(results).toEqual([true, true, true, false, false, false, false, false, false, false]);
  now += 61_000;
  expect(log.write({ source: 'renderer:error', message: 'later' })).toBe(true);
  const lines = readFileSync(join(dir, 'app.log'), 'utf8').trim().split('\n');
  expect(lines).toHaveLength(5);
  expect(lines[3]).toContain('7 entries dropped');
  expect(lines[4]).toContain('later');
});

test('a log that cannot be written never throws (logging must not crash the app)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-applog-'));
  // A file where the logs folder should be.
  writeFileSync(join(dir, 'logs'), '');
  const log = new AppLog(join(dir, 'logs', 'app.log'));
  expect(log.write({ source: 'main', message: 'x' })).toBe(false);
});
