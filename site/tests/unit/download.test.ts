import { expect, test } from 'vitest';
import { downloadInfo } from '../../src/lib/download';

test('a launched site links /download/mac: the newest DMG of the channel (functions/)', () => {
  expect(downloadInfo({ version: '0.3.0', launched: true })).toEqual({
    state: 'available', url: '/download/mac',
    version: '0.3.0', channel: 'stable', fileName: 'Atelier-0.3.0-arm64.dmg', label: 'Download for macOS'
  });
});

test('a beta version is the beta channel, linked to /download/mac/beta', () => {
  const d = downloadInfo({ version: '0.2.0-beta.7', launched: true });
  expect(d.channel).toBe('beta');
  expect(d.url).toBe('/download/mac/beta');
});

test('before launch there is no link, only "Coming soon"', () => {
  const d = downloadInfo({ version: '0.2.0-beta.7', launched: false });
  expect(d.state).toBe('coming-soon');
  expect(d.url).toBeNull();
  expect(d.label).toBe('Coming soon');
});

test('launched but not notarized: buttons elsewhere lead to /download (Gatekeeper help), its own button to the DMG', () => {
  const base = { version: '0.3.0', launched: true, notarized: false };
  expect(downloadInfo(base)).toMatchObject({ state: 'available', url: '/download', label: 'Download for macOS' });
  expect(downloadInfo({ ...base, direct: true }).url).toBe('/download/mac');
  expect(downloadInfo({ ...base, notarized: true }).url).toBe('/download/mac');
});

test('a version the release scripts never make fails the build instead of linking nowhere', () => {
  for (const version of ['', '0.3', '0.3.0-rc.1', 'v0.3.0', '0.3.0-beta']) {
    expect(() => downloadInfo({ version, launched: true })).toThrow(/version/);
  }
});
