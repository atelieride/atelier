import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Attribution } from '@shared/attribution';
import { profileSchema, type Resumable, type TerminalProfile } from '@shared/protocol';
import type { SessionState } from '@shared/session';
import type { NameSync } from '@shared/session-name';
import { writeFileAtomic } from './fsutil';
import { isCleanAbsPath } from '@shared/clean-path';

export interface RegistryTerminal {
  id: string; projectRoot: string; cwd: string; name: string | null; title: string; color: string;
  sessionId: string | null; state: SessionState | null; createdAt: number;
  /** Absent in registries written before profiles. */
  profile?: TerminalProfile;
  /** Where Claude stands on the name (session name sync); absent in registries written before it. */
  nameSync?: NameSync;
  /** The session's last message time; absent in registries written before it. */
  lastMessageAt?: number;
  /** The Claude config dir the session ran with; absent when unknown or written before it. */
  configDir?: string;
}
export interface RegistryFile { v: 1; terminals: RegistryTerminal[]; resumables: Resumable[]; attributions: Attribution[] }

const str = z.string().max(4096);
const nameSync = z.enum(['pending', 'sent', 'synced', 'kept']);
// A config dir that isn't a clean absolute path is forgotten (here and in `tidy`), not a reason to drop the session.
const configDir = str.optional().catch(undefined);
const terminalSchema = z.object({
  id: str, projectRoot: str, cwd: str, name: str.nullable(), title: str, color: str,
  sessionId: str.nullable(), state: z.enum(['idle', 'running', 'waiting', 'done', 'error']).nullable(), createdAt: z.number(),
  profile: profileSchema.optional(), nameSync: nameSync.optional(), lastMessageAt: z.number().optional(), configDir
});
const resumableSchema = z.object({ id: str, projectRoot: str, cwd: str, title: str, color: str, sessionId: str, endedAt: z.number(), profile: profileSchema.optional(), name: str.nullable().optional(), nameSync: nameSync.optional(), lastMessageAt: z.number().optional(), configDir });
const attributionSchema = z.object({ path: str, terminalId: str, sessionId: str, color: str, title: str, at: z.number() });
const fileSchema = z.object({ v: z.literal(1), terminals: z.array(z.unknown()), resumables: z.array(z.unknown()), attributions: z.array(z.unknown()) });

const empty = (): RegistryFile => ({ v: 1, terminals: [], resumables: [], attributions: [] });

/** Invalid entries are dropped one by one; an unreadable file, or one from another version, counts as an empty registry. */
export function loadRegistry(file: string): RegistryFile {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return empty(); }
  const f = fileSchema.safeParse(raw);
  if (!f.success) return empty();
  const keep = <T>(items: unknown[], schema: z.ZodType<T>): T[] => items.flatMap((x) => { const r = schema.safeParse(x); return r.success ? [r.data] : []; });
  // A config dir that isn't clean is no key at all: entries compare as they were written.
  const tidy = <T extends { configDir?: string }>(x: T): T => { if (!isCleanAbsPath(x.configDir)) delete x.configDir; return x; };
  return { v: 1, terminals: keep(f.data.terminals, terminalSchema).map(tidy), resumables: keep(f.data.resumables, resumableSchema).map(tidy), attributions: keep(f.data.attributions, attributionSchema) };
}

export function saveRegistry(file: string, r: RegistryFile): void {
  writeFileAtomic(file, JSON.stringify(r), 0o600);
}

/**
 * At startup the registered terminals no longer have a process: those with a Claude session become resumable, with the
 * terminal's name and where Claude stood on it (session name sync). A name saved before name sync stays Atelier-only
 * ('kept'): it may be a history title Atelier set itself, which must not become Claude's name; so does the title of a
 * resumable saved then (it was resumed as the name).
 */
export function toResumables(prev: RegistryFile, now: number): Resumable[] {
  const out = new Map<string, Resumable>();
  for (const r of prev.resumables) out.set(r.id, r.name === undefined ? { ...r, name: r.title, nameSync: 'kept' } : r);
  for (const t of prev.terminals) {
    if (!t.sessionId) continue;
    const sync: NameSync | undefined = t.name ? t.nameSync ?? 'kept' : undefined;
    out.set(t.id, { id: t.id, projectRoot: t.projectRoot, cwd: t.cwd, title: t.title, color: t.color, sessionId: t.sessionId, endedAt: now, ...(t.profile ? { profile: t.profile } : {}), name: t.name, ...(sync ? { nameSync: sync } : {}), ...(t.lastMessageAt !== undefined ? { lastMessageAt: t.lastMessageAt } : {}), ...(t.configDir ? { configDir: t.configDir } : {}) });
  }
  return [...out.values()];
}
