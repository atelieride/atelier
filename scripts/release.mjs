// Cuts a release (npm run release -- beta|stable [--base X.Y.Z] [--dry] [--trailer "<line>"]...).
// Checks: on main, clean tree (CHANGELOG.md may be edited), in sync with origin/main, tag not taken. Then the next
// version (beta: X.Y.Z-beta.N+1, or X.Y.Z-beta.1 from --base / the next minor; stable: the current beta without its
// suffix), a CHANGELOG.md section for it (missing: a stub from the commits since the last tag is written and the script
// stops so it can be edited), the bump of package.json + package-lock.json in a "release: vX" commit, an annotated tag,
// and, after a confirmation, one atomic push of main + the tag: the tag starts .github/workflows/release.yml.
// Before the release commit, the full e2e: when the last green full run doesn't cover HEAD it
// asks to run it (`n` needs typing "release anyway").
// --dry runs the checks and prints the plan without writing anything.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CORE_VERSION, RELEASE_VERSION, changelogSection, channelOf } from './make-feed.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The app's semver rules (no leading zeros), shared with make-feed and release-ci.
const VERSION = RELEASE_VERSION;
const CORE = CORE_VERSION;

function parse(version) {
  const m = VERSION.exec(version);
  if (!m) throw new Error(`Version ${version} is neither X.Y.Z (stable) nor X.Y.Z-beta.N (beta).`);
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], beta: m[4] === undefined ? null : Number(m[4]) };
}

const cmpCore = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const coreText = (c) => c.join('.');

/** The version to release after `current`: kind 'beta' (optionally starting from `base` X.Y.Z) or 'stable'. */
export function nextVersion(current, kind, base) {
  if (kind !== 'beta' && kind !== 'stable') throw new Error(`Release kind must be beta or stable, not ${kind}.`);
  const cur = parse(current);
  if (kind === 'stable') {
    if (base !== undefined) throw new Error('A stable release takes no --base: it promotes the current beta.');
    if (cur.beta === null) throw new Error(`${current} is already stable: release a beta first, then promote it.`);
    return coreText(cur.core);
  }
  if (base === undefined) {
    if (cur.beta !== null) return `${coreText(cur.core)}-beta.${cur.beta + 1}`;
    return `${cur.core[0]}.${cur.core[1] + 1}.0-beta.1`;
  }
  const m = CORE.exec(base);
  if (!m) throw new Error(`--base must be X.Y.Z, not ${base}.`);
  const b = [Number(m[1]), Number(m[2]), Number(m[3])];
  const c = cmpCore(b, cur.core);
  if (cur.beta !== null && c === 0) return `${base}-beta.${cur.beta + 1}`;
  // A beta of an already released stable (or of an older version) would sort below what users have.
  if (c <= 0) throw new Error(`--base ${base} is older than or equal to the current version ${current}.`);
  return `${base}-beta.1`;
}

/** Commit subjects worth listing in a stub (the bump commits of earlier releases and website commits are noise). */
export function releaseSubjects(subjects) {
  return subjects.filter((s) => s.trim() && !/^release: v/.test(s) && !/^site[:(]/.test(s));
}

const STUB_MARKER = '<!-- Edit before releasing';

export function changelogStub(version, subjects) {
  const lines = subjects.length ? subjects.map((s) => `- ${s}`) : ['- (no commits since the last tag)'];
  return `## ${version}\n\n${STUB_MARKER}: user-facing, short. Commits since the last tag: -->\n${lines.join('\n')}\n`;
}

/** The section is still the generated stub: its marker comment would end up in the notes the app shows. */
export function isUneditedStub(text) {
  return text.includes(STUB_MARKER);
}

/** The section goes above the newest one (after the title and intro), or at the end of a file without sections. */
export function insertChangelogSection(text, section) {
  if (!text.trim()) return `# Changelog\n\n${section}`;
  const m = /^## /m.exec(text);
  if (!m) return `${text.trimEnd()}\n\n${section}`;
  return `${text.slice(0, m.index)}${section}\n${text.slice(m.index)}`;
}

function rewriteJson(text, edit) {
  const data = JSON.parse(text);
  // npm's own format: refuse anything we would silently reformat.
  if (`${JSON.stringify(data, null, 2)}\n` !== text) throw new Error('Unexpected JSON format (not npm\'s 2-space layout): bump the version by hand.');
  edit(data);
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function bumpPackageJson(text, version) {
  return rewriteJson(text, (d) => { d.version = version; });
}

export function bumpPackageLock(text, version) {
  return rewriteJson(text, (d) => {
    d.version = version;
    if (d.packages?.['']) d.packages[''].version = version;
  });
}

/** Paths in `git status --porcelain` that block a release: everything but CHANGELOG.md. */
export function blockingChanges(porcelain) {
  return porcelain.split('\n').filter((l) => l.length > 3)
    .map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"(.*)"$/, '$1'))
    .filter((p) => p !== 'CHANGELOG.md');
}

/**
 * The full e2e before a release. `gate()`: whether the last green full run covers HEAD, and why
 * (scripts/e2e-affected.mjs --gate). Not covered: Enter/y runs it (red stops the release), n needs "release anyway".
 */
export async function fullE2eGate({ gate, ask, runE2e, log }) {
  const g = gate();
  log(g.why);
  if (g.ok) return;
  const a = (await ask('Run the full e2e now? (Y/n) ')).trim().toLowerCase();
  if (a === '' || a === 'y' || a === 'yes') {
    if (!runE2e()) throw new Error('The full e2e failed: fix it (or rerun a flaky spec alone, then the full run) before releasing.');
    return;
  }
  const b = (await ask('Releasing without a green full e2e run. Type "release anyway" to go on: ')).trim();
  if (b !== 'release anyway') throw new Error('Release stopped: no green full e2e run.');
  log('Going on without a green full e2e run.');
}

/**
 * One question on its own readline interface, closed before returning: an open interface keeps the tty raw, so Ctrl-C
 * wouldn't stop what runs next and keys typed meanwhile would answer the following question.
 */
export async function askOnce(question, make = () => createInterface({ input: process.stdin, output: process.stdout })) {
  const rl = make();
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Keys typed ahead (during a quarter-hour e2e run) are dropped, so they never answer the push question. Only our own
 * listener goes afterwards: readline's keypress decoder is a 'data' listener attached once per stream.
 */
export async function drainInput(stream = process.stdin, ms = 150) {
  if (!stream.isTTY) return;
  const drop = () => {};
  stream.setRawMode(true);
  stream.on('data', drop);
  stream.resume();
  await new Promise((r) => setTimeout(r, ms));
  stream.pause();
  stream.removeListener('data', drop);
  stream.setRawMode(false);
}

/** What changed while the full e2e ran (other sessions merge into main): any of these stops the release. */
export function afterGateProblems({ headBefore, head, blocking, originHead }) {
  const out = [];
  if (head !== headBefore) out.push(`HEAD moved while the full e2e ran (${headBefore.slice(0, 7)} → ${head.slice(0, 7)}): run the release again.`);
  if (blocking.length) out.push(`Uncommitted changes appeared while the full e2e ran: ${blocking.join(', ')}.`);
  if (originHead !== headBefore) out.push('origin/main moved while the full e2e ran: pull, then run the release again.');
  return out;
}

function e2eGateState() {
  const r = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/e2e-affected.mjs', '--gate'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 10) throw new Error(`Checking the full e2e stamp failed:\n${r.stderr || r.stdout}`);
  return { ok: r.status === 0, why: r.stdout.trim() };
}

/** The banned strings CHANGELOG.md would put in the public demo bundle (scripts/changelog-leaks.mjs); empty: clean. */
function changelogLeaks() {
  const r = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/changelog-leaks.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 10) throw new Error(`Checking CHANGELOG.md for banned strings failed:\n${r.stderr || r.stdout}`);
  return r.status === 10 ? r.stdout.trim().split('\n') : [];
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitOk = (...args) => { try { git(...args); return true; } catch { return false; } };

function lastTag(stableOnly) {
  const args = ['describe', '--tags', '--abbrev=0', '--match', 'v*'];
  if (stableOnly) args.push('--exclude', 'v*-*');
  try { return git(...args).trim(); } catch { return null; }
}

function options(argv) {
  const o = { kind: undefined, base: undefined, dry: false, trailers: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') o.dry = true;
    else if (a === '--base') o.base = argv[++i];
    else if (a === '--trailer') o.trailers.push(argv[++i]);
    else if (!a.startsWith('--') && o.kind === undefined) o.kind = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!o.kind) throw new Error('Usage: npm run release -- beta|stable [--base X.Y.Z] [--dry] [--trailer "<line>"]');
  return o;
}

async function main() {
  const o = options(process.argv.slice(2));
  const problems = [];
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  if (branch !== 'main') problems.push(`On branch ${branch}: releases are cut from main.`);
  const dirty = blockingChanges(git('status', '--porcelain'));
  if (dirty.length) problems.push(`Uncommitted changes (only CHANGELOG.md may be edited): ${dirty.join(', ')}`);
  git('fetch', '--quiet', 'origin', 'main', '--tags');
  if (git('rev-parse', 'HEAD').trim() !== git('rev-parse', 'origin/main').trim()) problems.push('main is not in sync with origin/main: pull or push first.');

  const pkgPath = join(ROOT, 'package.json');
  const lockPath = join(ROOT, 'package-lock.json');
  const current = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  const version = nextVersion(current, o.kind, o.base);
  const tag = `v${version}`;
  if (gitOk('rev-parse', '-q', '--verify', `refs/tags/${tag}`) || git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`).trim()) {
    problems.push(`Tag ${tag} already exists.`);
  }
  if (problems.length) {
    if (!o.dry) throw new Error(problems.join('\n'));
    for (const p of problems) console.warn(`warning: ${p}`);
  }

  const changelogPath = join(ROOT, 'CHANGELOG.md');
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
  const section = changelogSection(changelog, version);
  const leaks = changelogLeaks();
  if (leaks.length) {
    const msg = `CHANGELOG.md has text the website's live demo refuses (${leaks.join(', ')}): reword it before the tag.`;
    if (!o.dry) throw new Error(msg);
    console.warn(`warning: ${msg}`);
  }
  if (section && isUneditedStub(section)) {
    const msg = `The "## ${version}" section of CHANGELOG.md is still the generated stub: edit it and remove the "${STUB_MARKER} …" comment.`;
    if (!o.dry) throw new Error(msg);
    console.warn(`warning: ${msg}`);
  }
  if (!section) {
    const since = lastTag(o.kind === 'stable');
    const log = git('log', '--pretty=format:%s', '-n', '50', ...(since ? [`${since}..HEAD`] : [])).split('\n');
    const stub = changelogStub(version, releaseSubjects(log));
    if (o.dry) {
      console.log(`CHANGELOG.md has no "## ${version}" section; the release would stop and add this stub:\n\n${stub}`);
      return;
    }
    writeFileSync(changelogPath, insertChangelogSection(changelog, stub));
    throw new Error(`CHANGELOG.md had no "## ${version}" section: a stub was added from the commits since ${since ?? 'the start'}. Edit it, then run the release again.`);
  }

  if (o.dry) {
    const g = e2eGateState();
    console.log(`Full e2e: ${g.why}${g.ok ? '' : ' The release would ask to run it.'}`);
  } else {
    const headBefore = git('rev-parse', 'HEAD').trim();
    await fullE2eGate({
      gate: e2eGateState,
      ask: askOnce,
      runE2e: () => spawnSync('npm', ['run', 'e2e'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] }).status === 0,
      log: (l) => console.log(l)
    });
    git('fetch', '--quiet', 'origin', 'main');
    const late = afterGateProblems({
      headBefore,
      head: git('rev-parse', 'HEAD').trim(),
      blocking: blockingChanges(git('status', '--porcelain')),
      originHead: git('rev-parse', 'origin/main').trim()
    });
    if (late.length) throw new Error(late.join('\n'));
  }

  console.log(`Release ${tag} (${channelOf(version)} channel), from ${current}.`);
  if (o.dry) {
    console.log(`Dry run: would commit "release: ${tag}" (package.json, package-lock.json, CHANGELOG.md), tag ${tag}, and push main + ${tag} to origin.`);
    return;
  }
  writeFileSync(pkgPath, bumpPackageJson(readFileSync(pkgPath, 'utf8'), version));
  writeFileSync(lockPath, bumpPackageLock(readFileSync(lockPath, 'utf8'), version));
  git('add', 'package.json', 'package-lock.json', 'CHANGELOG.md');
  const message = `release: ${tag}${o.trailers.length ? `\n\n${o.trailers.join('\n')}` : ''}`;
  git('commit', '-q', '-m', message);
  git('tag', '-a', tag, '-m', `Atelier ${version}`);
  console.log(`Committed "release: ${tag}" and tagged ${tag}.`);

  await drainInput();
  const answer = (await askOnce(`Push main and ${tag} to origin? This starts the release build. [y/N] `)).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    console.log(`Not pushed. When ready: git push --atomic origin main refs/tags/${tag}`);
    return;
  }
  execFileSync('git', ['push', '--atomic', 'origin', 'main', `refs/tags/${tag}`], { cwd: ROOT, stdio: 'inherit' });
  console.log(`Pushed. The release workflow builds ${tag} and creates a draft release in atelieride/atelier.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
