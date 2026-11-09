import { describe, expect, test } from 'vitest';
import { MAX_CLOSED_OPTIONS, type Column, type ConnectorInfo, type NotionFields, type SourceInfo, type SourcePick, type TaskSummary } from '@shared/tasks';
import {
  addErrorText, canAdd, chooseColumn, columnTypeLabel, columnsFor, columnsView, doneChips, linkRefusal, pickerRows, previewRow, saveAnswered, searchText,
  saveProgress, saveRefused, saveStarted, setMine, shouldSearch, shownName, sourceSubLine, toggleClosed
} from './notion-view';

const source = (extra: Partial<SourceInfo> = {}): SourceInfo => ({
  id: 'a'.repeat(32), name: 'Engineering Backlog', path: 'Engineering', loading: false,
  fields: { title: 'Title', status: { prop: 'Stage', kind: 'select', closed: ['Shipped'] }, assignee: { prop: 'Owner', mine: true } }, ...extra
});
const card = (extra: Partial<ConnectorInfo> = {}): ConnectorInfo => ({
  id: 'notion', name: 'Notion', status: 'connected', loading: false, tasksVersion: 1, options: { show: 'assigned', includeClosed: false }, ...extra
});

describe('sourceSubLine: a database row\'s second line', () => {
  test('"Assigned to me · 4 open" / "Everyone · 12 open"', () => {
    expect(sourceSubLine(source({ count: 4 }), { includeClosed: false })).toBe('Assigned to me · 4 open');
    const everyone = source({ count: 12, fields: { title: 'Title', assignee: { prop: 'Owner', mine: false } } });
    expect(sourceSubLine(everyone, { includeClosed: false })).toBe('Everyone · 12 open');
    // No person column at all: everyone's tasks.
    expect(sourceSubLine(source({ count: 0, fields: { title: 'Title' } }), { includeClosed: false })).toBe('Everyone · 0 open');
  });
  test('"Loading…" while main lists it, or while a fields edit waits for its refresh', () => {
    expect(sourceSubLine(source({ loading: true }), { includeClosed: false })).toBe('Loading…');
    expect(sourceSubLine(source({ count: 4 }), { includeClosed: false, saving: true })).toBe('Loading…');
  });
  test('no count yet: who only; closed tasks included: "tasks", not "open"', () => {
    expect(sourceSubLine(source(), { includeClosed: false })).toBe('Assigned to me');
    expect(sourceSubLine(source({ count: 7 }), { includeClosed: true })).toBe('Assigned to me · 7 tasks');
    expect(sourceSubLine(source({ count: 1 }), { includeClosed: true })).toBe('Assigned to me · 1 task');
  });
});

const task = (id: string, listName: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  id, displayId: `ENG-${id}`, title: `Task ${id}`, status: { name: 'Review', color: '#8B5CF6' }, listName, url: `https://app.notion.com/p/${id}`, ...extra
});

describe('previewRow: the first task of that database, as the palette shows it', () => {
  test('the source\'s own first task (main sends it), with its tone', () => {
    const first = task('2', 'Engineering Backlog');
    expect(previewRow(source({ preview: first }))).toEqual({ source: 'notion', task: first, tone: 'violet' });
  });
  test('two databases with the same name each preview their own task, never the other\'s', () => {
    const a = source({ id: 'a'.repeat(32), name: 'Tasks', preview: task('1', 'Tasks') });
    const b = source({ id: 'b'.repeat(32), name: 'Tasks', preview: task('2', 'Tasks') });
    expect(previewRow(a)?.task.id).toBe('1');
    expect(previewRow(b)?.task.id).toBe('2');
  });
  test('none from that database: null → "No tasks match"', () => {
    expect(previewRow(source())).toBeNull();
  });
});

const columns: Column[] = [
  { name: 'Title', type: 'title' },
  { name: 'Stage', type: 'select', options: [{ name: 'Backlog', tone: 'idle' }, { name: 'Doing', tone: 'working' }, { name: 'Review', tone: 'violet' }, { name: 'Shipped', tone: 'done' }] },
  { name: 'Status', type: 'status', options: [{ name: 'Not started', tone: 'idle', group: 'to_do' }, { name: 'In progress', tone: 'working', group: 'in_progress' }, { name: 'Done', tone: 'done', group: 'complete' }, { name: 'Dropped', tone: 'error', group: 'complete' }] },
  { name: 'Owner', type: 'person' }, { name: 'Reviewer', type: 'person' },
  { name: 'Deadline', type: 'date' }, { name: 'Ticket', type: 'unique_id' }, { name: 'Area', type: 'other' }
];

describe('columnsFor / columnTypeLabel: what each select offers', () => {
  test('status: status and select columns; assigned to: people; due: dates; ID: unique IDs', () => {
    expect(columnsFor(columns, 'status').map((c) => c.name)).toEqual(['Stage', 'Status']);
    expect(columnsFor(columns, 'assignee').map((c) => c.name)).toEqual(['Owner', 'Reviewer']);
    expect(columnsFor(columns, 'due').map((c) => c.name)).toEqual(['Deadline']);
    expect(columnsFor(columns, 'id').map((c) => c.name)).toEqual(['Ticket']);
    expect(columnsFor(undefined, 'status')).toEqual([]);
  });
  test('the type hint after a column name', () => {
    expect(['select', 'status', 'person', 'date', 'unique_id'].map((t) => columnTypeLabel(t as Column['type']))).toEqual(['select', 'status', 'person', 'date', 'unique ID']);
  });
});

describe('shownName: a column or option name as the editor shows it (sent back to Notion verbatim)', () => {
  // Built from code points: no invisible character is ever written raw in this file.
  const ch = (cp: number) => String.fromCodePoint(cp);
  const [ZWSP, BOM, WJ, SHY, LSEP] = [0x200b, 0xfeff, 0x2060, 0xad, 0x2028].map(ch) as [string, string, string, string, string];
  test('zero-width space, BOM, word joiner and soft hyphen are not shown; line breaks become a space', () => {
    expect(shownName(`St${ZWSP}atus${BOM}`)).toBe('Status');
    expect(shownName(`Dead${SHY}line${WJ}`)).toBe('Deadline');
    expect(shownName(`Owner${LSEP} team`)).toBe('Owner team');
    expect(shownName('Stage')).toBe('Stage');
  });
  test('a name of invisible characters only shows as a dash, never as nothing', () => {
    expect(shownName(ZWSP + ZWSP)).toBe('—');
  });
  test("a read-only chip's spoken label uses the shown name", () => {
    const cols: Column[] = [{ name: 'Status', type: 'status', options: [{ name: `Do${ZWSP}ne`, tone: 'done', group: 'complete' }] }];
    const v = doneChips({ title: 'Title', status: { prop: 'Status', kind: 'status', closed: [] } }, cols)!;
    expect(v.chips[0]!.name).toBe(`Do${ZWSP}ne`);
    expect(v.chips[0]!.label).toBe('Done, in the Complete group');
  });
});

describe('doneChips: Done when', () => {
  test('a select column: one toggle per option, the closed ones on', () => {
    const v = doneChips(source().fields, columns)!;
    expect(v.readOnly).toBe(false);
    expect(v.note).toBeUndefined();
    expect(v.chips).toEqual([
      { name: 'Backlog', tone: 'idle', on: false, disabled: false }, { name: 'Doing', tone: 'working', on: false, disabled: false },
      { name: 'Review', tone: 'violet', on: false, disabled: false }, { name: 'Shipped', tone: 'done', on: true, disabled: false }
    ]);
  });
  test('a status column: read-only, its Complete group checked, "Notion\'s Complete group"', () => {
    const v = doneChips({ title: 'Title', status: { prop: 'Status', kind: 'status', closed: [] } }, columns)!;
    expect(v.readOnly).toBe(true);
    expect(v.note).toBe("Notion's Complete group");
    expect(v.chips.filter((c) => c.on).map((c) => c.name)).toEqual(['Done', 'Dropped']);
    expect(v.chips.every((c) => c.disabled)).toBe(true);
    // Read-only chips aren't toggles: screen readers hear which options are in the group.
    expect(v.chips.map((c) => c.label)).toEqual([
      'Not started, not in the Complete group', 'In progress, not in the Complete group', 'Done, in the Complete group', 'Dropped, in the Complete group'
    ]);
  });
  test(`at the cap (${MAX_CLOSED_OPTIONS}), the unchosen options are disabled with a tooltip`, () => {
    const names = Array.from({ length: 12 }, (_, i) => `S${i}`);
    const wide: Column[] = [{ name: 'Stage', type: 'select', options: names.map((name) => ({ name, tone: 'idle' as const })) }];
    const fields: NotionFields = { title: 'Title', status: { prop: 'Stage', kind: 'select', closed: names.slice(0, MAX_CLOSED_OPTIONS) } };
    const chips = doneChips(fields, wide)!.chips;
    expect(chips.filter((c) => c.on)).toHaveLength(MAX_CLOSED_OPTIONS);
    expect(chips.filter((c) => c.disabled).map((c) => c.name)).toEqual(['S10', 'S11']);
    expect(chips.find((c) => c.name === 'S10')!.tip).toBe('At most 10 options can mean done.');
    expect(chips.find((c) => c.name === 'S0')!.tip).toBeUndefined();
  });
  test('no status column, or columns not read yet: no chips row', () => {
    expect(doneChips({ title: 'Title' }, columns)).toBeNull();
    expect(doneChips(source().fields, undefined)).toBeNull();
    expect(doneChips({ title: 'Title', status: { prop: 'Gone', kind: 'select', closed: [] } }, columns)).toBeNull();
  });
});

describe('the editor\'s changes: the fields to save', () => {
  const f = source().fields;
  test('toggleClosed adds or removes a select option, never past the cap', () => {
    expect(toggleClosed(f, 'Review').status!.closed).toEqual(['Shipped', 'Review']);
    expect(toggleClosed(f, 'Shipped').status!.closed).toEqual([]);
    const full: NotionFields = { title: 'T', status: { prop: 'Stage', kind: 'select', closed: Array.from({ length: MAX_CLOSED_OPTIONS }, (_, i) => `S${i}`) } };
    expect(toggleClosed(full, 'More')).toBe(full);
    const status: NotionFields = { title: 'T', status: { prop: 'Status', kind: 'status', closed: [] } };
    expect(toggleClosed(status, 'Done')).toBe(status);
  });
  test('chooseColumn: a status column saves closed: []; another select starts with its done-like options guessed', () => {
    expect(chooseColumn(f, 'status', columns[2]!).status).toEqual({ prop: 'Status', kind: 'status', closed: [] });
    // Status → Stage: Shipped is closed at once (its tasks never leak into the list meanwhile).
    const onStatus: NotionFields = { title: 'T', status: { prop: 'Status', kind: 'status', closed: [] } };
    expect(chooseColumn(onStatus, 'status', columns[1]!).status).toEqual({ prop: 'Stage', kind: 'select', closed: ['Shipped'] });
    expect(chooseColumn({ title: 'T' }, 'status', columns[1]!).status).toEqual({ prop: 'Stage', kind: 'select', closed: ['Shipped'] });
    const priority: Column = { name: 'Priority', type: 'select', options: [{ name: 'P0', tone: 'error' }, { name: 'P1', tone: 'waiting' }] };
    expect(chooseColumn(f, 'status', priority).status).toEqual({ prop: 'Priority', kind: 'select', closed: [] });
    expect(chooseColumn(f, 'status', null)).toEqual({ title: 'Title', assignee: { prop: 'Owner', mine: true } });
  });
  test('chooseColumn: the column already chosen changes nothing (the same object: nothing is saved)', () => {
    const mine: NotionFields = { ...toggleClosed(f, 'Review'), due: 'Deadline', id: 'Ticket' };
    expect(chooseColumn(mine, 'status', columns[1]!)).toBe(mine);
    expect(chooseColumn(mine, 'assignee', columns[3]!)).toBe(mine);
    expect(chooseColumn(mine, 'due', columns[5]!)).toBe(mine);
    expect(chooseColumn(mine, 'id', columns[6]!)).toBe(mine);
    const none: NotionFields = { title: 'T' };
    expect(chooseColumn(none, 'due', null)).toBe(none);
    expect(chooseColumn(none, 'status', null)).toBe(none);
  });
  test('chooseColumn: assigned to keeps "Assigned to me" / "Everyone"; a new one starts as mine; None drops it', () => {
    expect(chooseColumn(setMine(f, false), 'assignee', columns[4]!).assignee).toEqual({ prop: 'Reviewer', mine: false });
    expect(chooseColumn({ title: 'T' }, 'assignee', columns[3]!).assignee).toEqual({ prop: 'Owner', mine: true });
    expect(chooseColumn(f, 'assignee', null).assignee).toBeUndefined();
    expect(setMine(f, false).assignee).toEqual({ prop: 'Owner', mine: false });
    expect(setMine({ title: 'T' }, true)).toEqual({ title: 'T' });
  });
  test('chooseColumn: due date and ID are names, None drops them', () => {
    expect(chooseColumn(f, 'due', columns[5]!).due).toBe('Deadline');
    expect(chooseColumn(f, 'id', columns[6]!).id).toBe('Ticket');
    expect('due' in chooseColumn({ ...f, due: 'Deadline' }, 'due', null)).toBe(false);
    expect('id' in chooseColumn({ ...f, id: 'Ticket' }, 'id', null)).toBe(false);
  });
});

describe('the picker', () => {
  const picks: SourcePick[] = [{ id: '1'.repeat(32), name: 'Sprint Tasks', path: 'Engineering / Sprints', added: false }, { id: '2'.repeat(32), name: 'Engineering Backlog', added: true }];
  test('shouldSearch: 2+ characters, never a link', () => {
    expect(shouldSearch('t')).toBe(false);
    expect(shouldSearch('  t ')).toBe(false);
    expect(shouldSearch('ta')).toBe(true);
    expect(shouldSearch(`https://app.notion.com/p/${'3'.repeat(32)}`)).toBe(false);
  });
  test('pickerRows: the results; a pasted link → one "Add this database" row instead', () => {
    expect(pickerRows('tasks', picks)).toEqual(picks.map((pick) => ({ kind: 'pick', key: pick.id, pick })));
    expect(pickerRows(`https://app.notion.com/p/${'3'.repeat(32)}`, picks)).toEqual([{ kind: 'link', key: 'link', ref: `https://app.notion.com/p/${'3'.repeat(32)}` }]);
    expect(pickerRows('t', picks)).toEqual([]);
  });
  test('canAdd: Enter adds a result only once it answers the text in the field (not during the debounce)', () => {
    const [pick] = pickerRows('tasks', picks);
    expect(canAdd(pick!, 'tasks', 'tasks')).toBe(true);
    expect(canAdd(pick!, 'tasks2', 'tasks')).toBe(false);
    expect(canAdd(pick!, 'tasks', null)).toBe(false);
    const [link] = pickerRows(`https://app.notion.com/p/${'3'.repeat(32)}`, []);
    expect(canAdd(link!, `https://app.notion.com/p/${'3'.repeat(32)}`, null)).toBe(true);
  });
  test('addErrorText: one line per refusal', () => {
    expect(addErrorText('not-database', 'Notion')).toBe("That link isn't a database.");
    expect(addErrorText('not-found', 'Notion')).toBe("Couldn't find that database. Is it shared with you?");
    expect(addErrorText('too-many', 'Notion')).toBe('You can add up to 20 databases.');
    expect(addErrorText('offline', 'Notion')).toBe("Can't reach Notion. Check your connection.");
    expect(addErrorText('failed', 'Notion')).toBe("Couldn't add that database. Try again.");
    expect(addErrorText('unsupported', 'Notion')).toBe("Couldn't add that database. Try again.");
  });
  test('searchText: what is sent to Notion is trimmed and at most 200 characters (never a refusal for length)', () => {
    expect(searchText('  sprint  ')).toBe('sprint');
    expect(searchText('x'.repeat(250))).toBe('x'.repeat(200));
    // Never half of a character made of two code units.
    const emoji = String.fromCodePoint(0x1f680);
    const cut = searchText('x'.repeat(199) + emoji);
    expect(cut).toBe('x'.repeat(199));
  });
  test('linkRefusal: a pasted link over 400 characters says so before anything is sent', () => {
    const link = `https://www.notion.so/acme/Sprint-${'3'.repeat(32)}?v=${'4'.repeat(32)}`;
    const [ok] = pickerRows(link, []);
    expect(linkRefusal(ok!)).toBeNull();
    const [long] = pickerRows(`${link}&x=${'a'.repeat(400)}`, []);
    expect(long!.kind).toBe('link');
    expect(linkRefusal(long!)).toBe('That link is too long.');
    expect(linkRefusal(pickerRows('tasks', picks)[0]!)).toBeNull();
  });
});

describe('a fields edit shows "Loading…" until the refresh it started lands', () => {
  test('no refresh started (nothing changed): done at the reply', () => {
    const s = saveStarted(card({ updatedAt: 100 }));
    expect(saveProgress(s, card({ updatedAt: 100 }))).toBe(s);
    expect(saveAnswered(s, card({ loading: false }))).toBeNull();
  });
  test('a refresh started: done when new tasks land (updatedAt moves past the reply\'s)', () => {
    // A refresh that was already running landed before the reply: it read the old fields, so it doesn't count.
    const s = saveAnswered(saveStarted(card({ updatedAt: 100 })), card({ loading: true, updatedAt: 150 }))!;
    expect(s).not.toBeNull();
    expect(saveProgress(s, card({ updatedAt: 150, loading: true }))).not.toBeNull();
    expect(saveProgress(s, card({ updatedAt: 200 }))).toBeNull();
  });
  test('a refresh that failed: done once loading was seen and ended', () => {
    let s = saveAnswered(saveStarted(card({ updatedAt: 100 })), card({ loading: true, updatedAt: 100 }));
    s = saveProgress(s!, card({ updatedAt: 100, loading: false }));
    expect(s).not.toBeNull();
    s = saveProgress(s!, card({ updatedAt: 100, loading: true }));
    expect(saveProgress(s!, card({ updatedAt: 100, loading: false }))).toBeNull();
  });
  test('loading seen before the reply came back counts too; leaving connected ends it', () => {
    let s = saveProgress(saveStarted(card({ updatedAt: 100 })), card({ updatedAt: 100, loading: true }));
    s = saveAnswered(s!, card({ loading: true, updatedAt: 100 }));
    expect(saveProgress(s!, card({ updatedAt: 100, loading: false }))).toBeNull();
    expect(saveProgress(saveStarted(card()), card({ status: 'reconnect' }))).toBeNull();
  });
});

describe('the editor\'s failures: one quiet line, never a toast', () => {
  const sent: NotionFields = { title: 'Title', status: { prop: 'Stage', kind: 'select', closed: ['Shipped', 'Review'] } };
  const reply = (fields: NotionFields, extra: Partial<SourceInfo> = {}) => card({ sources: [source({ fields, ...extra })] });
  test('saveRefused: main answered with other fields than those sent (they didn\'t fit the schema)', () => {
    expect(saveRefused(reply(sent), 'a'.repeat(32), sent)).toBe(false);
    expect(saveRefused(reply({ ...sent, status: { prop: 'Stage', kind: 'select', closed: ['Shipped'] } }), 'a'.repeat(32), sent)).toBe(true);
    // Gone meanwhile (removed) or unreadable: the row says so itself.
    expect(saveRefused(card({ sources: [] }), 'a'.repeat(32), sent)).toBe(false);
    expect(saveRefused(reply({ title: 'Title' }, { error: 'unreadable' }), 'a'.repeat(32), sent)).toBe(false);
  });
  test('columnsView: reading, ready, or failed once the read ended without columns', () => {
    expect(columnsView(source(), 'pending')).toBe('reading');
    expect(columnsView(source(), 'done')).toBe('failed');
    expect(columnsView(source({ columns }), 'pending')).toBe('ready');
    expect(columnsView(source({ columns }), 'done')).toBe('ready');
  });
});
