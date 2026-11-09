import { describe, expect, test } from 'vitest';
import { EDITOR_FILE, askOwner, backgroundOwner, openSteps, type OpenScreen } from './open-view';

// What opening a view does (a feature row's "Try it", a "Things to try" item): it shows its
// view, and opening again (a second Try it, Back then Forward) must not change what is shown.

type Term = OpenScreen['terminals'][number];
const term = (id: string, title: string, entries = 0, crons = 0): Term => ({
  id, title, work: { entries: Array.from({ length: entries }, (_, i) => ({ id: `${id}-${i}` })), crons: Array.from({ length: crons }, (_, i) => ({ id: `${id}-c${i}` })) }
});
const auth = term('t-auth', 'auth-refactor');
const billing = (n: number) => term('t-billing', 'billing-tests', n);
const docs = term('t-docs', 'docs', 0, 1);
const screen = (o: Partial<OpenScreen> = {}): OpenScreen => ({ split: false, terminals: [auth, billing(3), docs], selected: 'auth-refactor', sheet: null, ...o });

describe('openSteps', () => {
  test('a sheet left open (New Session from the accounts row, ⌘K, Settings) is closed first: the view is never under it', () => {
    for (const sheet of ['new-session', 'other'] as const) {
      expect(openSteps('view-docker', screen({ sheet })), sheet).toEqual([{ kind: 'close-sheet' }, { kind: 'command', command: 'view-docker' }]);
      expect(openSteps('demo:editor', screen({ sheet }))[0], sheet).toEqual({ kind: 'close-sheet' });
    }
    expect(openSteps('view-docker', screen())).toEqual([{ kind: 'command', command: 'view-docker' }]);
  });

  test('New Session as an account: an open New Session sheet stays (it switches account, the name typed stays); another sheet closes', () => {
    expect(openSteps('new-session-account:work', screen({ sheet: 'new-session' }))).toEqual([{ kind: 'command', command: 'new-session-account:work' }]);
    expect(openSteps('new-session-account:work', screen({ sheet: 'other' }))).toEqual([{ kind: 'close-sheet' }, { kind: 'command', command: 'new-session-account:work' }]);
  });

  test('split-right opens a split only when there is none yet', () => {
    expect(openSteps('split-right', screen())).toEqual([{ kind: 'command', command: 'split-right' }]);
    expect(openSteps('split-right', screen({ split: true }))).toEqual([]);
  });

  test('the other menu views are states already: always sent as they are', () => {
    for (const v of ['view-sessions', 'view-docker', 'view-redis', 'view-files', 'review-all', 'open-palette'] as const) {
      expect(openSteps(v, screen({ split: true })), v).toEqual([{ kind: 'command', command: v }]);
      expect(openSteps(v, screen()), v).toEqual([{ kind: 'command', command: v }]);
    }
  });

  test('Background: first the session with live background work (the command shows the selected one), then the view', () => {
    expect(openSteps('show-background', screen())).toEqual([{ kind: 'select', id: 't-billing' }, { kind: 'command', command: 'show-background' }]);
    // Already on a session with background work: it stays.
    expect(openSteps('show-background', screen({ selected: 'docs' }))).toEqual([{ kind: 'command', command: 'show-background' }]);
    // Nobody has any: the view as it is (its empty state is the truth).
    expect(openSteps('show-background', screen({ terminals: [auth] }))).toEqual([{ kind: 'command', command: 'show-background' }]);
  });

  test('the editor (a demo view): Files, and a file the sessions changed open in the focused pane; never a split', () => {
    const steps = [{ kind: 'command', command: 'view-files' }, { kind: 'open-file', rel: EDITOR_FILE }];
    expect(openSteps('demo:editor', screen())).toEqual(steps);
    expect(openSteps('demo:editor', screen({ split: true }))).toEqual(steps);
    expect(EDITOR_FILE).toBe('src/auth/session.ts');
  });

  test('Ask (a demo view): a session at work selected, then Ask opened on it unless it is open already (never toggled shut)', () => {
    const at = screen({ terminals: [{ ...auth, session: { state: 'waiting' } }, { ...billing(3), session: { state: 'running' } }, { ...docs, session: { state: 'running' } }] });
    expect(openSteps('demo:ask', at)).toEqual([{ kind: 'select', id: 't-billing' }, { kind: 'ask', id: 't-billing' }]);
    // Already on a session at work: it stays.
    expect(openSteps('demo:ask', { ...at, selected: 'docs' })).toEqual([{ kind: 'ask', id: 't-docs' }]);
    // A sheet over the app closes first, as for every view.
    expect(openSteps('demo:ask', { ...at, sheet: 'other' })[0]).toEqual({ kind: 'close-sheet' });
  });

  test('the JSON tree (a demo view): Files, package.json open, Split Preview (idempotent: never toggled back)', () => {
    const steps = [{ kind: 'command', command: 'view-files' }, { kind: 'open-file', rel: 'package.json' }, { kind: 'command', command: 'md-split' }];
    expect(openSteps('demo:json', screen())).toEqual(steps);
    expect(openSteps('demo:json', screen({ split: true }))).toEqual(steps);
  });
});

describe('askOwner', () => {
  const s = (t: Term, state: string | null): Term => ({ ...t, session: state ? { state } : null });
  test('a session at work, the one with the most background work first (billing-tests while it runs), else docs', () => {
    expect(askOwner([s(auth, 'waiting'), s(billing(3), 'running'), s(docs, 'running')], null)).toBe('t-billing');
    expect(askOwner([s(auth, 'waiting'), s(billing(1), 'done'), s(docs, 'running')], null)).toBe('t-docs');
  });

  test('the selected session when it works; nobody at work: the selected session, else the first one', () => {
    expect(askOwner([s(auth, 'running'), s(billing(3), 'running')], 'auth-refactor')).toBe('t-auth');
    expect(askOwner([s(auth, 'done'), s(billing(0), 'done')], 'billing-tests')).toBe('t-billing');
    expect(askOwner([s(auth, 'done'), s(billing(0), 'done')], null)).toBe('t-auth');
    expect(askOwner([{ id: 'x', title: 'Terminal 1', session: null }], null)).toBeNull();
  });
});

describe('backgroundOwner', () => {
  test('running items first (billing-tests while it has some), else scheduled ones (docs), else none', () => {
    expect(backgroundOwner([auth, billing(3), docs], null)).toBe('t-billing');
    expect(backgroundOwner([auth, billing(0), docs], null)).toBe('t-docs');
    expect(backgroundOwner([auth, billing(0)], null)).toBeNull();
    expect(backgroundOwner([auth, { id: 'x', title: 'x' }], null)).toBeNull();
  });

  test('the selected session when it has any: the visitor is not moved for nothing', () => {
    expect(backgroundOwner([auth, billing(3), docs], 'docs')).toBe('t-docs');
    expect(backgroundOwner([auth, billing(3), docs], 'auth-refactor')).toBe('t-billing');
  });
});
