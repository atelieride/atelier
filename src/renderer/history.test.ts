import { expect, test } from 'vitest';
import type { Resumable } from '@shared/protocol';
import { HISTORY_LIMIT, type ClaudeConversation } from '@shared/history';
import { conversationHint, refreshHistory, relativeTime, resumeConversation, resumeEmptyText, resumeList, searchConversations } from './history';
import { useApp } from './store';

const conv = (sessionId: string, at: number, o: Partial<ClaudeConversation> = {}): ClaudeConversation => ({ sessionId, cwd: '/p', title: sessionId, prompt: sessionId, branch: null, at, ...o });
const res = (id: string, sessionId: string, endedAt: number, projectRoot = '/p'): Resumable => ({ id, projectRoot, cwd: '/p', title: id, color: '#fff', sessionId, endedAt });

test('relativeTime: short, coarse, then the date', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  expect(relativeTime(now - 20_000, now)).toBe('just now');
  expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
  expect(relativeTime(now - 3 * 3600_000, now)).toBe('3h ago');
  expect(relativeTime(now - 2 * 86400_000, now)).toBe('2d ago');
  expect(relativeTime(now - 15 * 86400_000, now)).toBe('2w ago');
  expect(relativeTime(Date.parse('2026-07-04T12:00:00Z'), now)).toBe('Jul 4');
  expect(relativeTime(Date.parse('2025-07-04T12:00:00Z'), now)).toBe('Jul 4, 2025');
  // A clock a little ahead is still "just now".
  expect(relativeTime(now + 5000, now)).toBe('just now');
});

test('resumeList: Atelier sessions of the project first, then the other conversations, newest first, deduplicated', () => {
  const r = resumeList(
    [res('a', 'S1', 100), res('b', 'S2', 300), res('c', 'S9', 500, '/other')],
    [conv('S1', 900), conv('S3', 200), conv('S4', 400)],
    '/p'
  );
  expect(r.sessions.map((x) => x.id)).toEqual(['b', 'a']);
  expect(r.conversations.map((x) => x.sessionId)).toEqual(['S4', 'S3']);
});

test('searchConversations: fuzzy over title, first prompt, branch and folder; empty query keeps the order', () => {
  const list = [
    conv('A', 3, { title: 'Login bug', prompt: 'Fix the login bug', branch: 'fix/login' }),
    conv('B', 2, { title: 'Dark mode', prompt: 'Add a dark theme toggle', branch: 'main', cwd: '/p/web' }),
    conv('C', 1, { title: 'Summary only', prompt: 'Refactor the billing worker', branch: 'feat/billing' })
  ];
  const folder = (c: ClaudeConversation) => (c.cwd === '/p/web' ? 'web/' : null);
  const ids = (q: string) => searchConversations(list, q, folder).map((c) => c.sessionId);
  expect(ids('')).toEqual(['A', 'B', 'C']);
  expect(ids('dark')).toEqual(['B']);
  expect(ids('billing')).toEqual(['C']);
  expect(ids('fix/login')).toEqual(['A']);
  expect(ids('web/')).toEqual(['B']);
});

test('searchConversations: letters scattered over a long first prompt find nothing; words in any order do', () => {
  const long = 'Check how the MCP calls and the palette search work: searching for something unrelated still finds '
    + 'sessions, with the code cache, the conflicts, the connection counter, the click count and the cursor.';
  const list = [conv('A', 2, { title: 'Palette search', prompt: long, branch: 'main' }), conv('B', 1, { title: 'Deploy', prompt: 'Deploy the site', branch: 'site/deploy' })];
  const ids = (q: string) => searchConversations(list, q, () => null).map((c) => c.sessionId);
  expect(ids('mcpcccccccccccccc')).toEqual([]);
  expect(ids('mcp')).toEqual(['A']);
  expect(ids('site deploy')).toEqual(['B']);
  expect(ids('palete')).toEqual(['A']);
});

test('searchConversations: an empty query lists every conversation the main process sent (up to HISTORY_LIMIT)', () => {
  const list = Array.from({ length: HISTORY_LIMIT }, (_, i) => conv(`S${i}`, HISTORY_LIMIT - i));
  expect(searchConversations(list, '', () => null)).toHaveLength(HISTORY_LIMIT);
});

test('conversationHint: "active now" for a conversation maybe still running outside Atelier, the relative time otherwise', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  expect(conversationHint(conv('A', now - 10_000, { active: true }), now)).toEqual({ text: 'active now', active: true });
  expect(conversationHint(conv('B', now - 3 * 3600_000), now)).toEqual({ text: '3h ago', active: false });
});

test('resume: says it is loading until Claude history first answers, then the empty state', async () => {
  useApp.setState({ history: [], historyLoaded: false });
  expect(resumeEmptyText()).toBe('Loading conversations…');
  let fail = true;
  (globalThis as { window?: unknown }).window = { atelier: { claude: { history: () => (fail ? Promise.reject(new Error('x')) : Promise.resolve([conv('A', 1)])) } } };
  // A failed read ends the loading state too (nothing will come).
  await refreshHistory();
  expect(useApp.getState().historyLoaded).toBe(true);
  expect(resumeEmptyText()).toBe('No conversations to resume in this project');
  useApp.setState({ historyLoaded: false });
  fail = false;
  await refreshHistory();
  expect(useApp.getState()).toMatchObject({ historyLoaded: true, history: [conv('A', 1)] });
});

test('resuming a conversation passes its Claude account along', async () => {
  const calls: unknown[][] = [];
  const term = { id: 't1' };
  (globalThis as { window?: unknown }).window = { atelier: { claude: { history: () => Promise.resolve([]), resume: (...a: unknown[]) => { calls.push(a); return Promise.resolve(term); } } } };
  useApp.setState({ size: { cols: 100, rows: 30 }, launched: () => {} } as never);
  await resumeConversation('S1', 'ops');
  await resumeConversation('S2');
  expect(calls).toEqual([['S1', 100, 30, 'ops'], ['S2', 100, 30, undefined]]);
});
