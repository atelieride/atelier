import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
// @ts-expect-error: .mjs script without types
import { helperCodeHash as scriptHash } from '../../scripts/helper-hash.mjs';
import { helperCodeHash } from '../../src/shared/helper-hash.node';
import { macho } from '../support/macho';

// atelierd keeps running through an update and runs node-pty's spawn-helper from the bundle for every new terminal:
// an update without an atelierd restart needs the same helper. "The same" is its code: codesign on different build
// machines (a local Mac, CI on macOS 15 or 26) wraps the same helper in signature blobs of different sizes.
test('the spawn-helper is compared by its code, not its signature', () => {
  for (const hash of [helperCodeHash, scriptHash as (b: Buffer) => string]) {
    expect(hash(macho('code-v1', 19600))).toBe(hash(macho('code-v1', 19312)));
    expect(hash(macho('code-v1', 19312))).toBe(hash(macho('code-v1', 1328)));
    // Different code: a different helper, however it is signed.
    expect(hash(macho('code-v2', 1328))).not.toBe(hash(macho('code-v1', 1328)));
    // Not a thin 64-bit Mach-O (a universal binary, garbage): the whole file, as strict as before.
    expect(hash(Buffer.from('aaa'))).not.toBe(hash(Buffer.from('aab')));
    expect(hash(Buffer.from('aaa'))).toMatch(/^[0-9a-f]{64}$/);
  }
});

test('the app (TypeScript) and the release scripts (Node built-ins only) compute the same hash', () => {
  const real = readFileSync(join(__dirname, '../../node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'));
  for (const b of [real, macho('code-v1', 19312), Buffer.from('aaa'), Buffer.alloc(0)]) expect(helperCodeHash(b)).toBe(scriptHash(b));
});
