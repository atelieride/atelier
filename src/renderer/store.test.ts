import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useApp } from './store';
import { isPending } from './comments';
import type { TerminalInfo } from '@shared/protocol';
import type { ConnectorInfo } from '@shared/tasks';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { flatten, isSplit, single } from './split';
import { closingKeys, type TabKey } from './tabs-model';
import { dbTabKey, type DbTabRef } from './databases/tabs';
import { useDb } from './databases/store';
import type { WorkspacesState } from './workspaces';
import { askCloseWorkspace } from './workspace-menus';
import { emptyViews } from './spaces';

const term = (id: string): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: 'zsh', createdAt: 0, session: null });

beforeEach(() => useApp.setState({ terminals: [], selectedId: null }));

test('the first list selects the most recent terminal', () => {
  useApp.getState().setTerminals([term('a'), term('b')]);
  expect(useApp.getState().selectedId).toBe('b');
});
test('the selection stays if the terminal still exists', () => {
  useApp.getState().setTerminals([term('a'), term('b')]);
  useApp.getState().select('a');
  useApp.getState().setTerminals([term('a'), term('b'), term('c')]);
  expect(useApp.getState().selectedId).toBe('a');
});
test('if the selected one disappears, switch to the most recent remaining, or to none', () => {
  useApp.getState().setTerminals([term('a'), term('b')]);
  useApp.getState().select('b');
  useApp.getState().setTerminals([term('a')]);
  expect(useApp.getState().selectedId).toBe('a');
  useApp.getState().setTerminals([]);
  expect(useApp.getState().selectedId).toBeNull();
});

test('a recent file gone from disk (deleted outside Atelier) drops out of the palette recents', () => {
  useApp.setState({ recentFiles: [{ path: '/p/a.ts', rel: 'a.ts' }, { path: '/p/b.ts', rel: 'b.ts' }] });
  useApp.getState().forgetRecent('/p/a.ts');
  expect(useApp.getState().recentFiles).toEqual([{ path: '/p/b.ts', rel: 'b.ts' }]);
});

test('an image read from Claude\'s temp folder is remembered for its tab, and forgotten when it no longer is', () => {
  useApp.setState({ claudeTemp: {} });
  useApp.getState().setClaudeTemp('/t/a.png', true);
  expect(useApp.getState().claudeTemp).toEqual({ '/t/a.png': true });
  const same = useApp.getState().claudeTemp;
  useApp.getState().setClaudeTemp('/t/a.png', true);
  // No new object when nothing changes: tabs don't re-render on every read.
  expect(useApp.getState().claudeTemp).toBe(same);
  useApp.getState().setClaudeTemp('/t/a.png', false);
  expect(useApp.getState().claudeTemp).toEqual({});
});

test('Changes: a group toggles alone, ⌥ toggles every group of the grouping, expanded rows flip', () => {
  useApp.setState({ changesCollapsed: [], changesExpanded: false });
  const keys = ['repo:/a', 'repo:/b'];
  useApp.getState().toggleChangesGroup('repo:/a');
  expect(useApp.getState().changesCollapsed).toEqual(['repo:/a']);
  useApp.getState().toggleChangesGroup('repo:/b', keys);
  expect(useApp.getState().changesCollapsed).toEqual(keys);
  useApp.getState().toggleChangesGroup('repo:/b', keys);
  expect(useApp.getState().changesCollapsed).toEqual([]);
  useApp.getState().toggleChangesExpanded();
  expect(useApp.getState().changesExpanded).toBe(true);
  useApp.getState().toggleChangesExpanded();
  expect(useApp.getState().changesExpanded).toBe(false);
});

test('Changes: the grouping is saved with the other prefs, so By session survives a restart', () => {
  const saved = new Map<string, string>();
  const prev = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
  try {
    useApp.setState({ changesGroup: 'repo', changesCollapsed: ['repo:/a'], changesExpanded: true });
    useApp.getState().setChangesGroup('session');
    expect(useApp.getState().changesGroup).toBe('session');
    expect(JSON.parse(saved.get('atelier.changesPrefs')!)).toEqual({ compact: false, collapsed: ['repo:/a'], grouping: 'session' });
    useApp.getState().toggleChangesExpanded();
    expect(JSON.parse(saved.get('atelier.changesPrefs')!).grouping).toBe('session');
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = prev;
  }
});

test('pins: loaded per project, toggled and saved, pruned only by a non-empty terminal list once the resumables are known', () => {
  const saved = new Map<string, string>([['atelier.pins', JSON.stringify({ '/p': ['b', 'gone'], '/other': ['x'] })]]);
  const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
  const prev = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  try {
    useApp.setState({ pins: [], resumablesKnown: false });
    useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
    expect(useApp.getState().pins).toEqual(['b', 'gone']);
    // Not arrived yet (empty list): nothing is dropped.
    useApp.getState().setTerminals([]);
    expect(useApp.getState().pins).toEqual(['b', 'gone']);
    useApp.getState().setTerminals([term('a'), term('b'), term('c')]);
    // "gone" may be waiting in To resume: kept until atelierd's resumables say otherwise.
    expect(useApp.getState().pins).toEqual(['b', 'gone']);
    useApp.getState().setResumables([]);
    expect(useApp.getState().pins).toEqual(['b']);
    expect(JSON.parse(saved.get('atelier.pins')!)).toEqual({ '/other': ['x'], '/p': ['b'] });
    useApp.getState().togglePinned('a');
    expect(useApp.getState().pins).toEqual(['b', 'a']);
    useApp.getState().togglePinned('b');
    expect(useApp.getState().pins).toEqual(['a']);
    expect(JSON.parse(saved.get('atelier.pins')!)['/p']).toEqual(['a']);
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = prev;
  }
});

test('closing a file opened from a tab goes back to that tab, not to the neighbor on the right', () => {
  const file = (path: string) => ({ path, rel: path.slice(3), line: null, nonce: 1, mode: 'margin' as const });
  useApp.getState().setTerminals([term('a'), term('b')]);
  useApp.setState({ openFiles: [], tabOrder: ['t:a', 't:b'], activeTab: 'term', selectedId: 'a' });
  // Opened from t:a: the file lands right after it, before t:b.
  useApp.setState({ openFiles: [file('/p/new.ts')], tabOrder: ['t:a', 'f:/p/new.ts', 't:b'], activeTab: '/p/new.ts' });
  useApp.getState().closeTab();
  expect(useApp.getState().activeKey()).toBe('t:a');
  // From t:b, through a second file, to a third one: closing them unwinds the way back.
  useApp.getState().activate('t:b');
  useApp.setState({ openFiles: [file('/p/one.ts'), file('/p/two.ts')], tabOrder: ['t:a', 't:b', 'f:/p/one.ts', 'f:/p/two.ts'], activeTab: '/p/one.ts' });
  useApp.setState({ activeTab: '/p/two.ts' });
  useApp.getState().closeTab();
  expect(useApp.getState().activeKey()).toBe('f:/p/one.ts');
  useApp.getState().closeTab();
  expect(useApp.getState().activeKey()).toBe('t:b');
});

test('the active terminal exiting with others in the same list: back to the most recent surviving tab', () => {
  useApp.getState().setTerminals([term('a'), term('b'), term('c'), term('d')]);
  useApp.setState({ openFiles: [], tabOrder: ['t:a', 't:b', 't:c', 't:d'] });
  for (const id of ['d', 'c', 'b', 'a']) useApp.getState().activate(`t:${id}`);
  // a (in front) and b (used just before it) exit together: c was used before them.
  useApp.getState().setTerminals([term('c'), term('d')]);
  expect(useApp.getState().activeKey()).toBe('t:c');
});

test('the new-session sheet and the folder sheet replace each other (one top sheet at a time)', () => {
  useApp.getState().setNewSessionOpen(true);
  useApp.getState().setFolderSheet({ kind: 'terminal' });
  expect(useApp.getState().newSessionOpen).toBe(false);
  expect(useApp.getState().folderSheet).toEqual({ kind: 'terminal' });
  useApp.getState().setNewSessionOpen(true);
  expect(useApp.getState().folderSheet).toBeNull();
  useApp.getState().setFolderSheet({ kind: 'session', cwd: '/p/api' });
  expect(useApp.getState().newSessionOpen).toBe(false);
  useApp.getState().setFolderSheet(null);
  expect(useApp.getState().folderSheet).toBeNull();
});

test('a Source Control view picked before the project is known survives the project loading, and is saved with it', () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  try {
    useApp.setState({ project: null, scmView: 'one' });
    // The sidebar can show its switch before the window's project arrives (main lists the entries at once).
    useApp.getState().setScmView('all');
    useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
    expect(useApp.getState().scmView).toBe('all');
    useApp.setState({ scmView: 'one' });
    useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
    expect(useApp.getState().scmView).toBe('all');
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    useApp.setState({ project: null, scmView: 'one' });
  }
});

describe('a terminal shown from the create reply, before the daemon list', () => {
  const reset = () => useApp.setState({ terminals: [], selectedId: null, activeTab: 'term', tabOrder: [], pendingAnchor: null, project: { root: '/p', name: 'p', realRoot: '/p' } });
  const ids = () => useApp.getState().terminals.map((t) => t.id);
  beforeEach(reset);

  test('reply then list: one entry, the tab next to the active one, stable when the list arrives', () => {
    useApp.getState().setTerminals([term('a'), term('b')]);
    useApp.getState().select('a');
    useApp.getState().opened(term('c'));
    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(useApp.getState().tabOrder).toEqual(['t:a', 't:c', 't:b']);
    expect(useApp.getState().selectedId).toBe('c');
    expect(useApp.getState().activeTab).toBe('term');
    useApp.getState().setTerminals([term('a'), term('b'), term('c')]);
    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(useApp.getState().tabOrder).toEqual(['t:a', 't:c', 't:b']);
    expect(useApp.getState().selectedId).toBe('c');
    expect(useApp.getState().pendingAnchor).toBeNull();
  });

  test('list then reply: same result', () => {
    useApp.getState().setTerminals([term('a'), term('b')]);
    useApp.getState().select('a');
    useApp.getState().setTerminals([term('a'), term('b'), term('c')]);
    useApp.getState().opened(term('c'));
    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(useApp.getState().tabOrder).toEqual(['t:a', 't:c', 't:b']);
    expect(useApp.getState().selectedId).toBe('c');
    expect(useApp.getState().pendingAnchor).toBeNull();
  });

  test('next to the active file tab, as before', () => {
    useApp.getState().setTerminals([term('a')]);
    useApp.setState({ openFiles: [{ path: '/p/x.ts', rel: 'x.ts', line: null, nonce: 1, mode: 'margin' }], tabOrder: ['t:a', 'f:/p/x.ts'], activeTab: '/p/x.ts' });
    useApp.getState().opened(term('c'));
    expect(useApp.getState().tabOrder).toEqual(['t:a', 'f:/p/x.ts', 't:c']);
    expect(useApp.getState().activeTab).toBe('term');
    useApp.getState().setTerminals([term('a'), term('c')]);
    expect(useApp.getState().tabOrder).toEqual(['t:a', 'f:/p/x.ts', 't:c']);
  });

  test('a terminal of another project is ignored', () => {
    useApp.getState().setTerminals([term('a')]);
    useApp.getState().opened({ ...term('z'), projectRoot: '/q' });
    expect(ids()).toEqual(['a']);
    expect(useApp.getState().selectedId).toBe('a');
  });
});

describe('notification center', () => {
  const entry = (id: string, sessions: string[], at = 1) => ({ id, at, kind: 'done', sessions: sessions.map((s) => ({ id: s, title: s, color: '#fff' })), activity: null, unseen: sessions });
  beforeEach(() => useApp.setState({ notes: [], notesOpen: false, project: null, selectedId: null, activeTab: 'term' }));

  test('entries from main are checked, newest first; broken ones are dropped', () => {
    useApp.getState().receiveNotes([entry('a', ['s1'], 1), { junk: true }, entry('b', ['s2'], 2)]);
    expect(useApp.getState().notes.map((x) => x.id)).toEqual(['b', 'a']);
    useApp.getState().receiveNotes('nonsense');
    expect(useApp.getState().notes).toHaveLength(2);
  });

  test('an entry for the session you are looking at arrives read', () => {
    useApp.getState().receiveNotes([entry('a', ['s1'])], 's1');
    expect(useApp.getState().notes[0]!.unseen).toEqual([]);
  });

  test('viewing a session, opening an entry, mark all as read, clear', () => {
    useApp.getState().receiveNotes([entry('g', ['s1', 's2'], 3), entry('one', ['s1'], 2), entry('x', ['s3'], 1)]);
    useApp.getState().notesSeen('s1');
    expect(useApp.getState().notes.map((x) => x.unseen)).toEqual([['s2'], [], ['s3']]);
    useApp.getState().noteOpened('g');
    expect(useApp.getState().notes[0]!.unseen).toEqual([]);
    useApp.getState().markAllNotesRead();
    expect(useApp.getState().notes.every((x) => x.unseen.length === 0)).toBe(true);
    useApp.getState().clearNotes();
    expect(useApp.getState().notes).toEqual([]);
  });

  test('a session that is gone is no longer unseen: the bell count never stays stale', () => {
    useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, terminals: [], tabOrder: [] });
    useApp.getState().receiveNotes([entry('g', ['s1', 's2'], 3), entry('x', ['s3'], 1)]);
    useApp.getState().setTerminals([term('s1')]);
    expect(useApp.getState().notes.map((x) => x.unseen)).toEqual([['s1'], []]);
  });

  test('trigger matches: an entry through the same path, filter, clear and mark read act on what is shown', () => {
    useApp.setState({ terminals: [term('t1')], selectedId: 't1', activeTab: 'files' });
    useApp.getState().receiveNotes([entry('d', ['s1'], 1)]);
    const added = useApp.getState().addTriggerNote('t1', 'tests failed', '3 tests failed');
    expect(added).toBe(true);
    const [first] = useApp.getState().notes;
    expect(first).toMatchObject({ kind: 'trigger', trigger: 'tests failed', activity: '3 tests failed', sessions: [{ id: 't1', title: 't1' }], unseen: ['t1'] });
    // A terminal that is not in the window: nothing.
    expect(useApp.getState().addTriggerNote('ghost', 'x', 'y')).toBe(false);
    expect(useApp.getState().notes).toHaveLength(2);

    useApp.getState().setNotesOpen(true, 'triggers');
    expect(useApp.getState().notesFilter).toBe('triggers');
    useApp.getState().markAllNotesRead();
    expect(useApp.getState().notes.map((x) => [x.kind, x.unseen.length])).toEqual([['trigger', 0], ['done', 1]]);
    useApp.getState().clearNotes();
    expect(useApp.getState().notes.map((x) => x.kind)).toEqual(['done']);
    // The bell opens everything again.
    useApp.getState().setNotesOpen(false);
    useApp.getState().setNotesOpen(true);
    expect(useApp.getState().notesFilter).toBe('all');
    useApp.getState().setNotesFilter('triggers');
    expect(useApp.getState().notesFilter).toBe('triggers');
  });

  test('the popover toggles and closes the other floating things', () => {
    useApp.setState({ paletteOpen: true });
    useApp.getState().setNotesOpen(true);
    expect(useApp.getState().notesOpen).toBe(true);
    expect(useApp.getState().paletteOpen).toBe(false);
    useApp.getState().setNotesOpen(!useApp.getState().notesOpen);
    expect(useApp.getState().notesOpen).toBe(false);
  });
});

test('group by state toggles on and off', () => {
  useApp.setState({ groupByState: false });
  useApp.getState().toggleGroupByState();
  expect(useApp.getState().groupByState).toBe(true);
  useApp.getState().toggleGroupByState();
  expect(useApp.getState().groupByState).toBe(false);
});

describe('review tab', () => {
  beforeEach(() => useApp.setState({ terminals: [term('a'), term('b')], selectedId: 'a', activeTab: 'term', tabOrder: ['t:a', 't:b'], openFiles: [], review: null, servicesOpen: false }));
  test('opens next to the active tab, active; asking again changes its scope, never a second tab', () => {
    useApp.getState().openReview('b');
    expect(useApp.getState().tabOrder).toEqual(['t:a', 'review', 't:b']);
    expect(useApp.getState().activeTab).toBe('review');
    expect(useApp.getState().activeKey()).toBe('review');
    expect(useApp.getState().review?.scope).toBe('b');
    useApp.getState().select('b');
    useApp.getState().openReview('all');
    expect(useApp.getState().tabOrder).toEqual(['t:a', 'review', 't:b']);
    expect(useApp.getState().review?.scope).toBe('all');
    expect(useApp.getState().activeKey()).toBe('review');
  });
  test('activating, closing (by key and with others), and a terminal list while it is active', () => {
    useApp.getState().openReview('all');
    useApp.getState().setTerminals([term('a'), term('b')]);
    expect(useApp.getState().activeTab).toBe('review');
    useApp.getState().activate('t:b');
    expect(useApp.getState().activeTab).toBe('term');
    useApp.getState().activate('review');
    expect(useApp.getState().activeTab).toBe('review');
    useApp.getState().closeTab('review');
    expect(useApp.getState().tabOrder).toEqual(['t:a', 't:b']);
    expect(useApp.getState().review).toBeNull();
    expect(useApp.getState().activeKey()).toBe('t:b');
    useApp.getState().openReview('all');
    useApp.getState().closeTab();
    expect(useApp.getState().review).toBeNull();
  });
  test('closeTabs with the review among them', async () => {
    useApp.getState().openReview('all');
    await useApp.getState().closeTabs(['review']);
    expect(useApp.getState().tabOrder).toEqual(['t:a', 't:b']);
    expect(useApp.getState().review).toBeNull();
    expect(useApp.getState().activeTab).toBe('term');
  });
  test('against main is remembered as a preference and kept across scopes', () => {
    useApp.getState().openReview('all');
    useApp.getState().setReviewAgainstMain(true);
    expect(useApp.getState().reviewAgainstMain).toBe(true);
    useApp.getState().openReview('a');
    expect(useApp.getState().reviewAgainstMain).toBe(true);
    useApp.getState().setReviewAgainstMain(false);
  });
});

describe('line comments', () => {
  const draft = { path: '/p/a.ts', start: 2, end: 3, snippet: 'b\nc', target: 't1' };
  beforeEach(() => useApp.setState({ comments: [], commentDraft: null, project: null }));
  test('add, edit, delete; removed ones can be restored (Undo) in their place', () => {
    const id = useApp.getState().addComment({ ...draft, text: 'First' });
    const id2 = useApp.getState().addComment({ ...draft, start: 9, end: 9, snippet: 'x', text: 'Second' });
    expect(useApp.getState().comments.map((c) => c.text)).toEqual(['First', 'Second']);
    useApp.getState().updateComment(id, { text: 'Changed', target: 't2' });
    expect(useApp.getState().comments[0]).toMatchObject({ id, text: 'Changed', target: 't2' });
    const removed = useApp.getState().removeComments([id]);
    expect(removed.map((c) => c.id)).toEqual([id]);
    expect(useApp.getState().comments.map((c) => c.id)).toEqual([id2]);
    useApp.getState().restoreComments(removed);
    expect(useApp.getState().comments.map((c) => c.id).sort()).toEqual([id, id2].sort());
    useApp.getState().deleteComment(id2);
    expect(useApp.getState().comments.map((c) => c.id)).toEqual([id]);
  });
  test('kept per project (saved and loaded with it)', () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
    try {
      useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
      useApp.getState().addComment({ ...draft, text: 'Kept' });
      useApp.setState({ comments: [] });
      useApp.getState().setProject({ root: '/q', name: 'q', realRoot: '/q' });
      expect(useApp.getState().comments).toEqual([]);
      useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
      expect(useApp.getState().comments.map((c) => c.text)).toEqual(['Kept']);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
      useApp.setState({ project: null, comments: [] });
    }
  });
  test('one draft box at a time; the last Claude session selected is remembered for new comments', () => {
    useApp.getState().openCommentDraft({ ...draft, ambiguous: false });
    expect(useApp.getState().commentDraft).toMatchObject({ path: '/p/a.ts', start: 2 });
    useApp.getState().openCommentDraft({ ...draft, path: '/p/b.ts', ambiguous: true });
    expect(useApp.getState().commentDraft?.path).toBe('/p/b.ts');
    useApp.getState().closeCommentDraft();
    expect(useApp.getState().commentDraft).toBeNull();
    const claude = { ...term('c1'), session: { sessionId: 's', state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } } as TerminalInfo;
    useApp.setState({ terminals: [claude, term('sh')], lastSession: null });
    useApp.getState().select('c1');
    useApp.getState().select('sh');
    expect(useApp.getState().lastSession).toBe('c1');
  });
  test('a comment keeps at most 4 KB of its lines (plus a hash), and a full storage shows a toast once', () => {
    const id = useApp.getState().addComment({ ...draft, start: 1, end: 1000, snippet: 'y'.repeat(100000), text: 'Big' });
    const stored = useApp.getState().comments.find((c) => c.id === id)!;
    expect(stored.snippet.length).toBeLessThanOrEqual(4096);
    expect(stored.hash).toBeTruthy();
    const g = globalThis as { localStorage?: unknown };
    g.localStorage = { getItem: () => null, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
    try {
      useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, toast: null });
      useApp.getState().addComment({ ...draft, text: 'One' });
      expect(useApp.getState().toast?.text).toMatch(/not saved/i);
      useApp.setState({ toast: null });
      useApp.getState().addComment({ ...draft, text: 'Two' });
      expect(useApp.getState().toast).toBeNull();
      // Kept for this session all the same.
      expect(useApp.getState().comments.map((c) => c.text)).toEqual(['Big', 'One', 'Two']);
    } finally {
      delete g.localStorage;
      useApp.setState({ project: null, comments: [] });
    }
  });
  test('comments follow a renamed file or folder (even with no tab open)', () => {
    useApp.setState({ openFiles: [], recentFiles: [] });
    useApp.getState().addComment({ ...draft, path: '/p/src/a.ts', text: 'A' });
    useApp.getState().addComment({ ...draft, path: '/p/src/sub/b.ts', text: 'B' });
    useApp.getState().addComment({ ...draft, path: '/p/srcx/c.ts', text: 'C' });
    useApp.getState().renameOpenFiles('/p/src/a.ts', '/p/src/z.ts', '/p');
    useApp.getState().renameOpenFiles('/p/src', '/p/lib', '/p');
    expect(useApp.getState().comments.map((c) => c.path)).toEqual(['/p/lib/z.ts', '/p/lib/sub/b.ts', '/p/srcx/c.ts']);
  });
  test('comments on a trashed file are set aside ("File deleted"): not pending, not sent, until kept', () => {
    useApp.setState({ openFiles: [], recentFiles: [] });
    const a = useApp.getState().addComment({ ...draft, path: '/p/src/a.ts', text: 'A' });
    useApp.getState().addComment({ ...draft, path: '/p/other.ts', text: 'O' });
    useApp.getState().dropOpenFiles('/p/src');
    const byText = (x: string) => useApp.getState().comments.find((c) => c.text === x)!;
    expect(byText('A').gone).toBe(true);
    expect(byText('O').gone).toBeFalsy();
    expect(useApp.getState().comments.filter((c) => isPending(c, 't1')).map((c) => c.text)).toEqual(['O']);
    useApp.getState().keepComments([a]);
    expect(byText('A').gone).toBeFalsy();
  });
  test('what is being typed lives in the store (a redrawn box or card gets it back)', () => {
    useApp.getState().openCommentDraft({ ...draft, ambiguous: false });
    expect(useApp.getState().commentDraft?.text).toBe('');
    useApp.getState().updateCommentDraft({ text: 'Half a thought', target: 't2' });
    expect(useApp.getState().commentDraft).toMatchObject({ text: 'Half a thought', target: 't2', path: '/p/a.ts' });
    const id = useApp.getState().addComment({ ...draft, text: 'Saved' });
    useApp.getState().setCommentEdit(id, 'Saved, then');
    expect(useApp.getState().commentEdits[id]).toBe('Saved, then');
    useApp.getState().setCommentEdit(id, null);
    expect(id in useApp.getState().commentEdits).toBe(false);
    useApp.getState().setCommentEdit(id, 'again');
    useApp.getState().deleteComment(id);
    expect(id in useApp.getState().commentEdits).toBe(false);
  });
  test('a toast with an action (Undo after Send) is not replaced by a plain one during its 8 s: that one waits', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      useApp.getState().showToast('Sent', { label: 'Undo', run: () => {} });
      vi.setSystemTime(1_002_000);
      useApp.getState().showToast('Something else');
      expect(useApp.getState().toast?.text).toBe('Sent');
      // Closed (timer, click or Undo): the waiting one shows.
      useApp.getState().showToast(null);
      expect(useApp.getState().toast?.text).toBe('Something else');
      useApp.getState().showToast(null);
      expect(useApp.getState().toast).toBeNull();
      // Past its 8 s, a plain toast replaces it.
      useApp.getState().showToast('Sent', { label: 'Undo', run: () => {} });
      vi.setSystemTime(1_011_000);
      useApp.getState().showToast('Later');
      expect(useApp.getState().toast?.text).toBe('Later');
    } finally {
      vi.useRealTimers();
      useApp.getState().showToast(null);
    }
  });
  test('a toast is an error by default; an info toast keeps its tone, also when it waits behind an Undo toast', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      useApp.getState().showToast('Failed');
      expect(useApp.getState().toast?.tone).toBeUndefined();
      useApp.getState().showToast('Sent', { label: 'Undo', run: () => {} });
      vi.setSystemTime(1_001_000);
      useApp.getState().showToast('In the prompt', undefined, 'info');
      expect(useApp.getState().toast?.text).toBe('Sent');
      useApp.getState().showToast(null);
      expect(useApp.getState().toast).toMatchObject({ text: 'In the prompt', tone: 'info' });
    } finally {
      vi.useRealTimers();
      useApp.getState().showToast(null);
    }
  });
  test('a toast can carry an action (Undo)', () => {
    let undone = false;
    useApp.getState().showToast('Sent', { label: 'Undo', run: () => { undone = true; } });
    useApp.getState().toast?.action?.run();
    expect(undone).toBe(true);
    // Closed (as its button does), then a plain one.
    useApp.getState().showToast(null);
    useApp.getState().showToast('Plain');
    expect(useApp.getState().toast?.action).toBeUndefined();
  });
});

describe('connectors', () => {
  const card = (status: ConnectorInfo['status']): ConnectorInfo => ({ id: 'clickup', name: 'ClickUp', status, loading: false, tasksVersion: 0, options: { show: 'assigned', includeClosed: false } });
  const g = globalThis as { window?: unknown };
  let calls: string[] = [];
  let prevWindow: unknown;
  beforeEach(() => {
    calls = [];
    prevWindow = g.window;
    const record = (name: string) => (id: string) => { calls.push(`${name}:${id}`); return Promise.resolve(card('connecting')); };
    g.window = { atelier: { connectors: { connect: record('connect'), refresh: record('refresh') } } };
    useApp.setState({ connectors: [], connectorConfirm: null, connectorDetail: null, toast: null, settingsOpen: null });
  });
  afterEach(() => { g.window = prevWindow; useApp.getState().showToast(null); });

  test('setConnectors keeps the cards from main', () => {
    useApp.getState().setConnectors([card('connected')]);
    expect(useApp.getState().connectors.map((c) => c.status)).toEqual(['connected']);
  });

  test('one notice is one toast, with its way out as the action', () => {
    useApp.getState().connectorNotice({ id: 'clickup', kind: 'reconnect' });
    const toast = useApp.getState().toast!;
    expect(toast.text).toBe('ClickUp signed you out. Reconnect to see your tasks.');
    expect(toast.action?.label).toBe('Reconnect');
    toast.action!.run();
    expect(calls).toEqual(['connect:clickup']);
    // Like the palette's Reconnect: the card shows the countdown and Cancel while the browser is open.
    expect(useApp.getState().settingsOpen).toBe('connectors');
    // …on that connector's details page.
    expect(useApp.getState().connectorDetail).toBe('clickup');
  });

  test('a connector\'s details page: opened, back to the list, gone with its section', () => {
    useApp.getState().setSettingsOpen('connectors');
    expect(useApp.getState().connectorDetail).toBeNull();
    useApp.getState().openConnector('notion');
    expect(useApp.getState().connectorDetail).toBe('notion');
    // Asking for the same section again (the menu's Connectors… with it open) stays where it is.
    useApp.getState().setSettingsOpen('connectors');
    expect(useApp.getState().connectorDetail).toBe('notion');
    useApp.getState().openConnector(null);
    expect(useApp.getState().connectorDetail).toBeNull();
    useApp.getState().openConnector('clickup');
    useApp.getState().setSettingsOpen('about');
    expect(useApp.getState().connectorDetail).toBeNull();
    useApp.getState().setSettingsOpen('connectors');
    useApp.getState().openConnector('clickup');
    useApp.getState().setSettingsOpen(null);
    expect(useApp.getState().connectorDetail).toBeNull();
  });

  test('the Disconnect confirm lives on its details page: going back or to another connector drops it', () => {
    useApp.getState().setConnectors([card('connected')]);
    useApp.getState().setSettingsOpen('connectors');
    useApp.getState().openConnector('clickup');
    useApp.getState().setConnectorConfirm('clickup');
    useApp.getState().openConnector('clickup');
    expect(useApp.getState().connectorConfirm).toBe('clickup');
    useApp.getState().openConnector(null);
    expect(useApp.getState().connectorConfirm).toBeNull();
    useApp.getState().openConnector('clickup');
    useApp.getState().setConnectorConfirm('clickup');
    useApp.getState().openConnector('notion');
    expect(useApp.getState().connectorConfirm).toBeNull();
  });

  test('a confirm left open does not come back: leaving Connectors or closing Settings drops it', () => {
    useApp.getState().setConnectors([card('connected')]);
    useApp.getState().setSettingsOpen('connectors');
    useApp.getState().setConnectorConfirm('clickup');
    useApp.getState().setSettingsOpen('connectors');
    expect(useApp.getState().connectorConfirm).toBe('clickup');
    useApp.getState().setSettingsOpen('about');
    expect(useApp.getState().connectorConfirm).toBeNull();
    useApp.getState().setSettingsOpen('connectors');
    useApp.getState().setConnectorConfirm('clickup');
    useApp.getState().setSettingsOpen(null);
    expect(useApp.getState().connectorConfirm).toBeNull();
  });

  test('network → Retry signs in again; unavailable → Details opens Settings › Connectors; a plain one has no action', () => {
    useApp.getState().connectorNotice({ id: 'clickup', kind: 'network' });
    expect(useApp.getState().toast?.action?.label).toBe('Retry');
    useApp.getState().toast!.action!.run();
    expect(calls).toEqual(['connect:clickup']);
    useApp.getState().showToast(null);
    useApp.getState().connectorNotice({ id: 'clickup', kind: 'unavailable' });
    expect(useApp.getState().toast?.text).toBe("ClickUp isn't available right now.");
    useApp.getState().toast!.action!.run();
    expect(useApp.getState().settingsOpen).toBe('connectors');
    expect(useApp.getState().connectorDetail).toBe('clickup');
    useApp.getState().showToast(null);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 60_000);
      useApp.getState().connectorNotice({ id: 'clickup', kind: 'timeout' });
      expect(useApp.getState().toast).toMatchObject({ text: 'ClickUp connection timed out.' });
      expect(useApp.getState().toast?.action).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  test('the Disconnect confirm closes once there is nothing left to disconnect (e.g. from another window)', () => {
    useApp.getState().setConnectors([card('connected')]);
    useApp.getState().setConnectorConfirm('clickup');
    expect(useApp.getState().connectorConfirm).toBe('clickup');
    useApp.getState().setConnectors([card('offline')]);
    expect(useApp.getState().connectorConfirm).toBe('clickup');
    useApp.getState().setConnectors([card('disconnected')]);
    expect(useApp.getState().connectorConfirm).toBeNull();
  });
});

test('asking for the same palette query again is a new request (⌘⇧N with the palette already on resume:)', () => {
  useApp.getState().setPaletteOpen(true, 'resume:');
  const first = useApp.getState().paletteAsk;
  useApp.getState().setPaletteOpen(true, 'resume:');
  expect(useApp.getState().paletteAsk).not.toBe(first);
  expect(useApp.getState().paletteQuery).toBe('resume:');
});

describe('task links: per project, saved, pruned with the terminals, carried by a resume', () => {
  const link = (id: string) => ({ source: 'clickup' as const, taskId: id, displayId: `ENG-${id}`, title: `Task ${id}`, url: `https://app.clickup.com/t/${id}` });
  const g = globalThis as { localStorage?: unknown };
  let saved: Map<string, string>;
  beforeEach(() => {
    saved = new Map([['atelier.taskLinks', JSON.stringify({ '/p': { a: link('1'), gone: link('2') }, '/other': { x: link('3') } })]]);
    g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
    useApp.setState({ terminals: [], taskLinks: {}, project: null, layoutRestored: true, resumablesKnown: false });
  });
  afterEach(() => { delete g.localStorage; useApp.setState({ project: null, taskLinks: {} }); });
  const stored = () => (JSON.parse(saved.get('atelier.taskLinks')!) as Record<string, Record<string, unknown>>);

  test('loaded with the project; pruned only once terminals and resumables are known; link and unlink saved', () => {
    useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
    expect(Object.keys(useApp.getState().taskLinks)).toEqual(['a', 'gone']);
    // The terminals before the resumables (after an atelierd restart "gone" may be one): nothing dropped yet.
    useApp.getState().setTerminals([term('a'), term('b')]);
    expect(Object.keys(useApp.getState().taskLinks)).toEqual(['a', 'gone']);
    // A resumable session keeps its link.
    useApp.getState().setResumables([{ id: 'gone', projectRoot: '/p', cwd: '/p', title: 'g', color: '#fff', sessionId: 's', endedAt: 0 }]);
    expect(Object.keys(useApp.getState().taskLinks)).toEqual(['a', 'gone']);
    // Dismissed: gone for good.
    useApp.getState().setResumables([]);
    expect(Object.keys(useApp.getState().taskLinks)).toEqual(['a']);
    expect(Object.keys(stored()['/p']!)).toEqual(['a']);
    useApp.getState().linkTask('b', link('9'));
    expect(useApp.getState().taskLinks.b).toEqual(link('9'));
    expect(stored()['/p']!.b).toEqual(link('9'));
    useApp.getState().unlinkTask('a');
    expect(Object.keys(useApp.getState().taskLinks)).toEqual(['b']);
    expect(Object.keys(stored()['/p']!)).toEqual(['b']);
    // Another project's links are never touched.
    expect(stored()['/other']).toEqual({ x: link('3') });
  });

  test('a resumed session keeps its task: the link moves to the new terminal id', () => {
    useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
    useApp.getState().relinkTask('a', 'a2');
    expect(useApp.getState().taskLinks.a2).toEqual(link('1'));
    expect(useApp.getState().taskLinks.a).toBeUndefined();
    expect(stored()['/p']!.a2).toEqual(link('1'));
    // Nothing to move: nothing changes.
    const before = useApp.getState().taskLinks;
    useApp.getState().relinkTask('nope', 'x');
    expect(useApp.getState().taskLinks).toBe(before);
  });

  test('the task lists from main are kept for the palette and the chips', () => {
    const lists = [{ source: 'clickup' as const, status: 'connected' as const, loading: false, tasks: [] }];
    useApp.getState().setTaskLists(lists);
    expect(useApp.getState().taskLists).toBe(lists);
  });
});

describe('source control', () => {
  const entry = (root: string, rel: string) => ({ root, rel, name: rel || 'p', worktreeOf: null, nestedIn: null, common: `${root}/.git`, status: null });
  beforeEach(() => useApp.setState({ terminals: [term('a')], selectedId: 'a', activeTab: 'term', tabOrder: ['t:a'], openFiles: [], review: null, historyTab: null, revFiles: [], scmRepos: null, scmRepo: null, project: null }));

  test('the repos list keeps the selection while it is listed, else the root repo, else the first', () => {
    const st = useApp.getState();
    st.setScmRepos([entry('/p/apps/web', 'apps/web'), entry('/p', '')]);
    expect(useApp.getState().scmRepo).toBe('/p');
    st.selectScmRepo('/p/apps/web');
    st.setScmRepos([entry('/p/apps/web', 'apps/web'), entry('/p', '')]);
    expect(useApp.getState().scmRepo).toBe('/p/apps/web');
    st.setScmRepos([entry('/p/x', 'x'), entry('/p/y', 'y')]);
    expect(useApp.getState().scmRepo).toBe('/p/x');
    st.setScmRepos([]);
    expect(useApp.getState().scmRepo).toBeNull();
  });

  test('openHistory: one History tab, after the active one; again only focuses and retargets it', () => {
    const st = useApp.getState();
    st.setScmRepos([entry('/p', '')]);
    st.openHistory();
    expect(useApp.getState().tabOrder).toEqual(['t:a', 'history']);
    expect(useApp.getState().activeKey()).toBe('history');
    expect(useApp.getState().historyTab).toMatchObject({ repo: '/p', scope: { kind: 'refs', refs: 'all', firstParent: false } });
    st.activate('t:a');
    st.openHistory({ scope: { kind: 'refs', refs: 'refs/heads/main', firstParent: false } });
    expect(useApp.getState().tabOrder).toEqual(['t:a', 'history']);
    expect(useApp.getState().activeKey()).toBe('history');
    expect(useApp.getState().historyTab?.scope).toEqual({ kind: 'refs', refs: 'refs/heads/main', firstParent: false });
  });

  test('switching repositories retargets the History tab to all branches, keeping First parent', () => {
    const st = useApp.getState();
    st.setScmRepos([entry('/p', ''), entry('/p/web', 'web')]);
    st.openHistory({ scope: { kind: 'refs', refs: 'refs/heads/main', firstParent: true } });
    st.selectScmRepo('/p/web');
    expect(useApp.getState().historyTab).toMatchObject({ repo: '/p/web', scope: { kind: 'refs', refs: 'all', firstParent: true } });
  });

  test('closing the History tab clears it; ⌘W on it works like any tab', () => {
    const st = useApp.getState();
    st.setScmRepos([entry('/p', '')]);
    st.openHistory();
    st.closeTab();
    expect(useApp.getState().historyTab).toBeNull();
    expect(useApp.getState().tabOrder).toEqual(['t:a']);
    expect(useApp.getState().activeKey()).toBe('t:a');
    st.openHistory();
    void st.closeTabs(['history']);
  });

  test('a file at a commit opens once per commit and path, read-only, and closes without asking', async () => {
    const st = useApp.getState();
    const oid = 'a'.repeat(40);
    st.openRevFile({ root: '/p', oid, rel: 'src/a b.ts' });
    st.openRevFile({ root: '/p', oid, rel: 'src/a b.ts' });
    expect(useApp.getState().revFiles).toEqual([{ key: `rev:${oid}:src/a b.ts`, root: '/p', oid, rel: 'src/a b.ts' }]);
    expect(useApp.getState().activeKey()).toBe(`rev:${oid}:src/a b.ts`);
    expect(useApp.getState().tabOrder).toEqual(['t:a', `rev:${oid}:src/a b.ts`]);
    st.closeTab(`rev:${oid}:src/a b.ts`);
    expect(useApp.getState().revFiles).toEqual([]);
    expect(useApp.getState().activeKey()).toBe('t:a');
    st.openRevFile({ root: '/p', oid, rel: 'x.ts' });
    await st.closeTabs([`rev:${oid}:x.ts`]);
    expect(useApp.getState().revFiles).toEqual([]);
  });

  test('section collapse toggles', () => {
    const st = useApp.getState();
    useApp.setState({ scmCollapsed: [] });
    st.toggleScmSection('tags');
    expect(useApp.getState().scmCollapsed).toEqual(['tags']);
    st.toggleScmSection('tags');
    expect(useApp.getState().scmCollapsed).toEqual([]);
  });
});

describe('pins survive "To resume"', () => {
  const g = globalThis as { localStorage?: unknown; window?: unknown };
  let saved: Map<string, string>;
  const res = (id: string) => ({ id, projectRoot: '/p', cwd: '/p', title: id, color: '#fff', sessionId: `s-${id}`, endedAt: 0 });
  beforeEach(() => {
    saved = new Map([['atelier.pins', JSON.stringify({ '/p': ['a', 'b', 'c'] })]]);
    g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
    useApp.setState({ terminals: [], pins: [], resumables: [], resumablesKnown: false, project: null, layoutRestored: true });
  });
  afterEach(() => { delete g.localStorage; delete g.window; useApp.setState({ project: null, pins: [], resumables: [] }); });

  test('a resumable session keeps its pin while other terminals come and go; dismissing it drops the pin', () => {
    useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
    useApp.getState().setResumables([res('b')]);
    useApp.getState().setTerminals([term('a'), term('n')]);
    expect(useApp.getState().pins).toEqual(['a', 'b']);
    useApp.getState().setResumables([]);
    expect(useApp.getState().pins).toEqual(['a']);
  });

  test('terminals that arrive before the project prune no pin of a session waiting in To resume', () => {
    useApp.getState().setTerminals([term('a')]);
    useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
    expect(useApp.getState().pins).toEqual(['a', 'b', 'c']);
    useApp.getState().setResumables([res('b')]);
    expect(useApp.getState().pins).toEqual(['a', 'b']);
  });

  test('resuming moves the pin to the new terminal at the same place, even when the lists arrive before the reply', async () => {
    useApp.getState().setProject({ root: '/p', name: 'p', realRoot: '/p' });
    useApp.getState().setResumables([res('b')]);
    useApp.getState().setTerminals([term('a')]);
    let reply: (info: TerminalInfo) => void = () => {};
    g.window = { atelier: { terminals: { resume: vi.fn(() => new Promise<TerminalInfo>((r) => { reply = r; })) } } };
    const done = useApp.getState().resume('b');
    // atelierd's lists first: the resumable is gone and the new terminal runs, the reply still on its way.
    useApp.getState().setResumables([]);
    useApp.getState().setTerminals([term('a'), term('b2')]);
    expect(useApp.getState().pins).toEqual(['a', 'b']);
    reply(term('b2'));
    await done;
    expect(useApp.getState().pins).toEqual(['a', 'b2']);
    expect(JSON.parse(saved.get('atelier.pins')!)['/p']).toEqual(['a', 'b2']);
  });
});

describe('rename where it was asked', () => {
  beforeEach(() => useApp.setState({ terminals: [term('a'), term('b')], tabOrder: ['t:a'], renaming: null, activity: 'files' }));

  test('the row, the tab or the session bar renames; a tab rename without a tab falls back to the row', () => {
    useApp.getState().setRenaming({ id: 'a', at: 'tab' });
    expect(useApp.getState().renaming).toEqual({ id: 'a', at: 'tab' });
    useApp.getState().setRenaming({ id: 'a', at: 'bar' });
    expect(useApp.getState().renaming).toEqual({ id: 'a', at: 'bar' });
    // b has no tab (hidden, or closed while it runs): its sidebar row, shown.
    useApp.getState().setRenaming({ id: 'b', at: 'tab' });
    expect(useApp.getState().renaming).toEqual({ id: 'b', at: 'row' });
    expect(useApp.getState().activity).toBe('sessions');
    useApp.getState().setRenaming(null);
    expect(useApp.getState().renaming).toBeNull();
  });
});

describe('table tabs: db: keys with their own preview slot', () => {
  const C = 'c0123456789ab';
  const D = 'c00000000000d';
  const st = () => useApp.getState();
  const K = (name: string, schema = 'public', connId = C) => dbTabKey(connId, schema, name);
  const rel = (name: string, o: { connId?: string; schema?: string; kind?: DbTabRef['kind'] } = {}): Omit<DbTabRef, 'key'> =>
    ({ connId: o.connId ?? C, schema: o.schema ?? 'public', name, kind: o.kind ?? 'table', view: 'data' });
  const OVERVIEW: Omit<DbTabRef, 'key'> = { connId: C, schema: '', name: '', kind: 'overview', view: 'data' };
  const keys = () => st().dbTabs.map((r) => r.key);
  const tabs = () => st().split.panes.map((p) => p.tabs);
  /** Split view: the order is the panes' tabs, the focused front is the active key, no key twice. */
  function invariant() {
    const s = st().split;
    if (!isSplit(s)) return;
    expect(st().tabOrder).toEqual(flatten(s));
    expect(s.panes[s.focus]!.front).toBe(st().activeKey());
    expect(new Set(flatten(s)).size).toBe(flatten(s).length);
  }

  beforeEach(() => {
    useApp.setState({
      project: null, popout: null, poppedOut: [], terminals: [], selectedId: null, activeTab: 'term', tabOrder: [], hidden: [], pins: [], openFiles: [],
      preview: null, dbTabs: [], dbPreview: null, pendingAnchor: null, split: single(), ws: null, dirty: {}, toast: null, menu: null,
      space: 'sessions', spaceViews: emptyViews(), activity: 'sessions', sessionsActivity: 'sessions',
      settings: { ...DEFAULT_SETTINGS, previewTabs: true }
    });
    useDb.setState({ tabs: {} });
  });
  // Nothing of this block leaks into the tests after it (a pop-out window, workspaces, panes, a space).
  afterEach(() => {
    vi.unstubAllGlobals();
    useApp.setState({ popout: null, poppedOut: [], ws: null, split: single(), tabOrder: [], dbTabs: [], dbPreview: null, activeTab: 'term', selectedId: null, terminals: [], space: 'sessions', spaceViews: emptyViews(), activity: 'sessions' });
  });
  /** Kept tables opened first: the Databases strip's other tabs (tables live there). */
  const kept = (...names: string[]) => { for (const n of names) st().openDbTab(rel(n), { preview: false }); };

  test('a single click opens the table preview right after the active tab, in front — in the Databases space', () => {
    kept('a', 'b');
    st().activate(K('a'));
    st().openDbTab(rel('orders'), { preview: true });
    expect(st().space).toBe('databases');
    expect(st().tabOrder).toEqual([K('a'), K('orders'), K('b')]);
    expect(st().dbPreview).toBe(K('orders'));
    expect(st().activeTab).toBe(K('orders'));
    expect(st().activeKey()).toBe(K('orders'));
    expect(st().dbTabs.at(-1)).toEqual({ key: K('orders'), ...rel('orders') });
  });

  test('the next single click replaces it in place (same index), and the replaced table\'s state goes', () => {
    kept('a', 'b');
    st().activate(K('a'));
    st().openDbTab(rel('orders'), { preview: true });
    useDb.getState().patchTab(K('orders'), { wrap: true });
    st().openDbTab(rel('customers'), { preview: true });
    expect(st().tabOrder).toEqual([K('a'), K('customers'), K('b')]);
    expect(keys()).toEqual([K('a'), K('b'), K('customers')]);
    expect(st().dbPreview).toBe(K('customers'));
    expect(st().activeKey()).toBe(K('customers'));
    expect(useDb.getState().tabs).toEqual({});
  });

  test('kept: opened again with a double click (no second tab), Keep, dragging in the strip; a kept table is never replaced', () => {
    kept('a');
    st().openDbTab(rel('orders'), { preview: true });
    st().openDbTab(rel('orders'), { preview: false });
    expect(st().dbPreview).toBeNull();
    expect(st().tabOrder).toEqual([K('a'), K('orders')]);
    st().openDbTab(rel('customers'), { preview: true });
    expect(st().tabOrder).toEqual([K('a'), K('orders'), K('customers')]);
    st().keepDbTab(K('customers'));
    expect(st().dbPreview).toBeNull();
    st().openDbTab(rel('items'), { preview: true });
    st().moveTab(K('items'), K('a'));
    expect(st().dbPreview).toBeNull();
    expect(st().tabOrder).toEqual([K('items'), K('a'), K('orders'), K('customers')]);
    // Opened again as a preview, a kept table stays kept.
    st().openDbTab(rel('orders'), { preview: true });
    expect(st().dbPreview).toBeNull();
    expect(keys()).toEqual([K('a'), K('orders'), K('customers'), K('items')]);
  });

  test('Settings › Editor › preview tabs off: every table opens kept; turned off, the preview in place stays as a kept tab', () => {
    st().openDbTab(rel('orders'), { preview: true });
    expect(st().dbPreview).toBe(K('orders'));
    st().setSettings({ ...DEFAULT_SETTINGS, previewTabs: false });
    expect(st().dbPreview).toBeNull();
    expect(keys()).toEqual([K('orders')]);
    st().openDbTab(rel('customers'), { preview: true });
    st().openDbTab(rel('items'), { preview: true });
    expect(st().dbPreview).toBeNull();
    expect(st().tabOrder).toEqual([K('orders'), K('customers'), K('items')]);
  });

  test('a file preview (Sessions) and a table preview (Databases) live apart: neither replaces the other', () => {
    st().openFile('/p/x.ts', 'x.ts', null, undefined, { preview: true });
    st().openDbTab(rel('orders'), { preview: true });
    expect(st().preview).toBe('/p/x.ts');
    expect(st().dbPreview).toBe(K('orders'));
    expect(st().tabOrder).toEqual([K('orders')]);
    st().openFile('/p/y.ts', 'y.ts', null, undefined, { preview: true });
    expect(st().space).toBe('sessions');
    expect(st().tabOrder).toEqual(['f:/p/y.ts']);
    expect(st().dbPreview).toBe(K('orders'));
    st().openDbTab(rel('customers'), { preview: true });
    expect(st().tabOrder).toEqual([K('customers')]);
    expect(st().preview).toBe('/p/y.ts');
    expect(st().openFiles.map((f) => f.path)).toEqual(['/p/y.ts']);
  });

  test('the overview is never a preview, and a table preview never replaces it', () => {
    st().openDbTab(OVERVIEW, { preview: true });
    expect(st().tabOrder).toEqual([`db:${C}`]);
    expect(st().dbPreview).toBeNull();
    st().openDbTab(rel('orders'), { preview: true });
    st().openDbTab(rel('customers'), { preview: true });
    expect(st().tabOrder).toEqual([`db:${C}`, K('customers')]);
    expect(st().dbTabs[0]).toEqual({ key: `db:${C}`, ...OVERVIEW });
  });

  test('the view asked for (Structure, Relations from a menu) goes with the tab; setDbView changes it', () => {
    st().openDbTab(rel('orders'), { preview: false, view: 'structure' });
    expect(st().dbTabs[0]!.view).toBe('structure');
    st().openDbTab(rel('orders'), { preview: true, view: 'relations' });
    expect(st().dbTabs[0]!.view).toBe('relations');
    expect(st().dbPreview).toBeNull();
    st().setDbView(K('orders'), 'data');
    expect(st().dbTabs[0]!.view).toBe('data');
    const before = st().dbTabs;
    st().setDbView(K('nope'), 'structure');
    st().setDbView(K('orders'), 'data');
    expect(st().dbTabs).toBe(before);
  });

  test('a view switch invests in the tab: a preview switched to Structure or Relations is kept — a click on a node opens beside it', () => {
    st().openDbTab(rel('orders'), { preview: true });
    // The same view again changes nothing: still the preview.
    st().setDbView(K('orders'), 'data');
    expect(st().dbPreview).toBe(K('orders'));
    st().setDbView(K('orders'), 'structure');
    expect(st().dbPreview).toBeNull();
    // A node's single click: a new preview beside it, the tab hosting the diagram stays.
    st().openDbTab(rel('customers'), { preview: true });
    expect(st().tabOrder).toEqual([K('orders'), K('customers')]);
    expect(st().dbPreview).toBe(K('customers'));
    // Another tab's view switch never keeps the preview.
    st().setDbView(K('orders'), 'relations');
    expect(st().dbPreview).toBe(K('customers'));
    st().setDbView(K('customers'), 'relations');
    expect(st().dbPreview).toBeNull();
  });

  test('closed like a file (its ×, ⌘W, a key): the tab, its entry and its state go; the front goes back', async () => {
    kept('a');
    st().openDbTab(rel('orders'), { preview: false });
    st().openDbTab(rel('customers'), { preview: true });
    useDb.getState().patchTab(K('orders'), { wrap: true });
    useDb.getState().patchTab(K('customers'), { wrap: true });
    st().closeTab(K('orders'));
    expect(st().tabOrder).toEqual([K('a'), K('customers')]);
    expect(keys()).toEqual([K('a'), K('customers')]);
    expect(Object.keys(useDb.getState().tabs)).toEqual([K('customers')]);
    expect(st().activeKey()).toBe(K('customers'));
    st().closeTab();
    expect(st().tabOrder).toEqual([K('a')]);
    expect(keys()).toEqual([K('a')]);
    expect(st().dbPreview).toBeNull();
    expect(useDb.getState().tabs).toEqual({});
    expect(st().activeKey()).toBe(K('a'));
    // The last one closed: Databases empty, nothing in front.
    st().closeTab();
    expect(st().activeTab).toBe('none');
    st().openDbTab(rel('items'), { preview: false });
    await st().closeTabs([K('items')]);
    expect(st().dbTabs).toEqual([]);
  });

  test('Close Files in Sessions leaves the tables (in Databases) alone', async () => {
    st().openFile('/p/x.ts', 'x.ts');
    st().openDbTab(rel('orders'), { preview: false });
    st().openFile('/p/y.ts', 'y.ts');
    const closing = closingKeys(st().tabOrder, 'f:/p/y.ts', 'files');
    expect(closing).toEqual(['f:/p/x.ts', 'f:/p/y.ts']);
    await st().closeTabs(closing);
    expect(st().tabOrder).toEqual([]);
    expect(keys()).toEqual([K('orders')]);
    st().setActivity('databases');
    expect(st().tabOrder).toEqual([K('orders')]);
  });

  test('closeDbTabs (Never, a connection removed): every tab it names goes, from Sessions or from Databases; the others stay', () => {
    st().setTerminals([term('a')]);
    st().openDbTab(rel('orders'), { preview: true });
    st().openDbTab(rel('items'), { preview: false });
    st().openDbTab(rel('products', { connId: D }), { preview: false });
    useDb.getState().patchTab(K('orders'), { wrap: true });
    useDb.getState().patchTab(K('products', 'public', D), { wrap: true });
    st().select('a');
    st().closeDbTabs((r) => r.connId === C);
    // Closed in Databases while Sessions stays in front.
    expect(st().space).toBe('sessions');
    expect(st().tabOrder).toEqual(['t:a']);
    expect(keys()).toEqual([K('products', 'public', D)]);
    expect(st().dbPreview).toBeNull();
    expect(Object.keys(useDb.getState().tabs)).toEqual([K('products', 'public', D)]);
    st().setActivity('databases');
    expect(st().tabOrder).toEqual([K('products', 'public', D)]);
    const same = st().dbTabs;
    st().closeDbTabs(() => false);
    expect(st().dbTabs).toBe(same);
  });

  test('tables are no workspace\'s: the same in every workspace, never moved to one', () => {
    const ws: WorkspacesState = {
      on: true, active: 'A', members: { a: 'A', b: 'B' },
      list: [
        { id: 'A', name: 'A', color: 1, folder: null, order: ['t:a'] as TabKey[], active: 't:a', layout: null },
        { id: 'B', name: 'B', color: 2, folder: null, order: ['t:b'] as TabKey[], active: 't:b', layout: null }
      ]
    };
    useApp.setState({ ws });
    st().setTerminals([term('a'), term('b')]);
    expect(st().tabOrder).toEqual(['t:a']);
    st().openDbTab(rel('orders'), { preview: false });
    st().openDbTab(rel('customers'), { preview: true });
    st().moveToWorkspace(K('orders'), 'B', { quiet: true });
    expect(st().tabOrder).toEqual([K('orders'), K('customers')]);
    st().switchWorkspace('B');
    expect(st().space).toBe('sessions');
    expect(st().tabOrder).toEqual(['t:b']);
    expect(st().ws!.list.every((w) => w.order.every((k) => !k.startsWith('db:')))).toBe(true);
    st().setActivity('databases');
    expect(st().tabOrder).toEqual([K('orders'), K('customers')]);
    expect(st().dbPreview).toBe(K('customers'));
  });

  test('Close Workspace leaves the tables alone; a workspace an older version saved with only tables is empty: no question', async () => {
    const ws: WorkspacesState = {
      on: true, active: 'A', members: { a: 'A', b: 'B' },
      list: [
        { id: 'A', name: 'A', color: 1, folder: null, order: ['t:a'] as TabKey[], active: 't:a', layout: null },
        { id: 'B', name: 'B', color: 2, folder: null, order: ['t:b'] as TabKey[], active: 't:b', layout: null },
        { id: 'C', name: 'C', color: 3, folder: null, order: [K('orders')] as TabKey[], active: K('orders'), layout: null }
      ]
    };
    useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, ws, wsCloseAsk: null, resumables: [] });
    st().setTerminals([term('a'), term('b')]);
    st().openDbTab(rel('orders'), { preview: false });
    useDb.getState().patchTab(K('orders'), { wrap: true });
    await st().closeWorkspace('B', 'move');
    expect(keys()).toEqual([K('orders')]);
    expect(useDb.getState().tabs[K('orders')]).toBeDefined();
    askCloseWorkspace('C');
    expect(st().wsCloseAsk).toBeNull();
    expect(st().ws!.list.map((w) => w.id)).toEqual(['A']);
    expect(keys()).toEqual([K('orders')]);
    useApp.setState({ wsCloseAsk: null, project: null });
  });

  test('split: a preview shown in a pane that isn\'t focused is never replaced — the new one opens in the focused pane', () => {
    kept('a');
    st().openDbTab(rel('orders'), { preview: true });
    st().splitRight();
    st().activate(K('a'));
    expect(tabs()).toEqual([[K('orders')], [K('a')]]);
    expect(st().dbPreview).toBe(K('orders'));
    st().openDbTab(rel('customers'), { preview: true });
    expect(tabs()).toEqual([[K('orders')], [K('a'), K('customers')]]);
    expect(keys()).toEqual([K('a'), K('orders'), K('customers')]);
    expect(st().dbPreview).toBe(K('customers'));
    invariant();
    // The focused pane's own preview is replaced in place.
    st().openDbTab(rel('items'), { preview: true });
    expect(tabs()).toEqual([[K('orders')], [K('a'), K('items')]]);
    expect(keys()).toEqual([K('a'), K('orders'), K('items')]);
    invariant();
  });

  test('split: a preview alone in its pane, replaced by the next one, keeps its place and the split (same update)', () => {
    kept('a', 'b', 'c');
    st().splitRight();
    st().openDbTab(rel('orders'), { preview: true });
    expect(tabs()).toEqual([[K('a'), K('b'), K('c')], [K('orders')]]);
    st().openDbTab(rel('customers'), { preview: true });
    expect(tabs()).toEqual([[K('a'), K('b'), K('c')], [K('customers')]]);
    expect(st().split.focus).toBe(1);
    expect(st().dbPreview).toBe(K('customers'));
    invariant();
  });

  test('split: a preview moved to another pane (⌃⌘, a menu, a drop) is kept, as a strip drag keeps it', () => {
    kept('a');
    st().openDbTab(rel('orders'), { preview: true });
    st().moveTabStep(1);
    expect(tabs()).toEqual([[K('a')], [K('orders')]]);
    expect(st().dbPreview).toBeNull();
    st().openDbTab(rel('customers'), { preview: true });
    st().moveTabSide(K('customers'), -1);
    expect(st().dbPreview).toBeNull();
    st().openDbTab(rel('items'), { preview: true });
    st().moveTabToPane(K('items'), 1, null);
    expect(st().dbPreview).toBeNull();
    expect(tabs()).toEqual([[K('a'), K('customers')], [K('orders'), K('items')]]);
    invariant();
  });

  test('Open to the Side: in the pane on the right, as a kept tab', () => {
    kept('a', 'b');
    st().openDbTab(rel('orders'), { preview: true, side: true });
    expect(tabs()).toEqual([[K('a'), K('b')], [K('orders')]]);
    expect(st().split.focus).toBe(1);
    expect(st().dbPreview).toBeNull();
    invariant();
  });

  test('activate brings a table tab to the front (and Databases with it); one not open is ignored', () => {
    st().setTerminals([term('a')]);
    st().openDbTab(rel('orders'), { preview: false });
    st().activate('t:a');
    expect(st().space).toBe('sessions');
    st().activate(K('orders'));
    expect(st().space).toBe('databases');
    expect(st().activeKey()).toBe(K('orders'));
    st().activate(K('nope'));
    expect(st().activeKey()).toBe(K('orders'));
  });

  test('a table living in a pop-out: its window comes forward with the view asked for; from a pop-out, the project window shows it', () => {
    const focus = vi.fn(async () => {});
    const showInMain = vi.fn(async () => {});
    vi.stubGlobal('window', { atelier: { popout: { focus, showInMain } } });
    useApp.setState({ poppedOut: [K('orders')] });
    st().openDbTab(rel('orders'), { preview: true, view: 'structure' });
    const payload = { kind: 'db', connId: C, schema: 'public', name: 'orders', view: 'structure', rel: 'table' };
    expect(focus).toHaveBeenCalledWith(K('orders'), { payload: { ...payload, open: { preview: true, view: true } } });
    expect(st().tabOrder).toEqual([]);
    useApp.setState({ poppedOut: [], popout: { key: 'f:/p/a.ts' }, tabOrder: ['f:/p/a.ts'] });
    st().openDbTab(rel('orders'), { preview: true, view: 'structure' });
    expect(showInMain).toHaveBeenCalledWith({ key: K('orders'), payload: { ...payload, open: { preview: true, view: true } } });
    expect(st().tabOrder).toEqual(['f:/p/a.ts']);
    expect(st().dbTabs).toEqual([]);
  });

  // Open ›, "N rows ›", Open Referenced Row: the other table filtered on a key, its first row selected.
  const FILTERS = [{ column: 'id', op: 'eq' as const, values: ['2041'] }];

  test('opened on a key: a preview (a filter of its opening is no investment), the key\'s filters handed to the tab (its view applies them: filter-actions applyHandoff)', () => {
    st().openDbTab(rel('customers'), { preview: true, filters: FILTERS, inspector: true });
    expect(st().dbPreview).toBe(K('customers'));
    expect(useDb.getState().tab(K('customers')).handoff).toMatchObject({ filters: FILTERS, inspector: true });
    // Nothing applied here: the lazy view does (the toast and its Undo are its).
    expect(useDb.getState().tab(K('customers')).filters).toEqual([]);
    // Without filters, nothing is handed over.
    st().openDbTab(rel('coupons'), { preview: true });
    expect(useDb.getState().tab(K('coupons')).handoff).toBeUndefined();
  });

  test('already open with its own filters and view: the handoff waits for its view, the view stays (none asked), it stays kept', () => {
    st().openDbTab(rel('customers'), { preview: false, view: 'structure' });
    useDb.getState().patchTab(K('customers'), { filters: [{ column: 'plan', op: 'in', values: ['pro'] }] });
    st().openDbTab(rel('customers'), { preview: true, filters: FILTERS });
    expect(useDb.getState().tab(K('customers')).handoff?.filters).toEqual(FILTERS);
    expect(st().dbTabs.find((r) => r.key === K('customers'))?.view).toBe('structure');
    expect(st().dbPreview).toBeNull();
  });

  test('from a pop-out: the payload says preview or not, whether a view was asked, the key\'s filters — the project window opens it so', () => {
    const showInMain = vi.fn(async () => {});
    vi.stubGlobal('window', { atelier: { popout: { showInMain } } });
    useApp.setState({ popout: { key: 'f:/p/a.ts' }, tabOrder: ['f:/p/a.ts'] });
    st().openDbTab(rel('customers'), { preview: true, filters: FILTERS, inspector: true });
    const sent = { kind: 'db', connId: C, schema: 'public', name: 'customers', view: 'data', rel: 'table', open: { preview: true, view: false, filters: FILTERS, inspector: true } };
    expect(showInMain).toHaveBeenLastCalledWith({ key: K('customers'), payload: sent });
    st().openDbTab(rel('orders'), { preview: false });
    expect(showInMain).toHaveBeenLastCalledWith({ key: K('orders'), payload: expect.objectContaining({ open: { preview: false, view: false } }) });
    expect(useDb.getState().tabs).toEqual({});
  });

  test('the project window: such a payload opens as openDbTab would — a preview, an open tab\'s view kept, the filters handed over', () => {
    st().setTerminals([term('a')]);
    st().openDbTab(rel('orders'), { preview: false, view: 'structure' });
    st().select('a');
    const open = (name: string, o: { preview: boolean; view: boolean; filters?: typeof FILTERS }) => st().applyDock({
      key: K(name), payload: { kind: 'db', connId: C, schema: 'public', name, view: 'data', rel: 'table', open: o }
    });
    open('orders', { preview: true, view: false });
    expect(st().dbTabs.find((r) => r.key === K('orders'))?.view).toBe('structure');
    expect(st().activeKey()).toBe(K('orders'));
    open('customers', { preview: true, view: false, filters: FILTERS });
    expect(st().dbPreview).toBe(K('customers'));
    expect(useDb.getState().tab(K('customers')).handoff?.filters).toEqual(FILTERS);
    // A view asked for goes along.
    st().applyDock({ key: K('orders'), payload: { kind: 'db', connId: C, schema: 'public', name: 'orders', view: 'relations', open: { preview: false, view: true } } });
    expect(st().dbTabs.find((r) => r.key === K('orders'))?.view).toBe('relations');
  });

  test('the pop-out holding that table: its view kept unless asked, the key\'s filters handed over', () => {
    useApp.setState({ popout: { key: K('customers') }, tabOrder: [K('customers')], dbTabs: [{ key: K('customers'), ...rel('customers'), view: 'structure' }] });
    st().revealInPopout({ payload: { kind: 'db', connId: C, schema: 'public', name: 'customers', view: 'data', open: { preview: true, view: false, filters: FILTERS } } });
    expect(st().dbTabs[0]!.view).toBe('structure');
    expect(useDb.getState().tab(K('customers')).handoff?.filters).toEqual(FILTERS);
  });
});

test("What's new gives way to any overlay opened over it", () => {
  const open = () => useApp.getState().setWhatsNew({ since: '0.1.0' });
  for (const over of [
    () => useApp.getState().setPaletteOpen(true),
    () => useApp.getState().setSettingsOpen('about'),
    () => useApp.getState().setNotesOpen(true),
    () => useApp.getState().setNewSessionOpen(true),
    () => useApp.getState().setFolderSheet({ kind: 'session' } as never)
  ]) {
    open();
    over();
    expect(useApp.getState().whatsNew).toBeNull();
  }
  useApp.setState({ paletteOpen: false, settingsOpen: null, notesOpen: false, newSessionOpen: false, folderSheet: null });
});
