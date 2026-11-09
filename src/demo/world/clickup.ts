// The world's ClickUp: connected as the fictional user, with
// one sprint of open tasks. The automation editor reads it for "Matching now" and the condition chips' suggestions; the
// palette lists the user's own tasks. Pure data, types only (the demo's runtime imports it).
import type { WatchedTask } from '@shared/automations';
import type { TaskSummary } from '@shared/tasks';
import { AUTHOR } from './project';
import { SPRINT_LIST } from './automations';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const CLICKUP_WORKSPACE = 'Store';
/** The people the tasks name; the first is the visitor ("Me"). */
export const CLICKUP_PEOPLE = [
  { id: '61000001', name: AUTHOR.name },
  { id: '61000002', name: 'Grace Hopper' },
  { id: '61000003', name: 'Alan Turing' }
] as const;
const [ME, GRACE, ALAN] = CLICKUP_PEOPLE;

/** The lists the editor offers (Space › Folder › List, as the real connector names them). */
export const CLICKUP_LISTS = [
  SPRINT_LIST,
  { id: '901500000315', label: 'Store › Engineering › Backlog' },
  { id: '901500000316', label: 'Store › Design › Assets' }
];

/** The sprint's statuses as ClickUp defines them (`closed` ones are never watched). */
export const SPRINT_STATUSES = [
  { name: 'to do', color: '#87909e', type: 'open' },
  { name: 'Ready for AI', color: '#7b68ee', type: 'custom' },
  { name: 'in progress', color: '#5f55ee', type: 'custom' },
  { name: 'review', color: '#f8ae00', type: 'custom' },
  { name: 'blocked', color: '#e50000', type: 'custom' },
  { name: 'complete', color: '#008844', type: 'closed' }
] as const;

export interface WorldTask extends WatchedTask { creatorId: string; body: string; updatedAgo: number }

const t = (id: string, displayId: string, title: string, status: string, o: { tags: string[]; assignees: string[]; creator: string; priority?: string; dueIn?: number; body: string; updatedAgo: number }): WorldTask => ({
  id, scope: SPRINT_LIST.id, displayId, title, url: `https://app.clickup.com/t/${id}`, status, assignees: o.assignees, creatorId: o.creator, tags: o.tags,
  ...(o.priority ? { priority: o.priority } : {}), ...(o.dueIn !== undefined ? { due: o.dueIn } : {}), body: o.body, updatedAgo: o.updatedAgo
});

/** Sprint 14's open tasks. `due` is relative here (ms from now): the bridge adds the clock. */
export const SPRINT_TASKS: readonly WorldTask[] = [
  t('86c1e0142', 'ENG-142', 'Invoice totals round half-up', 'in progress', { tags: ['bug', 'billing'], assignees: [ME.id], creator: ME.id, priority: 'high', body: 'Totals with half a cent round up; finance expects banker\'s rounding.', updatedAgo: 6 * 60_000 }),
  t('86c1e0139', 'ENG-139', 'Returning customers lose their cart', 'review', { tags: ['bug'], assignees: [ME.id], creator: ME.id, priority: 'urgent', body: 'Signing in again empties the cart saved on the device.', updatedAgo: 3 * HOUR }),
  t('86c1e0144', 'ENG-144', 'Search ignores accents', 'Ready for AI', { tags: ['bug', 'search'], assignees: [ME.id], creator: ME.id, priority: 'normal', dueIn: 2 * DAY, body: '"creme" should find "crème brûlée".', updatedAgo: 40 * 60_000 }),
  t('86c1e0145', 'ENG-145', 'Checkout button jumps on mobile', 'Ready for AI', { tags: ['bug', 'ux'], assignees: [GRACE.id], creator: GRACE.id, priority: 'high', body: 'The sticky button moves when the keyboard opens on iOS.', updatedAgo: 2 * HOUR }),
  t('86c1e0147', 'ENG-147', 'Gift card balance off by a cent', 'Ready for AI', { tags: ['bug', 'billing'], assignees: [ME.id], creator: ALAN.id, priority: 'high', dueIn: 5 * DAY, body: 'A €25 card shows €24.99 after a partial refund.', updatedAgo: 5 * HOUR }),
  t('86c1e0146', 'ENG-146', 'Export orders as CSV', 'to do', { tags: ['feature'], assignees: [ALAN.id], creator: ME.id, priority: 'low', body: 'One row per order line, the store\'s currency.', updatedAgo: DAY })
];

/** The palette's ClickUp section: the visitor's own open tasks, newest change first. */
export function myTasks(now: number): TaskSummary[] {
  return SPRINT_TASKS.filter((x) => x.assignees.includes(ME.id)).sort((a, b) => a.updatedAgo - b.updatedAgo).map((x) => ({
    id: x.id, displayId: x.displayId, title: x.title, status: { name: x.status, color: SPRINT_STATUSES.find((s) => s.name === x.status)?.color },
    ...(x.priority ? { priority: x.priority } : {}), ...(x.due !== undefined ? { due: now + x.due } : {}), listName: 'Sprint 14', url: x.url, updatedAt: now - x.updatedAgo
  }));
}
