import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { toOut } from './cpath';

// Electron stand-ins: windows looked up from their webContents, notifications recorded.
const fake = vi.hoisted(() => ({
  windows: new Map<unknown, { focused: boolean; show: () => void; focus: () => void; isFocused: () => boolean }>(),
  banners: [] as string[],
  overlays: new Map<number, (string | null)[]>()
}));
vi.mock('electron', () => {
  class Notification {
    static isSupported() { return true; }
    constructor(readonly o: { title: string; body: string }) {}
    on() { return this; }
    show() { fake.banners.push(this.o.title); }
  }
  return {
    app: { dock: undefined },
    BrowserWindow: {
      fromWebContents: (wc: unknown) => fake.windows.get(wc) ?? null,
      // Windows' taskbar overlay, recorded per window (its webContents id).
      getAllWindows: () => [...fake.windows.keys()].map((wc) => ({
        isDestroyed: () => false,
        setOverlayIcon: (icon: unknown, text: string) => {
          const id = (wc as { id: number }).id;
          fake.overlays.set(id, [...(fake.overlays.get(id) ?? []), icon ? text : null]);
        }
      }))
    },
    nativeImage: { createFromBitmap: () => ({}) },
    Notification,
    Menu: { buildFromTemplate: vi.fn() },
    dialog: {},
    ipcMain: { handle: vi.fn(), on: vi.fn() }
  };
});

import { ipcMain } from 'electron';
import { IPC } from '@shared/api';
import { setTestDefaultPlatform } from '@shared/platform';
import type { TerminalInfo } from '@shared/protocol';
import type { DaemonClient } from './daemon-client';
import { TerminalHub } from './terminal-hub';
import type { Note } from './attention';
import { DEFAULT_SETTINGS } from '@shared/settings';

const term = (id: string, projectRoot = '/p'): TerminalInfo => ({
  id, projectRoot, cwd: projectRoot, title: id, name: null, color: '#fff', foreground: 'claude', createdAt: 0, session: null
});

interface Wc { id: number; send: ReturnType<typeof vi.fn>; isDestroyed(): boolean; once(): void }
const wc = (id: number): Wc => ({ id, send: vi.fn(), isDestroyed: () => false, once: () => {} });
const win = (w: Wc, focused = false) => {
  const b = { focused, show: vi.fn(), focus: vi.fn(), isFocused: () => b.focused };
  fake.windows.set(w, b);
  return b;
};

function setup() {
  const client = Object.assign(new EventEmitter(), { connected: true, daemonVersion: null, hasCapability: () => true, request: vi.fn(async () => ({})), send: vi.fn() });
  const hub = new TerminalHub(client as unknown as DaemonClient, { version: '1.0.0', build: 'x' }, () => true);
  const register = (w: Wc, root = '/p') => hub.register(w as unknown as Electron.WebContents, root);
  const priv = hub as unknown as { showNotes(n: Note[]): void; reveal(id: string, root: string): void };
  return { hub, register, priv, client };
}

const selects = (w: Wc) => w.send.mock.calls.filter((c) => c[0] === IPC.evSelect);

describe('TerminalHub with pop-out windows', () => {
  beforeEach(() => { fake.windows.clear(); fake.banners.length = 0; delete process.env.ATELIER_TEST_NOTIFY_LOG; });

  test('a banner is dropped while any window of its project is focused, shown when none is', () => {
    const { register, priv } = setup();
    const main = wc(1); const pop = wc(2);
    win(main, false);
    const p = win(pop, true);
    register(main); register(pop);
    const note: Note = { term: term('a'), kind: 'waiting', body: 'Waiting for you', silent: false };
    priv.showNotes([note]);
    expect(fake.banners).toEqual([]);
    p.focused = false;
    priv.showNotes([note]);
    expect(fake.banners).toEqual(['a']);
  });

  test('reveal: a popped-out session brings its window forward, nothing is selected in the main window', () => {
    const { hub, register, priv } = setup();
    const main = wc(1);
    const b = win(main);
    register(main);
    const focusPopout = vi.fn();
    hub.popoutFor = (root, id) => (root === '/p' && id === 'a' ? focusPopout : null);
    priv.reveal('a', '/p');
    expect(focusPopout).toHaveBeenCalledTimes(1);
    expect(selects(main)).toEqual([]);
    expect(b.show).not.toHaveBeenCalled();
  });

  test('reveal: otherwise the project window (never a pop-out) comes forward and selects the session', () => {
    const { hub, register, priv } = setup();
    const pop = wc(2); const main = wc(1);
    const pb = win(pop); const mb = win(main);
    // The pop-out registered first: the lookup must skip it.
    register(pop); register(main);
    hub.isPopout = (id) => id === 2;
    hub.popoutFor = () => null;
    priv.reveal('b', '/p');
    expect(mb.show).toHaveBeenCalled();
    expect(selects(main)).toEqual([[IPC.evSelect, 'b']]);
    expect(pb.show).not.toHaveBeenCalled();
    expect(selects(pop)).toEqual([]);
  });

  test("terminalIds: the project's terminals from atelierd's list (what a pop-out restore checks)", () => {
    const { hub } = setup();
    expect(hub.terminalIds('/p')).toEqual([]);
    (hub as unknown as { client: EventEmitter }).client.emit('terminals', [term('a'), term('b', '/q'), term('c')]);
    expect(hub.terminalIds('/p')).toEqual(['a', 'c']);
  });
});

describe('Windows: the taskbar badge', () => {
  beforeEach(() => { fake.windows.clear(); fake.overlays.clear(); });

  test('a window opened while sessions wait gets the badge too: each window has its own taskbar button', () => {
    setTestDefaultPlatform('win32');
    try {
      const { hub, register } = setup();
      const a = wc(1);
      win(a);
      register(a);
      const waiting = term('w');
      (hub as unknown as { lastList: TerminalInfo[] }).lastList = [{ ...waiting, session: { sessionId: 's', cwd: '/p', state: 'waiting', since: 0, activity: null, waitingFor: 'permission' } as unknown as TerminalInfo['session'] }];
      hub.refreshBadge();
      expect(fake.overlays.get(1)?.at(-1)).toBe('1 waiting');
      const b = wc(2);
      win(b);
      register(b);
      expect(fake.overlays.get(2)?.at(-1)).toBe('1 waiting');
    } finally {
      setTestDefaultPlatform('darwin');
    }
  });
});

describe('Windows: a terminal’s current folder from OSC 7 (no lsof there)', () => {
  test('read from the data relayed to windows, forgotten when the terminal exits; macOS reads none', () => {
    setTestDefaultPlatform('win32');
    try {
      const { hub, client } = setup();
      const live = hub as unknown as { liveCwd(id: string): string | null };
      client.emit('data', 'a', 'PS> cd x\r\n\x1b]7;file:///C:/dev/x\x07PS C:\\dev\\x> ');
      expect(live.liveCwd('a')).toBe('C:/dev/x');
      client.emit('exit', 'a');
      expect(live.liveCwd('a')).toBe(null);
    } finally {
      setTestDefaultPlatform('darwin');
    }
    const { hub, client } = setup();
    client.emit('data', 'a', '\x1b]7;file:///Users/me/x\x07');
    expect((hub as unknown as { liveCwd(id: string): string | null }).liveCwd('a')).toBe(null);
  });
});

describe('Windows: a session from the Jump List (--reveal)', () => {
  beforeEach(() => { fake.windows.clear(); });

  test('asked before atelierd’s first list (the app starting from the Jump List): shown once the list arrives', () => {
    const { hub, register, client } = setup();
    const main = wc(1);
    win(main);
    register(main);
    hub.popoutFor = () => null;
    expect(hub.revealTerminal('a')).toBe(false);
    client.emit('terminals', [term('a')]);
    expect(selects(main)).toEqual([[IPC.evSelect, 'a']]);
  });

  test('a session that is gone (a stale entry): false, and nothing is shown later', () => {
    const { hub, register, client } = setup();
    const main = wc(1);
    win(main);
    register(main);
    hub.popoutFor = () => null;
    client.emit('terminals', [term('b')]);
    expect(hub.revealTerminal('a')).toBe(false);
    client.emit('terminals', [term('b'), term('a')]);
    expect(selects(main)).toEqual([]);
    expect(hub.revealTerminal('b')).toBe(true);
    expect(selects(main)).toEqual([[IPC.evSelect, 'b']]);
  });
});

describe('the pane size survives a reconnection to atelierd', () => {
  beforeEach(() => { fake.windows.clear(); });

  // installIpc's handlers, called as the window would (sender = its webContents id).
  async function attached() {
    const { hub, register, client } = setup();
    const { ipcMain } = await import('electron');
    vi.mocked(ipcMain.handle).mockClear(); vi.mocked(ipcMain.on).mockClear();
    hub.installIpc();
    const handler = (mock: unknown, channel: string) => (mock as { mock: { calls: [string, (e: unknown, arg: unknown) => unknown][] } }).mock.calls.find((c) => c[0] === channel)![1];
    const ev = { sender: { id: 1 } };
    const attach = () => handler(ipcMain.handle, IPC.termAttach)(ev, 'a') as Promise<void>;
    const resize = (cols: number, rows: number) => handler(ipcMain.on, IPC.termResize)(ev, { id: 'a', cols, rows });
    const w = wc(1); win(w); register(w);
    client.emit('terminals', [term('a')]);
    const first = attach();
    await Promise.resolve();
    client.emit('snapshot', 'a', 'screen');
    await first;
    resize(100, 30);
    client.send.mockClear();
    const resizes = () => client.send.mock.calls.map((c) => c[0] as { t: string }).filter((m) => m.t === 'resize');
    return { client, resize, resizes };
  }

  test('a resize while the window re-attaches (the Mac waking on another display) reaches the PTY once attached', async () => {
    const { client, resize, resizes } = await attached();
    client.emit('reconnected');
    resize(140, 40);
    await Promise.resolve();
    client.emit('snapshot', 'a', 'screen again');
    expect(resizes().at(-1)).toEqual({ t: 'resize', id: 'a', cols: 140, rows: 40 });
  });

  test('a resize while atelierd is unreachable (sent into nothing) is sent again once re-attached', async () => {
    const { client, resize, resizes } = await attached();
    client.connected = false;
    resize(120, 36);
    client.send.mockClear();
    client.connected = true;
    client.emit('reconnected');
    await Promise.resolve();
    client.emit('snapshot', 'a', 'screen again');
    expect(resizes()).toEqual([{ t: 'resize', id: 'a', cols: 120, rows: 36 }]);
  });
});

describe('screens sent again after the Mac wakes or a display changes', () => {
  beforeEach(() => { fake.windows.clear(); });

  const session = (id: string, foreground: string): TerminalInfo => ({ ...term(id), foreground, session: { sessionId: id, state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } } as TerminalInfo);

  async function windowWith(list: TerminalInfo[], ids: string[]) {
    const { hub, register, client } = setup();
    const { ipcMain } = await import('electron');
    vi.mocked(ipcMain.handle).mockClear(); vi.mocked(ipcMain.on).mockClear();
    hub.installIpc();
    const attach = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === IPC.termAttach)![1] as (e: unknown, id: string) => Promise<void>;
    const resize = vi.mocked(ipcMain.on).mock.calls.find((c) => c[0] === IPC.termResize)![1] as (e: unknown, arg: unknown) => void;
    const w = wc(1); win(w); register(w);
    client.emit('terminals', list);
    for (const id of ids) { const p = attach({ sender: { id: 1 } }, id); await Promise.resolve(); client.emit('snapshot', id, 'old'); await p; }
    client.request.mockClear(); client.send.mockClear(); w.send.mockClear();
    return { hub, client, w, attach, resize };
  }

  test("a Claude session's screen is asked again from atelierd and sent to the window; plain terminals keep their own", async () => {
    const list = [session('claude', '2.1.302'), session('back-at-zsh', 'zsh'), { ...term('dev'), foreground: 'npm' }, { ...term('shell'), foreground: 'zsh' }, session('not-shown', '2.1.302')];
    const { hub, client, w, resize } = await windowWith(list, ['claude', 'back-at-zsh', 'dev', 'shell']);
    resize({ sender: { id: 1 } }, { id: 'claude', cols: 100, rows: 30 });
    client.send.mockClear();
    hub.resyncScreens();
    await Promise.resolve();
    // Only the attached Claude session: never a plain terminal, even running a command (its command blocks would go).
    expect(client.request.mock.calls.map((c) => (c as unknown[])[0])).toEqual([{ t: 'attach', id: 'claude' }]);
    client.emit('snapshot', 'claude', 'fresh');
    expect(w.send.mock.calls.filter((c) => c[0] === IPC.evSnapshot)).toEqual([[IPC.evSnapshot, 'claude', 'fresh']]);
    // The size reached atelierd already: not sent again (a same-size resize can repaint a Windows console).
    expect(client.send.mock.calls.filter((c) => (c[0] as { t: string }).t === 'resize')).toEqual([]);
  });

  test('an attach superseded by a later one (no reply, timed out) never cancels the attach that follows it', async () => {
    const { client, w, attach } = await windowWith([session('claude', '2.1.302')], []);
    let failFirst!: (e: Error) => void;
    client.request.mockImplementationOnce(() => new Promise((_r, reject) => { failFirst = reject; }));
    const first = attach({ sender: { id: 1 } }, 'claude');
    await Promise.resolve();
    client.emit('snapshot', 'claude', 'one');
    await first;
    // Redraw Terminal: a new attach on its way when the first request's timeout finally lands.
    void attach({ sender: { id: 1 } }, 'claude');
    await Promise.resolve();
    failFirst(new Error('timeout'));
    await Promise.resolve(); await Promise.resolve();
    client.emit('snapshot', 'claude', 'two');
    expect(w.send.mock.calls.filter((c) => c[0] === IPC.evSnapshot).map((c) => c[2])).toEqual(['one', 'two']);
  });
});

describe('for the automations\' runner', () => {
  test('every project\'s terminals, "listed" once atelierd\'s first list is in, a call on every list', () => {
    const { hub, client } = setup();
    const calls: number[] = [];
    const off = hub.onTerminals(() => calls.push(hub.allTerminals().length));
    expect(hub.daemonListed()).toBe(false);
    client.emit('terminals', [term('a', '/p'), term('b', '/q')]);
    expect(hub.daemonListed()).toBe(true);
    expect(hub.allTerminals().map((t) => t.id)).toEqual(['a', 'b']);
    off();
    client.emit('terminals', [term('a', '/p')]);
    expect(calls).toEqual([2]);
  });

  test('interruptSession: Esc into that terminal, as a user pressing it', () => {
    const { hub, client } = setup();
    hub.interruptSession('t1');
    expect(client.send).toHaveBeenCalledWith({ t: 'input', id: 't1', data: '\x1b' });
  });

  test('interruptSession: the interruption it draws brings the session back to ready, as a typed Esc does', () => {
    const { hub, client } = setup();
    const running = { ...term('t1'), session: { sessionId: 's', state: 'running', title: null, activity: 'Bash', contextPct: null, unread: false, updatedAt: Date.now() } } as TerminalInfo;
    client.emit('terminals', [running]);
    hub.interruptSession('t1');
    client.emit('data', 't1', '  \u23bf  Interrupted \u00b7 What should Claude do instead?');
    expect(hub.allTerminals()[0]!.session).toMatchObject({ state: 'idle', waitingFor: 'input' });
  });

  test('usageFor: an account\'s 5h percent from its config dir\'s entry; the default account\'s is keyed by its dir too', () => {
    const { hub, client } = setup();
    const home = '/Users/me/.claude';
    expect(hub.usageFor(undefined, home)).toBeNull();
    // atelierd keys each entry by the dir of the session's transcript, the default account's included.
    client.emit('usageByConfigDir', [
      { configDir: home, usage: { fiveHour: { pct: 41, resetsAt: 0 }, sevenDay: null, updatedAt: 1 } },
      { configDir: '/Users/me/.claude-work', usage: { fiveHour: { pct: 86, resetsAt: 0 }, sevenDay: null, updatedAt: 1 } }
    ]);
    expect(hub.usageFor(undefined, home)).toBe(41);
    expect(hub.usageFor('/Users/me/.claude-work', home)).toBe(86);
    expect(hub.usageFor('/Users/me/.claude-other', home)).toBeNull();
    // An older atelierd sent the default's entry with no dir.
    client.emit('usageByConfigDir', [{ configDir: null, usage: { fiveHour: { pct: 12, resetsAt: 0 }, sevenDay: null, updatedAt: 1 } }]);
    expect(hub.usageFor(undefined, home)).toBe(12);
    expect(hub.usageFor('/Users/me/.claude-work', home)).toBeNull();
  });
});

describe('accountDirOf: a terminal\'s Claude account dir (✦, dictation and Ask run as it, Ask reads its transcript there)', () => {
  test('a configured account\'s launch dir; the default\'s, a removed or unknown one only hook data names, another project\'s terminal: none', async () => {
    const { defaultConfigDirNow } = await import('./claude-accounts');
    const { hub, client } = setup();
    const WORK = '/Users/x/.claude-work';
    hub.settings = () => ({ ...DEFAULT_SETTINGS, claudeAccounts: { ...DEFAULT_SETTINGS.claudeAccounts, list: [...DEFAULT_SETTINGS.claudeAccounts.list, { id: 'work', name: 'Work', dir: WORK, color: 2 }] } });
    const at = (id: string, configDir: string, root = '/p') => ({ ...term(id, root), configDir });
    client.emit('terminals', [at('a', WORK), at('b', defaultConfigDirNow()), at('c', '/Users/x/.claude-removed'), at('d', '/etc'), term('e'), at('f', WORK, '/q')]);
    expect(hub.accountDirOf('/p', 'a')).toBe(WORK);
    for (const id of ['b', 'c', 'd', 'e', 'f', 'gone']) expect(hub.accountDirOf('/p', id), id).toBeUndefined();
  });
});

describe('kept sessions, for Ask\'s retention', () => {
  const withSession = (id: string, sessionId: string) => ({ ...term(id), session: { sessionId, state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } }) as TerminalInfo;
  const resumable = (sessionId: string) => ({ id: `r-${sessionId}`, projectRoot: '/p', cwd: '/p', title: 'R', color: '#fff', sessionId, endedAt: 0 });

  test('unknown until both of atelierd\'s lists are in since it connected; then live terminals\' and Resume\'s sessions', () => {
    const { hub, client } = setup();
    const calls: number[] = [];
    hub.onKeptSessions(() => calls.push(hub.keptSessions()?.size ?? -1));
    expect(hub.keptSessions()).toBeNull();
    client.emit('status', 'connected');
    client.emit('terminals', [withSession('a', 's1'), term('b'), withSession('c', 's2')]);
    expect(hub.keptSessions()).toBeNull();
    client.emit('resumables', [resumable('s3')]);
    expect([...hub.keptSessions()!].sort()).toEqual(['s1', 's2', 's3']);
    // A reconnection (an atelierd restart): unknown again until both lists come back.
    client.emit('status', 'disconnected');
    expect(hub.keptSessions()).toBeNull();
    client.emit('status', 'connected');
    client.emit('resumables', [resumable('s1'), resumable('s2')]);
    expect(hub.keptSessions()).toBeNull();
    client.emit('terminals', []);
    expect([...hub.keptSessions()!].sort()).toEqual(['s1', 's2']);
    // Called after every list of either kind.
    expect(calls).toEqual([-1, 3, -1, 2]);
  });

  test('open sessions, for Ask\'s thread cap: the terminals\' and the ones being resumed, never Resume\'s', () => {
    const { hub, client } = setup();
    const priv = hub as unknown as { resuming: Set<string>; resumed: Map<string, string> };
    client.emit('status', 'connected');
    client.emit('terminals', [withSession('a', 's1'), term('b')]);
    client.emit('resumables', [resumable('s3')]);
    priv.resuming.add('s4');
    priv.resumed.set('s5', 't5');
    expect([...hub.openSessions()].sort()).toEqual(['s1', 's4', 's5']);
  });

  test('a conversation being resumed from Claude\'s history counts before its terminal exists, and once Claude reports it', () => {
    const { hub, client } = setup();
    const priv = hub as unknown as { resuming: Set<string>; resumed: Map<string, string> };
    client.emit('status', 'connected');
    client.emit('terminals', []);
    client.emit('resumables', []);
    priv.resuming.add('s4');
    expect([...hub.keptSessions()!]).toEqual(['s4']);
    priv.resuming.delete('s4');
    priv.resumed.set('s4', 't9');
    expect([...hub.keptSessions()!]).toEqual(['s4']);
  });
});

describe('createAutomatedSession: New Session\'s request, for a project with no window', () => {
  test('the automation\'s project and folder, the run\'s command and name, 120×36 until a window attaches', async () => {
    const { mkdtempSync, mkdirSync, realpathSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, posix } = await import('node:path');
    // Real folders: the machine's platform (Windows: main's canonical C:/ paths).
    initPlatform(process.platform);
    try {
      const project = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-hub-auto-'))));
      const wt = posix.join(project, '.claude', 'worktrees', 'auto-cu-1');
      mkdirSync(wt, { recursive: true });
      const same = (a: unknown, b: string) => String(a).replace(/\\/g, '/').toLowerCase() === b.toLowerCase();
      const { hub, client } = setup();
      const made = term('t9', project);
      client.request.mockImplementation((async (build: () => unknown) => {
        const req = build() as { projectRoot: string; cwd: string };
        expect(req).toMatchObject({ t: 'create', cols: 120, rows: 36, name: 'CU-1 Fix', command: ". '/r/launch.sh'" });
        expect(same(req.projectRoot, project) && same(req.cwd, wt), JSON.stringify(req)).toBe(true);
        return made;
      }) as never);
      expect((await hub.createAutomatedSession({ project, cwd: wt, name: 'CU-1 Fix', command: ". '/r/launch.sh'" })).id).toBe('t9');
      expect(client.request).toHaveBeenCalledTimes(1);
    } finally {
      resetPlatformForTests();
    }
  });

  test('a folder outside the project, or inside .git, is refused before atelierd is asked', async () => {
    const { mkdtempSync, mkdirSync, realpathSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-hub-auto-')));
    mkdirSync(join(project, '.git', 'x'), { recursive: true });
    const { hub, client } = setup();
    for (const cwd of [tmpdir(), join(project, '.git', 'x')]) {
      await expect(hub.createAutomatedSession({ project, cwd, name: 'x', command: '. x' })).rejects.toThrow();
    }
    expect(client.request).not.toHaveBeenCalled();
  });
});

describe('closing a terminal: the page asked already', () => {
  beforeEach(() => { fake.windows.clear(); });
  const handler = (channel: string) => {
    const call = (vi.mocked(ipcMain.handle).mock.calls as unknown as [string, (e: unknown, arg: unknown) => unknown][]).findLast((c) => c[0] === channel);
    if (!call) throw new Error(`no handler for ${channel}`);
    return call[1];
  };

  test('term:close kills a busy Claude session at once, with no native dialog; another project\'s terminal is refused', async () => {
    const { hub, register, client } = setup();
    const w = wc(1); win(w); register(w);
    (hub as unknown as { client: EventEmitter }).client.emit('terminals', [term('a'), term('b', '/q')]);
    hub.installIpc();
    const close = handler(IPC.termClose);
    await close({ sender: w }, 'a');
    expect(client.request).toHaveBeenCalledWith({ t: 'kill', id: 'a' });
    await expect(async () => close({ sender: w }, 'b')).rejects.toThrow();
    expect(client.request).not.toHaveBeenCalledWith({ t: 'kill', id: 'b' });
  });

  // On Windows a second kill while ConPTY closes kills atelierd: whoever asks (two windows, a pop-out, Close Run), a
  // terminal is killed once, until it leaves the list; a kill atelierd never received can be sent again.
  test('a terminal is killed once across windows and callers; one never sent can be tried again', async () => {
    const { hub, register, client } = setup();
    const kills = () => (vi.mocked(client.request).mock.calls as unknown as [{ t: string }][]).filter(([m]) => m.t === 'kill');
    const w1 = wc(1); win(w1); register(w1);
    const w2 = wc(2); win(w2); register(w2);
    const c = (hub as unknown as { client: EventEmitter }).client;
    c.emit('terminals', [term('a'), term('b')]);
    hub.installIpc();
    await handler(IPC.termClose)({ sender: w1 }, 'a');
    await handler(IPC.termClose)({ sender: w2 }, 'a');
    await handler(IPC.termKill)({ sender: w2 }, 'a');
    await hub.closeAutomatedSession('a');
    expect(kills()).toEqual([[{ t: 'kill', id: 'a' }]]);
    vi.mocked(client.request).mockRejectedValueOnce(new Error('atelierd not connected'));
    await expect(hub.closeAutomatedSession('b')).rejects.toThrow('not connected');
    await hub.closeAutomatedSession('b');
    expect(kills()).toHaveLength(3);
    // Gone from the list: forgotten.
    c.emit('terminals', [term('b')]);
    expect((hub as unknown as { closing: Set<string> }).closing).toEqual(new Set(['b']));
  });

  // Close Workspace's Stop stops its terminals as a window close does (atelierd keeps a resume
  // entry for what has one, whatever "Keep closed sessions" says), once each, only this window's project's.
  test('term:stop stops the listed terminals resumable, once; another project\'s terminal refuses the whole call', async () => {
    const { hub, register, client } = setup();
    const kills = () => (vi.mocked(client.request).mock.calls as unknown as [{ t: string }][]).filter(([m]) => m.t === 'kill').map(([m]) => m);
    const w = wc(1); win(w); register(w);
    (hub as unknown as { client: EventEmitter }).client.emit('terminals', [term('a'), term('b'), term('q', '/q')]);
    hub.installIpc();
    const stop = handler(IPC.termStop);
    await stop({ sender: w }, ['a', 'b', 'a']);
    expect(kills()).toEqual([{ t: 'kill', id: 'a', resumable: true }, { t: 'kill', id: 'b', resumable: true }]);
    vi.mocked(client.request).mockClear();
    await expect(async () => stop({ sender: w }, ['b', 'q'])).rejects.toThrow();
    expect(kills()).toEqual([]);
    // One that exited meanwhile (no longer listed) is skipped; the others stop.
    (hub as unknown as { closing: Set<string> }).closing.clear();
    await stop({ sender: w }, ['gone', 'b']);
    expect(kills()).toEqual([{ t: 'kill', id: 'b', resumable: true }]);
    for (const bad of [[], 'a', [1], Array.from({ length: 201 }, (_, i) => `t${i}`)]) await expect(async () => stop({ sender: w }, bad)).rejects.toThrow();
  });

  // Main decides from its own settings and list (the page never asks for resumable).
  test('term:close keeps a Claude session under Resume only with the setting on and kill-resumable', async () => {
    const { hub, register, client } = setup();
    const kills = () => (vi.mocked(client.request).mock.calls as unknown as [{ t: string }][]).filter(([m]) => m.t === 'kill').map(([m]) => m);
    const w = wc(1); win(w); register(w);
    const c = (hub as unknown as { client: EventEmitter }).client;
    const withSession = (id: string, lastMessageAt: number | null) => ({ ...term(id), session: { sessionId: id, state: 'done', lastMessageAt } }) as unknown as TerminalInfo;
    // s: a conversation; e: no message yet; r: a resume whose Claude hasn't started (no session yet); sh: a shell.
    const list = () => [withSession('s', 1), withSession('e', null), term('r'), { ...term('sh'), foreground: 'zsh' }];
    c.emit('terminals', list());
    // e has no conversation in Claude's history either (a stand-in: never the user's ~/.claude).
    (hub as unknown as { history: unknown }).history = { hasConversation: async () => false };
    hub.installIpc();
    const close = handler(IPC.termClose);

    // Off (the default): today's request.
    await close({ sender: w }, 's');
    expect(kills()).toEqual([{ t: 'kill', id: 's' }]);

    // On: everything but a session with no message yet asks for a resume entry; atelierd gives back only what has one
    // (the conversation, the starting resume — nothing for the shell), as for window closes.
    vi.mocked(client.request).mockClear();
    (hub as unknown as { closing: Set<string> }).closing.clear();
    hub.settings = () => ({ ...DEFAULT_SETTINGS, keepClosedSessions: true });
    for (const id of ['s', 'e', 'r', 'sh']) await close({ sender: w }, id);
    expect(kills()).toEqual([{ t: 'kill', id: 's', resumable: true }, { t: 'kill', id: 'e' }, { t: 'kill', id: 'r', resumable: true }, { t: 'kill', id: 'sh', resumable: true }]);

    // On, but an atelierd without kill-resumable: today's request.
    vi.mocked(client.request).mockClear();
    (hub as unknown as { closing: Set<string> }).closing.clear();
    (client as unknown as { hasCapability: (c: string) => boolean }).hasCapability = (cap) => cap !== 'kill-resumable';
    await close({ sender: w }, 's');
    expect(kills()).toEqual([{ t: 'kill', id: 's' }]);
  });

  // Restart Session, /resume, `claude -c`: the conversation starts again with no last-message time (only atelierd's own
  // resumes seed it). Its transcript says it has one: kept. Never the user's ~/.claude here: the history is a stand-in.
  test('term:close: no last-message time yet, but a conversation in Claude\'s history → kept; none → for good', async () => {
    const { hub, register, client } = setup();
    const kills = () => (vi.mocked(client.request).mock.calls as unknown as [{ t: string }][]).filter(([m]) => m.t === 'kill').map(([m]) => m);
    const w = wc(1); win(w); register(w);
    const c = (hub as unknown as { client: EventEmitter }).client;
    const fresh = (id: string) => ({ ...term(id), session: { sessionId: `sid-${id}`, state: 'done', lastMessageAt: null } }) as unknown as TerminalInfo;
    c.emit('terminals', [fresh('restarted'), fresh('new')]);
    const asked: string[] = [];
    (hub as unknown as { history: unknown }).history = { hasConversation: async (q: { root: string }, sid: string) => { asked.push(`${q.root}:${sid}`); return sid === 'sid-restarted'; } };
    hub.installIpc();
    hub.settings = () => ({ ...DEFAULT_SETTINGS, keepClosedSessions: true });
    await handler(IPC.termClose)({ sender: w }, 'restarted');
    await handler(IPC.termClose)({ sender: w }, 'new');
    expect(kills()).toEqual([{ t: 'kill', id: 'restarted', resumable: true }, { t: 'kill', id: 'new' }]);
    expect(asked).toEqual(['/p:sid-restarted', '/p:sid-new']);
  });

  test('term:close: a history that can\'t be read keeps nothing extra; the setting off never reads it', async () => {
    const { hub, register, client } = setup();
    const kills = () => (vi.mocked(client.request).mock.calls as unknown as [{ t: string }][]).filter(([m]) => m.t === 'kill').map(([m]) => m);
    const w = wc(1); win(w); register(w);
    const c = (hub as unknown as { client: EventEmitter }).client;
    const fresh = (id: string) => ({ ...term(id), session: { sessionId: `sid-${id}`, state: 'done', lastMessageAt: null } }) as unknown as TerminalInfo;
    c.emit('terminals', [fresh('a'), fresh('b')]);
    const read = vi.fn(async () => { throw new Error('EACCES'); });
    (hub as unknown as { history: unknown }).history = { hasConversation: read };
    hub.installIpc();
    await handler(IPC.termClose)({ sender: w }, 'a');
    expect(read).not.toHaveBeenCalled();
    hub.settings = () => ({ ...DEFAULT_SETTINGS, keepClosedSessions: true });
    await handler(IPC.termClose)({ sender: w }, 'b');
    expect(kills()).toEqual([{ t: 'kill', id: 'a' }, { t: 'kill', id: 'b' }]);
  });

  test('with the setting on, term:kill and Close Run still end the session for good', async () => {
    const { hub, register, client } = setup();
    const kills = () => (vi.mocked(client.request).mock.calls as unknown as [{ t: string }][]).filter(([m]) => m.t === 'kill').map(([m]) => m);
    const w = wc(1); win(w); register(w);
    const c = (hub as unknown as { client: EventEmitter }).client;
    const s = (id: string) => ({ ...term(id), session: { sessionId: id, state: 'done', lastMessageAt: 1 } }) as unknown as TerminalInfo;
    c.emit('terminals', [s('a'), s('b')]);
    hub.installIpc();
    hub.settings = () => ({ ...DEFAULT_SETTINGS, keepClosedSessions: true });
    await handler(IPC.termKill)({ sender: w }, 'a');
    await hub.closeAutomatedSession('b');
    expect(kills()).toEqual([{ t: 'kill', id: 'a' }, { t: 'kill', id: 'b' }]);
  });

  // A window closing stops its project's terminals: sessions come back under Resume.
  // atelierd decides which have something to give back: a session, or a resume whose Claude hasn't started yet (main's
  // list may not show its session yet).
  test('stopProject kills the project’s terminals once, all with resumable; never another project’s', async () => {
    const { hub, client } = setup();
    const kills = () => (vi.mocked(client.request).mock.calls as unknown as [{ t: string }][]).filter(([m]) => m.t === 'kill').map(([m]) => m);
    const c = (hub as unknown as { client: EventEmitter }).client;
    const session = { ...term('s'), session: { sessionId: 'x', state: 'idle' } } as unknown as TerminalInfo;
    c.emit('terminals', [session, term('sh'), term('other', '/q')]);
    await hub.stopProject('/p');
    await hub.stopProject('/p');
    expect(kills()).toEqual([{ t: 'kill', id: 's', resumable: true }, { t: 'kill', id: 'sh', resumable: true }]);
  });

  test('stopProject: one terminal’s kill failing doesn’t keep the others running', async () => {
    const { hub, client } = setup();
    const c = (hub as unknown as { client: EventEmitter }).client;
    c.emit('terminals', [term('a'), term('b')]);
    vi.mocked(client.request).mockRejectedValueOnce(new Error('unknown terminal'));
    await expect(hub.stopProject('/p')).resolves.toBeUndefined();
    expect((vi.mocked(client.request).mock.calls as unknown as [{ t: string; id: string }][]).map(([m]) => m.id)).toEqual(['a', 'b']);
  });

  test('there is no "close many" handler any more (tabs only close tabs)', () => {
    const { hub } = setup();
    hub.installIpc();
    expect((IPC as Record<string, string>).termCloseMany).toBeUndefined();
  });
});

describe('the Claude Code signals notebook', () => {
  beforeEach(() => { fake.windows.clear(); });
  const handler = (channel: string) => {
    const call = (vi.mocked(ipcMain.handle).mock.calls as unknown as [string, (e: unknown, arg?: unknown) => unknown][]).findLast((c) => c[0] === channel);
    if (!call) throw new Error(`no handler for ${channel}`);
    return call[1];
  };
  const book = { lastVersion: '2.1.320', since: 1, entries: [{ kind: 'notification', event: 'Notification', value: 'quota_new_thing', version: '2.1.320', first: 1, last: 1, count: 1 }] };
  const sent = (w: Wc) => w.send.mock.calls.filter((c) => c[0] === IPC.evClaudeSignals).map((c) => c[1]);

  test("atelierd's book is kept and sent to every window; a window asks for it; daemonState says it is available", async () => {
    const { hub, register, client } = setup();
    const a = wc(1); win(a); register(a, '/p');
    const b = wc(2); win(b); register(b, '/q');
    hub.installIpc();
    expect(await handler(IPC.claudeSignals)({ sender: a })).toBeNull();
    client.emit('signals', book);
    expect(sent(a)).toEqual([book]);
    expect(sent(b)).toEqual([book]);
    expect(await handler(IPC.claudeSignals)({ sender: b })).toEqual(book);
    expect(hub.daemonState().signalsAvailable).toBe(true);
  });

  test('without the capability: null, nothing sent to atelierd, and daemonState says so', async () => {
    const { hub, register, client } = setup();
    (client as unknown as { hasCapability: (c: string) => boolean }).hasCapability = (cap) => cap !== 'signals';
    const a = wc(1); win(a); register(a);
    hub.installIpc();
    client.emit('signals', book);
    expect(await handler(IPC.claudeSignals)({ sender: a })).toBeNull();
    await handler(IPC.claudeSignalsClear)({ sender: a });
    expect(client.request).not.toHaveBeenCalled();
    expect(hub.daemonState().signalsAvailable).toBe(false);
  });

  test('Clear asks atelierd; a connection lost forgets the book (the next atelierd may be another one)', async () => {
    const { hub, register, client } = setup();
    const a = wc(1); win(a); register(a);
    hub.installIpc();
    client.emit('signals', book);
    await handler(IPC.claudeSignalsClear)({ sender: a });
    expect(client.request).toHaveBeenCalledWith({ t: 'signalsClear' });
    client.emit('status', 'disconnected');
    expect(await handler(IPC.claudeSignals)({ sender: a })).toBeNull();
  });

  test('both take no argument; an unknown sender is refused', async () => {
    const { hub, register, client } = setup();
    const a = wc(1); win(a); register(a);
    hub.installIpc();
    client.emit('signals', book);
    await expect(async () => handler(IPC.claudeSignals)({ sender: a }, { x: 1 })).rejects.toThrow();
    await expect(async () => handler(IPC.claudeSignalsClear)({ sender: a }, 'all')).rejects.toThrow();
    await expect(async () => handler(IPC.claudeSignals)({ sender: wc(9) })).rejects.toThrow('unauthorized sender');
    expect(client.request).not.toHaveBeenCalled();
  });
});

// Moving a terminal to another project's window.
describe('a terminal moved to another project\'s window', () => {
  beforeEach(() => { fake.windows.clear(); });

  test('rehomed: the old project\'s windows stop watching it at once (no output, no input), atelierd keeps its listener', async () => {
    const { hub, register, client } = setup();
    const { ipcMain } = await import('electron');
    vi.mocked(ipcMain.handle).mockClear(); vi.mocked(ipcMain.on).mockClear();
    hub.installIpc();
    const handler = (mock: unknown, channel: string) => (mock as { mock: { calls: [string, (e: unknown, arg: unknown) => unknown][] } }).mock.calls.find((c) => c[0] === channel)![1];
    const a = wc(1); win(a); register(a, '/p');
    client.emit('terminals', [term('t1', '/p')]);
    const first = handler(ipcMain.handle, IPC.termAttach)({ sender: { id: 1 } }, 't1') as Promise<void>;
    await Promise.resolve();
    client.emit('snapshot', 't1', 'screen');
    await first;
    client.emit('data', 't1', 'one');
    expect(a.send.mock.calls.filter((c) => c[0] === IPC.evData)).toHaveLength(1);
    client.request.mockClear();
    hub.rehomed('t1', '/q');
    client.emit('data', 't1', 'two');
    expect(a.send.mock.calls.filter((c) => c[0] === IPC.evData)).toHaveLength(1);
    expect(client.request.mock.calls.map((c) => ((c as unknown[])[0] as { t?: string } | undefined)?.t)).not.toContain('detach');
  });

  test('a moved terminal\'s session resumed in its new window: the reply goes through onResumed (its home)', async () => {
    const { hub, register, client } = setup();
    const { ipcMain } = await import('electron');
    vi.mocked(ipcMain.handle).mockClear();
    hub.installIpc();
    const handler = (channel: string) => vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === channel)![1] as (e: unknown, arg: unknown) => Promise<TerminalInfo>;
    const b = wc(2); win(b); register(b, '/q');
    client.emit('resumables', [{ id: 'old', projectRoot: '/q', cwd: '/p', title: 'x', color: '#fff', sessionId: 's', endedAt: 1 }]);
    client.request.mockResolvedValue(term('new', '/p') as never);
    hub.onResumed = (oldId, info) => (oldId === 'old' ? { ...info, projectRoot: '/q' } : info);
    const info = await handler(IPC.termResume)({ sender: { id: 2 } }, { id: 'old', cols: 80, rows: 24 });
    expect(info.projectRoot).toBe('/q');
    expect(hub.allTerminals().find((t) => t.id === 'new')?.projectRoot).toBe('/q');
  });
});

describe('a turn interrupted before Claude wrote anything', () => {
  beforeEach(() => { fake.windows.clear(); });
  afterEach(() => { vi.useRealTimers(); });

  /** Fake time in steps, with real turns of the event loop in between (the settings read is real I/O). */
  const pass = async (ms: number) => {
    for (let t = 0; t < ms; t += 50) {
      await vi.advanceTimersByTimeAsync(50);
      await new Promise((r) => setImmediate(r));
    }
  };

  /**
   * A running session (its account's settings.json, its folder's .claude/settings.local.json as given) in a window that
   * shows it, or in none.
   */
  async function interrupted(o: { settings?: object; local?: object; shown?: boolean } = {}) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const configDir = mkdtempSync(join(tmpdir(), 'atl-claude-'));
    if (o.settings) writeFileSync(join(configDir, 'settings.json'), JSON.stringify(o.settings));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'atl-prj-')));
    if (o.local) { mkdirSync(join(project, '.claude')); writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify(o.local)); }
    const { hub, register, client } = setup();
    vi.mocked(ipcMain.handle).mockClear(); vi.mocked(ipcMain.on).mockClear();
    hub.installIpc();
    const on = (channel: string) => vi.mocked(ipcMain.on).mock.calls.find((c) => c[0] === channel)![1] as (e: unknown, arg: unknown) => void;
    const handle = (channel: string) => vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === channel)![1] as (e: unknown, arg: unknown) => Promise<void>;
    const w = wc(1); win(w); register(w, project);
    client.emit('status', 'connected');
    const running = { ...term('a', project), configDir, session: { sessionId: 's', state: 'running', title: null, activity: null, contextPct: null, unread: false, updatedAt: Date.now() } } as TerminalInfo;
    client.emit('terminals', [running]);
    if (o.shown !== false) {
      const attached = handle(IPC.termAttach)({ sender: { id: 1 } }, 'a');
      await Promise.resolve();
      client.emit('snapshot', 'a', 'screen');
      await attached;
    }
    const type = (data: string) => on(IPC.termInput)({ sender: { id: 1 } }, { id: 'a', data });
    const state = () => hub.allTerminals()[0]!.session!.state;
    return { hub, client, type, state };
  }

  test('Esc, Claude puts the prompt back and goes quiet with no hook: ready ~1.5 s later; the next prompt is its own state', async () => {
    const { hub, client, type, state } = await interrupted();
    type('\x1b');
    client.emit('data', 'a', '\x1b[2K> fix the test');
    await pass(1000);
    expect(state()).toBe('running');
    await pass(1000);
    expect(state()).toBe('idle');
    type('\r');
    client.emit('terminals', [{ ...hub.allTerminals()[0]!, session: { sessionId: 's', state: 'running', title: null, activity: null, contextPct: null, unread: false, updatedAt: Date.now() + 1 } } as TerminalInfo]);
    expect(state()).toBe('running');
  });

  test('the quiet counts from the last output: a redraw 0.8 s after the key moves the check on, it waits again', async () => {
    const { client, type, state } = await interrupted();
    type('\x1b');
    await pass(800);
    client.emit('data', 'a', '\x1b[2K> fix the test');
    await pass(900);
    // 1.7 s after the key but only 0.9 s after the redraw.
    expect(state()).toBe('running');
    await pass(800);
    expect(state()).toBe('idle');
  });

  test('main cut off from atelierd right after the key (no output can come): still working', async () => {
    const { client, type, state } = await interrupted();
    type('\x1b');
    client.emit('status', 'disconnected');
    await pass(3000);
    expect(state()).toBe('running');
  });

  test('the spinner still drawing (the Esc closed a menu), reduced motion, or no window showing it: still working', async () => {
    const spinning = await interrupted();
    spinning.type('\x1b');
    for (let i = 0; i < 20; i++) { spinning.client.emit('data', 'a', '\x1b[1G✻ Thinking…'); await pass(300); }
    await pass(3000);
    expect(spinning.state()).toBe('running');
    for (const o of [{ settings: { prefersReducedMotion: true } }, { local: { prefersReducedMotion: true } }]) {
      vi.useRealTimers();
      const reduced = await interrupted(o);
      reduced.type('\x1b');
      await pass(3000);
      expect(reduced.state(), JSON.stringify(o)).toBe('running');
    }
    // Stop Run on an automated session no window shows (the only Esc that reaches a terminal with no window).
    vi.useRealTimers();
    const unseen = await interrupted({ shown: false });
    unseen.hub.interruptSession('a');
    await pass(3000);
    expect(unseen.state()).toBe('running');
  });
});
