import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runScripts } from '../support/workflow-text';

// Static guards on .github/workflows/ci.yml: when it runs, what it may touch, what it checks.
const root = join(__dirname, '../..');
const workflows = join(root, '.github/workflows');
const path = join(workflows, 'ci.yml');
const text = existsSync(path) ? readFileSync(path, 'utf8') : '';

/** The text of each job under `jobs:` (two-space indented keys). */
function jobs(): Record<string, string> {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  const out: Record<string, string> = {};
  let name: string | null = null;
  for (const line of body.split('\n')) {
    const m = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (m) { name = m[1]!; out[name] = ''; continue; }
    if (name) out[name] += `${line}\n`;
  }
  return out;
}

/** The `on:` block. */
function triggers(): string {
  const start = text.indexOf('\non:\n');
  expect(start).toBeGreaterThan(-1);
  const rest = text.slice(start + 5);
  return rest.slice(0, rest.search(/\n\S/));
}

test('runs on pull requests to main, weekly and on demand, never on push', () => {
  const on = triggers();
  expect(on).toMatch(/^ {2}pull_request:\n {4}branches: \[main\]$/m);
  // Weekly since 2026-10-23: one run a week, Monday night UTC, never every day.
  expect(on).toMatch(/^ {2}schedule:\n {4}- cron: '\d+ \d+ \* \* 1'$/m);
  expect(on.match(/- cron:/g)).toHaveLength(1);
  expect(on).toMatch(/^ {2}workflow_dispatch:/m);
  expect(on).not.toMatch(/^ {2}push:/m);
});

test('read-only, no secrets, credentials not kept', () => {
  expect(text).toMatch(/^permissions:\n {2}contents: read$/m);
  expect(text).not.toMatch(/\$\{\{[^}]*\bsecrets\b/);
  expect(text).not.toMatch(/write-all|:\s*write\b/);
  const checkouts = text.match(/uses: actions\/checkout@/g) ?? [];
  expect(checkouts.length).toBeGreaterThan(0);
  expect(text.match(/persist-credentials: false/g)?.length).toBe(checkouts.length);
});

test('one run per ref; only pull requests cancel the run in progress (a manual run and the weekly run never kill each other)', () => {
  expect(text).toMatch(/^concurrency:\n {2}group: ci-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m);
});

test('the weekly run tests main only when HEAD differs from the last scheduled run that ran (not by commit dates)', () => {
  const j = jobs();
  expect(Object.keys(j)).toEqual(['changes', 'app', 'app-windows', 'site']);
  const c = j.changes!;
  expect(c).toMatch(/runs-on: ubuntu-latest/);
  // Reads the run history: actions read, nothing else (no checkout needed).
  expect(c).toMatch(/^ {4}permissions:\n {6}actions: read$/m);
  expect(c).not.toMatch(/actions\/checkout@/);
  expect(c).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
  expect(c).toMatch(/gh run list [^\n]*--event schedule[^\n]*--status completed/);
  expect(c).toMatch(/select\(\.conclusion != "cancelled"\)/);
  expect(c).toMatch(/"\$GITHUB_SHA"/);
  expect(c).not.toMatch(/%ct|3600/);
  for (const name of ['app', 'app-windows', 'site']) {
    expect(j[name]).toMatch(/^ {4}needs: changes$/m);
    expect(j[name]).toMatch(/^ {4}if: needs\.changes\.outputs\.needed == 'true'$/m);
  }
});

test('the app job runs typecheck and the unit/integration tests on macOS, like the release build', () => {
  const a = jobs().app!;
  expect(a).toMatch(/^ {4}runs-on: macos-26$/m);
  expect(a).toMatch(/run: npm ci$/m);
  expect(a).toMatch(/run: npm run typecheck$/m);
  expect(a).toMatch(/brew install tmux/);
  expect(a).toMatch(/run: npm test$/m);
});

test('the app-windows job runs typecheck and the unit/integration tests on Windows, and fails the run', () => {
  const w = jobs()['app-windows']!;
  expect(w).toMatch(/^ {4}runs-on: windows-latest$/m);
  // A gate since 2026-10-21: as a non-blocking job its reds went unnoticed until the v0.2.0-beta.18 release build,
  // which tests on Windows too, stopped on them.
  expect(w).not.toMatch(/continue-on-error/);
  expect(w).toMatch(/node-version-file: \.nvmrc/);
  expect(w).toMatch(/run: npm ci$/m);
  expect(w).toMatch(/run: npm run typecheck$/m);
  expect(w).toMatch(/run: npm test$/m);
  // The Windows tests run the bridge and atelier-procs (daemon-win32, procs-win32): built before them. Found on the
  // nightly run of 2026-10-18 (ENOENT on vendor/bin/atelier-bridge.exe).
  expect(w.indexOf('run: npm run build:bridge')).toBeGreaterThan(-1);
  expect(w.indexOf('run: npm run build:bridge')).toBeLessThan(w.indexOf('run: npm test'));
  // No tmux, no Homebrew: the POSIX-only tests are left out on Windows (tests/support/posix-only.ts).
  expect(w).not.toMatch(/brew|tmux/);
});

test('the site job runs the site tests (unit, build, dist guard) on Linux', () => {
  const s = jobs().site!;
  expect(s).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
  expect(s).toMatch(/run: npm --prefix site ci$/m);
  expect(s).toMatch(/run: npm --prefix site test$/m);
});

test('the site job installs the root dependencies before building: the site build runs build:demo (vite from the root)', () => {
  const s = jobs().site!;
  // The npm cache is keyed on both lockfiles.
  expect(s).toMatch(/cache-dependency-path: \|\n {12}package-lock\.json\n {12}site\/package-lock\.json\n/);
  // Root install without lifecycle scripts: the demo build needs vite and the renderer's packages, not node-pty's
  // native build or Electron's download (esbuild runs through its platform package without its install script).
  const root = s.search(/run: npm ci --ignore-scripts$/m);
  const site = s.search(/run: npm --prefix site ci$/m);
  const build = s.search(/run: npm --prefix site test$/m);
  expect(root).toBeGreaterThan(-1);
  expect(root).toBeLessThan(build);
  expect(site).toBeLessThan(build);
});

test('GitHub expressions are never expanded inside a script (every run form: tests/support/workflow-text.ts)', () => {
  const scripts = runScripts(text);
  expect(scripts.length).toBeGreaterThanOrEqual(7);
  for (const script of scripts) expect(script, script).not.toMatch(/\$\{\{/);
});

test('every action in every workflow is pinned to a full commit SHA', () => {
  const files = readdirSync(workflows).filter((f) => /\.ya?ml$/.test(f));
  expect(files).toEqual(expect.arrayContaining(['ci.yml', 'release.yml']));
  for (const f of files) {
    for (const m of readFileSync(join(workflows, f), 'utf8').matchAll(/uses: (\S+)/g)) expect(m[1], `${f}: ${m[1]}`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  }
});

test('Dependabot keeps the action pins current (github-actions only: npm dependencies are pinned on purpose)', () => {
  const p = join(root, '.github/dependabot.yml');
  expect(existsSync(p)).toBe(true);
  const d = readFileSync(p, 'utf8');
  expect(d).toMatch(/^version: 2$/m);
  expect(d).toMatch(/package-ecosystem: github-actions/);
  expect(d).not.toMatch(/package-ecosystem: npm/);
  // Dependabot adds the colon: "CI: Bump …", like the repo's own commits.
  expect(d).toMatch(/^ {6}prefix: CI$/m);
});
