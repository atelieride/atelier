import { expect, test, vi } from 'vitest';
import { compileWorld } from '../compile/index';
import { createDemo } from '../bridge';
import { createClock } from './clock';

const demo = () => {
  const compiled = compileWorld();
  return createDemo(compiled, { version: '0.0.0-test', now: () => compiled.t0, clock: createClock() });
};

test('a write changes the tree, then tells the renderer: fsChanged with the absolute path, git with the new status', () => {
  const { context: ctx, events } = demo();
  const fs = vi.fn(), git = vi.fn();
  events.on.fsChanged(fs);
  events.on.git(git);
  ctx.worktree.write('src/billing/invoice.ts', 'export const total = 1;\n');
  expect(ctx.state.files['src/billing/invoice.ts']).toBe('export const total = 1;\n');
  expect(fs).toHaveBeenCalledWith([`${ctx.world.project.root}/src/billing/invoice.ts`]);
  const [repos] = git.mock.calls.at(-1)!;
  expect(repos[0].changes.map((c: { rel: string }) => c.rel)).toContain('src/billing/invoice.ts');
});

test('null deletes; a write with an attribution adds it (one per path) and emits attributions', () => {
  const { context: ctx, events } = demo();
  const attrs = vi.fn();
  events.on.attributions(attrs);
  ctx.worktree.write('README.md', null);
  expect(ctx.state.files['README.md']).toBeUndefined();
  const path = `${ctx.world.project.root}/src/pages/welcome.tsx`;
  const a = { path, terminalId: 't-x', sessionId: 's-x', color: '#000', title: 'x', at: 1 };
  ctx.worktree.write('src/pages/welcome.tsx', 'x\n', a);
  const list = attrs.mock.calls.at(-1)![0] as { path: string; terminalId: string }[];
  expect(list.filter((e) => e.path === path)).toEqual([a]);
});
