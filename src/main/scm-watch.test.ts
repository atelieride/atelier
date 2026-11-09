import { afterEach, expect, test, vi } from 'vitest';
import { ScmEvents } from './scm-watch';

afterEach(() => { vi.useRealTimers(); });

test('a burst becomes one event per repository and kind, after the quiet period', () => {
  vi.useFakeTimers();
  const got: unknown[] = [];
  const ev = new ScmEvents(300, (e) => got.push(e));
  ev.add({ common: '/p/.git', what: 'refs' });
  vi.advanceTimersByTime(50);
  ev.add({ common: '/p/.git', what: 'refs' });
  ev.add({ common: '/p/.git', what: 'head' });
  ev.add({ common: '/q/.git', what: 'refs' });
  vi.advanceTimersByTime(299);
  expect(got).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(got).toEqual([{ common: '/p/.git', what: 'refs' }, { common: '/p/.git', what: 'head' }, { common: '/q/.git', what: 'refs' }]);
  ev.dispose();
});

test('dispose drops what was waiting', () => {
  vi.useFakeTimers();
  const got: unknown[] = [];
  const ev = new ScmEvents(300, (e) => got.push(e));
  ev.add({ common: '/p/.git', what: 'fetch' });
  ev.dispose();
  vi.advanceTimersByTime(1000);
  expect(got).toEqual([]);
});
