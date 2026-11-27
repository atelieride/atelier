import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { expectMode } from '../../../tests/support/platform';
import { IMAGE_TTL_MS, MAX_HELD_IMAGES, MAX_PHONE_IMAGE, PhoneImages, imageOf, imagePaste } from './images';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const b64 = (b: Buffer) => b.toString('base64url');
const UNUSABLE = { code: 'invalid', message: 'This image can\'t be used.' };

test('imageOf: a png or a jpeg whose bytes start with its own signature, 1 byte to 2 MiB once decoded', () => {
  expect(imageOf('png', b64(PNG))).toEqual({ bytes: PNG, ext: 'png' });
  expect(imageOf('jpeg', b64(JPEG))).toEqual({ bytes: JPEG, ext: 'jpg' });
  // The largest one that goes.
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_PHONE_IMAGE - PNG.length)]);
  expect(imageOf('png', b64(big))?.bytes.length).toBe(MAX_PHONE_IMAGE);
  // Another type, a signature of the other type or of none, too large, nothing.
  expect(imageOf('gif', b64(PNG))).toBeNull();
  expect(imageOf('PNG', b64(PNG))).toBeNull();
  expect(imageOf('png', b64(JPEG))).toBeNull();
  expect(imageOf('jpeg', b64(PNG))).toBeNull();
  expect(imageOf('png', b64(PNG.subarray(0, 7)))).toBeNull();
  expect(imageOf('png', b64(Buffer.concat([big, Buffer.alloc(1)])))).toBeNull();
  expect(imageOf('png', '')).toBeNull();
});

test('imageOf: base64url without padding only, as every binary value; never another spelling, nor one that decodes loosely', () => {
  // 13 bytes: their base64 has a '+', a '/' and padding, their base64url a '-' and a '_'.
  const bytes = Buffer.concat([PNG, Buffer.from([0xfb, 0xff, 0xbf, 0x3e, 0x01])]);
  const url = bytes.toString('base64url');
  const std = bytes.toString('base64');
  expect(std).toMatch(/[+/].*=$/);
  expect(url).toMatch(/[-_]/);
  // A last character alone is no byte: 4k + 1 characters.
  expect(`${url}AA`.length % 4).toBe(1);
  expect(imageOf('png', url)?.bytes).toEqual(bytes);
  // base64, padded or not; base64url padded; a character outside it, a line break, a lone last character, stray bits.
  for (const data of [std, std.replace(/=+$/, ''), `${url}==`, `${url.slice(0, 4)}*${url.slice(5)}`, `${url.slice(0, 8)}\n${url.slice(8)}`, `${url}AA`, `${url.slice(0, -1)}B`]) {
    expect(imageOf('png', data), data).toBeNull();
  }
});

/** A store over a temp folder, its clock moved by hand. */
function store(o: { ttlMs?: number } = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), 'atl-phone-images-')), 'clipboard');
  let now = 1_000;
  const images = new PhoneImages({ dir, now: () => now, ...(o.ttlMs ? { ttlMs: o.ttlMs } : {}) });
  return { images, dir, later: (ms: number) => { now += ms; } };
}

test('keep: a private file in the folder (png or jpg), and an opaque reference that names it for that terminal only', () => {
  const s = store();
  const a = s.images.keep('t1', 'png', b64(PNG));
  const b = s.images.keep('t1', 'jpeg', b64(JPEG));
  if ('code' in a || 'code' in b) throw new Error('refused');
  expect(a.ref).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(b.ref).not.toBe(a.ref);
  const files = readdirSync(s.dir).sort();
  expect(files).toHaveLength(2);
  expect(files.map((f) => f.split('.').pop()).sort()).toEqual(['jpg', 'png']);
  const pa = s.images.pathOf(a.ref, 't1')!;
  expect(pa.startsWith(s.dir)).toBe(true);
  expect(readFileSync(pa)).toEqual(PNG);
  expect(readFileSync(s.images.pathOf(b.ref, 't1')!)).toEqual(JPEG);
  expectMode(pa, 0o600);
  expectMode(s.dir, 0o700);
  // Another terminal's, a reference never given, every reference of a list or none.
  expect(s.images.pathOf(a.ref, 't2')).toBeNull();
  expect(s.images.pathOf('x'.repeat(22), 't1')).toBeNull();
  expect(s.images.pathsOf([b.ref, a.ref], 't1')).toEqual([s.images.pathOf(b.ref, 't1'), pa]);
  expect(s.images.pathsOf([a.ref, 'nope'], 't1')).toBeNull();
  // An image that can't be used is never kept.
  expect(s.images.keep('t1', 'png', b64(JPEG))).toEqual(UNUSABLE);
  expect(readdirSync(s.dir)).toHaveLength(2);
});

test('a reference lasts 10 minutes; at most 10 are held at once, a new one dropping the oldest', () => {
  const s = store();
  const kept = () => { const r = s.images.keep('t1', 'png', b64(PNG)); if ('code' in r) throw new Error('refused'); return r.ref; };
  const refs: string[] = [];
  for (let i = 0; i < MAX_HELD_IMAGES; i++) { refs.push(kept()); s.later(1000); }
  // An eleventh: the first goes, the rest stay.
  refs.push(kept());
  expect(s.images.pathOf(refs[0]!, 't1')).toBeNull();
  expect(refs.slice(1).every((r) => s.images.pathOf(r, 't1') !== null)).toBe(true);
  // The second runs out: it names nothing any more.
  s.later(IMAGE_TTL_MS - MAX_HELD_IMAGES * 1000 + 1000);
  expect(s.images.pathOf(refs[1]!, 't1')).toBeNull();
  expect(s.images.pathOf(refs[2]!, 't1')).not.toBeNull();
  // Gone with the channel.
  s.images.clear();
  expect(s.images.pathOf(refs[2]!, 't1')).toBeNull();
});

test('use: references used up name nothing any more; the others stay', () => {
  const s = store();
  const [a, b, c] = [0, 1, 2].map(() => { const r = s.images.keep('t1', 'png', b64(PNG)); if ('code' in r) throw new Error('refused'); return r.ref; });
  s.images.use([a!, b!]);
  expect(s.images.pathOf(a!, 't1')).toBeNull();
  expect(s.images.pathsOf([b!], 't1')).toBeNull();
  expect(s.images.pathOf(c!, 't1')).not.toBeNull();
  // Used up again, or never given: nothing happens.
  s.images.use([a!, 'nope']);
  expect(s.images.pathOf(c!, 't1')).not.toBeNull();
});

test('a folder that can\'t be written: failed, no reference', () => {
  const s = store();
  const images = new PhoneImages({ dir: join(s.dir, 'x'), save: () => { throw new Error('EACCES'); } });
  expect(images.keep('t1', 'png', b64(PNG))).toEqual({ code: 'failed', message: 'The image could not be saved on the computer.' });
});

test('imagePaste: the path as Atelier\'s own Paste types it, bracketed only when the program asked for it', () => {
  expect(imagePaste('/tmp/atelier-clipboard/clipboard-1.png', true)).toBe('\x1b[200~/tmp/atelier-clipboard/clipboard-1.png\x1b[201~');
  expect(imagePaste('/tmp/atelier-clipboard/clipboard-1.png', false)).toBe('/tmp/atelier-clipboard/clipboard-1.png');
});
