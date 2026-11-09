import { expect, test } from 'vitest';
import { CHIME_GAP_MS, chimeFor, ChimeGate } from './chime';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import type { NoteEntry, NoteKind } from '@shared/notifications';

const entry = (kind: NoteKind, ids: string[]): NoteEntry =>
  ({ id: `${kind}-${ids.join()}`, at: 0, kind, sessions: ids.map((id) => ({ id, title: id, color: '#fff' })), activity: null, unseen: ids });
const none = new Set<string>();
const s = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, notifySound: true, notifyWaiting: true, notifyDone: true, notifyTriggers: true, ...over });

test('a session waiting, finishing, failing or a trigger match chimes, each only with its own notification on', () => {
  expect(chimeFor([entry('waiting', ['t1'])], s(), none)).toBe(true);
  expect(chimeFor([entry('done', ['t1'])], s(), none)).toBe(true);
  expect(chimeFor([entry('error', ['t1'])], s(), none)).toBe(true);
  expect(chimeFor([entry('trigger', ['t1'])], s(), none)).toBe(true);
  expect(chimeFor([entry('waiting', ['t1'])], s({ notifyWaiting: false }), none)).toBe(false);
  expect(chimeFor([entry('done', ['t1']), entry('error', ['t2'])], s({ notifyDone: false }), none)).toBe(false);
  expect(chimeFor([entry('trigger', ['t1'])], s({ notifyTriggers: false }), none)).toBe(false);
});

test('"Play a sound" off, nothing new, or only the session you are looking at: silence', () => {
  expect(chimeFor([entry('waiting', ['t1'])], s({ notifySound: false }), none)).toBe(false);
  expect(chimeFor([], s(), none)).toBe(false);
  expect(chimeFor([entry('done', ['t1'])], s(), new Set(['t1']))).toBe(false);
  // Several finishing together, one of them in front: the others still deserve the sound.
  expect(chimeFor([entry('done', ['t1', 't2'])], s(), new Set(['t1']))).toBe(true);
  // Split view: every pane on screen counts as looked at.
  expect(chimeFor([entry('done', ['t1', 't2'])], s(), new Set(['t1', 't2']))).toBe(false);
});

test('chimes close together play once', () => {
  const gate = new ChimeGate();
  expect(gate.pass(1000)).toBe(true);
  expect(gate.pass(1000 + CHIME_GAP_MS - 1)).toBe(false);
  expect(gate.pass(1000 + CHIME_GAP_MS)).toBe(true);
});
