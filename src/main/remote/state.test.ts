import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import { projectIdOf, remoteState, remoteUsage, type StateInput } from './state';

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
  // A color atelierd didn't give as #RRGGBB reads as the first session color.
  expect(s.sessions[0]).toEqual({ id: 'sh', project: projectIdOf('/a'), title: 'T sh', claude: false, state: 'idle', createdAt: 1, section: 'idle', color: '#B794F6', command: 'zsh' });
  expect('waitingFor' in s.sessions[0]!).toBe(false);
});

// ── v1.1: everything a sidebar row shows ──

const NOW = Date.UTC(2026, 10, 23, 12, 0);
const accounts = {
  list: [{ id: 'default', name: 'Claude', dir: '', color: 1 }, { id: 'work', name: 'Work', dir: '/acc/work', color: 4 }],
  newSession: 'default', dismissed: []
};
const full = (o: Partial<StateInput> = {}): StateInput => ({ terminals: [], open: ['/a'], recent: [], colors, now: NOW, accounts, defaultDir: '/home/.claude', ...o });

test('a session carries its section, color, second line, wait, model, context, mode, agents, cost and last message', () => {
  const waiting = session({ state: 'waiting', waitingFor: 'permission', activity: 'waiting: Bash npm test', updatedAt: 9, lastMessageAt: 7, model: 'Opus 5.5', contextPct: 58, permissionMode: 'plan', subagents: 2, cost: { usd: 4.126, linesAdded: 120, linesRemoved: 30 } } as never);
  const s = remoteState(full({ terminals: [term('w', '/a', { color: '#4FC3D9', createdAt: 3, session: waiting })] }));
  const row = s.sessions[0]!;
  expect(row).toMatchObject({
    id: 'w', claude: true, state: 'waiting', waitingFor: 'permission', section: 'needs', color: '#4FC3D9',
    detail: 'Needs permission: Bash npm test', permission: 'Bash npm test', lastMessageAt: 7, model: 'Opus 5.5', contextPct: 58,
    mode: 'plan', agents: 2, cost: { usd: 4.126, added: 120, removed: 30 }
  });
  expect(row.wait).toMatch(/^[A-Za-z0-9_-]{22}$/);
  // Fields with nothing to say are left out.
  expect(Object.keys(row)).not.toContain('unread');
  expect(Object.keys(row)).not.toContain('account');
});

test('finished and unread: Ready for review, no second line; bypass is its own mode', () => {
  const s = remoteState(full({ terminals: [term('d', '/a', { session: session({ state: 'done', unread: true, permissionMode: 'bypassPermissions' } as never) })] }));
  expect(s.sessions[0]).toMatchObject({ section: 'review', unread: true, mode: 'bypass' });
  expect('detail' in s.sessions[0]!).toBe(false);
  expect('wait' in s.sessions[0]!).toBe(false);
});

test('a terminal launched as a session and still starting reads as a Claude session, "Starting…"', () => {
  const s = remoteState(full({ terminals: [term('n', '/a', { foreground: 'zsh' }), term('p', '/a', { foreground: 'npm' })], starting: new Set(['n']) }));
  expect(s.sessions[0]).toMatchObject({ id: 'n', claude: true, starting: true, detail: 'Starting…', section: 'idle' });
  expect('command' in s.sessions[0]!).toBe(false);
  // A plain terminal: its program's name only.
  expect(s.sessions[1]).toMatchObject({ id: 'p', claude: false, command: 'npm' });
  expect('starting' in s.sessions[1]!).toBe(false);
});

test('a plain terminal\'s program: its name, never a path or arguments; Claude Code\'s binary reads as claude', () => {
  const cmd = (foreground: string) => remoteState(full({ terminals: [term('x', '/a', { foreground })] })).sessions[0]!.command;
  expect(cmd('-zsh')).toBe('zsh');
  expect(cmd('/usr/local/bin/node')).toBe('node');
  expect(cmd('2.1.330')).toBe('claude');
});

test('the folder a row runs in when not the project root: its name only', () => {
  const s = remoteState(full({
    terminals: [
      term('r', '/a', { cwd: '/a' }),
      term('sub', '/a', { cwd: '/a/apps/web' }),
      term('wt', '/a', { cwd: '/a/.claude/worktrees/feature-x/', session: session({ cwd: '/a/.claude/worktrees/feature-x' }) }),
      term('real', '/a', { cwd: '/private/a' })
    ],
    realOf: (p) => p.replace(/^\/private/, '')
  }));
  expect(s.sessions.map((x) => x.folder ?? null)).toEqual([null, 'web', 'feature-x', null]);
  expect(JSON.stringify(s.sessions)).not.toContain('/a/');
});

test('an account other than the default: its id; the default one and unknown dirs: none', () => {
  const s = remoteState(full({
    terminals: [
      term('w', '/a', { configDir: '/acc/work', session: session({}) }),
      term('d', '/a', { configDir: '/home/.claude', session: session({}) }),
      term('u', '/a', { configDir: '/somewhere/else', session: session({}) })
    ]
  }));
  expect(s.sessions.map((x) => x.account ?? null)).toEqual(['work', null, null]);
  expect(JSON.stringify(s)).not.toContain('/acc/work');
});

test('ports and the pull request, as the row shows them', () => {
  const s = remoteState(full({
    terminals: [term('a', '/a', { session: session({}) }), term('b', '/a', { session: session({}) }), term('c', '/a', { session: session({}) })],
    ports: (id) => (id === 'a' ? [{ port: 5173, name: 'node' }, { port: 8080 }] : undefined),
    pr: (id) => (id === 'a'
      ? { root: '/a', branch: 'feat', status: 'ok', pr: { number: 42, title: 'Add the thing', url: 'https://github.com/o/r/pull/42', state: 'OPEN', isDraft: true, reviewDecision: null, ci: { state: 'failing', passed: 1, failed: 1, pending: 0, failing: ['lint'] } } }
      : id === 'b' ? { root: '/a', branch: 'x', status: 'ok', pr: { number: 7, title: 'Done', url: 'https://github.com/o/r/pull/7', state: 'MERGED', isDraft: false, reviewDecision: null, ci: { state: 'none', passed: 0, failed: 0, pending: 0, failing: [] } } }
        : id === 'c' ? { root: '/a', branch: 'y', status: 'none' } : undefined)
  }));
  expect(s.sessions[0]).toMatchObject({ ports: [{ port: 5173, name: 'node' }, { port: 8080 }], pr: { number: 42, title: 'Add the thing', state: 'draft', checks: 'fail' } });
  expect(s.sessions[1]!.pr).toEqual({ number: 7, title: 'Done', state: 'merged' });
  expect('pr' in s.sessions[2]!).toBe(false);
  expect('ports' in s.sessions[1]!).toBe(false);
  expect(JSON.stringify(s)).not.toContain('https://');
});

test('resumables of the listed projects, newest first, with their account; never another project\'s', () => {
  const r = (id: string, projectRoot: string, endedAt: number, o: object = {}) => ({ id, projectRoot, cwd: projectRoot, title: `R ${id}`, color: '#F28FAD', sessionId: `s-${id}`, endedAt, ...o });
  const s = remoteState(full({
    resumables: [r('old', '/a', 1), r('new', '/a', 5, { lastMessageAt: 4, configDir: '/acc/work' }), r('far', '/not-listed', 9)]
  }));
  expect(s.resumables).toEqual([
    { id: 'new', project: projectIdOf('/a'), title: 'R new', color: '#F28FAD', endedAt: 5, lastMessageAt: 4, account: 'work' },
    { id: 'old', project: projectIdOf('/a'), title: 'R old', color: '#F28FAD', endedAt: 1 }
  ]);
});

test('usage: the default account and every configured one, names and colors only, live windows in ms', () => {
  const nowSec = NOW / 1000;
  const list = remoteUsage({
    usage: [
      { configDir: '/home/.claude', usage: { fiveHour: { pct: 42, resetsAt: nowSec + 3600 }, sevenDay: { pct: 18, resetsAt: nowSec - 10 }, updatedAt: NOW - 5 } },
      { configDir: '/acc/work', usage: { fiveHour: null, sevenDay: { pct: 80, resetsAt: nowSec + 86400 }, updatedAt: NOW - 9 } }
    ],
    accounts, defaultDir: '/home/.claude', now: NOW
  });
  expect(list).toEqual([
    { id: 'default', name: 'Claude', color: 1, default: true, fiveHour: { pct: 42, resetsAt: (nowSec + 3600) * 1000 }, updatedAt: NOW - 5 },
    { id: 'work', name: 'Work', color: 4, default: false, sevenDay: { pct: 80, resetsAt: (nowSec + 86400) * 1000 }, updatedAt: NOW - 9 }
  ]);
  // An older atelierd sends the default account's usage with no dir.
  const old = remoteUsage({ usage: [{ configDir: null, usage: { fiveHour: { pct: 3, resetsAt: nowSec + 60 }, sevenDay: null, updatedAt: 1 } }], accounts, defaultDir: '/home/.claude', now: NOW });
  expect(old[0]!.fiveHour).toEqual({ pct: 3, resetsAt: (nowSec + 60) * 1000 });
  expect(JSON.stringify(list)).not.toContain('/');
});
