import { afterEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from './platform';
import { profileChip, profileOptions } from './profiles';

// The built-in profiles on Windows are PowerShell: named so; macOS keeps zsh's names.

afterEach(() => { resetPlatformForTests(); });

test('Windows: PowerShell (your profile); macOS: zsh (your config)', () => {
  initPlatform('win32');
  expect(profileOptions([]).map((o) => o.label)).toEqual(['Atelier', 'PowerShell (your profile)']);
  expect(profileChip('user', [])).toBe('PowerShell');
  initPlatform('darwin');
  expect(profileOptions([]).map((o) => o.label)).toEqual(['Atelier', 'zsh (your config)']);
  expect(profileChip('user', [])).toBe('zsh');
});
