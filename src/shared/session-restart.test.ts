import { describe, expect, test } from 'vitest';
import { EXIT_MS, OTHER_MS, RETURN_MS, SHELL_MS, restartChoice, stepRestart, type RestartObs, type RestartPhase } from './session-restart';

// Restart Session: what a request does, and the steps of a running restart.

describe('restartChoice', () => {
  test('no session: nothing to restart', () => {
    expect(restartChoice('not-claude', 0)).toBe('none');
  });
  test('Claude free with nothing in the background: now; with work running: asked first', () => {
    expect(restartChoice('ok', 0)).toBe('now');
    expect(restartChoice('ok', 3)).toBe('confirm');
  });
  test('Claude working, asking, a draft typed or a panel command pending: armed until done', () => {
    for (const a of ['busy', 'waiting', 'draft'] as const) expect(restartChoice(a, 0), a).toBe('arm');
  });
  test('paused at a usage limit: armed, as for a busy session', () => {
    expect(restartChoice('paused', 0)).toBe('arm');
    expect(restartChoice('paused', 2)).toBe('arm');
  });
});

const obs = (o: Partial<RestartObs> = {}): RestartObs => ({ now: 1000, listed: true, sessionId: 'S', foreground: 'claude', shellReady: false, ...o });
const exiting: RestartPhase = { kind: 'exiting', since: 0 };

describe('stepRestart', () => {
  test('exiting: Claude quits → the shell; still there after EXIT_MS → noExit (nothing more typed)', () => {
    expect(stepRestart(exiting, 'S', obs({ sessionId: 'S', now: EXIT_MS - 1 }))).toEqual({ phase: exiting });
    expect(stepRestart(exiting, 'S', obs({ sessionId: null, foreground: 'zsh', now: 500 }))).toEqual({ phase: { kind: 'shell', since: 500, otherSince: null } });
    expect(stepRestart(exiting, 'S', obs({ sessionId: 'S', now: EXIT_MS + 1 }))).toEqual({ done: 'noExit' });
  });

  test('shell: ready → types the command and waits for the session; the terminal gone → gone', () => {
    const shell: RestartPhase = { kind: 'shell', since: 0, otherSince: null };
    expect(stepRestart(shell, 'S', obs({ sessionId: null, foreground: 'zsh', now: 100 }))).toEqual({ phase: shell });
    expect(stepRestart(shell, 'S', obs({ sessionId: null, foreground: 'zsh', shellReady: true, now: 300 }))).toEqual({ phase: { kind: 'relaunching', since: 300 }, type: true });
    expect(stepRestart(shell, 'S', obs({ listed: false }))).toEqual({ done: 'gone' });
  });

  test('shell: another program in front (tmux, a wrapper) for OTHER_MS → notShell; a shell never ready → notShell', () => {
    const shell: RestartPhase = { kind: 'shell', since: 0, otherSince: null };
    const s1 = stepRestart(shell, 'S', obs({ sessionId: null, foreground: 'tmux', now: 100 }));
    expect(s1).toEqual({ phase: { kind: 'shell', since: 0, otherSince: 100 } });
    expect(stepRestart((s1 as { phase: RestartPhase }).phase, 'S', obs({ sessionId: null, foreground: 'tmux', now: 100 + OTHER_MS + 1 }))).toEqual({ done: 'notShell' });
    // The shell back in front: the clock of the other program starts over.
    expect(stepRestart({ kind: 'shell', since: 0, otherSince: 100 }, 'S', obs({ sessionId: null, foreground: 'zsh', now: 200 }))).toEqual({ phase: { kind: 'shell', since: 0, otherSince: null } });
    expect(stepRestart(shell, 'S', obs({ sessionId: null, foreground: 'zsh', now: SHELL_MS + 1 }))).toEqual({ done: 'notShell' });
  });

  test('shell: Claude\'s own process still in front while it winds down is no other program (until SHELL_MS)', () => {
    const shell: RestartPhase = { kind: 'shell', since: 0, otherSince: null };
    expect(stepRestart(shell, 'S', obs({ sessionId: null, foreground: '2.1.302', now: OTHER_MS + 500 }))).toEqual({ phase: shell });
    expect(stepRestart(shell, 'S', obs({ sessionId: null, foreground: 'claude', now: SHELL_MS + 1 }))).toEqual({ done: 'notShell' });
  });

  test('relaunching: the session back (same id) → ok; none after RETURN_MS → noReturn', () => {
    const r: RestartPhase = { kind: 'relaunching', since: 0 };
    expect(stepRestart(r, 'S', obs({ sessionId: null, foreground: 'claude', now: 100 }))).toEqual({ phase: r });
    expect(stepRestart(r, 'S', obs({ sessionId: 'S' }))).toEqual({ done: 'ok' });
    expect(stepRestart(r, 'S', obs({ sessionId: null, now: RETURN_MS + 1 }))).toEqual({ done: 'noReturn' });
    expect(stepRestart(r, 'S', obs({ listed: false }))).toEqual({ done: 'gone' });
  });

  test('relaunching: a session back under another id (--fork-session among the launch flags) is back too (review 2)', () => {
    expect(stepRestart({ kind: 'relaunching', since: 0 }, 'S', obs({ sessionId: 'OTHER' }))).toEqual({ done: 'ok' });
  });

  test('a slow exit (MCP servers closing, the Enter\'s own settle wait) has 8 s (review 13)', () => {
    expect(EXIT_MS).toBe(8_000);
  });

  test('a Claude back in the shell before Atelier typed (someone resumed it by hand): done', () => {
    expect(stepRestart({ kind: 'shell', since: 0, otherSince: null }, 'S', obs({ sessionId: 'S' }))).toEqual({ done: 'ok' });
  });
});
