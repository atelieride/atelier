import { describe, expect, test } from 'vitest';
import type { ConnectorInfo, SourceInfo, TaskList, TaskSummary } from '@shared/tasks';
import { chooseSourcesLabel, onlyChosenNote, searchInLabel, taskChipLabel, taskToastName, ALL_MODE_ROWS, dueLabel, liveConnectors, sectionCount, statusTone, taskChipTip, taskFooter, taskSections, tasksEmptyLine, tasksKey, type TaskSection } from './task-view';

const summary = (id: string, over: Partial<TaskSummary> = {}): TaskSummary => ({
  id, displayId: id.toUpperCase(), title: `Task ${id}`, status: { name: 'to do', color: '#87909e' }, url: `https://app.clickup.com/t/${id}`, ...over
});
const list = (over: Partial<TaskList> = {}): TaskList => ({ source: 'clickup', status: 'connected', loading: false, updatedAt: 1000, tasks: [], ...over });
const TASKS = [
  summary('86a', { displayId: 'ENG-101', title: 'Fix the login redirect loop', listName: 'Sprint 42' }),
  summary('86b', { displayId: '86b', title: 'Document the CSV import format', listName: 'Backlog' }),
  summary('86c', { displayId: 'ENG-103', title: 'Review the onboarding copy', listName: 'Sprint 42' })
];
// Notion rows: two without an ID (a database with no unique-ID column), two with one.
const NOTION = [
  summary('n1', { displayId: '', title: 'Add rate limiting to the export endpoint', listName: 'Sprint Tasks' }),
  summary('n2', { displayId: '', title: 'Fix flaky login test on CI', listName: 'Sprint Tasks' }),
  summary('n3', { displayId: 'ENG-1', title: 'Dark mode for the billing page', listName: 'Engineering Backlog' }),
  summary('n4', { displayId: 'ENG-2', title: 'Pricing page copy review', listName: 'Engineering Backlog' })
];
const notionList = (over: Partial<TaskList> = {}): TaskList => list({ source: 'notion', tasks: NOTION, ...over });
const DB: SourceInfo = { id: 'a'.repeat(32), name: 'Sprint Tasks', fields: { title: 'Name' }, loading: false };

/** Each section as its rows' ids, or its kind when it says something instead. */
const shape = (s: TaskSection[]) => s.map((x) => (x.kind === 'tasks' ? [x.source, x.rows.map((r) => r.task.id)] : [x.source, x.kind]));

describe('statusTone: a ClickUp color → the nearest state token (never the raw hex)', () => {
  test.each([
    ['#87909e', 'idle'], // ClickUp's grey "to do"
    ['#5f55ee', 'violet'], // its indigo "in progress"
    ['#f8ae00', 'waiting'], // amber "review"
    ['#008844', 'done'], // green "complete"
    ['#d33d44', 'error'],
    ['#e50000', 'error'],
    ['#0ab4ff', 'working'],
    ['#1090e0', 'working'],
    ['#ff7800', 'waiting'],
    ['#f9d900', 'waiting'],
    ['#2ecd6f', 'done'],
    ['#7c4dff', 'violet'],
    ['#000000', 'idle'],
    ['#ffffff', 'idle'],
    ['#FBBF24', 'waiting'],
    ['#abc', 'working'], // the short form: a pale blue
    ['#999', 'idle'],
    ['#f00', 'error'],
    [undefined, 'idle'],
    ['', 'idle'],
    ['red', 'idle'],
    ['#12345', 'idle'],
    ['url(javascript:1)', 'idle']
  ])('%s → %s', (color, tone) => {
    expect(statusTone(color)).toBe(tone);
  });
  // tests/integration/theme.test.ts keeps TONE_COLORS equal to theme.css's tokens.
});

describe('dueLabel', () => {
  const now = new Date(2026, 9, 11, 15, 0).getTime();
  test.each([
    [new Date(2026, 9, 11, 23, 0).getTime(), 'Today', false],
    [new Date(2026, 9, 12, 9, 0).getTime(), 'Tomorrow', false],
    [new Date(2026, 9, 10, 9, 0).getTime(), 'Yesterday', true],
    [new Date(2026, 9, 16, 9, 0).getTime(), 'Oct 16', false],
    [new Date(2026, 8, 30, 9, 0).getTime(), 'Sep 30', true],
    [new Date(2027, 0, 5, 9, 0).getTime(), 'Jan 5, 2027', false]
  ])('%i → %s (overdue: %s)', (due, text, overdue) => {
    expect(dueLabel(due, now)).toEqual({ text, overdue });
  });
  test('earlier today is not overdue (a due date is a day)', () => {
    expect(dueLabel(new Date(2026, 9, 11, 8, 0).getTime(), now)).toEqual({ text: 'Today', overdue: false });
  });
});

describe('taskSections: one connector, the palette\'s tasks', () => {
  test('everything mode: only while searching, matching title, display id or list, a few rows', () => {
    const lists = [list({ tasks: TASKS })];
    expect(taskSections(lists, { mode: 'all', text: '' })).toEqual([]);
    expect(shape(taskSections(lists, { mode: 'all', text: 'login' }))).toEqual([['clickup', ['86a']]]);
    expect(shape(taskSections(lists, { mode: 'all', text: 'ENG-103' }))).toEqual([['clickup', ['86c']]]);
    expect(shape(taskSections(lists, { mode: 'all', text: 'backlog' }))).toEqual([['clickup', ['86b']]]);
    expect(taskSections(lists, { mode: 'all', text: 'zzzz' })).toEqual([]);
    // Free text (bug 2026-11-02): letters scattered over a title are no match; words in any order are.
    expect(taskSections(lists, { mode: 'all', text: 'frdlp' })).toEqual([]);
    expect(shape(taskSections(lists, { mode: 'all', text: 'redirect login' }))).toEqual([['clickup', ['86a']]]);
    const many = taskSections([list({ tasks: Array.from({ length: 20 }, (_, i) => summary(`t${i}`, { title: `Login ${i}` })) })], { mode: 'all', text: 'login' });
    expect(many[0]?.kind === 'tasks' && many[0].rows.length).toBe(5);
    expect(ALL_MODE_ROWS).toBe(5);
  });

  test('everything mode: nothing while not connected (the connector commands say what to do)', () => {
    for (const status of ['disconnected', 'connecting', 'reconnect', 'unavailable'] as const) {
      expect(taskSections([list({ status, tasks: [] })], { mode: 'all', text: 'login' })).toEqual([]);
    }
  });

  test('task: mode lists every task without a query, filters with one', () => {
    const lists = [list({ tasks: TASKS })];
    expect(shape(taskSections(lists, { mode: 'tasks', text: '' }))).toEqual([['clickup', ['86a', '86b', '86c']]]);
    const some = taskSections(lists, { mode: 'tasks', text: 'sprint' });
    expect(some[0]?.kind === 'tasks' && some[0].rows.map((r) => r.task.id).sort()).toEqual(['86a', '86c']);
    expect(some[0]).toMatchObject({ count: 2 });
    expect(taskSections(lists, { mode: 'tasks', text: 'zzzz' })).toEqual([{ source: 'clickup', kind: 'tasks', rows: [], stale: false, count: 0 }]);
  });

  test('task: mode adds what ClickUp\'s search found beyond the cached list, once', () => {
    const found = { clickup: [summary('86a'), summary('99z', { title: 'Found by search' })] };
    expect(shape(taskSections([list({ tasks: TASKS })], { mode: 'tasks', text: 'login', found }))).toEqual([['clickup', ['86a', '99z']]]);
  });

  test('rows carry the status tone; offline rows are stale, with the time of the cache', () => {
    const live = taskSections([list({ tasks: TASKS })], { mode: 'tasks', text: '' });
    expect(live[0]?.kind === 'tasks' && live[0].rows[0]).toMatchObject({ source: 'clickup', tone: 'idle' });
    expect(live[0]).toMatchObject({ stale: false, count: 3 });
    const offline = taskSections([list({ status: 'offline', updatedAt: 5000, tasks: TASKS })], { mode: 'tasks', text: '' });
    expect(offline).toMatchObject([{ source: 'clickup', kind: 'tasks', stale: true, since: 5000 }]);
  });

  test('task: mode offline with nothing ever fetched (offline at launch): the offline line, never "No open tasks"', () => {
    const empty = list({ status: 'offline', updatedAt: undefined, tasks: [] });
    expect(taskSections([empty], { mode: 'tasks', text: '' })).toEqual([{ source: 'clickup', kind: 'offline' }]);
    expect(taskSections([empty], { mode: 'tasks', text: 'login' })).toEqual([{ source: 'clickup', kind: 'offline' }]);
    // A retry running meanwhile changes nothing (no flicker to "Loading tasks…").
    expect(taskSections([{ ...empty, loading: true }], { mode: 'tasks', text: '' })).toEqual([{ source: 'clickup', kind: 'offline' }]);
    // The broadcast says offline before any list came.
    expect(taskSections([], { mode: 'tasks', text: '', statuses: { clickup: 'offline' } })).toEqual([{ source: 'clickup', kind: 'offline' }]);
    // Everything search: nothing to show.
    expect(taskSections([empty], { mode: 'all', text: 'login' })).toEqual([]);
    // A list fetched before going offline that was really empty: still the (stale) tasks group, with its time.
    expect(taskSections([list({ status: 'offline', updatedAt: 5000, tasks: [] })], { mode: 'tasks', text: '' }))
      .toEqual([{ source: 'clickup', kind: 'tasks', rows: [], stale: true, since: 5000, count: 0 }]);
  });

  test('task: mode: "Loading tasks…" while the first fetch runs', () => {
    expect(taskSections([list({ loading: true, tasks: [] })], { mode: 'tasks', text: '' })).toEqual([{ source: 'clickup', kind: 'loading' }]);
    // A refresh with tasks already there keeps showing them.
    expect(taskSections([list({ loading: true, tasks: TASKS })], { mode: 'tasks', text: '' })[0]?.kind).toBe('tasks');
    // Not listed yet (the first tasks:list reply hasn't come): loading too, once connected.
    expect(taskSections([], { mode: 'tasks', text: '', statuses: { clickup: 'connected' } })).toEqual([{ source: 'clickup', kind: 'loading' }]);
  });

  test('task: mode: signed out → one Reconnect row; not connected → Connect; unavailable → its reason', () => {
    expect(taskSections([list({ status: 'reconnect' })], { mode: 'tasks', text: '' })).toEqual([{ source: 'clickup', kind: 'reconnect' }]);
    expect(taskSections([list({ status: 'disconnected' })], { mode: 'tasks', text: '' })).toEqual([{ source: 'clickup', kind: 'connect' }]);
    expect(taskSections([list({ status: 'connecting' })], { mode: 'tasks', text: '' })).toEqual([{ source: 'clickup', kind: 'connecting' }]);
    expect(taskSections([list({ status: 'unavailable' })], { mode: 'tasks', text: '' })).toEqual([{ source: 'clickup', kind: 'unavailable' }]);
    // The connectors' broadcast is newer than the last list: it wins.
    expect(taskSections([list({ tasks: TASKS })], { mode: 'tasks', text: '', statuses: { clickup: 'reconnect' } })).toEqual([{ source: 'clickup', kind: 'reconnect' }]);
  });
});

describe('taskSections: one section per connector', () => {
  const both = { clickup: 'connected', notion: 'connected' } as const;

  test('two connectors → two sections, in the connectors\' order, each with its count', () => {
    // The lists may come in any order: the sections follow the connectors'.
    const s = taskSections([notionList(), list({ tasks: TASKS })], { mode: 'tasks', text: '', statuses: both });
    expect(shape(s)).toEqual([['clickup', ['86a', '86b', '86c']], ['notion', ['n1', 'n2', 'n3', 'n4']]]);
    expect(s.map((x) => x.kind === 'tasks' && x.count)).toEqual([3, 4]);
    expect(s[1]?.kind === 'tasks' && s[1].rows.every((r) => r.source === 'notion')).toBe(true);
  });

  test('everything mode: each live connector\'s matches, at most 5 per section; a connector without matches says nothing', () => {
    const many = (source: 'clickup' | 'notion') => list({ source, tasks: Array.from({ length: 20 }, (_, i) => summary(`${source}${i}`, { title: `Page ${i}` })) });
    const s = taskSections([many('clickup'), many('notion')], { mode: 'all', text: 'page', statuses: both });
    expect(s.map((x) => [x.source, x.kind === 'tasks' && x.rows.length])).toEqual([['clickup', 5], ['notion', 5]]);
    const onlyNotion = taskSections([list({ tasks: TASKS }), notionList()], { mode: 'all', text: 'billing', statuses: both });
    expect(shape(onlyNotion)).toEqual([['notion', ['n3']]]);
  });

  test('task: mode: a disconnected or signed-out connector shows nothing while another one is live', () => {
    const s = taskSections([list({ tasks: TASKS }), notionList({ status: 'disconnected', tasks: [] })], { mode: 'tasks', text: '' });
    expect(shape(s)).toEqual([['clickup', ['86a', '86b', '86c']]]);
    const r = taskSections([list({ tasks: TASKS })], { mode: 'tasks', text: '', statuses: { clickup: 'connected', notion: 'reconnect' } });
    expect(shape(r)).toEqual([['clickup', ['86a', '86b', '86c']]]);
  });

  test('task: mode with none live: one section per connector, saying what each needs', () => {
    expect(taskSections([], { mode: 'tasks', text: '', statuses: { clickup: 'reconnect', notion: 'disconnected', jira: 'disconnected' } }))
      .toEqual([{ source: 'clickup', kind: 'reconnect' }, { source: 'notion', kind: 'connect' }, { source: 'jira', kind: 'connect' }]);
    expect(taskSections([], { mode: 'tasks', text: 'x', statuses: { clickup: 'disconnected', notion: 'connecting', jira: 'reconnect' } }))
      .toEqual([{ source: 'clickup', kind: 'connect' }, { source: 'notion', kind: 'connecting' }, { source: 'jira', kind: 'reconnect' }]);
    // Before main has said anything: Connect for every connector.
    expect(taskSections([], { mode: 'tasks', text: '' }))
      .toEqual([{ source: 'clickup', kind: 'connect' }, { source: 'notion', kind: 'connect' }, { source: 'jira', kind: 'connect' }]);
  });

  test('task: mode: one connector still loading while the other has tasks', () => {
    const s = taskSections([list({ tasks: TASKS })], { mode: 'tasks', text: '', statuses: both });
    expect(shape(s)).toEqual([['clickup', ['86a', '86b', '86c']], ['notion', 'loading']]);
  });

  test('stale per section: only the offline connector\'s rows are greyed, with its own time', () => {
    const s = taskSections([list({ status: 'offline', updatedAt: 5000, tasks: TASKS }), notionList()], { mode: 'tasks', text: '' });
    expect(s).toMatchObject([{ source: 'clickup', stale: true, since: 5000 }, { source: 'notion', stale: false }]);
    expect(s[1]).not.toHaveProperty('since');
  });

  test('clickup: / notion: → that connector only, its state section when not live', () => {
    const lists = [list({ tasks: TASKS }), notionList()];
    expect(shape(taskSections(lists, { mode: 'tasks', source: 'notion', text: 'rate', statuses: both }))).toEqual([['notion', ['n1']]]);
    expect(shape(taskSections(lists, { mode: 'tasks', source: 'clickup', text: '', statuses: both }))).toEqual([['clickup', ['86a', '86b', '86c']]]);
    // Notion disconnected: its Connect section, even with ClickUp live.
    expect(taskSections([list({ tasks: TASKS })], { mode: 'tasks', source: 'notion', text: '', statuses: { clickup: 'connected', notion: 'disconnected' } }))
      .toEqual([{ source: 'notion', kind: 'connect' }]);
    // Not known to main at all: Connect too.
    expect(taskSections([list({ tasks: TASKS })], { mode: 'tasks', source: 'notion', text: '' })).toEqual([{ source: 'notion', kind: 'connect' }]);
    expect(taskSections([list({ tasks: TASKS })], { mode: 'tasks', source: 'clickup', text: '', statuses: { clickup: 'reconnect' } }))
      .toEqual([{ source: 'clickup', kind: 'reconnect' }]);
  });

  test('Notion connected with no databases chosen: "Choose Notion Databases…" instead of its tasks', () => {
    const lists = [list({ tasks: TASKS }), notionList({ tasks: [] })];
    const sources = { notion: [] };
    expect(taskSections(lists, { mode: 'tasks', source: 'notion', text: '', statuses: both, sources })).toEqual([{ source: 'notion', kind: 'choose-sources' }]);
    expect(shape(taskSections(lists, { mode: 'tasks', text: '', statuses: both, sources }))).toEqual([['clickup', ['86a', '86b', '86c']], ['notion', 'choose-sources']]);
    // Even before its first (empty) list came: nothing to load.
    expect(taskSections([], { mode: 'tasks', source: 'notion', text: '', statuses: { notion: 'connected' }, sources })).toEqual([{ source: 'notion', kind: 'choose-sources' }]);
    // The everything search has nothing to say about it.
    expect(shape(taskSections(lists, { mode: 'all', text: 'login', statuses: both, sources }))).toEqual([['clickup', ['86a']]]);
    // With a database chosen: its tasks as usual.
    expect(shape(taskSections([notionList()], { mode: 'tasks', source: 'notion', text: 'rate', statuses: both, sources: { notion: [DB] } }))).toEqual([['notion', ['n1']]]);
  });

  test('what each connector\'s own search found goes into its own section, never the other\'s', () => {
    const found = { clickup: [summary('99c', { title: 'Login from ClickUp search' })], notion: [summary('99n', { displayId: '', title: 'Login from Notion search' })] };
    const s = taskSections([list({ tasks: TASKS }), notionList()], { mode: 'tasks', text: 'login', statuses: both, found });
    expect(shape(s)).toEqual([['clickup', ['86a', '99c']], ['notion', ['n2', '99n']]]);
    expect(s[1]?.kind === 'tasks' && s[1].rows.map((r) => r.source)).toEqual(['notion', 'notion']);
    expect(s.map((x) => x.kind === 'tasks' && x.count)).toEqual([2, 2]);
    // notion: — ClickUp's results are left out with its section.
    expect(shape(taskSections([list({ tasks: TASKS }), notionList()], { mode: 'tasks', source: 'notion', text: 'login', statuses: both, found }))).toEqual([['notion', ['n2', '99n']]]);
    // The everything search never shows search results (only the cached lists).
    expect(shape(taskSections([list({ tasks: TASKS }), notionList()], { mode: 'all', text: 'login', statuses: both, found }))).toEqual([['clickup', ['86a']], ['notion', ['n2']]]);
  });
});

test('liveConnectors: the connectors whose tasks can be searched now (connected or offline), for "Search <App> Tasks…"', () => {
  const info = (id: ConnectorInfo['id'], status: ConnectorInfo['status']): ConnectorInfo => ({ id, name: id, status, loading: false, tasksVersion: 0, options: { show: 'assigned', includeClosed: false } });
  expect(liveConnectors([info('clickup', 'connected'), info('notion', 'offline')])).toEqual(['clickup', 'notion']);
  for (const status of ['disconnected', 'connecting', 'reconnect', 'unavailable'] as const) {
    expect(liveConnectors([info('clickup', status), info('notion', 'connected')])).toEqual(['notion']);
  }
});

describe('taskFooter: the everything search\'s task hints, only while a task row is highlighted', () => {
  test('not on a task (a session, a file, a container, nothing typed): today\'s footer (⌥↵, ↑↓ ↵)', () => {
    expect(taskFooter('all', undefined, ['clickup'])).toBeNull();
    expect(taskFooter('all', undefined, ['clickup', 'notion'])).toBeNull();
  });
  test('outside the everything search: never (task: / notion: keep their footer)', () => {
    expect(taskFooter('tasks', 'clickup', ['clickup', 'notion'])).toBeNull();
    expect(taskFooter('commands', 'clickup', ['clickup'])).toBeNull();
  });
  test('on a task: "task: all tasks", plus "<id>: only <App>" for that task\'s connector when two are live', () => {
    expect(taskFooter('all', 'clickup', ['clickup'])).toEqual({ only: null }); // task: already is that connector
    expect(taskFooter('all', 'notion', ['clickup', 'notion'])).toEqual({ only: 'notion' });
    expect(taskFooter('all', 'clickup', ['clickup', 'notion'])).toEqual({ only: 'clickup' });
    // No live connector (can't happen with a task row, but never a hint to nothing).
    expect(taskFooter('all', 'clickup', [])).toBeNull();
  });
});

test('sectionCount: a section\'s count only in task: mode (several connectors), never with clickup: / notion:', () => {
  const rows = taskSections([list({ tasks: TASKS })], { mode: 'tasks', text: '' })[0]!;
  expect(sectionCount({ mode: 'tasks' }, rows)).toBe(3);
  expect(sectionCount({ mode: 'tasks', source: 'clickup' }, rows)).toBeUndefined();
  expect(sectionCount({ mode: 'all' }, rows)).toBeUndefined();
  // Nothing to count: no "0" next to "No matching tasks".
  const none = taskSections([list({ tasks: TASKS })], { mode: 'tasks', text: 'zzzz' })[0]!;
  expect(sectionCount({ mode: 'tasks' }, none)).toBeUndefined();
  expect(sectionCount({ mode: 'tasks' }, { source: 'notion', kind: 'loading' })).toBeUndefined();
});

test('tasksKey changes when a connector\'s tasks or status change (then tasks:list is asked again), not otherwise', () => {
  const info = (status: ConnectorInfo['status'], tasksVersion: number, loading = false): ConnectorInfo => ({ id: 'clickup', name: 'ClickUp', status, loading, tasksVersion, options: { show: 'assigned', includeClosed: false } });
  expect(tasksKey([info('connected', 1)])).toBe(tasksKey([info('connected', 1, true)]));
  expect(tasksKey([info('connected', 1)])).not.toBe(tasksKey([info('connected', 2)]));
  expect(tasksKey([info('connected', 1)])).not.toBe(tasksKey([info('offline', 1)]));
  expect(tasksKey([])).not.toBe(tasksKey([info('disconnected', 0)]));
});

describe('chip label and toast name for tasks without an ID', () => {
  const base = { source: 'notion' as const, taskId: 'a'.repeat(32), displayId: '', title: 'Write the launch post', url: 'https://www.notion.so/x' };
  test('aria-label: the title once; with an ID, the ID then the tip', () => {
    expect(taskChipLabel(base, ['Write the launch post', 'No live status'])).toBe('Task Write the launch post. No live status');
    expect(taskChipLabel({ ...base, displayId: 'ENG-1' }, ['Write the launch post', 'x'])).toBe('Task ENG-1. Write the launch post. x');
    // A tip with only the title: no trailing ". ".
    expect(taskChipLabel(base, ['Write the launch post'])).toBe('Task Write the launch post');
  });
  test('toast name: the ID, else the title on one line, cut at 60 characters', () => {
    expect(taskToastName('ENG-1', 'T')).toBe('ENG-1');
    expect(taskToastName('', 'a\nb')).toBe('a b');
    const n = taskToastName('', 'x'.repeat(300));
    expect([...n].length).toBe(60);
    expect(n.endsWith('…')).toBe(true);
  });
});

describe('taskChipTip', () => {
  const link = { source: 'clickup' as const, taskId: '86a', displayId: 'ENG-101', title: 'Fix the login redirect loop', url: 'https://app.clickup.com/t/86a' };
  test('live: title, status, list, "Updated 5 min ago"', () => {
    const live = summary('86a', { title: 'Fix the login redirect loop (renamed)', status: { name: 'in progress', color: '#5f55ee' }, listName: 'Sprint 42', updatedAt: 10_000 });
    expect(taskChipTip(link, live, 10_000 + 5 * 60_000)).toEqual(['Fix the login redirect loop (renamed)', 'In progress · Sprint 42', 'Updated 5 min ago']);
  });
  test('without live data (disconnected, or not in the list): the saved title, and that the link still opens', () => {
    expect(taskChipTip(link, undefined, 0)).toEqual(['Fix the login redirect loop', 'ENG-101 · no live status']);
  });
  test('a task without an ID: no empty prefix on the status line', () => {
    expect(taskChipTip({ ...link, source: 'notion', displayId: '' }, undefined, 0)).toEqual(['Fix the login redirect loop', 'No live status']);
  });
  test('a due date is a line of its own after status · list, for every source', () => {
    const now = new Date(2026, 9, 17, 9).getTime();
    const due = new Date(2026, 9, 21).getTime();
    const notion = summary('n1', { displayId: '', title: 'Add rate limiting', status: { name: 'In progress', color: '#60A5FA' }, listName: 'Sprint Tasks', due });
    expect(taskChipTip({ ...link, source: 'notion', displayId: '', title: 'Add rate limiting' }, notion, now)).toEqual(['Add rate limiting', 'In progress · Sprint Tasks', 'Due Oct 21']);
    const clickup = summary('86a', { title: 'Fix the login redirect loop', status: { name: 'in progress', color: '#5f55ee' }, listName: 'Sprint 42', due: new Date(2026, 9, 10).getTime(), updatedAt: now - 5 * 60_000 });
    expect(taskChipTip(link, clickup, now)).toEqual(['Fix the login redirect loop', 'In progress · Sprint 42', 'Overdue · due Oct 10', 'Updated 5 min ago']);
  });
});

describe('tasksEmptyLine: what a connector\'s empty section says', () => {
  const notionInfo = (sources: SourceInfo[]): ConnectorInfo => ({ id: 'notion', name: 'Notion', status: 'connected', loading: false, tasksVersion: 0, options: { show: 'assigned', includeClosed: false }, sources });
  const clickupInfo: ConnectorInfo = { id: 'clickup', name: 'ClickUp', status: 'connected', loading: false, tasksVersion: 0, options: { show: 'assigned', includeClosed: false } };
  test('ClickUp lists only your tasks: "No open tasks assigned to you"', () => {
    expect(tasksEmptyLine(clickupInfo, false)).toBe('No open tasks assigned to you');
    expect(tasksEmptyLine(undefined, false)).toBe('No open tasks assigned to you');
  });
  test('Notion with a database set to Everyone (or without a person column): "No open tasks"', () => {
    const mine = { ...DB, fields: { title: 'Name', assignee: { prop: 'Owner', mine: true } } };
    expect(tasksEmptyLine(notionInfo([mine]), false)).toBe('No open tasks assigned to you');
    expect(tasksEmptyLine(notionInfo([mine, { ...DB, id: 'b'.repeat(32), fields: { title: 'Name', assignee: { prop: 'Owner', mine: false } } }]), false)).toBe('No open tasks');
    expect(tasksEmptyLine(notionInfo([DB]), false)).toBe('No open tasks');
  });
  test('with a query: "No matching tasks"', () => {
    expect(tasksEmptyLine(notionInfo([DB]), true)).toBe('No matching tasks');
    expect(tasksEmptyLine(clickupInfo, true)).toBe('No matching tasks');
  });
  test('Jira says issues; a project set to Everyone lists everyone\'s', () => {
    const project = { id: '10001', key: 'ATL', name: 'Atelier', type: 'software' as const, everyone: false, loading: false };
    const jiraInfo = (everyone: boolean): ConnectorInfo => ({ ...clickupInfo, id: 'jira', name: 'Jira', projects: [{ ...project, everyone }] });
    expect(tasksEmptyLine(jiraInfo(false), false)).toBe('No open issues assigned to you');
    expect(tasksEmptyLine(jiraInfo(true), false)).toBe('No open issues');
    expect(tasksEmptyLine(jiraInfo(true), true)).toBe('No matching issues');
  });
});

describe('Jira in the palette', () => {
  const ATL = summary('10103', { displayId: 'ATL-3', title: 'Billing export drops the last row', listName: 'Atelier', url: 'https://acme.atlassian.net/browse/ATL-3' });
  const jiraList = (over: Partial<TaskList> = {}): TaskList => list({ source: 'jira', tasks: [ATL], ...over });
  test('no project chosen: task: and jira: show "Choose Jira Projects…" instead of rows; the everything search nothing', () => {
    const q = { statuses: { clickup: 'disconnected', notion: 'disconnected', jira: 'connected' } as const, sources: { jira: [] } };
    expect(shape(taskSections([jiraList({ tasks: [] })], { mode: 'tasks', text: '', ...q }))).toEqual([['jira', 'choose-sources']]);
    expect(shape(taskSections([jiraList({ tasks: [] })], { mode: 'tasks', source: 'jira', text: '', ...q }))).toEqual([['jira', 'choose-sources']]);
    expect(taskSections([jiraList({ tasks: [] })], { mode: 'all', text: 'bill', ...q })).toEqual([]);
    expect(chooseSourcesLabel('jira', 'Jira')).toBe('Choose Jira Projects…');
    expect(chooseSourcesLabel('notion', 'Notion')).toBe('Choose Notion Databases…');
  });
  test('its issues as rows, by key or title', () => {
    const sections = taskSections([jiraList()], { mode: 'tasks', source: 'jira', text: 'ATL-3', statuses: { jira: 'connected' }, sources: { jira: [{}] } });
    expect(shape(sections)).toEqual([['jira', ['10103']]]);
  });
  test('the commands and the note name issues and projects', () => {
    expect(searchInLabel('jira', 'Jira')).toBe('Search Jira Issues…');
    expect(searchInLabel('notion', 'Notion')).toBe('Search Notion Tasks…');
    expect(onlyChosenNote({ source: 'jira', text: 'bill' }, 'jira')).toBe('Only the projects you chose in Settings › Connectors are searched.');
    expect(onlyChosenNote({ source: 'notion', text: 'rate' }, 'notion')).toBe('Only the databases you chose in Settings › Connectors are searched.');
    expect(onlyChosenNote({ source: 'jira', text: '' }, 'jira')).toBeUndefined();
    expect(onlyChosenNote({ text: 'bill' }, 'jira')).toBeUndefined();
    expect(onlyChosenNote({ source: 'clickup', text: 'bill' }, 'clickup')).toBeUndefined();
  });
});
