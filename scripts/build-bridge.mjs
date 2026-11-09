// Builds atelier-bridge.exe (native/atelier-bridge.c), atelier-procs.exe (native/atelier-procs.c,
// the process and TCP readings main needs), atelier-git.exe (native/atelier-git.c, the git an
// automated session finds first on its PATH) and atelier-store.exe (native/atelier-store.cpp,
// C++/WinRT, the Microsoft Store's updates) into vendor/bin, where atelierd, main and the
// packer find them. Part of `npm run build` on Windows (MSVC from Visual Studio or its Build Tools, found by vswhere;
// static runtime, so no Visual C++ redistributable is needed); elsewhere it does nothing.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BRIDGE_SOURCE = join(ROOT, 'native', 'atelier-bridge.c');
export const BRIDGE_BINARY = join(ROOT, 'vendor', 'bin', 'atelier-bridge.exe');
export const PROCS_SOURCE = join(ROOT, 'native', 'atelier-procs.c');
export const PROCS_BINARY = join(ROOT, 'vendor', 'bin', 'atelier-procs.exe');
export const GIT_SOURCE = join(ROOT, 'native', 'atelier-git.c');
export const GIT_BINARY = join(ROOT, 'vendor', 'bin', 'atelier-git.exe');
export const STORE_SOURCE = join(ROOT, 'native', 'atelier-store.cpp');
export const STORE_BINARY = join(ROOT, 'vendor', 'bin', 'atelier-store.exe');

/** vcvars64.bat of the newest Visual Studio with the C++ x64 tools, or null. */
export function findVcvars() {
  const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!existsSync(vswhere)) return null;
  const install = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
  const vcvars = install && join(install, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  return vcvars && existsSync(vcvars) ? vcvars : null;
}

/** Compiles the bridge to `out` (atomically: a concurrent reader never sees half a binary). */
export function compileBridge(out) {
  compileC(BRIDGE_SOURCE, out);
}

/** Compiles one C file (or C++, C++/WinRT included, for a .cpp) to `out`, atomically. */
export function compileC(source, out) {
  const vcvars = findVcvars();
  if (!vcvars) throw new Error('MSVC not found: install Visual Studio Build Tools with "Desktop development with C++"');
  mkdirSync(dirname(out), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'atl-bridge-'));
  const tmp = `${out}.${process.pid}.tmp.exe`;
  try {
    // vcvars64.bat only works inside cmd: one fixed command line, every path quoted.
    // C++20: under C++17, C++/WinRT's coroutines include <experimental/coroutine>, which MSVC 14.51 (Visual Studio 18,
    // GitHub's windows-latest since 2026-10) refuses with error STL1011.
    const cpp = source.endsWith('.cpp') ? ' /std:c++20 /EHsc' : '';
    const line = `call "${vcvars}" >nul && cl /nologo /O2 /MT /W4 /WX${cpp} /Fo"${work}\\\\" /Fe"${tmp}" "${source}"`;
    execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { stdio: 'inherit', windowsVerbatimArguments: true });
    renameSync(tmp, out);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(tmp, { force: true });
  }
}

const newer = (a, b) => existsSync(a) && statSync(a).mtimeMs >= statSync(b).mtimeMs;

function main() {
  if (process.platform !== 'win32') return;
  for (const [source, out] of [[BRIDGE_SOURCE, BRIDGE_BINARY], [PROCS_SOURCE, PROCS_BINARY], [GIT_SOURCE, GIT_BINARY], [STORE_SOURCE, STORE_BINARY]]) {
    if (newer(out, source)) continue;
    compileC(source, out);
    console.log(`ready: ${out}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
