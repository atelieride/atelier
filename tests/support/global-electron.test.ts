import { expect, test } from 'vitest';
import config from '../../vitest.config';
import { ensureElectron } from './global-electron';

test("vitest's global setup loads Electron once, before any worker (parallel first loads raced on its download)", () => {
  const loaded: string[] = [];
  ensureElectron((id) => { loaded.push(id); });
  expect(loaded).toEqual(['electron']);
  expect(config.test?.globalSetup).toContain('tests/support/global-electron.ts');
});
