import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const chimes = vi.hoisted(() => ({ played: 0 }));
vi.mock('./chime', async (orig) => ({ ...(await orig<typeof import('./chime')>()), playChime: () => { chimes.played++; } }));

import { useApp } from './store';
import { KEY } from './notes';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { NoteEntry } from '@shared/notifications';

// Tab pop-out windows: a session watched in its pop-out counts as seen for the project's notification
// center, which the main window keeps (its list in storage, carried to the other windows by storage-sync).
const stored = new Map<string, string>();
const writes: string[] = [];
const g = globalThis as { window?: unknown; localStorage?: unknown };
const st = () => useApp.getState();
const entry = (id: string, session: string, unseen = [session]): NoteEntry => ({ id, at: 1, kind: 'waiting', sessions: [{ id: session, title: session, color: '#fff' }], activity: null, unseen });
const storedNotes = (): NoteEntry[] => (JSON.parse(stored.get(KEY) ?? '{}') as Record<string, NoteEntry[]>)['/p'] ?? [];

beforeEach(() => {
  g.window = { addEventListener: () => {}, atelier: { terminals: { markSeen: vi.fn(async () => {}) }, popout: {} } };
  g.localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { writes.push(k); stored.set(k, v); }, removeItem: (k: string) => { stored.delete(k); } };
  stored.clear(); writes.length = 0; chimes.played = 0;
  useApp.setState({ project: null, popout: null, notes: [], settings: { ...DEFAULT_SETTINGS, notifySound: true, notifyWaiting: true }, terminals: [], tabOrder: [], openFiles: [], selectedId: null, activeTab: 'term' });
});
afterEach(() => { delete g.window; delete g.localStorage; });

test('popout mode: the session watched here is marked seen in storage itself, keeping what the main window added there', () => {
  // The main window's list in storage: e1 (also in this window) and e2 (arrived since, not here yet).
  stored.set(KEY, JSON.stringify({ '/p': [entry('e1', 'b'), entry('e2', 'b'), entry('e3', 'c')] }));
  st().enterPopout({ key: 't:b' });
  st().setProject({ root: '/p', name: 'p', realRoot: '/p', popout: { key: 't:b' } });
  useApp.setState({ notes: [entry('e1', 'b')] });
  st().notesSeen('b');
  expect(st().notes.map((e) => e.unseen)).toEqual([[]]);
  expect(storedNotes().map((e) => [e.id, e.unseen])).toEqual([['e1', []], ['e2', []], ['e3', ['c']]]);
  // Nothing left to mark: nothing written (no storage event bouncing between the windows).
  writes.length = 0;
  st().notesSeen('b');
  expect(writes).toEqual([]);
});

const done = (id: string, sessions: string[], extra: Partial<NoteEntry> = {}): NoteEntry => ({ id, at: 1, kind: 'done', sessions: sessions.map((s) => ({ id: s, title: s, color: '#fff' })), activity: null, unseen: [], ...extra });

test('main window: background work ending after the user peeked at the session (already seen) still chimes', () => {
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, settings: { ...DEFAULT_SETTINGS, notifySound: true, notifyDone: true } });
  // Its turn ended earlier, the user looked (unread cleared): main sends the "Finished" entry already seen.
  st().receiveNotes([done('e1', ['b'])]);
  expect(chimes.played).toBe(1);
});

test('main window: a session watched finishing, then left within the finish window, still chimes', () => {
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, settings: { ...DEFAULT_SETTINGS, notifySound: true, notifyDone: true } });
  // Seen as it finished (so not unseen), no longer on screen when the entry lands.
  st().receiveNotes([done('e1', ['b', 'c', 'd'])]);
  expect(chimes.played).toBe(1);
});

test('main window: a session main marks as viewed in a focused pop-out never chimes; the entry is stored without the mark', () => {
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, settings: { ...DEFAULT_SETTINGS, notifySound: true, notifyDone: true } });
  st().receiveNotes([entry('e1', 'b', []), done('e2', ['b'])].map((e) => ({ ...e, quiet: ['b'] })));
  expect(chimes.played).toBe(0);
  expect(st().notes.some((e) => 'quiet' in e)).toBe(false);
  expect(storedNotes().some((e) => 'quiet' in e)).toBe(false);
  // Grouped with a session nobody watches: that one chimes.
  st().receiveNotes([done('e3', ['b', 'c'], { quiet: ['b'] })]);
  expect(chimes.played).toBe(1);
});
