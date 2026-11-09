// automations.* in the demo: the world's two rules and their runs
// (world/automations.ts), one of them working in billing-tests. On, off, edit, delete, skip, stop and close change the
// demo's own copy; starting a run needs the Mac. The editor reads the world's
// ClickUp sprint (world/clickup.ts): its lists, "Matching now" with who "created by" leaves out, and the condition
// chips' suggestions, matched by the app's own shared rules.
import type { AtelierApi, AutomationsState } from '@shared/api';
import { conditionValues, matches, type Automation, type AutomationPreview, type AutomationStatus } from '@shared/automations';
import type { RunState } from '@shared/automation-run';
import { worldAutomations, type WorldAutomation } from '../world/automations';
import { CLICKUP_LISTS, CLICKUP_PEOPLE, SPRINT_STATUSES, SPRINT_TASKS } from '../world/clickup';
import { resolved, type DemoContext } from './context';
import { notInDemo } from './not-in-demo';

const CLOSABLE: ReadonlySet<RunState> = new Set(['review', 'stopped', 'failed', 'merged', 'closed']);
const NAMES = { clickup: 'ClickUp', notion: 'Notion', jira: 'Jira' } as const;
const ME = CLICKUP_PEOPLE[0].id;

/** "Matching now" over the world's sprint, as the runner's preview reads it (src/main/automations/runner.ts). */
function previewOf(a: Automation, now: number): AutomationPreview {
  if (a.source.connector !== 'clickup') return { matching: [], count: 0, leftOut: [], error: `${NAMES[a.source.connector]} isn't connected` };
  const tasks = SPRINT_TASKS.filter((t) => a.source.scopes.includes(t.scope)).map(({ body: _b, updatedAgo: _u, ...t }) => ({ ...t, ...(t.due !== undefined ? { due: now + t.due } : {}) }));
  const ctx = { me: ME, now };
  const lead = a.conditions.filter((c) => c.field !== 'createdBy');
  const candidates = tasks.filter((t) => matches(t, lead, ctx));
  const matching = candidates.filter((t) => matches(t, a.conditions, ctx));
  const name = (id: string) => CLICKUP_PEOPLE.find((p) => p.id === id)?.name ?? 'someone';
  const v = conditionValues(tasks, CLICKUP_PEOPLE, SPRINT_STATUSES.filter((s) => s.type !== 'closed'));
  return {
    matching, count: matching.length,
    leftOut: candidates.filter((t) => !matching.includes(t)).map((t) => ({ task: t, reason: `Created by ${name(t.creatorId!)}` })),
    values: { ...v, people: v.people.filter((p) => p.id !== ME) }
  };
}

export function createAutomations(ctx: DemoContext): AtelierApi['automations'] {
  const start = ctx.now();
  let list: WorldAutomation[] = worldAutomations(ctx.world.project.root, start);
  let paused = false;

  const status = (w: WorldAutomation): AutomationStatus => {
    const lastPollAt = w.automation.enabled ? ctx.now() - 40_000 : null;
    if (!w.automation.enabled) return { kind: 'off', lastPollAt, nextPollAt: null };
    if (paused) return { kind: 'paused', reason: 'All automations are paused', lastPollAt, nextPollAt: null };
    return { kind: 'on', lastPollAt, nextPollAt: ctx.now() + w.automation.limits.checkEveryMin * 60_000 - 40_000 };
  };
  /** A run's session is the world's session of that name, while its terminal is open. */
  const view = (): AutomationsState => ({
    automations: list.map((w) => ({
      automation: w.automation,
      status: status(w),
      runs: w.runs.map(({ session, ...r }) => {
        const t = session ? ctx.state.terminals.find((x) => x.title === session || x.name === session) : undefined;
        return t ? { ...r, terminalId: t.id } : r;
      })
    }))
  });
  const changed = () => { const s = view(); ctx.events.emit('automations', s); return resolved(s); };
  const setAutomation = (id: string, f: (w: WorldAutomation) => WorldAutomation | null) => {
    list = list.flatMap((w) => (w.automation.id === id ? (f(w) ?? []) : [w]));
    return changed();
  };
  const setRun = (runId: string, f: (r: WorldAutomation['runs'][number]) => WorldAutomation['runs'][number]) => {
    list = list.map((w) => ({ ...w, runs: w.runs.map((r) => (r.id === runId ? f(r) : r)) }));
    return changed();
  };
  const runOf = (runId: string) => list.flatMap((w) => w.runs).find((r) => r.id === runId);

  return {
    list: () => resolved(view()),
    save: (a) => {
      const prev = list.find((w) => w.automation.id === a.id);
      if (!prev) { list = [...list, { automation: { ...a, enabled: false, project: ctx.world.project.root }, runs: [] }]; return changed(); }
      return setAutomation(a.id, (w) => ({ ...w, automation: { ...a, enabled: w.automation.enabled, project: w.automation.project, createdAt: w.automation.createdAt } }));
    },
    remove: (id) => setAutomation(id, () => null),
    turnOn: (id) => setAutomation(id, (w) => ({ ...w, automation: { ...w.automation, enabled: true } })),
    turnOff: (id) => setAutomation(id, (w) => ({ ...w, automation: { ...w.automation, enabled: false } })),
    checkNow: () => changed(),
    preview: (a) => resolved(previewOf(a, ctx.now())),
    startRun: () => { notInDemo('Starting a run'); return resolved(view()); },
    skipRun: (runId) => setRun(runId, (r) => (r.state === 'queued' || r.state === 'held' ? { ...r, state: 'skipped', reason: 'Skipped by you' } : r)),
    stopRun: (runId) => setRun(runId, (r) => (r.state === 'working' || r.state === 'needsYou' ? { ...r, state: 'stopped', reason: 'Stopped by you', endedAt: ctx.now() } : r)),
    closeRun: async (runId, removeWorktree) => {
      const r = runOf(runId);
      if (!r || !CLOSABLE.has(r.state)) return { state: view(), outcome: 'error', message: 'That run is still working: stop it first' };
      const state = await setRun(runId, (x) => ({
        ...x, ...(x.state === 'review' ? { state: 'closed' as const, endedAt: x.endedAt ?? ctx.now() } : {}),
        ...(removeWorktree && x.worktree ? { worktreeRemoved: true } : {})
      }));
      return { state, outcome: 'ok' };
    },
    catchUp: () => changed(),
    setPaused: (p) => { paused = p; return changed(); },
    scopes: (connector) => resolved(connector === 'clickup' ? CLICKUP_LISTS.map((l) => ({ ...l })) : []),
    sourceMcp: () => resolved({ state: 'unknown' as const })
  };
}
