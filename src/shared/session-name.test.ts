import { describe, expect, test } from 'vitest';
import { NO_NAME, historyResumeTitle, onNameHook, onNameStatus, renamed, resumedName, terminalTitle, visibleSync, type NameState } from './session-name';

const prompt = (session_title?: string) => ({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'x', ...(session_title === undefined ? {} : { session_title }) });
const start = (session_title?: string) => ({ hook_event_name: 'SessionStart', session_id: 's1', source: 'resume', ...(session_title === undefined ? {} : { session_title }) });
const reply = (hookEventName: string, sessionTitle: string) => ({ hookSpecificOutput: { hookEventName, sessionTitle } });

describe('renamed', () => {
  test('a name is pending until Claude reports it', () => {
    expect(renamed('Login bug')).toEqual({ name: 'Login bug', sync: 'pending' });
  });
  test('no name, an empty one or only invisible characters: no name', () => {
    expect(renamed(null)).toEqual(NO_NAME);
    expect(renamed('   ')).toEqual(NO_NAME);
    expect(renamed('​‮\n')).toEqual(NO_NAME);
  });
  test('control and invisible characters go, whitespace collapses, at most 200 characters', () => {
    expect(renamed(' a\tb\u0007c​d‮ ').name).toBe('a b c d');
    expect([...renamed('é'.repeat(300)).name!].length).toBe(200);
  });
});

describe('onNameHook', () => {
  const pending: NameState = { name: 'Login bug', sync: 'pending' };

  test('pending: the next prompt carries the name to Claude', () => {
    expect(onNameHook(pending, prompt())).toEqual({ state: { name: 'Login bug', sync: 'sent', before: null }, reply: reply('UserPromptSubmit', 'Login bug') });
    // What Claude was called when the name was sent: its next report is a verdict only if it differs.
    expect(onNameHook(pending, prompt('Old name'))).toEqual({ state: { name: 'Login bug', sync: 'sent', before: 'Old name' }, reply: reply('UserPromptSubmit', 'Login bug') });
  });
  test('pending: a resume or a new conversation carries it too', () => {
    expect(onNameHook(pending, start())).toEqual({ state: { name: 'Login bug', sync: 'sent', before: null }, reply: reply('SessionStart', 'Login bug') });
  });
  test('pending: Claude already has that name (claude --name) → synced, nothing sent', () => {
    expect(onNameHook(pending, start('Login bug'))).toEqual({ state: { name: 'Login bug', sync: 'synced' }, reply: null });
  });
  test('other events never reply and change nothing', () => {
    for (const e of ['PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'PermissionRequest', 'SessionEnd']) {
      expect(onNameHook(pending, { hook_event_name: e, session_id: 's1', session_title: 'X' })).toEqual({ state: pending, reply: null });
    }
  });
  test('no name: nothing to send, whatever Claude reports', () => {
    expect(onNameHook(NO_NAME, prompt('Claude name'))).toEqual({ state: NO_NAME, reply: null });
    expect(onNameHook(NO_NAME, prompt())).toEqual({ state: NO_NAME, reply: null });
  });
  test('sent: Claude reports the name → synced', () => {
    expect(onNameHook({ name: 'Login bug', sync: 'sent' }, prompt('Login bug'))).toEqual({ state: { name: 'Login bug', sync: 'synced' }, reply: null });
  });
  test('sent: Claude settled on a variant → adopted, never sent again', () => {
    expect(onNameHook({ name: 'Login bug', sync: 'sent' }, prompt('Login bug 2'))).toEqual({ state: { name: 'Login bug 2', sync: 'synced' }, reply: null });
  });
  test('sent: Claude reports no name back → kept in Atelier only, never sent again', () => {
    const r = onNameHook({ name: 'Login bug', sync: 'sent', before: null }, prompt());
    expect(r).toEqual({ state: { name: 'Login bug', sync: 'kept' }, reply: null });
    expect(onNameHook(r.state, prompt()).reply).toBeNull();
  });
  test('sent: Claude still reports the name it had before (the reply was lost, or ignored) → kept, not reverted', () => {
    expect(onNameHook({ name: 'Login bug', sync: 'sent', before: 'Old name' }, prompt('Old name'))).toEqual({ state: { name: 'Login bug', sync: 'kept' }, reply: null });
    // Then a rename inside Claude is still adopted.
    expect(onNameHook({ name: 'Login bug', sync: 'kept' }, prompt('Auth flow')).state).toEqual({ name: 'Auth flow', sync: 'synced' });
  });
  test('synced or kept: a rename inside Claude is adopted', () => {
    expect(onNameHook({ name: 'Login bug', sync: 'synced' }, prompt('Auth flow'))).toEqual({ state: { name: 'Auth flow', sync: 'synced' }, reply: null });
    expect(onNameHook({ name: 'Login bug', sync: 'kept' }, prompt('Auth flow'))).toEqual({ state: { name: 'Auth flow', sync: 'synced' }, reply: null });
  });
  test('synced: a conversation with no custom title (after /clear) changes nothing', () => {
    expect(onNameHook({ name: 'Login bug', sync: 'synced' }, start())).toEqual({ state: { name: 'Login bug', sync: 'synced' }, reply: null });
  });
  test('the reply is plain JSON-safe data: quotes and backslashes survive a round trip', () => {
    const r = onNameHook(renamed('say "hi" \\ there'), prompt());
    expect(JSON.parse(JSON.stringify(r.reply))).toEqual(reply('UserPromptSubmit', 'say "hi" \\ there'));
  });
  test('malformed payloads: nothing', () => {
    for (const p of [null, 'x', 3, [], { hook_event_name: 7 }]) expect(onNameHook(pending, p)).toEqual({ state: pending, reply: null });
  });
});

describe('onNameStatus', () => {
  test('sent: the status line showing the name confirms it', () => {
    expect(onNameStatus({ name: 'Login bug', sync: 'sent' }, { session_id: 's1', session_name: 'Login bug' }, 's1')).toEqual({ name: 'Login bug', sync: 'synced' });
  });
  test('another session\'s status line (a nested claude) never confirms', () => {
    expect(onNameStatus({ name: 'Login bug', sync: 'sent' }, { session_id: 's2', session_name: 'Login bug' }, 's1')).toEqual({ name: 'Login bug', sync: 'sent' });
  });
  test('sent: another name in the status line (an AI title, a stale render) is not a verdict', () => {
    expect(onNameStatus({ name: 'Login bug', sync: 'sent' }, { session_id: 's1', session_name: 'Fix the login' }, 's1')).toEqual({ name: 'Login bug', sync: 'sent' });
  });
  test('pending: the status line never confirms (it may show an AI title that happens to match)', () => {
    expect(onNameStatus({ name: 'Login bug', sync: 'pending' }, { session_id: 's1', session_name: 'Login bug' }, 's1')).toEqual({ name: 'Login bug', sync: 'pending' });
  });
});

describe('visibleSync', () => {
  test('only for a named terminal with a Claude session', () => {
    expect(visibleSync({ name: 'A', sync: 'pending' }, true)).toBe('pending');
    expect(visibleSync({ name: 'A', sync: 'sent' }, true)).toBe('pending');
    expect(visibleSync({ name: 'A', sync: 'kept' }, true)).toBe('kept');
    expect(visibleSync({ name: 'A', sync: 'synced' }, true)).toBeUndefined();
    expect(visibleSync({ name: 'A', sync: 'pending' }, false)).toBeUndefined();
    expect(visibleSync(NO_NAME, true)).toBeUndefined();
  });
});

describe('resumedName', () => {
  test('as saved; a send whose verdict was lost in the restart is pending again; no state = Atelier-only', () => {
    expect(resumedName({ name: 'Auth  flow', nameSync: 'synced' })).toEqual({ name: 'Auth  flow', sync: 'synced' });
    expect(resumedName({ name: 'A', nameSync: 'pending' })).toEqual({ name: 'A', sync: 'pending' });
    expect(resumedName({ name: 'A', nameSync: 'sent' })).toEqual({ name: 'A', sync: 'pending' });
    expect(resumedName({ name: 'A', nameSync: 'kept' })).toEqual({ name: 'A', sync: 'kept' });
    expect(resumedName({ name: 'A' })).toEqual({ name: 'A', sync: 'kept' });
    expect(resumedName({ name: null })).toEqual(NO_NAME);
    expect(resumedName({})).toEqual(NO_NAME);
  });
});

describe('historyResumeTitle', () => {
  test('with name sync: a display-only label (Claude has its own name); before it: the name, as always', () => {
    expect(historyResumeTitle('Fix the login flow', true)).toEqual({ label: 'Fix the login flow' });
    expect(historyResumeTitle('Fix the login flow', false)).toEqual({ name: 'Fix the login flow' });
  });
  test('at most 80 characters', () => {
    expect(historyResumeTitle('x'.repeat(200), true)).toEqual({ label: 'x'.repeat(80) });
  });
});

describe('terminalTitle', () => {
  const fallback = () => 'Claude · app';
  const session = (title: string | null, autoTitle: string | null = null) => ({ title, autoTitle });

  test('a name not yet synced wins over Claude\'s', () => {
    expect(terminalTitle({ name: 'Login bug', sync: 'pending' }, null, session('AI title'), fallback)).toBe('Login bug');
    expect(terminalTitle({ name: 'Login bug', sync: 'kept' }, null, session('AI title'), fallback)).toBe('Login bug');
  });
  test('synced: Claude\'s live name', () => {
    expect(terminalTitle({ name: 'Login bug', sync: 'synced' }, null, session('Login bug 2'), fallback)).toBe('Login bug 2');
  });
  test('no name: Claude\'s title, then the label, then the first prompt, then the fallback', () => {
    expect(terminalTitle(NO_NAME, 'History title', session('AI title', 'first prompt'), fallback)).toBe('AI title');
    expect(terminalTitle(NO_NAME, 'History title', session(null, 'first prompt'), fallback)).toBe('History title');
    expect(terminalTitle(NO_NAME, null, session(null, 'first prompt'), fallback)).toBe('first prompt');
    expect(terminalTitle(NO_NAME, null, session(null), fallback)).toBe('Claude · app');
  });
  test('no Claude session: the name, then the label, then the fallback (computed only when needed)', () => {
    let calls = 0;
    const counted = () => { calls++; return 'Terminal 3'; };
    expect(terminalTitle({ name: 'Build', sync: 'synced' }, 'L', null, counted)).toBe('Build');
    expect(terminalTitle(NO_NAME, 'L', null, counted)).toBe('L');
    expect(calls).toBe(0);
    expect(terminalTitle(NO_NAME, null, null, counted)).toBe('Terminal 3');
  });
});
