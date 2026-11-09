import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
// @ts-expect-error: untyped .mjs script
import { buildEnv, needsBuild, sha256File } from '../../scripts/build-whisper.mjs';

// Without a target, clang targets the build machine's macOS: built on a macOS 26 runner, dictation would refuse to
// start on older systems the app itself supports.
test('atelier-whisper and whisper.cpp target the app\'s minimum macOS, not the build machine\'s', () => {
  expect(buildEnv().MACOSX_DEPLOYMENT_TARGET).toBe('13.0');
  expect(buildEnv().PATH).toBe(process.env.PATH);
});

test('sha256 of a file', () => {
  const d = mkdtempSync(join(tmpdir(), 'atl-bw-'));
  writeFileSync(join(d, 'a'), 'abc');
  expect(sha256File(join(d, 'a'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('rebuilds only if the binary is missing or older than the source', () => {
  const d = mkdtempSync(join(tmpdir(), 'atl-bw-'));
  const src = join(d, 'a.cpp'); const bin = join(d, 'bin');
  writeFileSync(src, 'x');
  expect(needsBuild(bin, src)).toBe(true);
  writeFileSync(bin, 'y');
  utimesSync(src, 1000, 1000); utimesSync(bin, 2000, 2000);
  expect(needsBuild(bin, src)).toBe(false);
  utimesSync(src, 3000, 3000);
  expect(needsBuild(bin, src)).toBe(true);
});
