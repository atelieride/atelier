// Where the ClickUp connector talks: https://mcp.clickup.com (OAuth server and MCP endpoint), and only
// there. ATELIER_TEST_CLICKUP_URL (devEnv: inert in the packaged app) swaps it for the local fake ClickUp in tests
// (tests/fixtures/fake-clickup.mjs); only a bare http://127.0.0.1:<port> is taken, anything else is ignored (the rule
// lives in ../endpoint.ts, shared with every connector).
import { devEnv } from '../../dev-env';
import { mcpEndpoint, type McpEndpoint } from '../endpoint';

export const CLICKUP_BASE_URL = 'https://mcp.clickup.com';

export type ClickUpEndpoint = McpEndpoint;

export function clickupEndpoint(override: string | undefined = devEnv('ATELIER_TEST_CLICKUP_URL')): ClickUpEndpoint {
  return mcpEndpoint({ base: CLICKUP_BASE_URL, name: 'ClickUp', scope: 'read', ...(override !== undefined ? { override } : {}) });
}
