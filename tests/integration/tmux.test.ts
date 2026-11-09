import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { capturePane, listPanes } from '../../src/main/tmux/panes';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'atl-tmux-')));
// The socket of the test server lives in the run's temp root (tests/support/temp-root.ts), not one level deeper: tmux
// resolves it to /private/var/folders/…/T/atl-run-XXXXXX/tmux-<uid>/<server> and macOS caps socket paths at 103 bytes.
const socketDir = tmpdir();
process.env.TMUX_TMPDIR = socketDir;
delete process.env.TMUX;
const server = `atelier-test-${process.pid}`;
const tmux = (...a: string[]) => execFileSync('tmux', ['-L', server, ...a], { env: { ...process.env, TMUX_TMPDIR: socketDir } });
const project = join(tmp, 'project');

beforeAll(() => {
  mkdirSync(join(project, 'api'), { recursive: true });
  mkdirSync(join(tmp, 'elsewhere'));
  tmux('new-session', '-d', '-s', 'trial', '-x', '120', '-y', '30', '-c', join(project, 'api'), "printf 'start\\n\\033[31mERROR something\\033[0m\\n'; exec sleep 300");
  tmux('select-pane', '-t', 'trial:0.0', '-T', 'api');
  tmux('split-window', '-t', 'trial:0', '-c', join(tmp, 'elsewhere'), 'sleep 300');
});
afterAll(() => { try { tmux('kill-server'); } catch { /* already stopped */ } });

test('only the panes of the project, with name from the title and state', async () => {
  const r = await listPanes(project, { server });
  expect(r.status).toBe('ok');
  expect(r.panes).toHaveLength(1);
  expect(r.panes[0]).toMatchObject({ name: 'api' });
  // `exec sleep`: under bash (the CI runner's shell) `cmd; sleep` keeps bash as the pane's command, under zsh it doesn't.
  // And the command may not have reached `sleep` yet on a slower machine: wait for it.
  await expect.poll(async () => (await listPanes(project, { server })).panes[0]?.running, { timeout: 5000 }).toBe(true);
});

test('capture with colors, without trailing empty lines', async () => {
  const [p] = (await listPanes(project, { server })).panes;
  await new Promise((r) => setTimeout(r, 300));
  const lines = await capturePane(p!.id, { server });
  expect(lines.some((l) => l.includes('\x1b[31mERROR something'))).toBe(true);
  expect(lines.at(-1)).not.toBe('');
});

/** Runs fn with the environment of an app opened from the Dock: launchd gives it no LANG/LC_* at all. */
async function withoutLocale<T>(fn: () => Promise<T>): Promise<T> {
  const keys = Object.keys(process.env).filter((k) => k === 'LANG' || k.startsWith('LC_'));
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try { return await fn(); } finally { Object.assign(process.env, saved); }
}

test('app opened from the Dock (no locale): panes still listed (tmux would turn the format\'s tabs into _)', async () => {
  const r = await withoutLocale(() => listPanes(project, { server }));
  expect(r.panes).toHaveLength(1);
  expect(r.panes[0]).toMatchObject({ name: 'api', cwd: join(project, 'api') });
});

test('nonexistent server → no-server status, no exception', async () => {
  expect(await listPanes(project, { server: 'atelier-nobody' })).toEqual({ status: 'no-server', panes: [] });
});
