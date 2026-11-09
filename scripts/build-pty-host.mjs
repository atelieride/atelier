// Builds atelier-pty-host (native/atelier-pty-host.c) into vendor/bin, where the app and the packer find it. Part of
// `npm run build`: a plain clang call, skipped while the binary is newer than its source.
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildEnv, needsBuild } from './build-whisper.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PTY_HOST_SOURCE = join(ROOT, 'native', 'atelier-pty-host.c');
export const PTY_HOST_BINARY = join(ROOT, 'vendor', 'bin', 'atelier-pty-host');

/** Compiles the host to `out` (atomically: a concurrent reader never sees half a binary). */
export function compilePtyHost(out) {
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  execFileSync('/usr/bin/clang', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-arch', 'arm64', '-o', tmp, PTY_HOST_SOURCE],
    { stdio: 'inherit', env: buildEnv() });
  renameSync(tmp, out);
}

function main() {
  // The launchd host is macOS only (ConPTY terminals on Windows).
  if (process.platform !== 'darwin') return;
  if (!needsBuild(PTY_HOST_BINARY, PTY_HOST_SOURCE)) return;
  compilePtyHost(PTY_HOST_BINARY);
  console.log(`atelier-pty-host ready: ${PTY_HOST_BINARY}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
