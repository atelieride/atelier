import { expect, test } from 'vitest';
import type { UpdateStatus } from '@shared/update-feed';
import { RelaunchArm, StoreUpdater, type StoreRun, type StoreRunner } from './store-updates';

// The Store updater with a scripted atelier-store.exe.

const CHECK = (o: { registered?: string; updates?: number; silent?: 0 | 1 } = {}): StoreRun =>
  ({ code: 0, out: `family FrancescoMusso.AtelierIDE_q82zjjpjsmf54\nregistered ${o.registered ?? '0.2.21.0'}\nupdates ${o.updates ?? 0}\nsilent ${o.silent ?? 1}\n` });

interface Script { checks: StoreRun[]; update?: { lines: string[]; code: number } }

function setup(script: Script, o: { build?: number | null; runner?: boolean } = {}) {
  const calls: string[] = [];
  const statuses: UpdateStatus[] = [];
  let release: (() => void) | null = null;
  const runner: StoreRunner = {
    check: async () => { calls.push('check'); return script.checks.length > 1 ? script.checks.shift()! : script.checks[0]!; },
    update: async (onLine) => {
      calls.push('update');
      if (release === null && hold) await new Promise<void>((r) => { release = r; });
      for (const l of script.update?.lines ?? []) onLine(l);
      return { code: script.update?.code ?? 0, out: (script.update?.lines ?? []).join('\n') };
    }
  };
  let hold = false;
  const logs: string[] = [];
  const u = new StoreUpdater({
    version: '0.2.0-beta.21', build: o.build === undefined ? 26200 : o.build, runner: o.runner === false ? null : runner,
    now: () => 1_000, log: (m) => logs.push(m), onStatus: (s) => statuses.push(s)
  });
  return { u, calls, statuses, logs, holdUpdate: () => { hold = true; }, releaseUpdate: () => release?.() };
}

test('without the helper (dev run, unpacked build) the updater is not available and never runs anything', async () => {
  const { u, calls } = setup({ checks: [CHECK()] }, { runner: false });
  expect(u.status()).toMatchObject({ available: false, channel: null, buildChannel: null, phase: { kind: 'idle' } });
  await u.check();
  expect(calls).toEqual([]);
});

test('no package identity: not available from then on, quietly', async () => {
  const { u, calls } = setup({ checks: [{ code: 1, out: 'error 80073d54 The process has no package identity.\n' }] });
  expect(u.status().available).toBe(true);
  await u.check();
  expect(u.status()).toMatchObject({ available: false, phase: { kind: 'idle' } });
  await u.check();
  expect(calls).toEqual(['check']);
});

test('nothing new: up to date, with the time of the check', async () => {
  const { u, statuses } = setup({ checks: [CHECK()] });
  await u.check();
  expect(u.status()).toMatchObject({ available: true, version: '0.2.0-beta.21', lastCheck: 1_000, phase: { kind: 'up-to-date' } });
  expect(statuses.map((s) => s.phase.kind)).toEqual(['checking', 'up-to-date']);
});

test('a newer version already registered: ready to restart into, without downloading anything', async () => {
  const { u, calls } = setup({ checks: [CHECK({ registered: '0.2.22.0' })] });
  await u.check();
  expect(u.status().phase).toEqual({ kind: 'ready', version: '0.2.0-beta.22', notes: '' });
  expect(u.ready()).toBe(true);
  expect(u.family()).toBe('FrancescoMusso.AtelierIDE_q82zjjpjsmf54');
  expect(calls).toEqual(['check']);
});

test('ready sticks: later checks run nothing and change nothing', async () => {
  const { u, calls } = setup({ checks: [CHECK({ registered: '0.2.22.0' }), CHECK()] });
  await u.check();
  await u.check();
  expect(calls).toEqual(['check']);
  expect(u.status().phase.kind).toBe('ready');
});

test('a Store update on 24H2+ with silent allowed: downloaded and installed in the background, progress shown, then ready', async () => {
  const { u, calls, statuses } = setup({
    checks: [CHECK({ updates: 1 }), CHECK({ registered: '0.2.22.0' })],
    update: { lines: ['progress 0.100', 'progress 0.550', 'bogus', 'progress 1.000', 'done completed'], code: 0 }
  });
  await u.check();
  expect(calls).toEqual(['check', 'update', 'check']);
  const dl = statuses.filter((s) => s.phase.kind === 'downloading').map((s) => s.phase);
  expect(dl).toEqual([
    { kind: 'downloading', version: '', received: 0, total: 100 },
    { kind: 'downloading', version: '', received: 10, total: 100 },
    { kind: 'downloading', version: '', received: 55, total: 100 },
    { kind: 'downloading', version: '', received: 100, total: 100 }
  ]);
  expect(u.status().phase).toEqual({ kind: 'ready', version: '0.2.0-beta.22', notes: '' });
});

test('one check at a time: a check during a download is ignored', async () => {
  const s = setup({ checks: [CHECK({ updates: 1 }), CHECK({ registered: '0.2.22.0' })], update: { lines: ['done completed'], code: 0 } });
  s.holdUpdate();
  const first = s.u.check();
  await new Promise((r) => setTimeout(r, 0));
  expect(s.u.status().phase.kind).toBe('downloading');
  await s.u.check();
  s.releaseUpdate();
  await first;
  expect(s.calls).toEqual(['check', 'update', 'check']);
});

test('silent downloads not allowed (Store automatic updates off, metered): the Store is where to get it', async () => {
  const { u, calls } = setup({ checks: [CHECK({ updates: 1, silent: 0 })] });
  await u.check();
  expect(u.status().phase).toEqual({ kind: 'store', reason: 'no-silent' });
  expect(calls).toEqual(['check']);
});

test('Windows before 24H2: never installed in the background (it would close Atelier)', async () => {
  const { u, calls } = setup({ checks: [CHECK({ updates: 1 })] }, { build: 22631 });
  await u.check();
  expect(u.status().phase).toEqual({ kind: 'store', reason: 'windows' });
  expect(calls).toEqual(['check']);
});

test('a check that fails or prints nonsense is a Store error, retried at the next check', async () => {
  const { u, logs } = setup({ checks: [{ code: 1, out: 'error 803f6101 \n' }, { code: 0, out: 'nonsense\n' }, { code: null, out: '' }, CHECK()] });
  await u.check();
  expect(u.status().phase).toEqual({ kind: 'error', error: 'store', message: 'error 803f6101' });
  await u.check();
  expect(u.status().phase).toMatchObject({ kind: 'error', error: 'store' });
  await u.check();
  expect(u.status().phase).toMatchObject({ kind: 'error', error: 'store' });
  await u.check();
  expect(u.status().phase.kind).toBe('up-to-date');
  expect(logs.filter((l) => l.includes('store check failed'))).toHaveLength(3);
});

test('a download that ends other than completed is a download error naming why', async () => {
  for (const [result, message] of [['wifi', 'wifi'], ['canceled', 'canceled'], ['low-battery', 'low-battery'], ['error', 'error']] as const) {
    const { u } = setup({ checks: [CHECK({ updates: 1 })], update: { lines: ['progress 0.300', `done ${result}`], code: 1 } });
    await u.check();
    expect(u.status().phase).toEqual({ kind: 'error', error: 'store-download', message });
  }
  const { u } = setup({ checks: [CHECK({ updates: 1 })], update: { lines: ['progress 0.300', 'error 80070005 Access is denied.'], code: 1 } });
  await u.check();
  expect(u.status().phase).toEqual({ kind: 'error', error: 'store-download', message: 'error 80070005 Access is denied.' });
});

test('Restart arms one relaunch into the registered version, for 120 s only (a quit cancelled over unsaved files forgets it)', () => {
  const arm = new RelaunchArm();
  expect(arm.take(0)).toBe(null);
  arm.arm('FrancescoMusso.AtelierIDE_q82zjjpjsmf54', 1_000);
  expect(arm.take(121_001)).toBe(null);
  arm.arm('FrancescoMusso.AtelierIDE_q82zjjpjsmf54', 1_000);
  expect(arm.take(60_000)).toBe('shell:AppsFolder\\FrancescoMusso.AtelierIDE_q82zjjpjsmf54!Atelier');
  // Once: a second will-quit (one prevented and fired again) starts nothing more.
  expect(arm.take(60_001)).toBe(null);
});

test('a runner that throws (spawn refused, bad script) is a Store error, never a phase stuck on checking', async () => {
  const statuses: UpdateStatus[] = [];
  const boom = async (): Promise<StoreRun> => { throw new Error('spawn EPERM'); };
  const u = new StoreUpdater({ version: '0.2.0-beta.21', build: 26200, runner: { check: boom, update: boom }, now: () => 1, log: () => {}, onStatus: (s) => statuses.push(s) });
  await expect(u.check()).resolves.toBeUndefined();
  expect(u.status().phase).toEqual({ kind: 'error', error: 'store', message: 'no answer' });
  // A download that throws, after a check that found an update.
  let calls = 0;
  const v = new StoreUpdater({
    version: '0.2.0-beta.21', build: 26200, now: () => 1, log: () => {}, onStatus: () => {},
    runner: { check: async () => { calls++; return CHECK({ updates: 1 }); }, update: boom }
  });
  await expect(v.check()).resolves.toBeUndefined();
  expect(v.status().phase).toEqual({ kind: 'error', error: 'store-download', message: 'no answer' });
  // And the next check runs again.
  await v.check();
  expect(calls).toBe(2);
});

test('an install the Store reports completed is ready even while the Store still lists it (the packaged run: staged until the next start)', async () => {
  // Second packaged run, 2026-10-27: 0.2.21.0 already staged, the install answered completed at once and the Store kept
  // listing the update; closing Atelier and starting it through shell:AppsFolder registered and ran 0.2.21.0.
  const { u, logs } = setup({ checks: [CHECK({ updates: 1 }), CHECK({ updates: 1 })], update: { lines: ['done completed'], code: 0 } });
  await u.check();
  expect(u.status().phase).toEqual({ kind: 'ready', version: '', notes: '' });
  expect(logs.some((l) => l.includes('staged'))).toBe(true);
});

test('"none" while the Store still lists an update: an install error to retry, never "up to date"', async () => {
  const { u } = setup({ checks: [CHECK({ updates: 1 }), CHECK({ updates: 1 })], update: { lines: ['done none'], code: 0 } });
  await u.check();
  expect(u.status().phase).toEqual({ kind: 'error', error: 'store-download', message: 'error' });
  // Nothing left in the Store and nothing newer registered (someone else got there): up to date.
  const v = setup({ checks: [CHECK({ updates: 1 }), CHECK()], update: { lines: ['done none'], code: 0 } });
  await v.u.check();
  expect(v.u.status().phase.kind).toBe('up-to-date');
});

test('the check after an install fails: a Store error; no identity then: not available', async () => {
  const a = setup({ checks: [CHECK({ updates: 1 }), { code: null, out: '' }], update: { lines: ['done completed'], code: 0 } });
  await a.u.check();
  expect(a.u.status().phase).toEqual({ kind: 'error', error: 'store', message: 'no answer' });
  const b = setup({ checks: [CHECK({ updates: 1 }), { code: 1, out: 'error 80073d54 no identity\n' }], update: { lines: ['done completed'], code: 0 } });
  await b.u.check();
  expect(b.u.status()).toMatchObject({ available: false, phase: { kind: 'idle' } });
});

test('a check while the Store has an update Atelier does not install runs again (the setting may have changed)', async () => {
  const { u, calls } = setup({ checks: [CHECK({ updates: 1, silent: 0 }), CHECK({ updates: 1, silent: 1 }), CHECK({ registered: '0.2.22.0' })], update: { lines: ['done completed'], code: 0 } });
  await u.check();
  expect(u.status().phase.kind).toBe('store');
  await u.check();
  expect(calls).toEqual(['check', 'check', 'update', 'check']);
  expect(u.status().phase.kind).toBe('ready');
});

test('RelaunchArm.disarm: a Restart whose quit was called off relaunches nothing later', () => {
  const arm = new RelaunchArm();
  arm.arm('FrancescoMusso.AtelierIDE_q82zjjpjsmf54', 1_000);
  arm.disarm();
  expect(arm.take(2_000)).toBe(null);
});

test('completed, nothing left in the Store, nothing newer registered yet: staged until Atelier closes, so ready (the packaged run, 2026-10-27)', async () => {
  // With the real app running, UpdateWhileInUse=defer stages the new version (Get-AppxPackage -AllUsers: Staged) and
  // registers it when Atelier closes: the registered version can't name it, and nothing else readable without admin can.
  const { u, logs } = setup({ checks: [CHECK({ updates: 1 }), CHECK()], update: { lines: ['done completed'], code: 0 } });
  await u.check();
  expect(u.status().phase).toEqual({ kind: 'ready', version: '', notes: '' });
  expect(u.ready()).toBe(true);
  expect(logs.some((l) => l.includes('staged'))).toBe(true);
  // A check later on (the 6 h timer) leaves it ready.
  await u.check();
  expect(u.status().phase).toEqual({ kind: 'ready', version: '', notes: '' });
});
