import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '../session';
import type { TerminalInfo } from '../protocol';
import { liveFacts } from './live';

const sess = (o: Partial<SessionInfo>): SessionInfo => ({ sessionId: 's', state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, lastMessageAt: null, model: null, cost: null, waitingFor: null, ...o }) as SessionInfo;
const term = (session: SessionInfo | null, work?: TerminalInfo['work']): TerminalInfo => ({ id: 't', session, work } as TerminalInfo);
const o = { since: 5, files: 3, now: 10 };

describe('liveFacts', () => {
  it('is ended without a terminal or a session', () => {
    expect(liveFacts(null, o)).toMatchObject({ state: 'ended', since: 5, files: 3, work: null, added: 0, removed: 0 });
    expect(liveFacts(term(null), o).state).toBe('ended');
  });
  it('maps running to working, with lines from the cost', () => {
    const f = liveFacts(term(sess({ state: 'running', cost: { usd: 1, linesAdded: 12, linesRemoved: 4 } })), o);
    expect(f).toMatchObject({ state: 'working', added: 12, removed: 4 });
  });
  it('is waiting when the session needs a permission or an answer', () => {
    expect(liveFacts(term(sess({ state: 'waiting', waitingFor: 'permission' })), o).state).toBe('waiting');
  });
  it('maps idle, done and error', () => {
    expect(liveFacts(term(sess({ state: 'idle' })), o).state).toBe('idle');
    expect(liveFacts(term(sess({ state: 'done' })), o).state).toBe('done');
    expect(liveFacts(term(sess({ state: 'error' })), o).state).toBe('error');
  });
  it('works while background work counts, and says what', () => {
    const work = { counting: true, agents: 0, shells: 1, monitors: 0, other: 0, idle: 0, items: [{ kind: 'shell', label: 'x', counted: true }], crons: [] } as unknown as TerminalInfo['work'];
    const f = liveFacts(term(sess({ state: 'idle' }), work), o);
    expect(f.state).toBe('working');
    expect(f.work).toBe('1 shell');
  });
});
