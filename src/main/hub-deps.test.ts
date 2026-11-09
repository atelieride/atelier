import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DockerContainer, DockerSnapshot } from '@shared/docker';
import type { SafeStorageLike } from './connectors/secret-store';
import { runningContainers, secretStoreFor } from './hub-deps';

describe("Docker's containers for discovery", () => {
  const c = { id: 'abc', name: 'db' } as unknown as DockerContainer;
  const hub = (engine: DockerSnapshot['engine']) => ({ snapshot: (): DockerSnapshot => ({ engine, containers: [c] }) });

  test('listed while the engine runs; none when it is stopped, absent, denied or unsupported', () => {
    expect(runningContainers(hub({ state: 'running', socket: '/s', name: 'n', version: '1', apiVersion: '1', os: 'linux', arch: 'arm64', cpus: 1, memory: 1 }))).toEqual([c]);
    expect(runningContainers(hub({ state: 'stopped', socket: '/s' }))).toEqual([]);
    expect(runningContainers(hub({ state: 'absent' }))).toEqual([]);
    expect(runningContainers(hub({ state: 'denied', socket: '/s' }))).toEqual([]);
    expect(runningContainers(hub({ state: 'unsupported', socket: '/s', version: '1' }))).toEqual([]);
  });
});

describe("ATELIER_HOME's secret store", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'atl-hubdeps-')); });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
  const real = (): SafeStorageLike & { used: number } => {
    const s = {
      used: 0,
      isEncryptionAvailable: () => { s.used++; return true; },
      encryptString: (p: string) => { s.used++; return Buffer.from(p); },
      decryptString: (b: Buffer) => { s.used++; return b.toString(); }
    };
    return s;
  };

  test('the given safeStorage (the Keychain) by default', () => {
    vi.stubEnv('ATELIER_TEST_FAKE_SAFE_STORAGE', '');
    const safe = real();
    const store = secretStoreFor(home, safe);
    store.write('db-c0123456789ab', 'pw');
    expect(store.read('db-c0123456789ab')).toBe('pw');
    expect(safe.used).toBeGreaterThan(0);
    expect(store.path('db-c0123456789ab')).toBe(join(home, 'connectors', 'db-c0123456789ab.bin'));
  });

  test('the test stand-in with ATELIER_TEST_FAKE_SAFE_STORAGE=1: the real one is never touched', () => {
    vi.stubEnv('ATELIER_TEST_FAKE_SAFE_STORAGE', '1');
    const safe = real();
    const store = secretStoreFor(home, safe);
    store.write('db-c0123456789ab', 'pw');
    expect(store.read('db-c0123456789ab')).toBe('pw');
    expect(safe.used).toBe(0);
  });
});
