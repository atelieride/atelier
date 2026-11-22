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
  const protocol = psk ? 'Noise_XXpsk3_25519_ChaChaPoly_SHA256' : 'Noise_XX_25519_ChaChaPoly_SHA256';
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
