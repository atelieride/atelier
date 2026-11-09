import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveConfig } from 'electron-vite';
import { build, normalizePath, type Plugin } from 'vite';
import { describe, expect, test } from 'vitest';
import { daemonFingerprint } from '../../src/main/daemon-fingerprint';

// The app asks for an atelierd restart when the fingerprint of the code it would launch changes (daemon.js and the
// local chunks it requires). Built in one graph with the main process, the modules both use went to a shared chunk
// that also carried main-only code: adding isClaudeProcess to shared/shells.ts for the app alone asked every user to
// restart atelierd (and close their sessions) for nothing. daemon.js is now a bundle of its own.

// Vite names modules with forward slashes on every machine.
const SHELLS = normalizePath(resolve('src/shared/shells.ts'));
const MAIN = normalizePath(resolve('src/main/index.ts'));

/**
 * A main-only change to a module atelierd uses too: a new export in shared/shells.ts that only the app imports.
 * `hits.shells` counts the builds it reached shells.ts in: a probe that never ran would prove nothing.
 */
function mainOnlyChange(hits = { shells: 0 }): Plugin {
  return {
    name: 'test-main-only-change',
    enforce: 'pre',
    transform(code, id) {
      if (id === SHELLS) {
        hits.shells += 1;
        return `${code}\nexport function mainOnlyProbe(): string { return 'main-only-probe'; }\n`;
      }
      if (id === MAIN) return `import { mainOnlyProbe } from '@shared/shells';\nconsole.log(mainOnlyProbe());\n${code}`;
      return null;
    }
  };
}

/** Builds the main target exactly as `electron-vite build` does, into a temp folder: its out/main. */
async function buildMain(extra: Plugin[] = []): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'atl-build-'));
  const { config } = await resolveConfig({ configFile: 'electron.vite.config.ts', build: { outDir }, logLevel: 'silent' }, 'build', 'production');
  const main = config!.main!;
  main.plugins = [...extra, ...(main.plugins ?? [])];
  await build(main);
  return join(outDir, 'main');
}

/** Builds atelierd alone, as standaloneDaemon does after the main process: its out/main/daemon.js. */
async function buildDaemon(extra: Plugin[] = []): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'atl-build-'));
  const { config } = await resolveConfig({ configFile: 'electron.vite.daemon.config.ts', logLevel: 'silent' }, 'build', 'production');
  const daemon = config!.main!;
  daemon.build = { ...daemon.build, outDir };
  daemon.plugins = [...extra, ...(daemon.plugins ?? [])];
  await build(daemon);
  return join(outDir, 'daemon.js');
}

/** All of the app's main-process code: index.js and the chunks next to it, if any. */
function appCode(main: string): string {
  const files = readdirSync(main, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.js') && f !== 'daemon.js');
  return files.map((f) => readFileSync(join(main, f), 'utf8')).join('\n');
}

const runtime = (JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8')) as { version: string }).version;

describe('the atelierd bundle', () => {
  test('daemon.js is standalone: it requires no local chunk', async () => {
    const main = await buildMain();
    const daemon = readFileSync(join(main, 'daemon.js'), 'utf8');
    expect(daemon).toContain('unhandled promise rejection');
    expect([...daemon.matchAll(/\brequire\((["'])(\.[^"']*)\1\)/g)].map((m) => m[2])).toEqual([]);
    // The app's own bundle is still there, and does not carry atelierd.
    expect(readFileSync(join(main, 'index.js'), 'utf8')).not.toContain('unhandled promise rejection');
  }, 120_000);

  test('a main-only change to a module atelierd uses too leaves its fingerprint as it was', async () => {
    const before = await buildMain();
    const after = await buildMain([mainOnlyChange()]);
    // The probe did reach the app: otherwise the test proves nothing.
    expect(appCode(after)).toContain('main-only-probe');
    expect(daemonFingerprint(join(after, 'daemon.js'), runtime)).toBe(daemonFingerprint(join(before, 'daemon.js'), runtime));
  }, 120_000);

  test('atelierd leaves out what only the app uses of a module they share', async () => {
    const before = await buildDaemon();
    const hits = { shells: 0 };
    const after = await buildDaemon([mainOnlyChange(hits)]);
    expect(hits.shells).toBe(1);
    expect(readFileSync(after, 'utf8')).not.toContain('main-only-probe');
    expect(daemonFingerprint(after, runtime)).toBe(daemonFingerprint(before, runtime));
  }, 120_000);
});
