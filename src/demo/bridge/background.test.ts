import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { BackgroundFeed } from '@shared/background-feed';
import { compileWorld } from '../compile/index';
import { createClock } from '../engine/clock';
import { BILLING_WATCH } from '../world/beats';
import { createDemo } from './index';

// Background stays worth opening for the whole visit: once its
// agents and its vitest run are over, billing-tests leaves a test watcher running, whose feed reruns on billing edits.

const compiled = compileWorld();
let now = compiled.t0;
const make = () => {
  const clock = createClock();
  return createDemo(compiled, { version: '0.0.0-test', now: () => now, clock });
};
const advance = async (ms: number) => { for (let t = 0; t < ms; t += 100) { now += 100; await vi.advanceTimersByTimeAsync(100); } };

beforeEach(() => { vi.useFakeTimers(); now = compiled.t0; });
afterEach(() => { vi.useRealTimers(); });

test('two minutes in, billing-tests is done and its test watcher still runs; its feed reruns on a billing edit only', async () => {
  const { api, events, context } = make();
  await advance(120_000);
  const billing = (await api.terminals.list()).find((t) => t.title === 'billing-tests')!;
  expect(billing.session!.state).toBe('done');
  expect(billing.work!.entries).toEqual([expect.objectContaining({ id: BILLING_WATCH.id, kind: 'monitor', watcher: true })]);

  const got: BackgroundFeed[] = [];
  events.on.backgroundFeed((f) => got.push(f));
  expect(await api.background.watch(billing.id, BILLING_WATCH.id)).toEqual({ ok: true });
  const first = got[0]!;
  if (first.kind !== 'output') throw new Error('output expected');
  expect(first.lines.join('\n')).toContain('Waiting for file changes');
  expect(first.exit).toBeNull();

  // A file the billing tests don't import: vitest stays quiet.
  context.worktree.write('README.md', '# acme-store\n');
  expect(got).toHaveLength(1);
  context.worktree.write('src/billing/invoice.ts', `${context.state.files['src/billing/invoice.ts']}\n`);
  expect(got).toHaveLength(2);
  const rerun = got[1]!;
  if (rerun.kind !== 'output') throw new Error('output expected');
  expect(rerun.reset).toBe(false);
  expect(rerun.lines).toContain(' RERUN  src/billing/invoice.ts');
  expect(rerun.seq).toBe(first.seq + rerun.lines.length);
  // A later watch gets the whole feed, the rerun included.
  await api.background.watch(billing.id, BILLING_WATCH.id);
  const again = got[2]!;
  if (again.kind !== 'output') throw new Error('output expected');
  expect(again.lines.slice(-rerun.lines.length)).toEqual(rerun.lines);
});

test('before the watcher starts, an edit reruns nothing', async () => {
  const { api, events, context } = make();
  const got: BackgroundFeed[] = [];
  events.on.backgroundFeed((f) => got.push(f));
  const billing = (await api.terminals.list()).find((t) => t.title === 'billing-tests')!;
  await api.background.watch(billing.id, BILLING_WATCH.id);
  got.length = 0;
  context.worktree.write('src/billing/invoice.ts', 'x\n');
  expect(got).toEqual([]);
});
