import { describe, expect, test } from 'vitest';
import { daemonOutdated, daemonVersionArg, parseDaemonVersion } from './daemon-build';

describe('atelierd build identity', () => {
  test('the --version atelierd gets is the app version with the fingerprint as semver build metadata', () => {
    expect(daemonVersionArg('1.6.0-beta.9', 'a1b2c3d4e5f60718')).toBe('1.6.0-beta.9+a1b2c3d4e5f60718');
  });

  test('what atelierd echoes splits back into the app version that started it and its fingerprint', () => {
    expect(parseDaemonVersion('1.6.0-beta.9+a1b2c3d4e5f60718')).toEqual({ version: '1.6.0-beta.9', build: 'a1b2c3d4e5f60718' });
    // Started by an app older than fingerprints: no build.
    expect(parseDaemonVersion('1.6.0-beta.8')).toEqual({ version: '1.6.0-beta.8', build: null });
    expect(parseDaemonVersion('1.6.0+')).toEqual({ version: '1.6.0', build: null });
  });

  test('an app update that leaves atelierd\'s code alone does not ask for a restart (beta.8 → beta.9)', () => {
    const app = { version: '1.6.0-beta.9', build: 'a1b2c3d4e5f60718' };
    expect(daemonOutdated('1.6.0-beta.8+a1b2c3d4e5f60718', app)).toBe(false);
    expect(daemonOutdated('1.6.0-beta.9+a1b2c3d4e5f60718', app)).toBe(false);
  });

  test('different code asks for a restart, even at the same app version (a dev build)', () => {
    const app = { version: '1.6.0-beta.9', build: 'a1b2c3d4e5f60718' };
    expect(daemonOutdated('1.6.0-beta.8+ffffffffffffffff', app)).toBe(true);
    expect(daemonOutdated('1.6.0-beta.9+ffffffffffffffff', app)).toBe(true);
  });

  test('an atelierd started before fingerprints cannot prove it runs the same code: only the version tells', () => {
    const app = { version: '1.6.0-beta.9', build: 'a1b2c3d4e5f60718' };
    expect(daemonOutdated('1.6.0-beta.8', app)).toBe(true);
    expect(daemonOutdated('1.6.0-beta.9', app)).toBe(false);
  });
});
