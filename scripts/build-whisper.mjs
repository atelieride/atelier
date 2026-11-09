// Builds whisper.cpp (pinned version, Metal, static libraries) and our atelier-whisper binary (npm run build:whisper).
// Everything goes in vendor/ (git-ignored): source verified with sha256, cmake in a local venv (never system-wide).
// Windows: CPU only (AVX2), MSVC with the static runtime, the CMake of the Visual Studio Build
// Tools (or the one on PATH, as on CI); curl.exe and tar.exe are Windows' own.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findVcvars } from './build-bridge.mjs';

const VERSION = '1.9.5';
const TARBALL = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${VERSION}.tar.gz`;
const TARBALL_SHA256 = 'ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720';

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The binary is missing or older than the source. */
export function needsBuild(binPath, sourcePath) {
  if (!existsSync(binPath)) return true;
  return statSync(binPath).mtimeMs < statSync(sourcePath).mtimeMs;
}

// The app's minimum macOS (Electron's LSMinimumSystemVersion). Without it clang targets the build machine's macOS, and
// a binary built on a macOS 26 runner would refuse to start on older systems the app supports.
const MIN_MACOS = '13.0';

/** The environment of every build command: cmake (whisper.cpp) and clang++ (atelier-whisper) both honor the target. */
export function buildEnv() {
  return { ...process.env, MACOSX_DEPLOYMENT_TARGET: MIN_MACOS };
}

const run = (cmd, args, cwd) => execFileSync(cmd, args, { stdio: 'inherit', cwd, env: buildEnv() });

function main() {
  if (process.platform === 'win32') { buildWindows(); return; }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const vendor = join(root, 'vendor');
  const src = join(vendor, `whisper.cpp-${VERSION}`);
  const build = join(src, 'build');
  const cmake = join(vendor, 'venv', 'bin', 'cmake');
  const out = join(vendor, 'bin', 'atelier-whisper');
  const cpp = join(root, 'native', 'atelier-whisper.cpp');
  mkdirSync(join(vendor, 'bin'), { recursive: true });

  if (!existsSync(src)) {
    const tgz = join(vendor, `whisper.cpp-${VERSION}.tar.gz`);
    run('/usr/bin/curl', ['-sSfL', '-o', tgz, TARBALL]);
    const got = sha256File(tgz);
    if (got !== TARBALL_SHA256) { rmSync(tgz, { force: true }); throw new Error(`whisper.cpp: unexpected sha256 (${got})`); }
    run('/usr/bin/tar', ['-xzf', tgz, '-C', vendor]);
    rmSync(tgz, { force: true });
  }
  if (!existsSync(cmake)) {
    run('/usr/bin/python3', ['-m', 'venv', join(vendor, 'venv')]);
    run(join(vendor, 'venv', 'bin', 'pip'), ['install', '-q', 'cmake']);
  }
  const lib = (p) => join(build, p);
  if (!existsSync(lib('src/libwhisper.a'))) {
    run(cmake, ['-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON',
      '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=OFF', '-DCMAKE_OSX_ARCHITECTURES=arm64'], src);
    run(cmake, ['--build', build, '--config', 'Release', '-j', '8'], src);
  }
  if (needsBuild(out, cpp)) {
    run('/usr/bin/clang++', ['-std=c++17', '-O2', `-I${join(src, 'include')}`, `-I${join(src, 'ggml', 'include')}`, cpp,
      lib('src/libwhisper.a'), lib('ggml/src/libggml.a'), lib('ggml/src/libggml-base.a'), lib('ggml/src/libggml-cpu.a'),
      lib('ggml/src/ggml-metal/libggml-metal.a'), lib('ggml/src/ggml-blas/libggml-blas.a'),
      '-framework', 'Accelerate', '-framework', 'Metal', '-framework', 'Foundation', '-framework', 'MetalKit', '-o', out]);
  }
  writeFileSync(join(vendor, 'bin', 'VERSION'), `whisper.cpp ${VERSION}\n`);
  console.log(`atelier-whisper ready: ${out}`);
}

/** cmd.exe with MSVC's environment: one fixed command line, every path quoted. */
function inVcvars(line, cwd) {
  const vcvars = findVcvars();
  if (!vcvars) throw new Error('MSVC not found: install Visual Studio Build Tools with "Desktop development with C++"');
  execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"call "${vcvars}" >nul && ${line}"`], { stdio: 'inherit', cwd, windowsVerbatimArguments: true });
}

function buildWindows() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const vendor = join(root, 'vendor');
  const src = join(vendor, `whisper.cpp-${VERSION}`);
  const build = join(src, 'build-win');
  const out = join(vendor, 'bin', 'atelier-whisper.exe');
  const cpp = join(root, 'native', 'atelier-whisper.cpp');
  const sys = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  mkdirSync(join(vendor, 'bin'), { recursive: true });
  if (!existsSync(src)) {
    const tgz = join(vendor, `whisper.cpp-${VERSION}.tar.gz`);
    execFileSync(join(sys, 'curl.exe'), ['-sSfL', '-o', tgz, TARBALL], { stdio: 'inherit' });
    const got = sha256File(tgz);
    if (got !== TARBALL_SHA256) { rmSync(tgz, { force: true }); throw new Error(`whisper.cpp: unexpected sha256 (${got})`); }
    execFileSync(join(sys, 'tar.exe'), ['-xzf', tgz, '-C', vendor], { stdio: 'inherit' });
    rmSync(tgz, { force: true });
  }
  const lib = (p) => join(build, p);
  if (!existsSync(lib('src\\whisper.lib'))) {
    // NMake in MSVC's environment: one configuration, libraries where the link below expects them.
    inVcvars(['cmake', '-G', '"NMake Makefiles"', '-B', `"${build}"`, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF',
      '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded', '-DGGML_NATIVE=OFF', '-DGGML_AVX2=ON',
      '-DGGML_FMA=ON', '-DGGML_F16C=ON', '-DGGML_OPENMP=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=OFF'].join(' '), src);
    inVcvars(`cmake --build "${build}" --config Release`, src);
  }
  if (needsBuild(out, cpp)) {
    const work = join(build, 'atelier');
    mkdirSync(work, { recursive: true });
    const libs = ['src\\whisper.lib', 'ggml\\src\\ggml.lib', 'ggml\\src\\ggml-base.lib', 'ggml\\src\\ggml-cpu.lib'].map((p) => `"${lib(p)}"`).join(' ') + ' advapi32.lib shell32.lib';
    inVcvars(`cl /nologo /std:c++17 /O2 /MT /EHsc /I"${join(src, 'include')}" /I"${join(src, 'ggml', 'include')}" /Fo"${work}\\\\" /Fe"${out}" "${cpp}" ${libs}`, src);
  }
  writeFileSync(join(vendor, 'bin', 'VERSION'), `whisper.cpp ${VERSION}\n`);
  console.log(`atelier-whisper ready: ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
