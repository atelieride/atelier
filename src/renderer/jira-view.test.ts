import { describe, expect, test } from 'vitest';
import type { Automation } from '@shared/automations';
import type { ConnectorInfo, ConnectorStatus, ProjectInfo, SourcePick } from '@shared/tasks';
import {
  API_TOKENS_PAGE, automationServiceKeys, filterChoices, filterValue, jiraAddErrorText, jiraLinkRef, jiraPickerRows, jiraRow, jiraSearchDelay, jiraView,
  opensTokenForm, projectSubLine, projectTypeLabel, serviceScopeKeys, tokenCreds, tokenDraftFor, tokenFormError, tokenFormMessage
} from './jira-view';

const NOW = new Date(2026, 9, 20, 10, 50, 0).getTime();
const ATL: ProjectInfo = { id: '10001', key: 'ATL', name: 'Atelier', type: 'software', everyone: false, count: 7, loading: false };
const SUP: ProjectInfo = { id: '10003', key: 'SUP', name: 'Customer Support', type: 'service_desk', everyone: true, count: 2, loading: false };
const jira = (status: ConnectorStatus, extra: Partial<ConnectorInfo> = {}): ConnectorInfo => ({
  id: 'jira', name: 'Jira', status, loading: false, tasksVersion: 1, options: { show: 'assigned', includeClosed: false },
  ...(status === 'connected' ? { account: 'Ada Lovelace', workspace: 'acme.atlassian.net' } : {}), ...extra
});
const ids = (v: { actions: { id: string; primary: boolean }[] }) => v.actions.map((a) => `${a.id}${a.primary ? '*' : ''}`);

describe('jiraRow: the Connectors list row', () => {
  test('connected with no project: the violet "Choose projects" chip and who is connected', () => {
    expect(jiraRow(jira('connected', { projects: [] }), NOW)).toEqual({
      chip: { tone: 'setup', label: 'Choose projects' }, line: 'Connected as Ada Lovelace · no projects chosen yet'
    });
  });
  test('connected with projects: how many, the open issues and when, the green chip with the site', () => {
    const r = jiraRow(jira('connected', { projects: [ATL, SUP], updatedAt: NOW - 2 * 60_000 }), NOW);
    expect(r.chip).toEqual({ tone: 'ok', label: 'Connected · acme.atlassian.net' });
    expect(r.line).toBe('2 projects · 9 open issues · updated 2 min ago');
    expect(jiraRow(jira('connected', { projects: [ATL] }), NOW).line).toBe('1 project · 7 open issues');
    // Done issues included: they are issues, not open ones.
    expect(jiraRow(jira('connected', { projects: [ATL], options: { show: 'assigned', includeClosed: true } }), NOW).line).toBe('1 project · 7 issues');
  });
  test('a project Atelier can no longer read: the amber "1 project needs attention"', () => {
    const gone = { ...ATL, error: 'unreadable' as const, count: undefined };
    expect(jiraRow(jira('connected', { projects: [gone, SUP], attention: 1 }), NOW).chip).toEqual({ tone: 'warn', label: '1 project needs attention' });
    expect(jiraRow(jira('connected', { projects: [gone, { ...SUP, error: 'unreadable' }], attention: 2 }), NOW).chip?.label).toBe('2 projects need attention');
  });
  test('every other state is the generic row', () => {
    expect(jiraRow(jira('disconnected'), NOW)).toMatchObject({ chip: null, line: 'Start sessions from the Jira issues in projects you choose.', action: { id: 'connect' } });
    expect(jiraRow(jira('reconnect', { workspace: 'acme.atlassian.net' }), NOW).chip).toEqual({ tone: 'warn', label: 'Signed out' });
  });
});

describe('jiraView: the details\' status block (9)', () => {
  test('connected with no project: violet, who and where, what to do next, Disconnect only', () => {
    const v = jiraView(jira('connected', { projects: [] }), NOW);
    expect(v).toMatchObject({ tone: 'setup', line: 'Connected as Ada Lovelace · acme.atlassian.net', sub: 'Now choose the projects Atelier may read.' });
    expect(ids(v)).toEqual(['disconnect*']);
  });
  test('connected with projects: the generic block (Disconnect, Refresh)', () => {
    expect(ids(jiraView(jira('connected', { projects: [ATL] }), NOW))).toEqual(['disconnect*', 'refresh']);
  });
  test('connecting in the browser: Atlassian\'s errors never come back, so the line says to cancel and retry', () => {
    const v = jiraView(jira('connecting', { connectingUntil: NOW + 300_000 }), NOW);
    expect(v).toMatchObject({ tone: 'busy', line: 'Waiting for you in the browser…', countdown: '5:00', sub: 'If Atlassian shows an error, cancel and try again.' });
  });
  test('connecting with an API token: no browser, so no countdown, no "open the page again", only Cancel', () => {
    const v = jiraView(jira('connecting', { connectingUntil: NOW + 300_000 }), NOW, { tokenFlow: true });
    expect(v).toEqual({ tone: 'busy', line: 'Checking the API token…', actions: [expect.objectContaining({ id: 'cancel', primary: true })] });
  });
  test('the token form open: an attempt\'s error is said in the form, not twice', () => {
    const refused = jira('disconnected', { reason: 'token-refused' });
    expect(jiraView(refused, NOW).sub).toBe('Jira refused this API token. Check the e-mail, the site, and that the token is for the Atlassian MCP V2 app.');
    expect(jiraView(refused, NOW, { tokenForm: true }).sub).toBeUndefined();
  });
});

describe('projectSubLine: a project row\'s second line', () => {
  test('"Assigned to me · 6 open" / "Everyone · 14 open"', () => {
    expect(projectSubLine({ ...ATL, count: 6 }, { includeClosed: false })).toBe('Assigned to me · 6 open');
    expect(projectSubLine({ ...SUP, count: 14 }, { includeClosed: false })).toBe('Everyone · 14 open');
  });
  test('"Loading…" while listed or while a scope change waits for its refresh; no count yet: who only', () => {
    expect(projectSubLine({ ...ATL, loading: true }, { includeClosed: false })).toBe('Loading…');
    expect(projectSubLine(ATL, { includeClosed: false, saving: true })).toBe('Loading…');
    expect(projectSubLine({ ...ATL, count: undefined }, { includeClosed: false })).toBe('Assigned to me');
    expect(projectSubLine({ ...ATL, count: 1 }, { includeClosed: true })).toBe('Assigned to me · 1 issue');
  });
  test('type labels', () => {
    expect(['software', 'business', 'service_desk', 'other'].map((x) => projectTypeLabel(x as ProjectInfo['type']))).toEqual(['Software', 'Business', 'Service', 'Other']);
  });
});

describe('the picker', () => {
  const picks: SourcePick[] = [
    { id: '10001', key: 'ATL', name: 'Atelier', kind: 'software', added: true },
    { id: '10003', key: 'SUP', name: 'Customer Support', kind: 'service_desk', added: false }
  ];
  test('a pasted link or an issue key is one "Add this project" row; a word is a search', () => {
    expect(jiraLinkRef('https://acme.atlassian.net/browse/ATL-3')).toBe('https://acme.atlassian.net/browse/ATL-3');
    expect(jiraLinkRef('  https://acme.atlassian.net/jira/software/projects/WEB/boards/1 ')).toBe('https://acme.atlassian.net/jira/software/projects/WEB/boards/1');
    expect(jiraLinkRef('atl-12')).toBe('ATL-12');
    expect(jiraLinkRef('ATL')).toBeNull();
    expect(jiraLinkRef('Customer support')).toBeNull();
    expect(jiraLinkRef('')).toBeNull();
    expect(jiraPickerRows('https://acme.atlassian.net/browse/ATL-3', picks)).toEqual([{ kind: 'link', key: 'link', ref: 'https://acme.atlassian.net/browse/ATL-3' }]);
    expect(jiraPickerRows('su', picks).map((r) => r.key)).toEqual(['10001', '10003']);
  });
  test('the empty field lists the first projects at once; typing waits for a pause; a link never searches', () => {
    expect(jiraSearchDelay('')).toBe(0);
    expect(jiraSearchDelay('  ')).toBe(0);
    expect(jiraSearchDelay('a')).toBe(250);
    expect(jiraSearchDelay('ATL-3')).toBeNull();
    expect(jiraSearchDelay('https://acme.atlassian.net/browse/ATL-3')).toBeNull();
  });
  test('why a project wasn\'t added, in one line', () => {
    expect(jiraAddErrorText('not-found')).toBe('No project with that key on this site.');
    expect(jiraAddErrorText('other-site')).toBe('That link is from another Jira site.');
    expect(jiraAddErrorText('not-database')).toBe("That isn't a Jira project link.");
    expect(jiraAddErrorText('too-many')).toBe('At most 20 projects.');
    expect(jiraAddErrorText('offline')).toBe("Can't reach Jira. Check your connection.");
    expect(jiraAddErrorText('failed')).toBe("Couldn't add that project. Try again.");
    expect(jiraAddErrorText('unsupported')).toBe("Couldn't add that project. Try again.");
  });
});

describe('the saved filter', () => {
  test('its name, or None', () => {
    expect(filterValue(jira('connected'))).toBe('None');
    expect(filterValue(jira('connected', { filter: { id: '10040', name: 'My open bugs' } }))).toBe('My open bugs');
  });
  test('the menu: None first, then the user\'s filters, the chosen one checked; none saved says so', () => {
    const filters = [{ id: '10040', name: 'My open bugs' }, { id: '10041', name: 'Website polish' }];
    expect(filterChoices(filters, jira('connected', { filter: { id: '10041', name: 'Website polish' } }))).toEqual([
      { id: null, label: 'None', on: false }, { id: '10040', label: 'My open bugs', on: false }, { id: '10041', label: 'Website polish', on: true }
    ]);
    expect(filterChoices(filters, jira('connected'))[0]).toEqual({ id: null, label: 'None', on: true });
    expect(filterChoices([], jira('connected'))).toEqual([{ id: null, label: 'None', on: true }, 'none-left']);
  });
});

describe('the API-token sign-in', () => {
  test('the token page is Atlassian\'s own', () => {
    // Atlassian's own link for the Rovo MCP server: the "Atlassian MCP V2" app, its scopes, the longest expiry.
    expect(API_TOKENS_PAGE).toBe('https://id.atlassian.com/manage-profile/security/api-tokens?appId=mcp-v2&expiryDays=max&selectedScopes=all');
  });
  test('starts empty; a Reconnect after an expired token starts from the e-mail and the site (never a secret)', () => {
    expect(tokenDraftFor(jira('disconnected'))).toEqual({ site: '', user: '', secret: '' });
    expect(tokenDraftFor(jira('reconnect', { reason: 'token-expired', signIn: 'token', tokenUser: 'ada@example.com', workspace: 'acme.atlassian.net' })))
      .toEqual({ site: 'acme.atlassian.net', user: 'ada@example.com', secret: '' });
  });
  test('Reconnect opens the form for a token connection, the browser otherwise', () => {
    expect(opensTokenForm(jira('reconnect', { signIn: 'token', reason: 'token-expired' }))).toBe(true);
    expect(opensTokenForm(jira('reconnect', { reason: 'token-expired' }))).toBe(true);
    expect(opensTokenForm(jira('reconnect', { reason: 'signed-out', workspace: 'acme.atlassian.net' }))).toBe(false);
    expect(opensTokenForm({ ...jira('reconnect', { signIn: 'token' }), id: 'clickup' })).toBe(false);
  });
  test('checked before sending, as main\'s schema would: a Jira Cloud site, an e-mail, a whole token', () => {
    const ok = { site: 'acme.atlassian.net', user: 'ada@example.com', secret: 'ATATT3xFfGF0abcdefghij' };
    expect(tokenFormError(ok)).toBeNull();
    expect(tokenFormError({ ...ok, site: 'https://acme.atlassian.net/' })).toBeNull();
    expect(tokenFormError({ ...ok, site: '' })).toBe('site');
    expect(tokenFormError({ ...ok, site: 'acme.example.com' })).toBe('site');
    expect(tokenFormError({ ...ok, site: 'acme.atlassian.net:8443' })).toBe('site');
    expect(tokenFormError({ ...ok, user: 'ada' })).toBe('user');
    expect(tokenFormError({ ...ok, user: 'a:b@example.com' })).toBe('user');
    expect(tokenFormError({ ...ok, secret: 'short' })).toBe('secret');
    expect(tokenFormError({ ...ok, secret: 'has a space in the middle' })).toBe('secret');
  });
  test('what is sent: trimmed, the site as typed without its scheme or slash', () => {
    expect(tokenCreds({ site: ' https://ACME.atlassian.net/ ', user: ' ada@example.com ', secret: ' ATATT3xFfGF0abcdefghij\n' }))
      .toEqual({ site: 'acme.atlassian.net', user: 'ada@example.com', secret: 'ATATT3xFfGF0abcdefghij' });
  });
  test('the form\'s error line: what the last attempt ran into, only once one was sent', () => {
    expect(tokenFormMessage(jira('disconnected', { reason: 'token-refused' }), false)).toBeNull();
    expect(tokenFormMessage(jira('disconnected', { reason: 'token-scopes' }), true)).toBe("This API token can't read Jira: create one with scopes for the Atlassian MCP V2 app.");
    expect(tokenFormMessage(jira('disconnected', { reason: 'token-refused' }), true)).toBe('Jira refused this API token. Check the e-mail, the site, and that the token is for the Atlassian MCP V2 app.');
    expect(tokenFormMessage(jira('disconnected', { reason: 'token-site' }), true)).toBe("That site isn't a Jira Cloud site this account can open. Check its name.");
    expect(tokenFormMessage(jira('disconnected', { reason: 'network' }), true)).toBe("Can't reach Jira. Check your connection.");
    expect(tokenFormMessage(jira('disconnected'), true)).toBeNull();
    expect(tokenFormMessage(jira('connecting', { reason: 'token-refused' }), true)).toBeNull();
  });
});

describe('service projects in automations', () => {
  const auto = (scopes: string[], conditions: Automation['conditions'] = []): Pick<Automation, 'source' | 'conditions'> =>
    ({ source: { connector: 'jira', scopes }, conditions });
  test('the keys of the service projects an automation watches', () => {
    expect(serviceScopeKeys(['10001', '10003'], [ATL, SUP])).toEqual(['SUP']);
    expect(serviceScopeKeys(['10001'], [ATL, SUP])).toEqual([]);
    // A scope whose project isn't listed (removed meanwhile) says nothing here; main still checks.
    expect(serviceScopeKeys(['10009'], [ATL, SUP])).toEqual([]);
  });
  test('blocked until Created by names people: then nothing to say', () => {
    const c = [jira('connected', { projects: [ATL, SUP] })];
    expect(automationServiceKeys(auto(['10003']), c)).toEqual(['SUP']);
    expect(automationServiceKeys(auto(['10003'], [{ field: 'createdBy', values: [] }]), c)).toEqual(['SUP']);
    expect(automationServiceKeys(auto(['10003'], [{ field: 'createdBy', values: ['me'] }]), c)).toEqual([]);
    expect(automationServiceKeys(auto(['10001']), c)).toEqual([]);
    // Another source never is.
    expect(automationServiceKeys({ ...auto(['10003']), source: { connector: 'clickup', scopes: ['10003'] } }, c)).toEqual([]);
  });
});
