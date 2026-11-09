import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { posixRel } from '../support/platform';

// In the Store package, files the GUI creates under AppData land in the package's private copy,
// invisible to atelierd, ConPTY shells, the bridge and Claude. Whatever another process must read lives under
// ATELIER_HOME (%USERPROFILE%\.atelier, never virtualized). Every Electron path main asks for is listed with a reason.
const ALLOWED: Record<string, string> = {
  // Chromium's own profile (cookies, caches, local storage): only the GUI reads it.
  "src/main/index.ts:app.setPath('userData'": 'set to ATELIER_HOME/electron, outside AppData on Windows',
  // Pasted images: macOS only; Windows keeps them under ATELIER_HOME (clipboardImageDir), Claude reads them.
  "src/main/clipboard-ipc.ts:app.getPath('temp'": 'the macOS branch of clipboardImageDir',
  // The running executable: its bundle, for the app icon of Docsy's themes (macOS only). Read,
  // never a place to write files.
  "src/main/index.ts:app.getPath('exe'": 'the installed bundle whose custom icon follows Docsy\'s themes'
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });
}

test('every app.getPath/setPath in main is listed with a reason', () => {
  const root = join(__dirname, '../..');
  const found: string[] = [];
  for (const f of walk(join(root, 'src/main'))) {
    const rel = posixRel(root, f);
    for (const m of readFileSync(f, 'utf8').matchAll(/app\.(get|set)Path\(\s*'(\w+)'/g)) found.push(`${rel}:app.${m[1]}Path('${m[2]}'`);
  }
  expect(found.sort()).toEqual(Object.keys(ALLOWED).sort());
});
