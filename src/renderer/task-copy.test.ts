import { expect, test } from 'vitest';
import { taskMarkdown } from './task-copy';

const detail = {
  id: '86fk0001a', displayId: 'ENG-101', title: 'Fix the login‮ redirect loop', status: { name: 'in progress' }, priority: 'high',
  due: new Date(2026, 9, 20, 18, 0).getTime(), listName: 'Sprint 42', url: 'https://app.clickup.com/t/86fk0001a',
  body: '\nSteps:\n1. Sign in\n2. Loop\u0007\n\n'
};

test('Copy Task: title with its id, the fields it has, the link, then the description as it is', () => {
  expect(taskMarkdown(detail)).toBe([
    '# ENG-101 · Fix the login redirect loop',
    '',
    '- Status: in progress',
    '- Priority: high',
    '- List: Sprint 42',
    '- Due: 2026-10-20',
    '- Link: https://app.clickup.com/t/86fk0001a',
    '',
    'Steps:',
    '1. Sign in',
    '2. Loop',
    ''
  ].join('\n'));
});

test('Copy Task: missing fields are left out; no description says so', () => {
  const bare = { id: 'x', displayId: 'x', title: 'Bare', status: { name: '' }, url: 'https://app.clickup.com/t/x', body: '  \n' };
  expect(taskMarkdown(bare)).toBe('# x · Bare\n\n- Link: https://app.clickup.com/t/x\n\n_No description._\n');
});

test('a task without an ID: the heading is the title alone', () => {
  expect(taskMarkdown({ displayId: '', title: 'Write the launch post', status: { name: '', color: '' }, url: 'https://www.notion.so/abc', body: '' }).startsWith('# Write the launch post\n')).toBe(true);
});
