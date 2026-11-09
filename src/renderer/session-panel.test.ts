import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo, SessionState } from '@shared/session';
import { ENTER_FLOOR_MS } from './task-session';
import { setTerminalFocuser } from './terminal/focus';
import { forgetDraft, hasDraft, noteInput, pruneDrafts, sendInput } from './terminal/drafts';
import { useApp } from './store';
import { PANEL_MODELS, compactSession, clearSession, modeAvailability, modelCommand, modelOf, nextMode, openSelectedSessionPanel, openSessionPanel, panelAvailability, panelReason, settlePending, switchModel } from './session-panel';

const term = (state: SessionState | null, extra: Partial<SessionInfo> = {}, foreground = 'claude'): TerminalInfo => ({
  id: 'a', projectRoot: '/p', cwd: '/p', title: 'A', name: null, color: '#fff', foreground, createdAt: 0,
  session: state ? { sessionId: 's-1', state, title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, ...extra } : null
});

const g = globalThis as { window?: unknown };
let input: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  input = vi.fn();
  g.window = { atelier: { terminals: { input, markSeen: () => Promise.resolve() } } };
  useApp.setState({ terminals: [term('done')], selectedId: 'a', toast: null, sessionPanel: null });
});
afterEach(() => { forgetDraft('a'); settlePending('a'); pruneDrafts(new Set()); delete g.window; vi.useRealTimers(); setTerminalFocuser(() => {}); useApp.setState({ terminals: [], sessionPanel: null }); });

const typed = () => input.mock.calls.map((c) => c[1] as string);

test('the models: the same list as Settings › Claude; /model <name>', () => {
  expect(PANEL_MODELS).toEqual(['default', 'opus', 'sonnet', 'haiku']);
  expect(PANEL_MODELS.map(modelCommand)).toEqual(['/model default', '/model opus', '/model sonnet', '/model haiku']);
});

test('the current model from the status line\'s name (unknown: none)', () => {
  expect(modelOf('Opus 5.5')).toBe('opus');
  expect(modelOf('Claude Sonnet 4.5')).toBe('sonnet');
  expect(modelOf('haiku-4-5')).toBe('haiku');
  expect(modelOf('Opus 4.1 (1M context)')).toBe('opus');
  expect(modelOf('gpt-x')).toBeNull();
  expect(modelOf(null)).toBeNull();
  expect(modelOf(undefined)).toBeNull();
});

test.each([
  // [state, waitingFor, foreground, expected]
  ['done', undefined, 'claude', 'ok'],
  ['idle', undefined, 'claude', 'ok'],
  ['error', undefined, 'claude', 'ok'],
  // The idle notice: the turn is over, Claude waits for a new prompt.
  ['waiting', 'input', 'claude', 'ok'],
  ['done', 'input', 'claude', 'ok'],
  // A dialog is open: typed text and Enter would answer it.
  ['waiting', 'permission', 'claude', 'waiting'],
  ['waiting', 'question', 'claude', 'waiting'],
  ['waiting', undefined, 'claude', 'waiting'],
  ['running', undefined, 'claude', 'busy'],
  // Not Claude's prompt in front.
  ['done', undefined, 'vim', 'busy'],
  ['idle', undefined, '/usr/bin/less', 'busy'],
  ['done', undefined, 'zsh', 'busy']
] as const)('typing actions: %s / waitingFor %s / %s in front → %s', (state, waitingFor, fg, expected) => {
  expect(panelAvailability(term(state, waitingFor ? { waitingFor } : {}, fg))).toBe(expected);
});

test('no session: never', () => {
  expect(panelAvailability(term(null))).toBe('not-claude');
  expect(panelAvailability(undefined)).toBe('not-claude');
});

test('the reason on a disabled action', () => {
  expect(panelReason('busy')).toBe('Available when Claude is waiting for you');
  expect(panelReason('not-claude')).toBe('Available when Claude is waiting for you');
  expect(panelReason('waiting')).toBe('Answer Claude first');
  expect(panelReason('paused')).toBe('Paused for the usage limit: Claude Code continues it by itself');
  expect(panelReason('ok')).toBeNull();
});

// A command typed during the wait would replace Claude Code's continuation.
test('a session paused at its usage limit: model, mode, Compact and Clear wait; an ended pause or none is as today', () => {
  const limited = (limitPause?: SessionInfo['limitPause']) => term('error', { errorReason: 'rate_limit', ...(limitPause ? { limitPause } : {}) });
  for (const p of [{ since: 1, resetsAt: 9 }, { since: 1, resetsAt: null }]) {
    expect(panelAvailability(limited(p))).toBe('paused');
    expect(modeAvailability(limited(p))).toBe('paused');
  }
  expect(panelAvailability(limited({ since: 1, resetsAt: 9, over: 'disabled' }))).toBe('ok');
  expect(panelAvailability(limited())).toBe('ok');
  expect(modeAvailability(limited())).toBe('ok');
});

test('choosing a model types exactly "/model opus", then its Enter as a separate write once it has settled', async () => {
  expect(switchModel('a', 'opus')).toBe(true);
  expect(typed()).toEqual(['/model opus']);
  await vi.advanceTimersByTimeAsync(ENTER_FLOOR_MS + 100);
  expect(typed()).toEqual(['/model opus', '\r']);
  expect(typed().join('')).toBe('/model opus\r');
});

test('every action types its exact bytes and nothing else', async () => {
  const bytes = async (run: () => boolean) => { input.mockClear(); expect(run()).toBe(true); await vi.advanceTimersByTimeAsync(ENTER_FLOOR_MS + 100); return typed().join(''); };
  expect(await bytes(() => switchModel('a', 'default'))).toBe('/model default\r');
  expect(await bytes(() => switchModel('a', 'haiku'))).toBe('/model haiku\r');
  expect(await bytes(() => compactSession('a'))).toBe('/compact\r');
  expect(await bytes(() => clearSession('a'))).toBe('/clear\r');
  // Shift+Tab: CSI Z, alone, no Enter.
  expect(await bytes(() => nextMode('a'))).toBe('\x1b[Z');
});

test('no control character ever but the Enter Atelier adds (and Shift+Tab for the mode)', async () => {
  for (const run of [() => switchModel('a', 'sonnet'), () => compactSession('a'), () => clearSession('a')]) {
    input.mockClear();
    run();
    await vi.advanceTimersByTimeAsync(ENTER_FLOOR_MS + 100);
    const parts = typed();
    expect(parts.at(-1)).toBe('\r');
    for (const p of parts.slice(0, -1)) expect(p).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  }
  // A model name from anywhere else is refused, not typed.
  input.mockClear();
  expect(switchModel('a', 'opus\r/clear' as never)).toBe(false);
  expect(input).not.toHaveBeenCalled();
});

test.each([
  ['running', {}, 'Available when Claude is waiting for you'],
  ['waiting', { waitingFor: 'permission' as const }, 'Answer Claude first']
] as const)('not at its prompt (%s): nothing typed, the reason as a toast', async (state, extra, why) => {
  useApp.setState({ terminals: [term(state, extra)] });
  for (const run of [() => switchModel('a', 'opus'), () => compactSession('a'), () => clearSession('a'), () => nextMode('a')]) {
    expect(run()).toBe(false);
    expect(useApp.getState().toast?.text).toBe(why);
  }
  await vi.advanceTimersByTimeAsync(3000);
  expect(input).not.toHaveBeenCalled();
});

test('a draft typed since the last send: every action that sends an Enter types nothing and says why (disabled reason too)', async () => {
  noteInput('a', 'half a prompt');
  expect(panelAvailability(term('done'))).toBe('draft');
  expect(panelReason('draft')).toBe('Send or clear your draft in Claude first (press Enter on an empty prompt).');
  for (const run of [() => switchModel('a', 'opus'), () => compactSession('a'), () => clearSession('a')]) {
    useApp.getState().showToast(null);
    expect(run()).toBe(false);
    expect(useApp.getState().toast?.text).toBe('Send or clear your draft in Claude first (press Enter on an empty prompt).');
  }
  await vi.advanceTimersByTimeAsync(3000);
  expect(input).not.toHaveBeenCalled();
  // Sent (the user's Enter): the exact bytes go out again.
  noteInput('a', '\r');
  expect(panelAvailability(term('done'))).toBe('ok');
  expect(switchModel('a', 'sonnet')).toBe(true);
  await vi.advanceTimersByTimeAsync(ENTER_FLOOR_MS + 100);
  expect(typed().join('')).toBe('/model sonnet\r');
});

test('Next mode over a draft: Shift+Tab sends no Enter, so it goes (task → plan mode → send); the draft stays', async () => {
  noteInput('a', 'the task prompt, typed and not sent');
  expect(modeAvailability(term('done'))).toBe('ok');
  expect(nextMode('a')).toBe(true);
  await vi.advanceTimersByTimeAsync(ENTER_FLOOR_MS + 100);
  expect(typed()).toEqual(['\x1b[Z']);
  expect(hasDraft('a')).toBe(true);
  // Its own rules stay: not at the prompt, a dialog, a compaction, a command waiting for its Enter.
  expect(modeAvailability(term('running'))).toBe('busy');
  expect(modeAvailability(term('waiting', { waitingFor: 'permission' }))).toBe('waiting');
  expect(modeAvailability(term('done', { compacting: true }))).toBe('busy');
  expect(modeAvailability(term('done', {}, 'vim'))).toBe('busy');
  forgetDraft('a');
  switchModel('a', 'opus');
  expect(modeAvailability(useApp.getState().terminals[0])).toBe('busy');
  expect(nextMode('a')).toBe(false);
});

test('keys typed while a command waits for its Enter go after it, never into the command', async () => {
  expect(switchModel('a', 'opus')).toBe(true);
  // The keyboard is the terminal's at once: the user types before the Enter has gone.
  sendInput('a', 'fix the');
  sendInput('a', ' bug');
  expect(typed()).toEqual(['/model opus']);
  await vi.advanceTimersByTimeAsync(ENTER_FLOOR_MS + 100);
  expect(typed()).toEqual(['/model opus', '\r', 'fix the', ' bug']);
  // What was typed is a draft now, in the prompt, unsent.
  expect(hasDraft('a')).toBe(true);
  // Afterwards straight through again.
  sendInput('a', '!');
  expect(typed().at(-1)).toBe('!');
});

test('after an app restart or a reload, a session already running counts as a draft until the user\'s first Enter there', () => {
  // The terminal list from atelierd: created before this window started.
  useApp.getState().applyTerminals([term('done')]);
  expect(panelAvailability(useApp.getState().terminals[0])).toBe('draft');
  expect(switchModel('a', 'opus')).toBe(false);
  expect(input).not.toHaveBeenCalled();
  // Shift+Tab sends no Enter: fine.
  expect(modeAvailability(useApp.getState().terminals[0])).toBe('ok');
  sendInput('a', '\r');
  expect(panelAvailability(useApp.getState().terminals[0])).toBe('ok');
  // A session started in this window: nothing unseen.
  useApp.getState().applyTerminals([term('done'), { ...term('done'), id: 'n', createdAt: Date.now() + 60_000 }]);
  expect(panelAvailability(useApp.getState().terminals.find((x) => x.id === 'n'))).toBe('ok');
  useApp.getState().applyTerminals([]);
});

test('the store tells the draft follower when Claude shows a dialog: its Enter keeps a draft typed ahead', () => {
  useApp.setState({ terminals: [term('waiting', { waitingFor: 'permission' })] });
  sendInput('a', 'typed ahead');
  sendInput('a', '\r');
  expect(hasDraft('a')).toBe(true);
  useApp.setState({ terminals: [term('done')] });
  sendInput('a', '\r');
  expect(hasDraft('a')).toBe(false);
});

test('a terminal that closes forgets its draft', () => {
  noteInput('a', 'x');
  useApp.getState().applyTerminals([]);
  expect(hasDraft('a')).toBe(false);
});

test('the panel\'s own typing is never taken for a draft', async () => {
  compactSession('a');
  await vi.advanceTimersByTimeAsync(ENTER_FLOOR_MS + 100);
  expect(hasDraft('a')).toBe(false);
});

test('in flight: while its Enter is pending, or during a compaction, a second action types nothing', async () => {
  expect(switchModel('a', 'opus')).toBe(true);
  expect(panelAvailability(useApp.getState().terminals[0])).toBe('busy');
  expect(compactSession('a')).toBe(false);
  expect(useApp.getState().toast?.text).toBe('Available when Claude is waiting for you');
  await vi.advanceTimersByTimeAsync(ENTER_FLOOR_MS + 100);
  expect(typed()).toEqual(['/model opus', '\r']);
  expect(panelAvailability(useApp.getState().terminals[0])).toBe('ok');
  // Compacting (PreCompact → PostCompact): busy.
  useApp.setState({ terminals: [term('done', { compacting: true })] });
  expect(panelAvailability(useApp.getState().terminals[0])).toBe('busy');
  expect(nextMode('a')).toBe(false);
  // A terminal closed with an Enter pending doesn't stay busy for ever.
  useApp.setState({ terminals: [term('done')] });
  switchModel('a', 'haiku');
  useApp.setState({ terminals: [] });
  await vi.advanceTimersByTimeAsync(3000);
  useApp.setState({ terminals: [term('done')] });
  expect(panelAvailability(useApp.getState().terminals[0])).toBe('ok');
});

test('the Enter is dropped if the terminal closes before it goes', async () => {
  switchModel('a', 'opus');
  useApp.setState({ terminals: [] });
  await vi.advanceTimersByTimeAsync(3000);
  expect(typed()).toEqual(['/model opus']);
});

test('after typing, the panel closes and the keyboard goes to the terminal', async () => {
  const focused: string[] = [];
  setTerminalFocuser((id) => focused.push(id));
  useApp.setState({ sessionPanel: 'a' });
  compactSession('a');
  expect(useApp.getState().sessionPanel).toBeNull();
  await vi.advanceTimersByTimeAsync(10);
  expect(focused).toEqual(['a']);
});

test('opening it (palette, menus) shows the session first, then the panel', async () => {
  useApp.setState({ terminals: [term('done'), { ...term('done'), id: 'b' }], selectedId: 'a', activeTab: 'f:/p/x.ts' });
  openSessionPanel('b');
  expect(useApp.getState().selectedId).toBe('b');
  expect(useApp.getState().activeTab).toBe('term');
  await vi.advanceTimersByTimeAsync(10);
  expect(useApp.getState().sessionPanel).toBe('b');
  // A plain terminal has no panel.
  useApp.setState({ sessionPanel: null, terminals: [term(null)] });
  openSessionPanel('a');
  await vi.advanceTimersByTimeAsync(10);
  expect(useApp.getState().sessionPanel).toBeNull();
});

test('View › Session Panel: the selected session, else the last one selected, else it says there is none', async () => {
  useApp.setState({ terminals: [term('done'), { ...term(null), id: 'p' }], selectedId: 'a', lastSession: null });
  openSelectedSessionPanel();
  await vi.advanceTimersByTimeAsync(10);
  expect(useApp.getState().sessionPanel).toBe('a');
  useApp.setState({ sessionPanel: null, selectedId: 'p', lastSession: 'a' });
  openSelectedSessionPanel();
  await vi.advanceTimersByTimeAsync(10);
  expect(useApp.getState().sessionPanel).toBe('a');
  useApp.setState({ sessionPanel: null, terminals: [{ ...term(null), id: 'p' }], selectedId: 'p', lastSession: null });
  openSelectedSessionPanel();
  await vi.advanceTimersByTimeAsync(10);
  expect(useApp.getState().sessionPanel).toBeNull();
  expect(useApp.getState().toast?.text).toBe('No Claude session to show');
});

test('another session in front, the palette, Settings or the notifications close it', () => {
  useApp.setState({ terminals: [term('done'), { ...term('done'), id: 'b' }], sessionPanel: 'a' });
  useApp.getState().select('a');
  expect(useApp.getState().sessionPanel).toBe('a');
  useApp.getState().select('b');
  expect(useApp.getState().sessionPanel).toBeNull();
  for (const open of [() => useApp.getState().setPaletteOpen(true), () => useApp.getState().setSettingsOpen('appearance'), () => useApp.getState().setNotesOpen(true)]) {
    useApp.setState({ sessionPanel: 'a', paletteOpen: false, settingsOpen: null, notesOpen: false });
    open();
    expect(useApp.getState().sessionPanel).toBeNull();
  }
  useApp.setState({ paletteOpen: false, settingsOpen: null, notesOpen: false });
});

test('a session that ends closes its panel', () => {
  useApp.setState({ sessionPanel: 'a' });
  useApp.getState().applyTerminals([term(null)]);
  expect(useApp.getState().sessionPanel).toBeNull();
  useApp.setState({ sessionPanel: 'a' });
  useApp.getState().applyTerminals([term('running')]);
  expect(useApp.getState().sessionPanel).toBe('a');
});
