import { describe, expect, test } from 'vitest';
import { GROUP_ORDER, serverKey, type ContextReport } from '../../shared/context-usage';
import { DEMO_HOME, accountDir } from './accounts';
import { CONTEXT_MAX, CONTEXT_SETUP, contextReport, contextTokens } from './context';
import { SCENARIOS } from './scenarios';

// The Context usage sheet's fictional numbers: they must add up the way Claude Code's
// own answer does, or the sheet's tiles, bar and donut would tell different stories.
const ROOT = `${DEMO_HOME}/code/acme-store`;
const sum = (xs: readonly number[]) => xs.reduce((n, x) => n + x, 0);
const tokens = (xs: readonly { tokens: number }[]) => sum(xs.map((x) => x.tokens));
const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => b - a);

function addsUp(r: ContextReport): void {
  expect(sum(GROUP_ORDER.map((g) => r.groups[g]))).toBe(r.total);
  expect(r.total + r.buffer + r.free).toBe(r.max);
  expect(r.groups.system).toBe(tokens(r.system));
  expect(r.groups.mcp).toBe(sum(r.servers.map((s) => s.inContext)));
  for (const s of r.servers) {
    expect(s.inContext).toBe(s.instructions + tokens(s.loaded));
    expect(s.key).toBe(serverKey(s.name));
    expect(s.loaded.map((t) => t.tokens)).toEqual(sorted(s.loaded.map((t) => t.tokens)));
  }
  expect(r.servers.map((s) => s.inContext)).toEqual(sorted(r.servers.map((s) => s.inContext)));
  expect(r.deferred.mcp).toBe(sum(r.servers.map((s) => s.deferredTokens)));
  expect(r.groups.memory).toBe(tokens(r.memory));
  expect(r.groups.skills).toBe(tokens(r.skills));
  const m = r.messages;
  expect(r.groups.messages).toBe(m.toolsTotal + m.user + m.assistant + m.attachments + m.other);
  expect(m.toolsTotal).toBe(tokens(m.tools) + m.otherTools);
  expect(m.tools.length).toBeLessThanOrEqual(5);
  for (const n of [...Object.values(r.groups), ...m.tools.map((t) => t.tokens), m.otherTools, m.user, m.assistant, m.attachments, m.other]) expect(n).toBeGreaterThanOrEqual(0);
}

describe('the demo\'s Context usage report', () => {
  test('every scripted session gets one that adds up, as large as its status line says', () => {
    for (const [name, sc] of Object.entries(SCENARIOS)) {
      const r = contextReport({ pct: sc.context, configDir: accountDir(DEMO_HOME, sc.account ?? 'default'), home: DEMO_HOME, root: ROOT, at: 5 });
      addsUp(r);
      expect(r.max, name).toBe(CONTEXT_MAX);
      expect(Math.abs(r.total - (sc.context / 100) * CONTEXT_MAX), name).toBeLessThanOrEqual(100);
      expect(r.total, name).toBe(contextTokens(sc.context));
      // The copy read the conversation, and its last call's input is what the live count starts from.
      expect(r.resumed).toBe(true);
      expect(r.apiTotal).toBe(r.total);
      expect(r.at).toBe(5);
      expect(r.groups.messages).toBe(r.total - CONTEXT_SETUP);
      expect(r.autoCompactAt).not.toBeNull();
      expect(r.autoCompactAt!).toBeGreaterThan(r.total);
    }
  });

  test('the setup is the same for every session: servers by weight, one that failed, memory, skills', () => {
    const r = contextReport({ pct: 20, configDir: accountDir(DEMO_HOME, 'default'), home: DEMO_HOME, root: ROOT, at: 0 });
    expect(r.servers.map((s) => s.name)).toEqual(['acme-docs', 'claude.ai Tasks', 'playwright', 'postgres']);
    expect(r.offline).toEqual([{ name: 'staging-logs', status: 'failed' }]);
    expect(r.total - r.groups.messages).toBe(CONTEXT_SETUP);
    expect(r.skills.map((s) => [s.kind, s.source, s.plugin])).toEqual([['skill', 'plugin', 'review-kit'], ['skill', 'built-in', null], ['agent', 'built-in', null], ['skill', 'project', null]]);
  });

  test('paths follow the session\'s account, shown with ~; a claude.ai connector has no file', () => {
    const personal = contextReport({ pct: 20, configDir: accountDir(DEMO_HOME, 'default'), home: DEMO_HOME, root: ROOT, at: 0 });
    expect(personal.memory.map((m) => [m.shown, m.type])).toEqual([
      ['~/.claude/projects/-home-ada-code-acme-store/memory/MEMORY.md', 'AutoMem'],
      ['~/.claude/CLAUDE.md', 'User']
    ]);
    expect(personal.memory[1]!.path).toBe(`${DEMO_HOME}/.claude/CLAUDE.md`);
    const files = Object.fromEntries(personal.servers.map((s) => [s.name, [s.configFile, s.configShown]]));
    // The default account's settings live beside its folder (~/.claude.json), another account's inside its own.
    expect(files).toEqual({
      'acme-docs': [`${DEMO_HOME}/.claude.json`, '~/.claude.json'],
      'claude.ai Tasks': [null, null],
      playwright: [`${DEMO_HOME}/.claude.json`, '~/.claude.json'],
      postgres: [`${DEMO_HOME}/.claude.json`, '~/.claude.json']
    });
    const work = contextReport({ pct: 20, configDir: accountDir(DEMO_HOME, 'work'), home: DEMO_HOME, root: ROOT, at: 0 });
    expect(work.memory.map((m) => m.shown)).toEqual(['~/.claude-work/projects/-home-ada-code-acme-store/memory/MEMORY.md', '~/.claude-work/CLAUDE.md']);
    expect(work.servers[0]!.configShown).toBe('~/.claude-work/.claude.json');
  });

  test('a conversation smaller than the setup counts the setup alone (a fresh session, or one cleared)', () => {
    expect(contextTokens(0)).toBe(CONTEXT_SETUP);
    const r = contextReport({ pct: 0, configDir: accountDir(DEMO_HOME, 'default'), home: DEMO_HOME, root: ROOT, at: 0 });
    addsUp(r);
    expect(r.groups.messages).toBe(0);
    expect(r.messages.tools).toEqual([]);
    expect(r.total).toBe(CONTEXT_SETUP);
  });

  test('any context % gives a report that adds up, the window never overflowing', () => {
    for (let pct = 0; pct <= 100; pct += 1) {
      const r = contextReport({ pct, configDir: accountDir(DEMO_HOME, 'default'), home: DEMO_HOME, root: ROOT, at: 0 });
      addsUp(r);
      expect(r.free).toBeGreaterThanOrEqual(0);
    }
  });
});
