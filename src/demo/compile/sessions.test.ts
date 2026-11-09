import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { attachWork } from '../../main/work-hub';
import { DEMO_HOME, accountDir } from '../world/accounts';
import { SCENARIOS } from '../world/scenarios';
import { claudeScreen, screenOf } from '../engine/claude-screen';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { DEMO_ROOT, SESSION_COLORS, T0, compileSessions, withWork } from './sessions';

// The five sessions through the app's own reducers: the hook and statusline
// payloads tests/e2e/fake-claude-demo.pl sends for each scenario, applied as atelierd applies them, the work attached
// as main attaches it. The states are those of the overview screenshot.

const { sessions, usage, attributions, raw } = compileSessions(DEMO_ROOT, T0);
const byName = Object.fromEntries(sessions.map((s) => [s.scenario, s]));
const info = (name: keyof typeof SCENARIOS) => byName[name]!.terminal;

describe('compileSessions', () => {
  test('one Claude terminal per scenario, in the sidebar order, named, coloured as atelierd colours them', () => {
    expect(sessions.map((s) => s.scenario)).toEqual(['auth-refactor', 'billing-tests', 'onboarding-copy', 'db-migration', 'docs']);
    sessions.forEach((s, i) => {
      expect(s.terminal).toMatchObject({ name: s.scenario, title: s.scenario, color: SESSION_COLORS[i], projectRoot: DEMO_ROOT, cwd: DEMO_ROOT, foreground: 'claude' });
      expect(s.terminal.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(s.terminal.session?.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(s.terminal.session?.cwd).toBe(DEMO_ROOT);
      expect(s.terminal.session?.model).toBe('Opus 5.5');
    });
  });

  test('ids are stable across builds (same world, same bytes)', () => {
    expect(compileSessions(DEMO_ROOT, T0)).toEqual({ sessions, usage, attributions, raw });
  });

  test('auth-refactor waits on its Bash permission', () => {
    expect(info('auth-refactor').session).toMatchObject({ state: 'waiting', waitingFor: 'permission', contextPct: 41, cost: { usd: 1.84, linesAdded: 7, linesRemoved: 2 } });
    expect(info('auth-refactor').session?.activity).toContain('npm test -- auth');
  });

  test('billing-tests runs, with two agents and one shell in the background', () => {
    const t = info('billing-tests');
    expect(t.session).toMatchObject({ state: 'running', activity: 'read README.md' });
    expect(t.work).toMatchObject({ agents: 2, shells: 1 });
    expect(t.work?.entries.map((e) => e.label)).toEqual(expect.arrayContaining(['rounding edge cases', 'currency formats', 'Run billing tests']));
    // As main sends it: the raw commands stay in main (attachWork drops them).
    expect(JSON.stringify(t.session?.background)).not.toContain('"command"');
  });

  test('onboarding-copy is done and was seen (it finished in front: Idle, as in the shot)', () => {
    expect(info('onboarding-copy').session).toMatchObject({ state: 'done', unread: false });
  });

  test("each group's order is the overview's: the later session updated last (the sidebar shows it first)", () => {
    const updated = (n: keyof typeof SCENARIOS) => info(n).session!.updatedAt;
    expect(updated('db-migration')).toBeGreaterThan(updated('auth-refactor'));
    expect(updated('docs')).toBeGreaterThan(updated('billing-tests'));
    for (let i = 1; i < sessions.length; i++) expect(sessions[i]!.terminal.createdAt).toBeGreaterThan(sessions[i - 1]!.terminal.createdAt);
    expect(Math.max(...sessions.map((s) => s.terminal.session!.updatedAt))).toBeLessThan(T0);
  });

  test('db-migration waits on a question', () => {
    expect(info('db-migration').session).toMatchObject({ state: 'waiting', waitingFor: 'question' });
  });

  test('docs runs with a cron', () => {
    const t = info('docs');
    expect(t.session?.state).toBe('running');
    expect(t.work?.crons).toEqual([expect.objectContaining({ label: 'check the preview deploy', schedule: '*/30 * * * *', recurring: true })]);
  });

  test('no internal bookkeeping leaves (publicSession)', () => {
    for (const s of sessions) for (const k of ['agentWaits', 'agentRuns', 'mainRest', 'bgOwners', 'bgSeen', 'agentDescriptions', 'agentsWaiting']) expect(s.terminal.session).not.toHaveProperty(k);
  });

  test('the work is attached exactly as main attaches it (withWork is a copy of attachWork for one terminal)', () => {
    const session = {
      ...info('billing-tests').session!,
      background: { items: [{ id: 'b1', kind: 'shell' as const, label: 'Run billing tests', since: T0 - 5000, command: 'npm test -- billing' }], crons: [] }
    };
    const raw = { ...info('billing-tests'), session, work: undefined };
    expect(withWork(raw, T0)).toEqual(attachWork([raw], {}, T0, DEFAULT_SETTINGS.countBackgroundWork).list[0]);
    expect(info('billing-tests').work?.entries.find((e) => e.kind === 'shell')?.display).toBe('npm test -- billing');
  });

  test('the screen is the scenario drawn', () => {
    for (const s of sessions) expect(claudeScreen(s.screen, 31, 79)).toBe(claudeScreen(screenOf(SCENARIOS[s.scenario]), 31, 79));
  });

  test('the limits from the status lines, per account: Personal 34% of 5 h and 12% of 7 days, Work its own', () => {
    const limits = (five: number, seven: number) => ({ fiveHour: { pct: five, resetsAt: Math.floor(T0 / 1000) + 30 + 7200 }, sevenDay: { pct: seven, resetsAt: Math.floor(T0 / 1000) + 30 + 3 * 86400 }, updatedAt: expect.any(Number) });
    expect(usage).toEqual([
      { configDir: accountDir(DEMO_HOME, 'default'), usage: limits(34, 12) },
      { configDir: accountDir(DEMO_HOME, 'work'), usage: limits(8, 41) }
    ]);
  });

  test('each session knows its Claude account\'s dir, as atelierd learns it from transcript_path: docs runs as Work', () => {
    for (const s of sessions) {
      expect(s.terminal.configDir, s.scenario).toBe(accountDir(DEMO_HOME, s.scenario === 'docs' ? 'work' : 'default'));
    }
  });

  test('every edit is attributed to its session, with its colour', () => {
    const files = Object.fromEntries(attributions.map((a) => [a.path.slice(DEMO_ROOT.length + 1), a]));
    expect(Object.keys(files).sort()).toEqual(['README.md', 'src/auth/session.ts', 'src/pages/welcome.tsx', 'tests/billing.test.ts']);
    expect(files['src/auth/session.ts']).toMatchObject({ terminalId: info('auth-refactor').id, color: SESSION_COLORS[0], title: 'auth-refactor' });
    expect(files['README.md']).toMatchObject({ terminalId: info('docs').id, title: 'docs' });
  });

  test("the colours are atelierd's (a copy: the daemon module loads node-pty)", () => {
    const src = readFileSync('src/daemon/terminals.ts', 'utf8');
    const m = /export const SESSION_COLORS = (\[[^\]]+\])/.exec(src);
    expect(m, 'SESSION_COLORS in src/daemon/terminals.ts').not.toBeNull();
    expect(SESSION_COLORS).toEqual(JSON.parse(m![1]!.replace(/'/g, '"')));
  });

  test('the root is fictional and passes the site guard (no /Users/)', () => {
    expect(DEMO_ROOT).not.toMatch(/\/Users\//);
    expect(DEMO_ROOT.endsWith('/code/acme-store')).toBe(true);
  });
});
