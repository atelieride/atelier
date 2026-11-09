import { describe, expect, test } from 'vitest';
import { MAX_CLOSED_OPTIONS, MAX_DATABASES, type NotionFields } from './tasks';
import { guessClosed, sameNotionFields } from './notion-fields';

describe('guessClosed: a select\'s options that read as done', () => {
  test('done-like names, in option order, trimmed and case-insensitive', () => {
    expect(guessClosed(['Backlog', 'Doing', 'Review', 'Shipped'])).toEqual(['Shipped']);
    expect(guessClosed([' DONE ', 'Cancelled', 'canceled', "Won't do", 'won’t do', 'Archived', 'Open'])).toEqual([' DONE ', 'Cancelled', 'canceled', "Won't do", 'won’t do', 'Archived']);
    expect(guessClosed(['Backlog', 'Doing', 'Done soon', 'Undone'])).toEqual([]);
  });
  test(`at most MAX_CLOSED_OPTIONS (${MAX_CLOSED_OPTIONS})`, () => {
    expect(guessClosed(Array.from({ length: 14 }, () => 'Done'))).toHaveLength(MAX_CLOSED_OPTIONS);
  });
});

describe('sameNotionFields', () => {
  const f: NotionFields = { title: 'Title', status: { prop: 'Stage', kind: 'select', closed: ['Shipped'] }, assignee: { prop: 'Owner', mine: true }, due: 'Deadline' };
  test('structural, whatever the key order; any field differing → false', () => {
    expect(sameNotionFields(f, { due: 'Deadline', assignee: { mine: true, prop: 'Owner' }, status: { closed: ['Shipped'], kind: 'select', prop: 'Stage' }, title: 'Title' })).toBe(true);
    expect(sameNotionFields(f, { ...f, status: { prop: 'Stage', kind: 'select', closed: [] } })).toBe(false);
    expect(sameNotionFields(f, { ...f, assignee: { prop: 'Owner', mine: false } })).toBe(false);
    const { due: _d, ...noDue } = f;
    expect(sameNotionFields(f, noDue)).toBe(false);
  });
});

test('MAX_DATABASES: 20 chosen databases at most', () => {
  expect(MAX_DATABASES).toBe(20);
});
