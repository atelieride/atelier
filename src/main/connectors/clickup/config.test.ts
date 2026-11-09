import { afterEach, expect, test, vi } from 'vitest';

const FAKE = 'http://127.0.0.1:4567';
// What tests/setup-env.ts set before this file loaded: every test gets it back.
const SETUP_URL = process.env.ATELIER_TEST_CLICKUP_URL;

afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
  if (SETUP_URL === undefined) delete process.env.ATELIER_TEST_CLICKUP_URL;
  else process.env.ATELIER_TEST_CLICKUP_URL = SETUP_URL;
});

async function load(packaged: boolean) {
  vi.resetModules();
  vi.doMock('electron', () => ({ app: { isPackaged: packaged }, default: { app: { isPackaged: packaged } } }));
  return import('./config');
}

test('under vitest the default endpoint is a closed loopback port (tests/setup-env.ts): never the real ClickUp', async () => {
  expect(SETUP_URL).toBe('http://127.0.0.1:9');
  const { clickupEndpoint } = await load(false);
  const e = clickupEndpoint();
  expect(e).toMatchObject({ base: 'http://127.0.0.1:9', test: true });
  expect(e.allow(new URL('https://mcp.clickup.com/mcp'))).toBe(false);
});

test('by default the connector talks to https://mcp.clickup.com, and only to it', async () => {
  delete process.env.ATELIER_TEST_CLICKUP_URL;
  const { clickupEndpoint, CLICKUP_BASE_URL } = await load(false);
  expect(CLICKUP_BASE_URL).toBe('https://mcp.clickup.com');
  const e = clickupEndpoint();
  expect(e).toMatchObject({ base: 'https://mcp.clickup.com', mcpUrl: 'https://mcp.clickup.com/mcp', test: false });
  expect(e.allow(new URL('https://mcp.clickup.com/mcp'))).toBe(true);
  expect(e.allow(new URL(`${FAKE}/mcp`))).toBe(false);
});

test('ATELIER_TEST_CLICKUP_URL (dev and tests) swaps the base for the local fake, and then only the fake is allowed', async () => {
  process.env.ATELIER_TEST_CLICKUP_URL = FAKE;
  const { clickupEndpoint } = await load(false);
  const e = clickupEndpoint();
  expect(e).toMatchObject({ base: FAKE, mcpUrl: `${FAKE}/mcp`, test: true });
  expect(e.allow(new URL(`${FAKE}/oauth/token`))).toBe(true);
  expect(e.allow(new URL('https://mcp.clickup.com/mcp'))).toBe(false);
});

test('the override is inert in the packaged app', async () => {
  process.env.ATELIER_TEST_CLICKUP_URL = FAKE;
  const { clickupEndpoint } = await load(true);
  expect(clickupEndpoint()).toMatchObject({ base: 'https://mcp.clickup.com', test: false });
});

test('only a bare http://127.0.0.1:<port> override is taken; anything else falls back to ClickUp', async () => {
  delete process.env.ATELIER_TEST_CLICKUP_URL;
  const { clickupEndpoint } = await load(false);
  for (const bad of ['http://localhost:4567', 'https://evil.test', 'http://10.0.0.2:4567', `${FAKE}/path`, `${FAKE}/?q=1`,
    'http://u:p@127.0.0.1:4567', 'http://127.0.0.1', 'garbage', '']) {
    expect(clickupEndpoint(bad).base, bad).toBe('https://mcp.clickup.com');
  }
  expect(clickupEndpoint(`${FAKE}/`).base).toBe(FAKE);
});
