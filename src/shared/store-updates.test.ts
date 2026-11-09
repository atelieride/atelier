import { expect, test } from 'vitest';
// @ts-expect-error -- plain ESM script, Node built-ins only (it runs in the release jobs that install nothing).
import { msixVersion } from '../../scripts/win/msix-version.mjs';
import { DEFER_BUILD, parseCheck, parseHelperError, parseUpdateLine, semverOfMsix, storeDecision, windowsBuild, type StoreCheck } from './store-updates';

// What atelier-store.exe prints and what Atelier makes of it.

test('check: the four lines, in any order, and nothing else', () => {
  const out = 'family FrancescoMusso.AtelierIDE_q82zjjpjsmf54\r\nregistered 0.2.21.0\r\nupdates 1\r\nsilent 1\r\n';
  expect(parseCheck(out)).toEqual({ family: 'FrancescoMusso.AtelierIDE_q82zjjpjsmf54', registered: '0.2.21.0', updates: 1, silent: true });
  expect(parseCheck('silent 0\nupdates 0\nfamily A.B_x\n')).toEqual({ family: 'A.B_x', registered: null, updates: 0, silent: false });
});

test('check: malformed or partial output is refused, never guessed', () => {
  for (const bad of [
    '', 'updates 1\nsilent 1\n', 'family A_b\nsilent 1\n', 'family A_b\nupdates 1\n',
    'family A_b\nupdates x\nsilent 1\n', 'family A_b\nupdates 1\nsilent 2\n', 'family A_b\nupdates 1\nsilent 1\nregistered 1.2.3\n',
    'family A b\nupdates 1\nsilent 1\n', 'family A_b\nupdates 1\nsilent 1\nsurprise 1\n', 'family A_b\nfamily C_d\nupdates 1\nsilent 1\n',
    'family A_b\nupdates 1\nsilent 1\nregistered 70000.0.0.0\n'
  ]) expect(parseCheck(bad), JSON.stringify(bad)).toBe(null);
});

test('the helper reports a failure as an HRESULT and a message', () => {
  expect(parseHelperError('error 80073d54 The process has no package identity.\r\n')).toEqual({ hresult: '80073d54', message: 'The process has no package identity.' });
  expect(parseHelperError('progress 0.100\nerror 803f6101 \n')).toEqual({ hresult: '803f6101', message: '' });
  expect(parseHelperError('family A_b\nupdates 1\nsilent 1\n')).toBe(null);
});

test('update lines: progress between 0 and 1, and how it ended', () => {
  expect(parseUpdateLine('progress 0.420')).toEqual({ kind: 'progress', value: 0.42 });
  expect(parseUpdateLine('progress 1.000\r')).toEqual({ kind: 'progress', value: 1 });
  for (const r of ['completed', 'none', 'canceled', 'error', 'low-battery', 'wifi'] as const) expect(parseUpdateLine(`done ${r}`)).toEqual({ kind: 'done', result: r });
  for (const bad of ['progress 1.5', 'progress -0.1', 'progress', 'progress abc', 'done maybe', 'done', 'hello', '']) expect(parseUpdateLine(bad), bad).toBe(null);
});

test('MSIX versions map back to the release they were packed from (inverse of scripts/win/msix-version.mjs)', () => {
  for (const v of ['0.2.0-beta.1', '0.2.0-beta.21', '0.2.0', '0.2.1-beta.3', '1.0.0', '1.4.2-beta.998', '2.1.64']) {
    expect(semverOfMsix(msixVersion(v) as string), v).toBe(v);
  }
  // Not ours (a revision, or a build field no release makes): no version rather than a wrong one.
  for (const bad of ['0.2.21.1', '0.2.65000.0', '0.2.21', 'x.2.21.0', '']) expect(semverOfMsix(bad), bad).toBe(null);
});

test("Windows' build number from os.release()", () => {
  expect(windowsBuild('10.0.26100')).toBe(26100);
  expect(windowsBuild('10.0.19045')).toBe(19045);
  expect(windowsBuild('23.6.0')).toBe(null);
  expect(windowsBuild('')).toBe(null);
});

const check = (o: Partial<StoreCheck> = {}): StoreCheck => ({ family: 'A_b', registered: '0.2.21.0', updates: 0, silent: true, ...o });

test('a newer version already registered (by us or by the Store itself) is ready to restart into', () => {
  expect(storeDecision(check({ registered: '0.2.22.0' }), { running: '0.2.0-beta.21', build: DEFER_BUILD })).toEqual({ kind: 'ready', version: '0.2.0-beta.22' });
  // Even when the Store still lists more updates, and on older Windows (the install is done already).
  expect(storeDecision(check({ registered: '0.2.999.0', updates: 1, silent: false }), { running: '0.2.0-beta.21', build: 19045 })).toEqual({ kind: 'ready', version: '0.2.0' });
});

test('a Store update is installed in the background only on 24H2+ with silent downloads allowed', () => {
  expect(storeDecision(check({ updates: 1 }), { running: '0.2.0-beta.21', build: DEFER_BUILD })).toEqual({ kind: 'download' });
  expect(storeDecision(check({ updates: 1 }), { running: '0.2.0-beta.21', build: 26200 })).toEqual({ kind: 'download' });
  expect(storeDecision(check({ updates: 1, silent: false }), { running: '0.2.0-beta.21', build: 26200 })).toEqual({ kind: 'store', reason: 'no-silent' });
  expect(storeDecision(check({ updates: 1 }), { running: '0.2.0-beta.21', build: 22631 })).toEqual({ kind: 'store', reason: 'windows' });
  expect(storeDecision(check({ updates: 1 }), { running: '0.2.0-beta.21', build: null })).toEqual({ kind: 'store', reason: 'windows' });
  // Older Windows wins over the setting: the install would close Atelier either way.
  expect(storeDecision(check({ updates: 1, silent: false }), { running: '0.2.0-beta.21', build: 19045 })).toEqual({ kind: 'store', reason: 'windows' });
});

test('nothing newer: up to date (the running version registered, an older or unknown one too)', () => {
  expect(storeDecision(check(), { running: '0.2.0-beta.21', build: DEFER_BUILD })).toEqual({ kind: 'up-to-date' });
  expect(storeDecision(check({ registered: '0.2.20.0' }), { running: '0.2.0-beta.21', build: DEFER_BUILD })).toEqual({ kind: 'up-to-date' });
  expect(storeDecision(check({ registered: null }), { running: '0.2.0-beta.21', build: DEFER_BUILD })).toEqual({ kind: 'up-to-date' });
  expect(storeDecision(check({ registered: '0.2.21.1' }), { running: '0.2.0-beta.21', build: DEFER_BUILD })).toEqual({ kind: 'up-to-date' });
});
