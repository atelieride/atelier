import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { SWAP_SCRIPT, UpdateWatcher, appBundleOf, appLocationProblem, designatedRequirement, previousAppToDrop, ptyHelperHash, updateUsable, type UpdateDeps } from './updates';
import { macho } from '../../tests/support/macho';

test('the bundle of the running app, from its executable', () => {
  expect(appBundleOf('/Applications/Atelier.app/Contents/MacOS/Atelier')).toBe('/Applications/Atelier.app');
  expect(appBundleOf('/usr/local/bin/node')).toBeNull();
});

test('a pending update is usable only if it is newer and speaks the same protocol with atelierd', () => {
  expect(updateUsable({ own: { protocol: 1, builtAt: 100 }, staged: { protocol: 1, builtAt: 200 }, protocol: 1 })).toBe(true);
  expect(updateUsable({ own: { protocol: 1, builtAt: 200 }, staged: { protocol: 1, builtAt: 200 }, protocol: 1 })).toBe(false);
  expect(updateUsable({ own: { protocol: 1, builtAt: 100 }, staged: { protocol: 2, builtAt: 200 }, protocol: 1 })).toBe(false);
  // App installed before the date stamp existed: any pending build is newer.
  expect(updateUsable({ own: null, staged: { protocol: 1, builtAt: 200 }, protocol: 1 })).toBe(true);
  expect(updateUsable({ own: null, staged: null, protocol: 1 })).toBe(false);
});

test('signing requirement of the running app: the same one the update must satisfy', () => {
  const out = 'Executable=/Applications/Atelier.app/Contents/MacOS/Atelier\ndesignated => identifier "app.atelier.desktop" and certificate root = H"2cd6"\n';
  expect(designatedRequirement(out)).toBe('identifier "app.atelier.desktop" and certificate root = H"2cd6"');
  // Ad-hoc signature: the requirement is this build's fingerprint, no update could satisfy it.
  expect(designatedRequirement('designated => cdhash H"abc"\n')).toBeNull();
  expect(designatedRequirement('')).toBeNull();
  // Defense in depth: a requirement naming only an identifier would accept any app that claims the same bundle id.
  expect(designatedRequirement('designated => identifier "app.atelier.desktop"\n')).toBeNull();
  expect(designatedRequirement('designated => identifier "app.atelier.desktop" or info [x] = "y"\n')).toBeNull();
  expect(designatedRequirement('designated => anchor apple generic and identifier "app.atelier.desktop" and certificate leaf[subject.OU] = "ABCDE12345"\n')).toMatch(/^anchor apple generic/);
});

test('after a swap the replaced app stays as .Atelier-previous.app until the new version has started once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-prev-'));
  const app = join(dir, 'Atelier.app');
  const prev = join(dir, '.Atelier-previous.app');
  mkdirSync(join(prev, 'Contents'), { recursive: true });
  // First launch of the new version (the last run was the old one): kept, a rollback is still possible.
  expect(previousAppToDrop(app, '0.1.0', '0.2.0')).toBeNull();
  // The new version already ran once: drop it.
  expect(previousAppToDrop(app, '0.2.0', '0.2.0')).toBe(prev);
  // Nothing there, or not a folder: nothing to drop.
  expect(previousAppToDrop(join(dir, 'other/Atelier.app'), '0.2.0', '0.2.0')).toBeNull();
  const odd = mkdtempSync(join(tmpdir(), 'atl-prev-'));
  writeFileSync(join(odd, '.Atelier-previous.app'), 'not a bundle');
  expect(previousAppToDrop(join(odd, 'Atelier.app'), '0.2.0', '0.2.0')).toBeNull();
  expect(previousAppToDrop(app, null, '0.2.0')).toBeNull();
});

test('the running app can be replaced only from a writable folder outside a disk image and App Translocation', () => {
  const ok = () => true;
  expect(appLocationProblem('/Applications/Atelier.app', ok)).toBeNull();
  expect(appLocationProblem('/Users/me/Applications/Atelier.app', ok)).toBeNull();
  expect(appLocationProblem('/Volumes/Atelier/Atelier.app', ok)).toBe('disk-image');
  expect(appLocationProblem('/private/var/folders/x/AppTranslocation/1234-ABCD/d/Atelier.app', ok)).toBe('translocated');
  expect(appLocationProblem('/Applications/Atelier.app', (p) => p !== '/Applications')).toBe('read-only');
  expect(appLocationProblem('/Applications/Atelier.app', (p) => p !== '/Applications/Atelier.app')).toBe('read-only');
});

function setHelper(appPath: string, content: string | Buffer) {
  const d = join(appPath, `Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-${process.arch}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'spawn-helper'), content);
}

function fakeApps() {
  const dir = mkdtempSync(join(tmpdir(), 'atl-upd-'));
  const app = join(dir, 'Atelier.app');
  const staged = join(dir, 'updates', 'Atelier.app');
  mkdirSync(app, { recursive: true });
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(app, 'v'), 'old');
  writeFileSync(join(staged, 'v'), 'new');
  for (const [p, builtAt] of [[app, 1], [staged, 2]] as const) {
    mkdirSync(join(p, 'Contents/Resources'), { recursive: true });
    writeFileSync(join(p, 'Contents/Resources/atelier-build.json'), JSON.stringify({ protocol: 1, builtAt }));
    setHelper(p, 'helper-v1');
  }
  return { dir, app, staged };
}

const deps = (app: string, staged: string, calls: string[][], extra: Partial<UpdateDeps> = {}): UpdateDeps => ({
  appPath: app, stagedPath: staged, protocol: 1,
  exec: async (cmd, args) => { calls.push([cmd, ...args]); return 'designated => identifier "x" and certificate root = H"1"\n'; },
  spawnHelper: () => { calls.push(['spawn']); },
  quit: () => { calls.push(['quit']); },
  canWrite: () => true,
  ...extra
});

function deadPid(): number {
  const r = spawnSync('/bin/sh', ['-c', 'echo $$']);
  return Number(String(r.stdout).trim());
}

test('the helper waits for the app to close, swaps, records and reopens', () => {
  const { dir, app, staged } = fakeApps();
  const log = join(dir, 'log');
  const rec = join(dir, 'rec.sh');
  writeFileSync(rec, `#!/bin/sh\necho "$0 $*" >> "${log}"\n`, { mode: 0o755 });
  execFileSync('/bin/sh', ['-c', SWAP_SCRIPT, 'sh', String(deadPid()), staged, app, rec, rec, '5']);
  expect(readFileSync(join(app, 'v'), 'utf8')).toBe('new');
  expect(existsSync(staged)).toBe(false);
  // The replaced app is kept for a manual rollback; the new version drops it once it has started (previousAppToDrop).
  expect(readFileSync(join(dir, '.Atelier-previous.app/v'), 'utf8')).toBe('old');
  expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([`${rec} -f ${app}`, `${rec} ${app}`]);
});

test('if the app does not close (quit cancelled) the helper gives up without touching anything', () => {
  const { app, staged } = fakeApps();
  const r = spawnSync('/bin/sh', ['-c', SWAP_SCRIPT, 'sh', String(process.pid), staged, app, '/usr/bin/true', '/usr/bin/true', '1']);
  expect(r.status).toBe(1);
  expect(readFileSync(join(app, 'v'), 'utf8')).toBe('old');
  expect(readFileSync(join(staged, 'v'), 'utf8')).toBe('new');
});

test('apply: without the same signature as the running app nothing is launched', async () => {
  const { app, staged } = fakeApps();
  const calls: string[][] = [];
  const w = new UpdateWatcher(deps(app, staged, calls, {
    exec: async (cmd, args) => { calls.push([cmd, ...args]); if (args.includes('--verify')) throw new Error('fails requirement'); return 'designated => identifier "x" and certificate root = H"1"\n'; }
  }));
  await w.init();
  expect(w.ready()).toBe(true);
  expect(await w.apply()).toBe(false);
  expect(calls.some((c) => c.includes('--verify'))).toBe(true);
  expect(calls.some((c) => c[0] === 'spawn' || c[0] === 'quit')).toBe(false);
});


test('atelierd uses the bundle\'s spawn-helper: updating from the app only works if it is identical', async () => {
  const { app, staged } = fakeApps();
  expect(ptyHelperHash(app)).toBe(ptyHelperHash(staged));
  const w = new UpdateWatcher(deps(app, staged, []));
  await w.init();
  expect(w.ready()).toBe(true);
  setHelper(staged, 'helper-v2');
  expect(w.ready()).toBe(false);
  expect(ptyHelperHash('/nonexistent/Atelier.app')).toBeNull();
});

test('the same spawn-helper signed on another build machine (CI on macOS 15 vs 26, a local Mac) still updates in place', async () => {
  const { app, staged } = fakeApps();
  setHelper(app, macho('helper-code', 19600));
  setHelper(staged, macho('helper-code', 19312));
  const w = new UpdateWatcher(deps(app, staged, []));
  await w.init();
  expect(w.ready()).toBe(true);
  setHelper(staged, macho('other-code', 19600));
  expect(w.ready()).toBe(false);
});

test('if /Applications is not writable the app is not closed for nothing', async () => {
  const { app, staged } = fakeApps();
  const calls: string[][] = [];
  expect(await new UpdateWatcher(deps(app, staged, calls, { canWrite: () => false })).apply()).toBe(false);
  expect(calls.some((c) => c[0] === 'spawn' || c[0] === 'quit')).toBe(false);
});

test('double click on Restart: a single helper', async () => {
  const { app, staged } = fakeApps();
  const calls: string[][] = [];
  const w = new UpdateWatcher(deps(app, staged, calls));
  const [a, b] = await Promise.all([w.apply(), w.apply()]);
  expect([a, b].filter(Boolean)).toHaveLength(1);
  expect(calls.filter((c) => c[0] === 'spawn')).toHaveLength(1);
});

test('if the swap fails the helper puts the old app back and reopens it anyway', () => {
  const { dir, app, staged } = fakeApps();
  const log = join(dir, 'log');
  const rec = join(dir, 'rec.sh');
  writeFileSync(rec, `#!/bin/sh\necho "$0 $*" >> "${log}"\n`, { mode: 0o755 });
  const missing = join(dir, 'updates', 'gone.app');
  const r = spawnSync('/bin/sh', ['-c', SWAP_SCRIPT, 'sh', String(deadPid()), missing, app, rec, rec, '5']);
  expect(r.status).toBe(1);
  expect(readFileSync(join(app, 'v'), 'utf8')).toBe('old');
  expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([`${rec} ${app}`]);
  expect(existsSync(staged)).toBe(true);
});

test('app installed with an ad-hoc signature: no "Update ready" (the click would always fail)', async () => {
  const { app, staged } = fakeApps();
  const adhoc = new UpdateWatcher(deps(app, staged, [], { exec: async () => '# designated => cdhash H"abc"\n' }));
  await adhoc.init();
  expect(adhoc.ready()).toBe(false);
  const signed = new UpdateWatcher(deps(app, staged, []));
  await signed.init();
  expect(signed.ready()).toBe(true);
});

test('until the app signature has been read there is no "Update ready" (no flash on an ad-hoc app)', async () => {
  const { app, staged } = fakeApps();
  const w = new UpdateWatcher(deps(app, staged, []));
  expect(w.ready()).toBe(false);
  await w.init();
  expect(w.ready()).toBe(true);
});
