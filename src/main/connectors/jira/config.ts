// Where the Jira connector talks: Atlassian's Rovo MCP v2 at https://mcp.atlassian.com
// (`/v2/mcp?tools=all`: the flat tool list, without the discover/execute family) and its authorization server at
// https://auth.atlassian.com, found through the protected resource's metadata (a path issuer). The client is Atelier's
// Client ID Metadata Document on useatelier.dev (site/public/oauth/client.json), which lists the loopback ports below.
// No scope is sent (Atlassian refuses every scope parameter) and the callback carries no `iss`.
//
// ATELIER_TEST_JIRA_URL / ATELIER_TEST_JIRA_AUTH_URL (devEnv: inert in the packaged app) swap both origins for the local
// fake Jira (tests/fixtures/fake-jira.mjs); only bare http://127.0.0.1:<port> origins are taken (../endpoint.ts).
import { devEnv } from '../../dev-env';
import { mcpEndpoint, type McpEndpoint } from '../endpoint';

export const JIRA_BASE_URL = 'https://mcp.atlassian.com';
export const JIRA_AUTH_URL = 'https://auth.atlassian.com';
/** Atelier's OAuth client: the URL is the client id (CIMD). */
export const ATELIER_CLIENT_ID = 'https://useatelier.dev/oauth/client.json';
/** The loopback ports the client document lists (with `/callback`), tried in order. */
export const CALLBACK_PORTS: readonly number[] = Object.freeze([47215, 47216, 47217]);

export type JiraEndpoint = McpEndpoint;

export function jiraEndpoint(
  override: string | undefined = devEnv('ATELIER_TEST_JIRA_URL'),
  authOverride: string | undefined = devEnv('ATELIER_TEST_JIRA_AUTH_URL')
): JiraEndpoint {
  return mcpEndpoint({
    base: JIRA_BASE_URL, name: 'Jira', mcpPath: '/v2/mcp', mcpQuery: '?tools=all', authBase: JIRA_AUTH_URL,
    discovery: 'protected-resource', client: { kind: 'cimd', id: ATELIER_CLIENT_ID, ports: CALLBACK_PORTS }, issInCallback: 'when-advertised',
    ...(override !== undefined ? { override } : {}), ...(authOverride !== undefined ? { authOverride } : {})
  });
}
