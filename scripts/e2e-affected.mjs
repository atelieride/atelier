// npm run e2e:affected [-- --list] [-- --base <ref>]: builds once and runs only the e2e this change can affect.
// The change: commits since <base> plus uncommitted and untracked files;
// <base> is origin/main on main (unpushed work of every session included), main's merge-base elsewhere. The selection
// is scripts/e2e-select.mjs on the map in tests/e2e/areas.ts and the app's import graph; anything it can't place runs
// the whole suite.
// --all (npm run e2e): the whole suite, built here (anything after it goes to Playwright: npm run e2e -- <spec>). --gate (npm run release): exit 0 when the last green full run covers
// HEAD, 10 when it doesn't. Both builds say which HEAD they built (ATELIER_E2E_BUILT_HEAD) when no uncommitted file
// reaches the e2e, so the full-green reporter stamps only what was really built and tested.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appCommits, countTests, fullRunGate, fullRunReminder, importGraph, parseLog, pickStamp, pkgChange, porcelainPaths,
  reminderStamp, removedStrings, report, select, stampBlockers
} from './e2e-select.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Windows: npm and npx are .cmd scripts, which Node only starts through a shell (fixed arguments here).
const WIN = process.platform === 'win32';
const NPM = WIN ? 'npm.cmd' : 'npm';
const NPX = WIN ? 'npx.cmd' : 'npx';
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const gitOk = (...args) => { try { git(...args); return true; } catch { return false; } };
const lines = (s) => s.split('\n').filter(Boolean);
const USAGE = 'Usage: npm run e2e:affected [-- --list] [-- --base <ref>]   (npm run e2e: --all; npm run release: --gate)';

function options(argv) {
  const o = { list: false, base: undefined, gate: false, all: false, pass: [] };
  for (let i = 0; i < argv.length; i++) {
    // npm run e2e -- <specs or Playwright flags>: passed on (the stamp needs the whole, unfiltered suite)
    if (o.all) o.pass.push(argv[i]);
    else if (argv[i] === '--list') o.list = true;
    else if (argv[i] === '--gate') o.gate = true;
    else if (argv[i] === '--all') o.all = true;
    else if (argv[i] === '--base') o.base = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}\n${USAGE}`);
  }
  return o;
}

function baseRef(o) {
  if (o.base) return o.base;
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  if (branch === 'main') return 'origin/main';
  return git('merge-base', 'HEAD', 'main').trim();
}

const tracked = (...paths) => lines(git('ls-files', '--cached', '--others', '--exclude-standard', ...paths));

/** Text of the given files that still exist (deleted ones in the tree are skipped). */
function readAll(paths) {
  const out = {};
  for (const p of paths) {
    try {
      if (statSync(join(ROOT, p)).size > 2 * 1024 * 1024) continue;
      out[p] = readFileSync(join(ROOT, p), 'utf8');
    } catch { /* deleted in the tree */ }
  }
  return out;
}

function packageAt(ref) {
  try { return JSON.parse(git('show', `${ref}:package.json`)); } catch { return null; }
}

const dirtyPaths = () => porcelainPaths(git('status', '--porcelain', '-z', '--untracked-files=all'));

/** Strict wiring files (strings): the strings their changed or removed lines had since <base>, committed or not. */
function removedSince(paths, base) {
  return Object.fromEntries(paths.map((p) => [p, removedStrings(git('diff', '-U0', '--no-renames', base, '--', p))]));
}

const readRuns = async () => {
  const { readStamps } = await import('../tests/support/full-green.ts');
  return readStamps(resolve(ROOT, git('rev-parse', '--git-common-dir').trim(), 'atelier-e2e-full-green'));
};
const descends = (to) => (sha) => gitOk('merge-base', '--is-ancestor', sha, to);
/** Merges listed with their changes against the first parent (a conflict resolution counts), renames as both paths. */
const commitsSince = (sha, to, ...extra) =>
  parseLog(git('log', ...extra, '--diff-merges=first-parent', '--no-renames', '--format=%x00%s', '--name-only', `${sha}..${to}`));

/** The line about the last green full run: app changes on main since its commit. */
async function reminder(map) {
  const r = reminderStamp(await readRuns(), descends('main'), descends('HEAD'));
  const commits = r.usable && r.onMain ? commitsSince(r.stamp.sha, 'main', '--first-parent') : [];
  return fullRunReminder({ ...r, appCommits: appCommits(commits, map) });
}

/** For npm run release: the newest green run HEAD descends from, and what changed since. */
async function gate(map) {
  const { stamp, isAncestor } = pickStamp(await readRuns(), descends('HEAD'));
  const g = fullRunGate({ stamp, isAncestor, commits: isAncestor ? commitsSince(stamp.sha, 'HEAD') : [], map });
  console.log(g.why);
  return g.ok ? 0 : 10;
}

/** Builds, then runs Playwright on `files` (none: the whole suite, which the full-green reporter can stamp). */
function buildAndRun(files, map) {
  const head = git('rev-parse', 'HEAD').trim();
  const blockers = stampBlockers(dirtyPaths(), map);
  const build = spawnSync(NPM, ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: WIN });
  if (build.status !== 0) return build.status ?? 1;
  const env = { ...process.env, ATELIER_E2E_BUILT_HEAD: blockers.length ? '' : head };
  const run = spawnSync(NPX, ['playwright', 'test', ...files], { cwd: ROOT, stdio: 'inherit', env, shell: WIN });
  return run.status ?? 1;
}

async function main() {
  if (!process.features.typescript) {
    throw new Error(`e2e:affected reads tests/e2e/areas.ts directly: it needs Node 22.18 or later (this is ${process.version}).`);
  }
  const o = options(process.argv.slice(2));
  const map = await import('../tests/e2e/areas.ts');
  if (o.gate) return gate(map);
  if (o.all) return buildAndRun(o.pass, map);
  const base = baseRef(o);
  const changed = [...new Set([...lines(git('diff', '--name-only', '--no-renames', `${base}...HEAD`)), ...dirtyPaths()])].sort();
  const pkg = changed.includes('package.json') ? pkgChange(packageAt(base), JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))) : 'scripts';
  const sources = readAll(tracked('tests'));
  const graph = importGraph(readAll(tracked('src').filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p))), tracked());
  const strict = changed.filter((p) => map.STRICT_WIRING.some((s) => p.startsWith(s)));
  const result = select({ changed, pkgChange: pkg, sources, map, graph, removed: removedSince(strict, base) });
  // Every spec on disk (a new one not in SPECS yet still runs when changed, and counts)
  const tests = Object.fromEntries(Object.entries(sources).filter(([p]) => /^tests\/e2e\/[^/]+\.spec\.ts$/.test(p)).map(([p, src]) => [p.slice('tests/e2e/'.length), countTests(src)]));
  const short = git('rev-parse', '--short', base).trim();
  console.log(report({
    result,
    base: o.base ?? (base === 'origin/main' ? `origin/main (${short})` : `main (${short})`),
    changed: changed.length,
    tests,
    rendererChanged: changed.some((p) => p.startsWith('src/renderer/')),
    reminder: await reminder(map)
  }).join('\n'));
  if (o.list) {
    if (result.mode === 'some') console.log(result.specs.map((s) => `  tests/e2e/${s}`).join('\n'));
    return 0;
  }
  if (result.mode === 'none') return 0;
  return buildAndRun(result.mode === 'all' ? [] : result.specs.map((s) => `tests/e2e/${s}`), map);
}

main().then((code) => process.exit(code), (err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
