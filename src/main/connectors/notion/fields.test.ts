import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MAX_CLOSED_OPTIONS, type NotionFields } from '@shared/tasks';
import { parseDataSourceState, type DataSourceSchema } from './markup';
import { NOTION_TOOLS } from './tools';
import { closedFilter, columnsOf, guessFields, rowsQuery, validateFields } from './fields';

const schemaOf = (name: string): DataSourceSchema =>
  parseDataSourceState(JSON.parse(readFileSync(join(__dirname, '../../../../tests/fixtures/notion', name), 'utf8')).text)!;
const sprint = () => schemaOf('fetch-data-source-sprint.json');
const backlog = () => schemaOf('fetch-data-source-backlog.json');
const SPRINT_DS = '00000002-0000-4000-8000-000000000002';
const BACKLOG_DS = '00000001-0000-4000-8000-000000000001';

/** Backlog with its Stage column renamed (Notion keeps the options). */
const renamed = (to: string, type = 'select'): DataSourceSchema => {
  const s = backlog();
  const { Stage, ...rest } = s.properties;
  return { ...s, properties: { ...rest, [to]: { ...Stage!, type } } };
};

describe('guessFields', () => {
  test('Sprint Tasks: Status (status, Notion\'s Complete group), Assignee mine, Due, no ID', () => {
    expect(guessFields(sprint())).toEqual({
      title: 'Task name', status: { prop: 'Status', kind: 'status', closed: [] }, assignee: { prop: 'Assignee', mine: true }, due: 'Due'
    });
  });

  test('Engineering Backlog: Stage (select, closed Shipped), Owner, Deadline, Ticket', () => {
    expect(guessFields(backlog())).toEqual({
      title: 'Title', status: { prop: 'Stage', kind: 'select', closed: ['Shipped'] }, assignee: { prop: 'Owner', mine: true },
      due: 'Deadline', id: 'Ticket'
    });
  });

  test('no title column → null', () => {
    const s = sprint();
    const { 'Task name': _t, ...rest } = s.properties;
    expect(guessFields({ ...s, properties: rest })).toBeNull();
  });

  test('a status column wins over a select, and one named "Status" over the first', () => {
    const f = guessFields({ name: 'X', properties: {
      Name: { type: 'title' }, State: { type: 'select', options: [{ name: 'Done' }] },
      Phase: { type: 'status', groups: { to_do: [], in_progress: [], complete: [] } },
      Status: { type: 'status', groups: { to_do: [], in_progress: [], complete: [] } }
    } })!;
    expect(f.status).toEqual({ prop: 'Status', kind: 'status', closed: [] });
  });

  test('a select only when named like status/stage/state/phase; closed options by name', () => {
    const opts = ['To do', 'Done', 'Completed', 'closed', 'RESOLVED', 'Released', 'Canceled', 'Cancelled', 'Archived', "Won't do", 'Won’t do', 'Doing']
      .map((name) => ({ name }));
    const f = guessFields({ name: 'X', properties: { Name: { type: 'title' }, Priority: { type: 'select', options: [{ name: 'Done' }] },
      'Workflow state': { type: 'select', options: opts } } })!;
    expect(f.status).toEqual({ prop: 'Workflow state', kind: 'select',
      closed: ['Done', 'Completed', 'closed', 'RESOLVED', 'Released', 'Canceled', 'Cancelled', 'Archived', "Won't do", 'Won’t do'] });
    expect(guessFields({ name: 'X', properties: { Name: { type: 'title' }, Priority: { type: 'select', options: [{ name: 'Done' }] } } })!.status)
      .toBeUndefined();
  });

  test('"Statement" is not a status; "task_status" is', () => {
    const sel = { type: 'select', options: [{ name: 'Done' }] };
    expect(guessFields({ name: 'X', properties: { Name: { type: 'title' }, Statement: sel } })!.status).toBeUndefined();
    expect(guessFields({ name: 'X', properties: { Name: { type: 'title' }, Statement: sel, task_status: sel } })!.status)
      .toEqual({ prop: 'task_status', kind: 'select', closed: ['Done'] });
  });

  test(`at most MAX_CLOSED_OPTIONS (${MAX_CLOSED_OPTIONS}) closed options are guessed, in option order (the filter holds 12 items)`, () => {
    const names = ['Done', 'Completed', 'closed', 'RESOLVED', 'Released', 'Canceled', 'Cancelled', 'Archived', "Won't do", 'Shipped', 'Complete', 'Wont do'];
    const f = guessFields({ name: 'X', properties: { Name: { type: 'title' }, Status: { type: 'select', options: names.map((name) => ({ name })) } } })!;
    expect(MAX_CLOSED_OPTIONS).toBe(10);
    expect(f.status!.closed).toEqual(names.slice(0, 10));
  });

  test('due: a name like due/deadline wins over one like date/when, whatever the order', () => {
    const f = guessFields({ name: 'X', properties: { Name: { type: 'title' }, 'Start date': { type: 'date' }, When: { type: 'date' }, Deadline: { type: 'date' } } })!;
    expect(f.due).toBe('Deadline');
    expect(guessFields({ name: 'X', properties: { Name: { type: 'title' }, Created: { type: 'date' }, 'Start date': { type: 'date' } } })!.due).toBe('Start date');
  });

  test('plural status names count too: Statuses, Stages, States, Phases (still not Statement)', () => {
    const sel = { type: 'select', options: [{ name: 'Done' }] };
    for (const name of ['Statuses', 'Stages', 'Ticket states', 'Phases', 'Status']) {
      expect(guessFields({ name: 'X', properties: { Name: { type: 'title' }, Statement: sel, [name]: sel } })!.status?.prop, name).toBe(name);
    }
  });

  test('the assignee prefers a name like assign/owner/responsible/DRI/people, else the first person; due likewise', () => {
    const f = guessFields({ name: 'X', properties: {
      Name: { type: 'title' }, 'Created by': { type: 'person' }, Reviewer: { type: 'person' }, DRI: { type: 'person' },
      Started: { type: 'date' }, 'Due date': { type: 'date' }
    } })!;
    expect(f.assignee).toEqual({ prop: 'DRI', mine: true });
    expect(f.due).toBe('Due date');
    const g = guessFields({ name: 'X', properties: { Name: { type: 'title' }, Reviewer: { type: 'person' }, Started: { type: 'date' } } })!;
    expect(g.assignee).toEqual({ prop: 'Reviewer', mine: true });
    expect(g.due).toBe('Started');
    expect(guessFields({ name: 'X', properties: { Name: { type: 'title' } } })).toEqual({ title: 'Name' });
  });

  test('a column whose name Atelier could not send (over 100 characters, control or invisible characters) is never picked', () => {
    const f = guessFields({ name: 'X', properties: {
      Name: { type: 'title' }, ['Owner'.padEnd(101, 'x')]: { type: 'person' }, 'Assignee\u202e': { type: 'person' }, 'Due\n': { type: 'date' },
      Status: { type: 'select', options: [{ name: 'Done' }, { name: 'Shipped'.padEnd(201, '!') }] }
    } })!;
    expect(f).toEqual({ title: 'Name', status: { prop: 'Status', kind: 'select', closed: ['Done'] } });
  });
});

describe('validateFields: a mapped column renamed or retyped is guessed again (Review Focus 1)', () => {
  const saved = (): NotionFields => guessFields(backlog())!;

  test('unchanged schema → the same fields, not changed', () => {
    expect(validateFields(saved(), backlog())).toEqual({ fields: saved(), changed: false, missingTitle: false });
  });

  test('Stage renamed to Phase (a select named like a stage) → status re-guessed to Phase, still closing Shipped', () => {
    expect(validateFields(saved(), renamed('Phase'))).toEqual({
      fields: { ...saved(), status: { prop: 'Phase', kind: 'select', closed: ['Shipped'] } }, changed: true, missingTitle: false
    });
  });

  test('Stage renamed to a name unlike a status → found again by its options (the select holding the closed values)', () => {
    expect(validateFields(saved(), renamed('Bucket'))).toEqual({
      fields: { ...saved(), status: { prop: 'Bucket', kind: 'select', closed: ['Shipped'] } }, changed: true, missingTitle: false
    });
  });

  test('the select holding the saved closed values wins over one merely named like a status; the user\'s closed options carry over', () => {
    const mine: NotionFields = { ...saved(), status: { prop: 'Stage', kind: 'select', closed: ['Review', 'Shipped'] } };
    const s = renamed('Bucket');
    const withPhase: DataSourceSchema = { ...s, properties: { Phase: { type: 'select', options: [{ name: 'Draft' }, { name: 'Done' }] }, ...s.properties } };
    expect(validateFields(mine, withPhase).fields.status).toEqual({ prop: 'Bucket', kind: 'select', closed: ['Review', 'Shipped'] });
    // Renamed to Phase: the saved choice carries over (not the guess, which would be just Shipped).
    expect(validateFields(mine, renamed('Phase')).fields.status).toEqual({ prop: 'Phase', kind: 'select', closed: ['Review', 'Shipped'] });
  });

  test('the saved select turned into a status column → that column (Notion\'s Complete group), even if another select holds the closed values', () => {
    const s = backlog();
    const retyped: DataSourceSchema = { ...s, properties: {
      Bucket: { type: 'select', options: [{ name: 'Shipped' }] }, ...s.properties,
      Stage: { type: 'status', groups: { to_do: [{ name: 'Backlog' }], in_progress: [], complete: [{ name: 'Shipped' }] } }
    } };
    expect(validateFields(saved(), retyped).fields.status).toEqual({ prop: 'Stage', kind: 'status', closed: [] });
  });

  test('Stage renamed, options unlike the saved ones, name unlike a status → no status', () => {
    const s = renamed('Bucket');
    const other: DataSourceSchema = { ...s, properties: { ...s.properties, Bucket: { type: 'select', options: [{ name: 'Left' }, { name: 'Right' }] } } };
    const { status: _s, ...rest } = saved();
    expect(validateFields(saved(), other)).toEqual({ fields: rest, changed: true, missingTitle: false });
  });

  test('no title column at all → reported (the connector marks the database unreadable), never kept silently', () => {
    const s = backlog();
    const { Title: _t, ...rest } = s.properties;
    const out = validateFields(saved(), { ...s, properties: rest });
    expect(out.missingTitle).toBe(true);
    expect(validateFields(saved(), backlog()).missingTitle).toBe(false);
  });

  test('carried-over closed options are capped at MAX_CLOSED_OPTIONS', () => {
    const names = Array.from({ length: 14 }, (_, i) => `Closed ${i}`);
    const schema: DataSourceSchema = { name: 'X', properties: { Name: { type: 'title' }, Stage: { type: 'select', options: names.map((name) => ({ name })) } } };
    const out = validateFields({ title: 'Name', status: { prop: 'Stage', kind: 'select', closed: names } }, schema);
    expect(out.fields.status!.closed).toEqual(names.slice(0, MAX_CLOSED_OPTIONS));
    expect(out.changed).toBe(true);
  });

  test('Stage retyped (select → multi_select) → re-guessed; the user\'s choices on columns that still fit are kept', () => {
    const mine: NotionFields = { ...saved(), assignee: { prop: 'Owner', mine: false }, due: undefined };
    const out = validateFields(mine, { ...backlog(), properties: { ...backlog().properties, Stage: { type: 'multi_select', options: [] } } });
    expect(out.changed).toBe(true);
    expect(out.fields.status).toBeUndefined();
    expect(out.fields.assignee).toEqual({ prop: 'Owner', mine: false });
    expect(out.fields.due).toBeUndefined(); // "None" stays None: only a mapped column that went away is guessed again
  });

  test('an assignee column renamed → the new person column, keeping Everyone', () => {
    const s = backlog();
    const { Owner: _o, ...rest } = s.properties;
    const out = validateFields({ ...saved(), assignee: { prop: 'Owner', mine: false } }, { ...s, properties: { ...rest, Responsible: { type: 'person' } } });
    expect(out).toEqual({ fields: { ...saved(), assignee: { prop: 'Responsible', mine: false } }, changed: true, missingTitle: false });
  });

  test('due and ID columns gone → re-guessed or dropped; the title follows a renamed title column', () => {
    const s = backlog();
    const { Deadline: _d, Ticket: _t, Title: _ti, ...rest } = s.properties;
    const out = validateFields(saved(), { ...s, properties: { ...rest, Name: { type: 'title' } } });
    expect(out).toEqual({ fields: { title: 'Name', status: saved().status, assignee: saved().assignee }, changed: true, missingTitle: false });
  });

  test('a status column\'s kind follows its type; closed options that no longer exist are dropped, re-guessed when none is left', () => {
    const sel = (names: string[]) => ({ type: 'select', options: names.map((name) => ({ name })) });
    const base = { name: 'X', properties: { Name: { type: 'title' }, Stage: sel(['Open', 'Shipped', 'Done']) } };
    const f: NotionFields = { title: 'Name', status: { prop: 'Stage', kind: 'select', closed: ['Shipped', 'Done'] } };
    expect(validateFields(f, { ...base, properties: { ...base.properties, Stage: sel(['Open', 'Done']) } }))
      .toEqual({ fields: { title: 'Name', status: { prop: 'Stage', kind: 'select', closed: ['Done'] } }, changed: true, missingTitle: false });
    expect(validateFields(f, { ...base, properties: { ...base.properties, Stage: sel(['Open', 'Released']) } }))
      .toEqual({ fields: { title: 'Name', status: { prop: 'Stage', kind: 'select', closed: ['Released'] } }, changed: true, missingTitle: false });
    // The user unticked every option on purpose: nothing to re-guess while the column is unchanged.
    const none: NotionFields = { title: 'Name', status: { prop: 'Stage', kind: 'select', closed: [] } };
    expect(validateFields(none, base)).toEqual({ fields: none, changed: false, missingTitle: false });
    // Retyped select → status.
    const st = { ...base, properties: { ...base.properties, Stage: { type: 'status', groups: { to_do: [], in_progress: [], complete: [{ name: 'Done' }] } } } };
    expect(validateFields(f, st)).toEqual({ fields: { title: 'Name', status: { prop: 'Stage', kind: 'status', closed: [] } }, changed: true, missingTitle: false });
  });
});

describe('columnsOf: the schema as the fields editor sees it', () => {
  test('Sprint: types, status options with their group and tone (never a raw color)', () => {
    expect(columnsOf(sprint())).toEqual([
      { name: 'Assignee', type: 'person' },
      { name: 'Due', type: 'date' },
      { name: 'Status', type: 'status', options: [
        { name: 'Not started', tone: 'idle', group: 'to_do' }, { name: 'In progress', tone: 'working', group: 'in_progress' },
        { name: 'Done', tone: 'done', group: 'complete' }, { name: 'Archived', tone: 'idle', group: 'complete' }] },
      { name: 'Task name', type: 'title' }
    ]);
  });

  test('Backlog: selects with tones, auto_increment_id as unique_id, multi_select as other', () => {
    expect(columnsOf(backlog())).toEqual([
      { name: 'Area', type: 'other' },
      { name: 'Deadline', type: 'date' },
      { name: 'Owner', type: 'person' },
      { name: 'Priority', type: 'select', options: [{ name: 'P0', tone: 'error' }, { name: 'P1', tone: 'waiting' }, { name: 'P2', tone: 'waiting' }] },
      { name: 'Stage', type: 'select', options: [
        { name: 'Backlog', tone: 'idle' }, { name: 'Doing', tone: 'working' }, { name: 'Review', tone: 'violet' }, { name: 'Shipped', tone: 'done' }] },
      { name: 'Ticket', type: 'unique_id' },
      { name: 'Title', type: 'title' }
    ]);
  });

  test('columns and options Atelier could not send are left out', () => {
    expect(columnsOf({ name: 'X', properties: {
      Name: { type: 'title' }, ['x'.repeat(101)]: { type: 'person' }, 'Bad\u0007': { type: 'date' },
      S: { type: 'select', options: [{ name: 'ok', color: 'brown' }, { name: 'y'.repeat(201) }, { name: 'z\u2066' }, { name: '👩\u200d💻 Dev' }] }
    } })).toEqual([{ name: 'Name', type: 'title' }, { name: 'S', type: 'select', options: [{ name: 'ok', tone: 'idle' }, { name: '👩\u200d💻 Dev', tone: 'idle' }] }]);
    // An emoji joined with U+200D (common in column names) is fine: only controls, bidi controls and separators are refused.
  });
});

describe('rowsQuery: the exact request shapes that worked against Notion', () => {
  const q = 'notion-query-data-sources' as const;

  test('Backlog, mine, not Shipped, by deadline (a real request, verbatim)', () => {
    const args = rowsQuery(BACKLOG_DS, guessFields(backlog())!, { schema: backlog(), includeClosed: false })!;
    expect(args).toEqual({ data: {
      mode: 'rows', data_source_url: `collection://${BACKLOG_DS}`,
      filter: { type: 'group', operator: 'and', filters: [
        { type: 'property', property: 'Owner', propertyType: 'person', operator: 'person_contains', value: { type: 'relative', value: 'me' } },
        { type: 'property', property: 'Stage', propertyType: 'select', operator: 'enum_is_not', value: { type: 'exact', value: 'Shipped' } }] },
      sort: [{ property: 'Deadline', direction: 'ascending' }],
      limit: 100
    } });
    expect(() => NOTION_TOOLS.parseArgs(q, args)).not.toThrow();
  });

  test('Sprint: mine, status not in the Complete group, by due date', () => {
    const args = rowsQuery(SPRINT_DS, guessFields(sprint())!, { schema: sprint(), includeClosed: false })!;
    expect(args.data.filter!.filters).toEqual([
      { type: 'property', property: 'Assignee', propertyType: 'person', operator: 'person_contains', value: { type: 'relative', value: 'me' } },
      { type: 'property', property: 'Status', propertyType: 'status', operator: 'status_is_not', value: { type: 'is_group', value: 'complete' } }]);
    expect(args.data.sort).toEqual([{ property: 'Due', direction: 'ascending' }]);
    expect(() => NOTION_TOOLS.parseArgs(q, args)).not.toThrow();
  });

  test('search: the list\'s filters plus title contains, limit 25', () => {
    const args = rowsQuery(BACKLOG_DS, guessFields(backlog())!, { schema: backlog(), includeClosed: false, search: '  PRICING\n ' })!;
    expect(args.data.limit).toBe(25);
    expect(args.data.filter!.filters.at(-1)).toEqual(
      { type: 'property', property: 'Title', propertyType: 'title', operator: 'string_contains', value: { type: 'exact', value: 'PRICING' } });
    expect(args.data.filter!.filters).toHaveLength(3);
    const long = rowsQuery(BACKLOG_DS, guessFields(backlog())!, { schema: backlog(), includeClosed: false, search: 'x'.repeat(500) });
    expect(() => NOTION_TOOLS.parseArgs(q, long)).not.toThrow();
  });

  test('include closed, everyone, no due column: no filter at all, no sort', () => {
    const f: NotionFields = { title: 'Title', status: { prop: 'Stage', kind: 'select', closed: ['Shipped'] }, assignee: { prop: 'Owner', mine: false } };
    expect(rowsQuery(BACKLOG_DS, f, { schema: backlog(), includeClosed: true }))
      .toEqual({ data: { mode: 'rows', data_source_url: `collection://${BACKLOG_DS}`, limit: 100 } });
  });

  test('one enum_is_not per closed select option', () => {
    const f: NotionFields = { title: 'Title', status: { prop: 'Stage', kind: 'select', closed: ['Shipped', 'Review'] } };
    expect(closedFilter(f, backlog(), false).map((x) => x.value)).toEqual([{ type: 'exact', value: 'Shipped' }, { type: 'exact', value: 'Review' }]);
    expect(closedFilter(f, backlog(), true)).toEqual([]);
  });

  test('closedFilter itself never goes over MAX_CLOSED_OPTIONS', () => {
    const names = Array.from({ length: 14 }, (_, i) => `Closed ${i}`);
    const schema: DataSourceSchema = { name: 'X', properties: { Name: { type: 'title' }, Stage: { type: 'select', options: names.map((name) => ({ name })) } } };
    const out = closedFilter({ title: 'Name', status: { prop: 'Stage', kind: 'select', closed: names } }, schema, false);
    expect(out.map((x) => x.value)).toEqual(names.slice(0, MAX_CLOSED_OPTIONS).map((value) => ({ type: 'exact', value })));
  });

  test('never a filter on a column the schema does not have: a renamed Stage is re-guessed before the query', () => {
    const args = rowsQuery(BACKLOG_DS, guessFields(backlog())!, { schema: renamed('Phase'), includeClosed: false })!;
    const props = args.data.filter!.filters.map((x) => x.property);
    expect(props).toEqual(['Owner', 'Phase']);
    const bucket = rowsQuery(BACKLOG_DS, guessFields(backlog())!, { schema: renamed('Bucket'), includeClosed: false })!;
    expect(bucket.data.filter!.filters.map((x) => x.property)).toEqual(['Owner', 'Bucket']);
    const s = renamed('Bucket');
    const unrelated = { ...s, properties: { ...s.properties, Bucket: { type: 'select', options: [{ name: 'Left' }] } } };
    const gone = rowsQuery(BACKLOG_DS, guessFields(backlog())!, { schema: unrelated, includeClosed: false })!;
    expect(gone.data.filter!.filters.map((x) => x.property)).toEqual(['Owner']);
  });

  test('no title column → no query at all (never 25 unrelated rows for a search, never untitled rows for a list)', () => {
    const s = backlog();
    const { Title: _t, ...rest } = s.properties;
    const untitled = { ...s, properties: rest };
    expect(rowsQuery(BACKLOG_DS, guessFields(backlog())!, { schema: untitled, includeClosed: false, search: 'pricing' })).toBeNull();
    expect(rowsQuery(BACKLOG_DS, guessFields(backlog())!, { schema: untitled, includeClosed: false })).toBeNull();
  });

  test('a data source id without dashes is sent in the dashed form Notion gave', () => {
    const args = rowsQuery(BACKLOG_DS.replace(/-/g, '').toUpperCase(), { title: 'Title' }, { schema: backlog(), includeClosed: true })!;
    expect(args.data.data_source_url).toBe(`collection://${BACKLOG_DS}`);
  });
});
