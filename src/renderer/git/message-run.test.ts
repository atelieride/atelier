import { afterEach, beforeEach, expect, test } from 'vitest';
import type { FileChange, RepoStatus } from '@shared/git';
import type { ScmMessageEvent } from '@shared/git-write';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { useApp } from '../store';
import { commitWork } from './actions';
import { messageApplied, messageEdited, stopMessage, writeMessage, writeMessageCommand } from './message-run';

// ✦ in the drawer, driven: main writes and streams ev:scmMessage events; the store's
// gitWrite follows them; Stop cancels in main and keeps what streamed; a failure toasts and leaves the field alone;
// closing the drawer or moving its target drops the run; Off and Read-only ask main nothing.

const g = globalThis as { window?: unknown; localStorage?: unknown };
let calls: [string, ...unknown[]][];
let answers: Record<string, unknown>;
let emit: ((e: ScmMessageEvent) => void) | null;
const tick = () => new Promise((r) => setTimeout(r, 0));

const ch = (rel: string, stage: FileChange['stage']): FileChange => ({ path: `/x/${rel}`, rel, kind: 'M', stage, added: 1, removed: 0 });
const repo = (root: string, name: string, ...stages: FileChange['stage'][]): RepoStatus => ({
  root, name, branch: 'main', detached: false, ahead: 0, behind: 0, changes: stages.map((s, i) => ch(`f${i}`, s)), oid: 'a'.repeat(40), checkedAt: 0, truncated: 0
});
const w = () => useApp.getState().gitWrite;
const DONE = { text: 'feat(cart): round half up', model: 'haiku', ms: 1800, notes: [] };

beforeEach(() => {
  calls = []; answers = { message: { id: 'm1' } }; emit = null;
  const method = (name: string) => async (...args: unknown[]) => {
    calls.push([name, ...args]);
    const a = answers[name];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? (a as (...x: unknown[]) => unknown)(...args) : a ?? { outcome: 'ok' };
  };
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  g.window = {
    atelier: {
      git: { message: method('message'), messageCancel: method('messageCancel'), stage: method('stage'), facts: method('facts') },
      on: { scmMessage: (cb: (e: ScmMessageEvent) => void) => { emit = cb; return () => { emit = null; }; } }
    }
  };
  useApp.setState({
    settings: DEFAULT_SETTINGS, project: { root: '/p', name: 'p', realRoot: '/p' }, showChanges: true,
    repos: [repo('/p/a', 'acme-store', 'all', 'none'), repo('/p/b', 'billing', 'all')],
    gitDrawer: { open: true, height: null, unfolded: [], openedFor: null }, gitTarget: '/p/a', gitLastStaged: null, gitDrafts: {}, gitOps: {}, gitResult: {},
    gitSheet: null, commitAll: null, gitFacts: {}, gitWrite: null, toast: null, activeTab: 'term'
  });
});
afterEach(() => {
  // Whatever a test left running ends here (and stops listening).
  useApp.setState({ gitDrawer: { open: false, height: null, unfolded: [], openedFor: null } });
  delete g.window; delete g.localStorage;
});

// A checkbox shows its click before git ran (stage-intents.ts), and main reads the index for ✦ outside the write
// queue: ✦ shows it is writing at once, and asks main once this window's clicks in that repository reached git.
test('✦ right after a checkbox click: writing at once, main asked once the click reached git; stopped meanwhile, never', async () => {
  useApp.setState({ gitStageIntents: [], gitReposSeen: [] });
  const id = useApp.getState().addStageIntent('/p/a', ['f1'], 'all');
  useApp.getState().addStageIntent('/p/b', ['f0'], 'none');
  const run = writeMessage('/p/a');
  await tick();
  expect(w()).toMatchObject({ root: '/p/a', phase: 'writing' });
  expect(calls).toEqual([]);
  useApp.getState().endStageIntent(id, 5);
  await run;
  expect(calls).toEqual([['message', { root: '/p/a' }]]);
  stopMessage();

  calls = [];
  const id2 = useApp.getState().addStageIntent('/p/a', ['f1'], 'none');
  const stopped = writeMessage('/p/a');
  await tick();
  stopMessage();
  useApp.getState().endStageIntent(id2, null);
  await stopped;
  expect(calls).toEqual([]);
  useApp.setState({ gitStageIntents: [], gitReposSeen: [] });
});

test('a run: main is asked for the root, the text streams, done is ready with the text to put in the field', async () => {
  await writeMessage('/p/a');
  expect(calls).toEqual([['message', { root: '/p/a' }]]);
  expect(w()).toMatchObject({ root: '/p/a', phase: 'writing', id: 'm1', text: '' });
  emit!({ id: 'm1', chunk: 'feat(cart): ' });
  emit!({ id: 'other', chunk: 'not mine' });
  emit!({ id: 'm1', chunk: 'round' });
  expect(w()!.text).toBe('feat(cart): round');
  emit!({ id: 'm1', done: DONE });
  expect(w()).toMatchObject({ phase: 'ready', text: DONE.text, apply: DONE.text, model: 'haiku', ms: 1800 });
  messageApplied();
  expect(w()).toMatchObject({ phase: 'ready', apply: null });
  messageEdited(DONE.text);
  expect(w()).not.toBeNull();
  messageEdited('my words');
  expect(w()).toBeNull();
});

test('a tweak passes the current text; events that come before main answers the id are kept', async () => {
  answers.message = (o: unknown) => { emit?.({ id: 'm2', chunk: 'early ' }); return { id: 'm2' }; };
  await writeMessage('/p/a', { kind: 'shorter', current: 'feat: long text' });
  expect(calls[0]).toEqual(['message', { root: '/p/a', tweak: { kind: 'shorter', current: 'feat: long text' } }]);
  expect(w()).toMatchObject({ phase: 'writing', tweak: 'shorter', text: 'early ' });
});

test('Stop: main cancels, what streamed is kept as one replacement; later events change nothing', async () => {
  await writeMessage('/p/a');
  emit!({ id: 'm1', chunk: 'feat(cart): ' });
  stopMessage();
  expect(calls.at(-1)).toEqual(['messageCancel', 'm1']);
  expect(w()).toMatchObject({ phase: 'stopped', apply: 'feat(cart): ' });
  emit?.({ id: 'm1', chunk: 'more' });
  emit?.({ id: 'm1', error: 'Stopped' });
  expect(w()).toMatchObject({ phase: 'stopped', text: 'feat(cart): ' });
  expect(useApp.getState().toast).toBeNull();
  messageApplied();
  expect(w()).toBeNull();
  // Stopped before anything came: nothing to keep.
  await writeMessage('/p/a');
  stopMessage();
  expect(w()).toBeNull();
});

test('Stop while main is still starting it: the run it answers is cancelled at once', async () => {
  let answer!: (v: unknown) => void;
  answers.message = () => new Promise((r) => { answer = r; });
  const run = writeMessage('/p/a');
  await tick();
  stopMessage();
  expect(w()).toBeNull();
  answer({ id: 'late' });
  await run;
  expect(calls).toContainEqual(['messageCancel', 'late']);
  expect(w()).toBeNull();
});

test('a failure: an info toast with the reason, the run is gone (the field keeps what it had)', async () => {
  await writeMessage('/p/a');
  emit!({ id: 'm1', chunk: 'half' });
  emit!({ id: 'm1', error: 'Claude Code was not found' });
  expect(w()).toBeNull();
  expect(useApp.getState().toast).toMatchObject({ text: "Claude couldn't write a message: Claude Code was not found", tone: 'info' });
  // main refusing at the start, or the call failing, says so the same way.
  answers.message = { error: 'Nothing is staged' };
  await writeMessage('/p/a');
  expect(w()).toBeNull();
  expect(useApp.getState().toast).toMatchObject({ text: "Claude couldn't write a message: Nothing is staged" });
  answers.message = new Error('gone');
  await writeMessage('/p/a');
  expect(useApp.getState().toast).toMatchObject({ text: "Claude couldn't write a message: gone" });
});

test('a new run while one writes: the first is cancelled and its events are ignored', async () => {
  await writeMessage('/p/a');
  answers.message = { id: 'm2' };
  await writeMessage('/p/a');
  expect(calls).toContainEqual(['messageCancel', 'm1']);
  emit!({ id: 'm1', chunk: 'old' });
  emit!({ id: 'm2', chunk: 'new' });
  expect(w()).toMatchObject({ id: 'm2', text: 'new' });
});

test('the target moving (staging in another repository) keeps the run: it lands when the drawer is back on its repository', async () => {
  await writeMessage('/p/a');
  useApp.getState().setGitTarget('/p/b');
  expect(calls).not.toContainEqual(['messageCancel', 'm1']);
  emit!({ id: 'm1', chunk: 'feat(cart)' });
  emit!({ id: 'm1', done: DONE });
  expect(w()).toMatchObject({ root: '/p/a', phase: 'ready', apply: DONE.text });
  useApp.getState().setGitTarget('/p/a');
  expect(w()).toMatchObject({ root: '/p/a', phase: 'ready', apply: DONE.text });
});

test('the drawer closing drops the run (cancelled in main while it writes)', async () => {
  await writeMessage('/p/a');
  useApp.getState().closeGitDrawer();
  expect(calls).toContainEqual(['messageCancel', 'm1']);
  expect(w()).toBeNull();
  useApp.setState({ gitDrawer: { open: true, height: null, unfolded: [], openedFor: null } });
  answers.message = { id: 'm2' };
  await writeMessage('/p/b');
  emit!({ id: 'm2', done: DONE });
  useApp.getState().closeGitDrawer();
  expect(w()).toBeNull();
});

test('Off and Read-only: nothing is asked of main', async () => {
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, commitMessages: 'off' } });
  await writeMessage('/p/a');
  await writeMessageCommand();
  useApp.setState({ settings: { ...DEFAULT_SETTINGS, gitActions: 'read-only' } });
  await writeMessage('/p/a');
  await writeMessageCommand();
  expect(calls).toEqual([]);
  expect(w()).toBeNull();
});

test('⌥⌘M: the drawer opens (Changes shown) on its target and ✦ starts there', async () => {
  useApp.setState({ showChanges: false, gitDrawer: { open: false, height: null, unfolded: [], openedFor: null }, gitTarget: null });
  await writeMessageCommand();
  expect(useApp.getState().showChanges).toBe(true);
  expect(useApp.getState().gitDrawer.open).toBe(true);
  expect(calls).toEqual([['message', { root: useApp.getState().gitTarget }]]);
  expect(w()).toMatchObject({ phase: 'writing', root: useApp.getState().gitTarget });
});

test("Commit <session>'s Work… in one repository starts ✦ on its own, unless the field has a draft", async () => {
  useApp.setState({ gitDrawer: { open: false, height: null, unfolded: [], openedFor: null }, gitTarget: null });
  await commitWork('t1', [{ repo: '/p/a', rel: 'f1', kind: 'M', stage: 'none' }]);
  await tick();
  expect(useApp.getState().gitTarget).toBe('/p/a');
  expect(calls.filter((c) => c[0] === 'message')).toEqual([['message', { root: '/p/a' }]]);
  stopMessage();

  calls = [];
  useApp.setState({ gitDrawer: { open: false, height: null, unfolded: [], openedFor: null }, gitTarget: null, gitDrafts: { '/p/a': 'fix: mine' } });
  await commitWork('t1', [{ repo: '/p/a', rel: 'f1', kind: 'M', stage: 'none' }]);
  await tick();
  expect(useApp.getState().gitDrawer.open).toBe(true);
  expect(calls.filter((c) => c[0] === 'message')).toEqual([]);
});
