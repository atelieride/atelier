import { describe, expect, test } from 'vitest';
import { DAEMON_CAPABILITIES, LineDecoder, clientRequestSchema, daemonCapabilities, encode, headerSchema } from './protocol';

describe('LineDecoder', () => {
  test('splits on \\n and keeps the remainder for the next chunk', () => {
    const d = new LineDecoder();
    expect(d.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(d.push(':2}\n')).toEqual(['{"b":2}']);
  });
  test('rejects a line over the limit', () => {
    const d = new LineDecoder(10);
    expect(() => d.push('x'.repeat(11))).toThrow(/line too long/);
  });
  test('encode ends with a single \\n', () => {
    expect(encode({ t: 'list', rid: 1 })).toBe('{"t":"list","rid":1}\n');
  });
});

describe('schemas', () => {
  test('valid create', () => {
    const r = clientRequestSchema.safeParse({ t: 'create', rid: 1, projectRoot: '/p', cwd: '/p', cols: 80, rows: 24 });
    expect(r.success).toBe(true);
  });
  test('create with absurd dimensions rejected', () => {
    const r = clientRequestSchema.safeParse({ t: 'create', rid: 1, projectRoot: '/p', cwd: '/p', cols: 0, rows: 99999 });
    expect(r.success).toBe(false);
  });
  test('unknown type rejected', () => {
    expect(clientRequestSchema.safeParse({ t: 'exec', rid: 1, cmd: 'rm -rf /' }).success).toBe(false);
  });
  test('hook header requires term', () => {
    expect(headerSchema.safeParse({ t: 'hook', token: 'x' }).success).toBe(false);
    expect(headerSchema.safeParse({ t: 'hook', token: 'x', term: 'abc' }).success).toBe(true);
  });
});

describe('terminal profiles (additive, same protocol version)', () => {
  const create = { t: 'create', rid: 1, projectRoot: '/p', cwd: '/p', cols: 80, rows: 24 };
  test('create without a profile is still valid (an older app)', () => {
    const r = clientRequestSchema.safeParse(create);
    expect(r.success && r.data.t === 'create' && r.data.profile).toBeUndefined();
  });
  test('create with each profile shape', () => {
    for (const profile of ['atelier', 'user', { shell: '/bin/bash' }]) {
      const r = clientRequestSchema.safeParse({ ...create, profile });
      expect(r.success, JSON.stringify(profile)).toBe(true);
      expect(r.success && r.data.t === 'create' && r.data.profile).toEqual(profile);
    }
  });
  test('unknown profiles and relative shells are rejected', () => {
    for (const profile of ['bash', 'user-zsh', { shell: 'bash' }, { shell: '/bin/bash', args: ['-c', 'x'] }, { shell: '' }, 42]) {
      expect(clientRequestSchema.safeParse({ ...create, profile }).success, JSON.stringify(profile)).toBe(false);
    }
  });
  test('resume accepts an optional profile', () => {
    expect(clientRequestSchema.safeParse({ t: 'resume', rid: 1, id: 'x', cols: 80, rows: 24 }).success).toBe(true);
    expect(clientRequestSchema.safeParse({ t: 'resume', rid: 1, id: 'x', cols: 80, rows: 24, profile: 'atelier' }).success).toBe(true);
  });
  test('reloadEnv request', () => {
    expect(clientRequestSchema.safeParse({ t: 'reloadEnv', rid: 3 }).success).toBe(true);
  });
  test('daemonCapabilities: an older atelierd has none, garbage is ignored', () => {
    expect(daemonCapabilities({ t: 'welcome', v: 1, version: '1.4.0', pid: 1 })).toEqual([]);
    expect(daemonCapabilities({ t: 'welcome', v: 1, version: '1.5.0', pid: 1, capabilities: ['profiles'] })).toEqual(['profiles']);
    expect(daemonCapabilities({ t: 'welcome', capabilities: 'profiles' })).toEqual([]);
    expect(daemonCapabilities({ t: 'welcome', capabilities: ['profiles', 3, null] })).toEqual(['profiles']);
    expect(daemonCapabilities(null)).toEqual([]);
    expect(DAEMON_CAPABILITIES).toContain('profiles');
  });
  test("'background': SessionInfo carries the session's background work", () => {
    expect(DAEMON_CAPABILITIES).toContain('background');
  });
  test("'kill-resumable': a kill may ask for the session to come back under Resume", () => {
    expect(DAEMON_CAPABILITIES).toContain('kill-resumable');
    const ok = clientRequestSchema.safeParse({ t: 'kill', rid: 1, id: 'a', resumable: true });
    expect(ok.success && ok.data).toEqual({ t: 'kill', rid: 1, id: 'a', resumable: true });
    expect(clientRequestSchema.safeParse({ t: 'kill', rid: 1, id: 'a' }).success).toBe(true);
    expect(clientRequestSchema.safeParse({ t: 'kill', rid: 1, id: 'a', resumable: 'yes' }).success).toBe(false);
  });
  test("'signals': the Claude Code signals notebook and its Clear", () => {
    expect(DAEMON_CAPABILITIES).toContain('signals');
    const ok = clientRequestSchema.safeParse({ t: 'signalsClear', rid: 4 });
    expect(ok.success && ok.data).toEqual({ t: 'signalsClear', rid: 4 });
    expect(clientRequestSchema.safeParse({ t: 'signalsClear' }).success).toBe(false);
  });
});
