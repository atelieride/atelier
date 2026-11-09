import { afterEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import type { UpdateStatus } from '@shared/update-feed';
import { canCheck, footerUpdate, offersCheck, storeUpdates, updateFailedToast, updateSummary, versionChannel } from './update-view';

// On Windows the Store updates the app. Our updater is macOS's: no channel, no check, no
// "development build" notice about npm run stage-update.

afterEach(() => { resetPlatformForTests(); });

const st = (o: Partial<UpdateStatus> = {}): UpdateStatus => ({
  available: false, buildChannel: null, channel: 'beta', version: '0.2.0-beta.16', lastCheck: null, phase: { kind: 'idle' }, currentNotes: null, ...o
});

test('on Windows the Store updates the app; on macOS our updater does', () => {
  initPlatform('win32');
  expect(storeUpdates()).toBe(true);
  initPlatform('darwin');
  expect(storeUpdates()).toBe(false);
});

test('the version line names no channel on Windows, even with Beta chosen before', () => {
  initPlatform('win32');
  expect(versionChannel(st())).toBe(null);
  initPlatform('darwin');
  expect(versionChannel(st({ available: true }))).toBe('Beta channel');
  expect(versionChannel(st({ channel: null }))).toBe('Development build');
  expect(versionChannel(st({ available: true, channel: null }))).toBe(null);
  expect(versionChannel(null)).toBe(null);
});

// What the Store's updates look like.
const win = (phase: UpdateStatus['phase'], o: Partial<UpdateStatus> = {}): UpdateStatus => st({ available: true, channel: null, phase, ...o });

test('Windows: the Store card for each phase', () => {
  initPlatform('win32');
  expect(updateSummary(win({ kind: 'idle' }, { available: false }))).toEqual({ tone: 'idle', title: 'Updates come from the Microsoft Store', detail: expect.stringContaining('Microsoft Store') });
  expect(updateSummary(win({ kind: 'idle' }))).toEqual({ tone: 'idle', title: 'Not checked yet' });
  expect(updateSummary(win({ kind: 'checking' }))).toEqual({ tone: 'busy', title: 'Checking the Microsoft Store…' });
  expect(updateSummary(win({ kind: 'up-to-date' }))).toEqual({ tone: 'ok', title: 'Atelier is up to date' });
  expect(updateSummary(win({ kind: 'downloading', version: '', received: 42, total: 100 }))).toEqual({ tone: 'busy', title: 'Installing the update · 42%', progress: 0.42 });
  expect(updateSummary(win({ kind: 'ready', version: '0.2.0-beta.22', notes: '' }))).toEqual({ tone: 'ok', title: 'Atelier 0.2.0-beta.22 is ready', detail: 'Restart to update: your sessions keep running.', action: 'restart', changelog: true });
  // Staged by Windows until Atelier closes: no version to name.
  expect(updateSummary(win({ kind: 'ready', version: '', notes: '' }))).toEqual({ tone: 'ok', title: 'The update is ready', detail: 'Restart to update: your sessions keep running.', action: 'restart', changelog: true });
  const store = updateSummary(win({ kind: 'store', reason: 'no-silent' }));
  expect(store).toMatchObject({ tone: 'warn', title: 'An update is in the Microsoft Store', action: 'store' });
  expect(store.detail).toMatch(/automatic app updates/i);
  expect(updateSummary(win({ kind: 'store', reason: 'windows' })).detail).toMatch(/sessions keep running/);
  expect(updateSummary(win({ kind: 'error', error: 'store', message: 'error 803f6101' }))).toEqual({ tone: 'warn', title: "Couldn't check the Microsoft Store", detail: 'Atelier will try again later.' });
  expect(updateSummary(win({ kind: 'error', error: 'store-download', message: 'wifi' }))).toMatchObject({ tone: 'warn', title: "The update couldn't be installed", detail: expect.stringMatching(/Wi-Fi/), action: 'store' });
  expect(updateSummary(win({ kind: 'error', error: 'store-download', message: 'error 80070005 Access is denied.' })).detail).toMatch(/Microsoft Store/);
});

test('Windows: the footer pill — ready, or a quiet "Update available" for a Store update; nothing while it installs', () => {
  initPlatform('win32');
  expect(footerUpdate(true, win({ kind: 'ready', version: '0.2.0-beta.22', notes: '' }))).toBe('ready');
  expect(footerUpdate(false, win({ kind: 'store', reason: 'windows' }))).toBe('available');
  expect(footerUpdate(false, win({ kind: 'downloading', version: '', received: 1, total: 100 }))).toBe(null);
  expect(footerUpdate(false, win({ kind: 'error', error: 'store', message: '' }))).toBe(null);
});

test('Windows: Check Now while the Store can be asked and nothing is running; never without the package', () => {
  initPlatform('win32');
  expect(canCheck(win({ kind: 'up-to-date' }))).toBe(true);
  expect(canCheck(win({ kind: 'store', reason: 'no-silent' }))).toBe(true);
  expect(canCheck(win({ kind: 'checking' }))).toBe(false);
  expect(canCheck(win({ kind: 'downloading', version: '', received: 1, total: 100 }))).toBe(false);
  expect(canCheck(win({ kind: 'idle' }, { available: false }))).toBe(false);
  // macOS: unchanged, a channel is needed.
  initPlatform('darwin');
  expect(canCheck(win({ kind: 'up-to-date' }))).toBe(false);
});

test('Windows: no Check Now once an update is ready (nothing left to ask until the restart)', () => {
  initPlatform('win32');
  expect(canCheck(win({ kind: 'ready', version: '0.2.0-beta.22', notes: '' }))).toBe(false);
  initPlatform('darwin');
  expect(canCheck(st({ available: true, phase: { kind: 'ready', version: '9.0.0', notes: '' } }))).toBe(true);
});

test("a Restart that can't apply: macOS offers the release page, Windows the Store", () => {
  initPlatform('darwin');
  expect(updateFailedToast()).toEqual({ text: "The update couldn't be installed — download it from the release page", label: 'Open Release Page', target: 'release' });
  initPlatform('win32');
  expect(updateFailedToast()).toEqual({ text: "The update couldn't be installed — get it from the Microsoft Store", label: 'Open Microsoft Store', target: 'store' });
});

test('the palette offers "Check for updates" on macOS always, on Windows when the Store can be asked', () => {
  initPlatform('darwin');
  expect(offersCheck(null)).toBe(true);
  initPlatform('win32');
  expect(offersCheck(win({ kind: 'up-to-date' }))).toBe(true);
  expect(offersCheck(win({ kind: 'idle' }, { available: false }))).toBe(false);
  expect(offersCheck(null)).toBe(false);
});
