import { expect, test } from 'vitest';
import { mcpEndpoint } from './endpoint';

test('a connector endpoint is its https origin, its /mcp URL and a one-origin allowlist', () => {
  const e = mcpEndpoint({ base: 'https://mcp.notion.com', name: 'Notion' });
  expect(e).toMatchObject({ base: 'https://mcp.notion.com', mcpUrl: 'https://mcp.notion.com/mcp', test: false, name: 'Notion' });
  expect(e.scope).toBeUndefined();
  expect(e.allow(new URL('https://mcp.notion.com/token'))).toBe(true);
  expect(e.allow(new URL('https://www.notion.so/'))).toBe(false);
  expect(e.allow(new URL('http://mcp.notion.com/token'))).toBe(false);
});

test('the scope is carried when the connector asks for one', () => {
  expect(mcpEndpoint({ base: 'https://mcp.clickup.com', name: 'ClickUp', scope: 'read' }).scope).toBe('read');
});

test('a bare http://127.0.0.1:<port> override replaces the base (tests), anything else is ignored', () => {
  const local = mcpEndpoint({ base: 'https://mcp.notion.com', name: 'Notion', override: 'http://127.0.0.1:4567' });
  expect(local).toMatchObject({ base: 'http://127.0.0.1:4567', mcpUrl: 'http://127.0.0.1:4567/mcp', test: true });
  expect(local.allow(new URL('http://127.0.0.1:4567/token'))).toBe(true);
  for (const bad of ['https://attacker.example', 'http://127.0.0.1', 'http://127.0.0.1:4567/path', 'http://u:p@127.0.0.1:4567', 'http://localhost:4567', '']) {
    const e = mcpEndpoint({ base: 'https://mcp.notion.com', name: 'Notion', override: bad });
    expect(e).toMatchObject({ base: 'https://mcp.notion.com', test: false });
  }
});

// Atlassian's authorization server lives on its own origin, the MCP URL carries a query,
// discovery starts from the protected resource and the client is a Client ID Metadata Document.
const jiraLike = (o: Partial<Parameters<typeof mcpEndpoint>[0]> = {}) => mcpEndpoint({
  base: 'https://mcp.atlassian.com', name: 'Jira', mcpPath: '/v2/mcp', mcpQuery: '?tools=all', authBase: 'https://auth.atlassian.com',
  discovery: 'protected-resource', client: { kind: 'cimd', id: 'https://useatelier.dev/oauth/client.json', ports: [47215, 47216, 47217] },
  issInCallback: 'when-advertised', ...o
});

test('a separate authorization origin: both origins allowed, nothing else', () => {
  const e = jiraLike();
  expect(e).toMatchObject({
    base: 'https://mcp.atlassian.com', mcpUrl: 'https://mcp.atlassian.com/v2/mcp?tools=all', resource: 'https://mcp.atlassian.com/v2/mcp',
    authBase: 'https://auth.atlassian.com', discovery: 'protected-resource', issInCallback: 'when-advertised', test: false
  });
  expect(e.client).toEqual({ kind: 'cimd', id: 'https://useatelier.dev/oauth/client.json', ports: [47215, 47216, 47217] });
  expect(e.allow(new URL('https://mcp.atlassian.com/v2/mcp'))).toBe(true);
  expect(e.allow(new URL('https://auth.atlassian.com/oauth/token'))).toBe(true);
  for (const bad of ['https://acme.atlassian.net/', 'https://api.atlassian.com/', 'http://auth.atlassian.com/', 'https://u:p@auth.atlassian.com/', 'https://useatelier.dev/oauth/client.json']) {
    expect(e.allow(new URL(bad)), bad).toBe(false);
  }
});

test('without the new options an endpoint is exactly as before (ClickUp, Notion)', () => {
  const e = mcpEndpoint({ base: 'https://mcp.notion.com', name: 'Notion' });
  expect(e.resource).toBe('https://mcp.notion.com/mcp');
  expect(e.authBase).toBeUndefined();
  expect(e.discovery).toBeUndefined();
  expect(e.client).toBeUndefined();
  expect(e.issInCallback).toBeUndefined();
});

test('test overrides: both loopback origins replace both bases, a CIMD client binds any port', () => {
  const e = jiraLike({ override: 'http://127.0.0.1:4567', authOverride: 'http://127.0.0.1:4568' });
  expect(e).toMatchObject({ base: 'http://127.0.0.1:4567', mcpUrl: 'http://127.0.0.1:4567/v2/mcp?tools=all', resource: 'http://127.0.0.1:4567/v2/mcp', authBase: 'http://127.0.0.1:4568', test: true });
  expect(e.client).toEqual({ kind: 'cimd', id: 'https://useatelier.dev/oauth/client.json', ports: [0] });
  expect(e.allow(new URL('http://127.0.0.1:4568/oauth/token'))).toBe(true);
  expect(e.allow(new URL('https://auth.atlassian.com/oauth/token'))).toBe(false);
  // Only the resource origin overridden: the authorization server is the same fake.
  expect(jiraLike({ override: 'http://127.0.0.1:4567' }).authBase).toBe('http://127.0.0.1:4567');
  // A bad auth override is ignored like a bad override: the real origins stay.
  const real = jiraLike({ authOverride: 'https://attacker.example' });
  expect(real).toMatchObject({ base: 'https://mcp.atlassian.com', authBase: 'https://auth.atlassian.com', test: false });
});

test('an authorization base must be https', () => {
  expect(() => jiraLike({ authBase: 'http://auth.atlassian.com' })).toThrow();
});
