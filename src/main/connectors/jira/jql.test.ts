import { describe, expect, test } from 'vitest';
import { listJql, searchJql, searchWords, watchJql } from './jql';

// One bounded query per refresh, values only from ids and cleaned words.

const mine = (id: string) => ({ id, everyone: false });
const all = (id: string) => ({ id, everyone: true });

describe('listJql', () => {
  test('my issues in every chosen project, open ones, due first', () => {
    expect(listJql({ projects: [mine('10001'), mine('10002')], includeDone: false }))
      .toBe('project in (10001, 10002) AND assignee = currentUser() AND statusCategory != Done ORDER BY duedate ASC, updated DESC');
  });

  test('everyone\'s in some projects, mine in the others; done included; a saved filter', () => {
    expect(listJql({ projects: [mine('10001'), all('10002')], includeDone: true, filterId: '10040' }))
      .toBe('project in (10001, 10002) AND (project in (10002) OR assignee = currentUser()) AND filter = 10040 ORDER BY duedate ASC, updated DESC');
    expect(listJql({ projects: [all('10001')], includeDone: false }))
      .toBe('project in (10001) AND statusCategory != Done ORDER BY duedate ASC, updated DESC');
  });

  test('no project → no query at all', () => {
    expect(listJql({ projects: [], includeDone: false })).toBeNull();
  });

  test('anything but numeric ids is refused (never interpolated)', () => {
    for (const bad of ['ATL', '1) OR (1=1', '10001 OR project = 1', '', '0', '-1']) {
      expect(() => listJql({ projects: [mine(bad)], includeDone: false }), bad).toThrow();
    }
    expect(() => listJql({ projects: [mine('10001')], includeDone: false, filterId: '1 OR x' })).toThrow();
  });
});

describe('search', () => {
  test('words: letters and digits only, at most six, each a prefix', () => {
    expect(searchWords('Dark-mode billing_page v2!')).toEqual(['Dark', 'mode', 'billing', 'page', 'v2']);
    expect(searchWords('a b c d e f g h')).toHaveLength(6);
    expect(searchWords('"\\ ) OR project != 1 ( ~ * ?')).toEqual(['project', '1']);
    expect(searchWords('caffè 東京')).toEqual(['caffè', '東京']);
    // Lucene's operators fail Jira's text search even quoted: never sent as words.
    expect(searchWords('fix OR or And not NOT bug')).toEqual(['fix', 'bug']);
  });

  test('the list\'s scope plus every word on the title', () => {
    expect(searchJql({ projects: [mine('10001')], includeDone: false }, 'billing export'))
      .toBe('project in (10001) AND assignee = currentUser() AND statusCategory != Done AND summary ~ "billing*" AND summary ~ "export*" ORDER BY updated DESC');
  });

  test('nothing searchable, or no project → no query', () => {
    expect(searchJql({ projects: [mine('10001')], includeDone: false }, '"()*')).toBeNull();
    expect(searchJql({ projects: [], includeDone: false }, 'x')).toBeNull();
  });

  // Whatever is typed, the output has the builder's grammar: no quote, backslash or operator from the input survives
  // outside the `summary ~ "<letters/digits>*"` slots.
  test('fuzz: the query keeps its grammar', () => {
    const alphabet = ['"', '\\', '(', ')', ' OR ', ' AND ', '~', '*', '!', '=', ' ', 'a', 'Z', '9', 'é', '\n', '\u202e', '-', "'", '[', ']'];
    let seed = 7;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    const shape = /^project in \(10001\) AND assignee = currentUser\(\) AND statusCategory != Done(?: AND summary ~ "[\p{L}\p{N}]{1,40}\*")+ ORDER BY updated DESC$/u;
    for (let n = 0; n < 2000; n++) {
      let text = '';
      for (let i = 0; i < 1 + Math.floor(rnd() * 24); i++) text += alphabet[Math.floor(rnd() * alphabet.length)];
      const q = searchJql({ projects: [mine('10001')], includeDone: false }, text);
      if (q !== null) expect(q, JSON.stringify(text)).toMatch(shape);
    }
  });
});

describe('watchJql', () => {
  test('the newest issues of the rule\'s projects, everyone\'s', () => {
    expect(watchJql(['10001', '10003'], { includeDone: false })).toBe('project in (10001, 10003) AND statusCategory != Done ORDER BY created DESC');
    expect(watchJql(['10001'], { includeDone: true })).toBe('project in (10001) ORDER BY created DESC');
    expect(watchJql([], { includeDone: false })).toBeNull();
    expect(() => watchJql(['ATL'], { includeDone: false })).toThrow();
  });
});
