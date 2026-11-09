import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { posixRel } from '../support/platform';

// Main hands the renderer canonical paths: a module building paths the renderer sees uses
// src/main/cpath.ts, whose results are C:/… on Windows. node:path (C:\… there) stays only in the modules below, whose
// paths go to the OS and never to a page: Atelier's own files (logs, settings, updates, keys, models, the daemon and its
// runtime copy, the whisper and shell-command binaries), Claude's config read in place, programs to spawn (gh, claude,
// tmux, shells), Docker and Redis endpoints, the clipboard image a terminal gets typed, and names (basename) only.
// Found on the PC, 2026-10-18: the file index and the tree gave C:\… paths that IPC then refused.
const NODE_PATH = new Set([
  'src/main/cpath.ts',
  // Atelier's own files and processes.
  'src/main/app-log.ts', 'src/main/settings-store.ts', 'src/main/runtime-copy.ts', 'src/main/daemon-fingerprint.ts', 'src/main/daemon-launcher.ts',
  'src/main/updates.ts', 'src/main/updates-ipc.ts', 'src/main/auto-update.ts', 'src/main/store-updates-ipc.ts', 'src/main/connectors/secret-store.ts', 'src/main/windows.ts',
  'src/main/dictation/ipc.ts', 'src/main/dictation/model.ts', 'src/main/dictation/polish.ts', 'src/main/dictation/service.ts',
  'src/main/shell-command.ts', 'src/main/shell-command-exec.ts', 'src/main/shell-env-fresh.ts', 'src/main/shells.ts', 'src/main/win-shell.ts',
  'src/main/index.ts', 'src/main/app-icon-exec.ts', 'src/main/automations/guard.ts', 'src/main/automations/store.ts', 'src/main/companion/store.ts', 'src/main/automations/launcher.ts',
  // Claude's config and history read in place; programs found and spawned.
  'src/main/claude-accounts.ts', 'src/main/claude-config.ts', 'src/main/claude-bin.ts', 'src/main/scm/message.ts', 'src/main/github/exec.ts', 'src/main/links.ts',
  'src/main/tmux/exec.ts', 'src/main/tmux/panes.ts',
  // git's own files and sockets, read in place; a repo root checked, never built.
  'src/main/git/history.ts', 'src/main/git/repo-facts.ts', 'src/main/git/trace2.ts', 'src/main/git/fetch.ts',
  // Endpoints and their config.
  'src/main/docker/detect.ts', 'src/main/redis/client.ts', 'src/main/redis/main-deps.ts', 'src/main/redis/picks.ts', 'src/main/databases/store.ts',
  // The clipboard image: its path is typed into a terminal, in the OS's own form.
  'src/main/clipboard-image.ts', 'src/main/clipboard-ipc.ts',
  // Names only (basename).
  'src/main/dock-menu.ts', 'src/main/popouts.ts'
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });
}

test('main builds the paths a page sees with cpath; node:path only where paths go to the OS', () => {
  const users = walk('src/main').filter((f) => /from 'node:path'|require\('node:path'\)|from 'path'/.test(readFileSync(f, 'utf8'))).map((f) => posixRel('.', f));
  expect(users.filter((f) => !NODE_PATH.has(f))).toEqual([]);
});

test('a realpath main hands on is canonical (toOut), outside the OS-only modules', () => {
  const bare = walk('src/main').map((f) => posixRel('.', f)).filter((f) => !NODE_PATH.has(f) || f === 'src/main/index.ts').flatMap((f) =>
    readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l] as const)
      .filter(([, , l]) => /realpathSync(\.native)?\(/.test(l) && !/toOut\(realpathSync/.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/^import /.test(l))
      .map(([file, line]) => `${file}:${line}`));
  expect(bare).toEqual([]);
});
