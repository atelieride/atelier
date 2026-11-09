import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { posixRel } from '../support/platform';
import { BACKEND_ONLY_SHARED, BUILD_TIME_ONLY, graphViolations } from '../../src/demo/compile/guard';

// The demo's two halves: the runtime (bridge, engine,
// shell, stubs, the entry) plays compiled snapshots and never imports the compiler or the state-detection functions;
// the app (main, preload, atelierd, renderer, shared) never imports the demo. A source scan, quick and readable; the
// build test (demo-build.test.ts) checks the same on Rollup's graph, transitively.

const DEMO = resolve('src/demo');
const files = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)).map((f) => join(dir, f));

/** Each import/export-from of a source: what it imports and from where. `*` stands for every export of the module
 *  (`export * from`, `export * as ns from`, `import * as ns from`): the module's whole surface is reachable. */
export function importsOf(src: string): { names: string[]; from: string }[] {
  const out: { names: string[]; from: string }[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g;
  for (const m of src.matchAll(re)) {
    if (m[4] || m[5] || m[6]) { out.push({ names: [], from: (m[4] ?? m[5] ?? m[6])! }); continue; }
    if (m[1]) continue; // type-only: erased
    const star = /^\*|,\s*\*/.test(m[2]!.trim()) ? ['*'] : [];
    const names = (/\{([\s\S]*)\}/.exec(m[2]!)?.[1] ?? '').split(',').map((n) => n.trim()).filter((n) => n && !n.startsWith('type ')).map((n) => n.split(/\s+as\s+/)[0]!.trim());
    out.push({ names: [...star, ...names], from: m[3]! });
  }
  return out;
}

/** What a source loads as soon as it runs: its imports but the dynamic `import()` calls (those load on demand). */
export function staticImportsOf(src: string): { names: string[]; from: string }[] {
  return importsOf(src.replace(/import\(\s*['"][^'"]+['"]\s*\)/g, 'null'));
}

/**
 * Every string and template literal's body in a source, comments left out: one scan that knows both, so a quote in a
 * comment or a `//` in a string never confuses it. A template's `${…}` stays in its body.
 */
export function literalsOf(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (ch === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === '\\' ? 2 : 1;
      out.push(src.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

/** A statement's shapes, whatever their case: SELECT … FROM, INSERT INTO, UPDATE … SET, DELETE FROM, its clauses. */
const SQL_SHAPES = [/\bselect\b[\s\S]*\bfrom\b/i, /\binsert\s+into\b/i, /\bupdate\s+\S+\s+set\b/i, /\bdelete\s+from\b/i, /\bwhere\b/i, /\border\s+by\b/i, /\bgroup\s+by\b/i, /\blimit\b/i, /\boffset\b/i];

/** The literals of a source shaped like SQL. */
export function sqlLiterals(src: string): string[] {
  return literalsOf(src).filter((l) => SQL_SHAPES.some((re) => re.test(l)));
}

/** The source file an import names (the @shared alias, relative paths), or null for a package. */
function resolveImport(from: string, importer: string): string | null {
  const base = from.startsWith('@shared/') ? resolve('src/shared', from.slice('@shared/'.length)) : from.startsWith('.') ? resolve(dirname(importer), from) : null;
  if (!base) return null;
  const clean = base.replace(/\?.*$/, '');
  for (const c of [clean, `${clean}.ts`, `${clean}.tsx`, join(clean, 'index.ts'), join(clean, 'index.tsx')]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/** The names a module exports (declarations and export lists). */
function exportsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const decl = [...src.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)/gm)].map((m) => m[1]!);
  const lists = [...src.matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap((m) => m[1]!.split(',').map((n) => n.trim().split(/\s+as\s+/).at(-1)!.trim()).filter(Boolean));
  return [...decl, ...lists];
}

/** Build-time functions a star import or re-export of `from` (in `importer`) makes reachable. */
export function starLeaks(imp: { names: string[]; from: string }, importer: string): string[] {
  if (!imp.names.includes('*')) return [];
  const file = resolveImport(imp.from, importer);
  if (!file) return [];
  return exportsOf(file).filter((n) => (BUILD_TIME_ONLY as readonly string[]).includes(n));
}

/** Every source file reachable from `entries` through value imports (workers included), packages left out. */
function reachable(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const imp of importsOf(readFileSync(f, 'utf8'))) {
      const r = resolveImport(imp.from, f);
      if (r && /\.tsx?$/.test(r)) stack.push(r);
    }
  }
  return seen;
}

const runtime = files(DEMO).filter((f) => !posixRel(DEMO, f).startsWith('compile/'));

describe('demo runtime isolation', () => {
  test('the runtime sources are found (bridge, engine, the entry)', () => {
    const rel = runtime.map((f) => posixRel(DEMO, f));
    expect(rel).toEqual(expect.arrayContaining(['main.ts', 'install.ts', 'bridge/index.ts', 'engine/claude-screen.ts']));
  });

  test.each(runtime.map((f) => [posixRel(DEMO, f), f]))('%s imports no compiler, no app backend, no build-time function', (_rel, file) => {
    for (const imp of importsOf(readFileSync(file, 'utf8'))) {
      expect(imp.from, `${file}: ${imp.from}`).not.toMatch(/(?:^|\/)compile(?:\/|$)|(?:^|\/)(?:main|preload|daemon)\//);
      for (const name of BUILD_TIME_ONLY) expect(imp.names, `${file} imports ${name}`).not.toContain(name);
      expect(starLeaks(imp, file), `${file}: * from ${imp.from}`).toEqual([]);
      const target = resolveImport(imp.from, file);
      if (target) expect(BACKEND_ONLY_SHARED.map((m) => resolve('src/shared', m)), `${file} imports ${imp.from}`).not.toContain(target);
    }
  });

  // The path ban (guard.ts › BACKEND_ONLY_SHARED): exactly the shared modules that neither the real renderer (which the
  // demo bundles unchanged) nor the demo runtime reach. A new shared module main or atelierd adds is banned from the
  // bundle until someone decides otherwise; a module the renderer starts using must leave the list (or the build fails).
  // Subfolders count: Ask's backend lives in src/shared/companion/ (the chat digest, the
  // rules, the stream parser) next to the parts the renderer draws with.
  test('the backend-only shared modules are those neither the renderer nor the demo runtime reaches', () => {
    const reached = reachable([resolve('src/renderer/main.tsx'), join(DEMO, 'install.ts')]);
    const shared = readdirSync(resolve('src/shared'), { recursive: true, encoding: 'utf8' }).map((f) => f.split('\\').join('/')).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
    const unreached = shared.filter((f) => !reached.has(resolve('src/shared', f)));
    expect([...BACKEND_ONLY_SHARED].sort()).toEqual(unreached.sort());
    // Sanity: the walk does see the renderer's shared modules, workers included, and Ask's backend stays out.
    expect(reached.has(resolve('src/shared/session.ts'))).toBe(true);
    expect(reached.has(resolve('src/shared/triggers.ts'))).toBe(true);
    expect(reached.has(resolve('src/shared/companion/answer.ts'))).toBe(true);
    // The argv builder too: its allowed tools and deny rules are main's business, never the public bundle's.
    expect(BACKEND_ONLY_SHARED).toEqual(expect.arrayContaining(['companion/args.ts', 'companion/chat.ts', 'companion/rules.ts', 'companion/stream.ts']));
  });

  // A paused demo (its iframe hidden after an exit: display none keeps document.hidden false) must cost nothing:
  // anything that repeats runs on the engine's clock (engine/clock.ts), which the page's `pause` stops.
  test('nothing repeats outside the demo clock (no setInterval but the first hint\'s bounded settle)', () => {
    const BOUNDED: Record<string, string> = { 'shell/coach.ts': 'places the first hint for 2.5 s after startup, then stops' };
    const hits = runtime.filter((f) => /\bsetInterval\s*\(/.test(readFileSync(f, 'utf8'))).map((f) => posixRel(DEMO, f));
    expect(hits.filter((f) => !BOUNDED[f])).toEqual([]);
  });

  // The build-time compiler reads the app's test fake Redis through its public door (FakeRedis.command), never by
  // casting its way to a private member: a refactor of the fake must not silently break the site's build.
  test('the compiler uses only public members of the test helpers (no cast to reach a private one)', () => {
    for (const f of files(join(DEMO, 'compile'))) expect(readFileSync(f, 'utf8'), f).not.toMatch(/as unknown as \{[^}]*\bexec\b/);
  });

  // Where the demo is served: one definition (protocol.ts, read by the site's scripts), which the build's `base` uses.
  test('DEMO_BASE is defined once, in protocol.ts; the build takes it from there', () => {
    const all = files(DEMO).filter((f) => /\bconst DEMO_BASE\b|['"]\/demo-app\/['"]/.test(readFileSync(f, 'utf8'))).map((f) => posixRel(DEMO, f));
    expect(all).toEqual(['protocol.ts']);
    expect(importsOf(readFileSync(join(DEMO, 'compile/build.ts'), 'utf8'))).toContainEqual({ names: expect.arrayContaining(['DEMO_BASE']), from: '../protocol' });
  });

  // The Databases view in the demo: its engine and the world it reads (a few
  // hundred orders, their payloads) are a chunk of their own, loaded when the visitor connects — the first paint keeps
  // only the saved connection. Nothing reaches them but import().
  test('the Databases engine and its world load on demand: no static import reaches them from the entry', () => {
    const lazy = [join(DEMO, 'engine/databases.ts'), join(DEMO, 'world/databases.ts')];
    const seen = new Set<string>();
    const stack = [join(DEMO, 'install.ts')];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const imp of staticImportsOf(readFileSync(f, 'utf8'))) {
        const r = resolveImport(imp.from, f);
        if (r && r.startsWith(DEMO) && /\.tsx?$/.test(r)) stack.push(r);
      }
    }
    expect(lazy.filter((f) => seen.has(f)).map((f) => posixRel(DEMO, f))).toEqual([]);
    expect(seen.has(join(DEMO, 'bridge/databases.ts'))).toBe(true);
    expect(readFileSync(join(DEMO, 'bridge/databases.ts'), 'utf8')).toMatch(/import\(\s*'\.\.\/engine\/databases'\s*\)/);
  });

  // Filters, sorts and pages are plain JS over the world's arrays: no statement is written or parsed in the bundle (the
  // world's DDL and the overview's queries are its data, as Postgres would print them).
  test('the Databases engine and bridge build no SQL', () => {
    // Matched on the path from src/demo with "/" (Windows' paths have "\").
    const sources = runtime.filter((f) => /^(?:engine\/databases[\w-]*|bridge\/databases)\.ts$/.test(posixRel(DEMO, f)));
    expect(sources.map((f) => posixRel(DEMO, f)).sort()).toEqual(['bridge/databases.ts', 'engine/databases-rows.ts', 'engine/databases.ts']);
    for (const f of sources) expect(sqlLiterals(readFileSync(f, 'utf8')), posixRel(DEMO, f)).toEqual([]);
  });

  test.each(['main', 'preload', 'daemon', 'renderer', 'shared'])('src/%s never imports the demo', (dir) => {
    for (const f of files(resolve('src', dir))) {
      for (const imp of importsOf(readFileSync(f, 'utf8'))) expect(imp.from, `${f}: ${imp.from}`).not.toMatch(/(?:^|\/)demo\//);
    }
  });

  // Mutation checks for the Databases guards: what a module loads at once (a side-effect import beside the dynamic one
  // counts), and a statement in any literal — on several lines, in lower case — while comments and method names don't.
  test('staticImportsOf leaves out import() and keeps a side-effect import of the same module', () => {
    expect(staticImportsOf("const l = () => import('../engine/databases');")).toEqual([]);
    expect(staticImportsOf("import '../engine/databases';\nconst l = () => import('../engine/databases');").map((i) => i.from)).toEqual(['../engine/databases']);
    expect(staticImportsOf("import { a } from './x';\nimport('./y');").map((i) => i.from)).toEqual(['./x']);
  });

  test('sqlLiterals finds a statement in any string or template, whatever its case or lines; never in comments', () => {
    expect(sqlLiterals('const q = `\n  select id\n  from orders\n`;')).toHaveLength(1);
    expect(sqlLiterals("const q = 'select * from orders where id = $1';")).toHaveLength(1);
    expect(sqlLiterals('const q = "update orders set total = 0";')).toHaveLength(1);
    expect(sqlLiterals("const q = 'delete from orders';")).toHaveLength(1);
    expect(sqlLiterals('const q = `insert into orders (id) values (${id})`;')).toHaveLength(1);
    expect(sqlLiterals("const q = `${base} ORDER BY id LIMIT 100 OFFSET ${n}`;")).toHaveLength(1);
    expect(sqlLiterals("const e = { '\"': '\"', '\\\\': '\\\\' }; const g = 'group by';")).toHaveLength(1);
    expect(sqlLiterals("// SELECT * FROM orders WHERE x\napi.select('select'); /* ORDER BY id */ const m = 'Runs on your Mac';\nconst u = 'https://example.com';")).toEqual([]);
  });

  // Mutation checks: the scan sees the forms an import can take.
  test('importsOf catches named, aliased, side-effect and dynamic imports, and skips type-only ones', () => {
    expect(importsOf("import { reduceHook, describeTool as d } from '@shared/session';")).toEqual([{ names: ['reduceHook', 'describeTool'], from: '@shared/session' }]);
    expect(importsOf("import {\n  type SessionInfo,\n  backgroundWork\n} from '../../shared/background';")[0]!.names).toEqual(['backgroundWork']);
    expect(importsOf("import './compile/index';")).toEqual([{ names: [], from: './compile/index' }]);
    expect(importsOf("const m = await import('../main/work-hub');")).toEqual([{ names: [], from: '../main/work-hub' }]);
    expect(importsOf("import type { DemoWorld } from './compile/index';")).toEqual([]);
    expect(importsOf("export { parseInfo } from '@shared/redis';")).toEqual([{ names: ['parseInfo'], from: '@shared/redis' }]);
    expect(importsOf("new Worker(new URL('./triggers.worker.ts', import.meta.url))")).toEqual([{ names: [], from: './triggers.worker.ts' }]);
  });

  // Mutation checks: a star re-export or namespace import of a module with build-time functions is caught, by name.
  test('star re-exports and namespace imports reach every export: flagged when the module has build-time functions', () => {
    expect(importsOf("export * from '@shared/session';")).toEqual([{ names: ['*'], from: '@shared/session' }]);
    expect(importsOf("export * as s from '@shared/session';")).toEqual([{ names: ['*'], from: '@shared/session' }]);
    expect(importsOf("import * as s from '@shared/redis';")).toEqual([{ names: ['*'], from: '@shared/redis' }]);
    const at = join(DEMO, 'bridge/index.ts');
    expect(starLeaks(importsOf("export * from '@shared/session';")[0]!, at)).toEqual(expect.arrayContaining(['reduceHook', 'applyStatusLine', 'publicSession']));
    expect(starLeaks(importsOf("import * as r from '../../shared/redis';")[0]!, at)).toContain('parseInfo');
    expect(starLeaks(importsOf("export * from '@shared/menu-spec';")[0]!, at)).toEqual([]);
    expect(starLeaks(importsOf("import { parseInfo } from '@shared/redis';")[0]!, at)).toEqual([]); // named: checked by name
  });
});

describe('graphViolations', () => {
  const mod = (id: string, exports: string[] = []) => ({ id, exports, worker: false });
  test('names every forbidden module and every build-time export', () => {
    expect(graphViolations([
      mod('/r/src/main/index.ts'), mod('/r/src/preload/index.ts'), mod('/r/src/daemon/terminals.ts'), mod('/r/src/demo/compile/index.ts'),
      mod('/r/src/renderer/dictation/recorder.ts'), mod('/r/src/renderer/dictation/recorder.worklet.ts?worker&url'),
      mod('/r/src/shared/redis.ts', ['parseInfo', 'fmtBytes']), mod('/r/src/renderer/App.tsx', ['App']), mod('/r/tests/support/fake-redis.ts'),
      mod('/r/node_modules/some-lib/tests/helper.js'), mod('/r/src/shared/transcript.ts', ['TIMELINE_SHOWN']), mod('/r/src/shared/version.ts'),
      mod('/r/src/shared/session.ts', ['describeTool']), mod('/r/src/renderer/chime.ts'), mod('/r/src/renderer/dictation/sounds.ts'),
      mod('/r/src/demo/stubs/chime.ts')
    ])).toEqual([
      'main process: /r/src/main/index.ts', 'preload: /r/src/preload/index.ts', 'atelierd: /r/src/daemon/terminals.ts',
      'build-time compiler: /r/src/demo/compile/index.ts', 'dictation recorder: /r/src/renderer/dictation/recorder.ts',
      'dictation recorder: /r/src/renderer/dictation/recorder.worklet.ts', 'build-time function parseInfo from /r/src/shared/redis.ts',
      'test helpers: /r/tests/support/fake-redis.ts', 'backend-only shared module: /r/src/shared/transcript.ts',
      'backend-only shared module: /r/src/shared/version.ts', 'sound: /r/src/renderer/chime.ts', 'sound: /r/src/renderer/dictation/sounds.ts'
    ]);
  });
});
