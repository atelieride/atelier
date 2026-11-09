import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { git } from '../../../tests/support/git-fixture';
import { posixTest } from '../../../tests/support/platform';
import { Trace2Reader, type Trace2Signal, disposeTrace2Dir, listenTrace2, trace2Dir } from './trace2';

// git trace2 on Windows: no af_unix for git there, so the events go to a file of the op's own, read as
// git appends to it. Runs on every machine (the file kind is chosen explicitly), with a real git.

afterEach(() => { disposeTrace2Dir(); });

const run = (repo: string, args: string[], env: NodeJS.ProcessEnv) => new Promise<number>((resolve) => {
  const ch = spawn('git', ['-C', repo, ...args], { env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
  ch.on('close', (code) => resolve(code ?? -1));
});

test('a file per op, tailed while git appends; GIT_TRACE2_EVENT names it; gone after close()', async () => {
  const lines: string[] = [];
  const t = await listenTrace2((l) => lines.push(l), 'win32');
  expect(t.path).toMatch(/\.trace2$/);
  expect(t.event).toBe(t.path);
  expect(existsSync(t.path)).toBe(true);
  // A real git writes its events there (the version event first).
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'atl-tr2f-')));
  git(repo, 'init', '-q', '-b', 'main');
  expect(await run(repo, ['status', '--porcelain'], { ...process.env, GIT_TRACE2_EVENT: t.event })).toBe(0);
  // A line written in two pieces arrives whole.
  appendFileSync(t.path, '{"event":"child_start","sid":"x","child_id":0,"child_class":"hook","hook_name":"pre-');
  await new Promise((r) => setTimeout(r, 300));
  appendFileSync(t.path, 'commit"}\n');
  await t.close();
  expect(lines.some((l) => l.includes('"event":"version"'))).toBe(true);
  const r = new Trace2Reader();
  expect(lines.map((l) => r.push(l)).filter((s): s is Trace2Signal => s !== null)).toEqual([{ phase: 'hook', hook: 'pre-commit' }]);
  expect(existsSync(t.path)).toBe(false);
  await t.close();
});

// On Windows a git still holding the file (a hook's leftover) makes the removal fail: quit tries again. The same
// failure, made here with a folder that refuses removals.
posixTest('a file that could not be removed at close is removed at quit', async () => {
  const t = await listenTrace2(() => {}, 'win32');
  chmodSync(trace2Dir('win32'), 0o500);
  try { await t.close(); } finally { chmodSync(trace2Dir('win32'), 0o700); }
  expect(existsSync(t.path)).toBe(true);
  disposeTrace2Dir();
  expect(existsSync(t.path)).toBe(false);
});
