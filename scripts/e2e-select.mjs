// Which e2e a change runs. Pure: changed paths + the map in tests/e2e/areas.ts + the test
// sources + the app's import graph → { mode: 'all' | 'some' | 'none', specs, reasons }. scripts/e2e-affected.mjs does
// the git and the running; the full-green reporter and the release gate share the helpers at the end.
import { posix } from 'node:path';

const SPEC = /^tests\/e2e\/[^/]+\.spec\.ts$/;
const UNIT_TEST = /\.test\.(ts|tsx|mjs|js)$/;
const MANUAL = /\.manual\.ts$/;
/** Helpers and fixtures: they run the specs that name them. */
const FIXTURE_DIRS = ['tests/e2e/', 'tests/support/', 'tests/fixtures/'];
/** Seconds a test adds on average with workers: 2 (235 tests ≈ 6.5 min, measured 2026-10-21). */
const SECONDS_PER_TEST = 1.7;
/** App changes on main since the last green full run before e2e:affected asks for one. */
export const REMINDER_AFTER = 10;

const base = (p) => p.slice(p.lastIndexOf('/') + 1);
const stem = (p) => base(p).replace(/\.[^.]+$/, '');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The rule for one path: what kind of change it is, and its areas when it has some. */
export function classify(path, map) {
  if (UNIT_TEST.test(path) || MANUAL.test(path)) return { kind: 'ignored' };
  if (map.IGNORED.some((p) => path.startsWith(p))) return { kind: 'ignored' };
  if (SPEC.test(path)) return { kind: 'spec' };
  if (path === 'package.json') return { kind: 'pkg' };
  let best = null;
  const consider = (prefix, rule) => {
    if (path.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, rule };
  };
  for (const p of map.FOUNDATIONS) consider(p, { kind: 'foundation' });
  for (const p of map.WIRING) consider(p, { kind: 'wiring' });
  for (const p of map.CSS) consider(p, { kind: 'css' });
  for (const [p, areas] of Object.entries(map.SOURCES)) consider(p, { kind: 'areas', areas });
  if (best) return best.rule;
  // Markdown outside src and tests is docs, unless a rule says otherwise (CHANGELOG.md ships in What's New).
  if (path.endsWith('.md') && !path.startsWith('src/') && !path.startsWith('tests/')) return { kind: 'ignored' };
  if (FIXTURE_DIRS.some((d) => path.startsWith(d))) return { kind: 'fixture' };
  return { kind: 'unmapped' };
}

/** True when a path can affect the app's e2e at all (the release gate and the reminder count only these). */
export const reachesE2e = (path, map) => classify(path, map).kind !== 'ignored';

/**
 * A source without its comments (a helper named in a comment isn't used): line comments, and block comments that
 * open a line (a `/*` inside a string, like a glob, stays code). Other files as they are.
 */
function code(file, src) {
  if (!/\.(ts|tsx|mjs|js|cjs)$/.test(file)) return src;
  return src.replace(/^\s*\/\*[\s\S]*?\*\//gm, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

/** The folders between a fixture dir and the file (tests/fixtures/claude-image/a.txt → claude-image): code that loads
 * the folder by a built path names the folder, not the file. */
function fixtureFolders(path) {
  const dir = FIXTURE_DIRS.find((d) => path.startsWith(d));
  return dir ? path.slice(dir.length).split('/').slice(0, -1) : [];
}

/**
 * The specs a fixture or helper reaches: those that name it, directly or through helpers that name it. `env` when
 * tests/e2e/env.ts names it on the way (every spec uses env.ts); `other` when a unit test or a manual check names it.
 */
function fixtureSpecs(path, sources) {
  const specs = new Set();
  const seen = new Set([path]);
  const frontier = [stem(path).replace(/\.d$/, ''), ...fixtureFolders(path)];
  let env = false;
  let other = false;
  while (frontier.length) {
    const name = new RegExp(`(?<![\\w-])${escape(frontier.pop())}(?![\\w-])`);
    for (const [file, src] of Object.entries(sources)) {
      if (seen.has(file) || !name.test(code(file, src))) continue;
      seen.add(file);
      if (file === 'tests/e2e/env.ts') env = true;
      else if (SPEC.test(file)) specs.add(base(file));
      else if (UNIT_TEST.test(file) || MANUAL.test(file)) other = true;
      else frontier.push(stem(file));
    }
  }
  return { specs: [...specs], env, other };
}

const IMPORT = /\b(?:import|export)\s[^'";]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g;
const CODE_EXT = ['.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx'];

/**
 * The app's import graph, reversed: path → the files that import it. `sources`: path → text of the files to scan;
 * `known`: every file that exists (an import resolves to one, or to the same path plus a code extension). Relative
 * imports and the `@shared/` alias; `?raw` and other queries dropped; packages skipped.
 */
export function importGraph(sources, known = Object.keys(sources)) {
  const exists = new Set(known);
  const graph = new Map();
  for (const [file, src] of Object.entries(sources)) {
    for (const m of code(file, src).matchAll(IMPORT)) {
      const spec = (m[1] ?? m[2] ?? m[3]).replace(/\?.*$/, '');
      let target;
      if (spec.startsWith('@shared/')) target = `src/shared/${spec.slice('@shared/'.length)}`;
      else if (spec.startsWith('.')) target = posix.normalize(posix.join(posix.dirname(file), spec));
      else continue;
      const found = exists.has(target) ? target : CODE_EXT.map((e) => target + e).find((t) => exists.has(t))
        ?? (/\.[a-z0-9]+$/i.test(base(target)) ? target : undefined);
      if (!found || found === file) continue;
      if (!graph.has(found)) graph.set(found, new Set());
      graph.get(found).add(file);
    }
  }
  return graph;
}

/**
 * Areas a source file reaches through the files that import it directly: their own areas. Wiring, foundations, CSS
 * and HUBS (files that import most of the app, like the palette) add nothing: they would add every area. One step
 * only: the component tree is so connected that walking it transitively reaches most areas from any file.
 */
function importerAreas(path, own, graph, map) {
  const out = [];
  const have = new Set(own);
  const hubs = map.HUBS ?? [];
  for (const imp of [...(graph.get(path) ?? [])].sort()) {
    if (hubs.includes(imp)) continue;
    const c = classify(imp, map);
    if (c.kind !== 'areas') continue;
    for (const a of c.areas) {
      if (have.has(a)) continue;
      have.add(a);
      out.push({ area: a, via: imp });
    }
  }
  return out;
}

const LITERAL = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
/** Pieces shorter than this are too common to point at a spec ("OK", "on"). */
const MIN_STRING = 4;

const unescape = (t) => t.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, '$1');

/** A spec's string literals, lower-cased: the text it looks for (getByText, getByRole names, expectations). */
function specStrings(src) {
  return [...code('x.ts', src).matchAll(LITERAL)].map((m) => unescape(m[1] ?? m[2] ?? m[3] ?? '').toLowerCase()).filter(Boolean);
}
/** A spec string this long, or with a space, is specific enough to point at a removed string that contains it. */
const MIN_SPEC_STRING = 6;

/** The text of the string literals on the removed lines of a diff (an interpolation splits a template). */
export function removedStrings(diff) {
  const out = [];
  for (const l of diff.split('\n')) {
    if (!l.startsWith('-') || l.startsWith('---')) continue;
    for (const m of l.slice(1).matchAll(LITERAL)) {
      const text = unescape(m[1] ?? m[2] ?? m[3]);
      for (const piece of text.split(/\$\{[^}]*\}/)) if (piece.trim().length >= MIN_STRING) out.push(piece);
    }
  }
  return out;
}

/**
 * `sources`: path → text of every file under tests/ the selection may follow (specs, helpers, fixtures, unit tests,
 * manual checks), to find who names a changed fixture. `graph`: importGraph() of the app's source. `pkgChange`: what
 * changed in package.json (pkgChange()). `removed`: strict wiring file → strings its changed or removed lines had
 * (removedStrings()): the specs that mention one (case aside) run too.
 */
export function select({ changed, pkgChange = 'scripts', sources, map, graph = new Map(), removed = {} }) {
  const allReasons = [];
  const reasons = [];
  const areas = new Set();
  const specs = new Set();
  const stringSpecs = new Set();
  const wiring = [];
  let css = false;
  let other = false; // a mapped path besides wiring: an area, a spec, a fixture, CSS
  let relevant = false;
  for (const path of changed) {
    const c = classify(path, map);
    if (c.kind === 'ignored') continue;
    if (c.kind === 'spec') {
      if (!(path in sources)) continue; // deleted
      specs.add(base(path));
      reasons.push({ what: base(path), from: path, why: 'changed spec' });
      other = relevant = true;
    } else if (c.kind === 'pkg') {
      relevant = true;
      if (pkgChange === 'deps') allReasons.push({ what: 'all', from: path, why: 'dependencies' });
      else if (pkgChange === 'app') {
        for (const a of map.PKG_AREAS ?? []) {
          areas.add(a);
          reasons.push({ what: a, from: path, why: 'version or app fields' });
        }
        other = true;
      } else reasons.push({ what: 'smoke', from: path, why: 'scripts' });
    } else if (c.kind === 'foundation') {
      allReasons.push({ what: 'all', from: path, why: 'foundation' });
    } else if (c.kind === 'unmapped') {
      allReasons.push({ what: 'all', from: path, why: 'unmapped' });
    } else if (c.kind === 'wiring') {
      if ((map.STRICT_WIRING ?? []).some((p) => path.startsWith(p))) {
        // A spec mentions a removed string, or quotes part of it ("Change Language Mode" of "…Mode…"). String hits
        // don't count as more than wiring: with nothing else, wiring still runs everything.
        const strings = (removed[path] ?? []).map((t) => [t, t.trim().toLowerCase()]);
        for (const [file, src] of Object.entries(sources)) {
          if (!SPEC.test(file)) continue;
          const lits = specStrings(src).filter((l) => l.trim().length >= MIN_STRING);
          const hit = strings.find(([, t]) => lits.some((l) => l.includes(t) || ((l.length >= MIN_SPEC_STRING || l.trim().includes(' ')) && t.includes(l.trim()))));
          if (!hit) continue;
          stringSpecs.add(base(file));
          reasons.push({ what: base(file), from: path, why: `uses "${hit[0]}"` });
        }
      }
      wiring.push(path);
      reasons.push({ what: 'smoke', from: path, why: 'wiring' });
      relevant = true;
    } else if (c.kind === 'css') {
      css = relevant = true;
      reasons.push({ what: 'css', from: path });
    } else if (c.kind === 'areas') {
      for (const a of c.areas) {
        areas.add(a);
        reasons.push({ what: a, from: path });
      }
      for (const { area, via } of importerAreas(path, c.areas, graph, map)) {
        areas.add(area);
        reasons.push({ what: area, from: path, why: `via ${via}` });
      }
      other = relevant = true;
    } else if (c.kind === 'fixture') {
      const f = fixtureSpecs(path, sources);
      if (f.env) allReasons.push({ what: 'all', from: path, why: 'used by env.ts' });
      else if (!f.specs.length && f.other) continue; // only unit tests or manual checks use it
      else if (!f.specs.length) allReasons.push({ what: 'all', from: path, why: 'used by no spec' });
      else {
        for (const s of f.specs) specs.add(s);
        reasons.push({ what: f.specs.sort().join(', '), from: path, why: 'fixture' });
        other = relevant = true;
      }
    }
  }
  if (wiring.length && !other && !css) for (const w of wiring) allReasons.push({ what: 'all', from: w, why: 'wiring only' });
  const everySpec = Object.keys(map.SPECS).sort();
  if (allReasons.length) return { mode: 'all', specs: everySpec, reasons: [...allReasons, ...reasons] };
  if (!relevant) return { mode: 'none', specs: [], reasons };
  if (css && !other) for (const a of map.CSS_AREAS) areas.add(a);
  for (const [spec, as] of Object.entries(map.SPECS)) if (as.some((a) => areas.has(a))) specs.add(spec);
  for (const s of [...map.SMOKE, ...stringSpecs]) specs.add(s);
  return { mode: 'some', specs: [...specs].sort(), reasons };
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'overrides'];
/** Fields the app itself reads (the version in What's New and About, the entry, the packaging). */
const APP_FIELDS = ['name', 'productName', 'version', 'main', 'build'];
const stable = (v) => JSON.stringify(v ?? null, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));

/** What changed in package.json: `deps` (what gets installed), `app` (fields the app reads), else `scripts`. */
export function pkgChange(basePkg, pkg) {
  if (!basePkg) return 'deps';
  if (DEP_FIELDS.some((f) => stable(basePkg[f]) !== stable(pkg[f]))) return 'deps';
  if (APP_FIELDS.some((f) => stable(basePkg[f]) !== stable(pkg[f]))) return 'app';
  return 'scripts';
}

export const estimate = (tests) => `~${Math.max(1, Math.round((tests * SECONDS_PER_TEST) / 60))} min`;

/**
 * The line about the last green full run. `usable`: its commit is an ancestor of HEAD; `onMain`: also of
 * main (false: it was stamped on this branch, nothing to count on main yet).
 */
export function fullRunReminder({ stamp, usable, onMain = true, appCommits }) {
  const suggest = 'run `npm run e2e` on main before the next stage-update (not from a worktree).';
  if (!stamp) return `No green full e2e run on record: ${suggest}`;
  const sha = stamp.sha.slice(0, 7);
  if (!usable) return `The last green full run (${sha}) is not in this history: ${suggest}`;
  if (!onMain) return `Last green full run: ${sha}, on this branch (not on main yet).`;
  const n = `${appCommits} app change${appCommits === 1 ? '' : 's'} on main since`;
  return appCommits >= REMINDER_AFTER ? `Last green full run: ${sha}, ${n}: ${suggest}` : `Last green full run: ${sha}, ${n}.`;
}

/** Paths in `git status --porcelain -z`: every entry's path, and a rename's or copy's original path too. */
export function porcelainPaths(z) {
  const out = [];
  const parts = z.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    out.push(e.slice(3));
    if (/[RC]/.test(e.slice(0, 2))) out.push(parts[++i]);
  }
  return out;
}

/** Tests a spec file declares (test, test.skip/fixme/fail/only), for the counts and the estimate. */
export const countTests = (src) => (src.match(/^\s*test(\.(skip|fixme|fail|only))?\(/gm) ?? []).length;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What e2e:affected prints before running: why each area runs, how much, and the reminders. */
export function report({ result, base, changed, tests, rendererChanged, reminder }) {
  const lines = [`e2e:affected: ${plural(changed, 'changed file')} since ${base}.`];
  if (result.mode === 'none') {
    lines.push("Nothing here reaches the app's e2e (docs, site, demo, unit tests, packaging).");
  } else {
    const groups = new Map();
    for (const r of result.reasons) {
      const g = groups.get(r.what) ?? [];
      g.push(r.why ? `${r.from} (${r.why})` : r.from);
      groups.set(r.what, g);
    }
    for (const [what, paths] of groups) {
      lines.push(`  ${what} ← ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` +${paths.length - 3} more` : ''}`);
    }
    const total = Object.keys(tests).length;
    const n = result.mode === 'all' ? Object.values(tests).reduce((s, t) => s + t, 0) : result.specs.reduce((s, f) => s + (tests[f] ?? 0), 0);
    lines.push(result.mode === 'all'
      ? `Runs the whole suite: ${plural(total, 'spec file')}, ${plural(n, 'test')}, ${estimate(n)}.`
      : `Runs ${result.specs.length} of ${plural(total, 'spec file')}, ${plural(n, 'test')}, ${estimate(n)}.`);
  }
  if (rendererChanged) lines.push('The renderer changed: the live demo has its own checks (npm --prefix site run e2e:browsers).');
  if (reminder) lines.push(reminder);
  return lines;
}

/** Commits of `git log --format=%x00%s --name-only`: subject and files. */
export function parseLog(log) {
  return log.split('\0').filter((c) => c.trim()).map((c) => {
    const [subject, ...files] = c.split('\n');
    return { subject, files: files.filter(Boolean) };
  });
}

/** What `npm run release` commits: a version bump and the changelog, never a reason for another full run. */
const RELEASE_FILES = new Set(['package.json', 'package-lock.json', 'CHANGELOG.md']);
const isRelease = (c) => /^release: v\d/.test(c.subject) && c.files.every((f) => RELEASE_FILES.has(f));
const appFiles = (commits, map) => [...new Set(commits.filter((c) => !isRelease(c)).flatMap((c) => c.files.filter((p) => reachesE2e(p, map))))].sort();

/** Commits that reach the e2e (release commits aside). */
export const appCommits = (commits, map) => commits.filter((c) => !isRelease(c) && c.files.some((p) => reachesE2e(p, map))).length;

/**
 * The release gate: ok when the last green full run's commit is an ancestor of HEAD and nothing since
 * reaches the e2e. `commits`: those in <stamp>..HEAD.
 */
export function fullRunGate({ stamp, isAncestor, commits, map }) {
  if (!stamp) return { ok: false, why: 'No green full e2e run on record.' };
  const sha = stamp.sha.slice(0, 7);
  if (!isAncestor) return { ok: false, why: `The last green full e2e run (${sha}) is not in this history.` };
  const files = appFiles(commits, map);
  if (!files.length) return { ok: true, why: `The green full e2e run at ${sha} covers HEAD.` };
  const shown = files.slice(0, 5).join(', ') + (files.length > 5 ? ` +${files.length - 5} more` : '');
  return { ok: false, why: `App files changed since the last green full e2e run (${sha}): ${shown}.` };
}

/** Of the recorded green runs (newest first), the newest HEAD descends from; else the newest, not usable. */
export function pickStamp(stamps, isAncestor) {
  const hit = stamps.find((s) => isAncestor(s.sha));
  if (hit) return { stamp: hit, isAncestor: true };
  return { stamp: stamps[0] ?? null, isAncestor: false };
}

/** Uncommitted files that keep a run from counting as the HEAD's: those that reach the e2e, CHANGELOG.md aside (the
 * release edits it before its full run, and commits it with the version bump only). */
export const stampBlockers = (dirty, map) => dirty.filter((p) => p !== 'CHANGELOG.md' && reachesE2e(p, map));

/**
 * The run the reminder talks about: the newest main descends from (count main's changes since), else one only this
 * branch has (nothing to count on main yet), else the newest, not in this history.
 */
export function reminderStamp(stamps, onMain, onHead) {
  const main = stamps.find((s) => onMain(s.sha));
  if (main) return { stamp: main, usable: true, onMain: true };
  const branch = stamps.find((s) => onHead(s.sha));
  if (branch) return { stamp: branch, usable: true, onMain: false };
  return { stamp: stamps[0] ?? null, usable: false, onMain: false };
}
