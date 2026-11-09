import { lstatSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parseThread } from '@shared/companion/thread';
import type { Thread } from '@shared/companion/types';
import { SESSION_ID } from '@shared/history';
import { ensureDir, writeFileAtomic } from '../../daemon/fsutil';

/** What is at a path, the path itself (lstat: a symlink is a link, never what it points to). */
function entryKind(path: string): 'missing' | 'dir' | 'link' | 'other' {
  try {
    const st = lstatSync(path);
    return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'other';
  } catch { return 'missing'; }
}

/**
 * Ask's files in ATELIER_HOME/companion/<sessionId>/: thread.json plus the inputs the
 * companion reads (rules.md, chat.md, facts.md). The only writer of that folder; the folder is 0700, files 0600, atomic.
 * Windows has no mode bits (NTFS keeps only a read-only flag): the folder is private as atelierd.json is there, by the
 * ACL %USERPROFILE%\.atelier inherits from the user's profile.
 */
export class CompanionStore {
  constructor(private readonly root: string) {}

  dirOf(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error('not a session id');
    return join(this.root, sessionId);
  }

  /** The saved thread; null when missing, unreadable, damaged or another session's. */
  load(sessionId: string): Thread | null {
    try { return parseThread(JSON.parse(readFileSync(join(this.dirOf(sessionId), 'thread.json'), 'utf8')), sessionId); } catch { return null; }
  }

  // Every write is atomic (a temp file renamed over the name): a symlink at thread.json or an input is replaced, never
  // written through.
  save(t: Thread): void {
    const dir = this.ownDir(t.sessionId);
    writeFileAtomic(join(dir, 'thread.json'), JSON.stringify(t), 0o600);
  }

  writeInputs(sessionId: string, f: { rules: string; chat: string; facts: string }): void {
    const dir = this.ownDir(sessionId);
    writeFileAtomic(join(dir, 'rules.md'), f.rules, 0o600);
    writeFileAtomic(join(dir, 'chat.md'), f.chat, 0o600);
    writeFileAtomic(join(dir, 'facts.md'), f.facts, 0o600);
  }

  /** Retention: the session's whole folder (Atelier's own data, not a project file). A symlink is unlinked, never followed. */
  remove(sessionId: string): void {
    const dir = this.dirOf(sessionId);
    const kind = entryKind(dir);
    if (kind === 'missing') return;
    if (kind === 'link') { try { unlinkSync(dir); } catch { /* gone meanwhile */ } return; }
    rmSync(dir, { recursive: true, force: true });
  }

  /** The session's folder to write in, created 0700 when missing; a symlink or a file in its place is refused, never followed. */
  private ownDir(sessionId: string): string {
    const dir = this.dirOf(sessionId);
    const kind = entryKind(dir);
    if (kind !== 'missing' && kind !== 'dir') throw new Error("companion: the session's folder is not a folder");
    ensureDir(dir, 0o700);
    return dir;
  }

  /** When the session's folder last changed (every atomic write renames into it); null without a folder. */
  changedAt(sessionId: string): number | null {
    try { return lstatSync(this.dirOf(sessionId)).mtimeMs; } catch { return null; }
  }

  /** Session ids that have a folder. */
  list(): string[] {
    try { return readdirSync(this.root, { withFileTypes: true }).filter((e) => e.isDirectory() && SESSION_ID.test(e.name)).map((e) => e.name); } catch { return []; }
  }
}
