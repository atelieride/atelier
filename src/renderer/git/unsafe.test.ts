import { afterEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { dubiousOwnership, safeDirectoryCommand } from './unsafe';

// Git refuses a repository another user owns (safe.directory): every read fails, and the views showed it as clean
// ("No changes yet · 1 repo clean", branch "—"). They now say why and give the command that trusts it; Atelier never
// runs it itself (it changes the user's global git config; git writes are only git/write.ts's ops).

const MAC = "git status: fatal: detected dubious ownership in repository at '/Volumes/Ext/shop'\n"
  + 'To add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /Volumes/Ext/shop';
const WIN = "git status: fatal: detected dubious ownership in repository at 'C:/Users/mario/dev/shop'\n"
  + "'C:/Users/mario/dev/shop' is owned by:\n\tBUILTIN/Administrators (S-1-5-32-544)\nbut the current user is:\n\tPC/mario (S-1-5-21-1)\n"
  + 'To add an exception for this directory, call:\n\n\tgit config --global --add safe.directory C:/Users/mario/dev/shop';

test('git’s refusal is recognised (reads run with LC_ALL=C), with the path git reports', () => {
  expect(dubiousOwnership(MAC)).toEqual({ path: '/Volumes/Ext/shop' });
  expect(dubiousOwnership(WIN)).toEqual({ path: 'C:/Users/mario/dev/shop' });
  expect(dubiousOwnership("git for-each-ref: fatal: detected dubious ownership in repository at '/a/it's here'")).toEqual({ path: "/a/it's here" });
  expect(dubiousOwnership('fatal: detected dubious ownership in repository')).toEqual({ path: null });
});

test('anything else is not', () => {
  expect(dubiousOwnership('git status: fatal: not a git repository (or any of the parent directories): .git')).toBeNull();
  expect(dubiousOwnership('git status: spawn git ENOENT')).toBeNull();
  expect(dubiousOwnership(undefined)).toBeNull();
  expect(dubiousOwnership('')).toBeNull();
});

test('the command to copy, quoted for the shell of Atelier’s terminals (zsh on macOS, PowerShell on Windows)', () => {
  expect(safeDirectoryCommand('/Volumes/Ext/shop', 'posix')).toBe("git config --global --add safe.directory '/Volumes/Ext/shop'");
  expect(safeDirectoryCommand("/Users/o'brien/my repo", 'posix')).toBe("git config --global --add safe.directory '/Users/o'\\''brien/my repo'");
  expect(safeDirectoryCommand('C:/Users/D’Angelo/shop', 'powershell')).toBe("git config --global --add safe.directory 'C:/Users/D’’Angelo/shop'");
});

afterEach(() => resetPlatformForTests());

test('by default, quoted for the platform’s terminals: PowerShell on Windows, zsh on macOS', () => {
  initPlatform('win32');
  expect(safeDirectoryCommand("C:/Users/o'brien/shop")).toBe("git config --global --add safe.directory 'C:/Users/o''brien/shop'");
  initPlatform('darwin');
  expect(safeDirectoryCommand("/Users/o'brien/shop")).toBe("git config --global --add safe.directory '/Users/o'\\''brien/shop'");
});
