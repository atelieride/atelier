import { describe, expect, test } from 'vitest';
import { envGet, envKey, pathListJoin, pathListSplit, withEnv } from './env';

describe('posix: exact keys, ":" lists (as before)', () => {
  test('envGet reads the exact key only', () => {
    expect(envGet({ PATH: '/a', Path: '/b' }, 'PATH', 'posix')).toBe('/a');
    expect(envGet({ Path: '/b' }, 'PATH', 'posix')).toBeUndefined();
  });

  test('withEnv is { ...env, [name]: value } (same keys, same order)', () => {
    const env = { A: '1', PATH: '/a', Path: '/b', Z: '2' };
    const out = withEnv(env, 'PATH', '/x', 'posix');
    expect(out).toEqual({ ...env, PATH: '/x' });
    expect(Object.keys(out)).toEqual(Object.keys({ ...env, PATH: '/x' }));
    expect(env.PATH).toBe('/a');
  });

  test('envKey is the key itself; lists split and join on ":"', () => {
    expect(envKey('git_dir', 'posix')).toBe('git_dir');
    expect(pathListSplit('/a::/b', 'posix')).toEqual(['/a', '', '/b']);
    expect(pathListJoin(['/a', '/b'], 'posix')).toBe('/a:/b');
  });
});

describe('win32: keys in any case, ";" lists', () => {
  test('envGet finds Path when asked for PATH', () => {
    expect(envGet({ Path: 'C:\\a' }, 'PATH', 'win32')).toBe('C:\\a');
    expect(envGet({ path: 'x' }, 'Path', 'win32')).toBe('x');
    expect(envGet({}, 'PATH', 'win32')).toBeUndefined();
  });

  test('withEnv replaces every spelling: one key left (a bridge once fell off PATH with PATH beside Path)', () => {
    const out = withEnv({ A: '1', Path: 'C:\\a', path: 'C:\\b' }, 'PATH', 'C:\\x', 'win32');
    expect(out).toEqual({ A: '1', PATH: 'C:\\x' });
  });

  test('envKey upper-cases (Windows reads Git_Dir as GIT_DIR); lists split and join on ";"', () => {
    expect(envKey('Git_Dir', 'win32')).toBe('GIT_DIR');
    expect(pathListSplit('C:\\a;C:\\b', 'win32')).toEqual(['C:\\a', 'C:\\b']);
    expect(pathListJoin(['C:\\a', 'C:\\b'], 'win32')).toBe('C:\\a;C:\\b');
  });
});
