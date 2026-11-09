import { describe, expect, test } from 'vitest';
import type { Attribution } from '@shared/attribution';
import { DEFAULT_ACCOUNTS, type ClaudeAccounts } from '@shared/claude-accounts';
import type { Binding } from '@shared/companion/types';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import { branchAt, companionAccountDir, companionFacts, sessionFiles } from './wiring';

// What main hands the Ask service: the account a run uses, and the facts it is told.

const SID = '0b5c8f0e-1111-4222-8333-944455556666';
const OTHER = '99999999-2222-4333-8444-555555555555';
const ACCOUNTS: ClaudeAccounts = {
  ...DEFAULT_ACCOUNTS,
  list: [...DEFAULT_ACCOUNTS.list, { id: 'work', name: 'Work', dir: '/Users/x/.claude-work', color: 2 }]
};

describe('the account a run uses', () => {
  const DEFAULT_DIR = '/Users/x/.claude';
  const dir = (choice: string, session: string | null) => companionAccountDir(ACCOUNTS, DEFAULT_DIR, choice, session);

  test("'session' and an id no longer configured: the session's own dir; an account: its launch dir; the default: none", () => {
    expect(dir('session', '/Users/x/.claude-work')).toBe('/Users/x/.claude-work');
    expect(dir('session', null)).toBeNull();
    expect(dir('work', null)).toBe('/Users/x/.claude-work');
    // Never an explicit default dir (Claude Code keys its sign-in on the dir it is given).
    expect(dir('default', '/Users/x/.claude-work')).toBeNull();
    expect(dir('removed', '/Users/x/.claude-work')).toBe('/Users/x/.claude-work');
    expect(dir('removed', null)).toBeNull();
  });

  test("the session's own dir only when it is a configured account's: the default's, a removed or unknown one → none", () => {
    expect(dir('session', DEFAULT_DIR)).toBeNull();
    expect(dir('session', '/Users/x/.claude-removed')).toBeNull();
    expect(dir('session', '/etc')).toBeNull();
    expect(dir('removed', '/etc')).toBeNull();
  });
});

describe("a session's files", () => {
  const a = (path: string, o: Partial<Attribution> = {}): Attribution => ({ path, terminalId: 't1', sessionId: SID, color: '#fff', title: 'S', at: 10, ...o });

  test("the session's sure ones in the project, relative, newest time per path, oldest first", () => {
    const list = [
      a('/p/acme/src/a.ts', { at: 30 }),
      a('/p/acme/src/a.ts', { at: 50 }),
      a('/p/acme/README.md', { at: 20 }),
      a('/p/acme/src/b.ts', { sessionId: OTHER }),
      a('/p/acme/src/c.ts', { unclear: ['t1', 't2'] }),
      a('/p/acme/src/d.ts', { maybe: true }),
      a('/p/acme/src/e.ts', { via: 'bash', resolved: true, at: 40 }),
      a('/p/acme-other/x.ts'),
      a('/elsewhere/y.ts')
    ];
    expect(sessionFiles(list, '/p/acme', SID)).toEqual([
      { rel: 'README.md', at: 20 }, { rel: 'src/e.ts', at: 40 }, { rel: 'src/a.ts', at: 50 }
    ]);
  });

  test('none', () => {
    expect(sessionFiles([], '/p/acme', SID)).toEqual([]);
  });
});

describe('the branch', () => {
  const s = (root: string, branch: string | null) => ({ root, branch });

  test("the deepest repository holding the session's folder; none, or a detached HEAD: null", () => {
    const statuses = [s('/p/acme', 'main'), s('/p/acme/.claude/worktrees/x', 'feat-x'), s('/p/acme-two', 'dev')];
    expect(branchAt(statuses, '/p/acme')).toBe('main');
    expect(branchAt(statuses, '/p/acme/src')).toBe('main');
    expect(branchAt(statuses, '/p/acme/.claude/worktrees/x/src')).toBe('feat-x');
    expect(branchAt(statuses, '/p/acme-two/a')).toBe('dev');
    expect(branchAt(statuses, '/q')).toBeNull();
    expect(branchAt([s('/p/acme', null)], '/p/acme')).toBeNull();
    expect(branchAt([], '/p/acme')).toBeNull();
  });
});

describe('the facts', () => {
  const session = (o: Partial<SessionInfo> = {}): SessionInfo => ({
    sessionId: SID, state: 'running', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0,
    model: 'Opus 4.5', cost: { usd: 1.25, linesAdded: 12, linesRemoved: 3 }, ...o
  });
  const term = (s: SessionInfo | null): TerminalInfo => ({ id: 't1', projectRoot: '/p/acme', cwd: '/p/acme', title: 'S', name: null, color: '#fff', foreground: 'claude', createdAt: 0, session: s });
  const b: Binding = { terminalId: 't1', sessionId: SID, cwd: '/p/acme', configDir: null, title: 'S' };
  const files = [{ rel: 'src/a.ts', at: 5 }, { rel: 'src/b.ts', at: 6 }];

  test('a live session: its state, lines, cost, model, files and branch', () => {
    expect(companionFacts(term(session()), b, { files, branch: 'main', now: 100 })).toEqual({
      facts: { state: 'working', since: null, work: null, files: 2, added: 12, removed: 3 },
      waiting: null, files, costUsd: 1.25, branch: 'main', model: 'Opus 4.5'
    });
  });

  test('waiting: what for, from its activity', () => {
    const permission = companionFacts(term(session({ state: 'waiting', waitingFor: 'permission', activity: 'waiting: Bash npm test' })), b, { files: [], branch: null, now: 1 });
    expect(permission.facts.state).toBe('waiting');
    expect(permission.waiting).toBe('permission: Bash npm test');
    expect(companionFacts(term(session({ state: 'waiting', waitingFor: 'question', activity: 'waiting for you' })), b, { files: [], branch: null, now: 1 }).waiting).toBe('an answer to its question');
    expect(companionFacts(term(session({ state: 'idle', waitingFor: 'input', activity: null })), b, { files: [], branch: null, now: 1 }).waiting).toBeNull();
  });

  test('an ended session (no session in its terminal, another session there now, or no terminal): ended, its files still told', () => {
    const ended = { facts: { state: 'ended', since: null, work: null, files: 2, added: 0, removed: 0 }, waiting: null, files, costUsd: null, branch: 'main', model: null };
    expect(companionFacts(term(null), b, { files, branch: 'main', now: 1 })).toEqual(ended);
    expect(companionFacts(term(session({ sessionId: OTHER })), b, { files, branch: 'main', now: 1 })).toEqual(ended);
    expect(companionFacts(null, b, { files, branch: 'main', now: 1 })).toEqual(ended);
  });
});
