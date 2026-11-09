import { expect, test } from 'vitest';
// @ts-expect-error -- plain ESM script, Node built-ins only (it runs in the release jobs that install nothing).
import { msixVersion } from '../../scripts/win/msix-version.mjs';

// Four numbers, the last 0 (the Store's rule),
// always increasing across betas and stables.
test('betas: X.Y.Z-beta.N → X.Y.(Z·1000+N).0', () => {
  expect(msixVersion('0.2.0-beta.15')).toBe('0.2.15.0');
  expect(msixVersion('0.3.0-beta.1')).toBe('0.3.1.0');
  expect(msixVersion('1.4.2-beta.998')).toBe('1.4.2998.0');
});

test('stables: X.Y.Z → X.Y.(Z·1000+999).0, above every beta of the same version', () => {
  expect(msixVersion('0.2.0')).toBe('0.2.999.0');
  expect(msixVersion('1.0.3')).toBe('1.0.3999.0');
  expect(msixVersion('2.1.64')).toBe('2.1.64999.0');
});

test('the order of releases is the order of their MSIX versions', () => {
  const releases = ['0.2.0-beta.1', '0.2.0-beta.15', '0.2.0', '0.2.1-beta.1', '0.2.1', '0.3.0-beta.1', '0.3.0', '1.0.0-beta.2', '1.0.0'];
  const key = (v: string) => v.split('.').map(Number).reduce((a, n) => a * 100_000 + n, 0);
  const keys = releases.map((r) => key(msixVersion(r)));
  expect(keys).toEqual([...keys].sort((a, b) => a - b));
  expect(new Set(keys).size).toBe(keys.length);
});

test('refused: beta numbers the stable could not outrank, patch numbers past the 16-bit field, anything not X.Y.Z[-beta.N]', () => {
  expect(() => msixVersion('0.2.0-beta.999')).toThrow(/beta/);
  expect(() => msixVersion('0.2.65')).toThrow(/patch/);
  expect(() => msixVersion('0.2.65-beta.1')).toThrow(/patch/);
  expect(() => msixVersion('65536.0.0')).toThrow(/65535/);
  expect(() => msixVersion('0.65536.0')).toThrow(/65535/);
  for (const bad of ['v0.2.0', '0.2', '0.2.0.0', '0.2.0-rc.1', '0.2.0-beta', '0.2.0-beta.01', '01.2.0', '0.2.0+build.1', ' 0.2.0', '', undefined]) {
    expect(() => msixVersion(bad), String(bad)).toThrow(/X\.Y\.Z/);
  }
});
