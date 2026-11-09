import { afterEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from './platform';
import { isClaudeProcess, isShell } from './shells';

// Foreground names on Windows: the shells Atelier starts there, with or without a path and .exe, in any case.

afterEach(() => { resetPlatformForTests(); });

test('Windows: PowerShell, cmd and bash are shells, however they are written', () => {
  initPlatform('win32');
  for (const n of ['pwsh', 'powershell', 'cmd', 'PowerShell.exe', 'C:\\WINDOWS\\System32\\cmd.exe', 'C:/Program Files/Git/bin/bash.exe']) expect(isShell(n), n).toBe(true);
  expect(isShell('claude')).toBe(false);
  expect(isClaudeProcess('claude.exe')).toBe(true);
});

test('macOS: as before', () => {
  initPlatform('darwin');
  expect(isShell('pwsh')).toBe(false);
  expect(isShell('-zsh')).toBe(true);
  expect(isShell('/bin/zsh')).toBe(true);
});
