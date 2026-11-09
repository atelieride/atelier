import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { expectMode } from '../../tests/support/platform';
import { appIconDeps, SET_ICON_PROGRAM } from './app-icon-exec';

/** A private folder standing in for the app: Resources with the Docsy image, the repo's dev icons, ATELIER_HOME. */
function setup(o: { packaged?: boolean; fail?: boolean; images?: boolean; dock?: { setIcon(image: string): void } | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atl-app-icon-'));
  const home = join(dir, 'home');
  const resources = join(dir, 'Resources');
  const repo = join(dir, 'repo');
  for (const d of [home, resources, join(repo, 'assets', 'brand'), join(repo, 'build')]) mkdirSync(d, { recursive: true });
  if (o.images !== false) for (const f of [join(resources, 'app-icon-docsy.png'), join(resources, 'app-icon-aurora.png'), join(repo, 'assets', 'brand', 'app-icon-docsy.png'), join(repo, 'assets', 'brand', 'app-icon-aurora.png'), join(repo, 'build', 'icon.png')]) writeFileSync(f, 'png');
  const bundle = join(dir, 'Atelier.app');
  mkdirSync(bundle);
  const runs: { file: string; args: string[]; opts: { timeout?: number; maxBuffer?: number } }[] = [];
  const execFile = vi.fn((file: string, args: string[], opts: { timeout?: number; maxBuffer?: number }, done: (err: Error | null, stdout: string, stderr: string) => void) => {
    runs.push({ file, args, opts });
    done(o.fail ? new Error('Command failed: setIcon refused') : null, 'ok\n', '');
  });
  const dock = o.dock === null ? undefined : o.dock ?? { setIcon: vi.fn() };
  const error = vi.fn();
  const deps = appIconDeps({
    packaged: o.packaged ?? true, exePath: `${bundle}/Contents/MacOS/Atelier`, userHome: '/Users/me', atelierHome: home,
    resourcesPath: resources, appPath: repo, dock, log: () => {}, error
  }, execFile as never);
  return { dir, home, resources, repo, bundle, runs, dock: dock as { setIcon: ReturnType<typeof vi.fn> }, error, deps };
}

describe('the real Mac behind the app icon', () => {
  test('setBundleIcon: /usr/bin/osascript, JavaScript, one fixed program, argv only: the icon (or "" to remove) and the bundle', async () => {
    const { deps, runs, bundle, resources } = setup();
    await deps.setBundleIcon(bundle, 'docsy');
    await deps.setBundleIcon(bundle, null);
    expect(runs).toEqual([
      { file: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', SET_ICON_PROGRAM, join(resources, 'app-icon-docsy.png'), bundle], opts: { timeout: 10_000, maxBuffer: 64 * 1024 } },
      { file: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', SET_ICON_PROGRAM, '', bundle], opts: { timeout: 10_000, maxBuffer: 64 * 1024 } }
    ]);
  });
  test('the program: NSWorkspace.setIcon with the image or nil, refusing an unreadable image or a refused write, then Finder told', () => {
    expect(SET_ICON_PROGRAM).toContain("ObjC.import('AppKit')");
    expect(SET_ICON_PROGRAM).toContain('setIconForFileOptions(image, argv[1], 0)');
    expect(SET_ICON_PROGRAM).toContain('noteFileSystemChanged(argv[1])');
    expect(SET_ICON_PROGRAM).toMatch(/isNil\(\)\) throw/);
    expect(SET_ICON_PROGRAM).not.toMatch(/doShellScript|\$\.system|NSTask|run\(\s*\)/);
  });
  test('a failed osascript rejects with its message', async () => {
    const { deps, bundle } = setup({ fail: true });
    await expect(deps.setBundleIcon(bundle, 'docsy')).rejects.toThrow('setIcon refused');
  });
  // macOS only: the resource fork (..namedfork/rsrc) is where setIcon keeps the image, and Windows refuses a file name
  // with a carriage return.
  test.skipIf(process.platform !== 'darwin')('customIcon: none without Icon\\r; else a print of its resource fork, the same for the same image, another for another', () => {
    const { deps, bundle } = setup();
    expect(deps.customIcon(bundle)).toBeNull();
    const icon = join(bundle, 'Icon\r');
    writeFileSync(icon, '');
    writeFileSync(join(icon, '..namedfork', 'rsrc'), 'the Docsy icns');
    const docsy = deps.customIcon(bundle);
    expect(docsy).toMatch(/^[0-9a-f]{64}$/);
    // setIcon recreates the file each time: the print follows the image, not the file's dates.
    writeFileSync(icon, '');
    writeFileSync(join(icon, '..namedfork', 'rsrc'), 'the Docsy icns');
    expect(deps.customIcon(bundle)).toBe(docsy);
    writeFileSync(join(icon, '..namedfork', 'rsrc'), 'an icon pasted in Get Info');
    expect(deps.customIcon(bundle)).not.toBe(docsy);
  });
  test('the marks: ATELIER_HOME/app-icon.json, one per bundle, 0600; the file goes with the last one; anything malformed reads as none', () => {
    const { deps, home } = setup();
    const print = 'a'.repeat(64);
    expect(deps.readMarks()).toEqual({});
    deps.writeMark('/Applications/Atelier.app', { icon: 'docsy', print });
    deps.writeMark('/Users/me/Applications/Atelier.app', { icon: 'docsy', print });
    expect(JSON.parse(readFileSync(join(home, 'app-icon.json'), 'utf8'))).toEqual({
      bundles: { '/Applications/Atelier.app': { icon: 'docsy', print }, '/Users/me/Applications/Atelier.app': { icon: 'docsy', print } }
    });
    expectMode(join(home, 'app-icon.json'), 0o600);
    deps.writeMark('/Applications/Atelier.app', null);
    expect(deps.readMarks()).toEqual({ '/Users/me/Applications/Atelier.app': { icon: 'docsy', print } });
    deps.writeMark('/Users/me/Applications/Atelier.app', null);
    expect(() => readFileSync(join(home, 'app-icon.json'))).toThrow(/ENOENT/);
    for (const bad of ['{', '[]', '{"bundles":[]}', `{"bundles":{"relative.app":{"icon":"docsy","print":"${print}"}}}`,
      `{"bundles":{"/Applications/Atelier.app":{"icon":"aurora","print":"${print}"}}}`, '{"bundles":{"/Applications/Atelier.app":{"icon":"docsy","print":"short"}}}']) {
      writeFileSync(join(home, 'app-icon.json'), bad);
      expect(deps.readMarks(), bad).toEqual({});
    }
  });
  test('setDockIcon: the Docsy and Aurora images, null for the bundle\'s own icon, the dev icon in development', () => {
    const packaged = setup();
    expect([packaged.deps.setDockIcon('docsy'), packaged.deps.setDockIcon('aurora'), packaged.deps.setDockIcon('bundle')]).toEqual([true, true, true]);
    expect(packaged.dock.setIcon.mock.calls).toEqual([[join(packaged.resources, 'app-icon-docsy.png')], [join(packaged.resources, 'app-icon-aurora.png')], [null]]);
    const dev = setup({ packaged: false });
    dev.deps.setDockIcon('docsy');
    dev.deps.setDockIcon('aurora');
    dev.deps.setDockIcon('dev');
    expect(dev.dock.setIcon.mock.calls).toEqual([
      [join(dev.repo, 'assets', 'brand', 'app-icon-docsy.png')], [join(dev.repo, 'assets', 'brand', 'app-icon-aurora.png')], [join(dev.repo, 'build', 'icon.png')]
    ]);
  });
  test('setDockIcon: a missing Docsy or Aurora image or a refused one is reported and returns false; a missing dev icon only returns false', () => {
    const missing = setup({ images: false });
    expect([missing.deps.setDockIcon('docsy'), missing.deps.setDockIcon('aurora')]).toEqual([false, false]);
    expect(missing.dock.setIcon).not.toHaveBeenCalled();
    expect(missing.error).toHaveBeenCalledWith(expect.stringContaining('app-icon-docsy.png'));
    expect(missing.error).toHaveBeenCalledWith(expect.stringContaining('app-icon-aurora.png'));
    const devMissing = setup({ images: false, packaged: false });
    expect(devMissing.deps.setDockIcon('dev')).toBe(false);
    expect(devMissing.error).not.toHaveBeenCalled();
    const refused = setup({ dock: { setIcon: () => { throw new Error('bad image'); } } });
    expect(refused.deps.setDockIcon('docsy')).toBe(false);
    expect(refused.error).toHaveBeenCalledWith(expect.stringContaining('bad image'));
    // No Dock (Windows): nothing to show, nothing to retry.
    expect(setup({ dock: null }).deps.setDockIcon('docsy')).toBe(true);
  });
  test('the bundle: only the installed app (from the executable\'s path); a packaged copy elsewhere is "uninstalled"', () => {
    const temp = setup();
    expect(temp.deps.bundle).toBeNull();
    expect(temp.deps.uninstalled).toBe(process.platform === 'darwin' ? temp.bundle : null);
    expect(setup({ packaged: false }).deps.uninstalled).toBeNull();
    const host = { packaged: true, userHome: '/Users/me', atelierHome: '/tmp/x', resourcesPath: '/r', appPath: '/a', dock: undefined, log: () => {}, error: () => {} };
    const installed = appIconDeps({ ...host, exePath: '/Applications/Atelier.app/Contents/MacOS/Atelier' });
    expect(installed.bundle).toBe(process.platform === 'darwin' ? '/Applications/Atelier.app' : null);
    expect(installed.uninstalled).toBeNull();
  });
});
