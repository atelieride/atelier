import { describe, expect, test } from 'vitest';
import { THEMES } from './themes';
import { appIconFor, bundleIconPlan, eligibleBundle, runtimeIconFor } from './app-icon';

describe('appIconFor', () => {
  test('Docsy and Docsy Night wear the Docsy icon; every other theme keeps the bundle\'s', () => {
    expect(Object.fromEntries(THEMES.map((t) => [t.id, appIconFor(t.id)]))).toEqual({
      aurora: null, ember: null, tide: null, daylight: null, ink: null, paper: null, docsy: 'docsy', 'docsy-night': 'docsy'
    });
  });
});

describe('eligibleBundle: only the installed app, never a build, a test copy or a disk image', () => {
  const base = { platform: 'darwin', packaged: true, home: '/Users/me' };
  const exe = (bundle: string) => `${bundle}/Contents/MacOS/Atelier`;
  test('/Applications and ~/Applications', () => {
    expect(eligibleBundle({ ...base, exePath: exe('/Applications/Atelier.app') })).toBe('/Applications/Atelier.app');
    expect(eligibleBundle({ ...base, exePath: exe('/Users/me/Applications/Atelier.app') })).toBe('/Users/me/Applications/Atelier.app');
    expect(eligibleBundle({ ...base, home: '/Users/me/', exePath: exe('/Users/me/Applications/Atelier.app') })).toBe('/Users/me/Applications/Atelier.app');
  });
  test('anywhere else: release/, a temp folder, a translocated copy, a disk image, a subfolder, someone else\'s home', () => {
    for (const bundle of [
      '/Users/me/code/atelier/release/mac-arm64/Atelier.app',
      '/private/var/folders/x7/T/atl-run-1/Atelier.app',
      '/private/var/folders/x7/T/AppTranslocation/0A1B/d/Atelier.app',
      '/Volumes/Atelier 0.2.0/Atelier.app',
      '/Applications/Tools/Atelier.app',
      '/Users/other/Applications/Atelier.app'
    ]) expect(eligibleBundle({ ...base, exePath: exe(bundle) }), bundle).toBeNull();
  });
  test('not packaged, not macOS, or an executable outside a bundle\'s Contents/MacOS', () => {
    expect(eligibleBundle({ ...base, packaged: false, exePath: exe('/Applications/Atelier.app') })).toBeNull();
    expect(eligibleBundle({ ...base, platform: 'win32', exePath: exe('/Applications/Atelier.app') })).toBeNull();
    expect(eligibleBundle({ ...base, exePath: '/Applications/Atelier.app/Contents/Frameworks/Atelier Helper.app/Contents/MacOS/Atelier Helper' })).toBeNull();
    expect(eligibleBundle({ ...base, exePath: '/Applications/Atelier.app/Atelier' })).toBeNull();
    expect(eligibleBundle({ ...base, exePath: '/usr/local/bin/electron' })).toBeNull();
  });
});

describe('bundleIconPlan: ours = the marker names this bundle', () => {
  const plan = (want: 'docsy' | null, hasCustomIcon: boolean, ours: boolean) => bundleIconPlan({ want, hasCustomIcon, ours });
  test('Docsy: set it when the bundle has none (first time, or a fresh bundle after an update)', () => {
    expect(plan('docsy', false, false)).toEqual({ action: 'set', mark: 'write' });
    expect(plan('docsy', false, true)).toEqual({ action: 'set', mark: 'write' });
  });
  test('Docsy: ours already there → nothing; the user\'s own icon → never overwritten', () => {
    expect(plan('docsy', true, true)).toEqual({ action: 'none', mark: 'keep' });
    expect(plan('docsy', true, false)).toEqual({ action: 'none', mark: 'keep' });
  });
  test('Aurora: remove only our icon; the user\'s stays; a stale marker goes', () => {
    expect(plan(null, true, true)).toEqual({ action: 'reset', mark: 'clear' });
    expect(plan(null, true, false)).toEqual({ action: 'none', mark: 'keep' });
    expect(plan(null, false, true)).toEqual({ action: 'none', mark: 'clear' });
    expect(plan(null, false, false)).toEqual({ action: 'none', mark: 'keep' });
  });
});

describe('runtimeIconFor: what the Dock shows while Atelier runs', () => {
  test('Docsy → the Docsy image; other themes → the bundle\'s icon (null), or the dev icon in development', () => {
    expect(runtimeIconFor({ want: 'docsy', packaged: true, foreignIcon: false, changed: false })).toBe('docsy');
    expect(runtimeIconFor({ want: 'docsy', packaged: false, foreignIcon: false, changed: false })).toBe('docsy');
    expect(runtimeIconFor({ want: null, packaged: true, foreignIcon: false, changed: false })).toBe('bundle');
    expect(runtimeIconFor({ want: null, packaged: false, foreignIcon: false, changed: false })).toBe('dev');
  });
  test('back from Docsy while running: the Aurora image itself, since null gives the Dock a stale copy (Docsy\'s)', () => {
    expect(runtimeIconFor({ want: null, packaged: true, foreignIcon: false, changed: true })).toBe('aurora');
    expect(runtimeIconFor({ want: 'docsy', packaged: true, foreignIcon: false, changed: true })).toBe('docsy');
    expect(runtimeIconFor({ want: null, packaged: false, foreignIcon: false, changed: true })).toBe('dev');
  });
  test('a bundle wearing the user\'s own icon: the Dock follows it, whatever the theme', () => {
    expect(runtimeIconFor({ want: 'docsy', packaged: true, foreignIcon: true, changed: false })).toBe('bundle');
    expect(runtimeIconFor({ want: null, packaged: true, foreignIcon: true, changed: false })).toBe('bundle');
    expect(runtimeIconFor({ want: null, packaged: true, foreignIcon: true, changed: true })).toBe('bundle');
  });
});
