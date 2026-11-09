import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** What a config dir's settings.json said, by the file's path, as long as its mtime holds. */
type SettingsCache = Map<string, { mtimeMs: number; value: boolean }>;

const shared: SettingsCache = new Map();

/**
 * Claude Code's `autoContinueAtUsageLimit` for a config dir: only
 * `false` in `<configDir>/settings.json` turns it off. A missing or broken file, any other value, or no config dir
 * (nothing read then) is Claude Code's default, on. Managed settings and project files aren't read.
 */
export function autoContinueAtUsageLimit(configDir: string | null, cache: SettingsCache = shared): boolean {
  if (configDir === null) return true;
  const file = join(configDir, 'settings.json');
  try {
    const st = statSync(file);
    // Only a regular file is read: a FIFO named settings.json would block atelierd's event loop.
    if (!st.isFile()) return true;
    const { mtimeMs } = st;
    const hit = cache.get(file);
    if (hit?.mtimeMs === mtimeMs) return hit.value;
    const value = valueOf(readFileSync(file, 'utf8'));
    cache.set(file, { mtimeMs, value });
    return value;
  } catch {
    return true;
  }
}

function valueOf(text: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return true; }
  const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  return !(isObject && (parsed as { autoContinueAtUsageLimit?: unknown }).autoContinueAtUsageLimit === false);
}
