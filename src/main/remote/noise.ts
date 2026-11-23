// The Noise protocol framework (revision 34) for iPhone access: the XX and XXpsk3 handshakes with X25519,
// AES-256-GCM and SHA-256, on node:crypto alone. AES-GCM, not ChaChaPoly: the main process runs on Electron's crypto
// (BoringSSL), whose ciphers have no chacha20-poly1305. Both roles: Atelier answers as the responder, the test phone
// drives the initiator. Ephemeral keys can be injected (test vectors); otherwise each handshake makes its own.
// Nothing here knows about the relay, the app messages or Electron, so the test phone can import it as is.
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, randomBytes, type KeyObject } from 'node:crypto';

export type NoiseProtocol = 'Noise_XX_25519_AESGCM_SHA256' | 'Noise_XXpsk3_25519_AESGCM_SHA256';

/** An X25519 key pair, both halves raw 32 bytes. */
export interface KeyPair { publicKey: Buffer; privateKey: Buffer }

/** The largest Noise message (handshake or transport), and the authentication tag each encrypted part carries. */
export const NOISE_MAX_MESSAGE = 65535;
export const NOISE_TAG = 16;
const DH_LEN = 32;
const HASH_LEN = 32;

// The fixed DER prefixes that wrap a raw X25519 key into the PKCS#8 / SPKI forms node:crypto takes.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

const privateKeyObject = (raw: Uint8Array): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
const publicKeyObject = (raw: Uint8Array): KeyObject => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });

export function keyPairFromPrivate(raw: Uint8Array): KeyPair {
  if (raw.length !== DH_LEN) throw new Error('an X25519 private key is 32 bytes');
  const pub = createPublicKey(privateKeyObject(raw)).export({ format: 'der', type: 'spki' });
  return { privateKey: Buffer.from(raw), publicKey: Buffer.from(pub.subarray(SPKI_PREFIX.length)) };
}

/** A fresh key pair from the CSPRNG (X25519 clamps any 32 bytes into a valid scalar). */
export function generateKeyPair(): KeyPair {
  return keyPairFromPrivate(randomBytes(DH_LEN));
}

function dh(priv: Buffer, pub: Buffer): Buffer {
  const out = diffieHellman({ privateKey: privateKeyObject(priv), publicKey: publicKeyObject(pub) });
  // A low-order public key gives an all-zero secret: nothing secret would come out of it.
  if (out.every((b) => b === 0)) throw new Error('invalid public key');
  return out;
}

const sha256 = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
const hmac = (key: Uint8Array, ...parts: Uint8Array[]): Buffer => {
  const h = createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return h.digest();
};

/** Noise's HKDF: two or three 32-byte outputs from the chaining key and the input key material. */
function hkdf(ck: Buffer, ikm: Uint8Array, outputs: 2 | 3): Buffer[] {
  const temp = hmac(ck, ikm);
  const o1 = hmac(temp, Buffer.from([1]));
  const o2 = hmac(temp, o1, Buffer.from([2]));
  return outputs === 2 ? [o1, o2] : [o1, o2, hmac(temp, o2, Buffer.from([3]))];
}

/** One direction's key and nonce. Nonces are 32 zero bits then the 64-bit counter, big-endian (Noise's AESGCM). */
class CipherState {
  private n = 0;
  constructor(private readonly k: Buffer | null = null) {}

  hasKey(): boolean { return this.k !== null; }
  get count(): number { return this.n; }

  private nonce(): Buffer {
    const iv = Buffer.alloc(12);
    iv.writeUInt32BE(Math.floor(this.n / 2 ** 32), 4);
    iv.writeUInt32BE(this.n >>> 0, 8);
    return iv;
  }

  encrypt(ad: Uint8Array, plaintext: Uint8Array): Buffer {
    if (!this.k) throw new Error('no key');
    const c = createCipheriv('aes-256-gcm', this.k, this.nonce(), { authTagLength: NOISE_TAG });
    c.setAAD(ad);
    const out = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
    this.n++;
    return out;
  }

  /** Throws when the message doesn't authenticate; the nonce then stays where it was. */
  decrypt(ad: Uint8Array, ciphertext: Uint8Array): Buffer {
    if (!this.k) throw new Error('no key');
    if (ciphertext.length < NOISE_TAG) throw new Error('message too short');
    const body = ciphertext.subarray(0, ciphertext.length - NOISE_TAG);
    const d = createDecipheriv('aes-256-gcm', this.k, this.nonce(), { authTagLength: NOISE_TAG });
    d.setAAD(ad);
    d.setAuthTag(ciphertext.subarray(ciphertext.length - NOISE_TAG));
    const out = Buffer.concat([d.update(body), d.final()]);
    this.n++;
    return out;
  }
}

class SymmetricState {
  ck: Buffer;
  h: Buffer;
  cs = new CipherState();

  constructor(protocol: string) {
    const name = Buffer.from(protocol, 'ascii');
    // A name of up to 32 bytes is the hash itself, zero-padded; a longer one is hashed.
    this.h = name.length <= HASH_LEN ? Buffer.concat([name, Buffer.alloc(HASH_LEN - name.length)]) : sha256(name);
    this.ck = Buffer.from(this.h);
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf(this.ck, ikm, 2);
    this.ck = ck!;
    this.cs = new CipherState(k!);
  }

  mixHash(data: Uint8Array): void { this.h = sha256(this.h, data); }

  mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, h, k] = hkdf(this.ck, ikm, 3);
    this.ck = ck!;
    this.mixHash(h!);
    this.cs = new CipherState(k!);
  }

  encryptAndHash(plaintext: Uint8Array): Buffer {
    const out = this.cs.hasKey() ? this.cs.encrypt(this.h, plaintext) : Buffer.from(plaintext);
    this.mixHash(out);
    return out;
  }

  decryptAndHash(ciphertext: Uint8Array): Buffer {
    const out = this.cs.hasKey() ? this.cs.decrypt(this.h, ciphertext) : Buffer.from(ciphertext);
    this.mixHash(ciphertext);
    return out;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, Buffer.alloc(0), 2);
    return [new CipherState(k1!), new CipherState(k2!)];
  }
}

type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'psk';
const PATTERNS: Record<NoiseProtocol, Token[][]> = {
  Noise_XX_25519_AESGCM_SHA256: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']],
  Noise_XXpsk3_25519_AESGCM_SHA256: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se', 'psk']]
};

/** The two directions after the handshake: what this side sends with, what it receives with. */
export class NoiseTransport {
  constructor(private readonly tx: CipherState, private readonly rx: CipherState) {}
  encrypt(plaintext: Uint8Array): Buffer { return this.tx.encrypt(Buffer.alloc(0), plaintext); }
  decrypt(ciphertext: Uint8Array): Buffer { return this.rx.decrypt(Buffer.alloc(0), ciphertext); }
  /** Transport messages sent and received so far. */
  get sent(): number { return this.tx.count; }
  get received(): number { return this.rx.count; }
}

export interface HandshakeOptions {
  protocol: NoiseProtocol;
  initiator: boolean;
  prologue: Uint8Array;
  /** This side's static key pair. */
  s: KeyPair;
  /** This side's ephemeral key pair: made fresh when left out. */
  e?: KeyPair;
  /** The pre-shared key, 32 bytes: XXpsk3 only. */
  psk?: Uint8Array;
}

export class NoiseHandshake {
  private readonly ss: SymmetricState;
  private readonly pattern: Token[][];
  private readonly psk: Buffer | null;
  private readonly initiator: boolean;
  private readonly s: KeyPair;
  private e: KeyPair | null;
  private re: Buffer | null = null;
  private rs: Buffer | null = null;
  private step = 0;

  constructor(o: HandshakeOptions) {
    this.pattern = PATTERNS[o.protocol];
    if (!this.pattern) throw new Error('unknown protocol');
    const wantsPsk = this.pattern.some((m) => m.includes('psk'));
    if (wantsPsk !== (o.psk !== undefined)) throw new Error(wantsPsk ? 'this protocol needs a pre-shared key' : 'this protocol takes no pre-shared key');
    if (o.psk && o.psk.length !== 32) throw new Error('a pre-shared key is 32 bytes');
    this.psk = o.psk ? Buffer.from(o.psk) : null;
    this.initiator = o.initiator;
    this.s = o.s;
    this.e = o.e ?? null;
    this.ss = new SymmetricState(o.protocol);
    this.ss.mixHash(o.prologue);
  }

  /** All the handshake's messages went through: split() gives the transport. */
  get finished(): boolean { return this.step >= this.pattern.length; }
  /** The other side's static public key, once its `s` token was read. */
  get remoteStatic(): Buffer | null { return this.rs; }
  /** The handshake hash (channel binding); final once finished. */
  get handshakeHash(): Buffer { return Buffer.from(this.ss.h); }

  private myTurn(): boolean { return (this.step % 2 === 0) === this.initiator; }

  writeMessage(payload: Uint8Array): Buffer {
    if (this.finished || !this.myTurn()) throw new Error('not this side\'s turn to write');
    const out: Buffer[] = [];
    for (const token of this.pattern[this.step]!) {
      switch (token) {
        case 'e': {
          this.e ??= generateKeyPair();
          out.push(this.e.publicKey);
          this.ss.mixHash(this.e.publicKey);
          if (this.psk) this.ss.mixKey(this.e.publicKey);
          break;
        }
        case 's': out.push(this.ss.encryptAndHash(this.s.publicKey)); break;
        default: this.mixToken(token);
      }
    }
    out.push(this.ss.encryptAndHash(payload));
    this.step++;
    const msg = Buffer.concat(out);
    if (msg.length > NOISE_MAX_MESSAGE) throw new Error('message too large');
    return msg;
  }

  /** The message's payload; throws when the message is malformed or doesn't authenticate. */
  readMessage(message: Uint8Array): Buffer {
    if (this.finished || this.myTurn()) throw new Error('not this side\'s turn to read');
    if (message.length > NOISE_MAX_MESSAGE) throw new Error('message too large');
    let at = 0;
    const take = (n: number): Buffer => {
      if (message.length - at < n) throw new Error('message too short');
      const part = Buffer.from(message.subarray(at, at + n));
      at += n;
      return part;
    };
    for (const token of this.pattern[this.step]!) {
      switch (token) {
        case 'e': {
          this.re = take(DH_LEN);
          this.ss.mixHash(this.re);
          if (this.psk) this.ss.mixKey(this.re);
          break;
        }
        case 's': this.rs = this.ss.decryptAndHash(take(this.ss.cs.hasKey() ? DH_LEN + NOISE_TAG : DH_LEN)); break;
        default: this.mixToken(token);
      }
    }
    const payload = this.ss.decryptAndHash(message.subarray(at));
    this.step++;
    return payload;
  }

  private mixToken(token: 'ee' | 'es' | 'se' | 'psk'): void {
    if (token === 'psk') { this.ss.mixKeyAndHash(this.psk!); return; }
    const e = this.e; const s = this.s; const re = this.re; const rs = this.rs;
    if (!e || !re) throw new Error('handshake out of order');
    if (token === 'ee') { this.ss.mixKey(dh(e.privateKey, re)); return; }
    // es: the initiator's ephemeral with the responder's static; se: the initiator's static with the responder's
    // ephemeral. Each side uses its own private half and the other's public one.
    const mineIsStatic = (token === 'es') !== this.initiator;
    if (mineIsStatic) { this.ss.mixKey(dh(s.privateKey, re)); return; }
    if (!rs) throw new Error('handshake out of order');
    this.ss.mixKey(dh(e.privateKey, rs));
  }

  split(): NoiseTransport {
    if (!this.finished) throw new Error('the handshake is not over');
    const [c1, c2] = this.ss.split();
    return this.initiator ? new NoiseTransport(c1, c2) : new NoiseTransport(c2, c1);
  }
}
