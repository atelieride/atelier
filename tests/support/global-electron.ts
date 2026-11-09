import { createRequire } from 'node:module';

// Global setup of vitest: Electron's binary, before any worker starts. Electron 44 has no install script: the first
// require('electron') downloads and unpacks it. Test files reach it through main's modules, so on a fresh install
// (CI, the release build, a new worktree) parallel workers each found it missing and unpacked it over one another
// ("File exists", the nightly run of 2026-10-23). Here it happens once; when it is there, this only reads path.txt.
export function ensureElectron(load: (id: string) => unknown): void {
  load('electron');
}

export default function globalElectron(): void {
  ensureElectron(createRequire(import.meta.url));
}
