import { describe, expect, test } from 'vitest';
import { InvalidArguments, NotAllowed, SchemaChanged } from '../errors';
import { missingTools } from '../mcp/toolset';
import { ALLOWED_TOOLS, CLICKUP_TOOLS } from './tools';

// Six read tools since 2026-10-19: clickup_get_list (optional) gives the statuses' colors that compact replies lack.
const READ = ['clickup_resolve_assignees', 'clickup_filter_tasks', 'clickup_get_task', 'clickup_get_workspace_hierarchy', 'clickup_search', 'clickup_get_list'];

describe('ClickUp ToolSet', () => {
  test('exactly the six read tools', () => {
    expect([...CLICKUP_TOOLS.names].sort()).toEqual([...READ].sort());
    expect([...ALLOWED_TOOLS].sort()).toEqual([...READ].sort());
    for (const n of READ) expect(CLICKUP_TOOLS.isAllowed(n), n).toBe(true);
    // A server may lack the optional one without the connector going `unavailable`.
    expect([...CLICKUP_TOOLS.required].sort()).toEqual(READ.filter((n) => n !== 'clickup_get_list').sort());
  });

  test.each(['clickup_update_task', 'clickup_create_task', 'clickup_execute_operator', 'CLICKUP_GET_TASK', ' clickup_get_task', 'constructor', '', 42, null, undefined])(
    'refuses %j', (name) => {
      expect(CLICKUP_TOOLS.isAllowed(name)).toBe(false);
      expect(() => CLICKUP_TOOLS.parseArgs(name as 'clickup_search', {})).toThrow(NotAllowed);
      expect(() => CLICKUP_TOOLS.parseReply(name as 'clickup_search', {})).toThrow(NotAllowed);
    });

  test('names is a frozen copy: nothing that touches it changes a check', () => {
    expect(() => (CLICKUP_TOOLS.names as string[]).push('clickup_update_task')).toThrow(TypeError);
    expect(CLICKUP_TOOLS.isAllowed('clickup_update_task')).toBe(false);
    expect(CLICKUP_TOOLS.names).toHaveLength(6);
  });

  test('parseArgs is strict, parseReply reports a changed shape', () => {
    expect(CLICKUP_TOOLS.parseArgs('clickup_get_task', { task_id: 'a' })).toEqual({ task_id: 'a' });
    expect(() => CLICKUP_TOOLS.parseArgs('clickup_get_task', { task_id: 'a', extra: 1 })).toThrow(InvalidArguments);
    expect(() => CLICKUP_TOOLS.parseReply('clickup_get_task', { name: 'no id' })).toThrow(SchemaChanged);
  });

  test('missingTools names the allowlisted tools a tools/list lacks', () => {
    expect(missingTools(CLICKUP_TOOLS, [...READ, 'clickup_update_task'])).toEqual([]);
    expect(missingTools(CLICKUP_TOOLS, READ.filter((n) => n !== 'clickup_search'))).toEqual(['clickup_search']);
  });
});
