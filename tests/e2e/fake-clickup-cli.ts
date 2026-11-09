import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/** The tools Atelier may call: the fake's call log must never show another one. */
export const READ_TOOLS = ['clickup_resolve_assignees', 'clickup_filter_tasks', 'clickup_get_task', 'clickup_get_workspace_hierarchy', 'clickup_search', 'clickup_get_list'];

export interface FakeClickUp {
  url: string;
  /** Every tools/call name that reached the fake's /mcp, in order. */
  calls(): Promise<string[]>;
  /** Every HTTP request that reached the fake on any path (not only tools/call). */
  hits(): Promise<number>;
  /** Adds a task to the fake's lists (POST /__task). */
  addTask(task: { id: string; name: string; customId?: string; status?: string; listId?: string; markdown?: string; creator?: 'user' | 'other' }): Promise<void>;
  /** Switches the fake's behavior (tests/fixtures/fake-clickup.mjs, "Scenarios"). */
  scenario(name: string, opts?: Record<string, unknown>): Promise<void>;
  close(): void;
}

/**
 * The fake ClickUp (authorization server + MCP endpoint on 127.0.0.1) through its CLI: Playwright loads specs as
 * CommonJS and the fake is an ES module. Never the real ClickUp.
 */
export async function startFake(): Promise<FakeClickUp> {
  const child = spawn(process.execPath, [resolve('tests/fixtures/fake-clickup.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise<string>((ok, fail) => {
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const line = out.split('\n')[0];
      if (out.includes('\n') && line) { try { ok((JSON.parse(line) as { url: string }).url); } catch (e) { fail(e); } }
    });
    child.once('exit', () => fail(new Error('fake ClickUp exited')));
  });
  return {
    url,
    hits: async () => ((await (await fetch(`${url}/__hits`)).json()) as { hits: number }).hits,
    calls: async () => ((await (await fetch(`${url}/__calls`)).json()) as { calls: string[] }).calls,
    addTask: async (task) => {
      const res = await fetch(`${url}/__task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(task) });
      if (!res.ok) throw new Error(`fake ClickUp: task refused (${res.status})`);
    },
    scenario: async (name, opts) => {
      const res = await fetch(`${url}/__scenario`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, ...(opts ? { opts } : {}) }) });
      if (!res.ok) throw new Error(`fake ClickUp: scenario ${name} refused (${res.status})`);
    },
    close: () => { child.kill('SIGTERM'); }
  };
}
