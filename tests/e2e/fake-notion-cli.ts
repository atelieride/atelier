import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/** The tools Atelier may call on Notion: the fake's call log must never show another one. */
export const NOTION_READ_TOOLS = ['notion-get-self', 'notion-search', 'notion-fetch', 'notion-query-data-sources'];

export interface FakeNotionRevocation { token: string; tokenTypeHint: string | null; clientId: string | null }

export interface FakeNotionCli {
  url: string;
  /** Every tools/call name that reached the fake's /mcp, in order. */
  calls(): Promise<string[]>;
  /** The revocation endpoint's log. */
  revoked(): Promise<FakeNotionRevocation[]>;
  /** Switches the fake's behavior (tests/fixtures/fake-notion.mjs, "Scenarios"). */
  scenario(name: string, opts?: Record<string, unknown>): Promise<void>;
  /** Access tokens stop working; refresh tokens still do. */
  expireAccessTokens(): Promise<void>;
  /** The next refresh answers invalid_grant. */
  revokeRefresh(): Promise<void>;
  /** expires_in of the tokens issued from now on. */
  setExpiresIn(seconds: number): Promise<void>;
  close(): void;
}

/**
 * The fake Notion (authorization server + MCP endpoint on 127.0.0.1) through its CLI: Playwright loads specs as
 * CommonJS and the fake is an ES module. Never the real Notion.
 */
export async function startFakeNotionCli(): Promise<FakeNotionCli> {
  const child = spawn(process.execPath, [resolve('tests/fixtures/fake-notion.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise<string>((ok, fail) => {
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const line = out.split('\n')[0];
      if (out.includes('\n') && line) { try { ok((JSON.parse(line) as { url: string }).url); } catch (e) { fail(e); } }
    });
    child.once('exit', () => fail(new Error('fake Notion exited')));
  });
  const post = async (path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    if (!res.ok) throw new Error(`fake Notion: ${path} refused (${res.status})`);
  };
  return {
    url,
    calls: async () => ((await (await fetch(`${url}/__calls`)).json()) as { calls: string[] }).calls,
    revoked: async () => ((await (await fetch(`${url}/__revoked`)).json()) as { revoked: FakeNotionRevocation[] }).revoked,
    scenario: (name, opts) => post('/__scenario', { name, ...(opts ? { opts } : {}) }),
    expireAccessTokens: () => post('/__expire'),
    revokeRefresh: () => post('/__revoke-refresh'),
    setExpiresIn: (seconds) => post('/__expires-in', { seconds }),
    close: () => { child.kill('SIGTERM'); }
  };
}
