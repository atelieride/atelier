import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { currentPlatform } from '@shared/platform';
import { open, realpath, stat } from 'node:fs/promises';
import { join, toOut } from './cpath';
import type { ClaudeRoots } from '@shared/background-files';
import type { HubFs } from './background-hub';
import { devEnv } from './dev-env';
import { historyRoot } from './claude-history';
import { defaultConfigDirNow } from './claude-accounts';

/**
 * Claude Code's roots for the Background inspector: its temp root (`/tmp/claude-<uid>`), its projects folder (the
 * history's) and the default config dir they belong to. Tests point all three at their own folders.
 */
export function claudeRoots(): ClaudeRoots {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  // Windows (measured): %TEMP%\claude, in the user's own temp folder.
  const tmp = currentPlatform() === 'win32' ? join(toOut(tmpdir()), 'claude') : join('/tmp', `claude-${uid}`);
  return {
    tmp: devEnv('ATELIER_TEST_CLAUDE_TMP') ?? tmp,
    projects: historyRoot(),
    configDir: defaultConfigDirNow()
  };
}

/** Read-only file access for BackgroundHub: real paths, sizes, ranged reads, change notifications. */
export const realHubFs: HubFs = {
  realpath: (p) => realpath(p).then(toOut, () => null),
  stat: async (p) => {
    try { const s = await stat(p); return s.isFile() ? { size: s.size, ino: s.ino } : null; } catch { return null; }
  },
  owner: async (p) => {
    try { return (await stat(p)).uid; } catch { return null; }
  },
  read: async (p, start, length) => {
    const h = await open(p, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await h.read(buf, 0, length, start);
      return buf.subarray(0, bytesRead);
    } finally { await h.close(); }
  },
  watch: (p, onChange) => {
    try {
      const w = watch(p, { persistent: false }, () => onChange());
      w.on('error', () => { /* the poll keeps following */ });
      return () => w.close();
    } catch { return () => {}; }
  }
};
