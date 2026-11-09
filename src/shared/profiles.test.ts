import { expect, test } from 'vitest';
import { aliasesOption, profileKeyOf, sessionProfile, terminalProfile } from './profiles';

const shells = ['/bin/bash', '/bin/sh'];

test('an atelierd without the profiles capability never gets a profile: terminals and sessions start as before', () => {
  for (const setting of ['atelier', 'user', '/bin/bash']) {
    expect(terminalProfile(undefined, setting, shells, false)).toBeUndefined();
    expect(terminalProfile('atelier', setting, shells, false)).toBeUndefined();
    expect(terminalProfile('/bin/bash', setting, shells, false)).toBeUndefined();
    expect(sessionProfile(setting, false)).toBeUndefined();
  }
});

test('terminals: the default profile, or the one asked for', () => {
  expect(terminalProfile(undefined, 'atelier', shells, true)).toBe('atelier');
  expect(terminalProfile(undefined, 'user', shells, true)).toBe('user');
  expect(terminalProfile(undefined, '/bin/bash', shells, true)).toEqual({ shell: '/bin/bash' });
  expect(terminalProfile('user', 'atelier', shells, true)).toBe('user');
  expect(terminalProfile('/bin/sh', 'atelier', shells, true)).toEqual({ shell: '/bin/sh' });
});

test('terminals: a shell that is not (or no longer) listed is never sent', () => {
  expect(terminalProfile(undefined, '/bin/gone', shells, true)).toBe('atelier');
  expect(() => terminalProfile('/usr/bin/python3', 'atelier', shells, true)).toThrow(/not available/);
  expect(() => terminalProfile('rm -rf', 'atelier', shells, true)).toThrow(/not available/);
});

test('Claude sessions: Atelier or zsh (your config) only; a shell default keeps sessions on Atelier', () => {
  expect(sessionProfile('atelier', true)).toBe('atelier');
  expect(sessionProfile('user', true)).toBe('user');
  expect(sessionProfile('/bin/bash', true)).toBe('atelier');
});

test('aliasesOption: aliases: false only when turned off and atelierd has the capability (absent = imported)', () => {
  expect(aliasesOption(false, true)).toEqual({ aliases: false });
  expect(aliasesOption(true, true)).toEqual({});
  expect(aliasesOption(false, false)).toEqual({});
  expect(aliasesOption(true, false)).toEqual({});
});

test('profileKeyOf: the setting form of a terminal profile', () => {
  expect(profileKeyOf('atelier')).toBe('atelier');
  expect(profileKeyOf('user')).toBe('user');
  expect(profileKeyOf({ shell: '/bin/bash' })).toBe('/bin/bash');
  expect(profileKeyOf(undefined)).toBeNull();
});

test('profileOptions: Atelier, zsh (your config), then the shells; labels for chips are short', async () => {
  const { profileOptions, profileLabel, profileChip } = await import('./profiles');
  const sh = [{ path: '/bin/bash', name: 'bash' }, { path: '/opt/homebrew/bin/fish', name: 'fish' }];
  expect(profileOptions(sh)).toEqual([
    { key: 'atelier', label: 'Atelier' },
    { key: 'user', label: 'zsh (your config)' },
    { key: '/bin/bash', label: 'bash' },
    { key: '/opt/homebrew/bin/fish', label: 'fish' }
  ]);
  expect(profileLabel('/bin/bash', sh)).toBe('bash');
  // A shell no longer offered still gets a readable name.
  expect(profileLabel('/usr/local/bin/ksh', sh)).toBe('ksh');
  expect(profileChip('atelier', sh)).toBe('Atelier');
  expect(profileChip('user', sh)).toBe('zsh');
  expect(profileChip('/bin/bash', sh)).toBe('bash');
});

test('profileChip shows only when a terminal runs a profile other than its default', async () => {
  const { chipFor } = await import('./profiles');
  const sh = [{ path: '/bin/bash', name: 'bash' }];
  // Terminal rows compare with the default profile, sessions with the session default (a shell default → Atelier).
  expect(chipFor({ profile: 'atelier', session: false }, 'atelier', sh)).toBeNull();
  expect(chipFor({ profile: 'user', session: false }, 'atelier', sh)).toBe('zsh');
  expect(chipFor({ profile: { shell: '/bin/bash' }, session: false }, 'atelier', sh)).toBe('bash');
  expect(chipFor({ profile: 'atelier', session: false }, '/bin/bash', sh)).toBe('Atelier');
  expect(chipFor({ profile: 'atelier', session: true }, '/bin/bash', sh)).toBeNull();
  expect(chipFor({ profile: 'user', session: true }, 'atelier', sh)).toBe('zsh');
  // From an older atelierd: no profile known, no chip.
  expect(chipFor({ profile: undefined, session: false }, 'user', sh)).toBeNull();
});
