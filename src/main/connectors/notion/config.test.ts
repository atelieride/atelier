import { describe, expect, test } from 'vitest';
import { NOTION_BASE_URL, notionEndpoint } from './config';

describe('notionEndpoint', () => {
  test('talks to mcp.notion.com only, with no OAuth scope', () => {
    expect(NOTION_BASE_URL).toBe('https://mcp.notion.com');
    const e = notionEndpoint(''); // explicit: never the ambient env
    expect(e.base).toBe('https://mcp.notion.com');
    expect(e.mcpUrl).toBe('https://mcp.notion.com/mcp');
    expect(e.name).toBe('Notion');
    expect(e.scope).toBeUndefined();
    expect(e.test).toBe(false);
    expect(e.allow(new URL('https://mcp.notion.com/mcp'))).toBe(true);
    expect(e.allow(new URL('https://evil.test/mcp'))).toBe(false);
    expect(e.allow(new URL('http://mcp.notion.com/mcp'))).toBe(false);
  });

  test('only a bare loopback override is taken', () => {
    const e = notionEndpoint('http://127.0.0.1:4567');
    expect(e.test).toBe(true);
    expect(e.mcpUrl).toBe('http://127.0.0.1:4567/mcp');
    expect(e.allow(new URL('http://127.0.0.1:4567/mcp'))).toBe(true);
    expect(e.allow(new URL('https://mcp.notion.com/mcp'))).toBe(false);
    for (const bad of ['https://evil.test', 'http://evil.test:1', 'http://127.0.0.1:4567/x', 'http://127.0.0.1']) {
      const b = notionEndpoint(bad);
      expect(b.test, bad).toBe(false);
      expect(b.base).toBe('https://mcp.notion.com');
    }
  });
});
