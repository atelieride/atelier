import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeApp } from '../fixtures/update-fixture';
// @ts-expect-error: .mjs script without types
import { channelOf } from '../../scripts/make-feed.mjs';
// @ts-expect-error: .mjs script without types
import { afterGateProblems, askOnce, blockingChanges, drainInput, bumpPackageJson, bumpPackageLock, changelogStub, fullE2eGate, insertChangelogSection, isUneditedStub, nextVersion, releaseSubjects } from '../../scripts/release.mjs';
// @ts-expect-error: .mjs script without types
import { DMG_VOLUME, DMG_WINDOW, DMG_WINDOW_ORIGIN, RELEASE_NOTES_FOOTER, RELEASE_REQUIREMENT, attachCommand, checkFeed, defaultDiskImageTool, diskImageFormat, dmgLayoutProblems, hasDiskutilImage, withAttachedDmg, gatekeeperProblem, notarize, packageRelease, releaseMeta, requirementProblem, throwawayKey } from '../../scripts/release-ci.mjs';
// @ts-expect-error: .mjs script without types
import { embeddedKeys, publicKeyOf } from '../../scripts/sign-feed.mjs';
// @ts-expect-error: .mjs script without types
import { changelogLeaks } from '../../scripts/changelog-leaks.mjs';
import { isPosix, posixTest } from '../support/platform';

// --- scripts/release.mjs (npm run release -- beta|stable) ---

// The release asks for the full e2e when the last green full run doesn't cover HEAD.
function gateRun(gate: { ok: boolean; why: string }, answers: string[], e2eOk = true) {
  const log: string[] = [];
  const asked: string[] = [];
  let ran = 0;
  const p = fullE2eGate({
    gate: () => gate,
    ask: async (q: string) => { asked.push(q); return answers.shift() ?? ''; },
    runE2e: () => { ran++; return e2eOk; },
    log: (l: string) => log.push(l)
  });
  return { p, log, asked, ran: () => ran };
}

test('release gate: a green full run that covers HEAD asks nothing', async () => {
  const r = gateRun({ ok: true, why: 'The green full e2e run at abc1234 covers HEAD.' }, []);
  await r.p;
  expect(r.asked).toEqual([]);
  expect(r.log).toEqual(['The green full e2e run at abc1234 covers HEAD.']);
});

test('release gate: app changes since → asks; Enter or y runs npm run e2e; a red run stops the release', async () => {
  const why = 'App files changed since the last green full e2e run (abc1234): src/a.ts.';
  for (const a of ['', 'y', 'Y', 'yes']) {
    const r = gateRun({ ok: false, why }, [a]);
    await r.p;
    expect(r.asked).toEqual(['Run the full e2e now? (Y/n) ']);
    expect(r.ran()).toBe(1);
  }
  const red = gateRun({ ok: false, why }, [''], false);
  await expect(red.p).rejects.toThrow(/full e2e failed/);
});

test('release gate: n needs typing "release anyway"; anything else stops', async () => {
  const why = 'No green full e2e run on record.';
  const go = gateRun({ ok: false, why }, ['n', 'release anyway']);
  await go.p;
  expect(go.ran()).toBe(0);
  expect(go.asked[1]).toMatch(/Type "release anyway"/);
  expect(go.log.at(-1)).toMatch(/without a green full e2e run/);
  const stop = gateRun({ ok: false, why }, ['n', 'yes']);
  await expect(stop.p).rejects.toThrow(/Release stopped/);
  expect(stop.ran()).toBe(0);
});

// A readline interface left open puts the tty in raw mode: Ctrl-C wouldn't stop the e2e, and keys typed
// during it would answer the push question. Each question gets its own interface, closed before anything runs.
test('askOnce opens an interface for one question and closes it before returning', async () => {
  const events: string[] = [];
  const make = () => {
    events.push('open');
    return { question: async (q: string) => { events.push(`ask ${q}`); return 'y'; }, close: () => events.push('close') };
  };
  expect(await askOnce('Run? ', make)).toBe('y');
  expect(events).toEqual(['open', 'ask Run? ', 'close']);
});

// Readline's keypress decoder is a 'data' listener attached once per stream; removing every
// 'data' listener left the push question deaf (raw tty, Enter and Ctrl-C ignored).
test('drainInput drops typed-ahead keys without removing anyone else\'s data listener', async () => {
  const { EventEmitter } = await import('node:events');
  const raw: boolean[] = [];
  const stream = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: (on: boolean) => { raw.push(on); return stream; },
    resume: () => { setTimeout(() => stream.emit('data', Buffer.from('y\r')), 10); return stream; },
    pause: () => stream
  });
  const decoder = () => {};
  stream.on('data', decoder);
  await drainInput(stream, 30);
  expect(stream.listeners('data')).toEqual([decoder]);
  expect(raw).toEqual([true, false]);
  await drainInput({ isTTY: false } as never, 30); // not a tty: nothing to do
});

// The full e2e can take a quarter of an hour; main may move meanwhile (other sessions merge there).
test('afterGateProblems: HEAD moved, uncommitted changes appeared, or origin/main moved stop the release', () => {
  const ok = { headBefore: 'aaa', head: 'aaa', blocking: [], originHead: 'aaa' };
  expect(afterGateProblems(ok)).toEqual([]);
  expect(afterGateProblems({ ...ok, head: 'bbb' })).toEqual(['HEAD moved while the full e2e ran (aaa → bbb): run the release again.']);
  expect(afterGateProblems({ ...ok, blocking: ['src/x.ts'] })).toEqual(['Uncommitted changes appeared while the full e2e ran: src/x.ts.']);
  expect(afterGateProblems({ ...ok, originHead: 'ccc' })).toEqual(['origin/main moved while the full e2e ran: pull, then run the release again.']);
});

test('release.mjs asks the gate before the release commit, and --dry only reports it', () => {
  const src = readFileSync(join(__dirname, '../../scripts/release.mjs'), 'utf8');
  const main = src.slice(src.indexOf('async function main()'));
  expect(main.indexOf('fullE2eGate(')).toBeGreaterThan(-1);
  expect(main.indexOf('fullE2eGate(')).toBeLessThan(main.indexOf("git('commit'"));
  expect(src).toContain("'scripts/e2e-affected.mjs', '--gate']");
  // one-shot questions, the e2e without stdin, the state checked again after it, typed-ahead keys dropped before the push
  expect(main).toContain('ask: askOnce');
  expect(main).toContain("spawnSync('npm', ['run', 'e2e'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] })");
  expect(main.indexOf('afterGateProblems(')).toBeGreaterThan(main.indexOf('fullE2eGate('));
  expect(main.indexOf('afterGateProblems(')).toBeLessThan(main.indexOf("git('commit'"));
  expect(main.indexOf('await drainInput()')).toBeLessThan(main.indexOf('Push main and'));
  expect(main.indexOf('await drainInput()')).toBeGreaterThan(main.indexOf("git('commit'"));
});

test('beta: the next beta of the same version, or the first beta of the next minor after a stable', () => {
  expect(nextVersion('0.2.0-beta.1', 'beta')).toBe('0.2.0-beta.2');
  expect(nextVersion('0.2.0-beta.9', 'beta')).toBe('0.2.0-beta.10');
  expect(nextVersion('0.1.0', 'beta')).toBe('0.2.0-beta.1');
  expect(nextVersion('1.4.2', 'beta')).toBe('1.5.0-beta.1');
});

test('beta with a base: starts X.Y.Z-beta.1, continues the same base, never goes back', () => {
  expect(nextVersion('0.1.0', 'beta', '0.2.0')).toBe('0.2.0-beta.1');
  expect(nextVersion('0.1.0', 'beta', '1.0.0')).toBe('1.0.0-beta.1');
  expect(nextVersion('0.2.0-beta.3', 'beta', '0.2.0')).toBe('0.2.0-beta.4');
  expect(nextVersion('0.2.0-beta.3', 'beta', '0.3.0')).toBe('0.3.0-beta.1');
  expect(() => nextVersion('0.2.0-beta.3', 'beta', '0.1.9')).toThrow(/older/);
  // 0.2.0 already shipped as stable: a 0.2.0 beta would sort below it.
  expect(() => nextVersion('0.2.0', 'beta', '0.2.0')).toThrow(/older/);
  expect(() => nextVersion('0.1.0', 'beta', '0.2')).toThrow(/X\.Y\.Z/);
  expect(() => nextVersion('0.1.0', 'beta', '0.2.0-beta.1')).toThrow(/X\.Y\.Z/);
});

test('stable: promotes the current beta, refuses when there is nothing to promote', () => {
  expect(nextVersion('0.2.0-beta.4', 'stable')).toBe('0.2.0');
  expect(() => nextVersion('0.2.0', 'stable')).toThrow(/beta/);
  expect(() => nextVersion('0.2.0-beta.4', 'stable', '0.3.0')).toThrow(/base/);
  expect(() => nextVersion('0.2.0-rc.1', 'beta')).toThrow();
  expect(() => nextVersion('0.2.0', 'nightly')).toThrow(/beta or stable/);
});

test('the CHANGELOG stub lists the commits since the last tag, minus release commits, and goes above older sections', () => {
  expect(releaseSubjects(['feat(x): one', 'release: v0.2.0-beta.1', 'fix: two'])).toEqual(['feat(x): one', 'fix: two']);
  // Website commits are not app changes: they never reach the release notes stub.
  expect(releaseSubjects(['site: hero copy', 'feat(x): one', 'site(changelog): cards', 'fix: site menu'])).toEqual(['feat(x): one', 'fix: site menu']);
  const stub = changelogStub('0.2.0-beta.2', ['feat(x): one', 'fix: two']);
  expect(stub).toBe('## 0.2.0-beta.2\n\n<!-- Edit before releasing: user-facing, short. Commits since the last tag: -->\n- feat(x): one\n- fix: two\n');
  expect(changelogStub('0.2.0', [])).toContain('- (no commits since the last tag)');
  const log = '# Changelog\n\nIntro line.\n\n## 0.2.0-beta.1\n\n- First\n';
  expect(insertChangelogSection(log, stub)).toBe(`# Changelog\n\nIntro line.\n\n${stub}\n## 0.2.0-beta.1\n\n- First\n`);
  expect(insertChangelogSection('', stub)).toBe(`# Changelog\n\n${stub}`);
  expect(insertChangelogSection('# Changelog\n', stub)).toBe(`# Changelog\n\n${stub}`);
  expect(isUneditedStub(stub)).toBe(true);
  expect(isUneditedStub('- Faster startup\n')).toBe(false);
});

test('a changelog with a string the public demo bundle refuses stops the release before the tag (beta.20: /c/Users/…)', () => {
  expect(changelogLeaks('- Git Bash paths (`/c/Users/…`) open from terminals\n')).toEqual(['/Users/']);
  expect(changelogLeaks('- Git Bash paths (`/c/…`) open from terminals\n')).toEqual([]);
});

test('the version bump touches only the version fields, and refuses files it would reformat', () => {
  const pkg = '{\n  "name": "atelier",\n  "version": "0.1.0",\n  "dependencies": {\n    "x": "1.0.0"\n  }\n}\n';
  expect(bumpPackageJson(pkg, '0.2.0-beta.1')).toBe(pkg.replace('"version": "0.1.0"', '"version": "0.2.0-beta.1"'));
  const lock = '{\n  "name": "atelier",\n  "version": "0.1.0",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "atelier",\n      "version": "0.1.0"\n    },\n    "node_modules/x": {\n      "version": "0.1.0"\n    }\n  }\n}\n';
  const bumped = JSON.parse(bumpPackageLock(lock, '0.2.0-beta.1'));
  expect(bumped.version).toBe('0.2.0-beta.1');
  expect(bumped.packages[''].version).toBe('0.2.0-beta.1');
  expect(bumped.packages['node_modules/x'].version).toBe('0.1.0');
  expect(() => bumpPackageJson('{"version":"0.1.0"}', '0.2.0')).toThrow(/format/);
});

test('a release starts from a clean tree, except CHANGELOG.md being edited for it', () => {
  expect(blockingChanges('')).toEqual([]);
  expect(blockingChanges(' M CHANGELOG.md\n')).toEqual([]);
  expect(blockingChanges('?? CHANGELOG.md\n')).toEqual([]);
  expect(blockingChanges('M  CHANGELOG.md\n M src/a.ts\n?? notes.txt\n')).toEqual(['src/a.ts', 'notes.txt']);
});

// --- scripts/release-ci.mjs (the release workflow) ---

const changelog = '# Changelog\n\n## 0.2.0-beta.1\n\n- First beta\n';

test('release metadata: the tag must be v + package.json version, with a CHANGELOG section', () => {
  expect(releaseMeta({ tag: 'v0.2.0-beta.1', pkgVersion: '0.2.0-beta.1', changelog })).toEqual({
    version: '0.2.0-beta.1', tag: 'v0.2.0-beta.1', channel: 'beta', prerelease: true, notes: '- First beta', placeholderNotes: false,
    zip: 'Atelier-0.2.0-beta.1-arm64.zip', dmg: 'Atelier-0.2.0-beta.1-arm64.dmg', msix: 'Atelier-0.2.0-beta.1-x64.msix'
  });
  expect(releaseMeta({ tag: 'v0.2.0', pkgVersion: '0.2.0', changelog: '## 0.2.0\n- Stable\n' })).toMatchObject({ channel: 'stable', prerelease: false });
  expect(() => releaseMeta({ tag: 'v0.2.0-beta.2', pkgVersion: '0.2.0-beta.1', changelog })).toThrow(/package\.json/);
  expect(() => releaseMeta({ tag: '0.2.0-beta.1', pkgVersion: '0.2.0-beta.1', changelog })).toThrow(/tag/);
  expect(() => releaseMeta({ tag: 'v0.2.0-rc.1', pkgVersion: '0.2.0-rc.1', changelog })).toThrow();
  expect(() => releaseMeta({ tag: 'v0.2.0', pkgVersion: '0.2.0', changelog })).toThrow(/CHANGELOG/);
  // A stub nobody edited (release.mjs's marker still there) is not release notes.
  const stub = `# Changelog\n\n${changelogStub('0.2.0', ['feat: x'])}`;
  expect(() => releaseMeta({ tag: 'v0.2.0', pkgVersion: '0.2.0', changelog: stub })).toThrow(/stub/);
  // Injection attempts through the dispatch input never reach a shell: the tag is validated first.
  expect(() => releaseMeta({ tag: 'v0.2.0";rm -rf /', pkgVersion: '0.2.0', changelog })).toThrow(/tag/);
});

test('release metadata for an untagged dry run: package.json version, placeholder notes when the section is missing', () => {
  const m = releaseMeta({ tag: '', pkgVersion: '0.1.0', changelog, dryRun: true });
  expect(m).toMatchObject({ version: '0.1.0', tag: 'v0.1.0', channel: 'stable', placeholderNotes: true });
  expect(m.notes).toMatch(/dry run/i);
  expect(releaseMeta({ tag: '', pkgVersion: '0.2.0-beta.1', changelog, dryRun: true })).toMatchObject({ notes: '- First beta', placeholderNotes: false });
  // Without a tag only dry runs are allowed.
  expect(() => releaseMeta({ tag: '', pkgVersion: '0.2.0-beta.1', changelog })).toThrow(/tag/);
});

test('the signed feed must describe exactly the ZIP being published', () => {
  const zip = Buffer.from('zip-bytes');
  const sha512 = createHash('sha512').update(zip).digest('base64');
  const feed = (o: Record<string, string | number> = {}) => {
    const f = { version: '0.2.0-beta.1', path: 'Atelier-0.2.0-beta.1-arm64.zip', sha512, size: zip.length, channel: 'beta', ...o };
    return `version: ${f.version}\nfiles:\n  - url: ${f.path}\n    sha512: ${f.sha512}\n    size: ${f.size}\npath: ${f.path}\nsha512: ${f.sha512}\nreleaseDate: '2026-10-11T00:00:00.000Z'\nchannel: ${f.channel}\nnotes: "x"\n`;
  };
  const want = { version: '0.2.0-beta.1', channel: 'beta', zipName: 'Atelier-0.2.0-beta.1-arm64.zip', zip };
  expect(checkFeed(feed(), want)).toEqual([]);
  expect(checkFeed(feed({ version: '0.2.0-beta.2' }), want)).toEqual([expect.stringMatching(/version/)]);
  expect(checkFeed(feed({ channel: 'stable' }), want)).toEqual([expect.stringMatching(/channel/)]);
  expect(checkFeed(feed({ size: 3 }), want)).toEqual([expect.stringMatching(/size/)]);
  expect(checkFeed(feed({ path: 'Other.zip' }), want)).toEqual([expect.stringMatching(/path/)]);
  expect(checkFeed(feed(), { ...want, zip: Buffer.from('tampered') })).toEqual(expect.arrayContaining([expect.stringMatching(/sha512/)]));
});

test('the published app carries the Developer ID identity of team AFMH6BSX52', () => {
  expect(RELEASE_REQUIREMENT).toBe('identifier "app.atelier.desktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = AFMH6BSX52');
  const out = (dr: string) => `Executable=/x/Atelier.app/Contents/MacOS/Atelier\ndesignated => ${dr}\n`;
  expect(requirementProblem(out(RELEASE_REQUIREMENT))).toBeNull();
  expect(requirementProblem(out('cdhash H"0123"'))).toMatch(/ad-hoc/);
  expect(requirementProblem(out('identifier "app.atelier.desktop" and certificate root = H"2cd628f090c8d7d52b9d5eac7b5e7a8d1489245a"'))).toMatch(/identity/);
  expect(requirementProblem(out(RELEASE_REQUIREMENT.replace('AFMH6BSX52', 'ZZZZZZZZZZ')))).toMatch(/identity/);
  expect(requirementProblem('no requirement')).toMatch(/requirement/);
});

test('release notes no longer send first installs to "Open Anyway": the DMG is notarized', () => {
  expect(RELEASE_NOTES_FOOTER).not.toMatch(/Open Anyway|not notarized/);
  expect(RELEASE_NOTES_FOOTER).toMatch(/drag Atelier to Applications/);
  // Windows installs from the Store; the attached .msix is only what the Store receives.
  expect(RELEASE_NOTES_FOOTER).toMatch(/On Windows, get Atelier from the \[Microsoft Store\]\(https:\/\/apps\.microsoft\.com\/detail\/9N9FX0BQ20HF\)/);
});

describe('notarize: submit, wait, staple, validate; the API key only in a 0600 file removed at the end', () => {
  const calls: string[][] = [];
  let keyMode = 0;
  let keyPath = '';
  const runner = (status: string) => (cmd: string, a: string[]) => {
    calls.push([cmd, ...a]);
    const k = a.indexOf('--key');
    if (k >= 0) { keyPath = a[k + 1]!; keyMode = statSync(keyPath).mode & 0o777; expect(readFileSync(keyPath, 'utf8')).toBe('-----BEGIN PRIVATE KEY-----\nx\n'); }
    if (a[0] === 'notarytool' && a[1] === 'submit') return { ok: true, out: JSON.stringify({ id: 'sub-1', status, message: 'done' }) };
    if (a[0] === 'notarytool' && a[1] === 'log') return { ok: true, out: '{"issues":[{"message":"The binary is not signed."}]}' };
    return { ok: true, out: '' };
  };
  const o = { file: '/r/app.zip', staple: '/r/Atelier.app', key: '-----BEGIN PRIVATE KEY-----\nx\n', keyId: 'KEY1', issuer: 'ISS1' };

  test('Accepted: stapled and validated', () => {
    calls.length = 0;
    notarize(o, runner('Accepted'));
    expect(calls[0]).toEqual(['/usr/bin/xcrun', 'notarytool', 'submit', '/r/app.zip', '--key', keyPath, '--key-id', 'KEY1', '--issuer', 'ISS1', '--wait', '--timeout', '1h', '--output-format', 'json']);
    expect(calls.slice(1)).toEqual([['/usr/bin/xcrun', 'stapler', 'staple', '/r/Atelier.app'], ['/usr/bin/xcrun', 'stapler', 'validate', '/r/Atelier.app']]);
    if (isPosix) expect(keyMode).toBe(0o600);
    expect(existsSync(keyPath)).toBe(false);
  });

  test('the ticket can lag behind "Accepted": stapling is retried, 20 s apart, up to 3 times', () => {
    calls.length = 0;
    let staples = 0;
    const waits: number[] = [];
    const flaky = (cmd: string, a: string[]) => {
      if (a[0] === 'stapler' && a[1] === 'staple' && ++staples < 3) { calls.push([cmd, ...a]); return { ok: false, out: '', err: 'Could not find base64 encoded ticket in response' }; }
      return runner('Accepted')(cmd, a);
    };
    notarize(o, flaky, (ms: number) => waits.push(ms));
    expect(calls.filter((c) => c[2] === 'staple')).toHaveLength(3);
    expect(waits).toEqual([20_000, 20_000]);
    let again = 0;
    expect(() => notarize(o, (cmd: string, a: string[]) => (a[1] === 'staple' ? (again++, { ok: false, out: '', err: 'no ticket' }) : runner('Accepted')(cmd, a)), () => {})).toThrow(/stapler staple/);
    expect(again).toBe(3);
  });

  test('Invalid: Apple\'s log in the error, nothing stapled, key removed', () => {
    calls.length = 0;
    expect(() => notarize(o, runner('Invalid'))).toThrow(/Invalid[\s\S]*not signed/);
    expect(calls.some((c) => c.includes('stapler'))).toBe(false);
    expect(calls.find((c) => c[2] === 'log')!.slice(0, 4)).toEqual(['/usr/bin/xcrun', 'notarytool', 'log', 'sub-1']);
    expect(existsSync(keyPath)).toBe(false);
  });
});

test('Gatekeeper: only an explicit "Notarized Developer ID" verdict passes (a runner with Gatekeeper off proves nothing)', () => {
  expect(gatekeeperProblem({ ok: true, out: '/x/Atelier.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Francesco Musso (AFMH6BSX52)\n' })).toBeNull();
  expect(gatekeeperProblem({ ok: true, out: '/x/Atelier.app: accepted\noverride=security disabled\n' })).toMatch(/disabled/);
  expect(gatekeeperProblem({ ok: true, out: '/x/Atelier.app: accepted\nsource=Developer ID\n' })).toMatch(/not notarized/);
  expect(gatekeeperProblem({ ok: false, out: '/x/Atelier.app: rejected\nsource=Unnotarized Developer ID\n' })).toMatch(/rejects/);
});

const DMG_LAYOUT = join(__dirname, '../../build/dmg');

/**
 * An app as `packageRelease` gets it: the icon the DMG's volume shows (a real .icns, like electron-builder's), plus a
 * symlink and a dotfile inside the bundle (a copy that drops either breaks the seal), signed after all of it.
 */
function packagedApp(dir: string): string {
  const app = makeApp(dir, { version: '1.0.0', builtAt: 1, sign: false });
  const res = join(app, 'Contents/Resources');
  execFileSync('/usr/bin/sips', ['-z', '256', '256', '-s', 'format', 'icns', join(DMG_LAYOUT, '../icon.png'), '--out', join(res, 'icon.icns')], { stdio: 'ignore' });
  writeFileSync(join(res, '.keep'), 'kept\n');
  symlinkSync('icon.icns', join(res, 'icon-link.icns'));
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' });
  return app;
}

function withMountedDmg(dir: string, dmg: string, tool: string, fn: (mount: string) => void) {
  withAttachedDmg(dmg, { readOnly: true, mountPoint: mkdtempSync(join(dir, 'mnt-')) }, fn, tool);
}

const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

// Every disk image tool this Mac has: `diskutil image` (macOS 27 deprecates hdiutil for it) and hdiutil, the fallback.
const TOOLS = [...(hasDiskutilImage() ? ['diskutil'] : []), ...(existsSync('/usr/bin/hdiutil') ? ['hdiutil'] : [])];

// POSIX: macOS's disk image tools and a Mach-O stand-in.
posixTest('the disk image tool: diskutil image where macOS has it (always from macOS 27), hdiutil before', () => {
  expect(TOOLS.length).toBeGreaterThan(0);
  expect(defaultDiskImageTool()).toBe(TOOLS[0]);
  const major = Number(execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).split('.')[0]);
  if (major >= 27) expect(defaultDiskImageTool()).toBe('diskutil');
  expect(() => packageRelease({ app: '/nonexistent', zip: '/x.zip', dmg: '/x.dmg', tool: 'mkisofs' })).toThrow(/disk image tool/);
});

test('every mount is hidden from Finder unless asked (tests and verify never put an "Atelier" disk on the Desktop)', () => {
  for (const tool of ['diskutil', 'hdiutil']) {
    expect(attachCommand(tool, '/x.dmg', { readOnly: true })[1]).toContain(tool === 'diskutil' ? '--nobrowse' : '-nobrowse');
    expect(attachCommand(tool, '/x.dmg', { browse: true })[1]).not.toContain(tool === 'diskutil' ? '--nobrowse' : '-nobrowse');
  }
});

describe.each(TOOLS)('package with %s', (tool) => {
  test('the update ZIP (ditto --keepParent) and the DMG with an Applications link, from one app', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkg-'));
    const app = packagedApp(dir);
    packageRelease({ app, zip: join(dir, 'out/Atelier.zip'), dmg: join(dir, 'out/Atelier.dmg'), tool });
    const x = join(dir, 'x');
    execFileSync('/usr/bin/ditto', ['-x', '-k', join(dir, 'out/Atelier.zip'), x]);
    expect(readdirSync(x)).toEqual(['Atelier.app']);
    withMountedDmg(dir, join(dir, 'out/Atelier.dmg'), tool, (mount) => {
      expect(readdirSync(mount).filter((n) => !n.startsWith('.')).sort()).toEqual(['Applications', 'Atelier.app']);
      // The app came through whole: its seal still verifies, the dotfile and the symlink inside the bundle are there.
      const copy = join(mount, 'Atelier.app');
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', copy], { stdio: 'pipe' });
      expect(readFileSync(join(copy, 'Contents/Resources/.keep'), 'utf8')).toBe('kept\n');
      expect(lstatSync(join(copy, 'Contents/Resources/icon-link.icns')).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(mount, 'Applications')).isSymbolicLink()).toBe(true);
      expect(dmgLayoutProblems(mount)).toEqual([]);
    });
  }, 120_000);

  test('the DMG window: background, Finder layout and volume icon, hidden; UDZO, APFS volume "Atelier"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkg-'));
    const app = packagedApp(dir);
    const dmg = join(dir, 'Atelier.dmg');
    packageRelease({ app, zip: join(dir, 'Atelier.zip'), dmg, tool });
    expect(diskImageFormat(dmg, tool)).toBe('UDZO');
    withMountedDmg(dir, dmg, tool, (mount) => {
      // Only what was staged: no .fseventsd or .Trashes from the read-write mount.
      expect(readdirSync(mount).filter((n) => n.startsWith('.')).sort()).toEqual(['.DS_Store', '.VolumeIcon.icns', '.background']);
      expect(sha(join(mount, '.background/background.tiff'))).toBe(sha(join(DMG_LAYOUT, 'background.tiff')));
      expect(sha(join(mount, '.DS_Store'))).toBe(sha(join(DMG_LAYOUT, 'DS_Store')));
      expect(sha(join(mount, '.VolumeIcon.icns'))).toBe(sha(join(app, 'Contents/Resources/icon.icns')));
      // kHasCustomIcon (0x0400) in the root folder's Finder flags: without it Finder ignores .VolumeIcon.icns.
      const info = execFileSync('/usr/bin/xattr', ['-px', 'com.apple.FinderInfo', mount], { encoding: 'utf8' }).replace(/\s+/g, '');
      expect(info.slice(16, 20)).toBe('0400');
      // The .DS_Store finds its background through the volume name; both tools make the same kind of volume.
      const volume = execFileSync('/usr/sbin/diskutil', ['info', mount], { encoding: 'utf8' });
      expect(volume).toMatch(/Volume Name:\s+Atelier$/m);
      expect(volume).toMatch(/File System Personality:\s+APFS$/m);
    });
  }, 120_000);
});

// POSIX: macOS's disk image tools and a Mach-O stand-in.
posixTest('package refuses an app without its icon, and a layout without the Finder-written .DS_Store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-'));
  const bare = makeApp(join(dir, 'bare'), { version: '1.0.0', builtAt: 1 });
  expect(() => packageRelease({ app: bare, zip: join(dir, 'a.zip'), dmg: join(dir, 'a.dmg') })).toThrow(/icon\.icns/);
  const app = packagedApp(dir);
  const layout = join(dir, 'layout');
  mkdirSync(layout);
  copyFileSync(join(DMG_LAYOUT, 'background.tiff'), join(layout, 'background.tiff'));
  expect(() => packageRelease({ app, zip: join(dir, 'b.zip'), dmg: join(dir, 'b.dmg'), layout })).toThrow(/dmg-layout\.mjs/);
});

test('verify flags a DMG that lost its window: no background, no .DS_Store, no volume icon or its flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmg-verify-'));
  expect(dmgLayoutProblems(dir)).toEqual([
    'DMG: no .background/background.tiff (the window background)',
    'DMG: no .DS_Store (the window layout)',
    'DMG: no .VolumeIcon.icns (the volume icon)',
    'DMG: the volume root lacks the custom-icon flag (Finder ignores .VolumeIcon.icns)'
  ]);
});

/** A .DS_Store record's value: UTF-16BE file name, 4-char code, 4-char type, then (for a blob) a length and the bytes. */
function dsRecord(ds: Buffer, name: string, code: string): Buffer | null {
  const key = Buffer.concat([Buffer.alloc(4), Buffer.from(name, 'utf16le').swap16(), Buffer.from(code + 'blob')]);
  key.writeUInt32BE(name.length, 0);
  const at = ds.indexOf(key);
  if (at < 0) return null;
  const start = at + key.length;
  return ds.subarray(start + 4, start + 4 + ds.readUInt32BE(start));
}

/** Some keys of a binary plist, as plutil prints them raw (the view's plist holds data, which JSON can't). */
const plistKeys = (blob: Buffer, keys: string[]) => Object.fromEntries(keys.map((k) =>
  [k, execFileSync('/usr/bin/plutil', ['-extract', k, 'raw', '-o', '-', '-'], { input: blob, encoding: 'utf8' }).trim()]));

// POSIX: macOS's disk image tools and a Mach-O stand-in.
posixTest('the committed .DS_Store is the layout of DMG_WINDOW: icon centers, window, view, background on volume "Atelier"', () => {
  const ds = readFileSync(join(DMG_LAYOUT, 'DS_Store'));
  for (const [name, [x, y]] of Object.entries(DMG_WINDOW.icons as Record<string, [number, number]>)) {
    const iloc = dsRecord(ds, name, 'Iloc');
    expect(iloc && [iloc.readUInt32BE(0), iloc.readUInt32BE(4)], name).toEqual([x, y]);
  }
  const window = plistKeys(dsRecord(ds, '.', 'bwsp')!, ['WindowBounds', 'ShowToolbar', 'ShowStatusBar', 'ShowSidebar']);
  // Finder's bounds include the title bar: the content is DMG_WINDOW.
  // Saved bottom-left (Cocoa) and with the title bar: at DMG_WINDOW_ORIGIN whatever the screen of the Mac that ran the
  // layout, so the window opens inside a laptop's screen too.
  expect(window.WindowBounds).toBe(`{{${DMG_WINDOW_ORIGIN.join(', ')}}, {${DMG_WINDOW.width}, ${DMG_WINDOW.height + 28}}}`);
  expect(window).toMatchObject({ ShowToolbar: 'false', ShowStatusBar: 'false', ShowSidebar: 'false' });
  const view = plistKeys(dsRecord(ds, '.', 'icvp')!, ['iconSize', 'textSize', 'backgroundType', 'arrangeBy', 'labelOnBottom']);
  expect({ ...view, iconSize: Number(view.iconSize), textSize: Number(view.textSize) }).toEqual({ iconSize: DMG_WINDOW.iconSize, textSize: DMG_WINDOW.textSize, backgroundType: '2', arrangeBy: 'none', labelOnBottom: 'true' });
  // The background's alias and bookmark both name the volume.
  expect(ds.includes(`file:///Volumes/${DMG_VOLUME}/`)).toBe(true);
  expect(ds.includes('background.tiff')).toBe(true);
});

test('the committed .DS_Store names nothing of the machine that wrote it (it ships in every public DMG)', () => {
  const text = readFileSync(join(DMG_LAYOUT, 'DS_Store')).toString('latin1') + readFileSync(join(DMG_LAYOUT, 'DS_Store')).swap16().toString('utf16le');
  for (const leak of ['/Users/', '/var/folders/', 'atl-dmg-layout-']) expect(text, leak).not.toContain(leak);
});

test('the background renderer takes the size from the HTML, and refuses to render without the brand fonts', () => {
  const src = readFileSync(join(__dirname, '../../scripts/render-dmg-background.cjs'), 'utf8');
  expect(src).not.toMatch(/\b(660|400)\b/);
  expect(src).toMatch(/--w/);
  expect(src).toMatch(/status !== 'loaded'|status === 'error'/);
});

// POSIX: macOS's disk image tools and a Mach-O stand-in.
posixTest('the committed DMG background is a Retina TIFF: 660×400 and 1320×800, the window size in dmg-layout.mjs', () => {
  const info = execFileSync('/usr/bin/tiffutil', ['-info', join(DMG_LAYOUT, 'background.tiff')], { encoding: 'utf8' });
  expect([...info.matchAll(/Image Width: (\d+) Image Length: (\d+)/g)].map((m) => `${m[1]}x${m[2]}`)).toEqual(['660x400', '1320x800']);
  expect(DMG_WINDOW).toMatchObject({ width: 660, height: 400 });
  // The background draws its pads and arrow where Finder puts the icons.
  const css = readFileSync(join(DMG_LAYOUT, 'background.html'), 'utf8');
  const px = (v: string) => Number(new RegExp(`--${v}: (\\d+)px`).exec(css)?.[1]);
  expect([px('w'), px('h')]).toEqual([DMG_WINDOW.width, DMG_WINDOW.height]);
  expect([px('left-x'), px('icon-y')]).toEqual(DMG_WINDOW.icons['Atelier.app']);
  expect([px('right-x'), px('icon-y')]).toEqual(DMG_WINDOW.icons.Applications);
  // The light pills under Finder's (always black) labels sit below the icons.
  expect(px('label-y')).toBeGreaterThan(px('icon-y') + DMG_WINDOW.iconSize / 2);
  expect(css).toMatch(/\.label\.left \{/);
  expect(css).toMatch(/\.label\.right \{/);
});

test('dry runs sign with a throwaway key: a fresh Ed25519 pair, never one embedded in the app', () => {
  const a = throwawayKey();
  const b = throwawayKey();
  expect(publicKeyOf(a.pem)).toBe(a.publicKey);
  expect(a.publicKey).not.toBe(b.publicKey);
  expect(embeddedKeys()).not.toContain(a.publicKey);
});

test('versions and tags follow the app\'s semver rules: no leading zeros anywhere (the app would ignore such a release)', () => {
  for (const bad of ['0.2.0-beta.01', '01.2.0', '0.02.0', '0.2.00', '0.2.0-beta.']) expect(() => channelOf(bad)).toThrow();
  expect(channelOf('0.2.0-beta.0')).toBe('beta');
  expect(channelOf('10.20.30')).toBe('stable');
  expect(() => releaseMeta({ tag: 'v0.2.0-beta.01', pkgVersion: '0.2.0-beta.01', changelog: '## 0.2.0-beta.01\n- x\n' })).toThrow(/tag/);
  expect(() => releaseMeta({ tag: 'v01.2.0', pkgVersion: '01.2.0', changelog: '## 01.2.0\n- x\n' })).toThrow(/tag/);
  expect(() => nextVersion('0.2.0-beta.01', 'beta')).toThrow();
  expect(() => nextVersion('0.1.0', 'beta', '0.02.0')).toThrow(/X\.Y\.Z/);
});
