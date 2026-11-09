import { describe, expect, test } from 'vitest';
import type { Condition, ConditionValues } from '@shared/automations';
import { addValue, daysValue, personName, removeValue, suggestions, withPeopleLabels } from './chips';

const values: ConditionValues = {
  status: [{ name: 'In progress', count: 2 }, { name: 'to do', color: '#87909e', count: 1 }, { name: 'blocked', count: 0 }],
  tag: [{ name: 'ux', count: 2 }, { name: 'auth', count: 1 }],
  people: [{ id: '81000002', name: 'Grace Fake', count: 2 }, { id: '81000001', name: 'Ada Fake', count: 1 }]
};
const cond = (o: Partial<Condition>): Condition => ({ field: 'status', values: [], ...o });

describe('suggestions', () => {
  test('status and tag: the source\'s values not chosen yet, filtered by the query; an Add row for new text', () => {
    expect(suggestions(cond({ values: ['TO DO'] }), '', values)).toEqual([
      { kind: 'value', value: 'In progress', label: 'In progress', count: 2 }, { kind: 'value', value: 'blocked', label: 'blocked', count: 0 }
    ]);
    expect(suggestions(cond({}), 'in', values).map((s) => s.label)).toEqual(['In progress', 'Add “in”']);
    // The query already one of them (any case) or already chosen: no Add row.
    expect(suggestions(cond({}), 'BLOCKED', values).map((s) => s.label)).toEqual(['blocked']);
    expect(suggestions(cond({ values: ['ready'] }), 'Ready ', values)).toEqual([]);
    expect(suggestions(cond({ field: 'tag' }), 'a', values).map((s) => s.label)).toEqual(['auth', 'Add “a”']);
    // No suggestions read yet: typed text still adds.
    expect(suggestions(cond({}), 'qa', null)).toEqual([{ kind: 'add', value: 'qa', label: 'Add “qa”' }]);
  });

  test('people: Me first, then names; no free text', () => {
    expect(suggestions(cond({ field: 'createdBy' }), '', values).map((s) => s.label)).toEqual(['Me', 'Grace Fake', 'Ada Fake']);
    expect(suggestions(cond({ field: 'assignee', values: ['me'] }), '', values).map((s) => s.label)).toEqual(['Grace Fake', 'Ada Fake']);
    expect(suggestions(cond({ field: 'assignee' }), 'ada', values)).toEqual([{ kind: 'value', value: '81000001', label: 'Ada Fake', count: 1 }]);
    expect(suggestions(cond({ field: 'assignee' }), 'zed', values)).toEqual([]);
    expect(suggestions(cond({ field: 'assignee' }), '', null).map((s) => s.label)).toEqual(['Me']);
  });
});

describe('adding and removing values', () => {
  test('status and tag: no duplicates in any case, at most 20, no labels', () => {
    expect(addValue(cond({ values: ['to do'] }), 'In progress', null)).toEqual(cond({ values: ['to do', 'In progress'] }));
    expect(addValue(cond({ values: ['to do'] }), 'TO DO', null)).toEqual(cond({ values: ['to do'] }));
    expect(addValue(cond({ values: ['to do'] }), '  ', null)).toEqual(cond({ values: ['to do'] }));
    const full = cond({ values: Array.from({ length: 20 }, (_, i) => `s${i}`) });
    expect(addValue(full, 'one more', null)).toBe(full);
  });

  test('people carry their names, the older values named from the suggestions', () => {
    expect(addValue(cond({ field: 'createdBy', values: ['me'] }), '81000002', values))
      .toEqual({ field: 'createdBy', values: ['me', '81000002'], labels: ['Me', 'Grace Fake'] });
    expect(addValue(cond({ field: 'createdBy', values: ['81000001', '99'] }), 'me', values))
      .toEqual({ field: 'createdBy', values: ['81000001', '99', 'me'], labels: ['Ada Fake', '…', 'Me'] });
    expect(addValue(cond({ field: 'createdBy', values: ['me'], labels: ['Me'] }), 'me', values)).toEqual(cond({ field: 'createdBy', values: ['me'], labels: ['Me'] }));
  });

  test('removing takes the label too', () => {
    expect(removeValue({ field: 'createdBy', values: ['me', '81000002'], labels: ['Me', 'Grace'] }, 0)).toEqual({ field: 'createdBy', values: ['81000002'], labels: ['Grace'] });
    expect(removeValue(cond({ values: ['a', 'b'] }), 1)).toEqual(cond({ values: ['a'] }));
  });

  test('a person\'s name: Me, the saved label, else the suggestions\' name, else unknown', () => {
    const c: Condition = { field: 'assignee', values: ['me', '81000001', '81000002', '99'], labels: ['Me', 'Ada L.', '…', '…'] };
    expect(c.values.map((_, i) => personName(c, i, values))).toEqual(['Me', 'Ada L.', 'Grace Fake', null]);
    expect(personName({ field: 'assignee', values: ['81000002'] }, 0, null)).toBeNull();
  });
});

describe('saving names people', () => {
  test('people conditions get their labels from what is known; other fields are left as they are', () => {
    const cs: Condition[] = [
      { field: 'createdBy', values: ['me', '81000002', '99'] }, { field: 'status', values: ['to do'] },
      { field: 'assignee', values: ['81000001'], labels: ['Ada L.'] }
    ];
    expect(withPeopleLabels(cs, values)).toEqual([
      { field: 'createdBy', values: ['me', '81000002', '99'], labels: ['Me', 'Grace Fake', '…'] }, { field: 'status', values: ['to do'] },
      { field: 'assignee', values: ['81000001'], labels: ['Ada L.'] }
    ]);
    expect(withPeopleLabels([{ field: 'assignee', values: ['99'] }], null)).toEqual([{ field: 'assignee', values: ['99'], labels: ['…'] }]);
  });
});

describe('Due within: typed days', () => {
  test('a whole number of days, 0–365; anything else keeps the last value', () => {
    expect(daysValue('30', 3)).toBe(30);
    expect(daysValue(' 7 ', 3)).toBe(7);
    expect(daysValue('400', 3)).toBe(365);
    expect(daysValue('-2', 3)).toBe(0);
    expect(daysValue('2.6', 3)).toBe(3);
    expect(daysValue('', 3)).toBe(3);
    expect(daysValue('abc', 9)).toBe(9);
  });
});
