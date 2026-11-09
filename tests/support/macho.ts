// A thin 64-bit Mach-O as node-pty's spawn-helper is laid out: header, __LINKEDIT segment, LC_CODE_SIGNATURE, then the
// code and the signature blob. Two builds of the same helper differ only in the blob (and the sizes that describe it):
// codesign on a macOS 15 build machine wrote 19600 bytes, on macOS 26 19312.
export function macho(code: string, signature: number): Buffer {
  const head = Buffer.alloc(32 + 72 + 16);
  head.writeUInt32LE(0xfeedfacf, 0);
  head.writeUInt32LE(2, 16);
  head.writeUInt32LE(0x19, 32); head.writeUInt32LE(72, 36); head.write('__LINKEDIT', 40, 'latin1');
  head.writeBigUInt64LE(BigInt(0x4000 + signature), 64); head.writeBigUInt64LE(BigInt(code.length + signature), 80);
  const dataoff = head.length + code.length;
  head.writeUInt32LE(0x1d, 104); head.writeUInt32LE(16, 108); head.writeUInt32LE(dataoff, 112); head.writeUInt32LE(signature, 116);
  return Buffer.concat([head, Buffer.from(code, 'latin1'), Buffer.alloc(signature, 0xab)]);
}
