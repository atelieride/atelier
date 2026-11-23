// iPhone access's Noise code runs in the main process, on Electron's crypto (BoringSSL), not on the OpenSSL the unit
// tests run on: a cipher only OpenSSL has passes every vector here and fails in the app. So a handshake and a few
// transport messages run once in Electron itself (as Node), from noise.ts bundled as it is.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, test } from 'vitest';

const electron = createRequire(import.meta.url)('electron') as unknown as string;

const SCRIPT = `
import { NoiseHandshake, generateKeyPair } from ${JSON.stringify(resolve(__dirname, '../../src/main/remote/noise.ts'))};
for (const psk of [undefined, Buffer.alloc(32, 7)]) {
  const protocol = psk ? 'Noise_XXpsk3_25519_AESGCM_SHA256' : 'Noise_XX_25519_AESGCM_SHA256';
  const prologue = Buffer.from('atelier-test');
  const i = new NoiseHandshake({ protocol, initiator: true, prologue, s: generateKeyPair(), ...(psk ? { psk } : {}) });
  const r = new NoiseHandshake({ protocol, initiator: false, prologue, s: generateKeyPair(), ...(psk ? { psk } : {}) });
  r.readMessage(i.writeMessage(Buffer.alloc(0)));
  i.readMessage(r.writeMessage(Buffer.from('hello from the host')));
  r.readMessage(i.writeMessage(Buffer.from('hello from the phone')));
  const [a, b] = [i.split(), r.split()];
  for (const text of ['one', 'two', 'x'.repeat(60000)]) {
    if (b.decrypt(a.encrypt(Buffer.from(text))).toString() !== text) throw new Error('phone → host');
    if (a.decrypt(b.encrypt(Buffer.from(text))).toString() !== text) throw new Error('host → phone');
  }
}
console.log('noise ok');
`;

test('a Noise handshake and its transport messages work on Electron\'s own crypto', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-noise-electron-'));
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, SCRIPT);
  const out = join(dir, 'noise.cjs');
  await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
  const run = execFileSync(electron, [out], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  expect(run.trim()).toBe('noise ok');
}, 60_000);

// A push's text is sealed in the main process too: the relay's vectors, sealed and opened on Electron's crypto.
const PUSH_SCRIPT = `
import { readFileSync } from 'node:fs';
import { openPush, pushKeyId, sealPush } from ${JSON.stringify(resolve(__dirname, '../../src/main/remote/push-seal.ts'))};
const { vectors } = JSON.parse(readFileSync(${JSON.stringify(resolve(__dirname, '../fixtures/push-vectors.json'))}, 'utf8'));
for (const v of vectors) {
  const key = Buffer.from(v.pushKey, 'base64url');
  if (pushKeyId(key) !== v.keyId) throw new Error('key id');
  if (sealPush(key, v.plaintext, Buffer.from(v.nonce, 'base64url')) !== v.p) throw new Error('sealed');
  if (openPush(key, v.p) !== v.plaintext) throw new Error('opened');
}
console.log('push ok');
`;

test('a push\'s text is sealed as the vectors say on Electron\'s own crypto', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-push-electron-'));
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, PUSH_SCRIPT);
  const out = join(dir, 'push.cjs');
  await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
  const run = execFileSync(electron, [out], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  expect(run.trim()).toBe('push ok');
}, 60_000);
