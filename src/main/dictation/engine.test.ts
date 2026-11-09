import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { WhisperEngine, encodeRequest, whisperEnv } from './engine';

const FAKE = resolve(__dirname, '../../../tests/fixtures/fake-whisper.mjs');
const engines: WhisperEngine[] = [];
const make = (o: Partial<ConstructorParameters<typeof WhisperEngine>[0]> = {}) => {
  const e = new WhisperEngine({ bin: FAKE, model: '/m.bin', idleMs: null, ...o });
  engines.push(e);
  return e;
};
afterEach(() => { for (const e of engines.splice(0)) e.stop(); delete process.env.FAKE_WHISPER_CRASH_ONCE; });

test('binary request: magic, id, language, hint, samples', () => {
  const b = encodeRequest(7, 'it', 'Atelier', new Int16Array([1, -2]));
  expect(b.toString('latin1', 0, 4)).toBe('AWR1');
  expect(b.readUInt32LE(4)).toBe(7);
  expect(b.readUInt8(8)).toBe(2);
  expect(b.toString('utf8', 9, 11)).toBe('it');
  expect(b.readUInt32LE(11)).toBe(7);
  expect(b.toString('utf8', 15, 22)).toBe('Atelier');
  expect(b.readUInt32LE(22)).toBe(2);
  expect(b.readInt16LE(26)).toBe(1);
  expect(b.readInt16LE(28)).toBe(-2);
  expect(b.length).toBe(30);
});

test('transcribes and handles parallel requests with their ids', async () => {
  const e = make();
  const [a, b] = await Promise.all([
    e.transcribe(new Int16Array(16000), 'it', 'Atelier'),
    e.transcribe(new Int16Array(8000), 'en', '')
  ]);
  expect(a.text).toBe('lang=it n=16000 prompt=Atelier');
  expect(a.segments).toEqual([{ text: 'lang=it n=16000 prompt=Atelier', noSpeech: 0 }]);
  expect(b.text).toBe('lang=en n=8000 prompt=');
});

test('the engine crashes on the first audio: restart and the same request is retried', async () => {
  process.env.FAKE_WHISPER_CRASH_ONCE = join(mkdtempSync(join(tmpdir(), 'atl-eng-')), 'crashed');
  const states: string[] = [];
  const e = make({ onState: (s) => states.push(s) });
  const r = await e.transcribe(new Int16Array(1600), 'it', '');
  expect(r.text).toBe('lang=it n=1600 prompt=');
  expect(states.filter((s) => s === 'ready')).toHaveLength(2);
  expect(states.filter((s) => s === 'loading')).toHaveLength(2);
});

test('the engine always crashes: after one restart the request fails', async () => {
  process.env.FAKE_WHISPER_CRASH_ALWAYS = '1';
  try {
    await expect(make().transcribe(new Int16Array(1600), 'it', '')).rejects.toThrow(/engine stopped/);
  } finally {
    delete process.env.FAKE_WHISPER_CRASH_ALWAYS;
  }
});

const REAL = resolve(__dirname, '../../../vendor/bin/atelier-whisper');
// The real binary exists only after npm run build:whisper.
test.skipIf(!existsSync(REAL))('model that fails to load: error, error state', async () => {
  const states: string[] = [];
  const e = new WhisperEngine({ bin: REAL, model: '/nonexistent.bin', idleMs: null, onState: (s) => states.push(s) });
  engines.push(e);
  await expect(e.warm()).rejects.toThrow(/cannot load model/);
  // The process exits right after the error: the state must stay "error" (not go back to "off").
  await new Promise((r) => setTimeout(r, 300));
  expect(states.at(-1)).toBe('error');
});

test('idle: after idleMs the engine stops', async () => {
  const states: string[] = [];
  const e = make({ idleMs: 50, onState: (s) => states.push(s) });
  await e.transcribe(new Int16Array(160), 'it', '');
  await new Promise((r) => setTimeout(r, 200));
  expect(states.at(-1)).toBe('off');
});

test('loaded and never used: with idleMs the engine still stops (10 minutes do not become "always")', async () => {
  const states: string[] = [];
  const e = make({ idleMs: 50, onState: (s) => states.push(s) });
  await e.warm();
  await new Promise((r) => setTimeout(r, 200));
  expect(states.at(-1)).toBe('off');
});

test('the engine runs without ggml-metal residency sets: no thread waking every 5 ms while idle', () => {
  const env = whisperEnv({ PATH: '/usr/bin', HOME: '/h' });
  expect(env.GGML_METAL_NO_RESIDENCY).toBe('1');
  expect(env.PATH).toBe('/usr/bin');
});
