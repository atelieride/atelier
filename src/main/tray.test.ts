import { expect, test, vi } from 'vitest';
import { SessionTray, afterAllClosed, keepsRunning, quitsWhenTurnedOff, reopensAfterCancelledQuit, type IconSpec, type MenuSpec, type TrayHost } from './tray';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo, SessionState } from '@shared/session';

// Applying the tray model: a fake host stands for Electron's Tray, so no
// icon ever reaches a real menu bar.

const t = (id: string, state: SessionState | null, opts: { unread?: boolean; project?: string; updatedAt?: number; session?: Partial<SessionInfo> } = {}): TerminalInfo => ({
  id, projectRoot: opts.project ?? '/p/alpha', cwd: '/p', title: id, name: null, color: '#fff', foreground: 'claude', createdAt: 0,
  session: state ? { sessionId: id, state, title: null, activity: null, contextPct: null, unread: opts.unread ?? false, updatedAt: opts.updatedAt ?? 0, ...opts.session } : null
});

interface Fake { id: number; icon: IconSpec; tooltip: string; title: string; destroyed: boolean; click: () => void; rightClick: () => void }

function fakeHost(opts: { throwOnCreate?: boolean } = {}) {
  const made: Fake[] = [];
  const calls: string[] = [];
  let menu: { tray: Fake; spec: MenuSpec } | null = null;
  const host: TrayHost = {
    create(icon, events) {
      if (opts.throwOnCreate) throw new Error('Failed to create tray icon');
      const f: Fake = { id: made.length, icon, tooltip: '', title: '', destroyed: false, ...events };
      made.push(f);
      calls.push(`create ${f.id}`);
      return {
        setImage: (i: IconSpec) => { calls.push(`image ${f.id}`); f.icon = i; },
        setToolTip: (s: string) => { calls.push(`tooltip ${f.id}`); f.tooltip = s; },
        setTitle: (s: string) => { calls.push(`title ${f.id}`); f.title = s; },
        destroy: () => { calls.push(`destroy ${f.id}`); f.destroyed = true; },
        fake: f
      } as never;
    },
    popUp(handle, spec) { menu = { tray: (handle as unknown as { fake: Fake }).fake, spec }; }
  };
  const live = () => made.filter((f) => !f.destroyed);
  return { host, made, calls, live, lastMenu: () => menu };
}

function actions() {
  return { reveal: vi.fn(), openProject: vi.fn(), openApp: vi.fn(), newWindow: vi.fn(), quit: vi.fn(), turnOff: vi.fn() };
}

const labels = (spec: MenuSpec) => spec.map((i) => ('type' in i ? '---' : i.label));
const tick = () => new Promise((r) => setTimeout(r, 0));
const choose = (spec: MenuSpec, label: string) => { const i = spec.find((x) => !('type' in x) && x.label === label); (i as { click: () => void }).click(); };

test('macOS: one icon per session that needs you, its colour by kind; none for the others', () => {
  const h = fakeHost();
  const tray = new SessionTray({ platform: 'darwin', host: h.host, actions: actions() });
  tray.update([t('w', 'waiting'), t('r', 'running'), t('d', 'done', { unread: true })]);
  expect(h.live().map((f) => f.icon)).toEqual([{ tinted: 'waiting' }, { tinted: 'done' }]);
  expect(h.live()[0]!.tooltip).toBe('w · alpha\nWaiting for you');
});

test('macOS: a session changing kind keeps its icon (only the image changes), one that no longer needs you loses it', () => {
  const h = fakeHost();
  const tray = new SessionTray({ platform: 'darwin', host: h.host, actions: actions() });
  tray.update([t('a', 'waiting'), t('b', 'waiting')]);
  h.calls.length = 0;
  tray.update([t('a', 'error', { unread: true }), t('b', 'running')]);
  expect(h.calls).not.toContain('create 0');
  expect(h.calls).toContain('image 0');
  expect(h.calls).toContain('destroy 1');
  expect(h.live().map((f) => [f.id, f.icon])).toEqual([[0, { tinted: 'error' }]]);
});

test('macOS: the same list again changes nothing', () => {
  const h = fakeHost();
  const tray = new SessionTray({ platform: 'darwin', host: h.host, actions: actions() });
  tray.update([t('a', 'waiting')]);
  h.calls.length = 0;
  tray.update([t('a', 'waiting'), t('r', 'running')]);
  expect(h.calls).toEqual([]);
});

test('macOS: left click reveals the session, right click offers Open Session, its project and turning icons off', async () => {
  const h = fakeHost();
  const a = actions();
  const tray = new SessionTray({ platform: 'darwin', host: h.host, actions: a });
  tray.update([t('a', 'waiting', { project: '/Users/x/atelier' })]);
  h.live()[0]!.click();
  expect(a.reveal).toHaveBeenCalledWith('a', '/Users/x/atelier');
  h.live()[0]!.rightClick();
  const spec = h.lastMenu()!.spec;
  expect(labels(spec)).toEqual(['Open Session', 'Open “atelier”', '---', 'Turn Off Menu Bar Icons']);
  choose(spec, 'Open “atelier”');
  expect(a.openProject).toHaveBeenCalledWith('/Users/x/atelier');
  choose(spec, 'Turn Off Menu Bar Icons');
  // Never while the menu is still up: turning off destroys the very icon whose menu it is.
  expect(a.turnOff).not.toHaveBeenCalled();
  await tick();
  expect(a.turnOff).toHaveBeenCalled();
});

test('macOS: beyond five, four icons and a "+N" item whose menu lists the hidden sessions', () => {
  const h = fakeHost();
  const a = actions();
  const tray = new SessionTray({ platform: 'darwin', host: h.host, actions: a });
  const many = [...Array.from({ length: 5 }, (_, i) => t(`w${i}`, 'waiting', { updatedAt: i })), t('d', 'done', { unread: true })];
  tray.update(many);
  const more = h.live().find((f) => f.title)!;
  expect(more.title).toBe('+2');
  expect(more.icon).toEqual({ tinted: 'waiting' });
  expect(h.live().filter((f) => !f.title)).toHaveLength(4);
  more.click();
  const spec = h.lastMenu()!.spec;
  expect(labels(spec)).toEqual(['● w4 · alpha', '---', '✓ d · alpha']);
  choose(spec, '✓ d · alpha');
  expect(a.reveal).toHaveBeenCalledWith('d', '/p/alpha');
  // Back under the limit: the "+N" item goes, the session it hid gets its icon.
  tray.update(many.slice(1));
  expect(more.destroyed).toBe(true);
  expect(h.live().filter((f) => !f.title)).toHaveLength(5);
});

test('turned off: every icon goes at once; back on: rebuilt from the last list', () => {
  const h = fakeHost();
  const tray = new SessionTray({ platform: 'darwin', host: h.host, actions: actions() });
  tray.update([t('a', 'waiting'), t('b', 'waiting')]);
  tray.setEnabled(false);
  expect(h.live()).toEqual([]);
  tray.update([t('a', 'waiting')]);
  expect(h.live()).toEqual([]);
  tray.setEnabled(true);
  expect(h.live()).toHaveLength(1);
});

test('Windows: one icon, always; neutral while nobody needs you, coloured by the most urgent', () => {
  const h = fakeHost();
  const tray = new SessionTray({ platform: 'win32', host: h.host, actions: actions() });
  tray.update([]);
  expect(h.live()).toHaveLength(1);
  expect(h.live()[0]!.icon).toEqual({ mark: 'none' });
  expect(h.live()[0]!.tooltip).toBe('Atelier');
  tray.update([t('d', 'done', { unread: true }), t('e', 'error', { unread: true })]);
  expect(h.made).toHaveLength(1);
  expect(h.live()[0]!.icon).toEqual({ mark: 'error' });
  expect(h.live()[0]!.tooltip).toBe('Atelier — 1 stopped, 1 finished');
});

test('Windows: either click opens the sessions menu, then Open Atelier, New Window and Quit', () => {
  const h = fakeHost();
  const a = actions();
  const tray = new SessionTray({ platform: 'win32', host: h.host, actions: a });
  tray.update([t('w', 'waiting'), t('d', 'done', { unread: true })]);
  h.live()[0]!.click();
  const spec = h.lastMenu()!.spec;
  expect(labels(spec)).toEqual(['Waiting for you', '● w · alpha', 'Finished', '✓ d · alpha', '---', 'Open Atelier', 'New Window', '---', 'Quit Atelier']);
  expect(spec[0]).toMatchObject({ enabled: false });
  choose(spec, '● w · alpha');
  expect(a.reveal).toHaveBeenCalledWith('w', '/p/alpha');
  choose(spec, 'Open Atelier');
  choose(spec, 'Quit Atelier');
  expect(a.openApp).toHaveBeenCalled();
  expect(a.quit).toHaveBeenCalled();
  h.live()[0]!.rightClick();
  expect(labels(h.lastMenu()!.spec)).toEqual(labels(spec));
});

test('Windows: more than eight sessions → "+N more", disabled', () => {
  const h = fakeHost();
  const tray = new SessionTray({ platform: 'win32', host: h.host, actions: actions() });
  tray.update(Array.from({ length: 10 }, (_, i) => t(`w${i}`, 'waiting', { updatedAt: i })));
  h.live()[0]!.click();
  const spec = h.lastMenu()!.spec;
  expect(spec.find((i) => !('type' in i) && i.label === '+2 more')).toMatchObject({ enabled: false });
});

test('a tray that fails is logged and never stops the rest (notifications, the next lists)', () => {
  const h = fakeHost({ throwOnCreate: true });
  const errors: string[] = [];
  const tray = new SessionTray({ platform: 'darwin', host: h.host, actions: actions(), onError: (e) => errors.push(String(e)) });
  expect(() => tray.update([t('a', 'waiting')])).not.toThrow();
  expect(errors).toEqual(['Error: Failed to create tray icon']);
  expect(() => tray.update([t('a', 'waiting'), t('b', 'waiting')])).not.toThrow();
});

test('log mode (tests): no tray at all, one line per change of what would be shown', () => {
  const lines: unknown[] = [];
  const tray = new SessionTray({ platform: 'darwin', host: null, actions: actions(), log: (l) => lines.push(l) });
  tray.update([t('a', 'waiting')]);
  tray.update([t('a', 'waiting')]);
  tray.update([]);
  expect(lines).toEqual([
    { icons: [{ id: 'a', kind: 'waiting', tooltip: 'a · alpha\nWaiting for you' }], more: null },
    { icons: [], more: null }
  ]);
});

test('log mode: a test can click an icon and read or choose from its menu', async () => {
  const a = actions();
  const tray = new SessionTray({ platform: 'darwin', host: null, actions: a, log: () => {} });
  tray.update([t('a', 'waiting')]);
  tray.click('a');
  expect(a.reveal).toHaveBeenCalledWith('a', '/p/alpha');
  expect(tray.menuLabels('a')).toEqual(['Open Session', 'Open “alpha”', '---', 'Turn Off Menu Bar Icons']);
  tray.choose('a', 'Turn Off Menu Bar Icons');
  await tick();
  expect(a.turnOff).toHaveBeenCalled();
});

test('Windows: with the icon on, closing the last window keeps the app in the notification area; off, it quits as before', () => {
  expect(keepsRunning('win32', true)).toBe(true);
  expect(keepsRunning('win32', false)).toBe(false);
  // macOS never quits with its windows (the Dock keeps it), whatever the setting.
  expect(keepsRunning('darwin', false)).toBe(true);
});

test('Windows: turning the icon off with no window open quits (nothing would be left to reach the app)', () => {
  expect(quitsWhenTurnedOff('win32', 0)).toBe(true);
  expect(quitsWhenTurnedOff('win32', 1)).toBe(false);
  expect(quitsWhenTurnedOff('darwin', 0)).toBe(false);
});

test('Windows, last window closed: quit with the icon off; with it on, stay, saying so the first time only', () => {
  expect(afterAllClosed('win32', false, false)).toBe('quit');
  expect(afterAllClosed('win32', true, false)).toBe('notice');
  expect(afterAllClosed('win32', true, true)).toBe('stay');
  expect(afterAllClosed('darwin', false, false)).toBe('stay');
});

test('Windows: a quit called off reopens a window only when nothing else would be left (the icon off)', () => {
  expect(reopensAfterCancelledQuit('win32', false, 0)).toBe(true);
  expect(reopensAfterCancelledQuit('win32', true, 0)).toBe(false);
  expect(reopensAfterCancelledQuit('win32', false, 1)).toBe(false);
  expect(reopensAfterCancelledQuit('darwin', false, 0)).toBe(false);
});
