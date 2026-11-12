import { afterEach, beforeEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { defaultPowerShell, isGitBash, listedShell, loginArgs, windowsShells } from './profiles';

// Shells on Windows: no /etc/shells, a fixed probe of where they install. PowerShell 7 may be
// an App Execution Alias (winget put it under WindowsApps on the test PC). Paths canonical, as on the protocol.

const ENV = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\WINDOWS', LOCALAPPDATA: 'C:\\Users\\m\\AppData\\Local' };
const has = (...paths: string[]) => (p: string) => paths.includes(p);

beforeEach(() => { initPlatform('win32'); });
afterEach(() => { resetPlatformForTests(); });

test('the shells found, PowerShell 7 first', () => {
  const list = windowsShells(ENV, has(
    'C:/Program Files/PowerShell/7/pwsh.exe', 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe',
    'C:/WINDOWS/System32/cmd.exe', 'C:/Program Files/Git/bin/bash.exe', 'C:/WINDOWS/System32/wsl.exe'
  ));
  expect(list.map((s) => [s.name, s.path, s.kind])).toEqual([
    ['PowerShell 7', 'C:/Program Files/PowerShell/7/pwsh.exe', 'powershell'],
    ['Windows PowerShell', 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe', 'powershell'],
    ['Command Prompt', 'C:/WINDOWS/System32/cmd.exe', 'cmd'],
    ['Git Bash', 'C:/Program Files/Git/bin/bash.exe', 'posix'],
    ['WSL', 'C:/WINDOWS/System32/wsl.exe', 'posix']
  ]);
  expect(defaultPowerShell(list)?.path).toBe('C:/Program Files/PowerShell/7/pwsh.exe');
});

test('PowerShell 7 as a Store alias; without it, Windows PowerShell is the default', () => {
  const alias = windowsShells(ENV, has('C:/Users/m/AppData/Local/Microsoft/WindowsApps/pwsh.exe', 'C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe'));
  expect(alias[0]?.path).toBe('C:/Users/m/AppData/Local/Microsoft/WindowsApps/pwsh.exe');
  const old = windowsShells(ENV, has('C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe'));
  expect(defaultPowerShell(old)?.name).toBe('Windows PowerShell');
});

test('Git for Windows installed for the user only (its default without admin rights, winget --scope user): Git Bash too', () => {
  const list = windowsShells(ENV, has('C:/Users/m/AppData/Local/Programs/Git/bin/bash.exe'));
  expect(list.map((s) => [s.name, s.path])).toEqual([['Git Bash', 'C:/Users/m/AppData/Local/Programs/Git/bin/bash.exe']]);
});

test('only a listed shell starts, by its native path; anything else is refused', () => {
  const probe = { env: ENV, exists: has('C:/WINDOWS/System32/cmd.exe') };
  expect(listedShell('C:/WINDOWS/System32/cmd.exe', undefined, probe)).toBe('C:\\WINDOWS\\System32\\cmd.exe');
  expect(listedShell('c:/windows/system32/CMD.EXE', undefined, probe)).toBe('C:\\WINDOWS\\System32\\cmd.exe');
  expect(() => listedShell('C:/Users/m/evil.exe', undefined, probe)).toThrow(/not allowed/);
  expect(() => listedShell('C:/Program Files/Git/bin/bash.exe', undefined, probe)).toThrow(/not allowed/);
});

test('start arguments per shell', () => {
  expect(loginArgs('C:\\Program Files\\Git\\bin\\bash.exe')).toEqual(['-l']);
  expect(loginArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toEqual(['-NoLogo']);
  expect(loginArgs('C:\\WINDOWS\\System32\\cmd.exe')).toEqual([]);
  expect(loginArgs('C:\\WINDOWS\\System32\\wsl.exe')).toEqual([]);
});

test('Git Bash is the bash of a Git for Windows install, not WSL, cmd or Git’s inner MSYS bash', () => {
  const win = { env: ENV, exists: has('C:/Program Files/Git/bin/bash.exe', 'C:/WINDOWS/System32/wsl.exe', 'C:/WINDOWS/System32/cmd.exe') };
  expect(isGitBash('C:\\Program Files\\Git\\bin\\bash.exe', win)).toBe(true);
  expect(isGitBash('c:/program files/git/bin/BASH.EXE', win)).toBe(true);
  expect(isGitBash('C:\\WINDOWS\\System32\\wsl.exe', win)).toBe(false);
  expect(isGitBash('C:\\WINDOWS\\System32\\cmd.exe', win)).toBe(false);
  expect(isGitBash('C:/Program Files/Git/usr/bin/bash.exe', win)).toBe(false);
  const perUser = { env: ENV, exists: has('C:/Users/m/AppData/Local/Programs/Git/bin/bash.exe') };
  expect(isGitBash('C:\\Users\\m\\AppData\\Local\\Programs\\Git\\bin\\bash.exe', perUser)).toBe(true);
});

test('macOS: loginArgs as before', () => {
  initPlatform('darwin');
  expect(loginArgs('/bin/bash')).toEqual(['-l']);
  expect(loginArgs('/opt/homebrew/bin/nu')).toEqual([]);
});
