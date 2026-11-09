// What several hubs take from main the same way: Docker's containers while its engine runs (Redis and Databases
// discovery), and ATELIER_HOME's Keychain-backed secret store (connectors, Redis, Databases) with the test stand-in
// for safeStorage when ATELIER_TEST_FAKE_SAFE_STORAGE=1 (a devEnv variable: inert in the packaged app).
import type { DockerContainer } from '@shared/docker';
import { createSecretStore, type SafeStorageLike, type SecretStore } from './connectors/secret-store';
import { testSafeStorage } from './connectors/test-safe-storage';
import { devEnv } from './dev-env';
import type { DockerHub } from './docker/hub';

/** Docker's containers while its engine runs; none otherwise (a stopped engine's last list is not what runs). */
export function runningContainers(docker: Pick<DockerHub, 'snapshot'>): DockerContainer[] {
  const s = docker.snapshot();
  return s.engine.state === 'running' ? s.containers : [];
}

/** The secret store in `home`, encrypted with `safe` (Electron's safeStorage), or with the stand-in in tests. */
export function secretStoreFor(home: string, safe: SafeStorageLike): SecretStore {
  return createSecretStore(home, devEnv('ATELIER_TEST_FAKE_SAFE_STORAGE') === '1' ? testSafeStorage() : safe);
}
