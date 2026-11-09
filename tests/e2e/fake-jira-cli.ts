import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/** The tools Atelier may call on Jira: the fake's call log must never show another one. */
export const JIRA_READ_TOOLS = [
  'getAccessibleAtlassianResources', 'getJiraCurrentUser', 'listJiraProjects', 'listJiraFilters', 'searchJiraIssuesUsingJql', 'getJiraIssue'
];

export interface FakeJiraCli {
  /** The resource server (ATELIER_TEST_JIRA_URL). */
  url: string;
  /** The authorization server, a second origin (ATELIER_TEST_JIRA_AUTH_URL). */
  authUrl: string;
  /** Every tools/call name that reached the fake's /v2/mcp, in order. */
  calls(): Promise<string[]>;
  /** Switches the fake's behavior (tests/fixtures/fake-jira.mjs, "Scenarios"). */
  scenario(name: string): Promise<void>;
  close(): void;
}

/**
 * The fake Jira (Rovo MCP v2 + Atlassian's authorization server on two 127.0.0.1 origins) through its CLI: Playwright
 * loads specs as CommonJS and the fake is an ES module. `apiToken`: one e-mail and token the fake accepts as Basic auth.
 * Never the real Atlassian.
 */
export async function startFakeJiraCli(o: { apiToken?: { email: string; token: string } } = {}): Promise<FakeJiraCli> {
  const args = [resolve('tests/fixtures/fake-jira.mjs'), ...(o.apiToken ? ['--api-token', `${o.apiToken.email}:${o.apiToken.token}`] : [])];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const { url, authUrl } = await new Promise<{ url: string; authUrl: string }>((ok, fail) => {
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const line = out.split('\n')[0];
      if (out.includes('\n') && line) { try { ok(JSON.parse(line) as { url: string; authUrl: string }); } catch (e) { fail(e); } }
    });
    child.once('exit', () => fail(new Error('fake Jira exited')));
  });
  const post = async (path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    if (!res.ok) throw new Error(`fake Jira: ${path} refused (${res.status})`);
  };
  return {
    url, authUrl,
    calls: async () => ((await (await fetch(`${url}/__calls`)).json()) as { calls: string[] }).calls,
    scenario: (name) => post('/__scenario', { name }),
    close: () => { child.kill('SIGTERM'); }
  };
}
