// The byte-level shapes both ends of an iPhone connection agree on, below the app messages: base64url, the Noise
// prologue and protocol of each channel kind, the fragments one JSON message travels in, and the relay's binary frames.
// Pure, node:crypto-free: the test phone and the test relay use the same functions.
import type { NoiseProtocol } from './noise';

/** What the relay calls a device connection: `pair` while pairing by code, `device` for a paired phone. */
export type ChannelKind = 'pair' | 'device';

export const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/**
 * base64url without padding, strictly: only its alphabet, the canonical encoding (no stray bits in the last symbol),
 * and `bytes` long when given. Null otherwise.
 */
export function fromB64url(s: string, bytes?: number): Buffer | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const out = Buffer.from(s, 'base64url');
  if (out.toString('base64url') !== s) return null;
  if (bytes !== undefined && out.length !== bytes) return null;
  return out;
}

const PROTOCOLS: Record<ChannelKind, NoiseProtocol> = {
  pair: 'Noise_XXpsk3_25519_AESGCM_SHA256',
  device: 'Noise_XX_25519_AESGCM_SHA256'
};
export const protocolOf = (kind: ChannelKind): NoiseProtocol => PROTOCOLS[kind];

/**
 * The handshake's prologue: "atelier-remote-v1", NUL, the channel kind, NUL, and the id the phone dialed (the code's
 * lookup for `pair`, the room id for `device`). Each side builds it from what it knows by itself, so a relay that
 * routes a phone to the wrong place makes the handshake fail.
 */
export function prologue(kind: ChannelKind, id: string): Buffer {
  return Buffer.concat([Buffer.from('atelier-remote-v1', 'ascii'), Buffer.from([0]), Buffer.from(kind, 'ascii'), Buffer.from([0]), Buffer.from(id, 'ascii')]);
}

/** A transport message's plaintext: one flag byte (0x01: more fragments follow, 0x00: the last), then the bytes. */
export const MAX_FRAGMENT = 65535 - 16 - 1;
/** The largest app message once reassembled. */
export const MAX_APP_MESSAGE = 8 * 1024 * 1024;

/** A message's UTF-8 bytes as the fragments it travels in, in order. */
export function fragments(message: Uint8Array): Buffer[] {
  if (message.length > MAX_APP_MESSAGE) throw new Error('message too large');
  const out: Buffer[] = [];
  for (let at = 0; ; at += MAX_FRAGMENT) {
    const end = Math.min(at + MAX_FRAGMENT, message.length);
    const last = end >= message.length;
    out.push(Buffer.concat([Buffer.from([last ? 0 : 1]), message.subarray(at, end)]));
    if (last) return out;
  }
}

/** Fragments back into messages; throws on a malformed fragment or a message beyond MAX_APP_MESSAGE. */
export class Reassembler {
  private parts: Buffer[] = [];
  private size = 0;

  /** The whole message once its last fragment is in, else null. */
  push(plain: Uint8Array): Buffer | null {
    if (plain.length < 1) throw new Error('empty fragment');
    const flag = plain[0];
    if (flag !== 0 && flag !== 1) throw new Error('unknown fragment flag');
    this.size += plain.length - 1;
    if (this.size > MAX_APP_MESSAGE) throw new Error('message too large');
    this.parts.push(Buffer.from(plain.subarray(1)));
    if (flag === 1) return null;
    const out = Buffer.concat(this.parts);
    this.parts = [];
    this.size = 0;
    return out;
  }
}

/** A relay binary frame: the channel id (4 bytes, big-endian), then the payload. */
export function channelFrame(ch: number, payload: Uint8Array): Buffer {
  const out = Buffer.alloc(4 + payload.length);
  out.writeUInt32BE(ch >>> 0, 0);
  out.set(payload, 4);
  return out;
}

export function parseChannelFrame(frame: Uint8Array): { ch: number; payload: Buffer } | null {
  if (frame.length < 4) return null;
  const b = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  return { ch: b.readUInt32BE(0), payload: Buffer.from(b.subarray(4)) };
}
