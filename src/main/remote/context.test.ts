import { describe, expect, test } from 'vitest';
import type { ContextReport } from '@shared/context-usage';
import { phoneContextReport } from './context';

function report(o: Partial<ContextReport> = {}): ContextReport {
  return {
    at: 1_700_000_000_000,
    model: 'claude-opus-5-5',
    total: 61_000,
    max: 200_000,
    autoCompactAt: 167_000,
    apiTotal: 60_500,
    resumed: true,
    groups: { system: 14_000, messages: 31_000, mcp: 6_000, memory: 7_000, skills: 3_000 },
    system: [{ name: 'System prompt', tokens: 3_000 }, { name: 'System tools', tokens: 11_000 }],
    deferred: { mcp: 22_000, system: 9_000 },
    buffer: 33_000,
    free: 106_000,
    servers: [{
      name: 'claude.ai Tasks', key: 'claude_ai_Tasks', scope: 'claudeai', instructions: 400,
      loaded: [{ name: 'create_task', tokens: 900 }, { name: 'list_tasks', tokens: 700 }],
      deferredCount: 12, deferredTokens: 8_000, inContext: 2_000,
      configFile: '/home/.claude.json', configShown: '~/.claude.json'
    }],
    offline: [{ name: 'figma', status: 'failed' }, { name: 'linear', status: 'needs-auth' }],
    memory: [
      { path: '/work/app/CLAUDE.md', shown: '/work/app/CLAUDE.md', type: 'Project', tokens: 5_000 },
      { path: 'C:\\work\\.claude\\CLAUDE.md', shown: 'C:\\work\\.claude\\CLAUDE.md', type: 'User', tokens: 2_000 }
    ],
    skills: [
      { kind: 'skill', source: 'user', plugin: null, count: 4, tokens: 1_200 },
      { kind: 'skill', source: 'plugin', plugin: 'review-kit', count: 9, tokens: 1_500 },
      { kind: 'agent', source: 'built-in', plugin: null, count: 3, tokens: 300 }
    ],
    messages: { tools: [{ name: 'Read', tokens: 12_000 }, { name: 'Bash', tokens: 6_000 }], otherTools: 2_000, toolsTotal: 20_000, user: 4_000, assistant: 6_000, attachments: 1_000, other: 0 },
    ...o
  };
}

describe('what fills a session\'s context, as a phone gets it', () => {
  test('the numbers and names Atelier\'s sheet shows', () => {
    expect(phoneContextReport(report())).toEqual({
      at: 1_700_000_000_000,
      model: 'claude-opus-5-5',
      total: 61_000,
      max: 200_000,
      autoCompactAt: 167_000,
      buffer: 33_000,
      free: 106_000,
      resumed: true,
      groups: { system: 14_000, messages: 31_000, mcp: 6_000, memory: 7_000, skills: 3_000 },
      system: [{ name: 'System prompt', tokens: 3_000 }, { name: 'System tools', tokens: 11_000 }],
      deferred: { mcp: 22_000, system: 9_000 },
      servers: [{ name: 'claude.ai Tasks', scope: 'claudeai', inContext: 2_000, loaded: 2, deferred: 12, deferredTokens: 8_000 }],
      offline: 2,
      memory: [{ name: 'CLAUDE.md', type: 'Project', tokens: 5_000 }, { name: 'CLAUDE.md', type: 'User', tokens: 2_000 }],
      skills: [
        { kind: 'skill', source: 'plugin', plugin: 'review-kit', count: 9, tokens: 1_500 },
        { kind: 'skill', source: 'user', count: 4, tokens: 1_200 },
        { kind: 'agent', source: 'built-in', count: 3, tokens: 300 }
      ],
      messages: { tools: [{ name: 'Read', tokens: 12_000 }, { name: 'Bash', tokens: 6_000 }], otherTools: 2_000, toolsTotal: 20_000, user: 4_000, assistant: 6_000, attachments: 1_000, other: 0 }
    });
  });

  test('never a path, a config file or the names of the tools a server loaded', () => {
    const json = JSON.stringify(phoneContextReport(report()));
    for (const leak of ['/work/', '/home/', '.claude.json', 'C:', '.claude\\\\', 'create_task', 'claude_ai_Tasks', 'apiTotal']) expect(json).not.toContain(leak);
  });

  test('an unknown model and auto-compact off are left out', () => {
    const r = phoneContextReport(report({ model: null, autoCompactAt: null }));
    expect(r).not.toHaveProperty('model');
    expect(r).not.toHaveProperty('autoCompactAt');
  });

  test('long lists keep their largest rows, long names are cut', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ path: `/p/${i}/CLAUDE.md`, shown: '', type: 'Project', tokens: i }));
    const r = phoneContextReport(report({ memory: many, system: [{ name: 'x'.repeat(300), tokens: 1 }] }));
    expect(r.memory).toHaveLength(40);
    expect(r.memory[0]!.tokens).toBe(79);
    expect(r.system[0]!.name).toHaveLength(120);
  });
});
