import { describe, expect, test } from 'vitest';
import { InvalidArguments, NotAllowed, SchemaChanged } from '../errors';
import { ALLOWED_TOOLS, JIRA_TOOLS } from './tools';
import { jiraEndpoint } from './config';

// The six read tools, strict arguments, both reply envelopes, no e-mails kept.

const CLOUD = '3f2a9c4e-8b1d-4e7a-9c56-0d2e8f4b7a13';
const person = { accountId: '712020:0f6c2b8e', displayName: 'Ada Lovelace', emailAddress: 'ada@example.com', avatarUrls: { '48x48': 'https://secure.gravatar.com/x' } };
const rawIssue = {
  id: '10103', key: 'ATL-3', self: 'https://api.atlassian.com/x',
  fields: {
    summary: 'Billing export', project: { id: '10001', key: 'ATL', name: 'Atelier', projectTypeKey: 'software', avatarUrls: {} },
    status: { name: 'To Do', statusCategory: { id: 2, key: 'new', colorName: 'blue-gray', name: 'To Do' } },
    assignee: person, creator: person, reporter: person, duedate: null, priority: { name: 'High', iconUrl: 'x' }, labels: ['claude'], description: 'Hi'
  }
};

describe('the allowlist', () => {
  test('exactly the six read tools; listJiraFilters is the only optional one', () => {
    expect([...ALLOWED_TOOLS].sort()).toEqual(['getAccessibleAtlassianResources', 'getJiraCurrentUser', 'getJiraIssue', 'listJiraFilters', 'listJiraProjects', 'searchJiraIssuesUsingJql']);
    expect([...JIRA_TOOLS.required].sort()).toEqual(['getAccessibleAtlassianResources', 'getJiraCurrentUser', 'getJiraIssue', 'listJiraProjects', 'searchJiraIssuesUsingJql']);
  });

  test('write and meta tools are refused before any argument is read', () => {
    for (const name of ['createJiraIssue', 'editJiraIssue', 'transitionJiraIssue', 'addOrEditJiraIssueComment', 'discover', 'executeRead', 'executeWrite', 'executeDestructive', 'search', 'fetch']) {
      expect(JIRA_TOOLS.isAllowed(name), name).toBe(false);
      expect(() => JIRA_TOOLS.parseArgs(name as never, {}), name).toThrow(NotAllowed);
    }
  });
});

describe('arguments', () => {
  const ok = { cloudId: CLOUD, jql: 'project in (10001) ORDER BY updated DESC', fields: ['summary'], maxResults: 100, view: 'full' };
  test('the search takes only bounded JQL, known fields, ≤ 100 results, the full view', () => {
    expect(JIRA_TOOLS.parseArgs('searchJiraIssuesUsingJql', ok)).toEqual(ok);
    for (const bad of [
      { ...ok, jql: 'ORDER BY updated DESC' }, { ...ok, jql: 'text ~ "x"' }, { ...ok, fields: ['*all'] }, { ...ok, fields: ['customfield_10010'] },
      { ...ok, maxResults: 101 }, { ...ok, view: 'compact' }, { ...ok, view: undefined }, { ...ok, cloudId: 'https://evil.example' }, { ...ok, responseContentFormat: 'html' }
    ]) expect(() => JIRA_TOOLS.parseArgs('searchJiraIssuesUsingJql', bad), JSON.stringify(bad)).toThrow(InvalidArguments);
  });

  test('cloud ids: a uuid or a Jira site URL, nothing else', () => {
    expect(JIRA_TOOLS.parseArgs('getJiraCurrentUser', { cloudId: CLOUD })).toEqual({ cloudId: CLOUD });
    expect(JIRA_TOOLS.parseArgs('getJiraCurrentUser', { cloudId: 'https://acme.atlassian.net' })).toEqual({ cloudId: 'https://acme.atlassian.net' });
    for (const bad of ['acme', 'https://acme.atlassian.net/', 'https://evil.example', '']) expect(() => JIRA_TOOLS.parseArgs('getJiraCurrentUser', { cloudId: bad }), bad).toThrow();
  });

  test('getJiraIssue: a numeric id or a key, Markdown, fields by key, the full view', () => {
    const a = { cloudId: CLOUD, issueIdOrKey: '10103', fields: ['summary', 'description'], fieldsByKeys: true, responseContentFormat: 'markdown', view: 'full' };
    expect(() => JIRA_TOOLS.parseArgs('getJiraIssue', { ...a, view: 'evidence' })).toThrow(InvalidArguments);
    expect(JIRA_TOOLS.parseArgs('getJiraIssue', a)).toEqual(a);
    expect(JIRA_TOOLS.parseArgs('getJiraIssue', { ...a, issueIdOrKey: 'ATL-3' }).issueIdOrKey).toBe('ATL-3');
    for (const bad of ['https://acme.atlassian.net/browse/ATL-3', 'ATL', 'atl-3', '../x']) expect(() => JIRA_TOOLS.parseArgs('getJiraIssue', { ...a, issueIdOrKey: bad }), bad).toThrow();
  });
});

describe('replies', () => {
  test('a search in Atelier\'s envelope: issues and the next page; e-mails and avatars dropped', () => {
    const r = JIRA_TOOLS.parseReply('searchJiraIssuesUsingJql', { data: { nextPageToken: 'p2', isLast: false, appliedContentFormat: 'markdown', issues: [rawIssue] } });
    expect(r.next).toBe('p2');
    expect(r.issues).toHaveLength(1);
    expect(JSON.stringify(r)).not.toMatch(/ada@example\.com|gravatar|avatarUrls|self|reporter/);
    expect(r.issues[0]!.fields.assignee).toEqual({ accountId: '712020:0f6c2b8e', displayName: 'Ada Lovelace' });
    expect(JIRA_TOOLS.parseReply('searchJiraIssuesUsingJql', { data: { isLast: true, nextPageToken: 'x', issues: [] } }).next).toBeUndefined();
  });

  test('a search in Claude Code\'s envelope (nodes + pageInfo) reads the same', () => {
    const r = JIRA_TOOLS.parseReply('searchJiraIssuesUsingJql', { issues: { nodes: [{ ...rawIssue, webUrl: 'https://evil.example' }], pageInfo: { hasNextPage: true, endCursor: 'c2' } } });
    expect(r.issues.map((i) => i.key)).toEqual(['ATL-3']);
    expect(r.next).toBe('c2');
    expect(JSON.stringify(r)).not.toContain('evil.example');
  });

  test('a malformed issue is skipped; a list with none valid → SchemaChanged; no issues key → SchemaChanged', () => {
    const r = JIRA_TOOLS.parseReply('searchJiraIssuesUsingJql', { data: { issues: [rawIssue, { id: 'x', key: 'nope', fields: {} }] } });
    expect(r.issues).toHaveLength(1);
    expect(() => JIRA_TOOLS.parseReply('searchJiraIssuesUsingJql', { data: { issues: [{ id: 'x' }] } })).toThrow(SchemaChanged);
    expect(() => JIRA_TOOLS.parseReply('searchJiraIssuesUsingJql', { data: { results: [] } })).toThrow(SchemaChanged);
  });

  test('one issue, both envelopes; its format kept', () => {
    expect(JIRA_TOOLS.parseReply('getJiraIssue', { data: { appliedContentFormat: 'html', ...rawIssue } })).toMatchObject({ key: 'ATL-3', appliedContentFormat: 'html' });
    expect(JIRA_TOOLS.parseReply('getJiraIssue', { issues: { nodes: [rawIssue] } }).key).toBe('ATL-3');
  });

  test('resources, the user, projects, filters', () => {
    expect(JIRA_TOOLS.parseReply('getAccessibleAtlassianResources', { data: { resources: [{ cloudId: CLOUD, url: 'https://acme.atlassian.net', products: [{ id: 'jira', access: 'read-write' }] }] } }).resources[0])
      .toEqual({ cloudId: CLOUD, url: 'https://acme.atlassian.net', products: [{ id: 'jira' }] });
    expect(JIRA_TOOLS.parseReply('getJiraCurrentUser', { data: { ...person, locale: 'en_GB' } })).toEqual({ accountId: '712020:0f6c2b8e', displayName: 'Ada Lovelace' });
    expect(JIRA_TOOLS.parseReply('listJiraProjects', { data: { values: [{ id: '10003', key: 'SUP', name: 'Support', projectTypeKey: 'service_desk', style: 'classic' }], isLast: true } }).values)
      .toEqual([{ id: '10003', key: 'SUP', name: 'Support', projectTypeKey: 'service_desk' }]);
    expect(JIRA_TOOLS.parseReply('listJiraFilters', { data: { values: [{ id: 10040, name: 'Mine', jql: 'x', owner: person }] } }).values).toEqual([{ id: '10040', name: 'Mine' }]);
  });
});

describe('the endpoint', () => {
  test('Rovo MCP v2 with ?tools=all, the auth origin, the CIMD client and its ports, no scope', () => {
    const e = jiraEndpoint('', '');
    expect(e).toMatchObject({
      base: 'https://mcp.atlassian.com', mcpUrl: 'https://mcp.atlassian.com/v2/mcp?tools=all', resource: 'https://mcp.atlassian.com/v2/mcp',
      authBase: 'https://auth.atlassian.com', discovery: 'protected-resource', issInCallback: 'when-advertised', test: false, name: 'Jira'
    });
    expect(e.client).toEqual({ kind: 'cimd', id: 'https://useatelier.dev/oauth/client.json', ports: [47215, 47216, 47217] });
    expect(e.scope).toBeUndefined();
  });
});
