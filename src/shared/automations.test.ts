import { describe, expect, test } from 'vitest';
import {
  AUTOMATION_DEFAULTS, AUTOMATIONS_SETTINGS_DEFAULTS, LEDGER_FORGET_MS, MAX_LEDGER, conditionFields, conditionValues, decide, isCatchUp,
  ledgerAfterPoll, matches, needsConsent, needsCreator, newMatches, normalizeAutomation, type Automation, type Condition, type Ledger,
  type WatchedTask
} from './automations';

const base = {
  id: 'a1', name: 'Bug fixes', enabled: true, createdAt: 1, project: '/Users/me/code/acme',
  source: { connector: 'clickup', scopes: ['901500000301'] }
};
const auto = (o: Record<string, unknown> = {}) => normalizeAutomation({ ...base, ...o })!;

describe('normalizeAutomation: field by field, defaults for what is missing or wrong', () => {
  test('the core fields are required: id, project, source; anything else gets its default', () => {
    const a = auto();
    expect(a).toEqual({ ...AUTOMATION_DEFAULTS, ...base, source: { connector: 'clickup', scopes: ['901500000301'] } });
    expect(a.claude).toEqual({ account: 'default', model: 'default', mode: 'auto', decideAlone: false, useSourceMcp: false });
    expect(a.isolation).toEqual({ worktree: true, base: 'default' });
    expect(a.limits).toEqual({ concurrent: 2, perDay: 10, checkEveryMin: 2, usagePause: 80 });
    for (const bad of [{ id: '' }, { id: 'a b' }, { id: 'x'.repeat(65) }, { project: 'relative/path' }, { project: '/a/../b' },
      { source: { connector: 'linear', scopes: ['1'] } }, { source: { connector: 'clickup', scopes: [] } },
      { source: { connector: 'clickup', scopes: ['bad id!'] } }]) {
      expect(normalizeAutomation({ ...base, ...bad }), JSON.stringify(bad)).toBeNull();
    }
    expect(normalizeAutomation(null)).toBeNull();
    expect(normalizeAutomation('x')).toBeNull();
  });

  test('source labels: the scopes\' names for display, one clean line each, as many as the scopes', () => {
    expect(auto({ source: { connector: 'clickup', scopes: ['1', '2'], labels: ['Sprint 42 › Backend', 'QA\n'] } }).source)
      .toEqual({ connector: 'clickup', scopes: ['1', '2'], labels: ['Sprint 42 › Backend', 'QA'] });
    expect(auto({ source: { connector: 'clickup', scopes: ['1', '2'], labels: ['only one'] } }).source).toEqual({ connector: 'clickup', scopes: ['1', '2'] });
    expect(auto({ source: { connector: 'clickup', scopes: ['1'], labels: 'x' } }).source).toEqual({ connector: 'clickup', scopes: ['1'] });
  });

  test('name: one clean line, 1–60 characters, else "Automation"', () => {
    expect(auto({ name: '  Bug\tfixes\n' }).name).toBe('Bug fixes');
    expect(auto({ name: 'x'.repeat(80) }).name).toBe('x'.repeat(60));
    expect(auto({ name: '\u0007' }).name).toBe('Automation');
  });

  test('folder: relative, clean, inside the project; anything else is the project root', () => {
    expect(auto({ folder: 'packages/api' }).folder).toBe('packages/api');
    for (const f of ['../x', '/abs', 'a/../b', './a', 'a//b', 'a/', '.git', 'a/.git/b', 'a\u0000b', 7]) expect(auto({ folder: f }).folder, String(f)).toBe('');
  });

  test('conditions: known fields only, values cleaned, at most 8; a field the connector lacks is dropped', () => {
    const conditions: unknown[] = [
      { field: 'status', values: ['Ready for AI', ' '] }, { field: 'tag', values: ['ai-ok'] }, { field: 'nope', values: ['x'] },
      { field: 'title', values: [] }, { field: 'priority', values: ['urgent'] }, { field: 'priority', values: ['huge'] },
      { field: 'due', values: ['3'] }, { field: 'due', values: ['-1'] }, { field: 'createdBy', values: ['me', '81000002'] }
    ];
    expect(auto({ conditions }).conditions).toEqual([
      { field: 'status', values: ['Ready for AI'] }, { field: 'tag', values: ['ai-ok'] }, { field: 'priority', values: ['urgent'] },
      { field: 'due', values: ['3'] }, { field: 'createdBy', values: ['me', '81000002'] }
    ]);
    expect(auto({ conditions: Array.from({ length: 12 }, () => ({ field: 'tag', values: ['x'] })) }).conditions).toHaveLength(8);
    // Notion has no tag or priority.
    expect(auto({ source: { connector: 'notion', scopes: ['0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0'] }, conditions }).conditions.map((c) => c.field))
      .toEqual(['status', 'due', 'createdBy']);
  });

  test('condition labels: display names, one clean line each, kept only with one per value', () => {
    expect(auto({ conditions: [{ field: 'createdBy', values: ['me', '81000002'], labels: ['Me', 'Grace\nFake'] }] }).conditions)
      .toEqual([{ field: 'createdBy', values: ['me', '81000002'], labels: ['Me', 'Grace Fake'] }]);
    // A value dropped by cleaning takes its label with it; a mismatch drops the labels.
    expect(auto({ conditions: [{ field: 'assignee', values: ['me', ' ', '81000002'], labels: ['Me', 'Nobody', 'Grace'] }] }).conditions)
      .toEqual([{ field: 'assignee', values: ['me', '81000002'], labels: ['Me', 'Grace'] }]);
    expect(auto({ conditions: [{ field: 'assignee', values: ['me', '81000002'], labels: ['Me'] }] }).conditions)
      .toEqual([{ field: 'assignee', values: ['me', '81000002'] }]);
    expect(auto({ conditions: [{ field: 'assignee', values: ['me'], labels: 'Me' }] }).conditions).toEqual([{ field: 'assignee', values: ['me'] }]);
    expect(auto({ conditions: [{ field: 'assignee', values: ['81000002'], labels: ['x'.repeat(150)] }] }).conditions[0]!.labels).toEqual(['x'.repeat(100)]);
    // An empty label after cleaning reads as "…", like a scope's.
    expect(auto({ conditions: [{ field: 'assignee', values: ['81000002'], labels: ['\u0007'] }] }).conditions[0]!.labels).toEqual(['…']);
  });

  test('claude: a known account id, model and mode; never bypass or dontAsk', () => {
    expect(auto({ claude: { account: 'work-2', model: 'opus', mode: 'plan', decideAlone: true, useSourceMcp: true } }).claude)
      .toEqual({ account: 'work-2', model: 'opus', mode: 'plan', decideAlone: true, useSourceMcp: true });
    for (const mode of ['bypassPermissions', 'dontAsk', 'inherit', 'x']) expect(auto({ claude: { mode } }).claude.mode).toBe('auto');
    expect(auto({ claude: { account: 'bad id', model: 'gpt' } }).claude).toMatchObject({ account: 'default', model: 'default' });
  });

  test('isolation: worktree on by default; base default, current or a branch name git would take', () => {
    expect(auto({ isolation: { worktree: false, base: 'current' } }).isolation).toEqual({ worktree: false, base: 'current' });
    expect(auto({ isolation: { base: { branch: 'release/1.2' } } }).isolation.base).toEqual({ branch: 'release/1.2' });
    for (const branch of ['-x', 'a..b', 'a b', '', 'refs/heads/x', 'x.lock', 'a~1']) {
      expect(auto({ isolation: { base: { branch } } }).isolation.base, branch).toBe('default');
    }
  });

  test('instructions: up to 8 KB, line breaks and tabs kept, other control characters dropped', () => {
    expect(auto({ instructions: 'Test first.\n\tThen fix.\u0007\u001b[31m' }).instructions).toBe('Test first.\n\tThen fix.[31m');
    expect(auto({ instructions: 'é'.repeat(9000) }).instructions.length).toBe(8192);
  });

  test('limits: each in its range, else its default; usage pause off or 50–95%', () => {
    expect(auto({ limits: { concurrent: 5, perDay: 50, checkEveryMin: 15, usagePause: null } }).limits)
      .toEqual({ concurrent: 5, perDay: 50, checkEveryMin: 15, usagePause: null });
    expect(auto({ limits: { concurrent: 9, perDay: 0, checkEveryMin: 3, usagePause: 99 } }).limits)
      .toEqual({ concurrent: 2, perDay: 10, checkEveryMin: 2, usagePause: 80 });
  });
});

describe('needsConsent: names never ask again', () => {
  test('a condition\'s labels changing is not a wider automation; its values are', () => {
    const a = auto({ conditions: [{ field: 'createdBy', values: ['me', '81000002'], labels: ['Me', 'Grace'] }] });
    expect(needsConsent(a, { ...a, conditions: [{ field: 'createdBy', values: ['me', '81000002'], labels: ['Me', 'Grace Hopper'] }] })).toBe(false);
    expect(needsConsent(a, { ...a, conditions: [{ field: 'createdBy', values: ['me', '81000002'] }] })).toBe(false);
    expect(needsConsent(a, { ...a, conditions: [{ field: 'createdBy', values: ['me'], labels: ['Me'] }] })).toBe(true);
    expect(needsConsent(a, { ...a, conditions: [{ field: 'assignee', values: ['me', '81000002'], labels: ['Me', 'Grace'] }] })).toBe(true);
  });
});

describe('conditionValues: what the chips suggest', () => {
  const t = (o: Partial<WatchedTask>): WatchedTask => ({ id: 'x', scope: 'l1', displayId: 'X', title: 'x', url: '', status: 'to do', assignees: [], tags: [], ...o });
  test('statuses and tags counted over every task, most used first, then by name; defined statuses after with 0', () => {
    const tasks = [
      t({ id: '1', status: 'to do', tags: ['ux', 'copy'] }), t({ id: '2', status: 'In progress', tags: ['UX'] }),
      t({ id: '3', status: 'in progress', tags: [] }), t({ id: '4', status: 'review', tags: ['auth'] })
    ];
    const v = conditionValues(tasks, [], [{ name: 'To Do', color: '#87909e' }, { name: 'blocked' }, { name: 'Review', color: '#ffcc00' }]);
    // Case-insensitive, as matching compares: the first spelling seen wins; a defined status lends its color.
    expect(v.status).toEqual([
      { name: 'In progress', count: 2 }, { name: 'review', color: '#ffcc00', count: 1 }, { name: 'to do', color: '#87909e', count: 1 }, { name: 'blocked', count: 0 }
    ]);
    expect(v.tag).toEqual([{ name: 'ux', count: 2 }, { name: 'auth', count: 1 }, { name: 'copy', count: 1 }]);
  });

  test('people: assignees and creators, by name from the read; an id without a name is left out', () => {
    const tasks = [
      t({ id: '1', assignees: ['81000001', '81000002'], creatorId: '81000002' }), t({ id: '2', assignees: ['81000002'] }), t({ id: '3', assignees: ['99'] })
    ];
    const v = conditionValues(tasks, [{ id: '81000001', name: 'Ada Fake' }, { id: '81000002', name: 'Grace Fake' }], []);
    expect(v.people).toEqual([{ id: '81000002', name: 'Grace Fake', count: 2 }, { id: '81000001', name: 'Ada Fake', count: 1 }]);
  });

  test('caps: 100 statuses, 200 tags, 200 people; empty names skipped', () => {
    const many = Array.from({ length: 250 }, (_, i) => t({ id: String(i), status: `s${i}`, tags: [`g${i}`, ''], assignees: [String(i)] }));
    const v = conditionValues(many, many.map((x) => ({ id: x.id, name: `P ${x.id}` })), Array.from({ length: 50 }, (_, i) => ({ name: `d${i}` })));
    expect(v.status).toHaveLength(100);
    expect(v.tag).toHaveLength(200);
    expect(v.people).toHaveLength(200);
    expect(v.tag.some((g) => g.name === '')).toBe(false);
    expect(conditionValues([t({ status: '' })], [], [{ name: '' }]).status).toEqual([]);
  });
});

const task = (o: Partial<WatchedTask> = {}): WatchedTask => ({
  id: 't1', scope: 'l1', displayId: 'CU-1', title: 'Fix the totals', url: 'https://app.clickup.com/t/t1', status: 'Ready for AI',
  assignees: ['81000001'], tags: ['ai-ok'], ...o
});
const ctx = { me: '81000001', now: Date.UTC(2026, 9, 19, 12) };
const DAY = 24 * 3600_000;

describe('matches: every condition must hold', () => {
  const m = (conditions: Condition[], t: Partial<WatchedTask> = {}) => matches(task(t), conditions, ctx);

  test('no conditions: every task in the scope', () => {
    expect(m([])).toBe(true);
  });

  test('status: any of the names, case-insensitive', () => {
    expect(m([{ field: 'status', values: ['ready for ai', 'Todo'] }])).toBe(true);
    expect(m([{ field: 'status', values: ['Done'] }])).toBe(false);
  });

  test('assignee and createdBy: any of the ids, "me" is the connected user; no creator known → no match', () => {
    expect(m([{ field: 'assignee', values: ['me'] }])).toBe(true);
    expect(m([{ field: 'assignee', values: ['81000002'] }])).toBe(false);
    expect(m([{ field: 'assignee', values: ['me'] }], { assignees: [] })).toBe(false);
    expect(m([{ field: 'createdBy', values: ['me'] }], { creatorId: '81000001' })).toBe(true);
    expect(m([{ field: 'createdBy', values: ['me', '81000002'] }], { creatorId: '81000003' })).toBe(false);
    expect(m([{ field: 'createdBy', values: ['me'] }])).toBe(false);
  });

  test('tag: has any of them, case-insensitive', () => {
    expect(m([{ field: 'tag', values: ['AI-OK'] }])).toBe(true);
    expect(m([{ field: 'tag', values: ['backend'] }])).toBe(false);
  });

  test('priority: at least the one named (urgent > high > normal > low); none set → no match', () => {
    expect(m([{ field: 'priority', values: ['high'] }], { priority: 'urgent' })).toBe(true);
    expect(m([{ field: 'priority', values: ['high'] }], { priority: 'high' })).toBe(true);
    expect(m([{ field: 'priority', values: ['high'] }], { priority: 'normal' })).toBe(false);
    expect(m([{ field: 'priority', values: ['low'] }])).toBe(false);
  });

  test('title: contains the text, case-insensitive', () => {
    expect(m([{ field: 'title', values: ['TOTALS'] }])).toBe(true);
    expect(m([{ field: 'title', values: ['login'] }])).toBe(false);
  });

  test('due: within N days from now, overdue included; no due date → no match', () => {
    expect(m([{ field: 'due', values: ['3'] }], { due: ctx.now + 2 * DAY })).toBe(true);
    expect(m([{ field: 'due', values: ['3'] }], { due: ctx.now - DAY })).toBe(true);
    expect(m([{ field: 'due', values: ['3'] }], { due: ctx.now + 4 * DAY })).toBe(false);
    expect(m([{ field: 'due', values: ['3'] }])).toBe(false);
  });

  test('all of them together', () => {
    const cs: Condition[] = [{ field: 'status', values: ['Ready for AI'] }, { field: 'tag', values: ['ai-ok'] }, { field: 'createdBy', values: ['me'] }];
    expect(m(cs, { creatorId: '81000001' })).toBe(true);
    expect(m(cs, { creatorId: '81000001', tags: [] })).toBe(false);
  });

  test('needsCreator: only when a createdBy condition is there', () => {
    expect(needsCreator([{ field: 'tag', values: ['x'] }])).toBe(false);
    expect(needsCreator([{ field: 'createdBy', values: ['me'] }])).toBe(true);
  });

  test('conditionFields: ClickUp has all seven; Notion has no assignee, tag or priority, and createdBy only with a creator column', () => {
    expect(conditionFields('clickup', false)).toEqual(['status', 'assignee', 'createdBy', 'tag', 'priority', 'title', 'due']);
    // The database's own "Assigned to me / Everyone" setting governs assignees on Notion.
    expect(conditionFields('notion', false)).toEqual(['status', 'title', 'due']);
    expect(conditionFields('notion', true)).toEqual(['status', 'createdBy', 'title', 'due']);
  });
});

describe('the seen ledger', () => {
  const now = ctx.now;

  test('a matching task runs once: after a poll it is in the ledger, matched and done', () => {
    const ledger: Ledger = {};
    expect(newMatches([task()], ledger, false).map((t) => t.id)).toEqual(['t1']);
    const after = ledgerAfterPoll(ledger, { seen: ['t1', 't2'], matched: ['t1'] }, now);
    expect(after).toEqual({ t1: { at: now, matched: true, done: true }, t2: { at: now, matched: false, done: false } });
    expect(newMatches([task()], after, false)).toEqual([]);
  });

  test('a task seen while it didn\'t match runs when it starts matching (the task moved to "Ready for AI")', () => {
    const l = ledgerAfterPoll({}, { seen: ['t1'], matched: [] }, now);
    expect(newMatches([task()], l, false).map((t) => t.id)).toEqual(['t1']);
  });

  test('turning on baselines: what matches now is in the ledger, so it never runs (unless the user asks)', () => {
    const baseline = ledgerAfterPoll({}, { seen: ['t1'], matched: ['t1'] }, now);
    expect(newMatches([task()], baseline, false)).toEqual([]);
  });

  test('rerun when it matches again: only a task that stopped matching and matches again', () => {
    let l = ledgerAfterPoll({}, { seen: ['t1'], matched: ['t1'] }, now);
    expect(newMatches([task()], l, true)).toEqual([]);
    l = ledgerAfterPoll(l, { seen: ['t1'], matched: [] }, now + 1);
    expect(newMatches([task()], l, true).map((t) => t.id)).toEqual(['t1']);
    expect(newMatches([task()], l, false)).toEqual([]);
  });

  test('an id the source hasn\'t reported for 30 days is forgotten; at most 5000 ids, the oldest go first', () => {
    const l = ledgerAfterPoll({ old: { at: now - LEDGER_FORGET_MS - 1, matched: true, done: true }, recent: { at: now - 1000, matched: true, done: true } }, { seen: [], matched: [] }, now);
    expect(Object.keys(l)).toEqual(['recent']);
    const big: Ledger = Object.fromEntries(Array.from({ length: MAX_LEDGER + 10 }, (_, i) => [`t${i}`, { at: now - MAX_LEDGER - 10 + i, matched: true, done: true }]));
    const capped = ledgerAfterPoll(big, { seen: [], matched: [] }, now);
    expect(Object.keys(capped)).toHaveLength(MAX_LEDGER);
    expect(capped.t0).toBeUndefined();
    expect(capped[`t${MAX_LEDGER + 9}`]).toBeDefined();
  });
});

describe('decide: start, queued or held', () => {
  const a = (limits: Partial<Automation['limits']> = {}) => auto({ limits: { ...AUTOMATION_DEFAULTS.limits, ...limits } });
  const free = { perAutomationActive: 0, globalActive: 0, todayCount: 0, usagePercent: 10 as number | null, manual: false };
  const s = AUTOMATIONS_SETTINGS_DEFAULTS;

  test('room everywhere → start', () => {
    expect(decide(a(), s, free)).toEqual({ kind: 'start' });
  });

  test('the day\'s count first, then usage, then the automation\'s own limit, then the global cap', () => {
    const all = { perAutomationActive: 2, globalActive: 3, todayCount: 10, usagePercent: 90, manual: false };
    expect(decide(a(), s, all)).toEqual({ kind: 'queued', reason: 'perDay' });
    expect(decide(a(), s, { ...all, todayCount: 0 })).toEqual({ kind: 'queued', reason: 'usage' });
    expect(decide(a(), s, { ...all, todayCount: 0, usagePercent: 10 })).toEqual({ kind: 'queued', reason: 'perAutomation' });
    expect(decide(a(), s, { ...free, globalActive: 3 })).toEqual({ kind: 'held', reason: 'global' });
    expect(decide(a(), { ...s, whenFull: 'queue' }, { ...free, globalActive: 3 })).toEqual({ kind: 'queued', reason: 'global' });
  });

  test('usage: unknown never blocks; the pause off never blocks', () => {
    expect(decide(a(), s, { ...free, usagePercent: null })).toEqual({ kind: 'start' });
    expect(decide(a({ usagePause: null }), s, { ...free, usagePercent: 99 })).toEqual({ kind: 'start' });
    expect(decide(a({ usagePause: 80 }), s, { ...free, usagePercent: 80 })).toEqual({ kind: 'queued', reason: 'usage' });
  });

  test('the global cap counts starting runs too (the caller adds them); default 3, ask when full', () => {
    expect(s).toEqual({ cap: 3, whenFull: 'ask', paused: false, keepAwake: false });
    expect(decide(a(), s, { ...free, globalActive: 2 })).toEqual({ kind: 'start' });
  });

  test('a start the user asked for always starts', () => {
    expect(decide(a(), s, { perAutomationActive: 9, globalActive: 9, todayCount: 99, usagePercent: 99, manual: true })).toEqual({ kind: 'start' });
  });
});

describe('isCatchUp: a gap longer than twice the interval', () => {
  test('first poll ever is not a catch-up; a gap of more than 2 × interval is', () => {
    const min = 60_000;
    expect(isCatchUp(null, 10 * min, 2 * min)).toBe(false);
    expect(isCatchUp(0, 4 * min, 2 * min)).toBe(false);
    expect(isCatchUp(0, 4 * min + 1, 2 * min)).toBe(true);
  });
});
