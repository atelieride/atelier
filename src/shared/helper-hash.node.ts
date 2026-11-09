// sha256 of node-pty's spawn-helper code, without its signature: atelierd keeps running through an update and runs the
// helper from the bundle for every new terminal, so an update without an atelierd restart needs the same code. The
// release scripts have the same function in scripts/helper-hash.mjs (Node built-ins only); tests/integration/
// helper-hash.test.ts checks they agree, also on the real helper.
import { createHash } from 'node:crypto';

const MH_MAGIC_64 = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;

/**
 * The bytes before the signature blob, with the fields that only describe the blob zeroed (LC_CODE_SIGNATURE's size,
 * __LINKEDIT's sizes): codesign on different machines wraps the same helper in blobs of different sizes. Anything but a
 * thin 64-bit Mach-O: the whole file.
 */
export function helperCodeHash(file: Buffer): string {
  const whole = () => createHash('sha256').update(file).digest('hex');
  try {
    if (file.length < 32 || file.readUInt32LE(0) !== MH_MAGIC_64) return whole();
    const b = Buffer.from(file);
    const ncmds = b.readUInt32LE(16);
    let off = 32;
    let end = b.length;
    for (let i = 0; i < ncmds; i++) {
      const cmd = b.readUInt32LE(off);
      const size = b.readUInt32LE(off + 4);
      if (cmd === LC_CODE_SIGNATURE) { end = b.readUInt32LE(off + 8); b.writeUInt32LE(0, off + 12); }
      if (cmd === LC_SEGMENT_64 && b.toString('latin1', off + 8, off + 24).replace(/\0+$/, '') === '__LINKEDIT') {
        b.writeBigUInt64LE(0n, off + 32);
        b.writeBigUInt64LE(0n, off + 48);
      }
      off += size;
    }
    if (end > b.length || end < off) return whole();
    return createHash('sha256').update(b.subarray(0, end)).digest('hex');
  } catch {
    return whole();
  }
}
