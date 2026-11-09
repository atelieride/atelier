import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { posixTest } from '../../../tests/support/platform';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import type { DictationStatus } from '@shared/dictation';
import { DictationService } from './service';

const FAKE = resolve(__dirname, '../../../tests/fixtures/fake-whisper.mjs');
const services: DictationService[] = [];
afterEach(() => { for (const s of services.splice(0)) s.dispose(); delete process.env.FAKE_WHISPER_NOSPEECH; delete process.env.FAKE_WHISPER_CRASH_ALWAYS; });

/** Home with a fake model already verified (file + .ok marker consistent with the spec). */
function home(withModel = true) {
  const h = mkdtempSync(join(tmpdir(), 'atl-dict-'));
  const spec = { file: 'm.bin', url: 'http://127.0.0.1:9/m.bin', size: 3, sha256: 'a'.repeat(64) };
  if (withModel) {
    mkdirSync(join(h, 'models'), { recursive: true });
    writeFileSync(join(h, 'models', 'm.bin'), 'abc');
    writeFileSync(join(h, 'models', 'm.bin.ok'), spec.sha256);
  }
  return { h, spec };
}

function make(o: { settings?: Partial<Settings>; withModel?: boolean; polish?: (s: string) => Promise<string>; claude?: string | null } = {}) {
  const { h, spec } = home(o.withModel ?? true);
  const statuses: DictationStatus[] = [];
  const settings = { ...DEFAULT_SETTINGS, dictationEnabled: true, ...o.settings };
  const s = new DictationService({
    home: h, settings: () => settings, binPath: FAKE, modelSpec: spec,
    micStatus: () => 'granted', askMic: async () => true,
    claudeBin: () => (o.claude === undefined ? '/fake/claude' : o.claude),
    polishRun: async (_b, _a, input) => (o.polish ?? (async (x) => x.toUpperCase()))(/<dictation>\n([\s\S]*)\n<\/dictation>/.exec(input)![1]!),
    onStatus: (st) => statuses.push(st)
  });
  services.push(s);
  return { s, statuses };
}

const ctx = { sessions: ['Fix login'], branch: 'main', files: ['src/a.ts'], identifiers: ['parseLine'] };
const second = new Int16Array(16000);

test('status: microphone, model ready, engine off until needed, polish available', () => {
  const { s } = make();
  expect(s.status()).toEqual({ mic: 'granted', model: { state: 'ready' }, engine: 'off', polish: 'available' });
  expect(make({ withModel: false }).s.status().model.state).toBe('missing');
  expect(make({ claude: null }).s.status().polish).toBe('unavailable');
});

// POSIX: POSIX account fixtures and #! fake binaries.
posixTest('the polish runs with the Claude account it is given', async () => {
  const dirs: (string | undefined)[] = [];
  const { h, spec } = home(true);
  const s = new DictationService({
    home: h, settings: () => ({ ...DEFAULT_SETTINGS, dictationEnabled: true }), binPath: FAKE, modelSpec: spec,
    micStatus: () => 'granted', askMic: async () => true, claudeBin: () => '/fake/claude',
    polishRun: async (_b, _a, input, _t, dir) => { dirs.push(dir); return /<dictation>\n([\s\S]*)\n<\/dictation>/.exec(input)![1]!; },
    onStatus: () => {}
  });
  services.push(s);
  await s.transcribe(second, false, ctx, null, '/Users/x/.claude_ops');
  await s.transcribe(second, false, ctx);
  expect(dirs).toEqual(['/Users/x/.claude_ops', undefined]);
});

// POSIX: POSIX account fixtures and #! fake binaries.
posixTest('transcribes with the vocabulary as a hint and polishes', async () => {
  const { s } = make({ settings: { dictationLanguage: 'it' } });
  const r = await s.transcribe(second, false, ctx);
  expect(r).toEqual({ text: 'LANG=IT N=16000 PROMPT=PARSELINE, SRC, A.TS, FIX LOGIN, MAIN, ATELIER, CLAUDE.MD, CLAUDE', polished: true });
});

test('raw on request, or with polish off: no call to Claude', async () => {
  let calls = 0;
  const polish = async (x: string) => { calls++; return x; };
  expect((await make({ polish }).s.transcribe(second, true, ctx)).polished).toBe(false);
  expect((await make({ polish, settings: { dictationPolish: false } }).s.transcribe(second, false, ctx)).polished).toBe(false);
  expect(calls).toBe(0);
});

// POSIX: POSIX account fixtures and #! fake binaries.
posixTest('polish failed: raw text with a warning', async () => {
  const r = await make({ polish: async () => { throw new Error('boom'); } }).s.transcribe(second, false, ctx);
  expect(r.polished).toBe(false);
  expect(r.warning).toBe('not-polished');
  expect(r.text).toMatch(/^lang= n=16000/);
});

// POSIX: POSIX account fixtures and #! fake binaries.
posixTest('silence: no text, no-speech warning', async () => {
  process.env.FAKE_WHISPER_NOSPEECH = '0.9';
  expect(await make().s.transcribe(second, false, ctx)).toEqual({ text: '', polished: false, warning: 'no-speech' });
});

test('engine that always crashes: engine-error warning, no exceptions', async () => {
  process.env.FAKE_WHISPER_CRASH_ALWAYS = '1';
  const r = await make().s.transcribe(second, false, ctx);
  expect(r).toEqual({ text: '', polished: false, warning: 'engine-error' });
});

// POSIX: POSIX account fixtures and #! fake binaries.
posixTest('long dictation with a silent window: the speech is kept, not everything thrown away', async () => {
  process.env.FAKE_WHISPER_SEGMENTS = JSON.stringify([{ text: ' Prima parte.', noSpeech: 0.02 }, { text: ' you', noSpeech: 0.95 }, { text: ' Seconda parte.', noSpeech: 0.1 }]);
  try {
    const r = await make({ settings: { dictationPolish: false } }).s.transcribe(second, false, ctx);
    expect(r).toEqual({ text: 'Prima parte. Seconda parte.', polished: false });
  } finally {
    delete process.env.FAKE_WHISPER_SEGMENTS;
  }
});
