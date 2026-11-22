import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import { projectIdOf, remoteState } from './state';

const term = (id: string, projectRoot: string, o: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id, projectRoot, cwd: projectRoot, title: `T ${id}`, name: null, color: '#fff', foreground: 'zsh', createdAt: 0, session: null, ...o
});
const session = (s: Partial<SessionInfo>): SessionInfo => ({ sessionId: 's', state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, ...s } as SessionInfo);
const colors = { projectTint: true, projectColors: { '/a': 3 } };

test('a project id: the first 16 characters of base64url(SHA-256(root)), never the path itself', () => {
  expect(projectIdOf('/a')).toBe(createHash('sha256').update('/a').digest('base64url').slice(0, 16));
  expect(projectIdOf('/a')).toHaveLength(16);
});

test('projects: open windows, then projects with live terminals, then recent ones, once each, in that order', () => {
  const s = remoteState({
    terminals: [term('t1', '/live', { createdAt: 5 }), term('t2', '/a', { createdAt: 1 }), term('t3', '/older', { createdAt: 2 })],
    open: ['/a', '/b'], recent: ['/b', '/r', '/live'], colors
  });
  expect(s.projects.map((p) => p.name)).toEqual(['a', 'b', 'older', 'live', 'r']);
  expect(s.projects[0]).toEqual({ id: projectIdOf('/a'), name: 'a', color: 3, open: true });
  expect(s.projects.find((p) => p.name === 'r')?.open).toBe(false);
  expect(s.roots.get(projectIdOf('/r'))).toBe('/r');
  expect(JSON.stringify(s.projects)).not.toContain('/');
});

test('project colors: the window\'s, none with project colors off', () => {
  const on = remoteState({ terminals: [], open: ['/a'], recent: [], colors });
  expect(on.projects[0]!.color).toBe(3);
  const off = remoteState({ terminals: [], open: ['/a'], recent: [], colors: { ...colors, projectTint: false } });
  expect(off.projects[0]!.color).toBeNull();
});

test('sessions: every terminal by age, its project by id, Claude or not, the state Atelier shows', () => {
  const s = remoteState({
    terminals: [
      term('w', '/a', { createdAt: 3, session: session({ state: 'waiting', waitingFor: 'permission' }) }),
      term('q', '/a', { createdAt: 4, session: session({ state: 'waiting', waitingFor: 'question' }) }),
      term('bg', '/a', { createdAt: 2, session: session({ state: 'done' }), work: { counting: true, items: [], crons: [] } as never }),
      // Paused at the usage limit: Claude Code goes on by itself, Atelier shows it idle.
      term('limit', '/a', { createdAt: 5, session: session({ state: 'error', errorReason: 'rate_limit', limitPause: { since: 1, resetsAt: null } } as never) }),
      term('sh', '/a', { createdAt: 1 }),
      term('dev', '/a', { createdAt: 6, foreground: 'npm' }),
      term('err', '/a', { createdAt: 7, session: session({ state: 'error' }) })
    ],
    open: ['/a'], recent: [], colors
  });
  expect(s.sessions.map((x) => [x.id, x.claude, x.state, x.waitingFor ?? null])).toEqual([
    ['sh', false, 'idle', null],
    ['bg', true, 'running', null],
    ['w', true, 'waiting', 'permission'],
    ['q', true, 'waiting', 'question'],
    ['limit', true, 'idle', null],
    ['dev', false, 'running', null],
    ['err', true, 'error', null]
  ]);
  expect(s.sessions[0]).toEqual({ id: 'sh', project: projectIdOf('/a'), title: 'T sh', claude: false, state: 'idle', createdAt: 1 });
  expect('waitingFor' in s.sessions[0]!).toBe(false);
});
