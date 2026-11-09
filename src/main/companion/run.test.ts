import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { StreamItem } from '@shared/companion/stream';
import { RUN_LINE_MAX, RUN_OUTPUT_MAX, COMPANION_TIMEOUT_MS, runCompanion } from './run';
import { posixTest } from '../../../tests/support/platform';

const FIX = resolve(__dirname, '../../../tests/fixtures/companion');
const FAKE = join(FIX, 'fake-run.mjs');
const KEYS = ['FAKE_RUN_FIXTURE', 'FAKE_RUN_DELAY_MS', 'FAKE_RUN_HANG', 'FAKE_RUN_FLOOD', 'FAKE_RUN_EXIT', 'FAKE_RUN_STDERR', 'FAKE_RUN_LOG', 'FAKE_RUN_KID', 'FAKE_RUN_BIGLINE', 'FAKE_RUN_NO_FINAL_NL', 'CLAUDE_CONFIG_DIR'];

let dir: string;
let log: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atl-crun-'));
  log = join(dir, 'log.json');
  for (const k of KEYS) delete process.env[k];
  process.env.FAKE_RUN_LOG = log;
});
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  rmSync(dir, { recursive: true, force: true });
});

const run = (o: Partial<Parameters<typeof runCompanion>[0]> = {}) => {
  const items: StreamItem[] = [];
  const p = runCompanion({
    claudeBin: FAKE, args: ['-p', 'x'], cwd: dir, projectRoot: '/p/app', input: 'the question', onItem: (i) => items.push(i), timeoutMs: 10_000, ...o
  });
  return { p, items };
};
const fixture = (n: string) => { process.env.FAKE_RUN_FIXTURE = join(FIX, `stream-${n}.jsonl`); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readLog = () => JSON.parse(readFileSync(log, 'utf8')) as { argv: string[]; pid: number; kid: number | null; input: string; entry: string | null; configDir: string | null };
const lines = (...l: unknown[]) => {
  const f = join(dir, 'x.jsonl');
  writeFileSync(f, l.map((x) => JSON.stringify(x)).join('\n') + '\n');
  process.env.FAKE_RUN_FIXTURE = f;
};
const rate = (status: string) => ({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt: 1793455200 } });
const result = (o: Record<string, unknown> = {}) => ({ type: 'result', is_error: false, result: 'The answer', structured_output: null, total_cost_usd: 0.5, api_error_status: null, ...o });
const read = (file: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${file}${Math.random()}`, name: 'Read', input: { file_path: file } }] } });
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25)); };

describe('runCompanion', () => {
  test('exports the timeouts and the cap', () => {
    expect(COMPANION_TIMEOUT_MS.question.sonnet).toBe(120_000);
    expect(COMPANION_TIMEOUT_MS.catchup.opus).toBe(240_000);
    expect(RUN_LINE_MAX).toBe(8 * 1024 * 1024);
    expect(RUN_OUTPUT_MAX).toBe(32 * 1024 * 1024);
  });

  test('a question run: streamed items, answer text, cost, files read inside the project', async () => {
    fixture('question');
    const { p, items } = run();
    const r = await p;
    expect(r).toMatchObject({ ok: true, read: ['src/token-store.ts', 'src/b.ts'] });
    expect(r.ok && r.text.length).toBeGreaterThan(0);
    expect(r.ok && typeof r.costUsd).toBe('number');
    expect(items.some((i) => i.t === 'init')).toBe(true);
    expect(items.some((i) => i.t === 'tool')).toBe(true);
    expect(readLog().input).toBe('the question');
    expect(readLog().argv).toEqual(['-p', 'x']);
  });

  test('reads outside the project root are not listed, and duplicates are dropped', async () => {
    fixture('question');
    const r = await run({ projectRoot: '/p/app/src' }).p;
    expect(r).toMatchObject({ ok: true, read: ['token-store.ts', 'b.ts'] });
    const none = await run({ projectRoot: '/other' }).p;
    expect(none).toMatchObject({ ok: true, read: [] });
  });

  test('a rejected limit: kind limit with the reset time', async () => {
    fixture('limit');
    expect(await run().p).toEqual({ ok: false, kind: 'limit', message: 'Usage limit reached', resetsAt: 1793455200, window: 'five-hour' });
  });

  test('a rejected weekly limit says so; a rate item without a type names no window', async () => {
    lines({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1793455200, rateLimitType: 'seven_day' } }, result({ is_error: true, api_error_status: 429 }));
    expect(await run().p).toEqual({ ok: false, kind: 'limit', message: 'Usage limit reached', resetsAt: 1793455200, window: 'weekly' });
    lines(rate('rejected'), result({ is_error: true, api_error_status: 429 }));
    expect(await run().p).toEqual({ ok: false, kind: 'limit', message: 'Usage limit reached', resetsAt: 1793455200 });
  });

  test('a successful run after a rejected rate item is a normal answer', async () => {
    lines(rate('rejected'), result());
    expect(await run().p).toMatchObject({ ok: true, text: 'The answer' });
  });

  test('a failed run whose last rate item is only a warning is not a limit', async () => {
    lines(rate('allowed_warning'), result({ is_error: true, result: 'Something broke\nmore' }));
    expect(await run().p).toEqual({ ok: false, kind: 'exit', message: 'Something broke' });
  });

  test('an error result without a 429 or a rejected rate is an exit with its first line', async () => {
    lines(result({ is_error: true, result: 'Bad request\ndetails' }));
    expect(await run().p).toEqual({ ok: false, kind: 'exit', message: 'Bad request' });
  });

  test('a 429 without any rate item is a limit without a reset time', async () => {
    lines(result({ is_error: true, result: 'Rate limit reached', api_error_status: 429 }));
    expect(await run().p).toEqual({ ok: false, kind: 'limit', message: 'Usage limit reached' });
  });

  test('a complete answer survives a crash on teardown', async () => {
    lines(result());
    process.env.FAKE_RUN_EXIT = '1';
    expect(await run().p).toMatchObject({ ok: true, text: 'The answer' });
  });

  test('duplicate reads are listed once, and the thread dir inside the project is not listed', async () => {
    const thread = join(dir, '.thread');
    mkdirSync(thread);
    lines(read(`${dir}/src/a.ts`), read(`${dir}/src/a.ts`), read(`${thread}/chat.md`), read(`${dir}/src/c.ts`), result());
    expect(await run({ cwd: thread, projectRoot: dir }).p).toMatchObject({ ok: true, read: ['src/a.ts', 'src/c.ts'] });
  });

  posixTest('reads by the real path of a symlinked project and thread folder are theirs (a symlinked home: /var is /private/var)', async () => {
    mkdirSync(join(dir, 'real', '.thread'), { recursive: true });
    const real = realpathSync(join(dir, 'real'));
    const project = join(dir, 'link');
    symlinkSync(real, project);
    lines(read(`${real}/src/a.ts`), read(`${project}/src/b.ts`), read(`${real}/.thread/chat.md`), read(`${project}/.thread/facts.md`), result());
    expect(await run({ cwd: join(project, '.thread'), projectRoot: project }).p).toMatchObject({ ok: true, read: ['src/a.ts', 'src/b.ts'] });
  });

  test('a last line without a newline is flushed at close', async () => {
    lines(result());
    process.env.FAKE_RUN_NO_FINAL_NL = '1';
    expect(await run().p).toMatchObject({ ok: true, text: 'The answer' });
  });

  test('exit 0 without a result: no answer', async () => {
    const r = await run().p;
    expect(r).toEqual({ ok: false, kind: 'exit', message: 'Claude ended without an answer' });
  });

  test('a non-zero exit gives the first stderr line', async () => {
    process.env.FAKE_RUN_EXIT = '3';
    process.env.FAKE_RUN_STDERR = 'boom happened';
    const r = await run().p;
    expect(r).toEqual({ ok: false, kind: 'exit', message: 'boom happened' });
  });

  test('abort: stopped, and the whole group is gone', async () => {
    process.env.FAKE_RUN_HANG = '1';
    const ac = new AbortController();
    process.env.FAKE_RUN_KID = '1';
    const { p } = run({ signal: ac.signal });
    await until(() => existsSync(log));
    const { pid, kid } = readLog();
    ac.abort();
    expect(await p).toEqual({ ok: false, kind: 'stopped', message: 'Stopped' });
    await until(() => !alive(pid) && !alive(kid!));
    expect(alive(pid)).toBe(false);
    expect(alive(kid!)).toBe(false);
  });

  test('already aborted: stopped without spawning', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await run({ signal: ac.signal }).p).toMatchObject({ kind: 'stopped' });
    expect(existsSync(log)).toBe(false);
  });

  test('timeout kills the group', async () => {
    process.env.FAKE_RUN_HANG = '1';
    process.env.FAKE_RUN_KID = '1';
    const { p } = run({ timeoutMs: 500 });
    expect(await p).toEqual({ ok: false, kind: 'timeout', message: "Claude didn't answer in time" });
    const { pid, kid } = readLog();
    await until(() => !alive(pid) && !alive(kid!));
    expect(alive(pid)).toBe(false);
    expect(alive(kid!)).toBe(false);
  });

  test('a run past the total cap is cut off', async () => {
    process.env.FAKE_RUN_FLOOD = '34';
    process.env.FAKE_RUN_HANG = '1';
    const { p } = run();
    expect(await p).toEqual({ ok: false, kind: 'exit', message: 'Claude wrote too much' });
    const { pid } = readLog();
    await until(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  }, 20_000);

  test('a single line past the line cap is cut off', async () => {
    process.env.FAKE_RUN_BIGLINE = String(RUN_LINE_MAX + 1024);
    process.env.FAKE_RUN_HANG = '1';
    const { p } = run();
    expect(await p).toEqual({ ok: false, kind: 'exit', message: 'Claude wrote too much' });
    const { pid } = readLog();
    await until(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  }, 20_000);

  test('a missing binary: not found', async () => {
    expect(await run({ claudeBin: join(dir, 'nope') }).p).toEqual({ ok: false, kind: 'not-found', message: 'Claude Code was not found' });
  });

  test('a binary that cannot be started resolves instead of throwing', async () => {
    const bin = join(dir, 'plain');
    writeFileSync(bin, 'not executable');
    chmodSync(bin, 0o644);
    const r = await run({ claudeBin: bin }).p;
    expect(r).toMatchObject({ ok: false, kind: 'exit' });
  });

  test('its own entrypoint and the account dir reach the child', async () => {
    await run({ configDir: '/acc/dir' }).p;
    expect(readLog()).toMatchObject({ entry: 'atelier-ask', configDir: '/acc/dir' });
  });
});
