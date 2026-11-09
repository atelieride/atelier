import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runDaemon, type RunningDaemon } from '../../src/daemon/main';
import { installAtelierFiles } from '../../src/daemon/install';

const running: RunningDaemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

const TERM_ID = '0b5c8f0e-1111-4222-8333-944455556666';

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'atl-b-'));
  const hooks: unknown[] = [];
  const statuses: unknown[] = [];
  const d = await runDaemon({ home, version: 't', shellArgs: ['-f'], onHook: (t, p) => hooks.push({ t, p }), onStatus: (t, p) => statuses.push({ t, p }) });
  running.push(d);
  const user = join(home, 'user-settings.json');
  writeFileSync(user, JSON.stringify({ statusLine: { type: 'command', command: "cat >/dev/null; printf 'STATUS-USER'" } }));
  installAtelierFiles(d.paths, user);
  const env = { PATH: '/usr/bin:/bin', ATELIER_HOME: home, ATELIER_SOCK: d.paths.sock, ATELIER_HOOK_TOKEN: d.hookToken, ATELIER_TERMINAL_ID: TERM_ID };
  return { d, home, env, hooks, statuses };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); }
};

test('atelier-hook delivers the payload, prints nothing, exits 0', async () => {
  const { d, env, hooks } = await setup();
  const r = spawnSync(join(d.paths.bin, 'atelier-hook'), { input: '{"hook_event_name":"Stop","session_id":"s1"}', env, encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stdout).toBe('');
  await until(() => hooks.length === 1);
  expect(hooks[0]).toEqual({ t: TERM_ID, p: { hook_event_name: 'Stop', session_id: 's1' } });
});

test('atelier-hook outside Atelier (no variables): exit 0, no output', async () => {
  const { d } = await setup();
  const r = spawnSync(join(d.paths.bin, 'atelier-hook'), { input: '{}', env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stdout + r.stderr).toBe('');
});

test('atelier-hook with the service off: exit 0 right away, no output', async () => {
  const { d, env } = await setup();
  const t0 = Date.now();
  const r = spawnSync(join(d.paths.bin, 'atelier-hook'), { input: '{}', env: { ...env, ATELIER_SOCK: join(d.paths.home, 'off.sock') }, encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stdout + r.stderr).toBe('');
  expect(Date.now() - t0).toBeLessThan(1500);
});

test('atelier-hook rejects a terminal id with invalid characters (no injected JSON)', async () => {
  const { d, env, hooks } = await setup();
  const r = spawnSync(join(d.paths.bin, 'atelier-hook'), { input: '{}', env: { ...env, ATELIER_TERMINAL_ID: 'x","term":"y' }, encoding: 'utf8' });
  expect(r.status).toBe(0);
  await new Promise((res) => setTimeout(res, 300));
  expect(hooks).toEqual([]);
});

test('atelier-statusline: output identical to the user status line and a copy to Atelier', async () => {
  const { d, env, statuses } = await setup();
  const payload = JSON.stringify({ session_id: 's1', context_window: { used_percentage: 42 } });
  const out = execFileSync(join(d.paths.bin, 'atelier-statusline'), { input: payload, env, encoding: 'utf8' });
  expect(out).toBe('STATUS-USER');
  await until(() => statuses.length === 1);
  expect(statuses[0]).toEqual({ t: TERM_ID, p: { session_id: 's1', context_window: { used_percentage: 42 } } });
});

test('atelier-statusline without a user status line → empty output', async () => {
  const { d, env } = await setup();
  installAtelierFiles(d.paths, join(d.paths.home, 'none.json'));
  const out = execFileSync(join(d.paths.bin, 'atelier-statusline'), { input: '{}', env, encoding: 'utf8' });
  expect(out).toBe('');
});
