import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { NoiseHandshake, generateKeyPair, keyPairFromPrivate, type NoiseProtocol, type NoiseTransport } from './noise';

interface Vector {
  protocol_name: NoiseProtocol;
  init_prologue: string; init_static: string; init_ephemeral: string; init_psks?: string[];
  resp_prologue: string; resp_static: string; resp_ephemeral: string; resp_psks?: string[];
  handshake_hash: string;
  messages: { payload: string; ciphertext: string }[];
}

const vectors = (JSON.parse(readFileSync(join(__dirname, '../../../tests/fixtures/noise-cacophony.json'), 'utf8')) as { vectors: Vector[] }).vectors;
const hex = (s: string) => Buffer.from(s, 'hex');

describe('the official test vectors', () => {
  test.each(vectors.map((v) => [v.protocol_name, v] as const))('%s', (_name, v) => {
    const init = new NoiseHandshake({ protocol: v.protocol_name, initiator: true, prologue: hex(v.init_prologue), s: keyPairFromPrivate(hex(v.init_static)), e: keyPairFromPrivate(hex(v.init_ephemeral)), ...(v.init_psks ? { psk: hex(v.init_psks[0]!) } : {}) });
    const resp = new NoiseHandshake({ protocol: v.protocol_name, initiator: false, prologue: hex(v.resp_prologue), s: keyPairFromPrivate(hex(v.resp_static)), e: keyPairFromPrivate(hex(v.resp_ephemeral)), ...(v.resp_psks ? { psk: hex(v.resp_psks[0]!) } : {}) });
    let transports: { init: NoiseTransport; resp: NoiseTransport } | null = null;
    v.messages.forEach((m, i) => {
      // The messages alternate, the initiator first, across the handshake and the transport messages after it.
      const fromInit = i % 2 === 0;
      if (!transports) {
        const [w, r] = fromInit ? [init, resp] : [resp, init];
        expect(w.writeMessage(hex(m.payload)).toString('hex')).toBe(m.ciphertext);
        expect(r.readMessage(hex(m.ciphertext)).toString('hex')).toBe(m.payload);
        if (init.finished && resp.finished) {
          expect(init.handshakeHash.toString('hex')).toBe(v.handshake_hash);
          expect(resp.handshakeHash.toString('hex')).toBe(v.handshake_hash);
          transports = { init: init.split(), resp: resp.split() };
        }
        return;
      }
      const [w, r] = fromInit ? [transports.init, transports.resp] : [transports.resp, transports.init];
      expect(w.encrypt(hex(m.payload)).toString('hex')).toBe(m.ciphertext);
      expect(r.decrypt(hex(m.ciphertext)).toString('hex')).toBe(m.payload);
    });
    expect(transports).not.toBeNull();
    expect(resp.remoteStatic?.toString('hex')).toBe(keyPairFromPrivate(hex(v.init_static)).publicKey.toString('hex'));
    expect(init.remoteStatic?.toString('hex')).toBe(keyPairFromPrivate(hex(v.resp_static)).publicKey.toString('hex'));
  });
});

describe('keys', () => {
  test('the public key of a private one (RFC 7748, section 6.1)', () => {
    const k = keyPairFromPrivate(hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'));
    expect(k.publicKey.toString('hex')).toBe('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
  });

  test('a generated pair is 32 + 32 bytes and consistent', () => {
    const k = generateKeyPair();
    expect(k.privateKey).toHaveLength(32);
    expect(keyPairFromPrivate(k.privateKey).publicKey.equals(k.publicKey)).toBe(true);
  });

  test('a key of the wrong length is refused', () => {
    expect(() => keyPairFromPrivate(Buffer.alloc(31))).toThrow();
  });
});

describe('failures', () => {
  const pair = (protocol: NoiseProtocol, o: { initPrologue?: string; respPrologue?: string; initPsk?: Buffer; respPsk?: Buffer } = {}) => {
    const psk = Buffer.alloc(32, 7);
    const init = new NoiseHandshake({ protocol, initiator: true, prologue: Buffer.from(o.initPrologue ?? 'p'), s: generateKeyPair(), ...(protocol.includes('psk') ? { psk: o.initPsk ?? psk } : {}) });
    const resp = new NoiseHandshake({ protocol, initiator: false, prologue: Buffer.from(o.respPrologue ?? 'p'), s: generateKeyPair(), ...(protocol.includes('psk') ? { psk: o.respPsk ?? psk } : {}) });
    return { init, resp };
  };

  test('a full handshake, then transport both ways', () => {
    const { init, resp } = pair('Noise_XX_25519_AESGCM_SHA256');
    resp.readMessage(init.writeMessage(Buffer.alloc(0)));
    expect(init.readMessage(resp.writeMessage(Buffer.from('host hello'))).toString()).toBe('host hello');
    expect(resp.readMessage(init.writeMessage(Buffer.from('device hello'))).toString()).toBe('device hello');
    const a = init.split(); const b = resp.split();
    expect(b.decrypt(a.encrypt(Buffer.from('ping'))).toString()).toBe('ping');
    expect(a.decrypt(b.encrypt(Buffer.from('pong'))).toString()).toBe('pong');
    expect(a.sent).toBe(1);
    expect(a.received).toBe(1);
  });

  test('a tampered message fails to decrypt', () => {
    const { init, resp } = pair('Noise_XX_25519_AESGCM_SHA256');
    resp.readMessage(init.writeMessage(Buffer.alloc(0)));
    const m2 = resp.writeMessage(Buffer.from('hello'));
    m2[m2.length - 1]! ^= 1;
    expect(() => init.readMessage(m2)).toThrow();
  });

  test('XXpsk3: a wrong prologue fails at the first message already (its empty payload is authenticated)', () => {
    const { init, resp } = pair('Noise_XXpsk3_25519_AESGCM_SHA256', { initPrologue: 'a', respPrologue: 'b' });
    const m1 = init.writeMessage(Buffer.alloc(0));
    expect(m1).toHaveLength(48);
    expect(() => resp.readMessage(m1)).toThrow();
  });

  test('XXpsk3: a wrong pre-shared key fails at the third message', () => {
    const { init, resp } = pair('Noise_XXpsk3_25519_AESGCM_SHA256', { initPsk: Buffer.alloc(32, 1), respPsk: Buffer.alloc(32, 2) });
    resp.readMessage(init.writeMessage(Buffer.alloc(0)));
    init.readMessage(resp.writeMessage(Buffer.alloc(0)));
    expect(() => resp.readMessage(init.writeMessage(Buffer.alloc(0)))).toThrow();
  });

  test('messages out of turn, or after the handshake, are refused', () => {
    const { init, resp } = pair('Noise_XX_25519_AESGCM_SHA256');
    expect(() => resp.writeMessage(Buffer.alloc(0))).toThrow();
    expect(() => init.readMessage(Buffer.alloc(32))).toThrow();
    expect(() => init.split()).toThrow();
  });

  test('a message too short for its tokens is refused', () => {
    const { resp } = pair('Noise_XX_25519_AESGCM_SHA256');
    expect(() => resp.readMessage(Buffer.alloc(10))).toThrow();
  });

  test('a low-order public key (an all-zero shared secret) is refused', () => {
    const { resp } = pair('Noise_XX_25519_AESGCM_SHA256');
    resp.readMessage(Buffer.alloc(32));
    expect(() => resp.writeMessage(Buffer.alloc(0))).toThrow();
  });

  test('a transport message replayed or reordered fails', () => {
    const { init, resp } = pair('Noise_XX_25519_AESGCM_SHA256');
    resp.readMessage(init.writeMessage(Buffer.alloc(0)));
    init.readMessage(resp.writeMessage(Buffer.alloc(0)));
    resp.readMessage(init.writeMessage(Buffer.alloc(0)));
    const a = init.split(); const b = resp.split();
    const one = a.encrypt(Buffer.from('1'));
    const two = a.encrypt(Buffer.from('2'));
    expect(() => b.decrypt(two)).toThrow();
    // A failed decryption does not advance the nonce: the right message still opens.
    expect(b.decrypt(one).toString()).toBe('1');
    expect(() => b.decrypt(one)).toThrow();
  });

  test('a transport message is at most 65535 bytes: none larger is made, none larger is decrypted', () => {
    const { init, resp } = pair('Noise_XX_25519_AESGCM_SHA256');
    resp.readMessage(init.writeMessage(Buffer.alloc(0)));
    init.readMessage(resp.writeMessage(Buffer.alloc(0)));
    resp.readMessage(init.writeMessage(Buffer.alloc(0)));
    const a = init.split(); const b = resp.split();
    // The largest: 65519 bytes of plaintext and the 16-byte tag.
    const full = a.encrypt(Buffer.alloc(65535 - 16, 1));
    expect(full).toHaveLength(65535);
    expect(b.decrypt(full)).toHaveLength(65519);
    expect(() => a.encrypt(Buffer.alloc(65535 - 15))).toThrow(/too large/);
    // Refused before any work, and the nonce stays: the next real message still opens.
    expect(() => b.decrypt(Buffer.alloc(65536))).toThrow(/too large/);
    expect(b.decrypt(a.encrypt(Buffer.from('next'))).toString()).toBe('next');
  });
});
