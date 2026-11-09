import { expect, test } from 'vitest';
// @ts-expect-error: .mjs script without types
import { guiPids, requirementOf, updateBlocker } from '../../scripts/update-app.mjs';

test('update without restarting atelierd only if the protocol is the same', () => {
  expect(updateBlocker({ installed: 1, next: 1 })).toBeNull();
  expect(updateBlocker({ installed: 1, next: 2 })).toMatch(/protocol/i);
  // App installed before the stamp: all those builds spoke protocol 1.
  expect(updateBlocker({ installed: null, next: 1 })).toBeNull();
  expect(updateBlocker({ installed: null, next: 2 })).toMatch(/protocol/i);
});

test('only the Atelier window is closed: never atelierd (which keeps sessions alive) nor other apps', () => {
  const ps = [
    '  101 /Applications/Atelier.app/Contents/MacOS/Atelier',
    '  102 /Applications/Atelier.app/Contents/MacOS/Atelier --project=/Users/me/repo',
    '  103 /Applications/Atelier.app/Contents/MacOS/Atelier /Applications/Atelier.app/Contents/Resources/app.asar/out/main/daemon.js --version=0.1.0',
    '  104 /Applications/Atelier.app/Contents/Frameworks/Atelier Helper (Renderer).app/Contents/MacOS/Atelier Helper (Renderer) --type=renderer',
    '  105 /Users/me/code/atelier/release/mac-arm64/Atelier.app/Contents/MacOS/Atelier',
    '  106 /bin/zsh -l'
  ].join('\n');
  expect(guiPids(ps, '/Applications/Atelier.app')).toEqual([101, 102]);
});

test('the node-pty spawn-helper must stay identical: atelierd runs it from the bundle for every new terminal', () => {
  expect(updateBlocker({ installed: 1, next: 1, helperInstalled: 'aa', helperNext: 'aa' })).toBeNull();
  expect(updateBlocker({ installed: 1, next: 1, helperInstalled: 'aa', helperNext: 'bb' })).toMatch(/spawn-helper/);
  // No installed app to compare against: install.
  expect(updateBlocker({ installed: 1, next: 1, helperInstalled: null, helperNext: 'bb' })).toBeNull();
});

test('signing requirement of the installed app: compared with a certificate, not with an ad-hoc signature', () => {
  expect(requirementOf('Executable=/x\ndesignated => identifier "app.atelier.desktop" and certificate root = H"2c"\n')).toBe('identifier "app.atelier.desktop" and certificate root = H"2c"');
  expect(requirementOf('# designated => cdhash H"abc"\n')).toBeNull();
  expect(requirementOf('')).toBeNull();
});
