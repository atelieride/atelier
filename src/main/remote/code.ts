// Pairing codes: 12 symbols of Crockford's base32 (60 bits from the CSPRNG), shown as three groups of four. Both ends
// derive two values from the code with a deliberately slow PBKDF2: the lookup, the name under which the relay finds
// this computer, and the pre-shared key of the pairing handshake. The QR code carries the same code, plus the relay to
// use and this computer's public key, which the phone then pins.
import { pbkdf2, randomInt } from 'node:crypto';
import { b64url, fromB64url } from './wire';

export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 12;
/** How long a code lives before the pairing sheet shows a fresh one. */
export const CODE_TTL_MS = 5 * 60_000;

const PBKDF2_SALT = 'atelier-pair-v1';
const PBKDF2_ROUNDS = 100_000;

/** A fresh code, normalised (no dashes). `rand(32)` picks each symbol: the CSPRNG's unbiased randomInt by default. */
export function newCode(rand: (max: number) => number = randomInt): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[rand(CODE_ALPHABET.length)];
  return out;
}

/** `7K4Q-9MXD-2HTR`. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

const isCode = (s: string): boolean => s.length === CODE_LENGTH && [...s].every((c) => CODE_ALPHABET.includes(c));

/**
 * A typed code as both ends read it: upper-cased, spaces and dashes dropped, O read as 0 and I or L as 1. Anything
 * else outside the alphabet, or a length other than 12, is not a code (null).
 */
export function normalizeCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[ -]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return isCode(s) ? s : null;
}

export interface CodeKeys {
  /** base64url of the first 32 bytes: what the relay resolves to this computer. */
  lookup: string;
  /** The last 32 bytes: the pairing handshake's pre-shared key. */
  psk: Buffer;
}

/** The code's lookup and pre-shared key; off the main thread (about a tenth of a second of hashing). */
export function deriveCode(code: string): Promise<CodeKeys> {
  if (!isCode(code)) return Promise.reject(new Error('not a normalised code'));
  return new Promise((resolve, reject) => {
    pbkdf2(Buffer.from(code, 'ascii'), PBKDF2_SALT, PBKDF2_ROUNDS, 64, 'sha256', (err, dk) => {
      if (err) reject(err);
      else resolve({ lookup: b64url(dk.subarray(0, 32)), psk: Buffer.from(dk.subarray(32)) });
    });
  });
}

export interface PairTarget {
  code: string;
  /** The relay's base URL (http or https). */
  relay: string;
  /** This computer's static public key, 32 bytes: the phone aborts the pairing unless the computer proves it. */
  hostKey: Buffer;
  /** The computer's name, shown on the phone while it pairs. */
  name: string;
}

/** The QR code's text: `atelier://pair?v=1&c=<code>&r=<relay>&k=<host key>&n=<name>`. */
export function pairUrl(t: PairTarget): string {
  return `atelier://pair?v=1&c=${t.code}&r=${encodeURIComponent(t.relay)}&k=${b64url(t.hostKey)}&n=${encodeURIComponent(t.name)}`;
}

/** A QR code's text read back, as the phone reads it; null when it isn't one. */
export function parsePairUrl(text: string): PairTarget | null {
  let u: URL;
  try { u = new URL(text); } catch { return null; }
  if (u.protocol !== 'atelier:' || u.host !== 'pair' || u.searchParams.get('v') !== '1') return null;
  const code = normalizeCode(u.searchParams.get('c') ?? '');
  const relay = u.searchParams.get('r');
  const hostKey = fromB64url(u.searchParams.get('k') ?? '', 32);
  const name = u.searchParams.get('n') ?? '';
  if (!code || !relay || !hostKey) return null;
  return { code, relay, hostKey, name };
}
