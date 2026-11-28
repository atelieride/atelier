import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import { WaitBook, anyWait } from './rows';
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

test('features: the switches a phone may use, as Settings has them; both off when not given', () => {
  expect(remoteState({ terminals: [], open: [], recent: [], colors }).features).toEqual({ workspacesEverywhere: false, activities: false });
  const on = remoteState({ terminals: [], open: [], recent: [], colors, features: { workspacesEverywhere: true, activities: true } });
  expect(on.features).toEqual({ workspacesEverywhere: true, activities: true });
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

// ── Everything a sidebar row shows ──

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

// ── The details the desktop row shows that the phone gets too: work, wake-ups, profile, worktree ──

const item = (kind: 'agent' | 'shell' | 'monitor' | 'other', counted = true) => ({ kind, label: kind, counted });
const cron = (next: number | null) => ({ id: `c${next}`, label: 'check', schedule: '*/5 * * * *', recurring: true, next });
const withWork = (work: object) => term('w', '/a', { session: session({}), work: { counting: false, crons: [], ...work } as never });

test('sends the work chip\'s counts, idle when only capped items remain, nothing without work', () => {
  const counts = (work: object | undefined) => remoteState(full({ terminals: [work ? withWork(work) : term('w', '/a', { session: session({}) })] })).sessions[0]!.work;
  expect(counts({ items: [item('agent'), item('agent'), item('shell')] })).toEqual({ agents: 2, shells: 1 });
  expect(counts({ items: [item('monitor'), item('other'), item('other')] })).toEqual({ monitors: 1, tasks: 2 });
  expect(counts({ items: [item('shell', false)] })).toEqual({ shells: 1, idle: true });
  expect(counts({ items: [] })).toBeUndefined();
  expect(counts(undefined)).toBeUndefined();
});

test('with work known, the subagent count is the work chip\'s; without it (an older atelierd), the session\'s own', () => {
  const row = (t: TerminalInfo) => remoteState(full({ terminals: [t] })).sessions[0]!;
  // A subagent kept for a server it started: the desktop's chip shows nothing, so the phone gets no agent either.
  const kept = row(term('w', '/a', { session: session({ subagents: 1 } as never), work: { counting: false, crons: [], items: [] } as never }));
  expect('agents' in kept).toBe(false);
  expect('work' in kept).toBe(false);
  const counted = row(term('w', '/a', { session: session({ subagents: 3 } as never), work: { counting: true, crons: [], items: [item('agent'), item('agent')] } as never }));
  expect(counted).toMatchObject({ agents: 2, work: { agents: 2 } });
  const older = row(term('w', '/a', { session: session({ subagents: 2 } as never) }));
  expect(older.agents).toBe(2);
});

test('sends how many wake-ups are set and the soonest with a time', () => {
  const row = (crons: object[]) => remoteState(full({ terminals: [withWork({ items: [], crons })] })).sessions[0]!;
  expect(row([cron(NOW + 3 * 3_600_000), cron(NOW + 3_600_000), cron(null)])).toMatchObject({ scheduled: 3, wakeAt: NOW + 3_600_000 });
  const untimed = row([cron(null)]);
  expect(untimed.scheduled).toBe(1);
  expect('wakeAt' in untimed).toBe(false);
  const none = row([]);
  expect('scheduled' in none).toBe(false);
});

test('sends the profile only when not the default, for sessions and terminals alike', () => {
  const s = remoteState(full({
    terminals: [term('a', '/a', { session: session({}) }), term('b', '/a'), term('c', '/a', { session: session({}) })],
    profileOf: (t) => (t.id === 'c' ? null : 'bash')
  }));
  expect(s.sessions.map((x) => x.profile ?? null)).toEqual(['bash', 'bash', null]);
});

test('marks a folder that is a linked worktree, named as its worktree', () => {
  const s = remoteState(full({
    terminals: [
      term('wt', '/a', { cwd: '/a/.claude/worktrees/fix-a/src', session: session({}) }),
      term('sub', '/a', { cwd: '/a/apps/web', session: session({}) })
    ],
    trees: (root) => (root === '/a' ? [{ root: '/a', worktreeOf: null }, { root: '/a/.claude/worktrees/fix-a', worktreeOf: '/a' }] : [])
  }));
  expect(s.sessions[0]).toMatchObject({ folder: 'fix-a', worktree: true });
  expect(s.sessions[1]).toMatchObject({ folder: 'web' });
  expect('worktree' in s.sessions[1]!).toBe(false);
});

test('a profile named by its folder (two shells of one name) reaches the phone by its name alone', () => {
  const s = remoteState(full({ terminals: [term('a', '/a'), term('b', '/a')], profileOf: (t) => (t.id === 'a' ? 'bash (/opt/homebrew/bin)' : 'fish') }));
  expect(s.sessions.map((x) => x.profile)).toEqual(['bash', 'fish']);
  expect(JSON.stringify(s)).not.toContain('/opt');
});

test('a worktree reached through a link is named as its worktree', () => {
  const s = remoteState(full({
    terminals: [term('wt', '/link', { cwd: '/link/.claude/worktrees/fix-a/src', session: session({}) })],
    realOf: (p) => p.replace(/^\/link/, '/a'),
    trees: (root) => (root === '/link' ? [{ root: '/a', worktreeOf: null }, { root: '/a/.claude/worktrees/fix-a', worktreeOf: '/a' }] : [])
  }));
  expect(s.sessions[0]).toMatchObject({ folder: 'fix-a', worktree: true });
});

test('a self-paced loop whose wake-up fired is happening now: no time, as the row shows none', () => {
  const loop = { id: 'l', label: '/loop check the build', schedule: '', recurring: false, next: null };
  const row = remoteState(full({ terminals: [withWork({ items: [], crons: [loop, cron(NOW + 3_600_000)] })] })).sessions[0]!;
  expect(row.scheduled).toBe(2);
  expect('wakeAt' in row).toBe(false);
  // An ordinary cron with no time yet doesn't hide the soonest one that has a time.
  const plain = remoteState(full({ terminals: [withWork({ items: [], crons: [cron(null), cron(NOW + 3_600_000)] })] })).sessions[0]!;
  expect(plain.wakeAt).toBe(NOW + 3_600_000);
});

// ── What runs, one by one, as the desktop's Background popover lists it ──

const entry = (id: string, kind: 'agent' | 'shell' | 'monitor' | 'other', o: object = {}) => ({ id, kind, label: `${kind} ${id}`, since: NOW - 60_000, counted: true, ...o });
const background = (work: object) => remoteState(full({ terminals: [withWork({ items: [], entries: [], ...work })] })).sessions[0]!.background;

test('sends each background item: agents with what they launched under them, then shells, monitors, other tasks', () => {
  const b = background({
    entries: [
      entry('a1', 'agent', { label: 'Explore the code', waiting: true, lastEvent: NOW }),
      entry('s1', 'shell', { label: 'Run the tests', display: 'npm test -- --watch=false' }),
      entry('s2', 'shell', { label: 'npm run e2e', display: 'npm run e2e', owner: 'a1' }),
      entry('m1', 'monitor', { counted: false, watcher: true }),
      entry('srv', 'shell', { label: 'Dev server', counted: false, server: { ports: [5173] } }),
      entry('o1', 'other', { counted: false, since: NOW - 40 * 60_000 })
    ]
  });
  expect(b?.items).toEqual([
    { kind: 'agent', label: 'Explore the code', since: NOW - 60_000, state: 'running', waiting: true },
    // A shell with no description of its own is named by its command: no second copy.
    { kind: 'shell', label: 'npm run e2e', since: NOW - 60_000, state: 'running', nested: true },
    { kind: 'shell', label: 'Run the tests', command: 'npm test -- --watch=false', since: NOW - 60_000, state: 'running' },
    { kind: 'shell', label: 'Dev server', since: NOW - 60_000, state: 'server', ports: [5173] },
    { kind: 'monitor', label: 'monitor m1', since: NOW - 60_000, state: 'watcher' },
    { kind: 'other', label: 'other o1', since: NOW - 40 * 60_000, state: 'idle' }
  ]);
  // An agent's last event changes all the time: it never reaches the phone, which would hear every tool call.
  expect(JSON.stringify(b)).not.toContain('lastEvent');
});

test('a subagent only the count knows has no start of its own: none is sent', () => {
  const b = background({ entries: [entry('subagent-1', 'agent', { label: 'Subagent' })] });
  expect(b?.items).toEqual([{ kind: 'agent', label: 'Subagent', state: 'running' }]);
});

test('sends the wake-ups: a self-paced loop by its task, an ordinary cron by its label, each with its next time', () => {
  const b = background({
    crons: [
      { id: 'l', label: '/loop check the build', schedule: '', recurring: false, next: null },
      { id: 'auto', label: '<<autonomous-loop-dynamic>>', schedule: '', recurring: false, next: NOW + 600_000 },
      { ...cron(NOW + 3_600_000), label: 'Nightly report' }
    ]
  });
  expect(b?.wakes).toEqual([
    { label: 'check the build', loop: true, next: null },
    { label: 'Autonomous loop', loop: true, next: NOW + 600_000 },
    { label: 'Nightly report', recurring: true, next: NOW + 3_600_000 }
  ]);
});

test('a loop whose wake-up fired is being checked while Claude itself works or waits, not while only its background does', () => {
  const fired = { id: 'l', label: '/loop check the build', schedule: '', recurring: false, next: null };
  const wakes = (s: Partial<SessionInfo>, counting: boolean) => remoteState(full({
    terminals: [term('w', '/a', { session: session(s), work: { counting, items: [], entries: [], crons: [fired] } as never })]
  })).sessions[0]!.background?.wakes;
  expect(wakes({ state: 'running' }, false)).toEqual([{ label: 'check the build', loop: true, next: null, checking: true }]);
  expect(wakes({ state: 'waiting', waitingFor: 'question' } as never, false)?.[0]?.checking).toBe(true);
  // Idle, its shell still counting: the phone reads the session as running, the loop's check has passed.
  expect(wakes({ state: 'idle' }, true)).toEqual([{ label: 'check the build', loop: true, next: null }]);
});

test('long labels and commands are cut, and a session runs at most 20 items and 10 wake-ups on the phone', () => {
  const long = 'x'.repeat(500);
  const b = background({
    entries: Array.from({ length: 25 }, (_, n) => entry(`s${n}`, 'shell', { label: long, display: `${long} ${n}` })),
    crons: Array.from({ length: 12 }, (_, n) => ({ ...cron(NOW + n), label: long }))
  });
  expect(b?.items).toHaveLength(20);
  expect(b?.wakes).toHaveLength(10);
  expect([...b!.items[0]!.label]).toHaveLength(120);
  expect([...b!.items[0]!.command!]).toHaveLength(200);
  expect([...b!.wakes[0]!.label]).toHaveLength(120);
});

test('a cut never splits an emoji made of several code points, nor leaves a space before its ellipsis', () => {
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  const label = `${'a'.repeat(118)}${family}${family}`;
  const b = background({ entries: [entry('s', 'shell', { label, display: `${'b'.repeat(198)} ccc` })] });
  // 119 code points before the ellipsis: the family's five don't fit after the 118 letters, so it is left out whole.
  expect(b?.items[0]?.label).toBe(`${'a'.repeat(118)}…`);
  expect(b?.items[0]?.command).toBe(`${'b'.repeat(198)}…`);
});

test('no background without items or wake-ups, nor for a plain terminal', () => {
  expect(background({})).toBeUndefined();
  const plain = remoteState(full({ terminals: [term('t', '/a', { work: { counting: false, crons: [], items: [], entries: [entry('s', 'shell')] } as never })] })).sessions[0]!;
  expect('background' in plain).toBe(false);
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

test('a waiting session carries ask for every wait; wait only for answerable permissions; neither once it goes on', () => {
  const perm = session({ state: 'waiting', waitingFor: 'permission', activity: 'waiting: Bash npm test', updatedAt: 5 });
  const plan = { ...perm, activity: 'waiting: plan approval' };
  const question = { ...perm, waitingFor: 'question' as const, activity: 'waiting: question' };
  const running = session({ state: 'running', activity: 'Bash npm test', updatedAt: 6 });
  const asks = new WaitBook(anyWait);
  const rows = (...ss: SessionInfo[]) => remoteState(full({ asks, terminals: ss.map((s, i) => term(`t${i}`, '/a', { createdAt: i, session: s })) })).sessions;
  const [p, pl, q, r] = rows(perm, plan, question, running);
  expect(p!.ask).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(p!.wait).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(pl!.ask).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(q!.ask).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect('wait' in pl!).toBe(false);
  expect('wait' in q!).toBe(false);
  expect(new Set([p!.ask, pl!.ask, q!.ask]).size).toBe(3);
  expect('ask' in r!).toBe(false);
  // Without a book of asks (an older caller) no row has one.
  expect('ask' in remoteState(full({ terminals: [term('w', '/a', { session: perm })] })).sessions[0]!).toBe(false);
});
