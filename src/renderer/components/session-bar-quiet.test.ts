import { beforeEach, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import { useApp } from '../store';
import { SessionBar } from './SessionBar';
import { SessionStats } from './SessionPanel';

// The quieter session bar: one session chip (context, model) that opens
// the Session panel; lines and cost in the panel; Ask without its pill and key chip.

const session = (o: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: 's1', state: 'idle', title: null, activity: 'idle', contextPct: 67, unread: false, updatedAt: 0,
  model: 'Opus 5.5', cost: { usd: 41.35, linesAdded: 3300, linesRemoved: 320 }, ...o
} as SessionInfo);
const term = (s: SessionInfo): TerminalInfo => ({ id: 't1', projectRoot: '/p', cwd: '/p', title: 'auth-refactor', name: null, color: '#B794F6', foreground: 'claude', createdAt: 1, session: s });

// A server render reads the store's initial state: it is given the current one (this file's own store instance).
const render = (el: ReturnType<typeof createElement>) => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  return renderToStaticMarkup(el);
};

beforeEach(() => {
  useApp.setState({ sessionPanel: null, askOpen: {}, askThreads: {}, restarts: {}, mcpAdded: {}, popout: null });
});

test('the bar: one session chip with the context and the model; no lines or cost; Ask without its key chip', () => {
  const html = render(createElement(SessionBar, { term: term(session()) }));
  expect(html).not.toContain('sb-lines');
  expect(html).not.toContain('sb-cost');
  expect(html).not.toContain('$41.35');
  const chip = html.slice(html.indexOf('class="sb-model'), html.indexOf('</button>', html.indexOf('class="sb-model')));
  expect(chip).toContain('67%');
  expect(chip).toContain('Opus 5.5');
  // One tooltip (the app's, with the context in it), no native one from the ring; a name that reads well.
  expect(chip).not.toContain('title=');
  expect(chip).toContain('data-tip="Context used: 67% · Model, mode and quick actions"');
  expect(chip).toContain('aria-label="Opus 5.5 · Context used: 67%"');
  expect(html).not.toContain('sb-ask-kbd');
  expect(html).toContain('class="sb-sep"');
});

test('the Session panel\'s strip: lines, cost, context; a missing number is a dash; none at all, no strip', () => {
  const full = render(createElement(SessionStats, { s: session() }));
  expect(full).toContain('+3.3k');
  expect(full).toContain('−320');
  expect(full).toContain('$41.35');
  expect(full).toContain('67%');
  const some = render(createElement(SessionStats, { s: session({ cost: null }) }));
  expect(some).toContain('67%');
  expect(some).toContain('—');
  expect(render(createElement(SessionStats, { s: session({ cost: null, contextPct: null }) }))).toBe('');
});
