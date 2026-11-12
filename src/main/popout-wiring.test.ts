import { describe, expect, test } from 'vitest';
import { commandFrom, commandPlan, forwardCommand, isPopoutWindow, mainWindows, openProjectRoots, pageReloading, projectWindowId, windowToFront, type WindowKind } from './popout-wiring';

describe('the window the app comes forward with (a second launch, Open Atelier)', () => {
  const w = (id: number, usedAt: number, popout = false) => ({ id, popout, usedAt });

  test('the one used last — focused, or brought forward by Atelier — never simply the first', () => {
    // Y (1) was in use before the user left; a click on a banner of X's session brought X (2) forward a moment ago, and
    // macOS's second launch of Atelier (a newer copy of the bundle) hands over right after: X stays in front.
    expect(windowToFront([w(1, 500), w(2, 900)])).toBe(2);
    expect(windowToFront([w(1, 900), w(2, 500)])).toBe(1);
  });

  test('a pop-out used last is the one', () => {
    expect(windowToFront([w(1, 500), w(3, 900, true)])).toBe(3);
  });

  test('none used yet: the first project or welcome window, a pop-out only when alone; no window: null', () => {
    expect(windowToFront([w(3, 0, true), w(1, 0), w(2, 0)])).toBe(1);
    expect(windowToFront([w(3, 0, true)])).toBe(3);
    expect(windowToFront([])).toBeNull();
  });
});

test("a pop-out's page loading anew is its main frame's own navigation: never an iframe's, never a same-page one", () => {
  expect(pageReloading({ isMainFrame: true, isSameDocument: false })).toBe(true);
  expect(pageReloading({ isMainFrame: false, isSameDocument: false })).toBe(false);
  expect(pageReloading({ isMainFrame: true, isSameDocument: true })).toBe(false);
});

// Windows: 1 = /a's project window, 2 and 3 = /a's pop-outs, 4 = /b's project window, 5 = the welcome window.
const view = () => {
  const projects = new Map<number, string | null>([[2, '/a'], [1, '/a'], [3, '/a'], [4, '/b'], [5, null]]);
  const kinds = new Map<number, WindowKind>([[1, 'project'], [2, 'popout'], [3, 'popout'], [4, 'project'], [5, 'project']]);
  return { projects, kinds };
};

describe('pop-out windows among the windows', () => {
  test("the project's window is never a pop-out, even one listed first", () => {
    expect(projectWindowId(view(), '/a')).toBe(1);
    expect(projectWindowId(view(), '/b')).toBe(4);
    expect(projectWindowId(view(), '/c')).toBeNull();
    const onlyPopout = { projects: new Map<number, string | null>([[2, '/a']]), kinds: new Map<number, WindowKind>([[2, 'popout']]) };
    expect(projectWindowId(onlyPopout, '/a')).toBeNull();
  });

  test('isPopoutWindow', () => {
    expect(isPopoutWindow(view(), 2)).toBe(true);
    expect(isPopoutWindow(view(), 1)).toBe(false);
    expect(isPopoutWindow(view(), 99)).toBe(false);
  });

  test('open projects to remember: project windows only, once each', () => {
    const v = view();
    v.kinds.set(6, 'popout'); v.projects.set(6, '/c');
    expect(openProjectRoots(v)).toEqual(['/a', '/b']);
  });

  test('main windows (what the file opener targets): project and welcome windows, no pop-out', () => {
    expect(mainWindows(view())).toEqual([[1, '/a'], [4, '/b'], [5, null]]);
  });
});

test('a command a pop-out forwards runs in its project window, which comes forward; F4 / ⇧F4 bring it forward only if their result opens there', () => {
  const done: string[] = [];
  const d = { send: (w: string, c: string) => done.push(`send ${w} ${c}`), reveal: (w: string) => done.push(`reveal ${w}`) };
  forwardCommand('open-palette', 'main', d);
  forwardCommand('next-search-result', 'main', d);
  forwardCommand('prev-search-result', 'main', d);
  forwardCommand('open-palette', null, d);
  expect(done).toEqual(['send main open-palette', 'reveal main', 'send main next-search-result', 'send main prev-search-result']);
  // Sent as given in a pop-out.
  const sent: unknown[][] = [];
  forwardCommand('find-in-files', 'main', { send: (...a) => sent.push(a), reveal: () => {} });
  expect(sent).toEqual([['main', 'find-in-files', 'popout']]);
});

test('a command a pop-out sends on to another window says so; the window it was given in, or a project window\'s own, does not', () => {
  const v = { projects: new Map<number, string | null>([[1, '/a'], [2, '/a']]), kinds: new Map<number, WindowKind>([[1, 'project'], [2, 'popout']]) };
  expect(commandFrom(2, 1, v)).toBe('popout');
  expect(commandFrom(2, 2, v)).toBeUndefined();
  expect(commandFrom(1, 1, v)).toBeUndefined();
  expect(commandFrom(1, 2, v)).toBeUndefined();
});

describe('commandPlan', () => {
  test('a project window gets its command as before', () => {
    expect(commandPlan('close-tab', 1, view())).toEqual({ send: [1], reveal: null, close: null });
    expect(commandPlan('open-palette', 5, view())).toEqual({ send: [5], reveal: null, close: null });
  });

  test("a pop-out: its tab's commands stay, moving it back docks, the rest goes to the project window", () => {
    expect(commandPlan('save', 2, view())).toEqual({ send: [2], reveal: null, close: null });
    expect(commandPlan('close-tab', 2, view())).toEqual({ send: [], reveal: null, close: 2 });
    expect(commandPlan('move-tab-back', 3, view())).toEqual({ send: [], reveal: null, close: 3 });
    expect(commandPlan('open-palette', 2, view())).toEqual({ send: [1], reveal: 1, close: null });
  });

  test("Save All: every window of the pop-out's project, nothing of another project", () => {
    expect(commandPlan('save-all', 3, view())).toEqual({ send: [1, 2, 3], reveal: null, close: null });
  });

  test("Save All from a project window reaches its pop-outs too (a dirty popped-out file is saved)", () => {
    expect(commandPlan('save-all', 1, view())).toEqual({ send: [1, 2, 3], reveal: null, close: null });
    expect(commandPlan('save-all', 4, view())).toEqual({ send: [4], reveal: null, close: null });
    expect(commandPlan('save-all', 5, view())).toEqual({ send: [5], reveal: null, close: null });
  });

  test('a pop-out whose project window is gone: a main command goes nowhere', () => {
    const v = view();
    v.projects.delete(1); v.kinds.delete(1);
    expect(commandPlan('open-palette', 2, v)).toEqual({ send: [], reveal: null, close: null });
  });
});
