// Registry of open files that know how to save themselves: ⌘S, ⌘⌥S, tab closing and quitting go through here.
// Moving a tab to another window asks it for its buffer too.
import type { EditorHandoff } from '@shared/popout';

interface Entry { save: () => Promise<boolean>; isDirty?: () => boolean; handoff?: () => EditorHandoff | null }
const savers = new Map<string, Entry>();

export function registerSaver(path: string, save: () => Promise<boolean>, isDirty?: () => boolean, handoff?: () => EditorHandoff | null): () => void {
  const entry: Entry = { save, isDirty, handoff };
  savers.set(path, entry);
  return () => { if (savers.get(path) === entry) savers.delete(path); };
}

/** An editor for this path is open in this window. */
export function hasSaver(path: string): boolean {
  return savers.has(path);
}

/** The open editor's buffer as it is now, to move with its tab (none: nothing to carry, the file is read again). */
export function handoffOf(path: string): EditorHandoff | undefined {
  return savers.get(path)?.handoff?.() ?? undefined;
}

/** Unsaved right now, without waiting for the delay with which the store learns about it (a ⌘W right after a keystroke). */
export function isDirtyNow(path: string, fallback: boolean): boolean {
  return savers.get(path)?.isDirty?.() ?? fallback;
}

/** All open files with unsaved changes, according to the editors themselves. */
export function dirtyPaths(): string[] {
  return [...savers.entries()].filter(([, e]) => e.isDirty?.()).map(([p]) => p);
}

export async function saveOne(path: string): Promise<boolean> {
  const s = savers.get(path);
  return s ? s.save() : false;
}

export async function saveMany(paths: string[]): Promise<boolean> {
  let ok = true;
  for (const p of paths) ok = (await saveOne(p)) && ok;
  return ok;
}
