import { expect, test } from 'vitest';
import { HEAL_AFTER_MS, healAfterOpen } from './terminal-heal';

const t = (id: string) => ({ id });

function harness(main: { id: string }[], local: { id: string }[]) {
  const st = { applied: null as { id: string }[] | null, timers: [] as { fn: () => void; ms: number }[], local };
  healAfterOpen('x', {
    list: async () => main,
    current: () => st.local,
    apply: (l) => { st.applied = l; },
    later: (fn, ms) => { st.timers.push({ fn, ms }); }
  });
  return st;
}

test('a terminal that exited while it was being created (absent from main\'s list) leaves the tabs: main\'s list is applied', async () => {
  const st = harness([t('a')], [t('a'), t('x')]);
  expect(st.timers[0]!.ms).toBe(HEAL_AFTER_MS);
  st.timers[0]!.fn();
  await new Promise((r) => setTimeout(r, 0));
  expect(st.applied).toEqual([t('a')]);
});

test('a terminal main still lists, or one already gone locally, changes nothing', async () => {
  const alive = harness([t('a'), t('x')], [t('a'), t('x')]);
  alive.timers[0]!.fn();
  await new Promise((r) => setTimeout(r, 0));
  expect(alive.applied).toBeNull();
  const gone = harness([t('a')], [t('a')]);
  gone.timers[0]!.fn();
  await new Promise((r) => setTimeout(r, 0));
  expect(gone.applied).toBeNull();
});

test('a list call that throws at once (main gone, a partial bridge) is swallowed like a rejected one', async () => {
  const timers: (() => void)[] = [];
  healAfterOpen('x', { list: () => { throw new Error('no bridge'); }, current: () => [t('x')], apply: () => {}, later: (fn) => { timers.push(fn); } });
  expect(() => timers[0]!()).not.toThrow();
  await new Promise((r) => setTimeout(r, 0));
});
