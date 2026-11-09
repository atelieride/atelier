import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('./recorder.worklet.ts?worker&url', () => ({ default: 'worklet.js' }));

// Fake microphone and AudioContext, with slow opens controlled by the test: they reproduce the race between start and stop/cancel.
let gum: { resolve: () => void; reject: (e: Error) => void } | null = null;
let addModule: { resolve: () => void; reject: (e: Error) => void } | null = null;
const track = { stop: vi.fn() };
const contexts: { close: ReturnType<typeof vi.fn> }[] = [];

class FakeCtx {
  sampleRate = 48000;
  destination = {};
  close = vi.fn(async () => {});
  audioWorklet = { addModule: () => new Promise<void>((resolve, reject) => { addModule = { resolve, reject }; }) };
  constructor() { contexts.push(this); }
  createMediaStreamSource() { return { connect: (n: unknown) => n }; }
  createGain() { return { gain: { value: 1 }, connect: (n: unknown) => n }; }
}
class FakeNode { port = { onmessage: null }; connect(n: unknown) { return n; } }

beforeEach(() => {
  gum = null; addModule = null; track.stop.mockClear(); contexts.length = 0;
  vi.stubGlobal('window', { atelier: { dictation: { testAudio: async () => null } } });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise((resolve, reject) => { gum = { resolve: () => resolve({ getTracks: () => [track] }), reject }; }) } });
  vi.stubGlobal('AudioContext', FakeCtx);
  vi.stubGlobal('AudioWorkletNode', FakeNode);
});
afterEach(() => vi.unstubAllGlobals());

const tick = () => new Promise((r) => setTimeout(r, 0));

test('cancelled while the microphone is opening: start fails and the microphone is closed as soon as it opens', async () => {
  const { Recorder } = await import('./recorder');
  const r = new Recorder();
  const p = r.start(() => {}, () => {});
  await tick();
  r.cancel();
  gum!.resolve();
  await expect(p).rejects.toThrow(/cancelled/);
  expect(track.stop).toHaveBeenCalled();
  expect(contexts).toHaveLength(0);
});

test('stopped while the worklet loads: microphone and AudioContext closed', async () => {
  const { Recorder } = await import('./recorder');
  const r = new Recorder();
  const p = r.start(() => {}, () => {});
  await tick();
  gum!.resolve();
  await tick();
  const pcm = r.stop();
  addModule!.resolve();
  await expect(p).rejects.toThrow(/cancelled/);
  expect((await pcm).length).toBe(0);
  expect(track.stop).toHaveBeenCalled();
  expect(contexts[0]!.close).toHaveBeenCalled();
});

test('the worklet fails to load after the microphone opened: everything closed, error to the caller', async () => {
  const { Recorder } = await import('./recorder');
  const r = new Recorder();
  const p = r.start(() => {}, () => {});
  await tick();
  gum!.resolve();
  await tick();
  addModule!.reject(new Error('worklet failed'));
  await expect(p).rejects.toThrow(/worklet failed/);
  expect(track.stop).toHaveBeenCalled();
  expect(contexts[0]!.close).toHaveBeenCalled();
});
