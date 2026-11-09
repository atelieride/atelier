import { describe, expect, test } from 'vitest';
import { dockPoint, normalizeSaved, placeWindow, popoutKind, restorable, restoreBounds, routeCommand, POPOUT_MIN, HANDLE_OFFSET } from './popout';

describe('popoutKind / restorable', () => {
  test.each([
    ['t:abc', 'terminal'], ['f:/p/a.ts', 'file'], ['f:untitled:1', 'file'], ['services', 'services'], ['review', 'review'],
    ['history', 'history'], ['background', 'background'], ['rev:/p@abc:a.ts', 'rev'],
    ['dk:overview', 'docker'], ['dk:s:acme', 'docker'], ['dk:c:0123456789ab', 'docker'], ['rd:keys', 'redis'], ['rd:live', 'redis'],
    ['t:', null], ['f:', null], ['nope', null], ['', null], ['docker', null], ['dk:', null], ['dk:c:XYZ', null], ['redis', null], ['rd:nope', null]
  ])('%s → %s', (k, kind) => { expect(popoutKind(k)).toBe(kind); });
  test('a table tab pops out by its db: key, strictly shaped; never brought back after a relaunch', () => {
    for (const k of ['db:c0123456789ab/public/orders', 'db:c0123456789ab/public/Order%20%22Items%22', 'db:c0123456789ab']) {
      expect(popoutKind(k), k).toBe('db');
      expect(restorable(k), k).toBe(false);
    }
    for (const k of ['db:', 'db:nope', 'db:c0123456789ab/public', 'db:c0123456789ab/public/a/b', `db:c0123456789ab/public/${'x'.repeat(300)}`]) expect(popoutKind(k), k).toBeNull();
  });
  test('only live things come back after a relaunch: terminals and files on disk (never untitled buffers or views of a moment)', () => {
    expect(restorable('t:abc')).toBe(true);
    expect(restorable('f:/p/a.ts')).toBe(true);
    expect(restorable('f:untitled:1')).toBe(false);
    expect(restorable('f:relative.ts')).toBe(false);
    for (const k of ['services', 'review', 'history', 'background', 'dk:overview', 'rd:keys', 'rev:/p@abc:a.ts']) expect(restorable(k)).toBe(false);
  });
});

describe('routeCommand', () => {
  test('about the tab: stays in the pop-out', () => {
    for (const c of ['save', 'save-all-and-close', 'comment-selection', 'next-change', 'prev-change', 'reveal-in-finder', 'md-toggle-preview', 'md-split', 'md-outline', 'session-panel', 'ask-session', 'send-review', 'show-background', 'review-session', 'toggle-word-wrap'] as const) expect(routeCommand(c)).toBe('local');
  });
  test('closing the tab and the toggle move it back', () => {
    for (const c of ['close-tab', 'move-tab-window', 'move-tab-back'] as const) expect(routeCommand(c)).toBe('dock');
  });
  test('Save All saves in every window of the project', () => { expect(routeCommand('save-all')).toBe('everywhere'); });
  test('about the project: the main window', () => {
    for (const c of ['new-session', 'open-palette', 'open-settings', 'view-sessions', 'next-tab', 'tab-3', 'split-right', 'review-all', 'show-notifications', 'new-session-account:x', 'new-terminal-profile:zsh'] as const) expect(routeCommand(c)).toBe('main');
  });
});

describe('placeWindow', () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  test('under the cursor: the handle lands under the pointer', () => {
    expect(placeWindow({ cursor: { x: 700, y: 400 }, size: { width: 800, height: 500 }, main: area, areas: [area], cascade: 0 }))
      .toEqual({ x: 700 - HANDLE_OFFSET.x, y: 400 - HANDLE_OFFSET.y, width: 800, height: 500 });
  });
  test('cascaded over the main window centre, 32 px per pop-out already open', () => {
    const main = { x: 100, y: 100, width: 1200, height: 700 };
    expect(placeWindow({ cursor: null, size: { width: 600, height: 400 }, main, areas: [area], cascade: 0 })).toEqual({ x: 400, y: 250, width: 600, height: 400 });
    expect(placeWindow({ cursor: null, size: { width: 600, height: 400 }, main, areas: [area], cascade: 2 })).toEqual({ x: 464, y: 314, width: 600, height: 400 });
  });
  test('clamped into the work area of the display it is on, never smaller than the minimum', () => {
    const b = placeWindow({ cursor: { x: 1430, y: 890 }, size: { width: 100, height: 100 }, main: area, areas: [area], cascade: 0 });
    expect(b.width).toBe(POPOUT_MIN.width);
    expect(b.height).toBe(POPOUT_MIN.height);
    expect(b.x + b.width).toBeLessThanOrEqual(1440);
    expect(b.y + b.height).toBeLessThanOrEqual(900);
  });
  test('a size bigger than the display shrinks to it', () => {
    const b = placeWindow({ cursor: null, size: { width: 5000, height: 3000 }, main: area, areas: [area], cascade: 0 });
    expect(b).toEqual({ x: 0, y: 25, width: 1440, height: 875 });
  });
  test('the handle offset is the grip centre: bar padding 14 + traffic lights 64 + gap 8 + margin 4 + half the grip 11', () => {
    expect(HANDLE_OFFSET).toEqual({ x: 101, y: 22 });
  });
});

describe('restoreBounds', () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  const right = { x: 1440, y: 0, width: 1920, height: 1080 };
  test('on a display: only clamped', () => {
    expect(restoreBounds({ x: 100, y: 100, width: 600, height: 400 }, [area])).toEqual({ x: 100, y: 100, width: 600, height: 400 });
    expect(restoreBounds({ x: 1300, y: 100, width: 600, height: 400 }, [area])).toEqual({ x: 840, y: 100, width: 600, height: 400 });
  });
  test('saved bounds on a display that is gone: placed on the first display, clamped', () => {
    expect(restoreBounds({ x: 3000, y: 100, width: 600, height: 400 }, [area])).toEqual({ x: 840, y: 100, width: 600, height: 400 });
  });
  test('the display where its bar can be grabbed (100×40 px of it): there, clamped', () => {
    // Its bar 200 px into the second display.
    expect(restoreBounds({ x: 3160, y: 300, width: 600, height: 400 }, [area, right])).toEqual({ x: 2760, y: 300, width: 600, height: 400 });
  });
  test('a sliver on a display is not enough: 1 px across, or the bar off its top, it goes to the first display', () => {
    // 1 px of the window on the second display.
    expect(restoreBounds({ x: 3359, y: 300, width: 600, height: 400 }, [area, right])).toEqual({ x: 840, y: 300, width: 600, height: 400 });
    // 90 px of its bar on the second display: too narrow to grab.
    expect(restoreBounds({ x: 3270, y: 300, width: 600, height: 400 }, [area, right])).toEqual({ x: 840, y: 300, width: 600, height: 400 });
    // Its body on the second display, its bar above it (30 px of the bar's height left).
    expect(restoreBounds({ x: 2000, y: -16, width: 600, height: 400 }, [area, right])).toEqual({ x: 840, y: 25, width: 600, height: 400 });
  });
  test('no displays at all: unchanged', () => {
    const b = { x: 3000, y: 100, width: 600, height: 400 };
    expect(restoreBounds(b, [])).toEqual(b);
  });
});

describe('normalizeSaved', () => {
  test('keeps valid entries only, at most 16 per project, last ones win', () => {
    const ok = { root: '/p', key: 't:a', bounds: { x: 1, y: 2, width: 600, height: 400 } };
    const many = Array.from({ length: 20 }, (_, i) => ({ root: '/p', key: `t:${i}`, bounds: ok.bounds }));
    expect(normalizeSaved([ok, { root: '/p', key: 'review', bounds: ok.bounds }, { root: 1 }, null, 'x'])).toEqual([ok]);
    expect(normalizeSaved(many).map((s) => s.key)).toEqual(many.slice(4).map((s) => s.key));
    expect(normalizeSaved('nope')).toEqual([]);
    expect(normalizeSaved([{ ...ok, bounds: { x: 0, y: 0, width: Number.NaN, height: 1 } }])).toEqual([]);
  });
  test("a file remembered read-only keeps main's mark; anything else there is dropped", () => {
    const ro = { root: '/p', key: 'f:/out/plan.md', bounds: { x: 1, y: 2, width: 600, height: 400 }, readOnly: true };
    expect(normalizeSaved([ro])).toEqual([ro]);
    expect(normalizeSaved([{ ...ro, readOnly: 'yes' }])).toEqual([{ root: '/p', key: 'f:/out/plan.md', bounds: ro.bounds }]);
  });
  test('one entry per project and key (the last)', () => {
    const a = { root: '/p', key: 't:a', bounds: { x: 1, y: 1, width: 600, height: 400 } };
    const b = { ...a, bounds: { x: 9, y: 9, width: 600, height: 400 } };
    expect(normalizeSaved([a, b])).toEqual([b]);
  });
});

describe('dockPoint', () => {
  const content = { x: 100, y: 50, width: 1000, height: 600 };
  test('inside the main window content: its client point (zoom applied)', () => {
    expect(dockPoint({ x: 300, y: 150 }, content, 1)).toEqual({ x: 200, y: 100 });
    expect(dockPoint({ x: 300, y: 150 }, content, 1.25)).toEqual({ x: 160, y: 80 });
  });
  test('outside: null', () => {
    expect(dockPoint({ x: 99, y: 150 }, content, 1)).toBeNull();
    expect(dockPoint({ x: 300, y: 650 }, content, 1)).toBeNull();
  });
});
