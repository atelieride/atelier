import { Transaction, type TransactionSpec } from '@codemirror/state';
/** The editor always works with LF: the original line ending is restored on save. */
export function normalizeEol(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/**
 * The file changed on disk while open:
 * - no local changes → the difference is applied in its place;
 * - local changes and the disk equals the buffer → adopt it (as if it were saved);
 * - local changes and the disk is unchanged from the last known version → nothing;
 * - otherwise → conflict to resolve (Compare, Keep Mine, Reload).
 */
export function onDiskChange(s: { dirty: boolean; disk: string; buffer: string; saved: string }): 'reload-minimal' | 'adopt' | 'none' | 'conflict' {
  if (s.disk === s.buffer) return s.dirty ? 'adopt' : 'none';
  if (!s.dirty) return 'reload-minimal';
  if (s.disk === s.saved) return 'none';
  return 'conflict';
}

/** A reload from disk doesn't go into the history: ⌘Z must not undo what Claude wrote. */
export function reloadSpec(change: { from: number; to: number; insert: string }): TransactionSpec {
  return { changes: change, annotations: Transaction.addToHistory.of(false) };
}

/**
 * Unsaved edits: the buffer differs from the last known disk version, whatever the disk holds now (a copy that turned
 * not UTF-8 makes the view read-only, not the edits saved). The Diff view's text is the diff: it holds none.
 */
export function unsaved(v: { doc: string; saved: string | null; diff: boolean } | null): boolean {
  return !!v && !v.diff && v.doc !== v.saved;
}

/** What a save does: write, nothing (the Diff view, a file read-only from the start), or tell why it can't. */
export function saveGate(s: { diff: boolean; notUtf8: boolean; gitInternal: boolean; unsaved: boolean }): 'save' | 'quiet' | 'not-utf8' {
  if (s.diff || s.gitInternal) return 'quiet';
  if (s.notUtf8) return s.unsaved ? 'not-utf8' : 'quiet';
  return 'save';
}
