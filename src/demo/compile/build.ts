// The demo's Vite build (vite.demo.config.ts): the real renderer with the fake backend,
// minified, no sourcemaps, comments stripped, hashed chunks, into site/public/demo-app/. The plugins here run in Node at
// build time: the compiled world as `virtual:demo-world`, dictation's recorder and the app's sounds swapped for inert
// ones, the bundled packages' license notices, the manifest the site prefetches from, and (for the guard tests) the module graph.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { OutputBundle, OutputChunk } from 'rollup';
import { runnerImport, type Plugin, type UserConfig } from 'vite';
import { DEMO_BASE } from '../protocol';
import { graphViolations } from './guard';

const REPO = resolve(__dirname, '../../..');
const DEMO = join(REPO, 'src/demo');
export const DEMO_OUT = join(REPO, 'site/public/demo-app');

const WORLD_ID = 'virtual:demo-world';
const WORLD_RESOLVED = `\0${WORLD_ID}`;

/** `virtual:demo-world`: the world compiled now, in Node, serialized as JSON (never the compiler itself). */
export function demoWorld(): Plugin {
  return {
    name: 'atelier-demo-world',
    resolveId: (id) => (id === WORLD_ID ? WORLD_RESOLVED : null),
    // JSON.parse of a string literal: faster to start than the same object as a JS literal.
    async load(id) {
      if (id !== WORLD_RESOLVED) return null;
      // Through Vite's module runner with the app's @shared alias, not the config's bundle: the Redis queues are read by
      // main's own adapters (compile/redis-queues.ts), whose imports use the alias the config bundler can't resolve.
      const { module } = await runnerImport<typeof import('./index')>(join(DEMO, 'compile/index.ts'), { configFile: false, logLevel: 'warn', resolve: { alias: { '@shared': join(REPO, 'src/shared') } } });
      return `export default JSON.parse(${JSON.stringify(JSON.stringify(await module.compileDemoWorld()))});`;
    }
  };
}

/**
 * The app's modules the demo swaps for its own (stubs/): dictation's recorder (microphone, AudioWorklet), so the engine
 * is never bundled; the notification chime and dictation's tones, so a page on the site never makes a sound; the two
 * company-named themes (their list and their stylesheet, also read as text), so the site never names the company,
 * and their typeface's files.
 */
const STUBS = new Map([
  [join(REPO, 'src/renderer/dictation/recorder.ts'), join(DEMO, 'stubs/recorder.ts')],
  [join(REPO, 'src/renderer/chime.ts'), join(DEMO, 'stubs/chime.ts')],
  [join(REPO, 'src/renderer/dictation/sounds.ts'), join(DEMO, 'stubs/sounds.ts')],
  [join(REPO, 'src/shared/themes-docsy.ts'), join(DEMO, 'stubs/themes-docsy.ts')],
  [join(REPO, 'src/renderer/themes-docsy.css'), join(DEMO, 'stubs/themes-docsy.css')],
  [join(REPO, 'src/renderer/fonts-poppins.ts'), join(DEMO, 'stubs/theme-faces.ts')]
]);

export function demoStubs(): Plugin {
  return {
    name: 'atelier-demo-stubs',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!/(?:recorder|chime|sounds|themes-docsy|fonts-poppins)(?:\.ts|\.css)?(?:\?raw)?$/.test(source)) return null;
      const r = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!r) return null;
      // A query (`?raw`: the stylesheet read as text) stays on the stand-in.
      const stub = STUBS.get(cleanId(r.id));
      return stub ? stub + (/\?.*$/.exec(r.id)?.[0] ?? '') : null;
    }
  };
}

/** A bundled module's id without the query (`?url`, `?worker`) or the virtual prefix. */
const cleanId = (id: string) => id.replace(/^\0/, '').replace(/\?.*$/, '');

/** The package folder a module comes from (the innermost node_modules entry, scoped or not), or null. */
export function packageRoot(id: string): string | null {
  const at = id.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const rest = id.slice(at + '/node_modules/'.length).split('/');
  const n = rest[0]?.startsWith('@') ? 2 : 1;
  return rest.length > n ? id.slice(0, at + '/node_modules/'.length) + rest.slice(0, n).join('/') : null;
}

const NOTICE = /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i;

/** licenses.txt: every bundled package's notice (name, version, licence, its LICENSE/NOTICE files), then the app's own assets/licenses. */
export function licensesText(packages: Iterable<string>): string {
  const parts: string[] = ['Atelier live demo: third-party notices', '', 'The demo bundles the following packages. Their licences require these notices to travel with copies.', ''];
  const seen = new Map<string, string>();
  for (const dir of packages) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string; license?: string };
    const name = pkg.name ?? dir.split('/').at(-1)!;
    if (seen.has(name)) continue;
    const texts = readdirSync(dir).filter((f) => NOTICE.test(f)).sort().map((f) => readFileSync(join(dir, f), 'utf8').trim());
    seen.set(name, [`==== ${name}@${pkg.version ?? '?'} (${pkg.license ?? 'see package'}) ====`, '', ...(texts.length ? texts : [`Licensed under ${pkg.license ?? 'its own terms'}.`]), ''].join('\n'));
  }
  for (const name of [...seen.keys()].sort()) parts.push(seen.get(name)!);
  const own = join(REPO, 'assets/licenses');
  for (const f of readdirSync(own).filter((x) => x.endsWith('.txt')).sort()) parts.push(`==== ${f.replace(/\.txt$/, '')} ====`, '', readFileSync(join(own, f), 'utf8').trim(), '');
  return parts.join('\n');
}

/** What the site reads: paths relative to the demo's base. */
export interface DemoManifest {
  entry: string;
  /** The entry and its static imports, and their CSS: what the first frame needs. */
  firstPaint: string[];
  /** Fonts the app loads before its first frame (fonts.ts), listed apart. */
  fonts: string[];
}

/** The entry chunk and everything it imports statically, with their CSS and assets. */
export function firstPaintOf(bundle: OutputBundle): DemoManifest {
  const chunks = Object.values(bundle).filter((f): f is OutputChunk => f.type === 'chunk');
  const entry = chunks.find((c) => c.isEntry);
  if (!entry) throw new Error('demo build: no entry chunk');
  const js: string[] = [];
  const css = new Set<string>();
  const assets = new Set<string>();
  const visit = (c: OutputChunk) => {
    if (js.includes(c.fileName)) return;
    js.push(c.fileName);
    for (const f of c.viteMetadata?.importedCss ?? []) css.add(f);
    for (const f of c.viteMetadata?.importedAssets ?? []) assets.add(f);
    for (const i of c.imports) { const next = bundle[i]; if (next?.type === 'chunk') visit(next); }
  };
  visit(entry);
  return { entry: entry.fileName, firstPaint: [...js, ...css], fonts: [...assets].filter((f) => /\.woff2?$/.test(f)) };
}

/** One bundled module (main bundle or a worker's) and the exports of it that made it into the output. */
export interface DemoModule { id: string; exports: string[]; worker: boolean }
export interface DemoBuildStats { modules: DemoModule[]; manifest: DemoManifest }

/** The build error for the guard's findings, with paths relative to the repo. */
const exposureError = (bad: string[]) =>
  `demo build: code that must not ship is in the bundle (src/demo/compile/guard.ts):\n${bad.map((b) => `  - ${b.split(`${REPO}/`).join('')}`).join('\n')}`;

const modulesOf = (bundle: OutputBundle, worker: boolean): DemoModule[] =>
  Object.values(bundle).flatMap((f) => (f.type === 'chunk' ? Object.entries(f.modules).map(([id, m]) => ({ id, exports: m.renderedExports, worker })) : []));

/**
 * The build's own plugins, shared by the page and its workers: licences of every bundled package (workers included),
 * licenses.txt and manifest.json in the output, the code-exposure guard (a violation fails the build, so
 * nothing that breaks the rule can reach the site), and the module graph handed to `onStats` (guard tests only:
 * absolute paths never ship).
 *
 * Workers are bundled while the page's modules load (Vite's workerFileToUrl, from the page's transform), so their
 * generateBundle runs before the page's: each worker checks its own graph, and the page checks its own plus theirs.
 */
export function demoOutputs(onStats?: (s: DemoBuildStats) => void): { page: Plugin; worker: () => Plugin } {
  const packages = new Set<string>();
  const workerModules: DemoModule[] = [];
  const collect = (bundle: OutputBundle) => {
    for (const f of Object.values(bundle)) {
      if (f.type !== 'chunk') continue;
      for (const id of Object.keys(f.modules)) {
        const p = packageRoot(cleanId(id));
        if (p) packages.add(p);
        // Vite's own helpers (\0vite/preload-helper…) are its code too.
        else if (id.startsWith('\0vite/')) packages.add(join(REPO, 'node_modules/vite'));
      }
    }
  };
  return {
    page: {
      name: 'atelier-demo-outputs',
      apply: 'build',
      enforce: 'post',
      generateBundle(_options, bundle) {
        const modules = [...modulesOf(bundle, false), ...workerModules];
        const bad = graphViolations(modules);
        if (bad.length) this.error(exposureError(bad));
        collect(bundle);
        const manifest = firstPaintOf(bundle);
        this.emitFile({ type: 'asset', fileName: 'manifest.json', source: `${JSON.stringify(manifest, null, 2)}\n` });
        this.emitFile({ type: 'asset', fileName: 'licenses.txt', source: licensesText(packages) });
        onStats?.({ modules, manifest });
      }
    },
    worker: () => ({
      name: 'atelier-demo-worker-outputs',
      generateBundle(_options, bundle) {
        const modules = modulesOf(bundle, true);
        const bad = graphViolations(modules);
        if (bad.length) this.error(exposureError(bad));
        collect(bundle);
        workerModules.push(...modules);
      }
    })
  };
}

function appVersion(): string {
  return (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version;
}

/** The demo's Vite config; tests pass another `outDir`, an `onStats` and plugins to inject (page and workers). */
export function demoConfig(opts: { outDir?: string; onStats?: (s: DemoBuildStats) => void; plugins?: Plugin[]; workerPlugins?: Plugin[] } = {}): UserConfig {
  const outputs = demoOutputs(opts.onStats);
  const outDir = opts.outDir ?? DEMO_OUT;
  if (!existsSync(dirname(outDir))) throw new Error(`demo build: ${dirname(outDir)} does not exist`);
  return {
    root: DEMO,
    base: DEMO_BASE,
    publicDir: false,
    logLevel: 'warn',
    resolve: { alias: { '@shared': join(REPO, 'src/shared') } },
    // Production code whatever NODE_ENV the caller runs with (vitest sets 'test': React's development build).
    mode: 'production',
    define: { __ATELIER_VERSION__: JSON.stringify(appVersion()), 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins: [...(opts.plugins ?? []), demoWorld(), demoStubs(), react(), outputs.page],
    // The Shiki worker loads its languages with dynamic imports: ES workers, as in the app.
    worker: { format: 'es', plugins: () => [...(opts.workerPlugins ?? []), demoStubs(), outputs.worker()] },
    // Comments out, licence headers included: the notices travel in licenses.txt.
    esbuild: { legalComments: 'none' },
    build: {
      outDir,
      emptyOutDir: true,
      minify: 'esbuild',
      cssMinify: 'esbuild',
      sourcemap: false,
      manifest: false,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 4096,
      rollupOptions: { output: { entryFileNames: 'assets/[name]-[hash].js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' } }
    }
  };
}
