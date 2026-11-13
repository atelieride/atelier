import { beforeEach, expect, test, vi } from 'vitest';
import type { SearchFile, SearchLine } from '@shared/search';

const app = vi.hoisted(() => ({ openSearchResult: vi.fn(), keepOpen: vi.fn(), openSendPalette: vi.fn(), showToast: vi.fn() }));
const clip = vi.hoisted(() => ({ copyText: vi.fn(() => Promise.resolve(true)) }));
const launch = vi.hoisted(() => ({ newSessionIn: vi.fn(() => Promise.resolve({ id: 't9' } as unknown)) }));
const typing = vi.hoisted(() => ({ typeWhenReadyAs: vi.fn() }));
vi.mock('../store', () => ({ useApp: { getState: () => ({ ...app, project: { root: '/p' } }) } }));
vi.mock('../editor/savers', () => ({ dirtyPaths: () => [], handoffOf: () => undefined }));
vi.mock('../clipboard', () => clip);
vi.mock('../launch', () => launch);
vi.mock('../task-session', () => typing);

import { copyAllResults, openFileResult, openResult, sendResults } from './actions';
import { searchAreaMenu } from './menus';
import { matchKey, resultsText } from './model';
import { useSearch } from './store';

const line: SearchLine = { line: 4, text: 'a token', start: 0, ranges: [[2, 7]], cutStart: false, cutEnd: false };
const file: SearchFile = { path: '/p/a.ts', rel: 'a.ts', size: 7, lines: [line] };
const other: SearchFile = { path: '/p/b.ts', rel: 'b.ts', size: 7, lines: [{ ...line, line: 9 }] };
const ran = { query: 'token', matchCase: false, wholeWord: false, regex: false };

beforeEach(() => vi.clearAllMocks());

test('a result opens with the spec its search ran with, even while a newer query is being typed', () => {
  useSearch.setState({ ranSpec: ran, spec: { ...ran, query: 'tokens' } });
  openResult(file, line, 0, { side: false, keepFocus: true });
  expect(app.openSearchResult).toHaveBeenLastCalledWith(file, line, 0, { side: false, keepFocus: true, spec: ran });
  // A file row: its first match.
  openFileResult(file, { side: true, keepFocus: false });
  expect(app.openSearchResult).toHaveBeenLastCalledWith(file, line, 0, { side: true, keepFocus: false, spec: ran });
});

test('Copy All Results and Send to Session take the same block: the spec the search ran with, dismissed rows left out', () => {
  const dismissed = new Set([matchKey(other.path, 9, 0)]);
  useSearch.setState({ ranSpec: ran, ranFilters: { include: '', exclude: '' }, spec: { ...ran, query: 'tokens' }, files: [file, other], dismissed, phase: 'done', limitHit: false });
  const block = resultsText(ran, [file, other], dismissed);
  expect(block).toBe('Search "token" (match case off, whole word off, regex off) — 1 result in 1 file\na.ts:4  a token');
  copyAllResults();
  expect(clip.copyText).toHaveBeenCalledWith(block);
  sendResults();
  expect(app.openSendPalette).toHaveBeenCalledTimes(1);
  const asked = app.openSendPalette.mock.calls[0]![0] as { text: string; cwd: string | null; newSession?: (send: boolean) => void };
  expect(asked.text).toBe(block);
  expect(asked.cwd).toBeNull();
  // Claude sessions only: the step offers a new one.
  expect(asked.newSession).toBeTypeOf('function');
});

test('Send to Session\'s New session: a session named after the search, the block typed into its prompt once Claude is ready', async () => {
  useSearch.setState({ ranSpec: ran, files: [file], dismissed: new Set() });
  sendResults();
  const asked = app.openSendPalette.mock.calls[0]![0] as { text: string; newSession: (send: boolean) => void };
  asked.newSession(false);
  await vi.waitFor(() => expect(typing.typeWhenReadyAs).toHaveBeenCalled());
  expect(launch.newSessionIn).toHaveBeenCalledWith('search token');
  expect(typing.typeWhenReadyAs).toHaveBeenCalledWith('t9', asked.text, false, 'The search results are in the prompt. Review them and press Enter to send.');
  // ⌘↵ sends it once typed.
  asked.newSession(true);
  await vi.waitFor(() => expect(typing.typeWhenReadyAs).toHaveBeenCalledTimes(2));
  expect(typing.typeWhenReadyAs).toHaveBeenLastCalledWith('t9', asked.text, true, expect.any(String));
  // A long query names the session by its start, on one line.
  useSearch.setState({ ranSpec: { ...ran, query: `${'x'.repeat(60)}\\nmore` } });
  sendResults();
  (app.openSendPalette.mock.calls[1]![0] as { newSession: (send: boolean) => void }).newSession(false);
  await vi.waitFor(() => expect(launch.newSessionIn).toHaveBeenCalledTimes(3));
  expect(launch.newSessionIn).toHaveBeenLastCalledWith(`search ${'x'.repeat(39)}…`);
});

test('a new session that cannot start (atelierd not reachable) says so and offers the results to copy', async () => {
  useSearch.setState({ ranSpec: ran, ranFilters: { include: '', exclude: '' }, files: [file], dismissed: new Set(), phase: 'done', limitHit: false });
  launch.newSessionIn.mockRejectedValueOnce(new Error('not connected'));
  sendResults();
  const asked = app.openSendPalette.mock.calls[0]![0] as { text: string; newSession: (send: boolean) => void };
  asked.newSession(false);
  await vi.waitFor(() => expect(app.showToast).toHaveBeenCalled());
  const [message, action] = app.showToast.mock.calls[0]! as [string, { label: string; run: () => void }];
  expect(message).toBe("Couldn't start a new session, so nothing was typed.");
  expect(action.label).toBe('Copy Text');
  action.run();
  expect(clip.copyText).toHaveBeenCalledWith(asked.text);
  expect(typing.typeWhenReadyAs).not.toHaveBeenCalled();
});

test('the block says what the results are not: the filters the search ran with, past the limit, stopped', () => {
  // The fields may hold other filters by now: the block tells those of the search it lists.
  useSearch.setState({
    ranSpec: ran, ranFilters: { include: 'src/', exclude: '**/*.test.ts' }, include: 'lib/', exclude: '',
    files: [file], dismissed: new Set(), phase: 'stopped', limitHit: true
  });
  copyAllResults();
  expect(clip.copyText).toHaveBeenLastCalledWith('Search "token" (match case off, whole word off, regex off) — 1+ results in 1 file, in src/, excluding **/*.test.ts (stopped)\na.ts:4  a token');
});

test('while the search runs, the menus do not copy or send the results (✦ Send to session is hidden then too)', () => {
  const state = { ranSpec: ran, ranFilters: { include: '', exclude: '' }, spec: ran, files: [file], dismissed: new Set<string>(), collapsed: new Set<string>(), limitHit: false };
  const enabled = () => Object.fromEntries(searchAreaMenu().filter((i) => i !== 'sep').map((i) => [(i as { id: string }).id, !(i as { disabled?: boolean }).disabled]));
  useSearch.setState({ ...state, phase: 'running' });
  expect(enabled()).toMatchObject({ 'copy-all': false, send: false });
  useSearch.setState({ ...state, phase: 'done' });
  expect(enabled()).toMatchObject({ 'copy-all': true, send: true });
});
