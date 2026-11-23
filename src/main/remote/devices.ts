// The phones paired with this computer: the allowlist of their static public keys, with what Settings shows (name,
// model, when paired, when last seen). ATELIER_HOME/remote/devices.json, 0600 in a 0700 folder, written atomically.
// Public keys only: nothing in it lets anyone in by itself.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ensureDir, writeFileAtomic } from '../../daemon/fsutil';

export interface PairedDevice {
  /** Derived from the key: stable across pairings of the same phone. */
  id: string;
  name: string;
  /** The hardware model the phone reported (e.g. iPhone17,1). */
  model: string;
  /** The phone's static public key, base64url. */
  key: string;
  pairedAt: number;
  lastSeenAt: number;
}

export const MAX_DEVICES = 20;

export const deviceIdOf = (key: string): string => createHash('sha256').update(key, 'ascii').digest('base64url').slice(0, 16);

const deviceSchema = z.object({
  id: z.string().min(1).max(64), name: z.string().max(200), model: z.string().max(200), key: z.string().length(43),
  pairedAt: z.number(), lastSeenAt: z.number()
}).strict();
const fileSchema = z.object({ v: z.literal(1), devices: z.array(deviceSchema).max(MAX_DEVICES) }).strict();

export class DeviceStore {
  private readonly dir: string;
  private readonly file: string;
  private cache: PairedDevice[] | null = null;

  constructor(home: string, private readonly now: () => number = Date.now) {
    this.dir = join(home, 'remote');
    this.file = join(this.dir, 'devices.json');
  }

  list(): PairedDevice[] {
    if (this.cache) return this.cache.map((d) => ({ ...d }));
    let parsed: PairedDevice[] = [];
    try {
      const r = fileSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      // A file this version can't read: no devices until they pair again (the next save replaces it).
      if (r.success) parsed = r.data.devices;
    } catch { /* none yet, or unreadable */ }
    this.cache = parsed;
    return parsed.map((d) => ({ ...d }));
  }

  byKey(key: string): PairedDevice | null {
    return this.list().find((d) => d.key === key) ?? null;
  }

  byId(id: string): PairedDevice | null {
    return this.list().find((d) => d.id === id) ?? null;
  }

  /**
   * A phone allowed in: added, or its name and model updated when its key is already known. Full, the device seen
   * longest ago makes room: `evicted` names it, so whoever keeps more of it (its push registration, its connection)
   * lets it go too.
   */
  add(o: { name: string; model: string; key: string }): { device: PairedDevice; evicted: PairedDevice[] } {
    const at = this.now();
    const id = deviceIdOf(o.key);
    const others = this.list().filter((d) => d.id !== id);
    const evicted: PairedDevice[] = [];
    while (others.length >= MAX_DEVICES) {
      const oldest = others.reduce((a, b) => (b.lastSeenAt < a.lastSeenAt ? b : a));
      others.splice(others.indexOf(oldest), 1);
      evicted.push(oldest);
    }
    const known = this.byId(id);
    const device: PairedDevice = { id, name: o.name, model: o.model, key: o.key, pairedAt: known?.pairedAt ?? at, lastSeenAt: at };
    this.save([...others, device]);
    return { device: { ...device }, evicted };
  }

  remove(id: string): boolean {
    const list = this.list();
    if (!list.some((d) => d.id === id)) return false;
    this.save(list.filter((d) => d.id !== id));
    return true;
  }

  /** A device connected (or its connection ended) now. */
  seen(id: string): void {
    const list = this.list();
    const d = list.find((x) => x.id === id);
    if (!d) return;
    d.lastSeenAt = this.now();
    this.save(list);
  }

  clear(): void { this.save([]); }

  private save(devices: PairedDevice[]): void {
    ensureDir(this.dir, 0o700);
    writeFileAtomic(this.file, JSON.stringify({ v: 1, devices }, null, 2) + '\n', 0o600);
    this.cache = devices.map((d) => ({ ...d }));
  }
}
