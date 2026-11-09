// Tab pop-out windows: an editor moving to another window takes its buffer along — text,
// selection, undo history, scroll, and the disk version Save compares against. Nothing is written by a move.
import { EditorState, Transaction, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { historyField } from '@codemirror/commands';
import type { Stamp } from '@shared/files';
import type { EditorHandoff } from '@shared/popout';
import { hasSaver } from './savers';

/** Past this (its JSON's length) the undo history stays behind: the text always travels. */
export const HISTORY_LIMIT = 8 * 1024 * 1024;

export function snapshotEditor(view: EditorView, extra: { path: string; saved: string | null; stamp: Stamp | null; eol: 'lf' | 'crlf' }): EditorHandoff {
  const json = view.state.toJSON({ history: historyField }) as { doc: string; selection: unknown; history?: unknown };
  const state: EditorHandoff['state'] = { doc: json.doc, selection: json.selection };
  if (json.history !== undefined) {
    let size = Infinity;
    try { size = JSON.stringify(json.history).length; } catch { /* not serializable: left behind */ }
    if (size <= HISTORY_LIMIT) state.history = json.history;
  }
  return { path: extra.path, state, saved: extra.saved, stamp: extra.stamp, eol: extra.eol, scrollTop: view.scrollDOM.scrollTop };
}

/** The editor state a handoff describes; anything off in its selection or history → the text alone. */
export function stateFromHandoff(h: EditorHandoff, extensions: Extension[]): EditorState {
  try {
    return EditorState.fromJSON(h.state, { extensions }, h.state.history ? { history: historyField } : undefined);
  } catch {
    return EditorState.create({ doc: h.state.doc, extensions });
  }
}

// Handoffs that arrived for a FileView about to mount in this window (one per path, taken once).
const pending = new Map<string, EditorHandoff>();

/** Waits for the path's next editor; refused when one is already open here (a later rebuild would replace its buffer). */
export function putHandoff(h: EditorHandoff): boolean {
  if (hasSaver(h.path)) return false;
  pending.set(h.path, h);
  return true;
}

export function takeHandoff(path: string): EditorHandoff | null {
  const h = pending.get(path) ?? null;
  pending.delete(path);
  return h;
}

/** A buffer is waiting for this path's editor (it decides how the editor first shows). */
export function hasHandoff(path: string): boolean {
  return pending.has(path);
}

// Editors whose tab is on its way to another window: the snapshot is taken, what is typed now would stay behind.
const moving = new Set<string>();

export function beginMove(path: string): void { moving.add(path); }
export function endMove(path: string): void { moving.delete(path); }
export function isMoving(path: string): boolean { return moving.has(path); }

/**
 * No edits while the tab moves (the window that gets it shows them never); after a failed move, editing goes on.
 * A reload from disk (kept out of the history, as `reloadSpec` does) still applies: saved and stamp follow it, and a
 * buffer left behind by a failed move must hold what they describe.
 */
export function moveGuard(path: string): Extension {
  return EditorState.changeFilter.of((tr) => !moving.has(path) || tr.annotation(Transaction.addToHistory) === false);
}
