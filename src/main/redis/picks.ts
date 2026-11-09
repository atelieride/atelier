// The Redis instance each project picked: ATELIER_HOME/redis.json, 0600, written atomically.
// Only endpoint keys (`tcp:6379`, `unix:/path`) by project root: no passwords (those are in the Keychain).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../../daemon/fsutil';
import { isAbsPath } from '@shared/paths';

const KEY = /^(tcp:\d{1,5}|unix:\/[^\u0000]{1,1023})$/;

export interface Picks { get(root: string): string | null; set(root: string, key: string): void }

export function createPicks(home: string): Picks {
  const file = join(home, 'redis.json');
  let picks: Record<string, string> | null = null;
  const load = (): Record<string, string> => {
    if (picks) return picks;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { picks?: unknown };
      const p = raw.picks && typeof raw.picks === 'object' ? (raw.picks as Record<string, unknown>) : {};
      picks = Object.fromEntries(Object.entries(p).filter((e): e is [string, string] => isAbsPath(e[0]) && typeof e[1] === 'string' && KEY.test(e[1])).slice(0, 500));
    } catch { picks = {}; }
    return picks;
  };
  return {
    get: (root) => load()[root] ?? null,
    set: (root, key) => {
      if (!isAbsPath(root) || !KEY.test(key) || load()[root] === key) return;
      picks = { ...load(), [root]: key };
      try { writeFileAtomic(file, JSON.stringify({ picks }, null, 2), 0o600); } catch { /* kept in memory for this run */ }
    }
  };
}
