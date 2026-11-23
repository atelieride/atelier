import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { buildInteropVectors } from '../../../tests/support/remote-vectors';
import { NoiseHandshake, keyPairFromPrivate, type NoiseProtocol } from './noise';

const FILE = join(__dirname, '../../../tests/fixtures/remote-interop-vectors.json');

test('the interop vectors the iPhone app checks are exactly what this code produces', async () => {
  const built = await buildInteropVectors();
  if (process.env.ATELIER_WRITE_REMOTE_VECTORS === '1') writeFileSync(FILE, JSON.stringify(built, null, 1) + '\n');
  expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(built);
});

test('the handshakes in the file replay from their keys alone', () => {
  const file = JSON.parse(readFileSync(FILE, 'utf8')) as { handshakes: { protocol: NoiseProtocol; prologue: string; initiatorStatic: string; initiatorEphemeral: string; responderStatic: string; responderEphemeral: string; psk?: string; messages: { from: string; payload: string; ciphertext: string }[]; handshakeHash: string }[] };
  const hex = (s: string) => Buffer.from(s, 'hex');
  for (const h of file.handshakes) {
    const psk = h.psk ? { psk: hex(h.psk) } : {};
    const resp = new NoiseHandshake({ protocol: h.protocol, initiator: false, prologue: hex(h.prologue), s: keyPairFromPrivate(hex(h.responderStatic)), e: keyPairFromPrivate(hex(h.responderEphemeral)), ...psk });
    const init = new NoiseHandshake({ protocol: h.protocol, initiator: true, prologue: hex(h.prologue), s: keyPairFromPrivate(hex(h.initiatorStatic)), e: keyPairFromPrivate(hex(h.initiatorEphemeral)), ...psk });
    const [m1, m2, m3, ...rest] = h.messages;
    expect(resp.readMessage(hex(m1!.ciphertext)).toString('hex')).toBe(m1!.payload);
    expect(resp.writeMessage(hex(m2!.payload)).toString('hex')).toBe(m2!.ciphertext);
    init.writeMessage(hex(m1!.payload)); init.readMessage(hex(m2!.ciphertext));
    expect(resp.readMessage(hex(m3!.ciphertext)).toString('hex')).toBe(m3!.payload);
    expect(resp.handshakeHash.toString('hex')).toBe(h.handshakeHash);
    const host = resp.split();
    for (const m of rest) {
      if (m.from === 'initiator') expect(host.decrypt(hex(m.ciphertext)).toString('hex')).toBe(m.payload);
      else expect(host.encrypt(hex(m.payload)).toString('hex')).toBe(m.ciphertext);
    }
  }
});
