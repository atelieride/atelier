import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { listedShell, loginArgs, parseEtcShells } from './profiles';

test('parseEtcShells: absolute paths only, comments and blank lines skipped', () => {
  const text = '# List of acceptable shells\n\n/bin/bash\n  /bin/zsh  \n/usr/local/bin/fish # brew\nnot-a-path\n#/bin/ksh\n';
  expect(parseEtcShells(text)).toEqual(['/bin/bash', '/bin/zsh', '/usr/local/bin/fish']);
});

test('listedShell: only shells listed in /etc/shells that exist and are executable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-sh-'));
  const etc = join(dir, 'shells');
  const missing = join(dir, 'gone-sh');
  const plain = join(dir, 'not-exec');
  writeFileSync(plain, '');
  writeFileSync(etc, `/bin/bash\n${missing}\n${plain}\n`);
  expect(listedShell('/bin/bash', etc)).toBe('/bin/bash');
  expect(() => listedShell('/bin/ksh', etc)).toThrow(/not listed in \/etc\/shells/);
  expect(() => listedShell('/bin/../bin/bash', etc)).toThrow(/not listed/);
  expect(() => listedShell(missing, etc)).toThrow(/not found/);
  expect(() => listedShell(plain, etc)).toThrow(/not found/);
  expect(() => listedShell('/bin/bash', join(dir, 'no-etc-shells'))).toThrow(/not listed/);
});

test('loginArgs: -l for shells that understand it, nothing for the others', () => {
  for (const s of ['/bin/bash', '/bin/zsh', '/bin/sh', '/bin/dash', '/bin/ksh', '/opt/homebrew/bin/fish', '/bin/tcsh', '/bin/csh']) expect(loginArgs(s), s).toEqual(['-l']);
  expect(loginArgs('/opt/homebrew/bin/nu')).toEqual([]);
});
