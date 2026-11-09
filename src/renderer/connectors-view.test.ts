import { describe, expect, test } from 'vitest';
import type { ConnectorInfo, ConnectorStatus } from '@shared/tasks';
import type { SourceInfo } from '@shared/tasks';
import { attentionConnector, clockTime, connectorCommands, connectorRow, connectorView, countdown, isConnectorsBackKey, needsAttention, noneChosen, noticeView, revokeHint, workspaceValue } from './connectors-view';

const NOW = new Date(2026, 9, 11, 10, 50, 0).getTime();
const info = (status: ConnectorStatus, extra: Partial<ConnectorInfo> = {}): ConnectorInfo => ({
  id: 'clickup', name: 'ClickUp', status, loading: false, tasksVersion: 0, options: { show: 'assigned', includeClosed: false }, ...extra
});
const ids = (v: ReturnType<typeof connectorView>) => v.actions.map((a) => `${a.id}${a.primary ? '*' : ''}`);

describe('countdown (connecting: m:ss to connectingUntil)', () => {
  test('minutes and zero-padded seconds, rounded up so it starts at 5:00', () => {
    expect(countdown(NOW + 5 * 60_000, NOW)).toBe('5:00');
    expect(countdown(NOW + 4 * 60_000 + 59_001, NOW)).toBe('5:00');
    expect(countdown(NOW + 4 * 60_000 + 59_000, NOW)).toBe('4:59');
    expect(countdown(NOW + 61_000, NOW)).toBe('1:01');
    expect(countdown(NOW + 9_000, NOW)).toBe('0:09');
  });
  test('never negative', () => {
    expect(countdown(NOW - 3000, NOW)).toBe('0:00');
  });
});

describe('clockTime ("showing tasks from 10:42")', () => {
  test('24 h, zero-padded, today', () => {
    expect(clockTime(new Date(2026, 9, 11, 10, 42).getTime(), NOW)).toBe('10:42');
    expect(clockTime(new Date(2026, 9, 11, 9, 5).getTime(), NOW)).toBe('09:05');
  });
  test('another day gets its date', () => {
    expect(clockTime(new Date(2026, 9, 10, 23, 7).getTime(), NOW)).toBe('Oct 10, 23:07');
  });
});

describe('connectorView: status line and actions per status', () => {
  test('disconnected: "Not connected", Connect (primary)', () => {
    const v = connectorView(info('disconnected'), NOW);
    expect(v).toMatchObject({ tone: 'idle', line: 'Not connected' });
    expect(v.sub).toBeUndefined();
    expect(ids(v)).toEqual(['connect*']);
  });

  test('connecting: waiting line with a countdown, Cancel (primary) and "Open the page again"', () => {
    const v = connectorView(info('connecting', { connectingUntil: NOW + 272_000 }), NOW);
    expect(v).toMatchObject({ tone: 'busy', line: 'Waiting for you in the browser…', countdown: '4:32' });
    expect(ids(v)).toEqual(['cancel*', 'reopen']);
    expect(v.actions.map((a) => a.label)).toEqual(['Cancel', 'Open the page again']);
  });

  test('connected: account · workspace, "Updated 2 min ago", Disconnect (primary) and Refresh', () => {
    const v = connectorView(info('connected', { account: 'Ada Lovelace', workspace: 'Acme', updatedAt: NOW - 2 * 60_000 - 5000 }), NOW);
    expect(v).toMatchObject({ tone: 'ok', line: 'Connected as Ada Lovelace · Acme', sub: 'Updated 2 min ago' });
    expect(ids(v)).toEqual(['disconnect*', 'refresh']);
    expect(v.actions.find((a) => a.id === 'disconnect')?.danger).toBe(true);
  });

  test('connected without an account name: "Connected · <workspace>"; just now; no workspace at all: "Connected"', () => {
    expect(connectorView(info('connected', { workspace: 'Acme', updatedAt: NOW - 10_000 }), NOW)).toMatchObject({ line: 'Connected · Acme', sub: 'Updated just now' });
    expect(connectorView(info('connected'), NOW).line).toBe('Connected');
  });

  test('Notion connected with no database: violet, "Now choose where your tasks live.", Disconnect only', () => {
    const c = info('connected', { id: 'notion', name: 'Notion', account: 'Ada Lovelace', workspace: 'Acme', sources: [], updatedAt: NOW - 60_000 });
    const v = connectorView(c, NOW);
    expect(v).toMatchObject({ tone: 'setup', line: 'Connected as Ada Lovelace · Acme', sub: 'Now choose where your tasks live.', subTone: 'muted' });
    expect(ids(v)).toEqual(['disconnect*']);
    // With a database: the usual green card, Refresh back.
    const withDb = connectorView({ ...c, sources: [{ id: 'a', name: 'A', fields: { title: 'Name' }, loading: false }] }, NOW);
    expect(withDb).toMatchObject({ tone: 'ok', sub: 'Updated 1 min ago' });
    expect(ids(withDb)).toEqual(['disconnect*', 'refresh']);
  });

  test('connected with an empty workspace name (no root name, no spaces): "Connected as <account>", the row shows —', () => {
    expect(connectorView(info('connected', { account: 'Ada Lovelace', workspace: '' }), NOW).line).toBe('Connected as Ada Lovelace');
    expect(connectorView(info('connected', { workspace: '' }), NOW).line).toBe('Connected');
    expect(workspaceValue(info('connected', { workspace: '' }))).toBe('—');
    expect(workspaceValue(info('connected', { workspace: 'acme' }))).toBe('acme');
    expect(workspaceValue(info('disconnected'))).toBe('—');
  });

  test('connected and fetching: the sub line says so; rate limited for long: "Slowing down…"', () => {
    expect(connectorView(info('connected', { workspace: 'Acme', loading: true, updatedAt: NOW - 60_000 }), NOW).sub).toBe('Refreshing tasks…');
    expect(connectorView(info('connected', { workspace: 'Acme', reason: 'slowing-down', updatedAt: NOW - 60_000 }), NOW)).toMatchObject({ sub: 'Slowing down…', subTone: 'warn' });
  });

  test('offline: "Can\'t reach ClickUp — showing tasks from 10:42", Retry and Disconnect (neither primary)', () => {
    const v = connectorView(info('offline', { workspace: 'Acme', updatedAt: new Date(2026, 9, 11, 10, 42).getTime() }), NOW);
    expect(v).toMatchObject({ tone: 'warn', line: "Can't reach ClickUp — showing tasks from 10:42" });
    expect(ids(v)).toEqual(['retry', 'disconnect']);
    expect(connectorView(info('offline'), NOW).line).toBe("Can't reach ClickUp. Atelier keeps trying.");
  });

  test('reconnect: signed out or unreadable, Reconnect (primary) and Disconnect', () => {
    const v = connectorView(info('reconnect', { reason: 'signed-out', workspace: 'Acme' }), NOW);
    expect(v).toMatchObject({ tone: 'warn', line: 'ClickUp signed you out. Reconnect to see your tasks.' });
    expect(v.sub).toBeUndefined();
    expect(ids(v)).toEqual(['reconnect*', 'disconnect']);
    expect(connectorView(info('reconnect', { reason: 'unreadable' }), NOW).line).toBe("Atelier can't read the saved ClickUp connection. Reconnect to see your tasks.");
  });

  test('unavailable: the reason is the line, Retry and Disconnect', () => {
    const v = connectorView(info('unavailable', { reason: 'connector-changed' }), NOW);
    expect(v).toMatchObject({ tone: 'err', line: "ClickUp's connector changed: update Atelier." });
    expect(ids(v)).toEqual(['retry', 'disconnect']);
    expect(connectorView(info('unavailable', { reason: 'auth-unsupported' }), NOW).line).toBe('ClickUp changed how apps sign in: update Atelier.');
    expect(connectorView(info('unavailable', { reason: 'workspace-gone' }), NOW).line).toBe('Your ClickUp workspace is no longer available. Retry or reconnect.');
  });

  test('a failed Connect leaves its reason on the card as a second line', () => {
    const sub = (reason: ConnectorInfo['reason'], detail?: string) => connectorView(info('disconnected', { reason, ...(detail ? { detail } : {}) }), NOW);
    expect(sub('timeout')).toMatchObject({ line: 'Not connected', sub: 'ClickUp connection timed out.', subTone: 'err' });
    expect(sub('denied').sub).toBe("You didn't allow access in ClickUp.");
    expect(sub('oauth-error', 'The server is busy.').sub).toBe('ClickUp said: The server is busy.');
    expect(sub('verify-failed').sub).toBe("Couldn't verify ClickUp's reply. Try again.");
    expect(sub('port-failed', 'EADDRINUSE').sub).toBe("Couldn't open a local port for the sign-in (EADDRINUSE).");
    expect(sub('network').sub).toBe("Can't reach ClickUp. Check your connection.");
    expect(sub('keychain-unavailable').sub).toBe("macOS Keychain isn't available, so Atelier can't store the connection safely.");
    expect(sub('fetch-failed').sub).toBe("Couldn't load your ClickUp tasks. Try again.");
  });

  test('a reason left over from a refused Reconnect (Keychain, timeout…) never replaces the status line', () => {
    const r = connectorView(info('reconnect', { reason: 'keychain-unavailable', workspace: 'Acme' }), NOW);
    expect(r).toMatchObject({ line: 'ClickUp signed you out. Reconnect to see your tasks.', sub: "macOS Keychain isn't available, so Atelier can't store the connection safely.", subTone: 'err' });
    expect(ids(r)).toEqual(['reconnect*', 'disconnect']);
    const u = connectorView(info('unavailable', { reason: 'timeout' }), NOW);
    expect(u).toMatchObject({ line: "ClickUp isn't available right now.", sub: 'ClickUp connection timed out.' });
    // A status reason never shows twice.
    expect(connectorView(info('unavailable', { reason: 'workspace-gone' }), NOW).sub).toBeUndefined();
  });

  test('oauth-error without a detail still reads as a sentence', () => {
    expect(connectorView(info('disconnected', { reason: 'oauth-error' }), NOW).sub).toBe('ClickUp refused the sign-in.');
  });
});

const notion = (status: ConnectorStatus, extra: Partial<ConnectorInfo> = {}): ConnectorInfo =>
  info(status, { id: 'notion', name: 'Notion', ...extra });
const db = (id: string, extra: Partial<SourceInfo> = {}): SourceInfo => ({ id, name: `DB ${id}`, fields: { title: 'Name' }, loading: false, ...extra });

describe('connectorRow: one row per connector in the list', () => {
  test('disconnected: no chip, the short description, Connect (primary)', () => {
    expect(connectorRow(info('disconnected'), NOW)).toEqual({
      chip: null, line: 'Start sessions from your ClickUp tasks.', action: { id: 'connect', label: 'Connect', aria: 'Connect ClickUp', primary: true }
    });
    expect(connectorRow(notion('disconnected'), NOW).line).toBe('Start sessions from tasks in your Notion databases.');
  });

  test('connecting: sky "Connecting" with the countdown, the waiting line, Cancel (ghost)', () => {
    expect(connectorRow(notion('connecting', { connectingUntil: NOW + 272_000 }), NOW)).toEqual({
      chip: { tone: 'busy', label: 'Connecting', countdown: '4:32' }, line: 'Waiting for you in the browser…',
      action: { id: 'cancel', label: 'Cancel', aria: 'Cancel Notion sign-in', primary: false }
    });
    expect(connectorRow(notion('connecting'), NOW).chip).toEqual({ tone: 'busy', label: 'Connecting' });
  });

  test('connected with no database chosen: violet "Choose databases", "Connected as <account> · no databases chosen yet"', () => {
    const r = connectorRow(notion('connected', { account: 'Ada Lovelace', workspace: 'Acme', sources: [] }), NOW);
    expect(r).toEqual({ chip: { tone: 'setup', label: 'Choose databases' }, line: 'Connected as Ada Lovelace · no databases chosen yet' });
    expect(connectorRow(notion('connected', { workspace: 'Acme', sources: [] }), NOW).line).toBe('Connected · no databases chosen yet');
  });

  test('connected with databases that need attention: amber, singular and plural', () => {
    const sources = [db('a', { count: 3 }), db('b', { error: 'unreadable' })];
    expect(connectorRow(notion('connected', { workspace: 'Acme', sources, attention: 1, updatedAt: NOW - 120_000 }), NOW)).toEqual({
      chip: { tone: 'warn', label: '1 database needs attention' }, line: '2 databases · 3 open tasks · updated 2 min ago'
    });
    expect(connectorRow(notion('connected', { workspace: 'Acme', sources, attention: 2 }), NOW).chip).toEqual({ tone: 'warn', label: '2 databases need attention' });
  });

  test('connected: green "Connected · <workspace>" (or "Connected"); ClickUp keeps its description', () => {
    expect(connectorRow(info('connected', { account: 'Ada Lovelace', workspace: 'Acme', updatedAt: NOW - 60_000 }), NOW)).toEqual({
      chip: { tone: 'ok', label: 'Connected · Acme' }, line: 'Start sessions from your ClickUp tasks.'
    });
    expect(connectorRow(info('connected'), NOW).chip).toEqual({ tone: 'ok', label: 'Connected' });
    expect(connectorRow(info('connected', { workspace: '' }), NOW).chip).toEqual({ tone: 'ok', label: 'Connected' });
  });

  test('connected Notion: "<n> databases · <k> open tasks · updated <ago>"; unknown counts and times are left out', () => {
    const two = [db('a', { count: 4 }), db('b', { count: 3 })];
    expect(connectorRow(notion('connected', { workspace: 'Acme', sources: two, updatedAt: NOW - 2 * 60_000 - 5000 }), NOW)).toEqual({
      chip: { tone: 'ok', label: 'Connected · Acme' }, line: '2 databases · 7 open tasks · updated 2 min ago'
    });
    expect(connectorRow(notion('connected', { sources: [db('a', { count: 1 })], updatedAt: NOW - 5000 }), NOW).line).toBe('1 database · 1 open task · updated just now');
    expect(connectorRow(notion('connected', { sources: [db('a', { loading: true }), db('b')] }), NOW).line).toBe('2 databases');
    expect(connectorRow(notion('connected', { sources: [db('a', { count: 0 })], updatedAt: NOW - 3_600_000 }), NOW).line).toBe('1 database · 0 open tasks · updated 1 h ago');
  });

  test('offline: amber "Offline", today\'s offline line, no action on the row', () => {
    expect(connectorRow(info('offline', { workspace: 'Acme', updatedAt: new Date(2026, 9, 11, 10, 42).getTime() }), NOW)).toEqual({
      chip: { tone: 'warn', label: 'Offline' }, line: "Can't reach ClickUp — showing tasks from 10:42"
    });
    expect(connectorRow(info('offline'), NOW).line).toBe("Can't reach ClickUp. Atelier keeps trying.");
  });

  test('reconnect: amber "Signed out", today\'s line, Reconnect (primary)', () => {
    expect(connectorRow(info('reconnect', { reason: 'signed-out', workspace: 'Acme' }), NOW)).toEqual({
      chip: { tone: 'warn', label: 'Signed out' }, line: 'ClickUp signed you out. Reconnect to see your tasks.',
      action: { id: 'reconnect', label: 'Reconnect', aria: 'Reconnect ClickUp', primary: true }
    });
    expect(connectorRow(info('reconnect', { reason: 'unreadable' }), NOW).line).toBe("Atelier can't read the saved ClickUp connection. Reconnect to see your tasks.");
  });

  test('unavailable: rose "Unavailable", today\'s line, no action on the row', () => {
    expect(connectorRow(notion('unavailable', { reason: 'connector-changed', workspace: 'Acme' }), NOW)).toEqual({
      chip: { tone: 'err', label: 'Unavailable' }, line: "Notion's connector changed: update Atelier."
    });
    expect(connectorRow(info('unavailable'), NOW).line).toBe("ClickUp isn't available right now.");
  });

  test('two rows never offer the same accessible name: the action names its connector', () => {
    const rows = [info('disconnected'), notion('disconnected')].map((c) => connectorRow(c, NOW).action!);
    expect(rows.map((a) => a.label)).toEqual(['Connect', 'Connect']);
    expect(rows.map((a) => a.aria)).toEqual(['Connect ClickUp', 'Connect Notion']);
  });

  test('at most one action, and only Connect, Cancel or Reconnect (everything else is in the details)', () => {
    for (const status of ['disconnected', 'connecting', 'connected', 'offline', 'reconnect', 'unavailable'] as const) {
      const a = connectorRow(info(status), NOW).action;
      if (a) expect(['connect', 'cancel', 'reconnect']).toContain(a.id);
    }
  });
});

describe('Jira sites', () => {
  test('a token site that isn\'t on the account, and an account with no Jira site', () => {
    expect(noticeView({ id: 'jira', kind: 'token-site' }, 'Jira').text).toBe("That site isn't a Jira Cloud site this account can open. Check its name.");
    const row = connectorRow({ ...info('unavailable'), id: 'jira', name: 'Jira', reason: 'no-site' } as ConnectorInfo, 0);
    expect(row.line).toBe('This Atlassian account has no Jira site.');
  });
});

describe('API-token sign-in copy', () => {
  test('a refused token at Connect, an expired one later (toast and reconnect row)', () => {
    expect(noticeView({ id: 'clickup', kind: 'token-refused' }, 'Jira').text).toBe('Jira refused this API token. Check the e-mail, the site, and that the token is for the Atlassian MCP V2 app.');
    expect(noticeView({ id: 'jira', kind: 'token-scopes' }, 'Jira').text).toBe("This API token can't read Jira: create one with scopes for the Atlassian MCP V2 app.");
    const expired = noticeView({ id: 'clickup', kind: 'reconnect', reason: 'token-expired' }, 'Jira');
    expect(expired).toEqual({ text: 'Jira refused the API token: it expired or was revoked. Reconnect with a new one.', action: 'reconnect' });
    const row = connectorRow({ ...info('reconnect'), name: 'Jira', reason: 'token-expired', workspace: 'acme.atlassian.net' } as ConnectorInfo, 0);
    expect(row.line).toBe('Jira refused the API token: it expired or was revoked. Reconnect with a new one.');
  });
});

describe('noticeView: one toast per notice', () => {
  test('copy per kind, with the way out as the toast action', () => {
    expect(noticeView({ id: 'clickup', kind: 'timeout' }, 'ClickUp')).toEqual({ text: 'ClickUp connection timed out.' });
    expect(noticeView({ id: 'clickup', kind: 'denied' }, 'ClickUp')).toEqual({ text: "You didn't allow access in ClickUp." });
    expect(noticeView({ id: 'clickup', kind: 'oauth-error', detail: 'Bad request' }, 'ClickUp')).toEqual({ text: 'ClickUp said: Bad request' });
    expect(noticeView({ id: 'clickup', kind: 'verify-failed' }, 'ClickUp')).toEqual({ text: "Couldn't verify ClickUp's reply. Try again." });
    expect(noticeView({ id: 'clickup', kind: 'network' }, 'ClickUp')).toEqual({ text: "Can't reach ClickUp. Check your connection.", action: 'retry' });
    expect(noticeView({ id: 'clickup', kind: 'keychain-unavailable' }, 'ClickUp')).toEqual({ text: "macOS Keychain isn't available, so Atelier can't store the connection safely." });
    expect(noticeView({ id: 'clickup', kind: 'fetch-failed' }, 'ClickUp')).toEqual({ text: "Couldn't load your ClickUp tasks. Try again.", action: 'retry' });
    expect(noticeView({ id: 'clickup', kind: 'auth-unsupported' }, 'ClickUp')).toEqual({ text: 'ClickUp changed how apps sign in: update Atelier.' });
    expect(noticeView({ id: 'clickup', kind: 'reconnect' }, 'ClickUp')).toEqual({ text: 'ClickUp signed you out. Reconnect to see your tasks.', action: 'reconnect' });
    expect(noticeView({ id: 'clickup', kind: 'unavailable' }, 'ClickUp')).toEqual({ text: "ClickUp isn't available right now.", action: 'details' });
    expect(noticeView({ id: 'clickup', kind: 'port-failed', detail: 'EACCES' }, 'ClickUp').text).toBe("Couldn't open a local port for the sign-in (EACCES).");
  });
});

const ALL_REASONS: readonly NonNullable<ConnectorInfo['reason']>[] = [
  'timeout', 'denied', 'oauth-error', 'verify-failed', 'port-failed', 'network', 'keychain-unavailable', 'fetch-failed',
  'auth-unsupported', 'connector-changed', 'workspace-gone', 'signed-out', 'unreadable', 'slowing-down'
];
const SIGNED_OUT = 'ClickUp signed you out. Reconnect to see your tasks.';
const UNREADABLE = "Atelier can't read the saved ClickUp connection. Reconnect to see your tasks.";
const KEYCHAIN = "macOS Keychain isn't available, so Atelier can't store the connection safely.";

describe('every reason on every status reads right (copy consistency)', () => {
  // Main keeps one reason: the status's own, or what the last attempt ran into. A reconnect card with nothing saved (no
  // workspace) is the unreadable one, whatever attempt reason replaced it.
  test.each([
    // [reason, saved (workspace), line, sub]
    ['signed-out', true, SIGNED_OUT, undefined],
    ['unreadable', false, UNREADABLE, undefined],
    ['keychain-unavailable', true, SIGNED_OUT, KEYCHAIN],
    ['keychain-unavailable', false, UNREADABLE, KEYCHAIN],
    ['timeout', false, UNREADABLE, 'ClickUp connection timed out.'],
    ['fetch-failed', false, UNREADABLE, "Couldn't load your ClickUp tasks. Try again."],
    ['network', true, SIGNED_OUT, "Can't reach ClickUp. Check your connection."],
    [undefined, true, SIGNED_OUT, undefined],
    [undefined, false, UNREADABLE, undefined]
  ] as const)('reconnect · %s · saved %s → its own line, the attempt below', (reason, saved, line, sub) => {
    const v = connectorView(info('reconnect', { ...(reason ? { reason } : {}), ...(saved ? { workspace: 'Acme' } : {}) }), NOW);
    expect(v.line).toBe(line);
    expect(v.sub).toBe(sub);
  });

  test.each([
    ['connector-changed', "ClickUp's connector changed: update Atelier.", undefined],
    ['auth-unsupported', 'ClickUp changed how apps sign in: update Atelier.', undefined],
    ['workspace-gone', 'Your ClickUp workspace is no longer available. Retry or reconnect.', undefined],
    ['keychain-unavailable', "ClickUp isn't available right now.", KEYCHAIN],
    ['network', "ClickUp isn't available right now.", "Can't reach ClickUp. Check your connection."],
    [undefined, "ClickUp isn't available right now.", undefined]
  ] as const)('unavailable · %s → %s', (reason, line, sub) => {
    const v = connectorView(info('unavailable', reason ? { reason } : {}), NOW);
    expect(v.line).toBe(line);
    expect(v.sub).toBe(sub);
  });

  test('no status × reason combination repeats its line below or loses the status line', () => {
    for (const status of ['disconnected', 'connecting', 'connected', 'offline', 'reconnect', 'unavailable'] as const) {
      for (const reason of [undefined, ...ALL_REASONS]) {
        for (const saved of [true, false]) {
          const v = connectorView(info(status, { ...(reason ? { reason } : {}), ...(saved ? { workspace: 'Acme' } : {}), updatedAt: NOW - 60_000 }), NOW);
          const at = `${status}/${reason}/${saved}`;
          expect(v.line, at).toBeTruthy();
          expect(v.sub, at).not.toBe(v.line);
          if (status === 'reconnect') expect([SIGNED_OUT, UNREADABLE], at).toContain(v.line);
        }
      }
    }
  });

  test.each([
    // [kind, reason, text, action]
    ['reconnect', 'signed-out', SIGNED_OUT, 'reconnect'],
    ['reconnect', 'unreadable', UNREADABLE, 'reconnect'],
    ['reconnect', undefined, SIGNED_OUT, 'reconnect'],
    ['unavailable', 'connector-changed', "ClickUp's connector changed: update Atelier.", 'details'],
    ['unavailable', 'workspace-gone', 'Your ClickUp workspace is no longer available. Retry or reconnect.', 'details'],
    ['unavailable', 'auth-unsupported', 'ClickUp changed how apps sign in: update Atelier.', 'details'],
    ['unavailable', undefined, "ClickUp isn't available right now.", 'details']
  ] as const)('the %s toast follows its reason (%s)', (kind, reason, text, action) => {
    expect(noticeView({ id: 'clickup', kind, ...(reason ? { reason } : {}) }, 'ClickUp')).toEqual({ text, action });
  });
});

describe('palette commands and the gear dot follow the status', () => {
  const keys = (status: ConnectorStatus) => connectorCommands([info(status)]).map((c) => c.label);
  test('only what makes sense now', () => {
    expect(keys('disconnected')).toEqual(['Connect ClickUp…']);
    expect(keys('connecting')).toEqual([]);
    expect(keys('connected')).toEqual(['Refresh Tasks', 'Disconnect ClickUp…']);
    expect(keys('offline')).toEqual(['Refresh Tasks', 'Disconnect ClickUp…']);
    expect(keys('reconnect')).toEqual(['Reconnect ClickUp…', 'Disconnect ClickUp…']);
    // Nothing saved here (no workspace): Retry would sign in (see below).
    expect(keys('unavailable')).toEqual(['Connect ClickUp…', 'Disconnect ClickUp…']);
    expect(connectorCommands([])).toEqual([]);
  });
  test('unavailable with nothing saved (its Retry signs in again): "Connect ClickUp…", never a "Refresh Tasks" that opens the browser', () => {
    // Nothing saved: no workspace (ConnectorInfo.workspace is present exactly when a connection is saved).
    expect(connectorCommands([info('unavailable', { reason: 'auth-unsupported' })])).toEqual([
      { key: 'connector-connect-clickup', id: 'clickup', action: 'connect', label: 'Connect ClickUp…' },
      { key: 'connector-disconnect-clickup', id: 'clickup', action: 'disconnect', label: 'Disconnect ClickUp…' }
    ]);
    // A saved connection: Refresh Tasks only refreshes.
    expect(connectorCommands([info('unavailable', { reason: 'connector-changed', workspace: 'Acme' })]).map((c) => c.label)).toEqual(['Refresh Tasks', 'Disconnect ClickUp…']);
  });

  test('ClickUp and Notion both live: each refresh names its connector (never two identical "Refresh Tasks")', () => {
    const both = connectorCommands([info('connected'), notion('connected', { sources: [db('a')], workspace: 'Acme' })]);
    expect(both.filter((c) => c.action === 'refresh')).toEqual([
      { key: 'connector-refresh-clickup', id: 'clickup', action: 'refresh', label: 'Refresh ClickUp Tasks' },
      { key: 'connector-refresh-notion', id: 'notion', action: 'refresh', label: 'Refresh Notion Tasks' }
    ]);
    expect(connectorCommands([info('offline'), notion('connected', { sources: [db('a')] })]).filter((c) => c.action === 'refresh').map((c) => c.label))
      .toEqual(['Refresh ClickUp Tasks', 'Refresh Notion Tasks']);
    // Only one of them live: the plain label.
    expect(connectorCommands([info('connected'), notion('disconnected')]).filter((c) => c.action === 'refresh').map((c) => c.label)).toEqual(['Refresh Tasks']);
    expect(connectorCommands([info('disconnected'), notion('connected', { sources: [db('a')] })]).filter((c) => c.action === 'refresh').map((c) => c.label)).toEqual(['Refresh Tasks']);
  });
  test('a connector with no source chosen yet (Notion without databases) has nothing to refresh', () => {
    expect(connectorCommands([notion('connected', { sources: [] })]).map((c) => c.label)).toEqual(['Disconnect Notion…']);
    // …and doesn't count as a second live one: ClickUp keeps "Refresh Tasks".
    expect(connectorCommands([info('connected'), notion('connected', { sources: [] })]).map((c) => c.label))
      .toEqual(['Refresh Tasks', 'Disconnect ClickUp…', 'Disconnect Notion…']);
  });

  test('the Disconnect confirm\'s last line: ClickUp\'s own way to revoke; Notion revokes on Disconnect, so where to check', () => {
    expect(revokeHint(info('connected'))).toBe("To also revoke Atelier's access in ClickUp, remove it under ClickUp › Settings › Apps.");
    expect(revokeHint(notion('connected'))).toBe('Atelier also asked Notion to revoke its access. You can check under Notion › Settings › Connections.');
  });

  test('each command names its connector and action', () => {
    expect(connectorCommands([info('reconnect')])).toEqual([
      { key: 'connector-reconnect-clickup', id: 'clickup', action: 'reconnect', label: 'Reconnect ClickUp…' },
      { key: 'connector-disconnect-clickup', id: 'clickup', action: 'disconnect', label: 'Disconnect ClickUp…' }
    ]);
  });
  test('the gear dot: reconnect or unavailable only', () => {
    expect(needsAttention([info('reconnect')])).toBe(true);
    expect(needsAttention([info('unavailable')])).toBe(true);
    for (const s of ['disconnected', 'connecting', 'connected', 'offline'] as const) expect(needsAttention([info(s)])).toBe(false);
    expect(needsAttention([])).toBe(false);
  });
  test('a database Atelier can\'t read needs you too: the dots light up for attention > 0', () => {
    expect(needsAttention([notion('connected', { sources: [db('a', { error: 'unreadable' })], attention: 1 })])).toBe(true);
    expect(needsAttention([notion('connected', { sources: [db('a')], attention: 0 })])).toBe(false);
    expect(attentionConnector([info('connected'), notion('connected', { attention: 2 })])).toBe('notion');
  });
  test('⌘[ is the details page\'s back key, and only the plain chord', () => {
    const k = (extra: Partial<{ key: string; metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean }> = {}) =>
      isConnectorsBackKey({ key: '[', metaKey: true, shiftKey: false, altKey: false, ctrlKey: false, ...extra });
    expect(k()).toBe(true);
    expect(k({ metaKey: false })).toBe(false);
    expect(k({ shiftKey: true })).toBe(false);
    expect(k({ altKey: true })).toBe(false);
    expect(k({ ctrlKey: true })).toBe(false);
    expect(k({ key: ']' })).toBe(false);
  });
  test('the gear dot opens the details of the first connector that needs you', () => {
    expect(attentionConnector([info('connected'), notion('reconnect')])).toBe('notion');
    expect(attentionConnector([info('unavailable'), notion('reconnect')])).toBe('clickup');
    expect(attentionConnector([info('connected')])).toBeNull();
  });
});

describe('Jira among the generic views', () => {
  const jira = (status: ConnectorStatus, extra: Partial<ConnectorInfo> = {}): ConnectorInfo =>
    ({ ...info(status), id: 'jira', name: 'Jira', workspace: 'acme.atlassian.net', ...extra });
  const project = { id: '10001', key: 'ATL', name: 'Atelier', type: 'software' as const, everyone: false, count: 3, loading: false };
  test('no project chosen: nothing to refresh, so no Refresh command', () => {
    expect(connectorCommands([jira('connected', { projects: [] })]).map((c) => c.action)).toEqual(['disconnect']);
    expect(connectorCommands([jira('connected', { projects: [project] })]).map((c) => c.label)).toEqual(['Refresh Tasks', 'Disconnect Jira…']);
  });
  test('two to refresh: Jira\'s names its issues', () => {
    const labels = connectorCommands([info('connected'), jira('connected', { projects: [project] })]).filter((c) => c.action === 'refresh').map((c) => c.label);
    expect(labels).toEqual(['Refresh ClickUp Tasks', 'Refresh Jira Issues']);
  });
  test('Disconnect\'s last line: an API-token connection says where to revoke the token', () => {
    expect(revokeHint(jira('connected'))).toBe('Atelier deletes its copy of the access. To remove it from Atlassian too, open id.atlassian.com › Connected apps.');
    expect(revokeHint(jira('connected', { signIn: 'token' }))).toBe('Atelier deletes its copy of the API token. To revoke the token itself, open id.atlassian.com › Security › API tokens.');
  });
  test('noneChosen: a connector with chosen sources and none yet (Notion\'s databases, Jira\'s projects)', () => {
    expect(noneChosen(jira('connected', { projects: [] }))).toBe(true);
    expect(noneChosen(jira('connected', { projects: [project] }))).toBe(false);
    expect(noneChosen(info('connected'))).toBe(false);
    expect(noneChosen({ ...info('connected'), sources: [] })).toBe(true);
  });
});
