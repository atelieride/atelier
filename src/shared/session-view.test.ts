import { expect, test } from 'vitest';
import type { SessionInfo, SessionState } from './session';
import { agentsInBackground, agentsLabel, isWaiting, withoutBackground, withoutStates2, modeBadge, needsYou, permissionModeLabel, waitKind, waitTarget } from './session-view';

const s = (state: SessionState, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: 'x', state, title: null, activity: null, contextPct: null, unread: false, updatedAt: 0, ...extra
});

test('waitKind: permission and question from states2; plain waiting from an older atelierd; input is not waiting', () => {
  expect(waitKind(s('waiting', { waitingFor: 'permission' }))).toBe('permission');
  expect(waitKind(s('waiting', { waitingFor: 'question' }))).toBe('question');
  // An atelierd without states2 sends no waitingFor: still waiting for you, kind unknown.
  expect(waitKind(s('waiting'))).toBe('waiting');
  expect(waitKind(s('waiting', { waitingFor: null }))).toBe('waiting');
  // The idle notice: the turn is over and the prompt is free, nothing to answer.
  expect(waitKind(s('idle', { waitingFor: 'input' }))).toBeNull();
  expect(waitKind(s('waiting', { waitingFor: 'input' }))).toBeNull();
  expect(waitKind(s('done', { waitingFor: 'input', unread: true }))).toBeNull();
  expect(waitKind(s('running'))).toBeNull();
  expect(waitKind(null)).toBeNull();
  expect(waitKind(undefined)).toBeNull();
});

test('isWaiting / needsYou: waiting for a permission or an answer, or stopped by an error', () => {
  expect(isWaiting(s('waiting', { waitingFor: 'question' }))).toBe(true);
  expect(isWaiting(s('idle', { waitingFor: 'input' }))).toBe(false);
  expect(needsYou(s('error', { errorReason: 'rate_limit' }))).toBe(true);
  expect(needsYou(s('error'))).toBe(true);
  expect(needsYou(s('waiting'))).toBe(true);
  expect(needsYou(s('done', { unread: true, waitingFor: 'input' }))).toBe(false);
  expect(needsYou(s('running'))).toBe(false);
  expect(needsYou(null)).toBe(false);
});

test('needsYou: a paused usage-limit error waits by itself; an ended pause needs you again', () => {
  expect(needsYou(s('error', { errorReason: 'rate_limit', limitPause: { since: 1, resetsAt: null } }))).toBe(false);
  expect(needsYou(s('error', { errorReason: 'rate_limit', limitPause: { since: 1, resetsAt: 5 } }))).toBe(false);
  expect(needsYou(s('error', { errorReason: 'rate_limit', limitPause: { since: 1, resetsAt: 5, over: 'expired' } }))).toBe(true);
  expect(needsYou(s('error', { errorReason: 'overloaded' }))).toBe(true);
});

test('waitTarget: what the permission is for, from the activity atelierd writes', () => {
  expect(waitTarget('waiting: Bash npm test')).toBe('Bash npm test');
  expect(waitTarget('waiting: plan approval')).toBe('plan approval');
  expect(waitTarget('waiting: question')).toBeNull();
  expect(waitTarget('waiting: permission')).toBeNull();
  expect(waitTarget('waiting for you')).toBeNull();
  expect(waitTarget(null)).toBeNull();
  expect(waitTarget('Bash: npm test')).toBeNull();
});

test('permission modes in words; unknown ones as they are', () => {
  expect(permissionModeLabel('plan')).toBe('Plan');
  expect(permissionModeLabel('acceptEdits')).toBe('Accept edits');
  expect(permissionModeLabel('bypassPermissions')).toBe('Bypass permissions');
  expect(permissionModeLabel('dontAsk')).toBe("Don't ask");
  expect(permissionModeLabel('default')).toBe('Default');
  expect(permissionModeLabel('auto')).toBe('Auto');
  expect(permissionModeLabel('someNewMode')).toBe('someNewMode');
});

test('agents chip: only with subagents running, singular and plural', () => {
  expect(agentsLabel(undefined)).toBeNull();
  expect(agentsLabel(0)).toBeNull();
  expect(agentsLabel(1)).toBe('1 agent');
  expect(agentsLabel(3)).toBe('3 agents');
  expect(agentsLabel(99)).toBe('99 agents');
});

test('agents in the background: subagents running while the main agent is idle or done (not while it works or waits)', () => {
  expect(agentsInBackground(s('done', { subagents: 1 }))).toBe(true);
  expect(agentsInBackground(s('idle', { subagents: 2 }))).toBe(true);
  expect(agentsInBackground(s('done', { subagents: 0 }))).toBe(false);
  expect(agentsInBackground(s('done'))).toBe(false);
  expect(agentsInBackground(s('running', { subagents: 1 }))).toBe(false);
  expect(agentsInBackground(s('waiting', { subagents: 1, waitingFor: 'permission' }))).toBe(false);
  expect(agentsInBackground(s('error', { subagents: 1 }))).toBe(false);
  expect(agentsInBackground(null)).toBe(false);
});

test('without the states2 capability the v2.0 fields are dropped: the session reads exactly as before', () => {
  const full = s('waiting', { activity: 'waiting: Bash npm test', cwd: '/p', model: 'Opus', cost: null, waitingFor: 'permission', compacting: true, subagents: 2, errorReason: null, permissionMode: 'plan', autoTitle: 'x' });
  const term = { id: 't', session: full, title: 'T' };
  const [out] = withoutStates2([term, { id: 'u', session: null, title: 'U' }]);
  expect(out!.session).toEqual(s('waiting', { activity: 'waiting: Bash npm test', cwd: '/p', model: 'Opus', cost: null }));
  expect(out!.title).toBe('T');
  // Untouched terminals are the same objects.
  const plain = { id: 'v', session: s('idle'), title: 'V' };
  expect(withoutStates2([plain])[0]).toBe(plain);
});

test('without the background capability the background field is dropped: the session reads exactly as before', () => {
  const bg = { items: [{ id: 'b1', kind: 'shell' as const, label: 'npm test', command: 'npm test', since: 1 }], crons: [] };
  const term = { id: 't', session: s('done', { subagents: 1, background: bg }), title: 'T' };
  const [out, none] = withoutBackground([term, { id: 'u', session: null, title: 'U' }]);
  expect(out!.session).toEqual(s('done', { subagents: 1 }));
  expect(term.session.background).toBe(bg);
  expect(none!.session).toBeNull();
  const plain = { id: 'v', session: s('idle'), title: 'V' };
  expect(withoutBackground([plain])[0]).toBe(plain);
});

// Launch flags: a session that skips permissions says so wherever Plan would show.
test('modeBadge: plan, bypass, or none', () => {
  expect(modeBadge('plan')).toBe('plan');
  expect(modeBadge('bypassPermissions')).toBe('bypass');
  for (const m of ['default', 'auto', 'acceptEdits', 'dontAsk', undefined, null]) expect(modeBadge(m)).toBeNull();
});
