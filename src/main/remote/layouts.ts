// How each project's sidebar is arranged, as its window last showed it with iPhone access on: what a phone groups a
// project's rows by while that window is closed too. ATELIER_HOME/remote/layouts.json, 0600 in a 0700 folder, written
// atomically; names and ids only (a workspace's folder by its name), read back through the same strict schema.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { RemoteLayout } from '@shared/remote';
import { ensureDir, writeFileAtomic } from '../../daemon/fsutil';
import { remoteLayoutSchema } from '../ipc-schemas';

/** Projects kept at most: the one changed longest ago makes room. */
export const MAX_LAYOUTS = 100;

const fileSchema = z.object({ v: z.literal(1), projects: z.record(z.string().min(1).max(4096), remoteLayoutSchema) }).strict();

export class LayoutStore {
  private readonly dir: string;
  private readonly file: string;
  /** Project root → layout, in the order they last changed (oldest first). */
  private cache: Map<string, RemoteLayout> | null = null;

  constructor(home: string) {
    this.dir = join(home, 'remote');
    this.file = join(this.dir, 'layouts.json');
  }

  private load(): Map<string, RemoteLayout> {
    if (this.cache) return this.cache;
    let parsed: Record<string, RemoteLayout> = {};
    try {
      const r = fileSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      // A file this version can't read: no layouts until the windows send theirs again.
      if (r.success) parsed = r.data.projects as Record<string, RemoteLayout>;
    } catch { /* none yet, or unreadable */ }
    this.cache = new Map(Object.entries(parsed));
    return this.cache;
  }

  get(root: string): RemoteLayout | null {
    return this.load().get(root) ?? null;
  }

  /** The projects whose layout lists place `id` (place ids are made unique, so one at most in practice). */
  holders(id: string): string[] {
    return [...this.load()].filter(([, l]) => l.workspaces?.places.some((p) => p.id === id)).map(([root]) => root);
  }

  /** A window's layout for its project; false when it is the one kept already (nothing written). */
  set(root: string, layout: RemoteLayout): boolean {
    const all = this.load();
    const before = all.get(root);
    if (before && JSON.stringify(before) === JSON.stringify(layout)) return false;
    all.delete(root);
    all.set(root, layout);
    while (all.size > MAX_LAYOUTS) all.delete(all.keys().next().value as string);
    ensureDir(this.dir, 0o700);
    writeFileAtomic(this.file, JSON.stringify({ v: 1, projects: Object.fromEntries(all) }) + '\n', 0o600);
    return true;
  }
}
