// The MSIX as a file, with Node built-ins only: the release jobs that check it (environment `release`) install nothing.
//
// An MSIX is a ZIP (makeappx writes the ZIP64 form): readZipEntry reads one file of it (the package manifest);
// writeZip makes a plain or ZIP64 ZIP (the tests build their packages with it).
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { msixVersion } from './win/msix-version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The committed manifest template: the package identity the Store reserved (Name, Publisher). */
export const MANIFEST_TEMPLATE = join(ROOT, 'build/appx/AppxManifest.xml');

const SIG = { local: 0x04034b50, central: 0x02014b50, eocd: 0x06054b50, eocd64: 0x06064b50, locator64: 0x07064b50 };
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** 1980-01-01 00:00 in DOS form: the archive is the same bytes whenever it is made. */
const DOS_DATE = 0x0021;

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, position + done);
    if (n === 0) break;
    done += n;
  }
  return buf.subarray(0, done);
}

/** The central directory's place and size, from the end records (ZIP64 when the classic fields are saturated). */
function centralDirectory(fd, size, file) {
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = readAt(fd, size - tailLen, tailLen);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG.eocd) { at = i; break; }
  }
  if (at < 0) throw new Error(`${file} is not a ZIP (no end of central directory): not an MSIX.`);
  let entries = tail.readUInt16LE(at + 10);
  let cdSize = tail.readUInt32LE(at + 12);
  let cdOffset = tail.readUInt32LE(at + 16);
  if (entries === MAX16 || cdSize === MAX32 || cdOffset === MAX32) {
    const locAt = size - tailLen + at - 20;
    const loc = locAt >= 0 ? readAt(fd, locAt, 20) : Buffer.alloc(0);
    if (loc.length !== 20 || loc.readUInt32LE(0) !== SIG.locator64) throw new Error(`${file}: ZIP64 locator missing.`);
    const rec = readAt(fd, Number(loc.readBigUInt64LE(8)), 56);
    if (rec.length !== 56 || rec.readUInt32LE(0) !== SIG.eocd64) throw new Error(`${file}: ZIP64 end of central directory missing.`);
    entries = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  }
  if (cdOffset + cdSize > size) throw new Error(`${file}: the central directory lies outside the file.`);
  if (cdSize > 64 * 1024 * 1024) throw new Error(`${file}: a central directory of ${cdSize} bytes, more than expected.`);
  return { entries, cdSize, cdOffset };
}

/**
 * The bytes of `name` inside the ZIP at `file` (stored or deflated), checked against its CRC-32. Reads only the end
 * records, the central directory and that entry: an MSIX is hundreds of MB.
 */
export function readZipEntry(file, name, { maxBytes = 64 * 1024 * 1024 } = {}) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const { entries, cdSize, cdOffset } = centralDirectory(fd, size, file);
    const cd = readAt(fd, cdOffset, cdSize);
    let p = 0;
    for (let i = 0; i < entries; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG.central) throw new Error(`${file}: corrupt central directory.`);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressed = cd.readUInt32LE(p + 20);
      let uncompressed = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const entryName = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      // ZIP64 extended information: the saturated fields, in this order.
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      for (let e = 0; e + 4 <= extra.length;) {
        const id = extra.readUInt16LE(e);
        const len = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressed === MAX32) { uncompressed = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (compressed === MAX32) { compressed = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (offset === MAX32) { offset = Number(extra.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + len;
      }
      p += 46 + nameLen + extraLen + commentLen;
      if (entryName !== name) continue;
      // Both sizes bounded before reading (deflate adds at most a few bytes per 16 KB to incompressible data).
      if (uncompressed > maxBytes || compressed > maxBytes + (maxBytes >> 6)) throw new Error(`${file}: ${name} is ${Math.max(uncompressed, compressed)} bytes, more than expected.`);
      const local = readAt(fd, offset, 30);
      if (local.length !== 30 || local.readUInt32LE(0) !== SIG.local) throw new Error(`${file}: no local header for ${name}.`);
      const start = offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const raw = readAt(fd, start, compressed);
      if (raw.length !== compressed) throw new Error(`${file}: ${name} is truncated.`);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: maxBytes });
      else throw new Error(`${file}: ${name} uses ZIP method ${method} (only stored and deflate are read).`);
      if (data.length !== uncompressed || crc32(data) !== crc) throw new Error(`${file}: ${name} fails its CRC-32 or size check.`);
      return data;
    }
    throw new Error(`${file} has no ${name}.`);
  } finally {
    closeSync(fd);
  }
}

/**
 * A ZIP of `entries` ([{ name, data }]): stored (the default: an MSIX is compressed already) or deflated, classic or
 * ZIP64 (tests use both forms to exercise the reader). Names are ASCII paths with `/`.
 */
export function writeZip(entries, { deflate = false, zip64 = false } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    if (!/^[\x20-\x7e]+$/.test(name) || name.startsWith('/') || name.includes('\\')) throw new Error(`Bad ZIP entry name: ${name}`);
    const nameBuf = Buffer.from(name, 'ascii');
    const body = deflate ? deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const crc = crc32(data);
    if (!zip64 && (body.length >= MAX32 || data.length >= MAX32 || offset >= MAX32)) throw new Error('The ZIP would need ZIP64.');
    const version = zip64 ? 45 : 20;
    const localExtra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (zip64) {
      localExtra.writeUInt16LE(0x0001, 0);
      localExtra.writeUInt16LE(16, 2);
      localExtra.writeBigUInt64LE(BigInt(data.length), 4);
      localExtra.writeBigUInt64LE(BigInt(body.length), 12);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG.local, 0);
    local.writeUInt16LE(version, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(zip64 ? MAX32 : body.length, 18);
    local.writeUInt32LE(zip64 ? MAX32 : data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    parts.push(local, nameBuf, localExtra, body);

    const cExtra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      cExtra.writeUInt16LE(0x0001, 0);
      cExtra.writeUInt16LE(24, 2);
      cExtra.writeBigUInt64LE(BigInt(data.length), 4);
      cExtra.writeBigUInt64LE(BigInt(body.length), 12);
      cExtra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(SIG.central, 0);
    c.writeUInt16LE(version, 4);
    c.writeUInt16LE(version, 6);
    c.writeUInt16LE(0, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(DOS_DATE, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(zip64 ? MAX32 : body.length, 20);
    c.writeUInt32LE(zip64 ? MAX32 : data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt16LE(cExtra.length, 30);
    c.writeUInt32LE(zip64 ? MAX32 : offset, 42);
    central.push(c, nameBuf, cExtra);
    offset += local.length + nameBuf.length + localExtra.length + body.length;
  }
  const cd = Buffer.concat(central);
  const tail = [];
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(SIG.eocd64, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(entries.length), 24);
    rec.writeBigUInt64LE(BigInt(entries.length), 32);
    rec.writeBigUInt64LE(BigInt(cd.length), 40);
    rec.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(SIG.locator64, 0);
    loc.writeBigUInt64LE(BigInt(offset + cd.length), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(rec, loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG.eocd, 0);
  eocd.writeUInt16LE(zip64 ? MAX16 : entries.length, 8);
  eocd.writeUInt16LE(zip64 ? MAX16 : entries.length, 10);
  eocd.writeUInt32LE(zip64 ? MAX32 : cd.length, 12);
  eocd.writeUInt32LE(zip64 ? MAX32 : offset, 16);
  return Buffer.concat([...parts, cd, ...tail, eocd]);
}

function identityOf(xml, where) {
  const tag = /<Identity\b([^>]*?)\/?>/.exec(xml.replace(/^﻿/, ''))?.[1];
  if (!tag) throw new Error(`${where} has no <Identity>.`);
  const attrs = Object.fromEntries([...tag.matchAll(/([A-Za-z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  return { name: attrs.Name, publisher: attrs.Publisher, version: attrs.Version, arch: attrs.ProcessorArchitecture };
}

/** The package identity in the MSIX's AppxManifest.xml. */
export function msixIdentity(file) {
  return identityOf(readZipEntry(file, 'AppxManifest.xml').toString('utf8'), `${file} (AppxManifest.xml)`);
}

/**
 * Problems between the MSIX and the release it must be ([] when it matches): the Store identity of the committed
 * manifest template, msixVersion(version) and x64.
 */
export function msixProblems(file, { version, template = MANIFEST_TEMPLATE }) {
  let got;
  try { got = msixIdentity(file); } catch (e) { return [e instanceof Error ? e.message : String(e)]; }
  const want = identityOf(readFileSync(template, 'utf8'), template);
  const problems = [];
  if (got.name !== want.name) problems.push(`MSIX identity name ${got.name}, expected ${want.name}`);
  if (got.publisher !== want.publisher) problems.push(`MSIX publisher ${got.publisher}, expected ${want.publisher}`);
  let wantVersion;
  try { wantVersion = msixVersion(version); } catch (e) { problems.push(`No MSIX version for ${version}: ${e instanceof Error ? e.message : e}`); }
  if (wantVersion && got.version !== wantVersion) problems.push(`MSIX version ${got.version}, expected ${wantVersion} (release ${version})`);
  if (got.arch !== 'x64') problems.push(`MSIX architecture ${got.arch}, expected x64`);
  return problems;
}
