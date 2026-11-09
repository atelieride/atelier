import { afterEach, beforeEach, expect, test } from 'vitest';
import type { ConnectorInfo, ConnectorStatus } from '@shared/tasks';
import { useApp } from './store';
import { runConnectorCommand } from './connector-actions';
import { connectorCommands } from './connectors-view';

const info = (status: ConnectorStatus, extra: Partial<ConnectorInfo> = {}): ConnectorInfo => ({
  id: 'clickup', name: 'ClickUp', status, loading: false, tasksVersion: 0, options: { show: 'assigned', includeClosed: false }, ...extra
});

const g = globalThis as { window?: unknown };
let calls: string[] = [];
beforeEach(() => {
  calls = [];
  const record = (name: string) => (id: string) => { calls.push(`${name}:${id}`); return Promise.resolve(info('connecting')); };
  g.window = { atelier: { connectors: { connect: record('connect'), refresh: record('refresh'), cancel: record('cancel'), reopenAuth: record('reopen'), disconnect: record('disconnect') } } };
  useApp.setState({ connectors: [], connectorConfirm: null, connectorDetail: null, settingsOpen: null });
});
afterEach(() => { delete g.window; useApp.setState({ connectors: [], settingsOpen: null, connectorDetail: null }); });

const run = (label: string) => {
  const cmd = connectorCommands(useApp.getState().connectors).find((c) => c.label === label);
  expect(cmd, label).toBeDefined();
  runConnectorCommand(cmd!);
};

test('Refresh Tasks while connected works in the background: Settings stays closed', () => {
  useApp.setState({ connectors: [info('connected', { workspace: 'Acme' })] });
  run('Refresh Tasks');
  expect(calls).toEqual(['refresh:clickup']);
  expect(useApp.getState().settingsOpen).toBeNull();
});

test('unavailable with nothing saved: "Connect ClickUp…" opens Settings › Connectors (countdown and Cancel visible), then connects', () => {
  useApp.setState({ connectors: [info('unavailable', { reason: 'auth-unsupported' })] });
  run('Connect ClickUp…');
  expect(useApp.getState().settingsOpen).toBe('connectors');
  // On that connector's details page.
  expect(useApp.getState().connectorDetail).toBe('clickup');
  expect(calls).toEqual(['connect:clickup']);
});

test('"Disconnect ClickUp…" opens its details page with the confirm open there', () => {
  useApp.setState({ connectors: [info('connected', { workspace: 'Acme' })] });
  run('Disconnect ClickUp…');
  expect(useApp.getState()).toMatchObject({ settingsOpen: 'connectors', connectorDetail: 'clickup', connectorConfirm: 'clickup' });
  expect(calls).toEqual([]);
});

test('Reconnect on a Jira API-token connection opens the token form on its details, never the browser', () => {
  const jira = info('reconnect', { id: 'jira', name: 'Jira', reason: 'token-expired', signIn: 'token', tokenUser: 'ada@example.com', workspace: 'acme.atlassian.net' });
  useApp.setState({ connectors: [jira], connectorTokenForm: null });
  run('Reconnect Jira…');
  expect(useApp.getState()).toMatchObject({ settingsOpen: 'connectors', connectorDetail: 'jira', connectorTokenForm: 'jira' });
  expect(calls).toEqual([]);
  // An OAuth one still signs in in the browser.
  useApp.setState({ connectors: [{ ...jira, reason: 'signed-out', signIn: undefined }], connectorTokenForm: null });
  run('Reconnect Jira…');
  expect(calls).toEqual(['connect:jira']);
  expect(useApp.getState().connectorTokenForm).toBeNull();
});

test('the token form belongs to its details page: another connector or the list closes it', () => {
  useApp.setState({ settingsOpen: 'connectors', connectorDetail: 'jira', connectorTokenForm: 'jira' });
  useApp.getState().openConnector('notion');
  expect(useApp.getState().connectorTokenForm).toBeNull();
  useApp.setState({ connectorDetail: 'jira', connectorTokenForm: 'jira' });
  useApp.getState().setSettingsOpen(null);
  expect(useApp.getState().connectorTokenForm).toBeNull();
});

test('Refresh Tasks on an unavailable connector goes on in Settings › Connectors: whatever it turns into is on the card', () => {
  useApp.setState({ connectors: [info('unavailable', { reason: 'connector-changed', workspace: 'Acme' })] });
  run('Refresh Tasks');
  expect(useApp.getState().settingsOpen).toBe('connectors');
  expect(calls).toEqual(['refresh:clickup']);
});
