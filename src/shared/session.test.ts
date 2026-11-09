import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  BACKGROUND_HYGIENE_MS, applyStatusLine, configDirOf, describeTool, expireBackground, expireSubagents, markSeen, mergeUsage, mergeUsageByDir, onShellForeground, publicSession,
  reduceHook, seedLastMessage, stampUsage, usageKey, type LimitPauseEnd, type SessionInfo, type Usage, type UsageEntry
} from './session';

test('usageKey leaves updatedAt out at any depth, keeps everything else', () => {
  const a = [{ configDir: null, usage: { fiveHour: { pct: 42, resetsAt: 1 }, sevenDay: null, updatedAt: 1 } }];
  const b = [{ configDir: null, usage: { fiveHour: { pct: 42, resetsAt: 1 }, sevenDay: null, updatedAt: 999 } }];
  const c = [{ configDir: null, usage: { fiveHour: { pct: 43, resetsAt: 1 }, sevenDay: null, updatedAt: 1 } }];
  expect(usageKey(a)).toBe(usageKey(b));
  expect(usageKey(a)).not.toBe(usageKey(c));
});

const T = 1000;
const ev = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({ hook_event_name, session_id: 's1', cwd: '/p', ...extra });
function run(...events: Record<string, unknown>[]): SessionInfo | null | undefined {
  let s: SessionInfo | null | undefined = null;
  for (const e of events) { const n = reduceHook(s ?? null, e, T); if (n !== undefined) s = n; }
  return s;
}

describe('reduceHook', () => {
  test('SessionStart → ready, with title', () => {
    expect(run(ev('SessionStart', { source: 'startup', session_title: 'Interviewees' }))).toMatchObject({ sessionId: 's1', state: 'idle', title: 'Interviewees', unread: false });
  });
  test('prompt and tools → working with activity', () => {
    const s = run(ev('SessionStart'), ev('UserPromptSubmit', { prompt: 'x' }), ev('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/p/src/App.tsx' } }));
    expect(s).toMatchObject({ state: 'running', activity: 'edit App.tsx' });
  });
  test('PostToolUseFailure ends the agent\'s permission wait like PostToolUse', () => {
    let s = reduceHook(null, { hook_event_name: 'SessionStart', session_id: 's1' }, 1)!;
    s = reduceHook(s, { hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'false' } }, 2)!;
    expect(s.state).toBe('waiting');
    s = reduceHook(s, { hook_event_name: 'PostToolUseFailure', session_id: 's1', tool_name: 'Bash', tool_use_id: 'b1' }, 3)!;
    expect(s).toMatchObject({ state: 'running', waitingFor: null });
  });
  test('permission → waiting for you, with what', () => {
    const s = run(ev('SessionStart'), ev('UserPromptSubmit'), ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
    expect(s).toMatchObject({ state: 'waiting', activity: 'waiting: Bash npm test' });
  });
  test('Notification permission_prompt / elicitation / agent_needs_input → waiting for you', () => {
    for (const nt of ['permission_prompt', 'elicitation_dialog', 'agent_needs_input']) {
      expect(run(ev('SessionStart'), ev('UserPromptSubmit'), ev('Notification', { notification_type: nt, message: 'm' }))?.state).toBe('waiting');
    }
  });
  test('after the permission the first event goes back to running', () => {
    const s = run(ev('SessionStart'), ev('PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: '/p/a.ts' } }), ev('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/p/a.ts' } }));
    expect(s?.state).toBe('running');
  });
  test('Stop → done and unread; markSeen marks it read', () => {
    const s = run(ev('SessionStart'), ev('UserPromptSubmit'), ev('Stop'));
    expect(s).toMatchObject({ state: 'done', unread: true, activity: null });
    expect(markSeen(s!)).toMatchObject({ state: 'done', unread: false });
  });
  test('StopFailure → error', () => {
    expect(run(ev('SessionStart'), ev('UserPromptSubmit'), ev('StopFailure', { error: 'overloaded' }))?.state).toBe('error');
  });
  test('idle_prompt while working (interrupted with Esc) → ready; after Stop it stays done', () => {
    expect(run(ev('SessionStart'), ev('UserPromptSubmit'), ev('Notification', { notification_type: 'idle_prompt' }))?.state).toBe('idle');
    expect(run(ev('SessionStart'), ev('UserPromptSubmit'), ev('Stop'), ev('Notification', { notification_type: 'idle_prompt' }))?.state).toBe('done');
  });
  test('idle_prompt after Esc on a permission request → ready, no longer waiting', () => {
    const s = run(ev('SessionStart'), ev('UserPromptSubmit'), ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm x' } }), ev('Notification', { notification_type: 'idle_prompt' }));
    expect(s).toMatchObject({ state: 'idle', activity: null });
  });
  test('SessionStart after a compaction (source compact) does not reset state and context', () => {
    let s = run(ev('SessionStart'), ev('UserPromptSubmit'))!;
    s = { ...s, contextPct: 80 };
    const after = reduceHook(s, ev('SessionStart', { source: 'compact' }), T);
    expect(after).toMatchObject({ state: 'running', contextPct: 80 });
  });
  test('SessionEnd → session closed', () => {
    expect(run(ev('SessionStart'), ev('SessionEnd', { reason: 'prompt_input_exit' }))).toBeNull();
  });
  test('a new session in the same terminal replaces the previous one', () => {
    const s = run(ev('SessionStart'), ev('Stop'), { ...ev('SessionStart', { session_title: 'Other' }), session_id: 's2' });
    expect(s).toMatchObject({ sessionId: 's2', state: 'idle', title: 'Other' });
  });
  test('event without SessionStart (hooks added to an already running session) still creates the session', () => {
    expect(run(ev('UserPromptSubmit', { session_title: 'T' }))).toMatchObject({ state: 'running', title: 'T' });
  });
  test('invalid payload → ignored', () => {
    expect(reduceHook(null, null, T)).toBeUndefined();
    expect(reduceHook(null, { hook_event_name: 'Stop' }, T)).toBeUndefined();
    expect(reduceHook(null, { session_id: 's', hook_event_name: 42 }, T)).toBeUndefined();
    expect(reduceHook(null, ev('FutureEvent'), T)).toBeUndefined();
  });
  test('the title stays if a later event does not carry it', () => {
    expect(run(ev('SessionStart', { session_title: 'Name' }), ev('Stop'))?.title).toBe('Name');
  });
});

// v2.0: richer states from the hook payloads.
describe('reduceHook: richer states', () => {
  const working = [ev('SessionStart'), ev('UserPromptSubmit', { prompt: 'fix the tests' })];

  test('a fresh session carries every new field, empty', () => {
    expect(run(ev('SessionStart'))).toMatchObject({ waitingFor: null, compacting: false, subagents: 0, errorReason: null, permissionMode: null, autoTitle: null, background: { items: [], crons: [] } });
  });

  test('waitingFor: PermissionRequest → permission; the next activity clears it', () => {
    const w = run(...working, ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
    expect(w).toMatchObject({ state: 'waiting', waitingFor: 'permission' });
    expect(run(...working, ev('PermissionRequest', { tool_name: 'Bash' }), ev('PostToolUse', { tool_name: 'Bash' }))).toMatchObject({ state: 'running', waitingFor: null });
  });

  test('waitingFor: AskUserQuestion (PreToolUse or PermissionRequest) → question; ExitPlanMode → permission (approving a plan)', () => {
    expect(run(...working, ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }))).toMatchObject({ state: 'waiting', waitingFor: 'question', activity: 'waiting: question' });
    expect(run(...working, ev('PermissionRequest', { tool_name: 'AskUserQuestion' }))).toMatchObject({ state: 'waiting', waitingFor: 'question' });
    expect(run(...working, ev('PreToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan: 'p' } }))).toMatchObject({ state: 'waiting', waitingFor: 'permission', activity: 'waiting: plan approval' });
    expect(run(...working, ev('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/p/a.ts' } }))).toMatchObject({ state: 'running', waitingFor: null });
  });

  test('waitingFor from notifications: permission_prompt → permission; elicitation dialogs and agent_needs_input → question', () => {
    expect(run(...working, ev('Notification', { notification_type: 'permission_prompt' }))).toMatchObject({ state: 'waiting', waitingFor: 'permission' });
    for (const nt of ['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']) {
      expect(run(...working, ev('Notification', { notification_type: nt }))).toMatchObject({ state: 'waiting', waitingFor: 'question' });
    }
  });

  test('a late permission_prompt notification keeps what the PermissionRequest said', () => {
    const s = run(...working, ev('PermissionRequest', { tool_name: 'AskUserQuestion' }), ev('Notification', { notification_type: 'permission_prompt' }));
    expect(s).toMatchObject({ state: 'waiting', waitingFor: 'question' });
  });

  test('elicitation answered (complete / response) → back to work', () => {
    for (const nt of ['elicitation_complete', 'elicitation_response']) {
      expect(run(...working, ev('Notification', { notification_type: 'elicitation_dialog' }), ev('Notification', { notification_type: nt }))).toMatchObject({ state: 'running', waitingFor: null });
    }
    // Not waiting on a question: nothing changes.
    expect(run(...working, ev('PermissionRequest', { tool_name: 'Bash' }), ev('Notification', { notification_type: 'elicitation_response' }))).toMatchObject({ state: 'waiting', waitingFor: 'permission' });
  });

  test('idle_prompt → input (prompt free): after Stop the state stays done, after Esc on a permission it is idle', () => {
    expect(run(...working, ev('Stop'), ev('Notification', { notification_type: 'idle_prompt' }))).toMatchObject({ state: 'done', waitingFor: 'input' });
    expect(run(...working, ev('PermissionRequest', { tool_name: 'Bash' }), ev('Notification', { notification_type: 'idle_prompt' }))).toMatchObject({ state: 'idle', waitingFor: 'input' });
    expect(run(...working, ev('Stop'), ev('Notification', { notification_type: 'idle_prompt' }), ev('UserPromptSubmit', { prompt: 'more' }))).toMatchObject({ state: 'running', waitingFor: null });
  });

  test('Stop, StopFailure and SessionStart clear a pending wait', () => {
    expect(run(...working, ev('PermissionRequest', { tool_name: 'Bash' }), ev('Stop'))?.waitingFor).toBeNull();
    expect(run(...working, ev('PermissionRequest', { tool_name: 'Bash' }), ev('StopFailure', { error: 'server_error' }))?.waitingFor).toBeNull();
    expect(run(...working, ev('PermissionRequest', { tool_name: 'Bash' }), ev('SessionStart', { source: 'resume' }))?.waitingFor).toBeNull();
  });

  test('compacting: PreCompact → true, PostCompact → false; state untouched', () => {
    const pre = run(...working, ev('PreCompact', { trigger: 'auto', custom_instructions: null }));
    expect(pre).toMatchObject({ compacting: true, state: 'running' });
    expect(run(...working, ev('PreCompact', { trigger: 'auto' }), ev('PostCompact', { trigger: 'auto', compact_summary: 's' }))).toMatchObject({ compacting: false, state: 'running' });
    expect(run(ev('SessionStart'), ev('Stop'), ev('PreCompact', { trigger: 'manual' }))).toMatchObject({ compacting: true, state: 'done' });
  });

  test('compacting: cleared by the next activity, by SessionStart(compact), kept across notifications and subagent events', () => {
    expect(run(...working, ev('PreCompact'), ev('PreToolUse', { tool_name: 'Read' }))?.compacting).toBe(false);
    let s = run(...working, ev('PreCompact'))!;
    s = reduceHook(s, ev('SessionStart', { source: 'compact' }), T)!;
    expect(s.compacting).toBe(false);
    expect(run(...working, ev('PreCompact'), ev('Notification', { notification_type: 'auth_success' }), ev('SubagentStop', { agent_id: 'a' }))?.compacting).toBe(true);
  });

  describe('subagents: tracked by agent_id, they outlive the main turn', () => {
    const start = (id: string) => ev('SubagentStart', { agent_id: id, agent_type: 'Explore' });
    const stop = (id: string) => ev('SubagentStop', { agent_id: id, agent_type: 'Explore' });
    const H = 60 * 60 * 1000;
    /** Events at given times: [event, now]. */
    function at(...steps: [Record<string, unknown>, number][]): SessionInfo | null | undefined {
      let s: SessionInfo | null | undefined = null;
      for (const [e, now] of steps) { const n = reduceHook(s ?? null, e, now); if (n !== undefined) s = n; }
      return s;
    }

    test('counted by SubagentStart/Stop per id, never negative, bounded to 99', () => {
      expect(run(...working, start('a'), start('b'), start('c'))?.subagents).toBe(3);
      expect(run(...working, start('a'), start('b'), stop('a'))?.subagents).toBe(1);
      expect(run(...working, stop('a'), stop('b'))?.subagents).toBe(0);
      // The same id twice is one subagent.
      expect(run(...working, start('a'), start('a'))?.subagents).toBe(1);
      expect(run(...working, ...Array.from({ length: 150 }, (_, i) => start(`x${i}`)))?.subagents).toBe(99);
    });

    test('a SubagentStop for an id never started is ignored', () => {
      expect(run(...working, start('a'), stop('zzz'))?.subagents).toBe(1);
      expect(run(...working, start('a'), stop('a'), stop('a'))?.subagents).toBe(0);
    });

    test('the main Stop, StopFailure and UserPromptSubmit keep them (background subagents); the idle notice clears them', () => {
      expect(run(...working, start('a'), ev('Stop'))).toMatchObject({ state: 'done', subagents: 1 });
      expect(run(...working, start('a'), start('b'), ev('Stop'), ev('UserPromptSubmit', { prompt: '<task-notification>' }))?.subagents).toBe(2);
      expect(run(...working, start('a'), ev('StopFailure', { error: 'overloaded' }))?.subagents).toBe(1);
      // Claude Code sends the idle notice only with the prompt free and no background agent: a subagent still counted
      // then (a foreground one interrupted with Esc never sends its SubagentStop) is gone.
      expect(run(...working, start('a'), ev('Notification', { notification_type: 'idle_prompt' }))).toMatchObject({ state: 'idle', subagents: 0 });
      // Then its own SubagentStop ends it.
      expect(run(...working, start('a'), ev('Stop'), stop('a'))).toMatchObject({ state: 'done', subagents: 0 });
    });

    test('SessionStart (new, resumed, cleared) and SessionEnd clear them; a compaction does not', () => {
      expect(run(...working, start('a'), ev('SessionStart', { source: 'clear' }))?.subagents).toBe(0);
      expect(run(...working, start('a'), ev('Stop'), ev('SessionStart', { source: 'resume' }))?.subagents).toBe(0);
      expect(run(...working, start('a'), ev('SessionStart', { source: 'compact' }))?.subagents).toBe(1);
      expect(run(...working, start('a'), ev('SessionEnd'))).toBeNull();
      // After a new session the old ids are gone: their late stop changes nothing.
      expect(run(...working, start('a'), ev('SessionStart', { source: 'clear' }), start('b'), stop('a'))?.subagents).toBe(1);
    });

    test('without an agent_id they are counted anonymously; a stop without id ends one of them', () => {
      const anonStart = ev('SubagentStart', { agent_type: 'Explore' });
      const anonStop = ev('SubagentStop', { agent_type: 'Explore' });
      expect(run(...working, anonStart, anonStart)?.subagents).toBe(2);
      expect(run(...working, anonStart, anonStart, anonStop)?.subagents).toBe(1);
      expect(run(...working, anonStop)?.subagents).toBe(0);
      // A stop without id never ends a subagent that has one.
      expect(run(...working, start('a'), anonStop)?.subagents).toBe(1);
    });

    test('an id with no event for 2 hours is dropped; its own tool events keep it alive', () => {
      const w: [Record<string, unknown>, number][] = working.map((e) => [e, 0]);
      expect(at(...w, [start('a'), 0], [ev('Notification', { notification_type: 'auth_success' }), 2 * H + 1])?.subagents).toBe(0);
      expect(at(...w, [start('a'), 0], [ev('Notification', { notification_type: 'auth_success' }), 2 * H - 1])?.subagents).toBe(1);
      const busy = at(...w, [start('a'), 0], [start('b'), 0], [ev('PreToolUse', { agent_id: 'a', tool_name: 'Read' }), 1.5 * H], [ev('Notification', { notification_type: 'auth_success' }), 3 * H]);
      expect(busy?.subagents).toBe(1);
      // The sweep atelierd runs without any event.
      const s = at(...w, [start('a'), 0])!;
      expect(expireSubagents(s, H)).toBe(s);
      expect(expireSubagents(s, 2 * H + 1)).toMatchObject({ subagents: 0 });
    });

    test('a background subagent working after the main Stop leaves the main state alone: done, unread, no activity', () => {
      const s = run(...working, start('a'), ev('Stop'), ev('PreToolUse', { agent_id: 'a', tool_name: 'Bash', tool_input: { command: 'npm test' } }), ev('PostToolUse', { agent_id: 'a', tool_name: 'Bash' }));
      expect(s).toMatchObject({ state: 'done', unread: true, activity: null, subagents: 1 });
      expect(run(...working, start('a'), ev('Notification', { notification_type: 'idle_prompt' }), ev('PreToolUse', { agent_id: 'a', tool_name: 'Read' }))).toMatchObject({ state: 'idle' });
      // The main agent working again is working.
      expect(run(...working, start('a'), ev('Stop'), ev('UserPromptSubmit', { prompt: '<task-notification>' }), ev('PreToolUse', { agent_id: 'a', tool_name: 'Read' }))?.state).toBe('running');
    });

    test('a background subagent asking for a permission after the main Stop waits, then goes back to done', () => {
      const asked = run(...working, start('a'), ev('Stop'), ev('PermissionRequest', { agent_id: 'a', tool_name: 'Bash', tool_input: { command: 'rm x' } }));
      expect(asked).toMatchObject({ state: 'waiting', waitingFor: 'permission', activity: 'waiting: Bash rm x' });
      const after = reduceHook(asked!, ev('PostToolUse', { agent_id: 'a', tool_name: 'Bash' }), T);
      expect(after).toMatchObject({ state: 'done', waitingFor: null, activity: null, subagents: 1 });
    });

    test('a main-agent PostToolUseFailure is main activity: it ends the background rest like PostToolUse', () => {
      const s = run(...working, start('a'), ev('Stop'), ev('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'b1' }), ev('PostToolUse', { agent_id: 'a', tool_name: 'Read' }));
      expect(s).toMatchObject({ state: 'running' });
    });

    test('the tracking never leaves atelierd', () => {
      const s = run(...working, start('a'), ev('Stop'))!;
      const pub = publicSession(s);
      expect(pub.subagents).toBe(1);
      expect(Object.keys(pub)).not.toContain('agentRuns');
      expect(Object.keys(pub)).not.toContain('mainRest');
    });
  });

  test('subagent events do not change the state or a pending wait', () => {
    const s = run(...working, ev('PermissionRequest', { tool_name: 'Bash' }), ev('SubagentStop', { agent_id: 'a' }));
    expect(s).toMatchObject({ state: 'waiting', waitingFor: 'permission' });
  });

  describe('waits are tracked per agent (agent_id, or the main agent)', () => {
    const sub = (name: string, agent: string, extra: Record<string, unknown> = {}) => ev(name, { agent_id: agent, agent_type: 'Explore', ...extra });
    const states = (...events: Record<string, unknown>[]) => {
      let s: SessionInfo | null = null; const out: (string | null | undefined)[] = [];
      for (const e of events) { const n = reduceHook(s, e, T); if (n !== undefined) s = n; out.push(s?.state); }
      return { s, out };
    };

    test("a subagent's tool events never clear the main agent's permission", () => {
      const s = run(...working, ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } }),
        sub('PreToolUse', 'a', { tool_name: 'Read', tool_input: { file_path: '/p/x.ts' } }), sub('PostToolUse', 'a', { tool_name: 'Read' }));
      expect(s).toMatchObject({ state: 'waiting', waitingFor: 'permission', activity: 'waiting: Bash npm test' });
    });

    test("the main agent's tool events never clear a subagent's question; that subagent's own do", () => {
      const asked = [...working, sub('PreToolUse', 'a', { tool_name: 'AskUserQuestion' }), ev('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'x' } })];
      expect(run(...asked)).toMatchObject({ state: 'waiting', waitingFor: 'question', activity: 'waiting: question' });
      expect(run(...asked, sub('PostToolUse', 'a', { tool_name: 'AskUserQuestion' }))).toMatchObject({ state: 'running', waitingFor: null });
    });

    test('with two waits the most urgent shows; answering it shows the other', () => {
      const both = [...working, ev('PreToolUse', { tool_name: 'AskUserQuestion' }), sub('PermissionRequest', 'a', { tool_name: 'Bash', tool_input: { command: 'rm x' } })];
      expect(run(...both)).toMatchObject({ state: 'waiting', waitingFor: 'permission', activity: 'waiting: Bash rm x' });
      expect(run(...both, sub('PostToolUse', 'a', { tool_name: 'Bash' }))).toMatchObject({ state: 'waiting', waitingFor: 'question', activity: 'waiting: question' });
      expect(run(...both, sub('PostToolUse', 'a', { tool_name: 'Bash' }), ev('PostToolUse', { tool_name: 'AskUserQuestion' }))).toMatchObject({ state: 'running', waitingFor: null });
    });

    test('Stop, UserPromptSubmit and idle_prompt clear every wait (nothing left over for later)', () => {
      const waits = [...working, sub('PermissionRequest', 'a', { tool_name: 'Bash' }), ev('PreToolUse', { tool_name: 'AskUserQuestion' })];
      for (const clear of [ev('Stop'), ev('UserPromptSubmit', { prompt: 'go' }), ev('Notification', { notification_type: 'idle_prompt' })]) {
        const s = run(...waits, clear, ev('PermissionRequest', { tool_name: 'Edit' }), ev('PostToolUse', { tool_name: 'Edit' }));
        expect(s).toMatchObject({ state: 'running', waitingFor: null });
      }
    });

    test('the late permission_prompt after a subagent tool event repeats nothing: the state stays waiting throughout', () => {
      const { s, out } = states(...working, ev('PermissionRequest', { tool_name: 'Bash' }), sub('PostToolUse', 'b', { tool_name: 'Read' }), ev('Notification', { notification_type: 'permission_prompt' }));
      expect(out.slice(2)).toEqual(['waiting', 'waiting', 'waiting']);
      expect(s).toMatchObject({ waitingFor: 'permission', activity: 'waiting: Bash' });
    });
  });

  test('errorReason: the raw StopFailure code (unknown when missing), cleared when work resumes', () => {
    expect(run(...working, ev('StopFailure', { error: 'rate_limit', error_details: '429 Too Many Requests' }))).toMatchObject({ state: 'error', errorReason: 'rate_limit' });
    expect(run(...working, ev('StopFailure'))).toMatchObject({ state: 'error', errorReason: 'unknown' });
    expect(run(...working, ev('StopFailure', { error: 'overloaded' }), ev('Notification', { notification_type: 'idle_prompt' }))).toMatchObject({ state: 'error', errorReason: 'overloaded' });
    expect(run(...working, ev('StopFailure', { error: 'overloaded' }), ev('UserPromptSubmit', { prompt: 'again' }))).toMatchObject({ state: 'running', errorReason: null });
    expect(run(...working, ev('StopFailure', { error: 'x'.repeat(500) }))?.errorReason?.length).toBeLessThanOrEqual(64);
  });

  test('permissionMode: from any event, kept when absent, nonsense ignored', () => {
    expect(run(ev('SessionStart', { permission_mode: 'default' }), ev('UserPromptSubmit', { permission_mode: 'plan' }))?.permissionMode).toBe('plan');
    expect(run(ev('SessionStart', { permission_mode: 'acceptEdits' }), ev('Stop'))?.permissionMode).toBe('acceptEdits');
    expect(run(ev('SessionStart', { permission_mode: 'plan' }), ev('Stop', { permission_mode: 42 }), ev('Stop', { permission_mode: '\u001b[31mevil' }))?.permissionMode).toBe('plan');
    let s = run(ev('SessionStart', { permission_mode: 'plan' }))!;
    s = reduceHook(s, ev('SessionStart', { source: 'compact', permission_mode: 'auto' }), T)!;
    expect(s.permissionMode).toBe('auto');
  });

  test('autoTitle: the first prompt, cleaned (whitespace, control characters), never replaced by later prompts', () => {
    const s = run(ev('SessionStart'), ev('UserPromptSubmit', { prompt: '  Fix the\n\tlogin  \u001b[31mbug\u0007 please ' }), ev('Stop'), ev('UserPromptSubmit', { prompt: 'second' }));
    expect(s?.autoTitle).toBe('Fix the login [31mbug please');
  });

  test('autoTitle: cut to 60 characters with an ellipsis, on a word boundary when there is one', () => {
    const long = 'Refactor the session reducer so that every hook event maps to the new optional fields cleanly';
    const t = run(ev('UserPromptSubmit', { prompt: long }))!.autoTitle!;
    expect([...t].length).toBeLessThanOrEqual(60);
    expect(t.endsWith('…')).toBe(true);
    expect(long.startsWith(t.slice(0, -1))).toBe(true);
    expect(t.slice(0, -1).endsWith(' ')).toBe(false);
    const word = run(ev('UserPromptSubmit', { prompt: 'x'.repeat(200) }))!.autoTitle!;
    expect([...word].length).toBe(60);
    // Surrogate pairs are never split.
    const emoji = run(ev('UserPromptSubmit', { prompt: '😀'.repeat(100) }))!.autoTitle!;
    expect([...emoji].length).toBe(60);
    expect(emoji.includes('�')).toBe(false);
  });

  test('autoTitle: slash commands, injected messages (<…>) and empty prompts give none; the next real prompt does', () => {
    expect(run(ev('UserPromptSubmit', { prompt: '/compact' }))?.autoTitle).toBeNull();
    expect(run(ev('UserPromptSubmit', { prompt: '<task-notification>done</task-notification>' }))?.autoTitle).toBeNull();
    expect(run(ev('UserPromptSubmit', { prompt: '   \n ' }))?.autoTitle).toBeNull();
    expect(run(ev('UserPromptSubmit', { prompt: 42 }))?.autoTitle).toBeNull();
    expect(run(ev('UserPromptSubmit', { prompt: '/clear' }), ev('UserPromptSubmit', { prompt: 'Add dark mode' }))?.autoTitle).toBe('Add dark mode');
  });

  test('autoTitle: secrets pasted in the first prompt never become the title (token-like runs → …)', () => {
    const title = (p: string) => run(ev('UserPromptSubmit', { prompt: p }))?.autoTitle;
    const hex = 'a3f9c0e1b2d4f6a8c0e2b4d6f8a0c2e4f6a8';
    const b64 = 'Qm9keVRleHQxMjM0NTY3ODkwYWJjZGVmZ2hpamtsbW5vcA==';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const cases: [string, string][] = [
      ['use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv to call', 'use … to call'],
      ['key sk-proj-1234567890abcdefghij please', 'key … please'],
      ['token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 ok', 'token … ok'],
      ['pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop ok', 'pat … ok'],
      ['aws AKIAIOSFODNN7EXAMPLE ok', 'aws … ok'],
      ['slack xoxb-1234567890-abcdefghij ok', 'slack … ok'],
      ['stripe sk_live_0123456789abcdefghij ok', 'stripe … ok'],
      ['stripe rk_test_51Hx0000abcdefgh ok', 'stripe … ok'],
      [`hash ${hex} ok`, 'hash … ok'],
      [`blob ${b64} ok`, 'blob … ok'],
      [`jwt ${jwt} ok`, 'jwt … ok']
    ];
    for (const [prompt, want] of cases) expect(title(prompt)).toBe(want);
    // Ordinary words, paths and short ids stay.
    expect(title('Fix src/renderer/terminal/trigger-engine.ts at e56f269')).toBe('Fix src/renderer/terminal/trigger-engine.ts at e56f269');
    expect(title('Read /Users/me/projects/app/NOTES.md')).toBe('Read /Users/me/projects/app/NOTES.md');
    expect(title('Rename skeleton-loader to task-skimmer')).toBe('Rename skeleton-loader to task-skimmer');
  });

  test('autoTitle: kept across a compaction and a SessionStart of the same session, reset for a new session', () => {
    const first = run(ev('SessionStart'), ev('UserPromptSubmit', { prompt: 'Add dark mode' }))!;
    expect(reduceHook(first, ev('SessionStart', { source: 'compact' }), T)?.autoTitle).toBe('Add dark mode');
    expect(reduceHook(first, ev('SessionStart', { source: 'resume' }), T)?.autoTitle).toBe('Add dark mode');
    expect(reduceHook(first, { ...ev('SessionStart', { source: 'clear' }), session_id: 's2' }, T)?.autoTitle).toBeNull();
  });

  test('autoTitle never replaces the title Claude Code gives (title stays separate)', () => {
    const s = run(ev('SessionStart', { session_title: 'Named' }), ev('UserPromptSubmit', { prompt: 'Add dark mode' }));
    expect(s).toMatchObject({ title: 'Named', autoTitle: 'Add dark mode' });
  });

  test('unknown events and unknown fields are ignored, never fatal', () => {
    const s = run(...working)!;
    expect(reduceHook(s, ev('PostModelSwitch', { model: 'x' }), T)).toBeUndefined();
    expect(reduceHook(s, ev('Notification', { notification_type: 'brand_new_type', brand_new: { x: 1 } }), T)).toMatchObject({ state: 'running', waitingFor: null });
    expect(reduceHook(s, ev('SubagentStart', { agent_id: { weird: true }, agent_type: 7 }), T)?.subagents).toBe(1);
    expect(reduceHook(s, ev('PreCompact', { trigger: ['?'] }), T)?.compacting).toBe(true);
  });
});

// Claude Code's own signals end a usage-limit pause.
describe('reduceHook: the usage-limit pause ends', () => {
  const SINCE = 400;
  const RESET = 900_000;
  const limited = () => run(ev('SessionStart'), ev('UserPromptSubmit', { prompt: 'go' }), ev('StopFailure', { error: 'rate_limit' }))!;
  /** A usage-limit error with its pause (atelierd arms it after the reducer), already seen. */
  const paused = (prev: SessionInfo, over?: LimitPauseEnd): SessionInfo =>
    ({ ...prev, state: 'error', errorReason: 'rate_limit', unread: false, limitPause: { since: SINCE, resetsAt: RESET, ...(over ? { over } : {}) } });
  const notify = (s: SessionInfo, type: string) => reduceHook(s, ev('Notification', { notification_type: type }), T)!;

  test('quota_auto_resume_fired: the task continues (running, no error, no pause key); unread stays as it was', () => {
    const s = notify({ ...paused(limited()), mainRest: 'done', agentWaits: { main: { kind: 'permission', activity: 'waiting: x' } } }, 'quota_auto_resume_fired');
    expect(s).toMatchObject({ state: 'running', errorReason: null, waitingFor: null, activity: null, unread: false, mainRest: null, agentWaits: {} });
    expect('limitPause' in s).toBe(false);
    expect(notify({ ...paused(limited()), unread: true }, 'quota_auto_resume_fired').unread).toBe(true);
    // Even when atelierd never armed a pause.
    const bare = notify(limited(), 'quota_auto_resume_fired');
    expect(bare).toMatchObject({ state: 'running', errorReason: null, waitingFor: null, activity: null, unread: true });
    expect('limitPause' in bare).toBe(false);
  });

  test('quota_auto_resume_fired acts only on an error: a late or repeated one changes nothing', () => {
    const done = run(ev('SessionStart'), ev('UserPromptSubmit', { prompt: 'go' }), ev('Stop'))!;
    const idle = reduceHook(done, ev('Notification', { notification_type: 'idle_prompt' }), T)!;
    const running = run(ev('SessionStart'), ev('UserPromptSubmit', { prompt: 'go' }), ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }))!;
    for (const s of [done, idle, running]) {
      const out = notify(s, 'quota_auto_resume_fired');
      expect(out, s.state).toMatchObject({ state: s.state, activity: s.activity, waitingFor: s.waitingFor, mainRest: s.mainRest, unread: s.unread });
    }
  });

  test('quota_auto_resume_stale: the wait ended and Claude Code waits for Enter (since/resetsAt kept, unread again)', () => {
    const s = notify(paused(limited()), 'quota_auto_resume_stale');
    expect(s).toMatchObject({ state: 'error', errorReason: 'rate_limit', unread: true });
    expect(s.limitPause).toEqual({ since: SINCE, resetsAt: RESET, over: 'stale' });
    // A rate_limit error atelierd never paused: Claude Code's wait is over all the same.
    const bare = notify({ ...limited(), unread: false }, 'quota_auto_resume_stale');
    expect(bare.unread).toBe(true);
    expect(bare.limitPause).toEqual({ since: T, resetsAt: null, over: 'stale' });
    // Asleep across the reset: the sweep expired it first, Claude Code's word still wins the wording.
    expect(notify(paused(limited(), 'expired'), 'quota_auto_resume_stale').limitPause).toEqual({ since: SINCE, resetsAt: RESET, over: 'stale' });
    // Another error, or no error: no pause to end.
    expect('limitPause' in notify(run(ev('SessionStart'), ev('UserPromptSubmit'), ev('StopFailure', { error: 'overloaded' }))!, 'quota_auto_resume_stale')).toBe(false);
    expect('limitPause' in notify(run(ev('SessionStart'), ev('UserPromptSubmit'))!, 'quota_auto_resume_stale')).toBe(false);
  });

  test('quota_auto_resume_disabled: auto-continue is off, so a pause in progress ends; anything else stays', () => {
    const s = notify(paused(limited()), 'quota_auto_resume_disabled');
    expect(s).toMatchObject({ state: 'error', errorReason: 'rate_limit', unread: true });
    expect(s.limitPause).toEqual({ since: SINCE, resetsAt: RESET, over: 'disabled' });
    expect(notify(paused(limited(), 'stale'), 'quota_auto_resume_disabled').limitPause).toEqual({ since: SINCE, resetsAt: RESET, over: 'stale' });
    expect('limitPause' in notify(limited(), 'quota_auto_resume_disabled')).toBe(false);
  });

  test('idle_prompt during a pause: the wait was cancelled (Esc), then the prompt is free as always', () => {
    const s = notify(paused(limited()), 'idle_prompt');
    expect(s).toMatchObject({ state: 'error', errorReason: 'rate_limit', waitingFor: 'input', unread: true });
    expect(s.limitPause).toEqual({ since: SINCE, resetsAt: RESET, over: 'cancelled' });
    // Still checking (no reset yet): cancelled too.
    const checking = { ...paused(limited()), limitPause: { since: SINCE, resetsAt: null } };
    expect(notify(checking, 'idle_prompt').limitPause).toEqual({ since: SINCE, resetsAt: null, over: 'cancelled' });
    // An ended pause keeps its reason: after the stale, the idle notice is only the prompt waiting for Enter.
    expect(notify(paused(limited(), 'stale'), 'idle_prompt').limitPause).toEqual({ since: SINCE, resetsAt: RESET, over: 'stale' });
  });

  test('anything that leaves the error drops the pause, key and all', () => {
    const leaving = [
      ev('UserPromptSubmit', { prompt: 'go on' }), ev('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/p/a.ts' } }),
      ev('Stop'), ev('SessionStart', { source: 'resume' }), ev('SessionStart', { source: 'startup' })
    ];
    for (const over of [undefined, 'stale'] as const) {
      for (const e of leaving) expect('limitPause' in reduceHook(paused(limited(), over), e, T)!, `${String(e.hook_event_name)} ${over}`).toBe(false);
    }
    // Only a rate-limit error holds one: a stray pause on any other error goes at the next event.
    const stray = { ...paused(limited()), errorReason: 'overloaded' };
    expect('limitPause' in notify(stray, 'auth_success')).toBe(false);
  });

  test('a new rate_limit stop is a new episode: an ended pause is dropped (atelierd decides afresh)', () => {
    for (const over of ['stale', 'expired', 'unconfirmed', 'disabled', 'cancelled'] as const) {
      const s = reduceHook(paused(limited(), over), ev('StopFailure', { error: 'rate_limit' }), T)!;
      expect(s).toMatchObject({ state: 'error', errorReason: 'rate_limit' });
      expect('limitPause' in s, over).toBe(false);
    }
  });

  test('a session that never paused never carries the key, through whole turns and their errors', () => {
    const events: Record<string, unknown>[] = [
      ev('SessionStart'), ev('UserPromptSubmit', { prompt: 'go' }), ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }),
      ev('PermissionRequest', { tool_name: 'Bash' }), ev('Notification', { notification_type: 'permission_prompt' }), ev('PostToolUse', { tool_name: 'Bash' }),
      ev('Stop'), ev('Notification', { notification_type: 'idle_prompt' }), ev('UserPromptSubmit', { prompt: 'more' }),
      ev('StopFailure', { error: 'overloaded' }), ev('Notification', { notification_type: 'quota_auto_resume_stale' }),
      ev('UserPromptSubmit', { prompt: 'again' }), ev('StopFailure', { error: 'rate_limit' }), ev('Notification', { notification_type: 'quota_auto_resume_disabled' }),
      ev('Notification', { notification_type: 'idle_prompt' }), ev('Notification', { notification_type: 'quota_auto_resume_fired' }), ev('Stop')
    ];
    let s: SessionInfo | null = null;
    for (const e of events) {
      s = reduceHook(s, e, T)!;
      expect('limitPause' in s, `${String(e.hook_event_name)} ${String(e.notification_type ?? '')}`).toBe(false);
    }
  });
});

// The session's background work, from Claude Code's own payloads.
describe('background work', () => {
  const fixture = (name: string) =>
    readFileSync(resolve(__dirname, '../../tests/fixtures/hooks', name), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  /** The session after each payload, the n-th payload at time n seconds. */
  function replay(events: Record<string, unknown>[]): (SessionInfo | null)[] {
    let s: SessionInfo | null = null;
    return events.map((e, i) => { const n = reduceHook(s, e, (i + 1) * 1000); if (n !== undefined) s = n; return s; });
  }
  const ids = (s: SessionInfo | null, kind: string) => (s?.background?.items ?? []).filter((i) => i.kind === kind).map((i) => i.id);
  const at = (s: SessionInfo | null, id: string) => s?.background?.items.find((i) => i.id === id);
  const working = [ev('SessionStart'), ev('UserPromptSubmit', { prompt: 'go' })];
  const task = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'shell', status: 'running', description: `task ${id}`, command: `sleep ${id}`, ...extra });
  const stop = (tasks: unknown[], extra: Record<string, unknown> = {}) => ev('Stop', { background_tasks: tasks, session_crons: [], ...extra });
  const bash = (taskId: string, extra: Record<string, unknown> = {}) =>
    ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: `sleep ${taskId}`, description: `Run ${taskId}`, run_in_background: true }, tool_response: { backgroundTaskId: taskId }, ...extra });

  test('fixture: a subagent waiting on its own shell stays counted until its final stop; the main Stop never drops it', () => {
    const steps = replay(fixture('background-subagent.jsonl'));
    const A = 'b4ncs800q'; const K = 'br8l2apqj'; const B = 'bg6ex3j6w'; const sub = 'a1xxxx';
    // [agents, shells, subagents] after each payload, in the order Claude Code sent them.
    const want: [string[], string[], number][] = [
      [[], [], 0], [[], [], 0], [[], [], 0], [[], [], 0],
      [[], [K], 0], // PostToolUse Bash K (backgroundTaskId)
      [[], [K, A], 0],
      [[], [K, A], 0],
      [[sub], [K, A], 1], // SubagentStart
      [[sub], [K, A], 1], [[sub], [K, A], 1], [[sub], [K, A], 1],
      [[sub], [K, A, B], 1], // the subagent's own background Bash
      [[sub], [A, B], 1], // TaskStop K
      [[sub], [A, B], 1], // SubagentStop while its shell B runs: it stays
      [[sub], [A, B], 1], // main Stop omits the subagent: still counted
      [[sub], [A, B], 1], // <task-notification> "completed" for the subagent: misleading, still counted
      [[sub], [A, B], 1],
      [[sub], [B], 1], // <task-notification> for A
      [[sub], [B], 1],
      [[sub], [B], 1], // wake-up SubagentStart (same id)
      [[], [], 0], // final SubagentStop: B is gone from the snapshot, the subagent leaves
      [[], [], 0], [[], [], 0]
    ];
    want.forEach(([agents, shells, n], i) => {
      expect([ids(steps[i]!, 'agent'), ids(steps[i]!, 'shell'), steps[i]!.subagents], `after payload ${i + 1}`).toEqual([agents, shells, n]);
    });
    expect(steps.at(-1)).toBeNull();
    // Labels, commands and first-seen times.
    // The agent's label: its type at SubagentStart, then the description the main agent's Agent call gave it, for life.
    expect(at(steps[7]!, sub)?.label).toBe('general-purpose');
    expect(at(steps[8]!, sub)?.label).toBe('Background shell B');
    // Kept by its own shell B after its SubagentStop: waiting, with the time of that last event.
    expect(at(steps[12]!, sub)).toEqual({ id: sub, kind: 'agent', label: 'Background shell B', since: 8000, lastEvent: 12000 });
    expect(at(steps[13]!, sub)).toEqual({ id: sub, kind: 'agent', label: 'Background shell B', since: 8000, lastEvent: 14000, waiting: true });
    expect(at(steps[18]!, sub)).toMatchObject({ lastEvent: 14000, waiting: true });
    expect(at(steps[19]!, sub)?.label).toBe('Background shell B'); // the wake-up SubagentStart keeps it
    expect(at(steps[19]!, sub)).toEqual({ id: sub, kind: 'agent', label: 'Background shell B', since: 8000, lastEvent: 20000 }); // and is no longer waiting
    // The owner: the agent that launched it (none for the main agent).
    expect(at(steps[13]!, A)).toEqual({ id: A, kind: 'shell', label: 'Background sleep A', command: 'sleep 20; echo shell-A-done', since: 6000 });
    expect(at(steps[13]!, B)).toEqual({ id: B, kind: 'shell', label: 'sleep 30; echo shell-B-done', command: 'sleep 30; echo shell-B-done', since: 12000, owner: sub });
    expect(at(steps[18]!, B)?.owner).toBe(sub);
    expect(steps[14]).toMatchObject({ state: 'done', background: { crons: [] } });
    expect(steps[11]!.bgOwners).toMatchObject({ [B]: 'agent:a1xxxx', [A]: 'main' });
  });

  test('fixture: the idle notice keeps a subagent waiting on its own shell (label, since, waiting) and clears the rest', () => {
    const events = fixture('background-subagent.jsonl');
    const idle = { hook_event_name: 'Notification', session_id: 's-1', cwd: '/tmp/x', notification_type: 'idle_prompt' };
    // After payload 19 (the main Stop that lists only the subagent's shell B), Claude Code says the prompt is free.
    const steps = replay([...events.slice(0, 19), idle, ...events.slice(19)]);
    const B = 'bg6ex3j6w'; const sub = 'a1xxxx';
    expect(steps[19]).toMatchObject({ subagents: 1, state: 'done', waitingFor: 'input' });
    expect(at(steps[19]!, sub)).toEqual({ id: sub, kind: 'agent', label: 'Background shell B', since: 8000, lastEvent: 14000, waiting: true });
    expect(at(steps[19]!, B)?.owner).toBe(sub);
    // Its wake-up and final stop end it as without the notice.
    expect(at(steps[20]!, sub)).toEqual({ id: sub, kind: 'agent', label: 'Background shell B', since: 8000, lastEvent: 21000 });
    expect(steps[21]).toMatchObject({ subagents: 0 });
  });

  test('fixture: a Monitor stays a monitor when the snapshot calls it a shell; crons come from session_crons', () => {
    const steps = replay(fixture('background-monitor-cron.jsonl'));
    const shell = 'brf4296uk'; const mon = 'b0ggs7rf2';
    expect(steps[5]!.background!.items).toEqual([
      { id: shell, kind: 'shell', label: 'Run background sleep test', command: 'sleep 25; echo shell-M-done', since: 4000 },
      // Monitor's tool_response.persistent is kept, across the snapshots that call it a shell.
      { id: mon, kind: 'monitor', label: 'background sleep command finishing', command: 'until grep -q shell-M-done /tmp/x/out.txt; do sleep 1; done; echo shell-M-done', since: 6000, persistent: false }
    ]);
    const cron = { id: '1ce2a8c4', schedule: '10 12 11 10 *', recurring: false, label: 'say: cron fired' };
    expect(steps[10]!.background).toEqual({ items: steps[5]!.background!.items, crons: [cron] });
    expect(ids(steps[11]!, 'monitor')).toEqual([mon]);
    expect(ids(steps[11]!, 'shell')).toEqual([]);
    expect(steps[12]!.background).toEqual({ items: [], crons: [cron] });
    expect(steps[14]!.background).toEqual({ items: [], crons: [cron] });
  });

  test('fixture: a self-paced /loop (ScheduleWakeup) is a dateless one-shot cron, a new one each turn, none once it stops', () => {
    const steps = replay(fixture('loop-wakeup.jsonl'));
    const label = '/loop check whether a file named done.txt exists in this…';
    expect(steps[6]!.background!.crons).toEqual([{ id: '3f193c39', schedule: '28 10 * * *', recurring: false, label }]);
    expect(steps[13]!.background!.crons).toEqual([{ id: '4fd7c746', schedule: '32 10 * * *', recurring: false, label }]);
    expect(steps[25]!.background!.crons).toEqual([]);
  });

  test('snapshot: unknown statuses count, finished ones never do', () => {
    expect(ids(run(...working, stop([task('t1', { status: 'paused_for_reasons' }), task('t2', { status: undefined })]))!, 'shell')).toEqual(['t1', 't2']);
    for (const status of ['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error', 'done', 'FAILED']) {
      expect(run(...working, bash('t1'), stop([task('t1', { status })]))?.background?.items, status).toEqual([]);
    }
  });

  test('snapshot: kinds (shell, monitor, subagent, anything else) and garbage entries', () => {
    const s = run(...working, stop([task('s1'), task('m1', { type: 'monitor' }), task('w1', { type: 'workflow' }), { id: 'z9', type: 'subagent', status: 'running', agent_type: 'Explore' }, null, 7, { type: 'shell' }, { id: 42 }]))!;
    expect(s.background!.items.map((i) => [i.id, i.kind])).toEqual([['z9', 'agent'], ['s1', 'shell'], ['m1', 'monitor'], ['w1', 'other']]);
  });

  test('snapshot: a subagent unknown to the count is added (a lost SubagentStart); in SubagentStop the stopping one is skipped', () => {
    const lost = run(...working, stop([{ id: 'z9', type: 'subagent', status: 'running', description: 'Look around', agent_type: 'Explore' }]))!;
    expect(lost.subagents).toBe(1);
    expect(at(lost, 'z9')).toMatchObject({ kind: 'agent', label: 'Look around' });
    const self = ev('SubagentStop', { agent_id: 'b', background_tasks: [{ id: 'b', type: 'subagent', status: 'running' }] });
    expect(run(...working, ev('SubagentStart', { agent_id: 'b' }), self)).toMatchObject({ subagents: 0, background: { items: [] } });
  });

  test('a subagent stays while it owns an item of the new snapshot; an item of another agent does not keep it', () => {
    const start = ev('SubagentStart', { agent_id: 'b', agent_type: 'Explore' });
    const own = bash('t1', { agent_id: 'b' });
    const subStop = (tasks: unknown[]) => ev('SubagentStop', { agent_id: 'b', background_tasks: tasks });
    expect(run(...working, start, own, subStop([task('t1')]))?.subagents).toBe(1);
    expect(run(...working, start, own, subStop([]))?.subagents).toBe(0);
    expect(run(...working, start, bash('t2'), subStop([task('t2')]))?.subagents).toBe(0);
    // Without a snapshot (older Claude Code) a SubagentStop ends it as before.
    expect(run(...working, start, own, ev('SubagentStop', { agent_id: 'b' }))?.subagents).toBe(0);
  });

  // An agent run no hook will ever end (a foreground subagent interrupted with Esc) must not keep a
  // session working for 2 hours.
  test('the main Stop with a snapshot drops the subagents it neither lists nor sees owning a listed item', () => {
    const start = (id: string) => ev('SubagentStart', { agent_id: id, agent_type: 'Explore' });
    // Interrupted foreground subagent: no SubagentStop, then a new turn ends with nothing running.
    expect(run(...working, start('fg'), ev('UserPromptSubmit', { prompt: 'next' }), stop([]))).toMatchObject({ subagents: 0, background: { items: [] } });
    // Listed as a running subagent: kept.
    expect(ids(run(...working, start('bg'), stop([{ id: 'bg', type: 'subagent', status: 'running' }]))!, 'agent')).toEqual(['bg']);
    // Waiting on its own shell (the main Stop omits it, lists the shell): kept; its shell no longer listed: dropped.
    const own = [...working, start('w'), bash('t1', { agent_id: 'w' }), ev('SubagentStop', { agent_id: 'w', background_tasks: [task('t1'), { id: 'w', type: 'subagent', status: 'running' }] })];
    expect(ids(run(...own, stop([task('t1')]))!, 'agent')).toEqual(['w']);
    expect(run(...own, stop([]))).toMatchObject({ subagents: 0 });
    // An item of another agent keeps nobody else.
    expect(run(...working, start('x'), bash('t2'), stop([task('t2')]))?.subagents).toBe(0);
    // A Stop without background_tasks (older Claude Code) and a SubagentStop's snapshot drop nobody.
    expect(run(...working, start('fg'), ev('Stop'))?.subagents).toBe(1);
    expect(run(...working, start('fg'), start('b'), ev('SubagentStop', { agent_id: 'b', background_tasks: [] }))?.subagents).toBe(1);
  });

  test('the idle notice clears the subagents, never the shells, monitors or crons', () => {
    const done = [...working, ev('SubagentStart', { agent_id: 'a' }), bash('t1'), stop([task('t1'), { id: 'a', type: 'subagent', status: 'running' }], { session_crons: [{ id: 'c1', schedule: '* * * * *', recurring: true, prompt: 'p' }] })];
    expect(run(...done)?.subagents).toBe(1);
    const s = run(...done, ev('Notification', { notification_type: 'idle_prompt' }))!;
    expect(s).toMatchObject({ subagents: 0, state: 'done' });
    expect(s.background!.items.map((i) => [i.id, i.kind])).toEqual([['t1', 'shell']]);
    expect(s.background!.crons).toHaveLength(1);
  });

  test('items say who owns them, agent items whether they are kept only by their own work and when they last spoke', () => {
    const H = 60 * 60 * 1000;
    let s = reduceHook(null, ev('SessionStart'), 0)!;
    s = reduceHook(s, ev('UserPromptSubmit', { prompt: 'go' }), 0)!;
    s = reduceHook(s, ev('SubagentStart', { agent_id: 'b', agent_type: 'Explore' }), 1000)!;
    expect(at(s, 'b')).toEqual({ id: 'b', kind: 'agent', label: 'Explore', since: 1000, lastEvent: 1000 });
    s = reduceHook(s, bash('t1', { agent_id: 'b' }), 2000)!;
    s = reduceHook(s, bash('t2'), 2500)!;
    expect([at(s, 't1')?.owner, 'owner' in at(s, 't2')!, at(s, 'b')?.lastEvent]).toEqual(['b', false, 2000]);
    // Its SubagentStop while t1 runs: kept, waiting.
    s = reduceHook(s, ev('SubagentStop', { agent_id: 'b', background_tasks: [task('t1'), task('t2'), { id: 'b', type: 'subagent', status: 'running' }] }), 3000)!;
    expect(at(s, 'b')).toMatchObject({ waiting: true, lastEvent: 3000 });
    // Other events leave it waiting; its own next event (the wake-up) ends that.
    s = reduceHook(s, stop([task('t1'), task('t2')]), 4000)!;
    expect(at(s, 'b')).toMatchObject({ waiting: true, lastEvent: 3000 });
    s = reduceHook(s, ev('SubagentStart', { agent_id: 'b', agent_type: 'Explore' }), 5000)!;
    expect(at(s, 'b')).toEqual({ id: 'b', kind: 'agent', label: 'Explore', since: 1000, lastEvent: 5000 });
    // The public session carries them; the internal bookkeeping stays inside.
    s = reduceHook(s, ev('SubagentStop', { agent_id: 'b', background_tasks: [task('t1'), { id: 'b', type: 'subagent', status: 'running' }] }), 6000)!;
    const pub = publicSession(s);
    expect(pub.background!.items.find((i) => i.id === 'b')).toMatchObject({ waiting: true, lastEvent: 6000 });
    expect(pub.background!.items.find((i) => i.id === 't1')).toMatchObject({ owner: 'b' });
    expect(Object.keys(pub).filter((k) => k.startsWith('agent'))).toEqual([]);
    // Gone with the run: at the 2-hour expiry the agent item and its waiting mark leave.
    expect(ids(expireSubagents(s, 6000 + 2 * H + 1), 'agent')).toEqual([]);
  });

  test('a Monitor records whether it is persistent; kept across snapshots, absent when not said', () => {
    const monitor = (id: string, persistent?: unknown) => ev('PostToolUse', { tool_name: 'Monitor', tool_input: { description: `watch ${id}`, command: `tail -f ${id}` }, tool_response: { taskId: id, timeoutMs: 0, ...(persistent === undefined ? {} : { persistent }) } });
    const s = run(...working, monitor('m1', true), monitor('m2'), monitor('m3', 'yes'), stop([task('m1'), task('m2'), task('m3')]))!;
    expect(at(s, 'm1')).toMatchObject({ kind: 'monitor', persistent: true });
    expect('persistent' in at(s, 'm2')!).toBe(false);
    expect('persistent' in at(s, 'm3')!).toBe(false);
  });

  test('a snapshot without background_tasks (older Claude Code) changes nothing', () => {
    const s = run(...working, bash('t1'), ev('Stop'))!;
    expect(ids(s, 'shell')).toEqual(['t1']);
    expect(run(...working, bash('t1'), ev('Stop', { background_tasks: 'nope', session_crons: { x: 1 } }))?.background).toEqual({ items: s.background!.items, crons: [] });
  });

  test('incremental: TaskStop, KillShell and KillBash remove the task they name', () => {
    expect(run(...working, bash('t1'), bash('t2'), ev('PostToolUse', { tool_name: 'TaskStop', tool_input: { task_id: 't1' } }))?.background?.items.map((i) => i.id)).toEqual(['t2']);
    expect(run(...working, bash('t1'), ev('PostToolUse', { tool_name: 'KillShell', tool_input: { shell_id: 't1' } }))?.background?.items).toEqual([]);
    expect(run(...working, bash('t1'), ev('PostToolUse', { tool_name: 'KillBash', tool_input: { shell_id: 't1' } }))?.background?.items).toEqual([]);
    // Stopping a running subagent ends it, and its agent item with it.
    const stopped = run(...working, ev('SubagentStart', { agent_id: 'a1' }), ev('SubagentStart', { agent_id: 'a2' }), ev('PostToolUse', { tool_name: 'TaskStop', tool_input: { task_id: 'a1' } }))!;
    expect(stopped.subagents).toBe(1);
    expect(ids(stopped, 'agent')).toEqual(['a2']);
    // The PreToolUse is only an intention.
    expect(ids(run(...working, bash('t1'), ev('PreToolUse', { tool_name: 'TaskStop', tool_input: { task_id: 't1' } }))!, 'shell')).toEqual(['t1']);
  });

  test('incremental: a <task-notification> removes the task it names, never a subagent', () => {
    const note = (id: string) => ev('UserPromptSubmit', { prompt: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>` });
    expect(run(...working, bash('t1'), bash('t2'), note('t2'))?.background?.items.map((i) => i.id)).toEqual(['t1']);
    expect(run(...working, ev('SubagentStart', { agent_id: 'b' }), note('b'))).toMatchObject({ subagents: 1 });
    expect(ids(run(...working, bash('t1'), ev('UserPromptSubmit', { prompt: 'about <task-id>t1</task-id>' }))!, 'shell')).toEqual(['t1']);
  });

  test('reset: SessionStart clears items and crons, a compaction keeps them; SessionEnd ends the session', () => {
    const busy = [...working, bash('t1'), stop([task('t1')], { session_crons: [{ id: 'c1', schedule: '* * * * *', recurring: true, prompt: 'p' }] })];
    expect(run(...busy)?.background?.crons).toHaveLength(1);
    expect(run(...busy, ev('SessionStart', { source: 'resume' }))).toMatchObject({ background: { items: [], crons: [] }, bgOwners: {} });
    expect(run(...busy, ev('SessionStart', { source: 'compact' }))?.background).toEqual(run(...busy)?.background);
    expect(run(...busy, ev('SessionEnd'))).toBeNull();
  });

  test('caps: 32 items (newest kept), 8 crons', () => {
    const many = Array.from({ length: 33 }, (_, i) => task(`t${i}`));
    expect(run(...working, stop(many))?.background?.items.map((i) => i.id)).toEqual(many.slice(1).map((t) => t.id));
    const added = run(...working, ...many.map((t) => bash(t.id)))!;
    expect(added.background!.items.map((i) => i.id)).toEqual(many.slice(1).map((t) => t.id));
    expect(Object.keys(added.bgOwners!)).toHaveLength(32);
    const crons = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, schedule: '0 9 * * 1', recurring: true, prompt: 'p' }));
    expect(run(...working, stop([], { session_crons: crons }))?.background?.crons).toHaveLength(8);
  });

  test('labels: one line, secrets redacted, at most 80 characters; commands at most 2048, ids at most 64; cron labels at most 60', () => {
    const s = run(...working, stop([task('t1', { description: 'deploy with\n token sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv now' }), task('t2', { description: 'x'.repeat(300), command: 'y'.repeat(5000) }), task('i'.repeat(100))],
      { session_crons: [{ id: 'c1', schedule: '0 9 * * 1', recurring: true, prompt: `check ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 and ${'z'.repeat(200)}` }] }))!;
    expect(at(s, 't1')?.label).toBe('deploy with token … now');
    expect([...at(s, 't2')!.label].length).toBeLessThanOrEqual(80);
    expect(at(s, 't2')!.command).toHaveLength(2048);
    expect(s.background!.items[2]!.id).toHaveLength(64);
    const cron = s.background!.crons[0]!;
    expect([...cron.label].length).toBeLessThanOrEqual(60);
    expect(cron.label.startsWith('check … and')).toBe(true);
    // No description: the command is the label.
    expect(at(run(...working, stop([task('t3', { description: undefined, command: 'npm run e2e' })]))!, 't3')?.label).toBe('npm run e2e');
  });

  test('agent items mirror the running subagents, and leave with them (stop or 2-hour expiry)', () => {
    const s = run(...working, ev('SubagentStart', { agent_id: 'a', agent_type: 'Explore' }), ev('SubagentStart', {}))!;
    expect(s.background!.items.map((i) => [i.id, i.label])).toEqual([['a', 'Explore'], ['anon:1', 'agent']]);
    // A description (Agent call or snapshot) wins over the type, cleaned like every label; it never leaves atelierd.
    const agentCall = (agentId: string, description: string) =>
      ev('PostToolUse', { tool_name: 'Agent', tool_input: { description, subagent_type: 'Explore', prompt: 'p' }, tool_response: { isAsync: true, status: 'async_launched', agentId } });
    const described = run(...working, ev('SubagentStart', { agent_id: 'a', agent_type: 'Explore' }), agentCall('a', 'Map the\nrouter sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv'), stop([{ id: 'a', type: 'subagent', status: 'running' }]))!;
    expect(at(described, 'a')?.label).toBe('Map the router …');
    expect(Object.keys(publicSession(described))).not.toContain('agentDescriptions');
    const snap = run(...working, ev('SubagentStart', { agent_id: 'a', agent_type: 'Explore' }), stop([{ id: 'a', type: 'subagent', status: 'running', description: 'Read the docs', agent_type: 'Explore' }]), ev('SubagentStart', { agent_id: 'a', agent_type: 'Explore' }))!;
    expect(at(snap, 'a')?.label).toBe('Read the docs');
    // An Agent call for a subagent not running (a foreground one, already over) adds nothing.
    expect(run(...working, agentCall('zz', 'Done already'))).toMatchObject({ subagents: 0, background: { items: [] } });
    // A new subagent with a reused key starts without the old description.
    expect(at(run(...working, ev('SubagentStart', { agent_id: 'a' }), agentCall('a', 'First'), ev('SubagentStop', { agent_id: 'a' }), ev('SubagentStart', { agent_id: 'a', agent_type: 'Plan' }))!, 'a')?.label).toBe('Plan');
    expect(ids(run(...working, ev('SubagentStart', { agent_id: 'a' }), ev('SubagentStop', { agent_id: 'a' }))!, 'agent')).toEqual([]);
    expect(ids(expireSubagents(s, T + 3 * 60 * 60 * 1000), 'agent')).toEqual([]);
  });

  test('the bookkeeping never leaves atelierd: publicSession strips the owners and the confirmation times', () => {
    const s = run(...working, bash('t1'), stop([task('t1')]))!;
    expect(s.bgOwners).toEqual({ t1: 'main' });
    const pub = publicSession(s);
    expect(pub.background?.items.map((i) => i.id)).toEqual(['t1']);
    expect(Object.keys(pub)).not.toContain('bgOwners');
    expect(Object.keys(pub)).not.toContain('bgSeen');
  });

  test('hygiene: an item no snapshot or event confirmed for 24 hours is dropped; the same object otherwise', () => {
    const H = 60 * 60 * 1000;
    let s = reduceHook(null, ev('SessionStart'), 0)!;
    s = reduceHook(s, bash('t1'), 0)!;
    // A snapshot listing it confirms it (its `since` stays).
    s = reduceHook(s, stop([task('t1')]), 20 * H)!;
    expect(at(s, 't1')?.since).toBe(0);
    expect(expireBackground(s, 30 * H)).toBe(s);
    expect(expireBackground(s, 20 * H + BACKGROUND_HYGIENE_MS + 1).background!.items).toEqual([]);
    // The reducer applies it too, on any event.
    expect(reduceHook(s, ev('Notification', { notification_type: 'auth_success' }), 20 * H + BACKGROUND_HYGIENE_MS + 1)?.background?.items).toEqual([]);
    // Older items expire alone; the owners follow.
    const old = reduceHook(reduceHook(reduceHook(null, ev('SessionStart'), 0)!, bash('t1'), 0)!, bash('t2'), 10 * H)!;
    const swept = expireBackground(old, BACKGROUND_HYGIENE_MS + 1);
    expect(swept.background!.items.map((i) => i.id)).toEqual(['t2']);
    expect(swept.bgOwners).toEqual({ t2: 'main' });
    // Agent items follow the subagents' own expiry, not this one.
    const agent = reduceHook(reduceHook(null, ev('SessionStart'), 0)!, ev('SubagentStart', { agent_id: 'a' }), 0)!;
    expect(expireBackground(agent, BACKGROUND_HYGIENE_MS + 1)).toBe(agent);
  });
});

describe('describeTool', () => {
  test.each([
    ['Edit', { file_path: '/a/b/App.tsx' }, 'edit App.tsx'],
    ['MultiEdit', { file_path: '/a/x.ts' }, 'edit x.ts'],
    ['Write', { file_path: '/a/new.ts' }, 'write new.ts'],
    ['NotebookEdit', { notebook_path: '/a/n.ipynb' }, 'edit n.ipynb'],
    ['Read', { file_path: '/a/r.md' }, 'read r.md'],
    ['Grep', { pattern: 'useSpeakers' }, 'search useSpeakers'],
    ['Glob', { pattern: '**/*.ts' }, 'search **/*.ts'],
    ['Bash', { command: 'npm test', description: 'Runs the tests' }, 'Bash: Runs the tests'],
    ['Bash', { command: 'npm run typecheck -w app-ui' }, 'Bash: npm run typecheck -w app-ui'],
    ['WebFetch', { url: 'https://x' }, 'WebFetch'],
    ['mcp__posthog__exec', {}, 'posthog · exec']
  ])('%s', (name, input, out) => expect(describeTool(name, input)).toBe(out));
  test('long command truncated to 80 characters', () => {
    expect(describeTool('Bash', { command: 'x'.repeat(200) }).length).toBeLessThanOrEqual(86);
  });
});

describe('applyStatusLine', () => {
  test('a status line that changes nothing it shows returns the same session object', () => {
    const payload = { session_id: 's1', session_name: 'Short', context_window: { used_percentage: 58.4 }, model: { display_name: 'Opus 5.5' }, cost: { total_cost_usd: 1.5, total_lines_added: 3, total_lines_removed: 1 } };
    const prev = applyStatusLine(run(ev('SessionStart'))!, payload, T).session!;
    expect(applyStatusLine(prev, payload, T + 1000).session).toBe(prev);
    const moved = applyStatusLine(prev, { ...payload, context_window: { used_percentage: 61 } }, T + 2000).session!;
    expect(moved).not.toBe(prev);
    expect(moved.contextPct).toBe(61);
    expect(applyStatusLine(prev, { ...payload, cost: { total_cost_usd: 1.6, total_lines_added: 3, total_lines_removed: 1 } }, T + 3000).session).not.toBe(prev);
  });
  test('context and limits', () => {
    const r = applyStatusLine(run(ev('SessionStart'))!, {
      session_id: 's1', session_name: 'Short',
      context_window: { used_percentage: 58.4 },
      rate_limits: { five_hour: { used_percentage: 42, resets_at: 1800000000 }, seven_day: { used_percentage: 18, resets_at: 1800500000 } }
    }, T);
    expect(r.session).toMatchObject({ contextPct: 58, title: 'Short' });
    expect(r.usage).toEqual({ fiveHour: { pct: 42, resetsAt: 1800000000 }, sevenDay: { pct: 18, resetsAt: 1800500000 }, updatedAt: T });
  });
  test('without rate_limits → usage null', () => {
    expect(applyStatusLine(run(ev('SessionStart'))!, { session_id: 's1' }, T).usage).toBeNull();
  });
  test('the title follows Claude\'s live name (a /rename, an AI title arriving later); none keeps the last one', () => {
    const s = run(ev('SessionStart', { session_title: 'From hook' }))!;
    const renamed = applyStatusLine(s, { session_id: 's1', session_name: 'Renamed in Claude' }, T).session!;
    expect(renamed.title).toBe('Renamed in Claude');
    expect(applyStatusLine(renamed, { session_id: 's1', session_name: 'Again' }, T).session?.title).toBe('Again');
    expect(applyStatusLine(renamed, { session_id: 's1' }, T).session?.title).toBe('Renamed in Claude');
  });
  test('status line of another session or with no session → session unchanged', () => {
    const s = run(ev('SessionStart'))!;
    expect(applyStatusLine(s, { session_id: 'other', context_window: { used_percentage: 9 } }, T).session).toBe(s);
    expect(applyStatusLine(null, { session_id: 's1' }, T).session).toBeNull();
  });

  test('model, changed lines and session cost', () => {
    const r = applyStatusLine(run(ev('SessionStart'))!, {
      session_id: 's1', model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
      cost: { total_cost_usd: 4.126, total_lines_added: 120, total_lines_removed: 30, total_duration_ms: 99 }
    }, T);
    expect(r.session?.model).toBe('Opus 5.5');
    expect(r.session?.cost).toEqual({ usd: 4.126, linesAdded: 120, linesRemoved: 30 });
  });

  test('missing or wrong fields: previous values stay, no invented numbers', () => {
    const first = applyStatusLine(run(ev('SessionStart'))!, { session_id: 's1', model: { display_name: 'Opus 5.5' }, cost: { total_cost_usd: 1, total_lines_added: 2, total_lines_removed: 3 } }, T).session!;
    const next = applyStatusLine(first, { session_id: 's1', model: 'dunno', cost: { total_cost_usd: 'plenty', total_lines_added: -4 } }, T).session!;
    expect(next.model).toBe('Opus 5.5');
    expect(next.cost).toEqual({ usd: 1, linesAdded: 2, linesRemoved: 3 });
    expect(run(ev('SessionStart'))!.cost).toBeNull();
    expect(run(ev('SessionStart'))!.model).toBeNull();
  });
});

test('onShellForeground: claude exited without SessionEnd → session closed', () => {
  expect(onShellForeground(run(ev('SessionStart'), ev('UserPromptSubmit'))!)).toBeNull();
  expect(onShellForeground(null)).toBeNull();
});

describe('mergeUsage', () => {
  const u = (five: [number, number] | null, seven: [number, number] | null, at = 0): Usage => ({
    fiveHour: five && { pct: five[0], resetsAt: five[1] }, sevenDay: seven && { pct: seven[0], resetsAt: seven[1] }, updatedAt: at
  });
  test('same window: the higher percentage wins (an idle session repeats old numbers)', () => {
    expect(mergeUsage(u([40, 2000], [10, 9000]), u([30, 2000], [10, 9000], 5), 1000)).toEqual(u([40, 2000], [10, 9000], 5));
  });
  test('new window (reset later): wins even if the percentage is lower', () => {
    expect(mergeUsage(u([90, 2000], null), u([3, 20000], null), 1000)?.fiveHour).toEqual({ pct: 3, resetsAt: 20000 });
  });
  test('an old window arriving later does not replace the new one', () => {
    expect(mergeUsage(u([3, 20000], null), u([90, 2000], null), 1000)?.fiveHour).toEqual({ pct: 3, resetsAt: 20000 });
  });
  test('expired windows are dropped', () => {
    expect(mergeUsage(u([40, 900], [10, 9000]), null, 1000)).toEqual(u(null, [10, 9000]));
    expect(mergeUsage(u([40, 900], null), null, 1000)).toBeNull();
  });
  const seen = (pct: number, resetsAt: number, seenAt: number) => ({ pct, resetsAt, seenAt });
  test('a limit reset mid-window: the numbers seen more recently win over an idle session repeating higher ones', () => {
    const stale: Usage = { fiveHour: null, sevenDay: seen(99, 9000, 10), updatedAt: 20 };
    const fresh: Usage = { fiveHour: null, sevenDay: seen(2, 9000, 30), updatedAt: 30 };
    expect(mergeUsage(stale, fresh, 1000)?.sevenDay).toEqual(seen(2, 9000, 30));
    // The idle session keeps repeating its old numbers: they stay behind.
    expect(mergeUsage(mergeUsage(stale, fresh, 1000), { ...stale, updatedAt: 40 }, 1000)?.sevenDay).toEqual(seen(2, 9000, 30));
  });
  test('a reset that moves the window earlier: the numbers seen more recently still win', () => {
    const stale: Usage = { fiveHour: null, sevenDay: seen(99, 9000, 10), updatedAt: 10 };
    const fresh: Usage = { fiveHour: null, sevenDay: seen(2, 8000, 30), updatedAt: 30 };
    expect(mergeUsage(stale, fresh, 1000)?.sevenDay).toEqual(seen(2, 8000, 30));
    expect(mergeUsage(fresh, stale, 1000)?.sevenDay).toEqual(seen(2, 8000, 30));
  });
  test('seen at the same moment: the one arriving last wins', () => {
    const a: Usage = { fiveHour: seen(40, 2000, 10), sevenDay: null, updatedAt: 10 };
    const b: Usage = { fiveHour: seen(30, 2000, 10), sevenDay: null, updatedAt: 10 };
    expect(mergeUsage(a, b, 1000)?.fiveHour).toEqual(seen(30, 2000, 10));
  });
});

describe('stampUsage: when a terminal last saw its limits move (its latest API response)', () => {
  const u = (pct: number, at: number): Usage => ({ fiveHour: { pct, resetsAt: 2000 }, sevenDay: { pct: 5, resetsAt: 9000 }, updatedAt: at });
  test('first numbers and changed numbers are seen now, on every window', () => {
    expect(stampUsage(null, u(40, 7), 7)).toEqual({ fiveHour: { pct: 40, resetsAt: 2000, seenAt: 7 }, sevenDay: { pct: 5, resetsAt: 9000, seenAt: 7 }, updatedAt: 7 });
    expect(stampUsage(stampUsage(null, u(40, 7), 7), u(41, 9), 9).sevenDay).toEqual({ pct: 5, resetsAt: 9000, seenAt: 9 });
  });
  test('the same numbers repeated keep the moment they were first seen', () => {
    expect(stampUsage(stampUsage(null, u(40, 7), 7), u(40, 9), 9)).toEqual({ fiveHour: { pct: 40, resetsAt: 2000, seenAt: 7 }, sevenDay: { pct: 5, resetsAt: 9000, seenAt: 7 }, updatedAt: 9 });
  });
  test('usageKey leaves seenAt out: a source switch alone shows nothing new', () => {
    expect(usageKey(stampUsage(null, u(40, 7), 7))).toBe(usageKey(u(40, 9)));
  });
});

describe('configDirOf: the Claude config dir from a transcript path', () => {
  test('the dir three levels up from <dir>/projects/<slug>/<session>.jsonl', () => {
    expect(configDirOf('/Users/me/.claude/projects/-Users-me-repo/0b1c.jsonl')).toBe('/Users/me/.claude');
    expect(configDirOf('/Users/me/.claude_ops/projects/-Users-me-repo/0b1c.jsonl')).toBe('/Users/me/.claude_ops');
    // A config dir that itself sits under a "projects" folder.
    expect(configDirOf('/work/projects/cfg/projects/-work-x/s.jsonl')).toBe('/work/projects/cfg');
  });
  test('anything else is unknown', () => {
    expect(configDirOf('.claude/projects/x/s.jsonl')).toBeNull();
    expect(configDirOf('/Users/me/.claude/projects/x/s.json')).toBeNull();
    expect(configDirOf('/Users/me/.claude/sessions/x/s.jsonl')).toBeNull();
    // A subagent's transcript is one level deeper: not the session's own path.
    expect(configDirOf('/Users/me/.claude/projects/x/s/subagents/agent-1.jsonl')).toBeNull();
    expect(configDirOf('/projects/x/s.jsonl')).toBeNull();
    expect(configDirOf('/a/../projects/x/s.jsonl')).toBeNull();
    expect(configDirOf(42)).toBeNull();
    expect(configDirOf(undefined)).toBeNull();
  });
  test('hook data is untrusted: no path longer than PATH_MAX, no control characters', () => {
    expect(configDirOf(`/${'a'.repeat(4096)}/projects/x/s.jsonl`)).toBeNull();
    expect(configDirOf('/u/.cla\nude/projects/x/s.jsonl')).toBeNull();
    expect(configDirOf('/u/.cla\u0000ude/projects/x/s.jsonl')).toBeNull();
  });
  test('applyStatusLine reports it with the limits', () => {
    const payload = { session_id: 's1', transcript_path: '/Users/me/.claude_ops/projects/-p/s1.jsonl', rate_limits: { five_hour: { used_percentage: 22, resets_at: 1800000000 } } };
    expect(applyStatusLine(run(ev('SessionStart'))!, payload, T).configDir).toBe('/Users/me/.claude_ops');
    expect(applyStatusLine(null, { session_id: 's1' }, T).configDir).toBeNull();
  });
});

describe('mergeUsageByDir: limits merged within one config dir only', () => {
  const u = (pct: number, resetsAt: number, at = 0): Usage => ({ fiveHour: { pct, resetsAt }, sevenDay: null, updatedAt: at });
  const now = 1000;
  test('two accounts stay apart, whichever resets later', () => {
    // The live case: ~/.claude at 0% resetting in 4h45m, ~/.claude_ops at 22% resetting in 3h45m.
    let list: UsageEntry[] = [];
    list = mergeUsageByDir(list, '/u/.claude', u(0, now + 17100, 1), now);
    list = mergeUsageByDir(list, '/u/.claude_ops', u(22, now + 13500, 2), now);
    expect(list).toEqual([{ configDir: '/u/.claude', usage: u(0, now + 17100, 1) }, { configDir: '/u/.claude_ops', usage: u(22, now + 13500, 2) }]);
  });
  test('within one dir the usual merge applies (a stale session does not win)', () => {
    let list = mergeUsageByDir([], '/u/.claude', u(40, now + 500, 1), now);
    list = mergeUsageByDir(list, '/u/.claude', u(30, now + 500, 2), now);
    expect(list).toEqual([{ configDir: '/u/.claude', usage: u(40, now + 500, 2) }]);
  });
  test('an unknown dir is its own entry; dirs with no live window leave the list', () => {
    let list = mergeUsageByDir([], '/u/.claude', u(40, now + 10, 1), now);
    list = mergeUsageByDir(list, null, u(5, now + 900, 2), now);
    expect(list.map((e) => e.configDir)).toEqual(['/u/.claude', null]);
    expect(mergeUsageByDir(list, null, u(6, now + 900, 3), now + 20).map((e) => e.configDir)).toEqual([null]);
  });
  test('a window resetting beyond 8 days is not credible: it never makes an immortal entry', () => {
    expect(mergeUsageByDir([], '/u/.claude', u(5, now + 8 * 86400 + 1, 1), now)).toEqual([]);
    expect(mergeUsage(null, u(5, 1e15, 1), now)).toBeNull();
  });
  test('at most 16 dirs: a new one evicts the stalest', () => {
    let list: UsageEntry[] = [];
    for (let i = 0; i < 16; i++) list = mergeUsageByDir(list, `/u/d${i}`, u(i, now + 500, i === 3 ? 0 : 10 + i), now);
    list = mergeUsageByDir(list, '/u/new', u(1, now + 500, 99), now);
    expect(list).toHaveLength(16);
    expect(list.map((e) => e.configDir)).not.toContain('/u/d3');
    expect(list.map((e) => e.configDir)).toContain('/u/new');
  });
});

describe('lastMessageAt: when the conversation last had a message', () => {
  const at = (s: SessionInfo | null, e: Record<string, unknown>, now: number) => reduceHook(s, e, now)!;
  test('a new session has none; a prompt and the end of a turn (Stop, StopFailure) set it', () => {
    let s = at(null, ev('SessionStart'), 10);
    expect(s.lastMessageAt).toBeNull();
    s = at(s, ev('UserPromptSubmit', { prompt: 'hi' }), 20);
    expect(s.lastMessageAt).toBe(20);
    s = at(s, ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), 30);
    expect(s.lastMessageAt).toBe(20);
    s = at(s, ev('Stop'), 40);
    expect(s.lastMessageAt).toBe(40);
    // The idle notice a minute later is not a message.
    s = at(s, ev('Notification', { notification_type: 'idle_prompt' }), 100);
    expect(s.lastMessageAt).toBe(40);
    s = at(s, ev('UserPromptSubmit', { prompt: 'again' }), 200);
    s = at(s, ev('StopFailure', { error: 'rate_limit' }), 210);
    expect(s.lastMessageAt).toBe(210);
  });
  test('kept across compaction and a SessionStart of the same conversation; a new conversation starts without', () => {
    let s = at(null, ev('SessionStart'), 10);
    s = at(s, ev('UserPromptSubmit', { prompt: 'hi' }), 20);
    s = at(s, ev('SessionStart', { source: 'compact' }), 30);
    expect(s.lastMessageAt).toBe(20);
    s = at(s, ev('SessionStart', { source: 'resume' }), 40);
    expect(s.lastMessageAt).toBe(20);
    s = at(s, { ...ev('SessionStart', { source: 'clear' }), session_id: 's2' }, 50);
    expect(s.lastMessageAt).toBeNull();
  });
  test('a resumed conversation\'s time seeds a session that has none, once, and only a sane one', () => {
    const s = at(null, ev('SessionStart', { source: 'resume' }), 1000);
    expect(seedLastMessage(s, 500, 1000).lastMessageAt).toBe(500);
    const spoken = at(s, ev('UserPromptSubmit', { prompt: 'x' }), 1100);
    expect(seedLastMessage(spoken, 500, 1100).lastMessageAt).toBe(1100);
    expect(seedLastMessage(s, 5000, 1000).lastMessageAt).toBeNull();
    expect(seedLastMessage(s, Number.NaN, 1000).lastMessageAt).toBeNull();
    expect(seedLastMessage(s, -1, 1000).lastMessageAt).toBeNull();
    expect(seedLastMessage(s, undefined, 1000)).toBe(s);
  });
  test('it leaves the daemon (not an internal field)', () => {
    const s = at(at(null, ev('SessionStart'), 10), ev('UserPromptSubmit', { prompt: 'hi' }), 20);
    expect(publicSession(s).lastMessageAt).toBe(20);
  });
});
