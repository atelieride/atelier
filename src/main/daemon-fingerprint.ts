import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const REQUIRE = /\brequire\((["'])([^"']+)\1\)/g;

/** The package a bare specifier loads: `zod/v4` → `zod`, `@xterm/headless/x` → `@xterm/headless`. */
function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/** The installed version of a package as Node would find it from `from` (node_modules up the tree), or null. */
function installedVersion(pkg: string, from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    try {
      const v = (JSON.parse(readFileSync(join(dir, 'node_modules', pkg, 'package.json'), 'utf8')) as { version?: unknown }).version;
      return typeof v === 'string' ? v : 'unreadable';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ENOTDIR') return 'unreadable';
    }
    if (dirname(dir) === dir) return null;
  }
}

/**
 * A fingerprint of the code atelierd would run from `script` (the bundled daemon.js): its bytes, those of every local
 * chunk it requires (followed recursively), the installed version of every package they load, and the Electron
 * (Node) it runs on. Changes to the app alone leave it the same. Read at every app start: a few small files.
 * `helpers`: the native files atelierd uses from the app's resources (Windows: atelier-bridge.exe, installed from the
 * runtime copy this fingerprint names); none on macOS, whose fingerprint stays what it always was.
 */
export function daemonFingerprint(script: string, runtime: string, helpers: readonly string[] = []): string {
  const hash = createHash('sha256').update(`runtime ${runtime}\n`);
  const seen = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    let code: string;
    try { code = readFileSync(file, 'utf8'); } catch { hash.update(`missing ${file}\n`); return; }
    hash.update(`file ${seen.size} ${code.length}\n`).update(code);
    for (const m of code.matchAll(REQUIRE)) {
      const spec = m[2]!;
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec));
      else if (!spec.startsWith('node:')) packages.add(packageName(spec));
    }
  };
  visit(resolve(script));
  for (const pkg of [...packages].sort()) hash.update(`package ${pkg} ${installedVersion(pkg, dirname(script)) ?? 'missing'}\n`);
  for (const file of helpers) {
    let bytes: string;
    try { bytes = createHash('sha256').update(readFileSync(file)).digest('hex'); } catch { bytes = 'missing'; }
    hash.update(`helper ${basename(file)} ${bytes}\n`);
  }
  return hash.digest('hex').slice(0, 16);
}
