import { readFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { applyPatch, DEFAULT_SETTINGS, normalizeSettings, type Settings, type SettingsContext } from '@shared/settings';
import { ensureDir, writeFileAtomic } from '../daemon/fsutil';
import { settingsPatchSchema } from './ipc-schemas';

/** App preferences in ATELIER_HOME (never in the project): read at startup, saved on every valid change. */
export class SettingsStore {
  private value: Settings;
  /** The keys the file had when Atelier started (none without a file). */
  private readonly found: ReadonlySet<string>;
  private listeners = new Set<(s: Settings) => void>();

  /**
   * shells: the paths a terminal profile may name (/etc/shells); none when not given. A file that isn't settings (cut
   * short, damaged, edited by hand) is set aside before anything writes, as automations.json is: the next change would
   * otherwise overwrite it with the defaults.
   */
  constructor(private readonly file: string, private readonly opts: { shells?: () => readonly string[]; log?: (m: string) => void } = {}) {
    let raw: unknown;
    let text: string | null = null;
    try { text = readFileSync(file, 'utf8'); } catch { /* missing (or not a file): the defaults */ }
    if (text !== null) {
      try { raw = JSON.parse(text); } catch { raw = undefined; }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { raw = undefined; this.setAside(); }
    }
    this.value = normalizeSettings(raw, this.ctx());
    this.found = new Set(raw && typeof raw === 'object' ? Object.keys(raw) : []);
  }

  /** The file had no such key when Atelier started: a setting never saved, for one-time migrations of new settings. */
  absent(key: keyof Settings): boolean { return !this.found.has(key); }

  private setAside(): void {
    const aside = `${basename(this.file)}.bad-${Date.now()}`;
    try {
      renameSync(this.file, join(dirname(this.file), aside));
      this.opts.log?.(`settings: ${basename(this.file)} unreadable, set aside as ${aside}; starting from the defaults`);
    } catch (e) {
      this.opts.log?.(`settings: ${basename(this.file)} unreadable and could not be set aside (${(e as Error).message})`);
    }
  }

  private ctx(): SettingsContext { return { shells: this.opts.shells?.() ?? [] }; }

  get(): Settings { return this.value; }

  onChange(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** A change from the renderer: null (and nothing changes) if it doesn't match the schema. */
  set(patch: unknown): Settings | null {
    const p = settingsPatchSchema.safeParse(patch);
    if (!p.success) return null;
    const patchData = p.data as Partial<Settings>;
    // A shell the machine doesn't list is refused here rather than silently replaced.
    const profile = patchData.terminalProfile;
    if (profile !== undefined && profile !== 'atelier' && profile !== 'user' && !this.ctx().shells!.includes(profile)) return null;
    return this.commit(applyPatch(this.value, patchData, this.ctx()));
  }

  reset(): Settings { return this.commit({ ...DEFAULT_SETTINGS }); }

  private commit(next: Settings): Settings {
    // File first, then memory: if the write fails nothing changes, neither here nor in the windows.
    ensureDir(dirname(this.file), 0o700);
    writeFileAtomic(this.file, JSON.stringify(next, null, 2), 0o600);
    this.value = next;
    for (const fn of this.listeners) fn(next);
    return next;
  }
}
