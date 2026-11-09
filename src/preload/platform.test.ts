import { beforeAll, expect, test, vi } from 'vitest';
import type { AtelierApi } from '@shared/api';
import { asPlatform } from '@shared/platform';

// The renderer learns the platform from the preload only.

let api: AtelierApi;
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_k: string, v: AtelierApi) => { api = v; } },
  ipcRenderer: { invoke: () => Promise.resolve(), send: () => {}, on: () => {}, off: () => {} },
  webUtils: { getPathForFile: () => '' }
}));
beforeAll(async () => { await import('./index'); });

test("the bridge carries Node's platform, narrowed to the ones Atelier knows", () => {
  expect(api.platform).toBe(asPlatform(process.platform));
});
