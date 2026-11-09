// Where the Notion connector talks: https://mcp.notion.com (OAuth server and MCP endpoint), and
// only there. ATELIER_TEST_NOTION_URL (devEnv: inert in the packaged app) swaps it for the local fake Notion in tests
// (tests/fixtures/fake-notion.mjs); only a bare http://127.0.0.1:<port> is taken (the rule lives in ../endpoint.ts).
// Notion defines no OAuth scopes, so none is asked for.
import { devEnv } from '../../dev-env';
import { mcpEndpoint, type McpEndpoint } from '../endpoint';

export const NOTION_BASE_URL = 'https://mcp.notion.com';

export type NotionEndpoint = McpEndpoint;

export function notionEndpoint(override: string | undefined = devEnv('ATELIER_TEST_NOTION_URL')): NotionEndpoint {
  return mcpEndpoint({ base: NOTION_BASE_URL, name: 'Notion', ...(override !== undefined ? { override } : {}) });
}
