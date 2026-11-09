import { expect, test } from 'vitest';
import type { UpdatePhase, UpdateStatus } from '@shared/update-feed';
import { t } from './i18n/en';
import { canCheck, channelOptions, checkedAgo, footerUpdate, updateSummary } from './update-view';

const st = (phase: UpdatePhase, o: Partial<UpdateStatus> = {}): UpdateStatus => ({
  available: true, buildChannel: 'stable', channel: 'stable', version: '0.2.0', lastCheck: null, phase, currentNotes: null, ...o
});

test('when it was last checked, in words', () => {
  const now = 10 * 86_400_000;
  expect(checkedAgo(null, now)).toBe('Never');
  expect(checkedAgo(now - 20_000, now)).toBe('Just now');
  expect(checkedAgo(now - 5 * 60_000, now)).toBe('5 min ago');
  expect(checkedAgo(now - 3 * 3_600_000, now)).toBe('3 h ago');
  expect(checkedAgo(now - 86_400_000, now)).toBe('Yesterday');
  expect(checkedAgo(now - 4 * 86_400_000, now)).toBe('4 days ago');
});

test('the status card: one line per phase, errors say what happened and that nothing was installed', () => {
  expect(updateSummary(st({ kind: 'idle' }, { available: false }))).toMatchObject({ tone: 'idle', title: expect.stringMatching(/installed app/) });
  expect(updateSummary(st({ kind: 'idle' }, { channel: null }))).toMatchObject({ tone: 'idle', title: 'Updates are off' });
  expect(updateSummary(st({ kind: 'idle' }))).toMatchObject({ tone: 'idle', title: 'Not checked yet' });
  expect(updateSummary(st({ kind: 'checking' }))).toMatchObject({ tone: 'busy', title: 'Checking for updates…' });
  expect(updateSummary(st({ kind: 'up-to-date' }))).toMatchObject({ tone: 'ok', title: 'Atelier is up to date' });
  expect(updateSummary(st({ kind: 'downloading', version: '0.3.0', received: 42, total: 100 }))).toMatchObject({ tone: 'busy', title: 'Downloading 0.3.0 · 42%', progress: 0.42 });
  expect(updateSummary(st({ kind: 'verifying', version: '0.3.0' }))).toMatchObject({ tone: 'busy', title: 'Verifying 0.3.0…' });
  expect(updateSummary(st({ kind: 'ready', version: '0.3.0', notes: '' }))).toMatchObject({ tone: 'ok', title: 'Atelier 0.3.0 is ready', action: 'restart' });
  expect(updateSummary(st({ kind: 'needs-restart', version: '0.3.0', notes: '' }))).toMatchObject({ tone: 'warn', action: 'release-page', detail: expect.stringMatching(/atelierd/) });
  expect(updateSummary(st({ kind: 'error', error: 'signature', message: 'x' }))).toMatchObject({ tone: 'err', detail: expect.stringMatching(/release key/) });
  expect(updateSummary(st({ kind: 'error', error: 'identity', message: 'x' }))).toMatchObject({ tone: 'err', detail: expect.stringMatching(/identity/) });
  expect(updateSummary(st({ kind: 'error', error: 'network', message: 'x' }))).toMatchObject({ tone: 'warn', detail: expect.stringMatching(/try again/i) });
});

test('"Check Now" only where a check can run and none is running', () => {
  expect(canCheck(st({ kind: 'up-to-date' }))).toBe(true);
  expect(canCheck(st({ kind: 'error', error: 'signature', message: '' }))).toBe(true);
  expect(canCheck(st({ kind: 'checking' }))).toBe(false);
  expect(canCheck(st({ kind: 'downloading', version: '1', received: 0, total: 1 }))).toBe(false);
  expect(canCheck(st({ kind: 'idle' }, { channel: null }))).toBe(false);
  expect(canCheck(st({ kind: 'idle' }, { available: false }))).toBe(false);
  expect(canCheck(null)).toBe(false);
});

test('an app that cannot replace itself (disk image, App Translocation, read-only folder): move it to Applications', () => {
  for (const problem of ['disk-image', 'translocated', 'read-only'] as const) {
    const s = updateSummary(st({ kind: 'location', version: '0.3.0', problem }));
    expect(s).toMatchObject({ tone: 'warn', title: 'Move Atelier to your Applications folder to get updates', action: 'applications' });
    expect(s.detail).toMatch(/0\.3\.0/);
  }
  expect(updateSummary(st({ kind: 'location', version: '0.3.0', problem: 'disk-image' })).detail).toMatch(/disk image/);
  expect(updateSummary(st({ kind: 'location', version: '0.3.0', problem: 'translocated' })).detail).toMatch(/Downloads|where it was downloaded/);
  expect(footerUpdate(false, st({ kind: 'location', version: '0.3.0', problem: 'read-only' }))).toBe('available');
});

test('a release with a missing file says so (not a connection problem), with the release page at hand', () => {
  expect(updateSummary(st({ kind: 'error', error: 'incomplete', message: 'x', version: '0.3.0' }))).toMatchObject({ tone: 'err', title: 'Release incomplete', action: 'release-page' });
});

test('a failed restart-to-update points users to the release page, never to npm', () => {
  expect(t.updateFailed).toBe("The update couldn't be installed — download it from the release page");
  expect(t.updateFailed).not.toMatch(/npm/);
  expect(t.upd.openRelease).toBe('Open Release Page');
});

test('the channel control can go back to Auto, which names the build\'s own channel', () => {
  expect(channelOptions('stable')).toEqual([
    { value: 'auto', label: 'Auto (Stable)' }, { value: 'off', label: 'Off' }, { value: 'stable', label: 'Stable' }, { value: 'beta', label: 'Beta' }
  ]);
  expect(channelOptions('beta')[0]).toEqual({ value: 'auto', label: 'Auto (Beta)' });
  expect(channelOptions(null)[0]).toEqual({ value: 'auto', label: 'Auto (Off)' });
});

test('the footer: "Update ready" wins; an update that needs atelierd restarted is a quieter notice', () => {
  expect(footerUpdate(true, st({ kind: 'needs-restart', version: '0.3.0', notes: '' }))).toBe('ready');
  expect(footerUpdate(false, st({ kind: 'needs-restart', version: '0.3.0', notes: '' }))).toBe('available');
  expect(footerUpdate(false, st({ kind: 'error', error: 'network', message: '' }))).toBeNull();
  expect(footerUpdate(false, null)).toBeNull();
});
