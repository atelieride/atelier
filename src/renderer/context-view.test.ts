import fixture from '../../tests/fixtures/context/usage.json?raw';
import { describe, expect, test } from 'vitest';
import { parseContextUsage, type ContextReport } from '@shared/context-usage';
import { conversationNote, donutArcs, formatShare, formatTokens, groupDetail, rankedGroups, sinceAnalyzed, tiles, windowBar, windowLabel } from './context-view';

const report = (): ContextReport => {
  const raw = JSON.parse(fixture) as unknown;
  const status = [
    { name: 'shop-docs', status: 'connected', scope: 'project' }, { name: 'claude.ai Tasks', status: 'connected', scope: 'claudeai' },
    { name: 'workflows', status: 'connected', scope: 'user' }, { name: 'postgres-readonly', status: 'connected', scope: 'local' },
    { name: 'analytics', status: 'connected', scope: 'user' }, { name: 'claude.ai Mail', status: 'needs-auth', scope: 'claudeai' }
  ];
  return parseContextUsage(raw, status, 0)!;
};

describe('formatTokens / formatShare (as Claude Code writes them)', () => {
  test('tokens: plain under 1k, then k and M with one decimal, no trailing .0', () => {
    expect([0, 450, 999, 1000, 8000, 19_400, 106_800, 860_200, 999_960, 1_000_000, 1_500_000].map(formatTokens))
      .toEqual(['0', '450', '999', '1k', '8k', '19.4k', '106.8k', '860.2k', '1M', '1M', '1.5M']);
  });
  test('shares of the window: one decimal, a tiny one is <0.1%, none is 0%', () => {
    expect(formatShare(31_400, 1_000_000)).toBe('3.1%');
    expect(formatShare(400, 1_000_000)).toBe('<0.1%');
    expect(formatShare(0, 1_000_000)).toBe('0%');
    expect(formatShare(103_300, 1_000_000)).toBe('10.3%');
    expect(formatShare(5, 0)).toBe('0%');
  });
});

describe('sinceAnalyzed', () => {
  test('the transcript\'s input now minus the one the analysis saw; never negative, nothing without both', () => {
    const r = report();
    expect(sinceAnalyzed(r, r.apiTotal! + 3_400)).toBe(3_400);
    expect(sinceAnalyzed(r, r.apiTotal! - 10_000)).toBe(0);
    expect(sinceAnalyzed(r, null)).toBe(0);
    expect(sinceAnalyzed({ ...r, apiTotal: null }, 200_000)).toBe(0);
  });
});

describe('rankedGroups / tiles / windowBar', () => {
  test('groups by size, Messages with what came since', () => {
    expect(rankedGroups(report(), 0).map((g) => [g.id, g.tokens])).toEqual([['system', 31_400], ['messages', 26_700], ['mcp', 19_400], ['memory', 17_800], ['skills', 8_000]]);
    expect(rankedGroups(report(), 6_000).map((g) => [g.id, g.tokens])).toEqual([['messages', 32_700], ['system', 31_400], ['mcp', 19_400], ['memory', 17_800], ['skills', 8_000]]);
  });

  test('tiles: in use (with since), before you type, conversation, until auto-compact', () => {
    expect(tiles(report(), 3_400)).toEqual({ inUse: 106_700, share: '10.7%', before: 76_600, conversation: 30_100, since: 3_400, untilCompact: 967_000 - 106_700, compactAt: 967_000, free: 863_700 - 3_400 });
    expect(tiles({ ...report(), autoCompactAt: null }, 0)).toMatchObject({ untilCompact: null, free: 863_700 });
  });

  test('free space is Claude Code\'s own (the auto-compact buffer left out), less what came since', () => {
    // 1M − 103.3k in use − 33k buffer, as /context says.
    expect(tiles(report(), 0).free).toBe(863_700);
    expect(tiles(report(), 900_000).free).toBe(0);
  });

  test('the conversation tile\'s note: what came since, a compaction since, a conversation not found, or nothing', () => {
    const r = { ...report(), resumed: true };
    expect(conversationNote(r, r.apiTotal! + 3_400, true)).toEqual({ kind: 'since', text: '+3.4k since analyzed' });
    expect(conversationNote(r, r.apiTotal! - 50_000, true)).toEqual({ kind: 'compacted', text: 'compacted since · Refresh' });
    expect(conversationNote(r, null, true)).toEqual({ kind: 'none', text: 'the messages so far' });
    // Analysed without its conversation although the session has messages: said, not hidden.
    expect(conversationNote({ ...r, resumed: false }, null, true)).toEqual({ kind: 'missing', text: 'conversation not found: not counted' });
    expect(conversationNote({ ...r, resumed: false }, null, false)).toEqual({ kind: 'none', text: 'the messages so far' });
  });

  test('the window bar\'s label: the buffer only when auto-compact keeps one', () => {
    expect(windowLabel(report(), 0)).toBe('Context window: 103.3k of 1M in use, 33k kept free for auto-compact');
    expect(windowLabel({ ...report(), buffer: 0, autoCompactAt: null }, 0)).toBe('Context window: 103.3k of 1M in use, auto-compact off');
  });

  test('the whole window: each group\'s share of it in the donut\'s order, since hatched after Messages, the buffer at the end', () => {
    const bar = windowBar(report(), 3_400);
    expect(bar.segments.map((s) => [s.id, Number(s.pct.toFixed(2))])).toEqual([['messages', 2.67], ['since', 0.34], ['mcp', 1.94], ['memory', 1.78], ['skills', 0.8], ['system', 3.14]]);
    expect(bar.bufferPct).toBeCloseTo(3.3);
  });
});

describe('donutArcs', () => {
  test('arcs in the fixed order sum to the circle, each less its gap; empty groups have none', () => {
    const C = 100;
    const arcs = donutArcs(report(), 3_400, C, 2);
    expect(arcs.map((a) => a.id)).toEqual(['messages', 'since', 'mcp', 'memory', 'skills', 'system']);
    const used = 106_700;
    expect(arcs[0]!.offset).toBe(0);
    expect(arcs[1]!.offset).toBeCloseTo(-(26_700 / used) * C);
    expect(arcs[0]!.len).toBeCloseTo((26_700 / used) * C - 2);
    expect(donutArcs(report(), 0, C, 2).some((a) => a.id === 'since')).toBe(false);
  });

  test('a sliver never goes negative', () => {
    const r = report();
    const tiny = { ...r, groups: { ...r.groups, skills: 1 } };
    expect(donutArcs(tiny, 0, 100, 2).find((a) => a.id === 'skills')!.len).toBeGreaterThan(0);
  });
});

describe('groupDetail', () => {
  test('MCP servers: rows by what is in context, scope as a chip, loaded/total, deferred, where it is configured; offline apart', () => {
    const r = report();
    r.servers[0]!.configFile = '/Users/dev/Code/shop/.mcp.json';
    r.servers[0]!.configShown = '~/Code/shop/.mcp.json';
    const d = groupDetail(r, 'mcp', 0);
    expect(d.title).toBe('MCP servers');
    expect(d.tokens).toBe(19_400);
    expect(d.sub).toBe('in context now · 128.7k deferred');
    expect(d.servers!.map((s) => [s.name, s.scope, s.inContext, s.loadedLabel, s.deferred, s.bar])).toEqual([
      ['shop-docs', 'project', '8k', '3 / 5', '28.2k', 100],
      ['claude.ai Tasks', 'claude.ai', '6.6k', '1 / 2', '35.7k', expect.closeTo(82.3, 1)],
      ['workflows', 'user', '2.7k', '1 / 2', '47k', expect.closeTo(33.7, 1)],
      ['postgres-readonly', 'local', '1.6k', '1 / 2', '900', expect.closeTo(19.7, 1)],
      ['analytics', 'user', '450', '0 / 1', '16.9k', expect.closeTo(5.6, 1)]
    ]);
    expect(d.servers![0]!.config).toEqual({ path: '/Users/dev/Code/shop/.mcp.json', shown: '~/Code/shop/.mcp.json' });
    expect(d.servers![1]!.where).toBe('claude.ai › Settings › Connectors');
    expect(d.offline).toEqual({ label: '1 server not connected · cost nothing', names: 'claude.ai Mail (needs-auth)' });
    expect(d.pending).toBeNull();
    // Each server's button reads as one sentence to a screen reader.
    expect(d.servers![0]!.label).toBe('shop-docs, project: 8k in context, 3 of 5 tools loaded, 28.2k deferred');
  });

  test('a server still connecting in the copy is said apart: not counted, Refresh', () => {
    const r = report();
    const d = groupDetail({ ...r, offline: [...r.offline, { name: 'slow-one', status: 'pending' }] }, 'mcp', 0);
    expect(d.offline!.names).toBe('claude.ai Mail (needs-auth)');
    expect(d.pending).toEqual({ label: '1 server still connecting in the copy: not counted · Refresh', names: 'slow-one' });
  });

  test('Messages: tools with their sub-rows, who wrote what, since analyzed live and hatched', () => {
    const d = groupDetail(report(), 'messages', 3_400);
    expect(d.tokens).toBe(30_100);
    expect(d.rows!.map((r) => [r.name, r.tokens, r.sub ?? false, r.hatch ?? false])).toEqual([
      ['Tool calls and results', 14_200, false, false],
      ['Bash', 6_100, true, false], ['Read', 5_300, true, false], ['mcp__shop-docs__query', 2_800, true, false],
      ['Your messages', 4_900, false, false], ['Claude’s replies', 3_800, false, false], ['Attachments and reminders', 3_800, false, false],
      ['Since analyzed', 3_400, false, true]
    ]);
    expect(d.rows![0]!.bar).toBe(100);
    expect(d.compact).toBe(true);
  });

  test('Memory files: the shown path, the type in words, openable; System with its deferred tools muted; Skills by source', () => {
    const memory = groupDetail(report(), 'memory', 0);
    expect(memory.sub).toBe('4 files, loaded whole at every start');
    expect(memory.rows!.map((r) => [r.name, r.chip, r.open])).toEqual([
      ['/Users/dev/Code/shop/CLAUDE.md', 'Project', '/Users/dev/Code/shop/CLAUDE.md'],
      ['/Users/dev/.claude/projects/-Users-dev-Code-shop/memory/MEMORY.md', 'Auto memory', '/Users/dev/.claude/projects/-Users-dev-Code-shop/memory/MEMORY.md'],
      ['/Users/dev/Code/shop/apps/sales/CLAUDE.md', 'Project', '/Users/dev/Code/shop/apps/sales/CLAUDE.md'],
      ['/Users/dev/.claude/CLAUDE.md', 'User', '/Users/dev/.claude/CLAUDE.md']
    ]);
    const system = groupDetail(report(), 'system', 0);
    expect(system.rows!.map((r) => [r.name, r.tokens, r.muted ?? false, r.chip ?? null])).toEqual([
      ['System tools', 19_600, false, null], ['System prompt', 11_800, false, null], ['Deferred built-in tools', 25_400, true, 'not in context']
    ]);
    expect(system.rows![2]!.bar).toBe(0);
    const skills = groupDetail(report(), 'skills', 0);
    expect(skills.sub).toBe('5 skills, 2 agents');
    expect(skills.rows!.map((r) => [r.name, r.chip])).toEqual([
      ['claude.ai', '2 skills'], ['Built-in', '1 skill'], ['review-tools', 'plugin · 1 skill'], ['This project', '1 skill'], ['This project', '1 agent'], ['Your agents', '1 agent']
    ]);
  });
});
