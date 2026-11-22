// The interop vectors for iPhone access (tests/fixtures/remote-interop-vectors.json), built from Atelier's own code
// with fixed keys, codes and messages: the iPhone app checks its implementation against the same file. Hex for raw
// bytes, base64url where the wire carries base64url. src/main/remote/interop-vectors.test.ts keeps the file equal to
// what this builds (ATELIER_WRITE_REMOTE_VECTORS=1 writes it again).
import { deriveCode, formatCode, normalizeCode } from '../../src/main/remote/code';
import { roomIdOf } from '../../src/main/remote/identity';
import { NoiseHandshake, keyPairFromPrivate } from '../../src/main/remote/noise';
import { fragments, prologue, protocolOf, type ChannelKind } from '../../src/main/remote/wire';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fixed = (byte: number) => Buffer.alloc(32, byte);

/** 32 bytes counting up from `start`: fixed, and different for every key. */
const counting = (start: number) => Buffer.from(Array.from({ length: 32 }, (_, i) => (start + i) & 0xff));
const ROOM_SECRET = counting(0x00);
const HOST_STATIC = counting(0x40);
const DEVICE_STATIC = counting(0x80);
const CODES = ['7K4Q9MXD2HTR', '000000000000', 'ZZZZZZZZZZZZ', 'ABCDEFGHJKMN'];
const NORMALIZE = ['7k4q-9mxd-2htr', ' 7K4Q 9MXD 2HTR ', 'OIL0-OIL0-OIL0', '7K4Q-9MXD-2HTU', '7K4Q-9MXD-2HT', '7K4Q_9MXD_2HTR'];

const HOST_HELLO = { v: 1, name: 'Studio Mac', app: '0.3.0', platform: 'darwin' };
const DEVICE_HELLO = { v: 1, name: 'Test iPhone', model: 'iPhone17,1', app: '1.0.0' };

interface Message { from: 'initiator' | 'responder'; payload: string; ciphertext: string; text?: string }

async function handshake(kind: ChannelKind) {
  const roomId = roomIdOf(ROOM_SECRET);
  const code = kind === 'pair' ? await deriveCode(CODES[0]!) : null;
  const pro = prologue(kind, code ? code.lookup : roomId);
  const iS = keyPairFromPrivate(DEVICE_STATIC); const iE = keyPairFromPrivate(fixed(kind === 'pair' ? 0x21 : 0x11));
  const rS = keyPairFromPrivate(HOST_STATIC); const rE = keyPairFromPrivate(fixed(kind === 'pair' ? 0x22 : 0x12));
  const protocol = protocolOf(kind);
  const psk = code ? { psk: code.psk } : {};
  const init = new NoiseHandshake({ protocol, initiator: true, prologue: pro, s: iS, e: iE, ...psk });
  const resp = new NoiseHandshake({ protocol, initiator: false, prologue: pro, s: rS, e: rE, ...psk });
  const messages: Message[] = [];
  const hs = (from: Message['from'], payload: Buffer) => {
    const [w, r] = from === 'initiator' ? [init, resp] : [resp, init];
    const ciphertext = w.writeMessage(payload);
    r.readMessage(ciphertext);
    messages.push({ from, payload: hex(payload), ciphertext: hex(ciphertext), ...(payload.length ? { text: payload.toString('utf8') } : {}) });
  };
  hs('initiator', Buffer.alloc(0));
  hs('responder', Buffer.from(JSON.stringify(HOST_HELLO)));
  hs('initiator', Buffer.from(JSON.stringify(DEVICE_HELLO)));
  const tx = { initiator: init.split(), responder: resp.split() };
  // Transport plaintexts carry the fragment byte: 0x00 last fragment, 0x01 more follow.
  const transport = (from: Message['from'], plain: Buffer) => {
    const to = from === 'initiator' ? tx.responder : tx.initiator;
    const ciphertext = tx[from].encrypt(plain);
    to.decrypt(ciphertext);
    messages.push({ from, payload: hex(plain), ciphertext: hex(ciphertext), text: plain.subarray(1).toString('utf8') });
  };
  const welcome = { t: 'welcome', host: { name: HOST_HELLO.name, platform: HOST_HELLO.platform }, ...(kind === 'pair' ? { room: roomId } : {}) };
  transport('responder', fragments(Buffer.from(JSON.stringify(welcome)))[0]!);
  transport('initiator', fragments(Buffer.from(JSON.stringify({ t: 'attach', rid: 1, id: 't1', cols: 80, rows: 24 })))[0]!);
  if (kind === 'pair') {
    // One app message in two fragments: 0x01 then 0x00, reassembled into the snapshot.
    const snap = Buffer.from(JSON.stringify({ t: 'snapshot', id: 't1', cols: 80, rows: 24, data: '\u001b[1mhello\u001b[0m\r\n$ ' }));
    const half = Math.floor(snap.length / 2);
    transport('responder', Buffer.concat([Buffer.from([1]), snap.subarray(0, half)]));
    transport('responder', Buffer.concat([Buffer.from([0]), snap.subarray(half)]));
  } else {
    transport('responder', fragments(Buffer.from(JSON.stringify({ t: 'out', id: 't1', data: 'ls\r\n' })))[0]!);
  }
  transport('initiator', fragments(Buffer.from(JSON.stringify({ t: 'input', id: 't1', data: 'echo hi\r' })))[0]!);
  return {
    kind, protocol,
    prologue: hex(pro),
    initiatorStatic: hex(iS.privateKey), initiatorStaticPublic: hex(iS.publicKey),
    initiatorEphemeral: hex(iE.privateKey),
    responderStatic: hex(rS.privateKey), responderStaticPublic: hex(rS.publicKey),
    responderEphemeral: hex(rE.privateKey),
    ...(code ? { psk: hex(code.psk) } : {}),
    messages,
    handshakeHash: hex(init.handshakeHash)
  };
}

export async function buildInteropVectors() {
  return {
    about: 'Atelier Remote v1 interop vectors: pairing codes and their PBKDF2 derivation, the room id, and one Noise handshake per channel kind followed by transport messages (each plaintext starts with the fragment byte). Raw bytes in hex; lookup and room id in base64url, as on the wire.',
    room: { secret: hex(ROOM_SECRET), id: roomIdOf(ROOM_SECRET) },
    codes: await Promise.all(CODES.map(async (code) => {
      const k = await deriveCode(code);
      return { code, formatted: formatCode(code), lookup: k.lookup, psk: hex(k.psk) };
    })),
    normalize: NORMALIZE.map((input) => ({ input, code: normalizeCode(input) })),
    handshakes: [await handshake('device'), await handshake('pair')]
  };
}
