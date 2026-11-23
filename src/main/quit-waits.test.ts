import { expect, test, vi } from 'vitest';
import { QuitWaits } from './quit-waits';

/** A promise and its resolve/reject, for a wait the test ends when it wants. */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const willQuit = () => ({ preventDefault: vi.fn() });
const flush = () => new Promise((r) => setTimeout(r, 0));

test('nothing to wait for: the quit goes on, and nothing exits by itself', async () => {
  const q = new QuitWaits();
  const exit = vi.fn();
  q.add(() => null);
  const e = willQuit();
  q.willQuit(e, exit);
  await flush();
  expect(e.preventDefault).not.toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();
});

test('the windows\' stops and the phones\' goodbye: one hold, and the exit once both ended, whichever ends last', async () => {
  const q = new QuitWaits();
  const stops = deferred();
  const goodbye = deferred();
  q.add(() => stops.promise);
  q.add(() => goodbye.promise);
  const exit = vi.fn();
  const e = willQuit();
  q.willQuit(e, exit);
  expect(e.preventDefault).toHaveBeenCalledTimes(1);
  // The phones are told first: the stops still reach atelierd.
  goodbye.resolve();
  await flush();
  expect(exit).not.toHaveBeenCalled();
  stops.resolve();
  await flush();
  expect(exit).toHaveBeenCalledTimes(1);
});

test('each part is asked once; a quit asked again while waiting is held too, and the exit comes once', async () => {
  const q = new QuitWaits();
  const stops = deferred();
  const part = vi.fn(() => stops.promise);
  const idle = vi.fn(() => null);
  q.add(part);
  q.add(idle);
  const exit = vi.fn();
  q.willQuit(willQuit(), exit);
  const again = willQuit();
  q.willQuit(again, exit);
  expect(again.preventDefault).toHaveBeenCalledTimes(1);
  expect(part).toHaveBeenCalledTimes(1);
  expect(idle).toHaveBeenCalledTimes(1);
  stops.resolve();
  await flush();
  expect(exit).toHaveBeenCalledTimes(1);
  // Nothing held after a quit with nothing to wait for: parts are not asked again.
  const later = new QuitWaits();
  const asked = vi.fn(() => null);
  later.add(asked);
  later.willQuit(willQuit(), exit);
  later.willQuit(willQuit(), exit);
  expect(asked).toHaveBeenCalledTimes(1);
});

test('a part that throws has nothing to wait for; the others are still waited for', async () => {
  const q = new QuitWaits();
  const goodbye = deferred();
  q.add(() => { throw new Error('closed already'); });
  q.add(() => goodbye.promise);
  const exit = vi.fn();
  const e = willQuit();
  q.willQuit(e, exit);
  expect(e.preventDefault).toHaveBeenCalledTimes(1);
  goodbye.resolve();
  await flush();
  expect(exit).toHaveBeenCalledTimes(1);
});

test('a wait that fails still ends in the exit', async () => {
  const q = new QuitWaits();
  const stops = deferred();
  q.add(() => stops.promise);
  const exit = vi.fn();
  q.willQuit(willQuit(), exit);
  stops.reject(new Error('atelierd gone'));
  await flush();
  expect(exit).toHaveBeenCalledTimes(1);
});
