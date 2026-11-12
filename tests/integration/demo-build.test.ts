import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { build, type Plugin } from 'vite';
import { beforeAll, describe, expect, test } from 'vitest';
import { demoConfig, type DemoBuildStats } from '../../src/demo/compile/build';
import { BUILD_TIME_ONLY, graphViolations } from '../../src/demo/compile/guard';
import { SENSITIVE, SHOTS_ONLY, findBanned } from '../support/banned-strings';

// The website's live demo bundle: built here once with Vite's API into a temp folder, exactly
// as `npm run build:demo` builds it, then checked: nothing of main, the preload, atelierd or the build-time compiler;
// none of the state-detection functions (their output ships, never they); the first-paint budget; the page's CSP,
// noindex, manifest and licence notices; no sourcemaps and no comments.

// +1 KB for Find in Files: a result's file opened at its match (the store's action, the editor's hand-off to its module).
const BUDGET = 901 * 1024;
const SHARED = resolve('src/shared');
const INSTALL = resolve('src/demo/install.ts');

async function buildDemo(plugins: Plugin[] = []): Promise<{ out: string; stats: DemoBuildStats }> {
  const out = join(mkdtempSync(join(tmpdir(), 'atl-demo-')), 'demo-app');
  let stats: DemoBuildStats | null = null;
  // As `npm run build:demo` runs: Vite (and the React plugin's JSX transform) take production from NODE_ENV, which
  // vitest sets to 'test' — a development build would embed this machine's file paths.
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await build({ ...demoConfig({ outDir: out, onStats: (s) => { stats = s; }, plugins }), configFile: false, logLevel: 'silent' });
  } finally { process.env.NODE_ENV = env; }
  if (!stats) throw new Error('the build reported no stats');
  return { out, stats };
}

const brotli = (b: Buffer) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

describe('demo build', () => {
  let out = '';
  let stats: DemoBuildStats;
  beforeAll(async () => { ({ out, stats } = await buildDemo()); }, 180_000);

  test('the graph is the renderer, the bridge and the compiled world — nothing else of the app', () => {
    const ids = stats.modules.map((m) => m.id);
    expect(ids).toContain(resolve('src/renderer/main.tsx'));
    expect(ids).toContain(INSTALL);
    expect(ids).toContain('\0virtual:demo-world');
    expect(stats.modules.some((m) => m.worker)).toBe(true); // the workers' graphs are checked too
    expect(graphViolations(stats.modules)).toEqual([]);
  });

  test("the shared modules the renderer uses are there, but not the build-time functions' exports", () => {
    const session = stats.modules.find((m) => m.id === join(SHARED, 'session.ts'));
    expect(session, 'shared/session.ts is in the bundle (the renderer uses describeTool)').toBeDefined();
    for (const m of stats.modules) for (const name of BUILD_TIME_ONLY) expect(m.exports, `${name} in ${m.id}`).not.toContain(name);
  });

  test('first paint within the budget (entry, its static imports, their CSS; brotli)', () => {
    const { manifest } = stats;
    const size = manifest.firstPaint.reduce((sum, f) => sum + brotli(readFileSync(join(out, f))), 0);
    const fonts = manifest.fonts.reduce((sum, f) => sum + readFileSync(join(out, f)).length, 0);
    console.log(`demo first paint: ${(size / 1024).toFixed(0)} KB brotli (+ fonts ${(fonts / 1024).toFixed(0)} KB woff2)`);
    expect(manifest.firstPaint[0]).toBe(manifest.entry);
    expect(manifest.firstPaint.some((f) => f.endsWith('.css'))).toBe(true);
    expect(manifest.fonts).toHaveLength(4);
    // The only themes with Poppins are out of the demo: its faces and their module stay out too.
    expect(readdirSync(join(out, 'assets')).filter((f) => /poppins/i.test(f))).toEqual([]);
    expect(size).toBeLessThanOrEqual(BUDGET);
  }, 120_000); // brotli at quality 11 over ~2.7 MB: seconds, more under a loaded full run

  test('manifest.json is what the site reads, every file in it exists', () => {
    const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(m).toEqual(stats.manifest);
    for (const f of [...m.firstPaint, ...m.fonts]) expect(existsSync(join(out, f)), f).toBe(true);
    expect(m.entry).toMatch(/^assets\/index-[\w-]+\.js$/);
  });

  test("the page: CSP without network, noindex, the demo's title, scripts from files only", () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("worker-src 'self'");
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('<title>Atelier | Live demo</title>');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(html).toContain(`src="/demo-app/${stats.manifest.entry}"`);
  });

  test('licenses.txt carries the bundled packages and the app’s own notices', () => {
    const text = readFileSync(join(out, 'licenses.txt'), 'utf8');
    for (const name of ['react@', 'react-dom@', '@xterm/xterm@', '@codemirror/view@', 'zustand@', '@shikijs/core@', 'vite@']) expect(text).toContain(`==== ${name}`);
    expect(text).toContain('MIT License');
    expect(text).toContain('==== OFL-InstrumentSans ====');
    expect(text).not.toMatch(/\/Users\//);
  });

  test('no sourcemaps, no comments (licence headers included: they travel in licenses.txt)', () => {
    const files = readdirSync(join(out, 'assets'));
    expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
    for (const f of files.filter((x) => /\.(js|css)$/.test(x))) {
      const text = readFileSync(join(out, 'assets', f), 'utf8');
      expect(text, f).not.toContain('sourceMappingURL');
      expect(text, f).not.toMatch(/\/\*[!*]|@license|@preserve/);
      // No path of the machine that built it (a development JSX transform embeds file names).
      expect(text, f).not.toContain(resolve('.'));
    }
  });

  test("React's production build, as `npm run build:demo` ships it (vitest's NODE_ENV=test must not leak in)", () => {
    const entry = readFileSync(join(out, stats.manifest.entry), 'utf8');
    expect(entry).not.toContain('should have a unique "key" prop');
  });

  // The site's dist guard (site/tests/build/guard.test.ts) scans demo-app/ too; failing here first names the source.
  // licenses.txt is third-party notices: their authors' addresses (gmail…) are theirs to publish, the rest still applies.
  // Every other file never names the author either (SHOTS_ONLY): the site's footer does on purpose, the demo never.
  test('nothing sensitive in the bundle (the site guard’s SENSITIVE list, and no author outside the notices)', () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const hits = walk(out).filter((f) => /\.(html|js|css|json|txt)$/.test(f)).flatMap((f) => {
      const patterns = f.endsWith('licenses.txt') ? SENSITIVE.filter((p) => !/gmail/.test(p.source)) : [...SENSITIVE, ...SHOTS_ONLY];
      return findBanned(readFileSync(f, 'utf8'), patterns).map((h) => `${f.slice(out.length + 1)}: ${h}`);
    });
    expect(hits).toEqual([]);
  });

  test('dictation is not bundled: no AudioWorklet, no getUserMedia', () => {
    const js = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
    expect(js).not.toContain('audioWorklet');
    expect(js).not.toContain('getUserMedia');
  });

  // The notification chime and dictation's tones are swapped for silent ones: a page on the site never makes a sound.
  test('the demo is silent: no AudioContext, no oscillator', () => {
    const js = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
    expect(js.includes('AudioContext')).toBe(false);
    expect(js.includes('createOscillator')).toBe(false);
  });
});

// Mutation checks: the guard runs inside the build itself (the page's and each worker's generateBundle), so
// `npm run build:demo` — hence the site build and its deploy — fails, naming what broke the rule. It must catch a
// build-time function reaching the bundle directly, through a module the runtime imports (Rollup keeps a function
// another kept function calls: its export is rendered), or inside a worker's graph.
describe('demo build guard (mutations)', () => {
  const TRIGGERS_WORKER = resolve('src/renderer/terminal/triggers.worker.ts');
  /** Adds `code` to the top of `top` (install.ts by default) and `extra` to the end of a shared module, in this build only. */
  const inject = (code: string, file?: string, extra?: string, top = INSTALL): Plugin => ({
    name: 'test-inject', enforce: 'pre',
    transform(src, id) {
      if (id === top) return `${code}\n${src}`;
      if (file && id === join(SHARED, file)) return `${src}\n${extra}`;
      return null;
    }
  });
  /** The real config (no onStats: what vite.demo.config.ts builds), with the injections. */
  const buildPlain = async (plugins: Plugin[], workerPlugins: Plugin[] = []): Promise<string> => {
    const out = join(mkdtempSync(join(tmpdir(), 'atl-demo-')), 'demo-app');
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await build({ ...demoConfig({ outDir: out, plugins, workerPlugins }), configFile: false, logLevel: 'silent' });
    } finally { process.env.NODE_ENV = env; }
    return out;
  };

  test('a runtime import of reduceHook fails the build itself, naming the function; nothing is written', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'atl-demo-')), 'demo-app');
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const run = build({ ...demoConfig({ outDir: out, plugins: [inject("import { reduceHook } from '@shared/session';\nconsole.log(reduceHook(null, {}, 0));")] }), configFile: false, logLevel: 'silent' })
      .finally(() => { process.env.NODE_ENV = env; });
    await expect(run).rejects.toThrow(/demo build: code that must not ship[\s\S]*build-time function reduceHook from .*src\/shared\/session\.ts/);
    expect(existsSync(join(out, 'index.html'))).toBe(false);
  }, 180_000);

  test('backgroundWork reached through another shared function fails the build too', async () => {
    await expect(buildPlain([inject(
      "import { probeWork } from '@shared/background';\nconsole.log(probeWork());", 'background.ts',
      'export function probeWork() { return backgroundWork({ background: { items: [], crons: [] } } as never, null, 0, { countAsWork: true }); }'
    )])).rejects.toThrow(/build-time function backgroundWork/);
  }, 180_000);

  test('a backend-only shared module (a path, whatever it exports) fails the build', async () => {
    await expect(buildPlain([inject("import { TIMELINE_SHOWN } from '@shared/transcript';\nconsole.log(TIMELINE_SHOWN, String(Math.random()));")]))
      .rejects.toThrow(/backend-only shared module: src\/shared\/transcript\.ts/);
  }, 180_000);

  test('a build-time function inside a worker fails the build', async () => {
    await expect(buildPlain([], [inject("import { parseInfo } from '@shared/redis';\nconsole.log(parseInfo(String(self)));", undefined, undefined, TRIGGERS_WORKER)]))
      .rejects.toThrow(/build-time function parseInfo/);
  }, 180_000);
});
