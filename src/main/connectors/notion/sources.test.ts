import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MAX_CLOSED_OPTIONS, type NotionFields } from '@shared/tasks';
import { parseDataSourceState, parseDataSources, type DataSourceSchema } from './markup';
import { checkedFields, entriesFor, normalizeClosed, picksFrom, sameFields } from './sources';

// The picker's rows, the entries a database adds, and the fields editor's checks, on the fake's
// fictional fixtures (tests/fixtures/notion/).

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, '../../../../tests/fixtures/notion', `${name}.json`), 'utf8')) as { title: string; text: string };
const schemaOf = (name: string) => parseDataSourceState(fixture(name).text)!;

describe('picksFrom', () => {
  test('databases only, 32-hex ids, deduplicated, clean names, added marked', () => {
    const results = [
      { id: '00000005-0000-4000-8000-000000000005', title: 'Engineering Backlog', type: 'database', path: 'Engineering' },
      { id: '00000003-0000-4000-8000-000000000003', title: 'Engineering', type: 'page' },
      { id: '00000005000040008000000000000005', title: 'Engineering Backlog (again)', type: 'database' },
      { id: 'x', url: 'https://app.notion.com/p/00000006000040008000000000000006', title: '  Sprint\tTasks ', type: 'database' },
      { id: 'y', title: '', type: 'database' }
    ];
    expect(picksFrom(results, new Set(['00000006000040008000000000000006']))).toEqual([
      { id: '00000005000040008000000000000005', name: 'Engineering Backlog', path: 'Engineering', added: false },
      { id: '00000006000040008000000000000006', name: 'Sprint Tasks', added: true }
    ]);
  });
});

describe('entriesFor', () => {
  const roadmap = fixture('fetch-database-roadmap');
  const sources = parseDataSources(roadmap.text);
  const schemas = new Map<string, DataSourceSchema | null>(sources.map((s) => [s.id.replace(/-/g, ''), parseDataSourceState(fixture(`fetch-data-source-roadmap-${s.name.toLowerCase()}`).text)]));

  test('one entry per data source, named "<database> · <data source>" when there are several', () => {
    const entries = entriesFor({ id: '7e0a5b1c2d3e4f5061728394a5b6c7d8', title: roadmap.title, path: 'Engineering' }, sources, schemas);
    expect(entries.map((e) => [e.source, e.name, e.path])).toEqual([
      ['9a1b2c3d4e5f4a6b8c7d8e9fa0b1c2d3', 'Roadmap · Web', 'Engineering'],
      ['0f1e2d3c4b5a49688776655443322110', 'Roadmap · Mobile', 'Engineering']
    ]);
    expect(entries[0]!.fields).toEqual({ title: 'Name', status: { prop: 'Status', kind: 'status', closed: [] }, assignee: { prop: 'Owner', mine: true } });
  });

  test('a single data source is named after the database; an unreadable schema adds no entry', () => {
    const one = entriesFor({ id: 'a'.repeat(32), title: 'Roadmap', path: undefined }, sources.slice(0, 1), schemas);
    expect(one.map((e) => e.name)).toEqual(['Roadmap']);
    expect(one[0]).not.toHaveProperty('path');
    const none = entriesFor({ id: 'a'.repeat(32), title: undefined, path: undefined }, sources, new Map());
    expect(none).toEqual([]);
  });
});

describe('fields editor', () => {
  const backlog = schemaOf('fetch-data-source-backlog');
  const sprint = schemaOf('fetch-data-source-sprint');
  const fields: NotionFields = { title: 'Title', status: { prop: 'Stage', kind: 'select', closed: ['Shipped'] }, assignee: { prop: 'Owner', mine: true }, due: 'Deadline', id: 'Ticket' };

  test('normalizeClosed: existing options (exact, else trimmed), deduplicated, capped at MAX_CLOSED_OPTIONS', () => {
    const options = Array.from({ length: 14 }, (_, i) => ({ name: `Done ${i}` }));
    expect(normalizeClosed(options.map((o) => o.name), options)).toEqual(options.slice(0, MAX_CLOSED_OPTIONS).map((o) => o.name));
    expect(normalizeClosed([' Done 1 ', 'Done 1', '', 'Ghost'], options)).toEqual(['Done 1']);
  });

  test('checkedFields: every column must exist with the field\'s type; a status column keeps no closed options', () => {
    expect(checkedFields(fields, backlog)).toEqual(fields);
    expect(checkedFields({ ...fields, due: 'Owner' }, backlog)).toBeNull();
    expect(checkedFields({ ...fields, id: 'Priority' }, backlog)).toBeNull();
    expect(checkedFields({ title: 'Task name', status: { prop: 'Status', kind: 'status', closed: ['Done'] } }, sprint))
      .toEqual({ title: 'Task name', status: { prop: 'Status', kind: 'status', closed: [] } });
  });

  test('sameFields compares structurally, whatever the key order', () => {
    const reordered = JSON.parse('{"id":"Ticket","due":"Deadline","assignee":{"mine":true,"prop":"Owner"},"status":{"closed":["Shipped"],"kind":"select","prop":"Stage"},"title":"Title"}') as NotionFields;
    expect(sameFields(fields, reordered)).toBe(true);
    expect(sameFields(fields, { ...fields, assignee: { prop: 'Owner', mine: false } })).toBe(false);
    expect(sameFields(fields, { ...fields, status: { prop: 'Stage', kind: 'select', closed: ['Shipped', 'Backlog'] } })).toBe(false);
    const { due: _due, ...noDue } = fields;
    expect(sameFields(fields, noDue)).toBe(false);
  });
});
