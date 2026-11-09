import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// e2e pages play Atelier's chime and the dictation tones (WebAudio): under the devEnv test flag every page is muted, so
// the tests still run that code but the developer never hears it. Never muted in normal runs or in the packaged app.
const packaged = vi.hoisted(() => ({ value: false }));
vi.mock('electron', () => ({ app: { get isPackaged() { return packaged.value; } } }));
const { muteTestAudio } = await import('./test-audio');

type Listener = (e: unknown, wc: { setAudioMuted(m: boolean): void }) => void;
const fakeApp = () => {
  const listeners: Listener[] = [];
  return { on: vi.fn((ev: string, fn: Listener) => { if (ev === 'web-contents-created') listeners.push(fn); }), create: () => { const wc = { setAudioMuted: vi.fn() }; for (const l of listeners) l({}, wc); return wc; } };
};

let saved: string | undefined;
beforeEach(() => { saved = process.env.ATELIER_TEST_MUTED; packaged.value = false; });
afterEach(() => { if (saved === undefined) delete process.env.ATELIER_TEST_MUTED; else process.env.ATELIER_TEST_MUTED = saved; });

test('with the test flag every page is muted as it is created', () => {
  process.env.ATELIER_TEST_MUTED = '1';
  const app = fakeApp();
  muteTestAudio(app);
  expect(app.create().setAudioMuted).toHaveBeenCalledWith(true);
  expect(app.create().setAudioMuted).toHaveBeenCalledWith(true);
});

test('without the flag pages keep their sound', () => {
  delete process.env.ATELIER_TEST_MUTED;
  const app = fakeApp();
  muteTestAudio(app);
  expect(app.on).not.toHaveBeenCalled();
  expect(app.create().setAudioMuted).not.toHaveBeenCalled();
});

test('in the packaged app the flag is inert', () => {
  process.env.ATELIER_TEST_MUTED = '1';
  packaged.value = true;
  const app = fakeApp();
  muteTestAudio(app);
  expect(app.create().setAudioMuted).not.toHaveBeenCalled();
});
