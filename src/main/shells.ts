import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { ShellOption } from '@shared/profiles';
import { defaultPowerShell, parseEtcShells, windowsShells, type WindowsShell } from '../daemon/profiles';
import { toNative } from '@shared/paths';
import { pathStyle } from '@shared/platform';

/**
 * Shells offered as terminal profiles: those /etc/shells lists that exist as executables (atelierd checks the same
 * list again before starting one). zsh is left out: "zsh (your config)" already is the user's zsh, with Atelier's
 * hooks; a plain zsh profile would only look like a duplicate.
 */
export function shellOptions(etcShells: string, isExecutable: (path: string) => boolean): ShellOption[] {
  const paths = [...new Set(parseEtcShells(etcShells))].filter((p) => basename(p) !== 'zsh' && isExecutable(p));
  const seen = new Set<string>();
  return paths.map((path) => {
    const name = basename(path);
    const dup = seen.has(name);
    seen.add(name);
    return { path, name: dup ? `${name} (${dirname(path)})` : name };
  });
}

/** Windows: the shells found but the default PowerShell, which the two built-in profiles run. */
export function windowsShellOptions(list: readonly WindowsShell[]): ShellOption[] {
  const builtIn = defaultPowerShell([...list]);
  return list.filter((s) => s !== builtIn).map(({ path, name }) => ({ path, name }));
}

function executable(path: string): boolean {
  try { return statSync(path).isFile() && (accessSync(path, constants.X_OK), true); } catch { return false; }
}

/** The machine's shells, read once (the list rarely changes; a restart of Atelier picks up new ones). */
export function readShells(file = '/etc/shells'): () => ShellOption[] {
  let cached: ShellOption[] | null = null;
  return () => {
    if (cached) return cached;
    if (pathStyle() === 'win32') {
      cached = windowsShellOptions(windowsShells(process.env, (p) => executable(toNative(p))));
      return cached;
    }
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { /* no list: no shells */ }
    cached = shellOptions(text, executable);
    return cached;
  };
}
