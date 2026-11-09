import { beforeEach, describe, expect, test, vi } from 'vitest';
import { loopRowId } from '@shared/loop';
import { useApp } from './store';

// The store talks to window.atelier only in actions that need it: a minimal stub.
beforeEach(() => {
  (globalThis as unknown as { window: object }).window = { atelier: { background: { watch: vi.fn(async () => ({ ok: true })), unwatch: vi.fn() } } };
  // Feeds are taken only for watched items: the tests' usual one is.
  useApp.setState({ backgroundTab: null, bgFeeds: {}, bgWatched: { 't1:b1': true }, tabOrder: [], activeTab: 'term', selectedId: null });
});

describe('Background feeds', () => {
  const feed = (over: object = {}) => ({ key: 't1:m1', kind: 'output' as const, lines: ['a'], live: '', reset: true, seq: 1, dropped: 0, exit: null, at: 5, ...over });
  test('watching marks the key, unwatching clears it; a feed for a key nobody watches is ignored', async () => {
    const s = useApp.getState();
    expect(await s.watchBackground('t1', 'm1')).toEqual({ ok: true });
    expect(window.atelier.background.watch).toHaveBeenCalledWith('t1', 'm1');
    s.applyBackgroundFeed(feed());
    expect(useApp.getState().bgFeeds['t1:m1']).toBeDefined();
    useApp.getState().unwatchBackground('t1', 'm1');
    expect(window.atelier.background.unwatch).toHaveBeenCalledWith('t1', 'm1');
    useApp.getState().dropBackgroundFeed('t1:m1');
    // A feed main sent before it saw the unwatch arrives late: no stale entry comes back.
    useApp.getState().applyBackgroundFeed(feed({ lines: ['late'] }));
    expect(useApp.getState().bgFeeds['t1:m1']).toBeUndefined();
  });
  test('a reset that repeats kept lines keeps their arrival times (a monitor tab hidden, then shown again)', () => {
    const s = useApp.getState();
    void s.watchBackground('t1', 'm1');
    s.applyBackgroundFeed(feed({ lines: ['old'], at: 1 }));
    s.applyBackgroundFeed(feed({ lines: ['e1', 'e2'], reset: false, at: 10 }));
    s.applyBackgroundFeed(feed({ lines: ['e3'], reset: false, at: 20 }));
    // Shown again: main sends the whole file as a fresh snapshot (arrival unknown), plus a line that is new.
    s.applyBackgroundFeed(feed({ lines: ['old', 'e1', 'changed', 'e3', 'e4'], at: 30 }));
    expect(useApp.getState().bgFeeds['t1:m1']!.lines).toEqual([
      { text: 'old', at: null }, { text: 'e1', at: 10 }, { text: 'changed', at: null }, { text: 'e3', at: 20 }, { text: 'e4', at: null }
    ]);
  });
  test('kept times follow the absolute line number (dropped lines counted)', () => {
    const s = useApp.getState();
    void s.watchBackground('t1', 'm1');
    s.applyBackgroundFeed(feed({ lines: ['a', 'b'], reset: false, dropped: 2, at: 1 }));
    s.applyBackgroundFeed(feed({ lines: ['c'], reset: false, dropped: 2, at: 10 }));
    // The same follower's snapshot again (same dropped count): 'a', 'b' and 'c' keep their times.
    s.applyBackgroundFeed(feed({ lines: ['a', 'b', 'c', 'd'], dropped: 2, at: 30 }));
    expect(useApp.getState().bgFeeds['t1:m1']!.lines).toEqual([{ text: 'a', at: 1 }, { text: 'b', at: 1 }, { text: 'c', at: 10 }, { text: 'd', at: null }]);
  });
  test('a snapshot that starts at another absolute line (a re-watched big output) carries no times, even with repeated text', () => {
    const s = useApp.getState();
    void s.watchBackground('t1', 'm1');
    s.applyBackgroundFeed(feed({ lines: ['tick', 'tick', 'tick', 'tick'], at: 1 }));
    s.applyBackgroundFeed(feed({ lines: ['tick', 'tick', 'tick', 'tick'], reset: false, at: 10 }));
    s.applyBackgroundFeed(feed({ lines: ['tick', 'tick', 'tick', 'tick'], dropped: 2, at: 30 }));
    expect(useApp.getState().bgFeeds['t1:m1']!.lines.map((l) => l.at)).toEqual([null, null, null, null]);
  });
});

describe('Background tab', () => {
  test('opening sets the scope and the item, adds the tab once, activates it here', () => {
    useApp.getState().openBackground({ terminalId: 't1', itemId: 'b1', here: true });
    expect(useApp.getState().backgroundTab).toMatchObject({ terminalId: 't1', itemId: 'b1' });
    expect(useApp.getState().tabOrder.filter((k) => k === 'background')).toHaveLength(1);
    expect(useApp.getState().activeTab).toBe('background');
    useApp.getState().openBackground({ terminalId: 't2', here: true });
    expect(useApp.getState().backgroundTab).toMatchObject({ terminalId: 't2', itemId: null });
    expect(useApp.getState().tabOrder.filter((k) => k === 'background')).toHaveLength(1);
  });
  test('closing the tab forgets it', () => {
    useApp.getState().openBackground({ terminalId: 't1', here: true });
    useApp.getState().closeTab('background');
    expect(useApp.getState().backgroundTab).toBeNull();
    expect(useApp.getState().tabOrder).not.toContain('background');
  });
  test('output feeds append, reset replaces, the buffer is capped, new lines carry their time', () => {
    const s = useApp.getState();
    s.applyBackgroundFeed({ key: 't1:b1', kind: 'output', lines: ['a', 'b'], live: '', reset: true, seq: 2, dropped: 0, exit: null, at: 10 });
    s.applyBackgroundFeed({ key: 't1:b1', kind: 'output', lines: ['c'], live: 'd', reset: false, seq: 3, dropped: 0, exit: null, at: 20 });
    expect(useApp.getState().bgFeeds['t1:b1']).toMatchObject({ lines: [{ text: 'a', at: null }, { text: 'b', at: null }, { text: 'c', at: 20 }], live: 'd' });
    s.applyBackgroundFeed({ key: 't1:b1', kind: 'output', lines: ['x'], live: '', reset: true, seq: 1, dropped: 0, exit: 0, at: 30 });
    expect(useApp.getState().bgFeeds['t1:b1']).toMatchObject({ lines: [{ text: 'x', at: null }], exit: 0 });
  });
  test('the output buffer is capped at BUFFER_LINES, keeping the newest line', () => {
    const s = useApp.getState();
    const many = Array.from({ length: 4999 }, (_, i) => `l${i}`);
    s.applyBackgroundFeed({ key: 't1:b1', kind: 'output', lines: many, live: '', reset: true, seq: 1, dropped: 0, exit: null, at: 1 });
    s.applyBackgroundFeed({ key: 't1:b1', kind: 'output', lines: ['p', 'q', 'last'], live: '', reset: false, seq: 2, dropped: 0, exit: null, at: 2 });
    const lines = useApp.getState().bgFeeds['t1:b1']!.lines;
    expect(lines).toHaveLength(5000);
    expect(lines[4999]!.text).toBe('last');
  });
  test('a terminal that is gone closes the tab; its feeds and popover go too', () => {
    const term = (id: string) => ({ id, title: id, cwd: '/p', session: { sessionId: 's' } }) as never;
    useApp.getState().setTerminals([term('t1'), term('t2')]);
    useApp.getState().openBackground({ terminalId: 't1', here: true });
    useApp.setState({ bgFeeds: { 't1:x': { kind: 'output', lines: [], live: '', dropped: 0, exit: null, entries: [], meta: null }, 't2:y': { kind: 'output', lines: [], live: '', dropped: 0, exit: null, entries: [], meta: null } } });
    useApp.getState().openBgPopover({ terminalId: 't1', anchor: { left: 0, top: 0, right: 1, bottom: 1 }, side: 'below', section: 'all' });
    useApp.getState().setTerminals([term('t2')]);
    expect(useApp.getState().backgroundTab).toBeNull();
    expect(useApp.getState().tabOrder).not.toContain('background');
    expect(Object.keys(useApp.getState().bgFeeds)).toEqual(['t2:y']);
    expect(useApp.getState().bgPopover).toBeNull();
  });
  test('a popover whose terminal lost its session closes', () => {
    useApp.getState().setTerminals([{ id: 't1', title: 't', cwd: '/p', session: { sessionId: 's' } } as never]);
    useApp.getState().openBgPopover({ terminalId: 't1', anchor: { left: 0, top: 0, right: 1, bottom: 1 }, side: 'right', section: 'all' });
    useApp.getState().setTerminals([{ id: 't1', title: 't', cwd: '/p' } as never]);
    expect(useApp.getState().bgPopover).toBeNull();
  });
  describe('the popover follows the front of the window', () => {
    const open = () => useApp.getState().openBgPopover({ terminalId: 't1', anchor: { left: 0, top: 0, right: 1, bottom: 1 }, side: 'below', section: 'all' });
    beforeEach(() => {
      useApp.setState({ terminals: [{ id: 't1', title: 't1', cwd: '/p', session: { sessionId: 's' } } as never, { id: 't2', title: 't2', cwd: '/p', session: { sessionId: 's2' } } as never] });
    });
    test('selecting another session closes it, selecting the same one keeps it', () => {
      open();
      useApp.getState().select('t1');
      expect(useApp.getState().bgPopover).not.toBeNull();
      useApp.getState().select('t2');
      expect(useApp.getState().bgPopover).toBeNull();
    });
    test.each([
      ['the palette', () => useApp.getState().setPaletteOpen(true)],
      ['Settings', () => useApp.getState().setSettingsOpen('general' as never)],
      ['the notes', () => useApp.getState().setNotesOpen(true)],
      ['the new session sheet', () => useApp.getState().setNewSessionOpen(true)],
      ['the folder sheet', () => useApp.getState().setFolderSheet({} as never)],
      ['the ref picker', () => useApp.getState().setRefPicker({} as never)],
      ['the language sheet', () => useApp.getState().setLanguageSheet({} as never)],
      ['the SCM switcher', () => useApp.getState().setScmSwitcherOpen(true)]
    ])('opening %s closes it', (_name, act) => {
      open();
      act();
      expect(useApp.getState().bgPopover).toBeNull();
    });
  });
  test('dropBackgroundFeed removes one key', () => {
    useApp.getState().applyBackgroundFeed({ key: 't1:b1', kind: 'output', lines: ['a'], live: '', reset: true, seq: 1, dropped: 0, exit: null, at: 1 });
    useApp.getState().dropBackgroundFeed('t1:b1');
    expect(useApp.getState().bgFeeds).toEqual({});
  });
  test('not here, with a terminal tab active: opens to the side in a split', () => {
    useApp.setState({ tabOrder: ['t:x'], activeTab: 'term', selectedId: 'x' });
    useApp.getState().openBackground({ terminalId: 'x' });
    const s = useApp.getState();
    expect(s.split.panes.map((p) => p.tabs)).toEqual([['t:x'], ['background']]);
    expect(s.split.focus).toBe(1);
    expect(s.activeTab).toBe('background');
  });
  describe('the shown item is always a concrete, pinned id', () => {
    const e = (id: string, kind = 'shell') => ({ id, kind, label: id, since: 0, counted: true });
    const term = (id: string, entries: object[], extra: object = {}) => ({ id, title: id, cwd: '/p', session: { sessionId: `s-${id}` }, work: { entries, crons: [], items: [] }, ...extra }) as never;
    const item = () => useApp.getState().backgroundTab?.itemId;
    test('opening without an item and changing the scope select the first row; a new first row does not take over', () => {
      useApp.getState().setTerminals([term('t1', [e('a')]), term('t2', [e('s1'), e('s2')])]);
      useApp.getState().openBackground({ terminalId: 't1', here: true });
      expect(item()).toBe('a');
      useApp.getState().setBackgroundScope('t2');
      expect(item()).toBe('s1');
      useApp.getState().setTerminals([term('t1', [e('a')]), term('t2', [e('ag', 'agent'), e('s1'), e('s2')])]);
      expect(item()).toBe('s1');
    });
    test('a quiet session pins the first item that appears, then keeps it', () => {
      useApp.getState().setTerminals([term('t1', [])]);
      useApp.getState().openBackground({ terminalId: 't1', here: true });
      expect(item()).toBeNull();
      useApp.getState().setTerminals([term('t1', [e('x')])]);
      expect(item()).toBe('x');
      useApp.getState().setTerminals([term('t1', [e('ag', 'agent'), e('x')])]);
      expect(item()).toBe('x');
    });
    test('the selection is kept while the work is momentarily absent, and when the session ended (its items recent)', () => {
      useApp.getState().setTerminals([term('t1', [e('a'), e('b')])]);
      useApp.getState().openBackground({ terminalId: 't1', itemId: 'b', here: true });
      // A list without the work field (an older atelierd, a momentary list): nothing to reselect from.
      useApp.getState().setTerminals([{ id: 't1', title: 't1', cwd: '/p', session: { sessionId: 's-t1' } } as never]);
      expect(item()).toBe('b');
      // SessionEnd: no session, no work, the items are recent.
      const recent = (id: string) => ({ id, kind: 'shell', label: id, since: 0, endedAt: 1, exit: null, sessionId: 's-t1', cwd: '/p' });
      useApp.getState().setTerminals([{ id: 't1', title: 't1', cwd: '/p', recent: [recent('b'), recent('a')] } as never]);
      expect(item()).toBe('b');
      expect(useApp.getState().backgroundTab?.terminalId).toBe('t1');
    });
    test('with no entries the first row is a scheduled task, then a recent item', () => {
      useApp.getState().setTerminals([term('t1', [], { work: { entries: [], items: [], crons: [{ id: 'k', label: 'k', schedule: '* * * * *', recurring: true, next: null }] } }), term('t2', [], { recent: [{ id: 'r', kind: 'shell', label: 'r', since: 0, endedAt: 1, exit: 0 }] })]);
      useApp.getState().openBackground({ terminalId: 't1', here: true });
      expect(item()).toBe('cron:k');
      useApp.getState().setBackgroundScope('t2');
      expect(item()).toBe('r');
    });
    test('a self-paced loop stays selected across turns (a new cron id each time), and leaves when it stops', () => {
      const loop = (id: string) => ({ id, label: '/loop check the preview deploy', schedule: '28 10 * * *', recurring: false, next: null });
      const withLoop = (cronId: string | null) => term('t1', [e('b9')], { work: { entries: [e('b9')], items: [], crons: cronId ? [loop(cronId)] : [] } });
      const row = loopRowId('/loop check the preview deploy');
      useApp.getState().setTerminals([withLoop('w1')]);
      useApp.getState().openBackground({ terminalId: 't1', itemId: row, here: true });
      expect(item()).toBe(row);
      useApp.getState().setTerminals([withLoop('w2')]);
      expect(item()).toBe(row);
      useApp.getState().setTerminals([withLoop(null)]);
      expect(item()).toBe('b9');
    });
  });
  test('a live-only update keeps the same lines array (the log rows are not rebuilt)', () => {
    const s = useApp.getState();
    s.applyBackgroundFeed({ key: 't1:b1', kind: 'output', lines: ['a'], live: '', reset: true, seq: 1, dropped: 0, exit: null, at: 1 });
    const before = useApp.getState().bgFeeds['t1:b1']!.lines;
    s.applyBackgroundFeed({ key: 't1:b1', kind: 'output', lines: [], live: 'part', reset: false, seq: 1, dropped: 0, exit: null, at: 2 });
    expect(useApp.getState().bgFeeds['t1:b1']!.lines).toBe(before);
    expect(useApp.getState().bgFeeds['t1:b1']!.live).toBe('part');
  });
  test('a missing selected item falls back to the first entry', () => {
    useApp.getState().openBackground({ terminalId: 't1', itemId: 'gone', here: true });
    useApp.getState().setTerminals([{ id: 't1', title: 'S', cwd: '/p', session: { sessionId: 's' }, work: { entries: [{ id: 'b2', kind: 'shell', label: 'b2', since: 0, counted: true }] } } as never]);
    expect(useApp.getState().backgroundTab?.itemId).toBe('b2');
  });
});
