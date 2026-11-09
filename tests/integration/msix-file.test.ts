import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { expect, test } from 'vitest';
// @ts-expect-error: .mjs script without types
import { msixIdentity, msixProblems, readZipEntry, writeZip } from '../../scripts/msix-file.mjs';

// scripts/msix-file.mjs: the MSIX is a ZIP (ZIP64, as makeappx writes it). The release jobs
// read its manifest with Node built-ins only.

const dir = () => mkdtempSync(join(tmpdir(), 'atl-msix-'));
const manifest = (version: string, o: { name?: string; publisher?: string; arch?: string } = {}) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">\n  <Identity Name="${o.name ?? 'FrancescoMusso.AtelierIDE'}" Publisher="${o.publisher ?? 'CN=F5719CFD-083A-4791-AA97-9440062FF386'}" Version="${version}" ProcessorArchitecture="${o.arch ?? 'x64'}" />\n</Package>\n`;

function msix(version: string, o: Parameters<typeof manifest>[1] & { zip64?: boolean; deflate?: boolean } = {}): string {
  const file = join(dir(), 'Atelier-test-x64.msix');
  writeFileSync(file, writeZip([
    { name: 'Atelier.exe', data: Buffer.from('MZ fake') },
    { name: 'resources/app.asar', data: Buffer.alloc(70_000, 7) },
    { name: 'AppxManifest.xml', data: Buffer.from(manifest(version, o)) }
  ], { zip64: o.zip64 ?? true, deflate: o.deflate ?? true }));
  return file;
}

test('writeZip + readZipEntry: stored and deflated entries, plain ZIP and ZIP64 (the form makeappx writes)', () => {
  for (const zip64 of [false, true]) {
    for (const deflate of [false, true]) {
      const file = join(dir(), 'a.zip');
      const big = Buffer.alloc(200_000, 3);
      writeFileSync(file, writeZip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'dir/b.bin', data: big }], { zip64, deflate }));
      expect(readZipEntry(file, 'a.txt').toString()).toBe('hello');
      expect(readZipEntry(file, 'dir/b.bin').equals(big)).toBe(true);
      expect(() => readZipEntry(file, 'missing.txt')).toThrow(/missing\.txt/);
    }
  }
});

test('writeZip without options: one stored entry, CRC and sizes right (what the Store API unpacks)', () => {
  const data = Buffer.from('package bytes');
  const zip = writeZip([{ name: 'Atelier-0.2.0-x64.msix', data }]);
  // Local file header: signature, version, flags 0, method 0 (stored), then CRC-32 and both sizes.
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  expect(zip.readUInt16LE(8)).toBe(0);
  expect(zip.readUInt32LE(14)).toBe(crc32(data));
  expect(zip.readUInt32LE(18)).toBe(data.length);
  expect(zip.readUInt32LE(22)).toBe(data.length);
  expect(zip.subarray(30, 30 + 22).toString()).toBe('Atelier-0.2.0-x64.msix');
  // End of central directory: one entry.
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  expect(zip.readUInt16LE(eocd + 10)).toBe(1);
  const file = join(dir(), 'up.zip');
  writeFileSync(file, zip);
  expect(readZipEntry(file, 'Atelier-0.2.0-x64.msix').equals(data)).toBe(true);
});

test('a corrupted entry is refused (CRC), and so is something that is not a ZIP', () => {
  const file = join(dir(), 'c.zip');
  const zip = writeZip([{ name: 'a.txt', data: Buffer.from('hello world') }]);
  zip[30 + 5 + 2] ^= 0xff;
  writeFileSync(file, zip);
  expect(() => readZipEntry(file, 'a.txt')).toThrow(/CRC/);
  const junk = join(dir(), 'junk.msix');
  writeFileSync(junk, 'not a zip at all');
  expect(() => readZipEntry(junk, 'AppxManifest.xml')).toThrow(/not a ZIP/);
});

test('sizes from the central directory are bounded before anything is read', () => {
  const file = join(dir(), 'big.zip');
  const zip = writeZip([{ name: 'a.txt', data: Buffer.from('hello world') }], { zip64: false, deflate: false });
  // The central directory entry's compressed size, claimed as 4 GB - 2.
  const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(0xfffffffe, cd + 20);
  writeFileSync(file, zip);
  expect(() => readZipEntry(file, 'a.txt')).toThrow(/more than expected/);
});

test('msixIdentity reads Identity from the package manifest', () => {
  expect(msixIdentity(msix('0.2.15.0'))).toEqual({
    name: 'FrancescoMusso.AtelierIDE', publisher: 'CN=F5719CFD-083A-4791-AA97-9440062FF386', version: '0.2.15.0', arch: 'x64'
  });
});

test('msixProblems: identity from the committed manifest template, version from the release version, x64', () => {
  const template = readFileSync(join(__dirname, '../../build/appx/AppxManifest.xml'), 'utf8');
  const want = /<Identity Name="([^"]+)" Publisher="([^"]+)"/.exec(template)!;
  expect(want[1]).toBe('FrancescoMusso.AtelierIDE');
  expect(msixProblems(msix('0.2.15.0'), { version: '0.2.0-beta.15' })).toEqual([]);
  expect(msixProblems(msix('0.2.999.0'), { version: '0.2.0' })).toEqual([]);
  expect(msixProblems(msix('0.2.14.0'), { version: '0.2.0-beta.15' })).toEqual([expect.stringMatching(/version 0\.2\.14\.0.*0\.2\.15\.0/)]);
  expect(msixProblems(msix('0.2.15.0', { name: 'Other.App' }), { version: '0.2.0-beta.15' })).toEqual([expect.stringMatching(/Other\.App/)]);
  expect(msixProblems(msix('0.2.15.0', { publisher: 'CN=Someone' }), { version: '0.2.0-beta.15' })).toEqual([expect.stringMatching(/CN=Someone/)]);
  expect(msixProblems(msix('0.2.15.0', { arch: 'arm64' }), { version: '0.2.0-beta.15' })).toEqual([expect.stringMatching(/arm64/)]);
  // Not an MSIX at all: one problem, no exception.
  const junk = join(dir(), 'junk.msix');
  writeFileSync(junk, 'nope');
  expect(msixProblems(junk, { version: '0.2.0' })).toEqual([expect.stringMatching(/not a ZIP/)]);
});
