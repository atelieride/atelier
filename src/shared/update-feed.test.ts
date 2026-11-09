import { expect, test } from 'vitest';
import {
  MAX_UPDATE_ZIP, compareSemver, effectiveChannel, feedVerdict, parseFeed, parseReleaseList, parseSemver, pickRelease,
  systemVersionAtLeast, whatsNewDue
} from './update-feed';

const SHA = Buffer.alloc(64, 7).toString('base64');
const HELPER = 'a'.repeat(64);

function yml(over: Record<string, string> = {}): string {
  const f: Record<string, string> = {
    version: '0.2.0-beta.1',
    files: `\n  - url: Atelier-0.2.0-beta.1-arm64.zip\n    sha512: ${SHA}\n    size: 123456`,
    path: 'Atelier-0.2.0-beta.1-arm64.zip',
    sha512: SHA,
    releaseDate: "'2026-10-11T10:00:00.000Z'",
    channel: 'beta',
    minimumSystemVersion: "'12.0'",
    protocol: '1',
    spawnHelper: HELPER,
    notes: '"- First beta\\n- Updates inside the app"',
    ...over
  };
  return Object.entries(f).filter(([, v]) => v !== '<omit>').map(([k, v]) => (v.startsWith('\n') ? `${k}:${v}` : `${k}: ${v}`)).join('\n') + '\n';
}

test('semver: numbers compare numerically, a prerelease comes before its release', () => {
  expect(parseSemver('0.2.0')).toEqual({ major: 0, minor: 2, patch: 0, pre: [] });
  expect(parseSemver('v0.2.0')).toBeNull();
  expect(parseSemver('0.2')).toBeNull();
  expect(parseSemver('01.2.3')).toBeNull();
  expect(compareSemver('0.2.0-beta.1', '0.2.0')).toBeLessThan(0);
  expect(compareSemver('0.2.0', '0.2.0-beta.1')).toBeGreaterThan(0);
  expect(compareSemver('0.2.0-beta.2', '0.2.0-beta.10')).toBeLessThan(0);
  expect(compareSemver('0.10.0', '0.9.9')).toBeGreaterThan(0);
  expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  // Numeric identifiers sort before alphanumeric ones; a longer prerelease wins when the prefix is equal.
  expect(compareSemver('1.0.0-1', '1.0.0-beta')).toBeLessThan(0);
  expect(compareSemver('1.0.0-beta', '1.0.0-beta.1')).toBeLessThan(0);
  expect(compareSemver('nope', '1.0.0')).toBeNaN();
});

test('a well-formed feed parses into its fields', () => {
  const r = parseFeed(yml());
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.feed).toEqual({
    version: '0.2.0-beta.1', path: 'Atelier-0.2.0-beta.1-arm64.zip', sha512: SHA, size: 123456,
    releaseDate: '2026-10-11T10:00:00.000Z', channel: 'beta', minimumSystemVersion: '12.0', protocol: 1,
    spawnHelper: HELPER, notes: '- First beta\n- Updates inside the app'
  });
});

test('block scalar notes and unknown keys are accepted', () => {
  const r = parseFeed(yml({ notes: '|-\n  - First beta\n\n  - Second line', stagingPercentage: '100' }));
  expect(r.ok && r.feed.notes).toBe('- First beta\n\n- Second line');
});

test('a feed that is malformed or out of bounds is rejected', () => {
  const bad = [
    yml({ version: '0.2' }),
    yml({ channel: 'nightly' }),
    // A stable feed never carries a prerelease.
    yml({ channel: 'stable' }),
    yml({ sha512: Buffer.alloc(63).toString('base64') }),
    yml({ path: '../Atelier.zip' }),
    yml({ path: 'Atelier.dmg' }),
    // path and sha512 must match the first file (electron-builder writes both).
    yml({ path: 'Other-arm64.zip' }),
    yml({ files: `\n  - url: Atelier-0.2.0-beta.1-arm64.zip\n    sha512: ${SHA}\n    size: ${MAX_UPDATE_ZIP + 1}` }),
    yml({ files: `\n  - url: Atelier-0.2.0-beta.1-arm64.zip\n    sha512: ${SHA}\n    size: 0` }),
    yml({ protocol: 'one' }),
    yml({ spawnHelper: 'xyz' }),
    yml({ minimumSystemVersion: 'Sonoma' }),
    yml({ notes: '<omit>' }),
    yml({ version: '<omit>' }),
    // Things outside the subset we write: anchors, flow maps, tabs, odd indentation.
    yml({ notes: '&a "x"' }),
    yml({ files: ' [{url: x}]' }),
    `${yml()}\tkey: value\n`,
    `${yml()}   stray: 1\n`,
    'not: [yaml',
    ''
  ];
  for (const text of bad) expect(parseFeed(text).ok, text).toBe(false);
});

test('a duplicate key is rejected: the signed bytes must mean one thing', () => {
  expect(parseFeed(`${yml()}version: 9.9.9\n`).ok).toBe(false);
});

test('the release list from the GitHub API: tags vX.Y.Z or vX.Y.Z-beta.N, drafts and junk skipped', () => {
  const list = parseReleaseList([
    { tag_name: 'v0.2.0', draft: false, prerelease: false },
    { tag_name: 'v0.3.0-beta.1', draft: false, prerelease: true },
    { tag_name: 'v0.4.0', draft: true, prerelease: false },
    { tag_name: 'channel-beta', draft: false, prerelease: false },
    { tag_name: 7 },
    null
  ]);
  expect(list).toEqual([{ tag: 'v0.2.0', version: '0.2.0', prerelease: false }, { tag: 'v0.3.0-beta.1', version: '0.3.0-beta.1', prerelease: true }]);
  expect(parseReleaseList({ message: 'API rate limit exceeded' })).toEqual([]);
});

test('channel selection: stable sees only releases, beta the newest of betas and releases', () => {
  const list = [
    { tag: 'v0.2.0', version: '0.2.0', prerelease: false },
    { tag: 'v0.3.0-beta.2', version: '0.3.0-beta.2', prerelease: true },
    { tag: 'v0.3.0-beta.10', version: '0.3.0-beta.10', prerelease: true },
    { tag: 'v0.2.1', version: '0.2.1', prerelease: false }
  ];
  expect(pickRelease(list, 'stable')?.version).toBe('0.2.1');
  expect(pickRelease(list, 'beta')?.version).toBe('0.3.0-beta.10');
  // Once 0.3.0 is promoted, beta users get it too.
  expect(pickRelease([...list, { tag: 'v0.3.0', version: '0.3.0', prerelease: false }], 'beta')?.version).toBe('0.3.0');
  // A prerelease version marked as a full release on GitHub still never reaches stable.
  expect(pickRelease([{ tag: 'v0.5.0-beta.1', version: '0.5.0-beta.1', prerelease: false }], 'stable')).toBeNull();
  expect(pickRelease([], 'beta')).toBeNull();
});

test('a verified feed is installed only if newer and allowed on the channel; never a downgrade', () => {
  const feed = (version: string, channel: 'stable' | 'beta') => ({ version, channel });
  expect(feedVerdict(feed('0.2.0', 'stable'), { channel: 'stable', current: '0.1.0' })).toBe('newer');
  expect(feedVerdict(feed('0.2.0', 'stable'), { channel: 'beta', current: '0.2.0-beta.3' })).toBe('newer');
  expect(feedVerdict(feed('0.2.0-beta.1', 'beta'), { channel: 'beta', current: '0.1.0' })).toBe('newer');
  expect(feedVerdict(feed('0.2.0-beta.1', 'beta'), { channel: 'stable', current: '0.1.0' })).toBe('wrong-channel');
  expect(feedVerdict(feed('0.1.0', 'stable'), { channel: 'stable', current: '0.1.0' })).toBe('not-newer');
  expect(feedVerdict(feed('0.1.0', 'stable'), { channel: 'stable', current: '0.2.0-beta.1' })).toBe('not-newer');
  // A running version that is not semver (a dev build) never blocks nor triggers: nothing to compare.
  expect(feedVerdict(feed('0.2.0', 'stable'), { channel: 'stable', current: 'dev' })).toBe('not-newer');
});

test('the effective channel: the setting wins, "auto" follows the build, off or no channel means idle', () => {
  expect(effectiveChannel('auto', 'beta')).toBe('beta');
  expect(effectiveChannel('auto', null)).toBeNull();
  expect(effectiveChannel('stable', 'beta')).toBe('stable');
  expect(effectiveChannel('beta', null)).toBe('beta');
  expect(effectiveChannel('off', 'stable')).toBeNull();
});

test('macOS version check for minimumSystemVersion', () => {
  expect(systemVersionAtLeast('26.0.1', '12.0')).toBe(true);
  expect(systemVersionAtLeast('12.0', '12.0')).toBe(true);
  expect(systemVersionAtLeast('11.7.10', '12.0')).toBe(false);
  expect(systemVersionAtLeast('14', '13.5')).toBe(true);
  expect(systemVersionAtLeast('garbage', '12.0')).toBe(false);
});

test('"What\'s new" only after a launch on a newer version than the last one', () => {
  expect(whatsNewDue('0.2.0-beta.1', '0.2.0')).toBe(true);
  expect(whatsNewDue('0.2.0', '0.2.0')).toBe(false);
  expect(whatsNewDue('0.3.0', '0.2.0')).toBe(false);
  // First launch ever: nothing to announce.
  expect(whatsNewDue(null, '0.2.0')).toBe(false);
  expect(whatsNewDue('junk', '0.2.0')).toBe(false);
});
