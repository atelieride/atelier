import path from 'node:path';
import { pathListSplit } from '@shared/env';
import { isAbsPath, samePath } from '@shared/paths';
import type { Platform } from '@shared/platform';

// Where the real `claude` may be, for ✦ commit messages, Ask and dictation's polish (never the wrapper with hooks in
// ATELIER_HOME). Windows: `.exe` only, since Atelier never starts a shell, so a `claude.cmd`
// counts through the exe it runs. The native installer's claude.exe; then each PATH folder in order, its claude.exe
// and, for an npm install there, the package's own claude.exe (npm's `claude.cmd` runs exactly that file); then npm's,
// WinGet's and Scoop's folders when PATH misses them (the app's PATH is the one it started with).

/** What npm's `claude.cmd` runs, from the folder the shim is in (the global prefix). */
const NPM_EXE = ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'];

export function claudeCandidates(o: { home: string; path: string; atelierHome: string; platform: Platform; appData?: string; localAppData?: string }): string[] {
  const win = o.platform === 'win32';
  const dirs = pathListSplit(o.path, win ? 'win32' : 'posix').filter(Boolean);
  if (!win) {
    const p = path.posix;
    return [p.join(o.home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', ...dirs.map((d) => p.join(d, 'claude'))]
      .filter((c) => !c.startsWith(o.atelierHome));
  }
  const p = path.win32;
  const list = [
    p.join(o.home, '.local', 'bin', 'claude.exe'),
    ...dirs.filter((d) => isAbsPath(d, 'win32')).flatMap((d) => [p.join(d, 'claude.exe'), p.join(d, ...NPM_EXE)]),
    ...(o.appData ? [p.join(o.appData, 'npm', ...NPM_EXE)] : []),
    ...(o.localAppData ? [p.join(o.localAppData, 'Microsoft', 'WinGet', 'Links', 'claude.exe')] : []),
    p.join(o.home, 'scoop', 'shims', 'claude.exe')
  ];
  const out: string[] = [];
  for (const c of list) {
    if (samePath(c.slice(0, o.atelierHome.length), o.atelierHome, 'win32')) continue;
    if (!out.some((x) => samePath(x, c, 'win32'))) out.push(c);
  }
  return out;
}
