import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { daemonFingerprint } from './daemon-fingerprint';

/** A built app as electron-vite lays it out: out/main/{daemon,index}.js, a shared chunk, node_modules at the root. */
function fakeBuild(): { root: string; script: string } {
  const root = mkdtempSync(join(tmpdir(), 'atl-fp-'));
  const main = join(root, 'out', 'main');
  mkdirSync(join(main, 'chunks'), { recursive: true });
  writeFileSync(join(main, 'daemon.js'), '"use strict";\nconst fs = require("node:fs");\nconst s = require("./chunks/shells-AAA.js");\nconst pty = require("node-pty");\nconst h = require(\'@xterm/headless\');\n');
  writeFileSync(join(main, 'chunks', 'shells-AAA.js'), '"use strict";\nconst z = require("zod");\nexports.x = 1;\n');
  writeFileSync(join(main, 'index.js'), '"use strict";\nrequire("./daemon-unrelated");\n');
  for (const [name, version] of [['node-pty', '1.0.0'], ['@xterm/headless', '5.5.0'], ['zod', '3.25.0']]) {
    mkdirSync(join(root, 'node_modules', name!), { recursive: true });
    writeFileSync(join(root, 'node_modules', name!, 'package.json'), JSON.stringify({ name, version }));
  }
  return { root, script: join(main, 'daemon.js') };
}

describe('atelierd fingerprint', () => {
  test('the same code on the same runtime gives the same short hex fingerprint', () => {
    const a = fakeBuild();
    const b = fakeBuild();
    const fp = daemonFingerprint(a.script, '38.1.0');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    // Where the app is installed does not matter, only what atelierd would run.
    expect(daemonFingerprint(b.script, '38.1.0')).toBe(fp);
  });

  test('the main process bundle is not part of it: an app-only change keeps atelierd current', () => {
    const { root, script } = fakeBuild();
    const before = daemonFingerprint(script, '38.1.0');
    writeFileSync(join(root, 'out', 'main', 'index.js'), '"use strict";\n// a new feature in the app\n');
    expect(daemonFingerprint(script, '38.1.0')).toBe(before);
  });

  test('a change to daemon.js changes it', () => {
    const { script } = fakeBuild();
    const before = daemonFingerprint(script, '38.1.0');
    writeFileSync(script, '"use strict";\nconst s = require("./chunks/shells-AAA.js");\n');
    expect(daemonFingerprint(script, '38.1.0')).not.toBe(before);
  });

  test('a change to a shared chunk daemon.js requires changes it, even if the chunk kept its name', () => {
    const { root, script } = fakeBuild();
    const before = daemonFingerprint(script, '38.1.0');
    writeFileSync(join(root, 'out', 'main', 'chunks', 'shells-AAA.js'), '"use strict";\nconst z = require("zod");\nexports.x = 2;\n');
    expect(daemonFingerprint(script, '38.1.0')).not.toBe(before);
  });

  test('another installed version of a package atelierd loads changes it (directly or through a chunk)', () => {
    for (const name of ['node-pty', '@xterm/headless', 'zod']) {
      const { root, script } = fakeBuild();
      const before = daemonFingerprint(script, '38.1.0');
      writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '9.9.9' }));
      expect(daemonFingerprint(script, '38.1.0'), name).not.toBe(before);
    }
  });

  test('another Electron (the Node atelierd runs on) changes it', () => {
    const { script } = fakeBuild();
    expect(daemonFingerprint(script, '38.2.0')).not.toBe(daemonFingerprint(script, '38.1.0'));
  });

  test('a missing file or package does not throw: it is part of the fingerprint as missing', () => {
    const { root, script } = fakeBuild();
    const before = daemonFingerprint(script, '38.1.0');
    writeFileSync(join(root, 'node_modules', 'zod', 'package.json'), '{ not json');
    expect(daemonFingerprint(script, '38.1.0')).toMatch(/^[0-9a-f]{16}$/);
    expect(daemonFingerprint(script, '38.1.0')).not.toBe(before);
    expect(daemonFingerprint(join(root, 'nope.js'), '38.1.0')).toMatch(/^[0-9a-f]{16}$/);
  });

  // A bridge-only change (native/atelier-bridge.c) never reached users: the runtime copy atelierd installs it from is
  // keyed by this fingerprint. Windows passes the native helpers atelierd uses; macOS passes none and must keep its
  // fingerprint byte for byte, or every Mac would be asked to restart atelierd (closing its sessions) for nothing.
  test('no native helpers (macOS): the fingerprint is the one it always was', () => {
    const { script } = fakeBuild();
    expect(daemonFingerprint(script, '38.1.0')).toBe('58b966acb2955938');
    expect(daemonFingerprint(script, '38.1.0', [])).toBe('58b966acb2955938');
  });

  test('Windows: the bytes of a native helper atelierd uses (the bridge) are part of it', () => {
    const { root, script } = fakeBuild();
    const bridge = join(root, 'resources', 'bin', 'atelier-bridge.exe');
    mkdirSync(join(root, 'resources', 'bin'), { recursive: true });
    writeFileSync(bridge, 'MZ v1');
    const v1 = daemonFingerprint(script, '38.1.0', [bridge]);
    expect(v1).toMatch(/^[0-9a-f]{16}$/);
    expect(v1).not.toBe(daemonFingerprint(script, '38.1.0'));
    expect(daemonFingerprint(script, '38.1.0', [bridge])).toBe(v1);
    writeFileSync(bridge, 'MZ v2');
    expect(daemonFingerprint(script, '38.1.0', [bridge])).not.toBe(v1);
    // A helper the build lacks is part of it as missing, never thrown.
    expect(daemonFingerprint(script, '38.1.0', [join(root, 'nope.exe')])).toMatch(/^[0-9a-f]{16}$/);
  });
});
