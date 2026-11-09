import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runScripts } from '../support/workflow-text';

// Static guards on .github/workflows/release.yml: where the secrets may
// appear, and that no secret reaches a command line. actionlint/shellcheck check the syntax; this checks the intent.
const text = readFileSync(join(__dirname, '../../.github/workflows/release.yml'), 'utf8');

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

const ID = 'Developer ID Application: Francesco Musso (AFMH6BSX52)';
const SIGNING = ['DEVELOPER_ID_P12', 'DEVELOPER_ID_PASSWORD', 'NOTARY_KEY', 'NOTARY_KEY_ID', 'NOTARY_ISSUER'];
const PUBLISHING = ['UPDATE_SIGNING_KEY'];
const secretsIn = (job: string) => [...job.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]).sort();
const installs = /\bnpm (ci|install|i|run)\b|\bnpx\b|\byarn\b|\bpnpm\b|cache: npm/;

test('four jobs and a cleanup: each secret only where it is needed', () => {
  const j = jobs();
  expect(Object.keys(j)).toEqual(['build', 'sign', 'check', 'build-win', 'check-win', 'publish', 'cleanup']);
  expect(secretsIn(j.build!)).toEqual([]);
  expect(secretsIn(j.check!)).toEqual([]);
  expect(secretsIn(j['build-win']!)).toEqual([]);
  expect(secretsIn(j['check-win']!)).toEqual([]);
  expect(secretsIn(j.cleanup!)).toEqual([]);
  for (const k of ['build-win', 'check-win']) expect(j[k], k).not.toMatch(/environment:/);
  expect(new Set(secretsIn(j.sign!))).toEqual(new Set(SIGNING));
  expect(new Set(secretsIn(j.publish!))).toEqual(new Set(PUBLISHING));
  expect(text).not.toMatch(/MAC_CERT/);
  // The jobs holding a key run in the protected environment (tag rule v*).
  for (const k of ['sign', 'publish']) expect(j[k]).toMatch(/^ {4}environment: release$/m);
  expect(j.sign).toMatch(/^ {4}if: [^\n]*github\.ref_type == 'tag'/m);
  // Two notarizations of up to an hour each, plus signing and packaging.
  expect(Number(/^ {4}timeout-minutes: (\d+)$/m.exec(j.sign!)?.[1])).toBeGreaterThanOrEqual(150);
  expect(j.publish).toMatch(/^ {4}needs: \[build, check, check-win\]$/m);
});

test('the draft is created in this repository, on the tag that started the run, by publish alone', () => {
  const j = jobs();
  // Only publish may write to the repository, with the job's own token: no long-lived token to renew.
  for (const [k, job] of Object.entries(j)) {
    if (k !== 'publish') expect(job, k).not.toMatch(/contents: write/);
  }
  expect(j.publish).toMatch(/^ {6}contents: write$/m);
  expect(text).not.toMatch(/^ {2}contents: write$/m);
  expect(j.publish).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}\n {8}run: \|\n {10}repo="\$GITHUB_REPOSITORY"/);
  expect(j.publish).toMatch(/flags=\(--draft --verify-tag /);
  expect(text).not.toMatch(/RELEASES_TOKEN|atelier-releases/);
});

test('sign waits for the Windows build (or the escape hatch): a Windows red no longer wastes the macOS minutes of sign and check', () => {
  const s = jobs().sign!;
  // The Windows path (build-win, check-win) is the longer one, so waiting costs no wall-clock time; v0.2.0-beta.18
  // stopped on build-win after sign and check had run (~$0.40 of macOS minutes).
  expect(s).toMatch(/^ {4}needs: \[build, build-win\]$/m);
  expect(s).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) && github\.ref_type == 'tag' && needs\.build\.result == 'success' && \(needs\.build-win\.result == 'success' \|\| needs\.build\.outputs\.windows == 'false'\) \}\}$/m);
});

test('on a tag, check runs only after sign: a Windows red keeps the unsigned app, and "Re-run failed jobs" can sign it', () => {
  const c = jobs().check!;
  // A skipped sign means a branch dry run only. On a tag it means build-win failed: check then ran on the unsigned app,
  // and cleanup (after check) deleted atelier-unsigned, so a rerun of the failed jobs had nothing to sign
  // (v0.2.0-beta.23 and .24, 2026-11-01).
  expect(c).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) && needs\.build\.result == 'success' && \(needs\.sign\.result == 'success' \|\| \(needs\.sign\.result == 'skipped' && github\.ref_type != 'tag'\)\) \}\}$/m);
});

test('the jobs holding a key install nothing: Node built-ins, codesign, notarytool, stapler only', () => {
  const j = jobs();
  for (const k of ['sign', 'publish']) expect(j[k], k).not.toMatch(installs);
  expect(j.build).toMatch(/npm run dist:unsigned/);
  expect(j.build).not.toMatch(/sign-app\.mjs|security /);
});

test('sign: Developer ID inside-out, the app notarized and stapled before packaging, the DMG signed, notarized, stapled', () => {
  const s = jobs().sign!;
  const at = (re: RegExp) => { const m = re.exec(s); expect(m, String(re)).not.toBeNull(); return m!.index; };
  const signApp = at(new RegExp(`node scripts/sign-app\\.mjs --identity "\\$IDENTITY"`));
  expect(s).toContain(`IDENTITY: '${ID}'`);
  const notarizeApp = at(/release-ci\.mjs notarize --file "\$RUNNER_TEMP\/notarize\.zip" --staple release\/mac-arm64\/Atelier\.app/);
  const pack = at(/release-ci\.mjs package /);
  const signDmg = at(/codesign --force --sign "\$IDENTITY" --timestamp "release\/\$DMG"/);
  const notarizeDmg = at(/release-ci\.mjs notarize --file "release\/\$DMG" --staple "release\/\$DMG"/);
  const checked = at(/release-ci\.mjs check-app [^\n]*--notarized/);
  expect(signApp).toBeLessThan(notarizeApp);
  expect(notarizeApp).toBeLessThan(pack);
  expect(pack).toBeLessThan(signDmg);
  expect(signDmg).toBeLessThan(notarizeDmg);
  expect(notarizeApp).toBeLessThan(checked);
  // The keychain goes before anything is uploaded.
  const drop = at(/name: Delete the temporary keychain\n\s+if: always\(\)/);
  expect(drop).toBeLessThan(at(/uses: actions\/upload-artifact@/));
});

test('check: the packaged checks and the full verification run on the very files that ship (notarized on a tag)', () => {
  const c = jobs().check!;
  expect(c).toMatch(/^ {4}needs: \[build, sign\]$/m);
  // Its `if:` (sign skipped only on a branch dry run): the next test.
  // Signed files are checked as notarized, the dry run's as unsigned: never the other way round.
  expect(c).toMatch(/if \[ "\$SIGNED" = "true" \]; then\n\s+gh run download [^\n]*--name atelier-signed[^\n]*\n\s+echo "MODE=--notarized"/);
  expect(c).toMatch(/else\n(?:[^\n]*\n){3}\s+echo "MODE=--unsigned"/);
  expect(c).toMatch(/packaged\.manual\.ts/);
  expect(c).toMatch(/release-ci\.mjs throwaway-key/);
  expect(c).toMatch(/sign-feed\.mjs [^\n]*--public-key/);
  expect(c).toMatch(/release-ci\.mjs verify [^\n]*--public-key/);
  // Unsigned only on a branch dry run, notarized otherwise.
  expect(c).toMatch(/--unsigned/);
  expect(c).toMatch(/--notarized/);
});

test('publish signs the feed the check job made and refuses anything not notarized', () => {
  const p = jobs().publish!;
  expect(p).toMatch(/node scripts\/sign-feed\.mjs [^\n]*latest-mac\.yml/);
  expect(p).toMatch(/node scripts\/release-ci\.mjs verify [^\n]*--notarized/);
  expect(p).not.toContain('--public-key');
  expect(p).not.toContain('--unsigned');
});

test('artifacts are hand-offs: short retention, deleted by `cleanup` once used (Actions storage is billed by the hour)', () => {
  const uploads = [...text.matchAll(/name: (atelier-[\w-]+)\n(?:[^\n]*\n){1,5}?\s+retention-days: (\d+)/g)].map((m) => [m[1], Number(m[2])]);
  // atelier-windows is the MSIX publish attaches (and what a dry run delivers): it lives as long as the release files.
  expect(Object.fromEntries(uploads)).toEqual({ 'atelier-unsigned': 1, 'atelier-signed': 1, 'atelier-release-files': 3, 'atelier-windows': 3 });
  const c = jobs().cleanup!;
  // A cheap Linux runner, no environment, no secret, nothing installed, no checkout: only the run's own artifacts.
  expect(c).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
  expect(c).not.toMatch(/environment:|actions\/checkout|actions\/setup-node/);
  expect(c).not.toMatch(installs);
  expect(c).toMatch(/^ {4}permissions:\n {6}actions: write\n(?! {6})/m);
  expect(c).toMatch(/^ {4}needs: \[check, publish\]$/m);
  // Only after a successful check; the release files only once the draft exists (a dry run keeps them, and a failed
  // publish keeps them for "Re-run failed jobs").
  expect(c).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) && needs\.check\.result == 'success' \}\}$/m);
  expect(c).toMatch(/PUBLISHED: \$\{\{ needs\.publish\.result == 'success' \}\}/);
  expect(c).toMatch(/atelier-unsigned/);
  expect(c).toMatch(/atelier-signed/);
  expect(c).toMatch(/if \[ "\$PUBLISHED" = "true" \]; then names\+=\(atelier-release-files atelier-windows\); fi/);
  expect(c).toMatch(/gh api -X DELETE "repos\/\$GITHUB_REPOSITORY\/actions\/artifacts\/\$id"/);
});

test('no password on a command line: security reads them from stdin (security -i), never as -p/-P arguments', () => {
  const lines = text.split('\n').map((l) => l.trim());
  const direct = lines.filter((l) => /^(if !\s*)?security\s/.test(l));
  for (const l of direct) expect(l, l).not.toMatch(/\$\{?(kc_pass|MAC_CERT_PASSWORD)\b/);
  expect(direct.length).toBeGreaterThan(0);
  // The helper that feeds them through stdin is what the keychain step uses.
  expect(text).toMatch(/printf '%s\\n' "\$line" \| security -i/);
  expect(text).toMatch(/sec import /);
  // GitHub expressions are never expanded inside a script: secrets and inputs reach run blocks as env vars only.
  const scripts = runScripts(text);
  expect(scripts.length).toBeGreaterThan(10);
  for (const script of scripts) expect(script, script).not.toMatch(/\$\{\{\s*(secrets|inputs|github\.event)\./);
});

test('the build selects Xcode 26+ before packaging: actool compiles the Icon Composer app icon', () => {
  const b = jobs().build!;
  // actool's .icon compiler loads a macOS 26 runtime: on a macOS 15 runner it crashes (missing CoreMedia symbols).
  expect(b).toMatch(/^ {4}runs-on: macos-26$/m);
  const select = b.indexOf('name: Select Xcode 26');
  expect(select).toBeGreaterThan(-1);
  expect(select).toBeLessThan(b.indexOf('npm run dist:unsigned'));
  const step = b.slice(select, b.indexOf('\n      - ', select));
  // The newest Xcode 26+ on the runner, for the rest of the job; a clear error when there is none.
  expect(step).toMatch(/DEVELOPER_DIR=[^\n]*>> "\$GITHUB_ENV"/);
  expect(step).toMatch(/::error::/);
  expect(step).toMatch(/actool --version/);
});

// --- Windows ---

/** The steps of a job (`      - name:` items), as text. */
const steps = (job: string) => job.split(/\n(?= {6}- )/).filter((s) => /^ {6}- /.test(s));
const step = (job: string, name: string) => {
  const s = steps(job).find((x) => x.includes(`- name: ${name}\n`));
  expect(s, name).toBeDefined();
  return s!;
};

test('the manual input `windows` (default true) is the single-platform escape hatch; a tag push always builds Windows', () => {
  expect(text).toMatch(/^ {6}windows:\n {8}description: [^\n]+\n {8}type: boolean\n {8}default: true$/m);
  const mode = step(jobs().build!, 'Run mode');
  expect(mode).toMatch(/INPUT_WINDOWS: \$\{\{ inputs\.windows \}\}/);
  // Only a manual run that says false skips Windows: a push (inputs empty) never does.
  expect(mode).toMatch(/windows=true\n\s+if \[ "\$EVENT" != push \] && \[ "\$INPUT_WINDOWS" = false \]; then\n\s+windows=false/);
  expect(mode).toMatch(/echo "windows=\$windows"/);
  expect(jobs().build).toMatch(/^ {6}windows: \$\{\{ steps\.mode\.outputs\.windows \}\}$/m);
  expect(jobs().build).toMatch(/^ {6}msix: \$\{\{ steps\.meta\.outputs\.msix \}\}$/m);
});

test('build-win: the build commit on windows-latest, its tests, whisper cached for Windows, electron-builder dir, the MSIX unsigned', () => {
  const b = jobs()['build-win']!;
  // The tests run the bridge and atelier-procs: built before them (the nightly CI of 2026-10-18 failed without).
  expect(b.indexOf('run: npm run build:bridge')).toBeGreaterThan(-1);
  expect(b.indexOf('run: npm run build:bridge')).toBeLessThan(b.indexOf('run: npm test'));
  expect(b).toMatch(/^ {4}needs: build$/m);
  expect(b).toMatch(/^ {4}if: needs\.build\.outputs\.windows == 'true'$/m);
  expect(b).toMatch(/^ {4}runs-on: windows-latest$/m);
  expect(b).toMatch(/ref: \$\{\{ needs\.build\.outputs\.sha \}\}/);
  const order = ['run: npm ci', 'run: npm run typecheck', 'run: npm test', 'run: npm run build:whisper', 'run: npm run build', 'npx electron-builder --config electron-builder.yml --win dir --x64 --publish never', 'node scripts/win/pack-msix.mjs --version'];
  const at = order.map((s) => { const i = b.search(new RegExp(`${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'm')); expect(i, s).toBeGreaterThan(-1); return i; });
  expect([...at].sort((x, y) => x - y)).toEqual(at);
  // The release channel stamped by after-pack, as on macOS.
  expect(step(b, 'Pack the app folder (electron-builder)')).toMatch(/ATELIER_RELEASE_CHANNEL: \$\{\{ needs\.build\.outputs\.channel \}\}/);
  // whisper's own build only: the bridge and atelier-procs are rebuilt by npm run build (never a stale cached copy).
  const cache = step(b, 'Cache the whisper.cpp build');
  expect(cache).toMatch(/key: whisper-win-/);
  expect(cache).toMatch(/vendor\/bin\/atelier-whisper\.exe/);
  expect(cache).not.toMatch(/^\s+vendor\/bin\s*$/m);
  // Unsigned (the Store signs it), checked, handed over.
  expect(b).not.toMatch(/--sign|signtool|test-cert/);
  expect(b).toMatch(/release-ci\.mjs check-msix --file [^\n]*--version/);
  expect(b).toMatch(/name: atelier-windows\n/);
});

test('every run step of the Windows jobs names its shell (bash is the workflow default, Git Bash on Windows)', () => {
  for (const k of ['build-win', 'check-win']) {
    const runs = steps(jobs()[k]!).filter((s) => /\n {8}run: /.test(s));
    expect(runs.length, k).toBeGreaterThan(3);
    for (const s of runs) expect(s, s).toMatch(/\n {8}shell: (pwsh|powershell)\n/);
  }
});

test('check-win: the shipped MSIX unpacked for the packaged smoke, a signed copy installed and started, WACK on it', () => {
  const c = jobs()['check-win']!;
  expect(c).toMatch(/^ {4}needs: \[build, build-win\]$/m);
  expect(c).toMatch(/^ {4}runs-on: windows-latest$/m);
  expect(c).toMatch(/^ {4}permissions:\n {6}contents: read\n(?: {6}#[^\n]*\n)* {6}actions: read$/m);
  expect(c).toMatch(/gh run download [^\n]*--name atelier-windows/);
  // The smoke runs on the very files that ship: makeappx unpacks the MSIX (no second artifact of the app folder).
  expect(c).toMatch(/makeappx\.exe" unpack \/p /);
  const smoke = step(c, 'Packaged smoke (the unpacked MSIX)');
  expect(smoke).toMatch(/ATELIER_WIN_APP: /);
  expect(smoke).toMatch(/ATELIER_RELEASE_CHANNEL: \$\{\{ needs\.build\.outputs\.channel \}\}/);
  expect(smoke).toMatch(/npx playwright test --config playwright\.manual\.config\.ts tests\/e2e\/packaged-win\.manual\.ts/);
  // A throwaway certificate made in the job, a signed copy (the unsigned MSIX stays as built).
  const sign = step(c, 'Sign a copy with a throwaway certificate');
  expect(sign).toMatch(/scripts\/win\/test-cert\.ps1 -Out /);
  expect(sign).toMatch(/::add-mask::/);
  expect(sign).toMatch(/Copy-Item /);
  expect(sign).toMatch(/signtool\.exe" sign \/fd SHA256 /);
  // Installed through the AppX module of Windows PowerShell, started through its package identity, seen running.
  const install = step(c, 'Install the signed copy and start it once');
  expect(install).toMatch(/shell: powershell\n/);
  expect(install).toMatch(/Add-AppxPackage -Path /);
  expect(install).toMatch(/shell:AppsFolder\\/);
  expect(install).toMatch(/MainWindowHandle/);
  expect(install).toMatch(/PACKAGE_FULL_NAME=/);
  // WACK on the installed package; the verdict from the report (required tests), never appcert's exit code alone.
  const wack = step(c, 'Windows App Certification Kit');
  expect(wack).toMatch(/& \$env:APPCERT reset/);
  expect(wack).toMatch(/& \$env:APPCERT test -packagefullname \$env:PACKAGE_FULL_NAME -reportoutputpath /);
  expect(wack).toMatch(/node scripts\/release-ci\.mjs wack --report [^\n]*--version \$env:VERSION/);
  // A runner image without the kit fails the job with a clear error: never a silent skip.
  const tools = step(c, 'Find the Windows SDK tools and the certification kit');
  expect(tools).toMatch(/App Certification Kit\\appcert\.exe/);
  expect(tools).toMatch(/::error::[^\n]*appcert/);
  expect(tools).toMatch(/exit 1/);
  expect(c).not.toMatch(/continue-on-error/);
  // Order: download, unpack and smoke, sign, install, WACK.
  const idx = ['--name atelier-windows', 'unpack /p', 'packaged-win.manual.ts', 'test-cert.ps1', 'Add-AppxPackage', 'APPCERT test'].map((s) => c.indexOf(s));
  expect(idx.every((i) => i > -1)).toBe(true);
  expect([...idx].sort((x, y) => x - y)).toEqual(idx);
});

test('publish waits for both platforms (or the escape hatch) and attaches the checked MSIX; the Mac feed never sees it', () => {
  const j = jobs();
  const p = j.publish!;
  expect(p).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) && needs\.build\.outputs\.publish == 'true' && needs\.check\.result == 'success' && \(needs\.check-win\.result == 'success' \|\| needs\.build\.outputs\.windows == 'false'\) \}\}$/m);
  expect(p).toMatch(/WINDOWS: \$\{\{ needs\.build\.outputs\.windows \}\}/);
  expect(p).toMatch(/if \[ "\$WINDOWS" = "true" \]; then\n\s+gh run download [^\n]*--name atelier-windows --dir release/);
  expect(p).toMatch(/release-ci\.mjs check-msix --file "release\/\$MSIX" --version "\$VERSION"/);
  expect(p).toMatch(/if \[ "\$WINDOWS" = "true" \]; then assets\+=\("release\/\$MSIX"\); fi/);
  expect(p).toMatch(/gh release create "\$TAG" --repo "\$repo" "\$\{flags\[@\]\}" "\$\{assets\[@\]\}"/);
  // The MSIX is never part of the Mac feed: the jobs that write and check latest-mac.yml never fetch it.
  for (const k of ['build', 'sign', 'check']) expect(j[k], k).not.toMatch(/atelier-windows|check-msix|\$MSIX|\.msix"/);
  expect(text.match(/make-feed\.mjs [^\n]*/g)!.join('\n')).not.toMatch(/msix/i);
});
