import { expect, test, vi } from 'vitest';
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
import { execFile } from 'node:child_process';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { BUNDLE_EXTENSIONS, STORE_PAGE, openAppUrl, openStorePage, openTerminalFolder, openUrl } from './links';

test('safe URL → the system default browser (shell.openExternal), no process spawned', async () => {
  const openExternal = vi.fn(async () => {});
  expect(await openUrl('https://claude.ai/', { openExternal })).toBe(true);
  expect(openExternal).toHaveBeenCalledWith('https://claude.ai/');
  expect(execFile).not.toHaveBeenCalled();
});
test('unsafe URL → nothing', async () => {
  const openExternal = vi.fn(async () => {});
  expect(await openUrl('file:///etc/passwd', { openExternal })).toBe(false);
  expect(openExternal).not.toHaveBeenCalled();
});
test('the browser receives the normalized URL, never the raw string', async () => {
  const openExternal = vi.fn(async () => {});
  await openUrl(' https://claude.ai/a b', { openExternal });
  expect(openExternal).toHaveBeenCalledWith('https://claude.ai/a%20b');
});
test('a failing openExternal does not throw', async () => {
  await expect(openUrl('https://claude.ai/', { openExternal: async () => { throw new Error('x'); } })).resolves.toBe(false);
});

test("openStorePage: Atelier's own Microsoft Store page, a fixed link", async () => {
  const openExternal = vi.fn(async () => {});
  expect(STORE_PAGE).toBe('ms-windows-store://pdp/?ProductId=9N9FX0BQ20HF');
  expect(await openStorePage({ openExternal })).toBe(true);
  expect(openExternal).toHaveBeenCalledWith(STORE_PAGE);
  expect(await openStorePage({ openExternal: async () => { throw new Error('no Store'); } })).toBe(false);
});

test('openAppUrl: an app is installed for the scheme → opened in it', async () => {
  const openExternal = vi.fn(async () => {});
  const hasApp = vi.fn(() => true);
  expect(await openAppUrl('clickup://t/86fk0001a', { openExternal, hasApp })).toBe(true);
  expect(hasApp).toHaveBeenCalledWith('clickup://t/86fk0001a');
  expect(openExternal).toHaveBeenCalledWith('clickup://t/86fk0001a');
});
test('openAppUrl: no app for the scheme → false, nothing opened (no "no application" dialog)', async () => {
  const openExternal = vi.fn(async () => {});
  expect(await openAppUrl('clickup://t/86fk0001a', { openExternal, hasApp: () => false })).toBe(false);
  expect(openExternal).not.toHaveBeenCalled();
});
test('openAppUrl: only the known app schemes, never http(s), file or any other', async () => {
  const openExternal = vi.fn(async () => {});
  for (const url of ['https://app.clickup.com/t/1', 'file:///etc/passwd', 'x-apple.systempreferences:x', 'slack://open', 'clickup:', 'clickup://t/a b']) {
    expect(await openAppUrl(url, { openExternal, hasApp: () => true })).toBe(false);
  }
  expect(openExternal).not.toHaveBeenCalled();
});
test("openAppUrl: Notion's page link (notion://www.notion.so/<32hex>) opens in the Notion app", async () => {
  const openExternal = vi.fn(async () => {});
  const url = 'notion://www.notion.so/2a0e8f2b5c6d4e7f8a9b0c1d2e3f4a5b';
  expect(await openAppUrl(url, { openExternal, hasApp: () => true })).toBe(true);
  expect(openExternal).toHaveBeenCalledWith(url);
});
test('openAppUrl: only the exact Notion page shape, never another host, path or id', async () => {
  const openExternal = vi.fn(async () => {});
  for (const url of [
    'notion://www.notion.so/2A0E8F2B5C6D4E7F8A9B0C1D2E3F4A5B', 'notion://www.notion.so/2a0e8f2b5c6d4e7f8a9b0c1d2e3f4a5', 'notion://evil.example/2a0e8f2b5c6d4e7f8a9b0c1d2e3f4a5b',
    'notion://www.notion.so/2a0e8f2b5c6d4e7f8a9b0c1d2e3f4a5b?x=1', 'notion://www.notion.so/acme/2a0e8f2b5c6d4e7f8a9b0c1d2e3f4a5b', 'notion:',
  ]) {
    expect(await openAppUrl(url, { openExternal, hasApp: () => true })).toBe(false);
  }
  expect(openExternal).not.toHaveBeenCalled();
});
test('openAppUrl: a failing open → false (the caller falls back to the browser)', async () => {
  await expect(openAppUrl('clickup://t/86fk0001a', { openExternal: async () => { throw new Error('x'); }, hasApp: () => true })).resolves.toBe(false);
});

test('a terminal folder that is a bundle (Foo.app, .pkg, Contents/Info.plist) is shown selected in Finder, never opened', async () => {
  const shown: string[] = [];
  const opened: string[] = [];
  const deps = { show: (p: string) => void shown.push(p), open: async (p: string) => void opened.push(p), hasInfoPlist: (p: string) => p === '/r/Weird' };
  for (const p of ['/r/api', '/r/tools.app', '/r/Setup.pkg', '/r/Weird', '/r/.config']) await openTerminalFolder(p, deps);
  expect(opened).toEqual(['/r/api', '/r/.config']);
  expect(shown).toEqual(['/r/tools.app', '/r/Setup.pkg', '/r/Weird']);
});

test('Windows: a name Explorer would run (.exe, .bat, .lnk…) is shown selected, never opened', async () => {
  initPlatform('win32');
  try {
    const shown: string[] = [];
    const opened: string[] = [];
    const deps = { show: (p: string) => void shown.push(p), open: async (p: string) => void opened.push(p), hasInfoPlist: () => false, bundleName: BUNDLE_EXTENSIONS };
    // Windows drops trailing dots and spaces from a name: `tool.exe.` runs as tool.exe.
    const runs = ['C:\\r\\tool.exe', 'C:\\r\\x.BAT', 'C:\\r\\a.lnk', 'C:\\r\\s.ps1', 'C:\\r\\i.msi', 'C:\\r\\t.exe.', 'C:\\r\\t.cmd ', 'C:\\r\\t.bat. .'];
    for (const p of ['C:\\r\\api', 'C:\\r\\run.v2', 'C:\\r\\v2.', ...runs]) await openTerminalFolder(p, deps);
    expect(opened).toEqual(['C:\\r\\api', 'C:\\r\\run.v2', 'C:\\r\\v2.']);
    expect(shown).toEqual(runs);
  } finally { resetPlatformForTests(); }
});

test('Windows: a dotted folder (Contoso.Web, example.org, tools.app) opens in File Explorer: bundles are macOS\'s', async () => {
  initPlatform('win32');
  try {
    const shown: string[] = [];
    const opened: string[] = [];
    // The default rule (no bundle names given), and an Info.plist that means nothing there.
    const deps = { show: (p: string) => void shown.push(p), open: async (p: string) => void opened.push(p), hasInfoPlist: () => true };
    for (const p of ['C:\\r\\Contoso.Web', 'C:\\r\\example.org', 'C:\\r\\tools.app', 'C:\\r\\tool.exe']) await openTerminalFolder(p, deps);
    expect(opened).toEqual(['C:\\r\\Contoso.Web', 'C:\\r\\example.org', 'C:\\r\\tools.app']);
    expect(shown).toEqual(['C:\\r\\tool.exe']);
  } finally { resetPlatformForTests(); }
});

test('with the bundle extensions given (Claude temp folders), a dotted folder name opens; bundles are still shown', async () => {
  const shown: string[] = [];
  const opened: string[] = [];
  const deps = { show: (p: string) => void shown.push(p), open: async (p: string) => void opened.push(p), hasInfoPlist: (p: string) => p === '/t/Weird', bundleName: BUNDLE_EXTENSIONS };
  for (const p of ['/t/run.v2', '/t/-Users-x-app.v2', '/t/tools.app', '/t/Setup.pkg', '/t/Weird']) await openTerminalFolder(p, deps);
  expect(opened).toEqual(['/t/run.v2', '/t/-Users-x-app.v2']);
  expect(shown).toEqual(['/t/tools.app', '/t/Setup.pkg', '/t/Weird']);
});
