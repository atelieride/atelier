import { afterEach, beforeEach, expect, test } from 'vitest';
import { loadNotes, noteDetail, noteTitle, saveNotes, viewingNow } from './notes';
import type { NoteEntry } from '@shared/notifications';

const e = (id: string, at: number): NoteEntry => ({ id, at, kind: 'done', sessions: [{ id: 's', title: 'S', color: '#fff' }], activity: null, unseen: ['s'] });

const store = new Map<string, string>();
beforeEach(() => { (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }; });
afterEach(() => { store.clear(); delete (globalThis as { localStorage?: unknown }).localStorage; });

test('kept per project, survive a reload, broken storage means none', () => {
  expect(loadNotes('/p')).toEqual([]);
  saveNotes('/p', [e('a', 2), e('b', 1)]);
  saveNotes('/q', [e('c', 3)]);
  expect(loadNotes('/p').map((x) => x.id)).toEqual(['a', 'b']);
  expect(loadNotes('/q').map((x) => x.id)).toEqual(['c']);
  // No entries left: the project is dropped from storage.
  saveNotes('/q', []);
  expect(Object.keys(JSON.parse(store.get('atelier.notifications')!) as object)).toEqual(['/p']);
  store.set('atelier.notifications', '{broken');
  expect(loadNotes('/p')).toEqual([]);
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  expect(loadNotes('/p')).toEqual([]);
  expect(() => saveNotes('/p', [e('a', 1)])).not.toThrow();
});

test('detail line: kind, then the activity without repeating "waiting"; a group lists its sessions', () => {
  const kinds = { waiting: 'Waiting for you', done: 'Finished', error: 'Stopped with an error' };
  const one = (kind: NoteEntry['kind'], activity: string | null): NoteEntry => ({ ...e('a', 1), kind, activity });
  expect(noteDetail(one('waiting', 'waiting: Bash npm test'), kinds)).toBe('Waiting for you · Bash npm test');
  expect(noteDetail(one('waiting', 'waiting for you'), kinds)).toBe('Waiting for you');
  expect(noteDetail(one('waiting', null), kinds)).toBe('Waiting for you');
  expect(noteDetail(one('error', 'rate_limit'), kinds)).toBe('Stopped with an error · Rate limit');
  expect(noteDetail(one('done', null), kinds)).toBe('Finished');
  // States2 entries say what the session waited for.
  expect(noteDetail({ ...one('waiting', 'waiting: Bash npm test'), wait: 'permission' }, kinds)).toBe('Needs permission · Bash npm test');
  expect(noteDetail({ ...one('waiting', 'waiting: question'), wait: 'question' }, kinds)).toBe('Has a question');
  const group: NoteEntry = { ...e('g', 1), sessions: [{ id: 'a', title: 'Alfa', color: '#fff' }, { id: 'b', title: 'Beta', color: '#fff' }] };
  expect(noteDetail(group, kinds)).toBe('Alfa, Beta');
  // Sessions stopped together for the same reason: the reason, then the names.
  expect(noteDetail({ ...group, kind: 'error', activity: 'rate_limit' }, kinds)).toBe('Rate limit · Alfa, Beta');
  // A trigger match: the terminal, then the line that matched (the rule is in the title).
  expect(noteDetail({ ...one('trigger', '3 tests failed'), trigger: 'tests failed' }, kinds)).toBe('S · 3 tests failed');
  expect(noteTitle({ ...one('trigger', '3 tests failed'), trigger: 'tests failed' }, (n, k) => `${n} ${k}`, (r) => `Trigger: ${r}`)).toBe('Trigger: tests failed');
  expect(noteTitle(one('done', null), (n, k) => `${n} ${k}`, (r) => `Trigger: ${r}`)).toBe('S');
  // A failed container: its name, then why and its last error line, with the project.
  const box: NoteEntry = { ...e('c', 1), kind: 'container', sessions: [{ id: `docker:${'a'.repeat(64)}`, title: 'worker', color: 'docker' }], activity: 'Error: boom', container: { id: 'a'.repeat(64), project: 'acme', reason: 'crash', exitCode: 1 } };
  expect(noteTitle(box, (n, k) => `${n} ${k}`, (r) => r)).toBe('worker');
  expect(noteDetail(box, kinds)).toBe('Exited (1) · Error: boom');
  expect(noteDetail({ ...box, activity: null, container: { ...box.container!, reason: 'oom' } }, kinds)).toBe('Ran out of memory');
  expect(noteDetail({ ...box, activity: null, container: { ...box.container!, reason: 'unhealthy' } }, kinds)).toBe('Unhealthy');
  expect(noteTitle({ ...group, kind: 'error' }, (n, k) => `${n} ${k}`, (r) => r)).toBe('2 error');
});

test('the session you are looking at: selected terminal tab, window focused, nothing over it', () => {
  expect(viewingNow('a', 'term', true, false)).toBe('a');
  expect(viewingNow('a', 'term', false, false)).toBeNull();
  expect(viewingNow('a', 'term', true, true)).toBeNull();
  expect(viewingNow('a', '/r/file.ts', true, false)).toBeNull();
  expect(viewingNow(null, 'term', true, false)).toBeNull();
});
