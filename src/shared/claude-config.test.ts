import { expect, test } from 'vitest';
import { addedMcp, loadableMcp, type ClaudeConfig, type ConfiguredItem } from './claude-config';

const item = (name: string, state: ConfiguredItem['state'] = 'enabled'): ConfiguredItem => ({ name, scope: 'user', state });
const config = (mcpServers: ConfiguredItem[]): ClaudeConfig => ({ mcpServers, skills: [], plugins: [], unreadable: false, project: true });

test('loadableMcp: the servers a session would start with, enabled or to approve, sorted', () => {
  expect(loadableMcp(config([item('zeta'), item('off', 'disabled'), item('alpha', 'approval'), item('beta')]))).toEqual(['alpha', 'beta', 'zeta']);
  expect(loadableMcp(config([]))).toEqual([]);
});

test('addedMcp: only the names not in the baseline, in order; removed ones never count', () => {
  expect(addedMcp(['a', 'b'], ['a', 'b', 'c', 'posthog'])).toEqual(['c', 'posthog']);
  expect(addedMcp(['a', 'b'], ['a'])).toEqual([]);
  expect(addedMcp([], [])).toEqual([]);
});
