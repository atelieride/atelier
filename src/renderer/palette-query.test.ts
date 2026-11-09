import { expect, test } from 'vitest';
import { parseQuery, splitTerminals, stepActive } from './palette-query';

// Workspaces: "#" only while the project uses them; off, a query starting with # searches as today.
test('# lists the workspaces while they are on, and searches everything otherwise', () => {
  expect(parseQuery('#', { workspaces: true })).toEqual({ mode: 'workspaces', text: '' });
  expect(parseQuery('#bil', { workspaces: true })).toEqual({ mode: 'workspaces', text: 'bil' });
  expect(parseQuery('  # db ', { workspaces: true })).toEqual({ mode: 'workspaces', text: 'db' });
  expect(parseQuery('#123 fix')).toEqual({ mode: 'all', text: '#123 fix' });
  expect(parseQuery('#notes', { workspaces: false })).toEqual({ mode: 'all', text: '#notes' });
});

test.each([
  ['', { mode: 'all', text: '' }],
  ['app', { mode: 'all', text: 'app' }],
  ['>new', { mode: 'commands', text: 'new' }],
  ['  > new ', { mode: 'commands', text: 'new' }],
  ['@ref', { mode: 'sessions', text: 'ref' }],
  [':42', { mode: 'line', text: '42', line: 42 }],
  [':abc', { mode: 'line', text: 'abc' }],
  [':0', { mode: 'line', text: '0' }],
  ['resume:', { mode: 'resume', text: '' }],
  ['resume:auth', { mode: 'resume', text: 'auth' }],
  ['scheduled:', { mode: 'scheduled', text: '' }],
  ['scheduled: tests', { mode: 'scheduled', text: 'tests' }],
  // Tasks: only tasks.
  ['task:', { mode: 'tasks', text: '' }],
  ['task: login', { mode: 'tasks', text: 'login' }],
  ['  task:ENG-101', { mode: 'tasks', text: 'ENG-101' }],
  ['tasks', { mode: 'all', text: 'tasks' }],
  // One connector's tasks: case-sensitive, like task:.
  ['clickup:', { mode: 'tasks', source: 'clickup', text: '' }],
  ['clickup: login', { mode: 'tasks', source: 'clickup', text: 'login' }],
  ['notion:', { mode: 'tasks', source: 'notion', text: '' }],
  [' notion: rate ', { mode: 'tasks', source: 'notion', text: 'rate' }],
  ['notion:ENG-1', { mode: 'tasks', source: 'notion', text: 'ENG-1' }],
  ['Notion:', { mode: 'all', text: 'Notion:' }],
  ['notion', { mode: 'all', text: 'notion' }],
  ['clickup', { mode: 'all', text: 'clickup' }]
])('%j', (q, expected) => {
  expect(parseQuery(q)).toEqual(expected);
});

test.each([
  [0, 1, 3, 1],
  [2, 1, 3, 0],
  [0, -1, 3, 2],
  [1, -1, 3, 0],
  [0, 1, 1, 0],
  [0, -1, 1, 0],
  [0, 1, 0, 0],
  [0, -1, 0, 0],
  // A stale index (the list shrank) counts as the last item.
  [7, 1, 3, 0],
  [7, -1, 3, 1]
])('stepActive(%i, %i, %i) = %i: arrows wrap around the ends', (active, delta, length, expected) => {
  expect(stepActive(active, delta as 1 | -1, length)).toBe(expected);
});

test('Claude sessions (starting ones too) are listed under Sessions, plain terminals under Terminals', () => {
  const session = { id: 'a', session: { sessionId: 's' } };
  const starting = { id: 'b', session: null };
  const plain = { id: 'c', session: null };
  expect(splitTerminals([session, starting, plain], { b: 1 })).toEqual({ sessions: [session, starting], plain: [plain] });
});
