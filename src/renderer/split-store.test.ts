import { beforeEach, describe, expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from './store';
import { flatten, isSplit, single } from './split';
import type { TabKey } from './tabs-model';

// Split view with tab groups in the store: each pane keeps its own tabs; closing,
// exiting and opening stay inside a pane; the strip order is the panes' tabs, left to right.

const term = (id: string, createdAt = 0, session = false): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: 'zsh', createdAt,
  session: session ? { state: 'waiting', unread: false } as unknown as TerminalInfo['session'] : null
});
const st = () => useApp.getState();
const tabs = () => st().split.panes.map((p) => p.tabs);
const fronts = () => st().split.panes.map((p) => p.front);
const focus = () => st().split.focus;

/** Every invariant at once: in split mode the order is the panes' tabs, the focused front is the active key, no key twice. */
function invariant() {
  const s = st().split;
  if (!isSplit(s)) { expect(s).toEqual(single()); return; }
  expect(st().tabOrder).toEqual(flatten(s));
  expect(s.panes[s.focus]!.front).toBe(st().activeKey());
  for (const p of s.panes) if (p.front !== null) expect(p.tabs).toContain(p.front);
  const all = flatten(s);
  expect(new Set(all).size).toBe(all.length);
  expect(s.focus).toBeGreaterThanOrEqual(0);
  expect(s.focus).toBeLessThan(s.panes.length);
}

beforeEach(() => useApp.setState({
  project: null, terminals: [], selectedId: null, activeTab: 'term', tabOrder: [], hidden: [], pins: [], openFiles: [], preview: null,
  pendingAnchor: null, review: null, servicesOpen: false, split: single(), toast: null, dirty: {}, tabDrag: null,
  settings: { ...useApp.getState().settings, previewTabs: true }
}));

/** Terminals a, b, c (oldest first); the first list selects c. */
function three() {
  st().setTerminals([term('a', 1), term('b', 2), term('c', 3)]);
}
/** a, b, c, then panes [a c | b] with the focus on b (b picked into the empty pane). */
function twoPanes() {
  three();
  st().splitRight();
  st().select('b');
  expect(tabs()).toEqual([['t:a', 't:c'], ['t:b']]);
}
/** Panes [c | b | a], focus on `f`. */
function triple(f: number) {
  twoPanes();
  st().splitRight();
  st().select('a');
  expect(tabs()).toEqual([['t:c'], ['t:b'], ['t:a']]);
  st().focusPane(f);
}

describe('the beta report', () => {
  test('a file opened in a pane and closed: the pane shows its session again, the split stays', () => {
    st().setTerminals([term('a', 1), term('b', 2)]);
    st().splitRight();
    st().select('a');
    expect(tabs()).toEqual([['t:b'], ['t:a']]);
    st().focusPane(0);
    st().openFile('/p/context.md', 'context.md', null, undefined, { preview: true });
    expect(tabs()).toEqual([['t:b', 'f:/p/context.md'], ['t:a']]);
    expect(st().activeKey()).toBe('f:/p/context.md');
    invariant();
    st().closeTab('/p/context.md');
    expect(isSplit(st().split)).toBe(true);
    expect(tabs()).toEqual([['t:b'], ['t:a']]);
    expect(focus()).toBe(0);
    expect(st().activeKey()).toBe('t:b');
    invariant();
  });
});

describe('split right and the empty pane', () => {
  test('⌘\\: the tabs stay left, an empty focused pane on the right; the selection is cleared', () => {
    three();
    st().splitRight();
    expect(tabs()).toEqual([['t:a', 't:b', 't:c'], []]);
    expect(fronts()).toEqual(['t:c', null]);
    expect(focus()).toBe(1);
    expect(st().selectedId).toBeNull();
    expect(st().activeKey()).toBeNull();
    invariant();
  });
  test('a sidebar pick of a tab that is not in front anywhere moves it into the empty pane', () => {
    twoPanes();
    expect(fronts()).toEqual(['t:c', 't:b']);
    invariant();
  });
  test('a sidebar pick of another pane\'s front only moves the focus there; the empty pane stays', () => {
    three();
    st().splitRight();
    st().select('c');
    expect(tabs()).toEqual([['t:a', 't:b', 't:c'], []]);
    expect(focus()).toBe(0);
    invariant();
  });
  test('a hidden terminal selected while the empty pane is focused: its tab comes back there', () => {
    three();
    void st().closeTabs(['t:b']);
    expect(st().hidden).toEqual(['b']);
    st().splitRight();
    st().select('b');
    expect(st().hidden).toEqual([]);
    expect(tabs()).toEqual([['t:a', 't:c'], ['t:b']]);
    invariant();
  });
  test('a terminal list never fills the empty pane: a new terminal waits in the nearest pane with tabs', () => {
    three();
    st().splitRight();
    st().setTerminals([term('a', 1), term('b', 2), term('c', 3), term('d', 4)]);
    expect(st().selectedId).toBeNull();
    expect(tabs()).toEqual([['t:a', 't:b', 't:c', 't:d'], []]);
    expect(fronts()).toEqual(['t:c', null]);
    invariant();
  });
});

describe('where things open', () => {
  test('a key in another pane: the focus goes there and it comes to its front; nothing moves', () => {
    twoPanes();
    st().openFile('/p/x.ts', 'x.ts');
    expect(tabs()).toEqual([['t:a', 't:c'], ['t:b', 'f:/p/x.ts']]);
    st().focusPane(0);
    st().select('b');
    expect(focus()).toBe(1);
    expect(fronts()).toEqual(['t:c', 't:b']);
    expect(tabs()).toEqual([['t:a', 't:c'], ['t:b', 'f:/p/x.ts']]);
    invariant();
  });
  test('a key in no pane opens in the focused pane, after its front', () => {
    twoPanes();
    st().focusPane(0);
    st().openServices();
    expect(tabs()).toEqual([['t:a', 't:c', 'services'], ['t:b']]);
    expect(st().activeKey()).toBe('services');
    invariant();
  });
  test('a new terminal arriving unselected joins the focused pane behind its front', () => {
    twoPanes();
    st().setTerminals([term('a', 1), term('b', 2), term('c', 3), term('d', 4)]);
    expect(tabs()).toEqual([['t:a', 't:c'], ['t:b', 't:d']]);
    expect(st().activeKey()).toBe('t:b');
    invariant();
  });
  test('opened(): a terminal just launched opens in the focused pane, in front', () => {
    twoPanes();
    st().opened(term('n', 9));
    expect(tabs()).toEqual([['t:a', 't:c'], ['t:b', 't:n']]);
    expect(st().activeKey()).toBe('t:n');
    invariant();
  });
});

describe('closing and exiting stay in their pane', () => {
  test('the focused pane\'s last tab closes: its pane closes, the focus goes left', () => {
    triple(2);
    st().closeTab('t:a');
    expect(tabs()).toEqual([['t:c'], ['t:b']]);
    expect(focus()).toBe(1);
    expect(st().activeKey()).toBe('t:b');
    invariant();
  });
  test('closing the focused front shows its own pane\'s previous tab, even when another pane\'s tab was used more recently', () => {
    twoPanes();
    st().focusPane(0);
    st().openFile('/p/x.ts', 'x.ts');
    st().activate('t:c');
    st().focusPane(1);
    st().activate('f:/p/x.ts');
    expect(focus()).toBe(0);
    st().closeTab('/p/x.ts');
    expect(focus()).toBe(0);
    expect(st().activeKey()).toBe('t:c');
    invariant();
  });
  test('the last tab of an unfocused pane closes: that pane closes, the focus stays on the same pane', () => {
    triple(0);
    st().closeTab('t:a');
    expect(tabs()).toEqual([['t:c'], ['t:b']]);
    expect(focus()).toBe(0);
    invariant();
  });
  test('Review Focus 1: an unfocused pane\'s front exits; that pane shows its previous tab, the focus stays', () => {
    twoPanes();
    st().openFile('/p/x.ts', 'x.ts');
    st().select('b');
    st().focusPane(0);
    expect(fronts()).toEqual(['t:c', 't:b']);
    st().setTerminals([term('a', 1), term('c', 3)]);
    expect(tabs()).toEqual([['t:a', 't:c'], ['f:/p/x.ts']]);
    expect(fronts()).toEqual(['t:c', 'f:/p/x.ts']);
    expect(focus()).toBe(0);
    expect(st().activeKey()).toBe('t:c');
    invariant();
  });
  test('the focused pane\'s front exits: that pane shows its previous tab', () => {
    twoPanes();
    st().openFile('/p/x.ts', 'x.ts');
    st().select('b');
    st().setTerminals([term('a', 1), term('c', 3)]);
    expect(fronts()).toEqual(['t:c', 'f:/p/x.ts']);
    expect(focus()).toBe(1);
    expect(st().activeKey()).toBe('f:/p/x.ts');
    expect(['a', 'c']).toContain(st().selectedId === null ? 'a' : st().selectedId);
    invariant();
  });
  test('two panes\' terminals exit in one list (the focused one among them): both panes go at once', () => {
    triple(2);
    st().setTerminals([term('c', 3), term('d', 4)]);
    expect(isSplit(st().split)).toBe(false);
    expect(st().tabOrder).toEqual(['t:c', 't:d']);
    expect(st().activeKey()).toBe('t:c');
    expect(st().pendingAnchor).toBeNull();
    invariant();
  });
  test('closing a tab that is not in front keeps everything else where it is', () => {
    twoPanes();
    st().focusPane(0);
    st().closeTab('t:a');
    expect(tabs()).toEqual([['t:c'], ['t:b']]);
    expect(st().activeKey()).toBe('t:c');
    invariant();
  });
  test('a file trashed: it leaves its pane (the pane closes if it was alone there)', () => {
    twoPanes();
    st().openFile('/p/x.ts', 'x.ts');
    st().dropOpenFiles('/p/x.ts');
    expect(tabs()).toEqual([['t:a', 't:c'], ['t:b']]);
    expect(st().activeKey()).toBe('t:b');
    st().focusPane(0);
    st().openFile('/p/y.ts', 'y.ts');
    st().moveTabStep(1);
    expect(tabs()).toEqual([['t:a', 't:c'], ['t:b', 'f:/p/y.ts']]);
    invariant();
  });
  test('a renamed file keeps its pane', () => {
    twoPanes();
    st().openFile('/p/x.ts', 'x.ts');
    st().focusPane(0);
    st().renameOpenFiles('/p/x.ts', '/p/z.ts', '/p');
    expect(tabs()).toEqual([['t:a', 't:c'], ['t:b', 'f:/p/z.ts']]);
    invariant();
  });
  test('a dragged tab that leaves the strip (closed, its terminal exited) ends the drag: no stuck drop layer', () => {
    three();
    st().setTabDrag('t:b');
    st().closeTab('t:b');
    expect(st().tabDrag).toBeNull();
    st().setTabDrag('t:a');
    st().setTerminals([term('c', 3)]);
    expect(st().tabDrag).toBeNull();
    st().setTabDrag('t:c');
    st().setTerminals([term('c', 3), term('d', 4)]);
    expect(st().tabDrag).toBe('t:c');
    st().setTabDrag(null);
  });
});

describe('preview tabs (one per window, replaced only in the focused pane)', () => {
  test('C1: a preview alone in its pane replaced by the next preview keeps the split (a second click in Changes)', () => {
    three();
    st().splitRight();
    st().openFile('/p/x.ts', 'x.ts', null, undefined, { preview: true });
    expect(tabs()).toEqual([['t:a', 't:b', 't:c'], ['f:/p/x.ts']]);
    st().openFile('/p/y.ts', 'y.ts', null, undefined, { preview: true });
    expect(tabs()).toEqual([['t:a', 't:b', 't:c'], ['f:/p/y.ts']]);
    expect(focus()).toBe(1);
    expect(st().preview).toBe('/p/y.ts');
    invariant();
  });
  test('a preview in another pane stays open when a new preview opens in the focused pane', () => {
    st().setTerminals([term('a', 1)]);
    st().openFile('/p/x.ts', 'x.ts', null, undefined, { preview: true });
    st().splitRight();
    st().select('a');
    expect(tabs()).toEqual([['f:/p/x.ts'], ['t:a']]);
    expect(st().preview).toBe('/p/x.ts');
    st().openFile('/p/y.ts', 'y.ts', null, undefined, { preview: true });
    expect(tabs()).toEqual([['f:/p/x.ts'], ['t:a', 'f:/p/y.ts']]);
    expect(st().openFiles.map((f) => f.path)).toEqual(['/p/x.ts', '/p/y.ts']);
    expect(st().preview).toBe('/p/y.ts');
    invariant();
    // The focused pane's own preview is replaced in place, as with one pane.
    st().openFile('/p/z.ts', 'z.ts', null, undefined, { preview: true });
    expect(tabs()).toEqual([['f:/p/x.ts'], ['t:a', 'f:/p/z.ts']]);
    invariant();
  });
});

describe('pane commands', () => {
  test('a fourth pane is refused with a toast', () => {
    triple(2);
    st().splitRight();
    expect(st().split.panes).toHaveLength(3);
    expect(st().toast?.text).toBe('Up to three panes side by side');
  });
  test('moveTabToPane: to the end of that pane, in front, focused; the source shows its previous tab', () => {
    twoPanes();
    st().focusPane(0);
    st().moveTabToPane('t:a', 1, null);
    expect(tabs()).toEqual([['t:c'], ['t:b', 't:a']]);
    expect(fronts()).toEqual(['t:c', 't:a']);
    expect(focus()).toBe(1);
    invariant();
  });
  test('moveTabStep: ⌃⌘→ in one pane splits the tab out; ⌃⌘← brings it back and the emptied pane closes', () => {
    three();
    st().moveTabStep(1);
    expect(tabs()).toEqual([['t:a', 't:b'], ['t:c']]);
    expect(focus()).toBe(1);
    invariant();
    st().moveTabStep(-1);
    expect(st().split).toEqual(single());
    expect(st().tabOrder).toEqual(['t:a', 't:b', 't:c']);
    expect(st().activeKey()).toBe('t:c');
  });
  test('moveTabSide (⌥-click, the tab menu): any tab to the neighbour\'s end, or a new pane at the edge', () => {
    twoPanes();
    st().moveTabSide('t:a', 1);
    expect(tabs()).toEqual([['t:c'], ['t:b', 't:a']]);
    expect(fronts()).toEqual(['t:c', 't:a']);
    expect(focus()).toBe(1);
    st().moveTabSide('t:a', 1);
    expect(tabs()).toEqual([['t:c'], ['t:b'], ['t:a']]);
    expect(focus()).toBe(2);
    st().moveTabSide('t:c', -1);
    expect(tabs()).toEqual([['t:c'], ['t:b'], ['t:a']]);
    invariant();
  });
  test('moveTabStep with nowhere to go does nothing', () => {
    st().setTerminals([term('a', 1)]);
    st().moveTabStep(1);
    expect(st().split).toEqual(single());
    expect(st().tabOrder).toEqual(['t:a']);
  });
  test('Unsplit (closePane): its tabs join the neighbour after its tabs; the neighbour\'s front stays; nothing closes', () => {
    twoPanes();
    st().closePane(1);
    expect(st().split).toEqual(single());
    expect(st().tabOrder).toEqual(['t:a', 't:c', 't:b']);
    expect(st().activeKey()).toBe('t:c');
  });
  test('Unsplit All (closeOtherPanes): every tab in pane order; the focused front stays in front', () => {
    twoPanes();
    st().closeOtherPanes();
    expect(st().split).toEqual(single());
    expect(st().tabOrder).toEqual(['t:a', 't:c', 't:b']);
    expect(st().activeKey()).toBe('t:b');
  });
  test('⌘W on the focused empty pane closes it', () => {
    three();
    st().splitRight();
    st().closeTab();
    expect(st().split).toEqual(single());
    expect(st().activeKey()).toBe('t:c');
    expect(st().tabOrder).toEqual(['t:a', 't:b', 't:c']);
  });
  test('a strip reorder in split mode stays in its pane', () => {
    twoPanes();
    st().openFile('/p/x.ts', 'x.ts');
    st().moveTab('f:/p/x.ts', 't:b');
    expect(tabs()).toEqual([['t:a', 't:c'], ['f:/p/x.ts', 't:b']]);
    invariant();
  });
  test('a preview moved to another pane (⌃⌘, a menu, a drop) is kept open, as a strip drag keeps it', () => {
    st().setTerminals([term('a', 1)]);
    st().openFile('/p/x.ts', 'x.ts', null, undefined, { preview: true });
    expect(st().preview).toBe('/p/x.ts');
    st().moveTabStep(1);
    expect(tabs()).toEqual([['t:a'], ['f:/p/x.ts']]);
    expect(st().preview).toBeNull();
    st().openFile('/p/y.ts', 'y.ts', null, undefined, { preview: true });
    st().moveTabSide('f:/p/y.ts', -1);
    expect(st().preview).toBeNull();
    st().openFile('/p/z.ts', 'z.ts', null, undefined, { preview: true });
    st().moveTabToPane('f:/p/z.ts', 1, null);
    expect(st().preview).toBeNull();
    expect(tabs()).toEqual([['t:a', 'f:/p/y.ts'], ['f:/p/x.ts', 'f:/p/z.ts']]);
  });
  test('dropTab: another pane\'s middle moves it there (end); an edge makes a new pane; its own middle only activates it', () => {
    twoPanes();
    st().dropTab('t:a', 1, 'middle');
    expect(tabs()).toEqual([['t:c'], ['t:b', 't:a']]);
    st().dropTab('t:b', 1, 'right');
    expect(tabs()).toEqual([['t:c'], ['t:a'], ['t:b']]);
    st().dropTab('t:c', 0, 'middle');
    expect(tabs()).toEqual([['t:c'], ['t:a'], ['t:b']]);
    expect(st().activeKey()).toBe('t:c');
    invariant();
  });
  test('dropTab: a tab alone in its own pane dropped on that pane\'s edge does nothing', () => {
    twoPanes();
    st().dropTab('t:b', 1, 'left');
    expect(tabs()).toEqual([['t:a', 't:c'], ['t:b']]);
  });
});

describe('open to the side', () => {
  test('from one pane: the tab moves to a new pane on the right, focused', () => {
    three();
    st().openToSide('t:a');
    expect(tabs()).toEqual([['t:b', 't:c'], ['t:a']]);
    expect(focus()).toBe(1);
    expect(st().selectedId).toBe('a');
    invariant();
  });
  test('a hidden terminal gets its tab back, in the pane on the right', () => {
    three();
    void st().closeTabs(['t:a']);
    st().openToSide('t:a');
    expect(st().hidden).not.toContain('a');
    expect(tabs()).toEqual([['t:b', 't:c'], ['t:a']]);
    invariant();
  });
  test('a key in another pane only takes the focus there', () => {
    twoPanes();
    st().focusPane(0);
    st().openToSide('t:b');
    expect(tabs()).toEqual([['t:a', 't:c'], ['t:b']]);
    expect(focus()).toBe(1);
  });
  test('the focused pane\'s lone tab: nothing to split off', () => {
    twoPanes();
    st().openToSide('t:b');
    expect(tabs()).toEqual([['t:a', 't:c'], ['t:b']]);
    expect(focus()).toBe(1);
  });
  test('a file opens to the side as a normal tab (never the preview)', () => {
    three();
    st().openFileToSide('/p/x.ts', 'x.ts');
    expect(tabs()).toEqual([['t:a', 't:b', 't:c'], ['f:/p/x.ts']]);
    expect(fronts()).toEqual(['t:c', 'f:/p/x.ts']);
    expect(st().preview).toBeNull();
    invariant();
  });
});

describe('keys that walk the strip act on the focused pane\'s strip', () => {
  test('⌘1…9 and Ctrl+Tab read the focused pane\'s tabs', () => {
    twoPanes();
    st().openFile('/p/x.ts', 'x.ts');
    expect(st().focusedStrip()).toEqual(['t:b', 'f:/p/x.ts']);
    st().focusPane(0);
    expect(st().focusedStrip()).toEqual(['t:a', 't:c']);
  });
  test('one pane: the whole strip', () => {
    three();
    expect(st().focusedStrip()).toEqual(['t:a', 't:b', 't:c']);
  });
});

describe('one pane is today\'s app', () => {
  test('closing a tab picks the neighbour tab as today; the pane commands do nothing', () => {
    three();
    st().focusNextPane();
    st().closePane();
    st().closeOtherPanes();
    expect(st().split).toEqual(single());
    expect(st().selectedId).toBe('c');
    st().closeTab();
    expect(st().activeKey()).toBe('t:b');
    expect(st().split).toEqual(single());
  });
  test('opening, selecting and closing never materialize a pane', () => {
    three();
    st().openFile('/p/x.ts', 'x.ts');
    st().select('a');
    void st().closeTabs(['f:/p/x.ts']);
    st().setTerminals([term('a', 1), term('c', 3)]);
    expect(st().split).toEqual(single());
    expect(st().tabOrder).toEqual(['t:a', 't:c']);
  });
});
