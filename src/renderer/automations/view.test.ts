import { describe, expect, test } from 'vitest';
import type { AutomationView, AutomationsState } from '@shared/api';
import { normalizeAutomation, type Automation } from '@shared/automations';
import { normalizeRun, type Run } from '@shared/automation-run';
import {
  activeCount, byProject, canCloseRun, conditionSentence, costLabel, durationLabel, footerCounts, needsConsent, newDraft, peopleWords, runCounts, runLabel, runOf, runSentence, whatClaudeGets
} from './view';

const auto = (o: Record<string, unknown> = {}): Automation => normalizeAutomation({
  id: 'a1', name: 'Bug fixes', project: '/p/acme', enabled: true,
  source: { connector: 'clickup', scopes: ['l1'], labels: ['Sprint 42 › Backend'] },
  conditions: [{ field: 'status', values: ['Ready for AI'] }, { field: 'tag', values: ['ai-ok'] }, { field: 'createdBy', values: ['me', 'u2'] }], ...o
})!;
const run = (id: string, state: string, o: Record<string, unknown> = {}): Run => normalizeRun({
  id, automationId: 'a1', createdAt: 1, state, task: { source: 'clickup', id: `t-${id}`, displayId: `CU-${id}`, title: 'T', url: 'https://app.clickup.com/t/x' }, ...o
})!;
const view = (a: Automation, runs: Run[] = []): AutomationView => ({ automation: a, runs, status: { kind: a.enabled ? 'on' : 'off', lastPollAt: null, nextPollAt: null } });

describe('grouping and counts (1b, footer)', () => {
  const state: AutomationsState = { automations: [
    view(auto({ id: 'z', project: '/p/zeta', name: 'Zeta' }), [run('1', 'working')]),
    view(auto({ id: 'a1' }), [run('2', 'working'), run('3', 'needsYou'), run('4', 'review'), run('5', 'queued'), run('6', 'held', { held: 'global' }), run('7', 'closed')]),
    view(auto({ id: 'b', project: '/p/beta', name: 'Beta', enabled: false }))
  ] };

  test('byProject: the window\'s project first, then the others by name', () => {
    expect(byProject(state, '/p/acme').map((g) => [g.project, g.name, g.views.map((v) => v.automation.id)])).toEqual([
      ['/p/acme', 'acme', ['a1']], ['/p/beta', 'beta', ['b']], ['/p/zeta', 'zeta', ['z']]
    ]);
  });

  test('runCounts: working, needs you, for review, queued, held', () => {
    expect(runCounts(state.automations[1]!.runs)).toEqual({ working: 1, needsYou: 1, review: 1, queued: 1, held: 1 });
  });

  test('the activity badge: this project\'s runs at work (starting, working, needs you)', () => {
    expect(activeCount(state, '/p/acme')).toBe(2);
    expect(activeCount(state, null)).toBe(0);
  });

  test('the footer: every project\'s runs at work, and those waiting', () => {
    expect(footerCounts(state)).toEqual({ automated: 3, waiting: 2 });
  });

  test('runOf: the run a session belongs to, with its automation; none for a plain session', () => {
    const s: AutomationsState = { automations: [view(auto(), [run('2', 'working', { terminalId: 'term-2' }), run('3', 'closed', { terminalId: 'term-3' })])] };
    expect(runOf(s, 'term-2')).toMatchObject({ run: { id: '2' }, automation: { id: 'a1' } });
    expect(runOf(s, 'term-3')?.run.id).toBe('3');
    expect(runOf(s, 'term-9')).toBeNull();
  });
});

describe('words (2a, 4a)', () => {
  test('the "When" sentence', () => {
    expect(conditionSentence(auto())).toBe('New task in Sprint 42 › Backend · status Ready for AI · tag ai-ok · created by you or 1 more');
    expect(conditionSentence(auto({ source: { connector: 'clickup', scopes: ['l1', 'l2'] }, conditions: [] }))).toBe('New task in 2 lists');
    expect(conditionSentence(auto({ source: { connector: 'notion', scopes: ['0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0'], labels: ['Docs board'] },
      conditions: [{ field: 'status', values: ['To write'] }, { field: 'due', values: ['3'] }] }))).toBe('New row in Docs board · status To write · due within 3 days');
    expect(conditionSentence(auto({ conditions: [{ field: 'assignee', values: ['me'] }] }))).toBe('New task in Sprint 42 › Backend · assigned to you');
    // People by name once the chips named them; the unnamed counted.
    expect(conditionSentence(auto({ conditions: [{ field: 'createdBy', values: ['me', 'u2'], labels: ['Me', 'Ada Lovelace'] }] })))
      .toBe('New task in Sprint 42 › Backend · created by you or Ada Lovelace');
    expect(conditionSentence(auto({ conditions: [{ field: 'assignee', values: ['u1', 'u2', 'u3'], labels: ['Ada', 'Grace', '…'] }] })))
      .toBe('New task in Sprint 42 › Backend · assigned to Ada, Grace or 1 more');
    expect(conditionSentence(auto({ conditions: [{ field: 'assignee', values: ['u1', 'u2', 'u3', 'me'], labels: ['Ada', 'Grace', 'Linus', 'Me'] }] })))
      .toBe('New task in Sprint 42 › Backend · assigned to you, Ada or 2 more');
    expect(conditionSentence(auto({ conditions: [{ field: 'assignee', values: ['u1', 'u2'] }] }))).toBe('New task in Sprint 42 › Backend · assigned to 2 people');
    expect(conditionSentence(auto({ conditions: [{ field: 'priority', values: ['high'] }, { field: 'title', values: ['login'] }] })))
      .toBe('New task in Sprint 42 › Backend · priority ≥ high · title has "login"');
    // Jira: issues in projects.
    expect(conditionSentence(auto({ source: { connector: 'jira', scopes: ['10001'], labels: ['ATL · Atelier'] }, conditions: [] }))).toBe('New issue in ATL · Atelier');
    expect(conditionSentence(auto({ source: { connector: 'jira', scopes: ['10001', '10003'] }, conditions: [] }))).toBe('New issue in 2 projects');
    expect(conditionSentence(auto({ source: { connector: 'jira', scopes: ['10001'] }, conditions: [] }))).toBe('New issue in 1 project');
  });

  test('the consent sheet names everyone a created-by trusts; the unnamed as "someone"', () => {
    expect(peopleWords({ field: 'createdBy', values: ['u1', 'u2', 'me', 'u3'], labels: ['Ada', 'Grace', 'Me', '…'] }, true)).toBe('you, Ada, Grace or someone');
    expect(peopleWords({ field: 'createdBy', values: ['me', 'u1'], labels: ['Me', 'Ada'] }, true)).toBe('you or Ada');
    expect(peopleWords({ field: 'createdBy', values: ['u1'] }, true)).toBe('someone');
  });

  test('a run\'s label and tone', () => {
    expect(runLabel(run('1', 'working'))).toEqual({ label: 'Working', tone: 'working' });
    expect(runLabel(run('1', 'needsYou'))).toEqual({ label: 'Needs you', tone: 'waiting' });
    expect(runLabel(run('1', 'review'))).toEqual({ label: 'Ready for review', tone: 'done' });
    expect(runLabel(run('1', 'held', { held: 'global' }))).toEqual({ label: 'Held for you', tone: 'violet' });
    expect(runLabel(run('1', 'held', { held: 'catchUp' }))).toEqual({ label: 'Waiting for you', tone: 'violet' });
    expect(runLabel(run('1', 'failed'))).toEqual({ label: 'Failed', tone: 'error' });
    expect(runLabel(run('1', 'skipped'))).toEqual({ label: 'Not started', tone: 'idle' });
  });

  test('a run\'s sentence: why it waits, or what happened', () => {
    const a = auto({ limits: { concurrent: 2 } });
    expect(runSentence(run('1', 'queued', { queued: 'perAutomation' }), a, { cap: 3 })).toBe('2 running, the limit · starts when one ends');
    expect(runSentence(run('1', 'queued', { queued: 'perDay' }), a, { cap: 3 })).toBe('10 a day, the limit · starts tomorrow');
    expect(runSentence(run('1', 'queued', { queued: 'usage' }), a, { cap: 3 })).toBe('Waiting for the 5h limit to go below 80%');
    expect(runSentence(run('1', 'queued', { queued: 'global' }), a, { cap: 3 })).toBe('3 automated runs going · next in line');
    expect(runSentence(run('1', 'held', { held: 'global' }), a, { cap: 3 })).toBe('3 automated runs already going, your limit');
    expect(runSentence(run('1', 'held', { held: 'catchUp' }), a, { cap: 3 })).toBe('Started matching while Atelier was closed');
    expect(runSentence(run('1', 'failed', { reason: 'Claude stopped with an error' }), a, { cap: 3 })).toBe('Claude stopped with an error');
  });

  test('time and cost', () => {
    expect(durationLabel(0, 4 * 60_000)).toBe('4m');
    expect(durationLabel(0, 38 * 60_000)).toBe('38m');
    expect(durationLabel(0, 125 * 60_000)).toBe('2h 5m');
    expect(durationLabel(0, 20_000)).toBe('<1m');
    expect(costLabel(1.8399)).toBe('$1.84');
    expect(costLabel(undefined)).toBe('—');
  });
});

describe('"What Claude gets"', () => {
  test('the worktree, the command with its guards, the first message\'s head', () => {
    const lines = whatClaudeGets(auto({ claude: { model: 'opus', mode: 'auto', decideAlone: true } }),
      { displayId: 'CU-479', title: 'Coupon codes are case-sensitive', url: 'https://app.clickup.com/t/86c0x479' }).split('\n');
    expect(lines[0]).toBe('# Atelier makes the worktree from the default branch');
    expect(lines[1]).toBe('# branch auto/cu-479-coupon-codes-are-case');
    expect(lines[2]).toBe('# git guard on');
    expect(lines).toContain("claude --name='CU-479 Coupon codes are case-sensitive'");
    expect(lines).toContain('  --model opus --permission-mode auto');
    expect(lines.join('\n')).toContain('AskUserQuestion');
    expect(lines.join('\n')).toContain('ClickUp task CU-479: Coupon codes are case-sensitive');
    const plain = whatClaudeGets(auto({ isolation: { worktree: false } }), null);
    expect(plain.split('\n')[0]).toBe('# in the folder itself, git guard on its branch');
    expect(plain).not.toContain('ClickUp task');
  });
});

describe('the editor', () => {
  test('a new draft: this project, the connector, off, the defaults', () => {
    const d = newDraft('/p/acme', 'clickup', () => 'n1', 7);
    expect(d).toMatchObject({ id: 'n1', project: '/p/acme', enabled: false, createdAt: 7, source: { connector: 'clickup', scopes: [] } });
    expect(d.claude.mode).toBe('auto');
    expect(d.isolation.worktree).toBe(true);
  });

  test('turning on again asks only when the automation got wider: source, conditions, mode, account, worktree off', () => {
    const a = auto();
    expect(needsConsent(a, { ...a, name: 'New name', instructions: 'x', limits: { ...a.limits, perDay: 5 } })).toBe(false);
    expect(needsConsent(a, { ...a, source: { ...a.source, scopes: ['l1', 'l2'] } })).toBe(true);
    expect(needsConsent(a, { ...a, conditions: a.conditions.slice(1) })).toBe(true);
    expect(needsConsent(a, { ...a, claude: { ...a.claude, mode: 'acceptEdits' } })).toBe(true);
    expect(needsConsent(a, { ...a, claude: { ...a.claude, account: 'work' } })).toBe(true);
    expect(needsConsent(a, { ...a, isolation: { ...a.isolation, worktree: false } })).toBe(true);
    expect(needsConsent(null, a)).toBe(true);
  });
});

describe('Close Run', () => {
  test('offered once a run no longer works, and on a closed one only while its worktree is still there', () => {
    const wt = { branch: 'auto/x', worktree: '/p/acme/.claude/worktrees/auto-x' };
    for (const s of ['review', 'stopped', 'failed', 'merged']) expect(canCloseRun(run('1', s, wt)), s).toBe(true);
    for (const s of ['queued', 'held', 'starting', 'working', 'needsYou', 'skipped']) expect(canCloseRun(run('1', s, wt)), s).toBe(false);
    expect(canCloseRun(run('1', 'closed', wt))).toBe(true);
    expect(canCloseRun(run('1', 'closed', { ...wt, worktreeRemoved: true }))).toBe(false);
    expect(canCloseRun(run('1', 'closed'))).toBe(false);
  });
});
