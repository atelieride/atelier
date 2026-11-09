import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { setTestDefaultPlatform } from '@shared/platform';
import { addRecent, forgetRecent, loadUiState, placeOfWindow, rememberWindow, saveUiState, saveUiStateLogged, recentForWelcome, windowPlace, type UiState } from './projects';

test('missing or corrupt state → empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-p-'));
  expect(loadUiState(join(dir, 'no.json'))).toEqual({ openProjects: [], recent: [] });
  writeFileSync(join(dir, 'bad.json'), '{');
  expect(loadUiState(join(dir, 'bad.json'))).toEqual({ openProjects: [], recent: [] });
});
test('recents: on top, no duplicates, at most 10', () => {
  let s = { openProjects: [] as string[], recent: [] as string[] };
  for (let i = 0; i < 12; i++) s = addRecent(s, `/p${i}`);
  s = addRecent(s, '/p5');
  expect(s.recent[0]).toBe('/p5');
  expect(s.recent.length).toBe(10);
  expect(new Set(s.recent).size).toBe(10);
});
test('saves and reads back', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'atl-p-')), 'ui.json');
  saveUiState(f, { openProjects: ['/a'], recent: ['/a'] });
  expect(loadUiState(f)).toEqual({ openProjects: ['/a'], recent: ['/a'] });
});

test('Windows: recents and open projects saved by an older build in the C:\\ form read back canonical, once', () => {
  setTestDefaultPlatform('win32');
  try {
    const f = join(mkdtempSync(join(tmpdir(), 'atl-p-')), 'ui.json');
    writeFileSync(f, JSON.stringify({ openProjects: ['c:\\dev\\p'], recent: ['C:/dev/p', 'C:\\dev\\p', 'C:\\dev\\q'] }));
    const s = loadUiState(f);
    expect(s.openProjects).toEqual(['C:/dev/p']);
    expect(s.recent).toEqual(['C:/dev/p', 'C:/dev/q']);
  } finally {
    setTestDefaultPlatform('darwin');
  }
});

test('quitInfoShown read only when true', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'atl-p-')), 'ui.json');
  writeFileSync(f, JSON.stringify({ openProjects: [], recent: [], quitInfoShown: true }));
  expect(loadUiState(f).quitInfoShown).toBe(true);
  writeFileSync(f, JSON.stringify({ openProjects: [], recent: [], quitInfoShown: 'yes' }));
  expect(loadUiState(f).quitInfoShown).toBeUndefined();
});

test('trayInfoShown read only when true', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'atl-p-')), 'ui.json');
  writeFileSync(f, JSON.stringify({ openProjects: [], recent: [], trayInfoShown: true }));
  expect(loadUiState(f).trayInfoShown).toBe(true);
  writeFileSync(f, JSON.stringify({ openProjects: [], recent: [], trayInfoShown: 1 }));
  expect(loadUiState(f).trayInfoShown).toBeUndefined();
});

test('pop-outs: valid entries only, round-tripped; none → no key, read or written', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'atl-p-')), 'ui.json');
  const ok = { root: '/a', key: 't:abc', bounds: { x: 10, y: 20, width: 600, height: 400 } };
  writeFileSync(f, JSON.stringify({ openProjects: ['/a'], recent: ['/a'], popouts: [ok, { root: 'rel', key: 't:x', bounds: ok.bounds }, { root: '/a', key: 'services', bounds: ok.bounds }, 'junk'] }));
  expect(loadUiState(f).popouts).toEqual([ok]);
  // Missing or with nothing valid: no key at all (the state reads as before pop-outs existed).
  writeFileSync(f, JSON.stringify({ openProjects: [], recent: [], popouts: ['junk'] }));
  expect(loadUiState(f)).toEqual({ openProjects: [], recent: [] });
  // Round trip.
  saveUiState(f, { openProjects: ['/a'], recent: ['/a'], popouts: [ok] });
  expect(loadUiState(f)).toEqual({ openProjects: ['/a'], recent: ['/a'], popouts: [ok] });
  // An empty list is not written back as a key.
  saveUiState(f, { openProjects: [], recent: [], popouts: [] });
  expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ openProjects: [], recent: [] });
});

test('homes: moved terminals\' projects, valid entries only; none → no key', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'atl-p-')), 'ui.json');
  writeFileSync(f, JSON.stringify({ openProjects: [], recent: [], homes: { t1: '/b', t2: 'rel', t3: 4 } }));
  expect(loadUiState(f).homes).toEqual({ t1: '/b' });
  writeFileSync(f, JSON.stringify({ openProjects: [], recent: [], homes: { t2: 'rel' } }));
  expect(loadUiState(f)).toEqual({ openProjects: [], recent: [] });
  saveUiState(f, { openProjects: [], recent: [], homes: { t1: '/b' } });
  expect(loadUiState(f)).toEqual({ openProjects: [], recent: [], homes: { t1: '/b' } });
  saveUiState(f, { openProjects: [], recent: [], homes: {} });
  expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ openProjects: [], recent: [] });
});

test('recents for the welcome screen: only existing folders, in order, at most 6', () => {
  const state = { openProjects: [], recent: ['/a', '/gone', '/b', '/c', '/d', '/e', '/f', '/g'] };
  expect(recentForWelcome(state, (p) => p !== '/gone')).toEqual(['/a', '/b', '/c', '/d', '/e', '/f']);
});

test('forgetting a recent (the welcome window\'s ×): only that folder goes, the others keep their order; unknown → unchanged', () => {
  const state: UiState = { openProjects: ['/b'], recent: ['/a', '/b', '/c'] };
  expect(forgetRecent(state, '/b')).toEqual({ openProjects: ['/b'], recent: ['/a', '/c'] });
  expect(forgetRecent(state, '/x')).toBe(state);
});

test('project windows: their bounds round-trip, invalid entries dropped; none → no key', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'atl-p-')), 'ui.json');
  const b = { x: 40, y: 60, width: 1200, height: 760 };
  writeFileSync(f, JSON.stringify({ openProjects: ['/a'], recent: ['/a'], windows: { '/a': b, rel: b, '/b': { ...b, width: 0 }, '/c': 'junk' } }));
  expect(loadUiState(f).windows).toEqual({ '/a': b });
  saveUiState(f, loadUiState(f));
  expect(loadUiState(f).windows).toEqual({ '/a': b });
  saveUiState(f, { openProjects: [], recent: [] });
  expect(JSON.parse(readFileSync(f, 'utf8'))).not.toHaveProperty('windows');
});

test('rememberWindow: one entry per project, only for projects still open or recent', () => {
  const b = (x: number) => ({ x, y: 0, width: 1000, height: 700 });
  let s: UiState = { openProjects: ['/a'], recent: ['/a', '/b'], windows: { '/gone': b(9) } };
  s = rememberWindow(s, '/a', b(1));
  s = rememberWindow(s, '/b', b(2));
  s = rememberWindow(s, '/a', b(3));
  expect(s.windows).toEqual({ '/a': b(3), '/b': b(2) });
});

const fakeWin = (o: { normal: { x: number; y: number; width: number; height: number }; maximized?: boolean; fullScreen?: boolean; minimized?: boolean; bounds?: { x: number; y: number; width: number; height: number } }) => ({
  isDestroyed: () => false, isMinimized: () => !!o.minimized, isFullScreen: () => !!o.fullScreen, isMaximized: () => !!o.maximized,
  getNormalBounds: () => o.normal, getBounds: () => o.bounds ?? o.normal
});

test('a maximized window is remembered as maximized, with the bounds it goes back to; full screen keeps the last place', () => {
  const normal = { x: 100, y: 80, width: 1200, height: 800 };
  // Windows: a maximized window's bounds overhang the screen by its 8 px borders.
  const win = fakeWin({ normal, maximized: true, bounds: { x: -8, y: -8, width: 1936, height: 1056 } });
  expect(placeOfWindow(win)).toEqual({ ...normal, maximized: true });
  expect(placeOfWindow(fakeWin({ normal }))).toEqual(normal);
  expect(placeOfWindow(fakeWin({ normal, fullScreen: true }))).toBeNull();
  // Round trip through ui-state.json.
  const f = join(mkdtempSync(join(tmpdir(), 'atl-p-')), 'ui.json');
  saveUiState(f, rememberWindow({ openProjects: ['/a'], recent: [] }, '/a', { ...normal, maximized: true }));
  expect(loadUiState(f).windows).toEqual({ '/a': { ...normal, maximized: true } });
  writeFileSync(f, JSON.stringify({ openProjects: ['/a'], recent: [], windows: { '/a': { ...normal, maximized: 'yes' } } }));
  expect(loadUiState(f).windows).toEqual({ '/a': normal });
});

test('where a project window opens: the welcome window it replaces (its normal bounds, maximized too), else its saved place', () => {
  const areas = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  const normal = { x: 100, y: 80, width: 1200, height: 800 };
  const welcome = fakeWin({ normal, maximized: true, bounds: { x: -8, y: -8, width: 1936, height: 1056 } });
  expect(windowPlace(welcome, undefined, areas)).toEqual({ ...normal, maximized: true });
  expect(windowPlace(fakeWin({ normal }), undefined, areas)).toEqual(normal);
  // A minimized or full-screen welcome window: the saved place (maximized as it was).
  expect(windowPlace(fakeWin({ normal, minimized: true }), { x: 10, y: 10, width: 900, height: 600, maximized: true }, areas)).toEqual({ x: 10, y: 10, width: 900, height: 600, maximized: true });
  expect(windowPlace(null, { x: 10, y: 10, width: 900, height: 600 }, areas)).toEqual({ x: 10, y: 10, width: 900, height: 600 });
  expect(windowPlace(null, undefined, areas)).toBeUndefined();
});

test('saving the UI state never throws (a close handler goes on): the failure is logged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-p-'));
  // A folder in place of the file: the atomic write fails.
  mkdirSync(join(dir, 'ui.json'));
  const logged: string[] = [];
  expect(saveUiStateLogged(join(dir, 'ui.json'), { openProjects: [], recent: [] }, (m) => logged.push(m))).toBe(false);
  expect(logged).toEqual([expect.stringContaining('ui.json')]);
  expect(saveUiStateLogged(join(dir, 'ok', 'ui.json'), { openProjects: ['/a'], recent: [] }, (m) => logged.push(m))).toBe(true);
  expect(loadUiState(join(dir, 'ok', 'ui.json')).openProjects).toEqual(['/a']);
});
