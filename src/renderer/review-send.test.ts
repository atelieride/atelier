import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionState } from '@shared/session';
import { pendingFor, sendReview, sendReason } from './review-send';
import { setBracketedProbe, setTerminalFocuser } from './terminal/focus';
import { useApp } from './store';
import type { LineComment } from './comments';

const term = (id: string, state: SessionState | null, foreground = 'claude'): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id.toUpperCase(), name: null, color: '#fff', foreground, createdAt: 0,
  session: state ? { sessionId: 's', state, title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, cwd: '/p/api' } as never : null
});
const comment = (id: string, target: string | null, over: Partial<LineComment> = {}): LineComment =>
  ({ id, path: '/p/api/a.ts', start: 3, end: 4, text: `note ${id}`, snippet: '', target, createdAt: Number(id.replace(/\D/g, '')) || 1, ...over });

const g = globalThis as { window?: unknown };
let input: ReturnType<typeof vi.fn>;
beforeEach(() => {
  input = vi.fn();
  g.window = { atelier: { terminals: { input, markSeen: () => Promise.resolve() } } };
  setBracketedProbe(() => true);
  useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, terminals: [term('t1', 'done'), term('t2', 'idle')], selectedId: null, toast: null, comments: [] });
});
afterEach(() => { delete g.window; vi.useRealTimers(); setTerminalFocuser(() => {}); setBracketedProbe(() => false); useApp.setState({ project: null, comments: [] }); });

test('types that session\'s comments as one bracketed paste, no Enter; clears them; Undo restores them', () => {
  vi.useFakeTimers();
  const focused: string[] = [];
  setTerminalFocuser((id) => focused.push(id));
  useApp.setState({ comments: [comment('c1', 't1'), comment('c2', 't2'), comment('c3', 't1', { path: '/p/api/b.ts', start: 7, end: 7 })] });
  expect(pendingFor('t1')).toBe(2);
  sendReview('t1');
  expect(input.mock.calls).toHaveLength(1);
  const [id, data] = input.mock.calls[0]! as [string, string];
  expect(id).toBe('t1');
  expect(data).toBe('\x1b[200~Review comments:\r@a.ts#L3-4 note c1\r@b.ts#L7 note c3\x1b[201~');
  // Nothing after the paste's end: the user reviews and presses Enter.
  expect(data.endsWith('\x1b[201~')).toBe(true);
  expect(useApp.getState().comments.map((c) => c.id)).toEqual(['c2']);
  expect(useApp.getState().selectedId).toBe('t1');
  expect(useApp.getState().toast?.text).toBe('2 comments typed into T1 · press Enter to send');
  vi.runAllTimers();
  expect(focused).toEqual(['t1']);
  useApp.getState().toast!.action!.run();
  expect(useApp.getState().comments.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
});

test('only when the prompt is free: otherwise nothing typed, the reason shown, the comments kept', () => {
  useApp.setState({ terminals: [term('t1', 'waiting')], comments: [comment('c1', 't1')] });
  expect(sendReason('t1')).toBe('Answer Claude first');
  sendReview('t1');
  useApp.setState({ terminals: [term('t1', 'running')] });
  expect(sendReason('t1')).toBe('Available when Claude\'s prompt is free');
  sendReview('t1');
  // No bracketed paste in front: every newline would submit.
  useApp.setState({ terminals: [term('t1', 'idle')] });
  setBracketedProbe(() => false);
  expect(sendReason('t1')).toBe('Available when Claude\'s prompt is free');
  sendReview('t1');
  expect(input).not.toHaveBeenCalled();
  expect(useApp.getState().toast?.text).toBe('Available when Claude\'s prompt is free');
  expect(useApp.getState().comments).toHaveLength(1);
});

test('a comment set aside (its file in the Trash) is neither counted nor sent, and stays', () => {
  useApp.setState({ comments: [comment('c1', 't1'), comment('c2', 't1', { path: '/p/api/gone.ts', gone: true })] });
  expect(pendingFor('t1')).toBe(1);
  sendReview('t1');
  expect((input.mock.calls[0]! as [string, string])[1]).not.toContain('gone.ts');
  expect(useApp.getState().comments.map((c) => c.id)).toEqual(['c2']);
});

test('Undo after the session closed: the drafts come back, aimed at the closed session, which says so', () => {
  useApp.setState({ comments: [comment('c1', 't1')] });
  sendReview('t1');
  const undo = useApp.getState().toast!.action!.run;
  useApp.setState({ terminals: [term('t2', 'idle')] });
  undo();
  expect(useApp.getState().comments.map((c) => [c.id, c.target])).toEqual([['c1', 't1']]);
  expect(sendReason('t1')).toBe('That session is closed');
});

test('nothing to send, or a closed session', () => {
  expect(sendReason('t1')).toBe('No comments for T1');
  sendReview('t1');
  expect(input).not.toHaveBeenCalled();
  useApp.setState({ comments: [comment('c1', 'gone')] });
  expect(sendReason('gone')).toBe('That session is closed');
});
