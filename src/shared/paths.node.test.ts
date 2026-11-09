import { afterEach, expect, test } from 'vitest';
import { atelierHome, daemonPaths } from './paths.node';

const saved = process.env.ATELIER_HOME;
afterEach(() => { if (saved === undefined) delete process.env.ATELIER_HOME; else process.env.ATELIER_HOME = saved; });

test('default in Application Support', () => {
  delete process.env.ATELIER_HOME;
  expect(atelierHome()).toMatch(/Library\/Application Support\/Atelier$/);
});
test('ATELIER_HOME overrides it', () => {
  process.env.ATELIER_HOME = '/tmp/x';
  expect(daemonPaths().sock).toBe('/tmp/x/atelierd.sock');
});
test('a socket path too long falls back to the temp folder', () => {
  const p = daemonPaths('/' + 'a'.repeat(120));
  expect(Buffer.byteLength(p.sock)).toBeLessThanOrEqual(100);
  expect(p.sock).toMatch(/atelier-\d+\/atelierd\.sock$/);
});
