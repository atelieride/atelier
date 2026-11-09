import { afterEach, beforeEach, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import type { Resumable, TerminalInfo } from '@shared/protocol';
import type { SessionInfo, SessionState } from '@shared/session';
import { useApp } from '../store';
import { single } from '../split';
import { renderLive as live } from '../databases/test-render';
import { Appearance } from './Settings';
import { PaneStrip } from './Tabs';
import { PaneHeader } from './PaneHeader';
import { SessionBar } from './SessionBar';
import { SessionRow } from './SessionRow';
import { ResumeRow } from './ResumeRow';

// Session avatars off: sidebar rows start with the title,
// tabs and session bars show the session tile.

test('Settings › Appearance: a Session avatars switch with its hint, on by default', () => {
  const html = renderToStaticMarkup(createElement(Appearance, { s: DEFAULT_SETTINGS }));
  expect(html).toContain('Session avatars');
  expect(html).toContain('The initial at the start of each session row. Off, titles get the room and the pin moves to the row’s end.');
  const at = html.indexOf('aria-label="Session avatars"');
  expect(at).toBeGreaterThan(-1);
  const tag = html.slice(html.lastIndexOf('<button', at), html.indexOf('>', at));
  expect(tag).toContain('aria-checked="true"');
});

const session = (state: SessionState): SessionInfo => ({
  sessionId: `s-${state}`, state, title: null, activity: state, contextPct: 10, unread: false, updatedAt: 0, model: null, cost: null
} as unknown as SessionInfo);
const claude = (id: string, state: SessionState | null): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: `Fix ${id}`, name: null, color: '#B794F6', foreground: state ? 'claude' : 'zsh', createdAt: 1, session: state ? session(state) : null
});

/** The markup of one tab of the strip: from its opening tag to the next tab's. */
function tabOf(html: string, key: string): string {
  const at = html.indexOf(`data-key="${key}"`);
  expect(at, key).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<div role="tab"', at);
  const next = html.indexOf('<div role="tab"', at);
  return html.slice(start, next === -1 ? undefined : next);
}
const strip = () => live(createElement(PaneStrip, { pane: 0, split: false, last: false, onNew: () => {} }));
const avatars = (on: boolean) => useApp.setState({ settings: { ...useApp.getState().settings, sessionAvatars: on } });

const TERMS = [claude('idle', 'idle'), claude('wait', 'waiting'), claude('err', 'error'), claude('done', 'done'), claude('start', null), claude('zsh', null)];

beforeEach(() => {
  useApp.setState({
    project: null, popout: null, poppedOut: [], terminals: TERMS, selectedId: 'idle', starting: { start: 1 }, openFiles: [], preview: null,
    split: single(), ws: null, tabOrder: TERMS.map((x) => `t:${x.id}` as const), dbTabs: [], dbPreview: null, activeTab: 't:idle', tabDrag: null, dockHover: null,
    sessionPanel: null, askOpen: {}, askThreads: {}, restarts: {}, mcpAdded: {}, closeAsk: null, restartAsk: null, automations: { automations: [] }
  });
  avatars(false);
});
afterEach(() => {
  avatars(true);
  useApp.setState({ tabOrder: [], activeTab: 'term', terminals: [], selectedId: null, starting: {}, closeAsk: null, restartAsk: null, automations: { automations: [] } });
});

test('avatars off: a session tab shows the session tile, no avatar', () => {
  const tab = tabOf(strip(), 't:idle');
  expect(tab).toContain('class="session-tile');
  expect(tab).not.toContain('class="avatar');
});

test('avatars off: the tile says waiting and error; a finished session keeps the done dot', () => {
  const html = strip();
  expect(tabOf(html, 't:wait')).toContain('session-tile st-waiting');
  expect(tabOf(html, 't:err')).toContain('session-tile st-error');
  expect(tabOf(html, 't:done')).toContain('av-done-dot');
});

test('avatars off: a session still starting shows the tile from the start; a plain terminal keeps its terminal glyph', () => {
  const html = strip();
  expect(tabOf(html, 't:start')).toContain('class="session-tile');
  expect(tabOf(html, 't:start')).not.toContain('tab-term');
  expect(tabOf(html, 't:zsh')).toContain('tab-term');
  expect(tabOf(html, 't:zsh')).not.toContain('session-tile');
});

test('avatars off: the pane header and the session bar show the tile', () => {
  expect(live(createElement(PaneHeader, { k: 't:wait', popout: true }))).toContain('session-tile st-waiting');
  const bar = live(createElement(SessionBar, { term: claude('idle', 'idle'), popout: true }));
  expect(bar).toContain('class="session-tile');
  expect(bar).not.toContain('class="avatar');
});

test('avatars on: tabs, the pane header and the session bar keep their avatars', () => {
  avatars(true);
  const html = strip();
  for (const id of ['idle', 'wait', 'start']) expect(tabOf(html, `t:${id}`)).toContain('class="avatar');
  expect(html).not.toContain('session-tile');
  expect(live(createElement(PaneHeader, { k: 't:wait', popout: true }))).toContain('class="avatar');
  expect(live(createElement(SessionBar, { term: claude('idle', 'idle'), popout: true }))).toContain('class="avatar');
});

// Sidebar rows: no leading element; automation and the kept pin at the end of the title line.
const row = (id: string, pinned = false) => live(createElement(SessionRow, { term: TERMS.find((x) => x.id === id)!, selected: false, pinned, onSelect: () => {} }));
const AUTOMATED = { automations: [{ automation: { id: 'au1', name: 'Nightly audit' }, runs: [{ terminalId: 'idle' }] }] } as never;

test('avatars off: a session row has no avatar and says so in its class', () => {
  const html = row('idle');
  expect(html).not.toContain('class="avatar');
  expect(html).toMatch(/class="session-row [^"]*no-avatar/);
});

test('avatars off: a pinned row keeps its pin button at rest (kept, counted in the reserved room); an unpinned one has none', () => {
  const pinned = row('idle', true);
  expect(pinned).toMatch(/<button[^>]*class="row-pin is-pinned is-kept"[^>]*data-keep=""/);
  const unpinned = row('idle');
  expect(unpinned).not.toContain('is-kept');
  expect(unpinned).not.toMatch(/class="row-pin[^"]*"[^>]*data-keep/);
});

test('avatars off: a row started by an automation shows its mark at the end; avatars on, the avatar\'s badge as today', () => {
  useApp.setState({ automations: AUTOMATED });
  try {
    const off = row('idle');
    expect(off).toMatch(/class="row-mark is-auto"[^>]*role="img"[^>]*aria-label="Started by an automation"/);
    avatars(true);
    const on = row('idle');
    expect(on).not.toContain('row-mark');
    expect(on).toContain('av-auto');
  } finally {
    useApp.setState({ automations: { automations: [] } });
  }
});

test('avatars off: the row\'s close and restart questions have no avatar; avatars on, they keep it', () => {
  useApp.setState({ closeAsk: { id: 'idle', at: 'row', stops: { kind: 'claude', doing: 'idle' }, note: 'history' } });
  expect(row('idle')).not.toContain('class="avatar');
  avatars(true);
  expect(row('idle')).toContain('class="avatar');
  useApp.setState({ closeAsk: null, restartAsk: { id: 'idle', at: 'row' } });
  expect(row('idle')).toContain('class="avatar');
  avatars(false);
  expect(row('idle')).not.toContain('class="avatar');
  useApp.setState({ restartAsk: null });
});

const RESUMABLE: Resumable = { id: 'r1', projectRoot: '/p', cwd: '/p', title: 'Fix the login', color: '#B794F6', sessionId: 's-r1', endedAt: 1 };

test('avatars off: a resume row has no avatar; a pinned one shows a pin mark after its title', () => {
  const html = live(createElement(ResumeRow, { r: RESUMABLE, pinned: true }));
  expect(html).not.toContain('class="avatar');
  expect(html).toMatch(/class="resume-row [^"]*no-avatar/);
  expect(html).toMatch(/class="resume-title"[^>]*>Fix the login<\/span><span class="row-mark is-pin" role="img" aria-label="Pinned"/);
  expect(live(createElement(ResumeRow, { r: RESUMABLE, pinned: false }))).not.toContain('row-mark');
  avatars(true);
  const on = live(createElement(ResumeRow, { r: RESUMABLE, pinned: true }));
  expect(on).toContain('av-pin');
  expect(on).not.toContain('row-mark');
});
