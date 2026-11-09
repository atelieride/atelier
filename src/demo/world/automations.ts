// The world's automations: two rules of the store and their runs. Pure
// data, shared by the live demo (bridge/connectors.ts plays them) and the website's Automations shot (written to the
// app's store before it opens), so the two cannot drift. Times are relative to `now`; `session` links a run to one of
// the world's sessions (the demo looks its terminal up by name, the shot by title).
import type { Automation } from '@shared/automations';
import type { Run } from '@shared/automation-run';
import type { ScenarioName } from './scenarios';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** ClickUp's list and Notion's database the rules watch (ids shaped like the real ones). */
export const SPRINT_LIST = { id: '901500000314', label: 'Store › Engineering › Sprint 14' };
export const DOCS_DB = { id: '2a8f3c1e-7b4d-4e9a-9c61-5d0e2b7f4a13', label: 'Store docs' };

export interface WorldRun extends Run { session?: ScenarioName }
export interface WorldAutomation { automation: Automation; runs: WorldRun[] }

const task = (source: 'clickup' | 'notion', id: string, displayId: string, title: string) => ({
  source, id, displayId, title, url: source === 'clickup' ? `https://app.clickup.com/t/${id}` : `https://www.notion.so/${id.replace(/-/g, '')}`
});

export function worldAutomations(project: string, now: number): WorldAutomation[] {
  const bugs: Automation = {
    id: 'au-bugfixes', name: 'Bug fixes from the sprint', enabled: true, createdAt: now - 9 * DAY, project, folder: '',
    source: { connector: 'clickup', scopes: [SPRINT_LIST.id], labels: [SPRINT_LIST.label] },
    conditions: [{ field: 'status', values: ['Ready for AI'] }, { field: 'tag', values: ['bug'] }, { field: 'createdBy', values: ['me'] }],
    claude: { account: 'default', model: 'sonnet', mode: 'auto', decideAlone: false, useSourceMcp: false },
    isolation: { worktree: true, base: 'default' },
    instructions: 'Write a failing test first, then the fix. Keep the change small and explain it in the last message.',
    limits: { concurrent: 2, perDay: 10, checkEveryMin: 2, usagePause: 80 },
    rerunWhenMatchesAgain: false
  };
  const docs: Automation = {
    id: 'au-docs', name: 'Docs pages from Notion', enabled: false, createdAt: now - 20 * DAY, project, folder: '',
    source: { connector: 'notion', scopes: [DOCS_DB.id], labels: [DOCS_DB.label] },
    conditions: [{ field: 'status', values: ['Ready to write'] }],
    claude: { account: 'work', model: 'haiku', mode: 'acceptEdits', decideAlone: true, useSourceMcp: false },
    isolation: { worktree: true, base: 'default' },
    instructions: 'Write for customers, not developers. Short sections, one example each.',
    limits: { concurrent: 1, perDay: 5, checkEveryMin: 15, usagePause: 80 },
    rerunWhenMatchesAgain: false
  };
  // A skipped run never started: it has no start, end or time.
  const run = (a: Automation, id: string, o: Partial<WorldRun> & Pick<WorldRun, 'task' | 'state'>, startedAgo: number, took?: number): WorldRun => ({
    id, automationId: a.id, createdAt: now - startedAgo, ...(o.state === 'skipped' ? {} : { startedAt: now - startedAgo }),
    ...(took !== undefined ? { endedAt: now - startedAgo + took } : {}), ...o
  });
  return [
    {
      automation: bugs,
      runs: [
        run(bugs, 'run-eng-128', { task: task('clickup', '86c1e0128', 'ENG-128', 'Coupon codes are case-sensitive'), state: 'skipped', reason: 'Created by Grace Hopper, who isn\'t in "created by"' }, 2 * DAY),
        run(bugs, 'run-eng-131', {
          task: task('clickup', '86c1e0131', 'ENG-131', 'Order emails show UTC times'), state: 'merged', branch: 'auto/eng-131-order-emails-show-utc',
          worktree: `${project}/.claude/worktrees/auto-eng-131-order-emails-show-utc`, cost: 0.62
        }, 26 * HOUR, 14 * MIN),
        run(bugs, 'run-eng-139', {
          task: task('clickup', '86c1e0139', 'ENG-139', 'Returning customers lose their cart'), state: 'review', session: 'onboarding-copy', branch: 'auto/eng-139-returning-customers',
          worktree: `${project}/.claude/worktrees/auto-eng-139-returning-customers`, cost: 0.84
        }, 3 * HOUR, 22 * MIN),
        run(bugs, 'run-eng-142', {
          task: task('clickup', '86c1e0142', 'ENG-142', 'Invoice totals round half-up'), state: 'working', session: 'billing-tests',
          branch: 'auto/eng-142-invoice-totals-round', worktree: `${project}/.claude/worktrees/auto-eng-142-invoice-totals-round`
        }, 6 * MIN)
      ]
    },
    {
      automation: docs,
      runs: [
        run(docs, 'run-docs-refunds', {
          task: task('notion', '3c71b2a4-0e5f-4d8b-a2c9-71e6f0d38b55', 'DOC-7', 'How refunds work'), state: 'closed', branch: 'auto/doc-7-how-refunds-work',
          worktree: `${project}/.claude/worktrees/auto-doc-7-how-refunds-work`, worktreeRemoved: true, cost: 0.21,
          decisions: ['Wrote for shoppers, not support staff: the page is linked from the order email.', 'Left out partial refunds: the page in Notion doesn\'t cover them yet.']
        }, 5 * DAY, 9 * MIN)
      ]
    }
  ];
}
