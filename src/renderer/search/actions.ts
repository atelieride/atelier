// Find in Files: what opening a result does, shared by the list (click, ⏎, ⌘⏎) and the rows' menus; what the results
// as a whole can do (copied, sent to a Claude session).
import type { SearchFile, SearchLine } from '@shared/search';
import { copyText } from '../clipboard';
import { newSessionIn } from '../launch';
import { useApp } from '../store';
import { typeWhenReadyAs } from '../task-session';
import { ts } from './copy';
import { resultsText } from './model';
import { useSearch } from './store';

export interface OpenHow {
  /** In the other pane of a split (a new split when there is none), as a kept tab; else the preview tab. */
  side: boolean;
  /** The keyboard stays where it is (⏎ and ⌘⏎ in the list, to walk on); else it moves to the editor. */
  keepFocus: boolean;
}

/**
 * A match: its file opened at it, selected, every occurrence of the query its search ran with marked (walking the
 * results replaces the preview tab).
 */
export function openResult(file: SearchFile, line: SearchLine, index: number, how: OpenHow): void {
  useApp.getState().openSearchResult(file, line, index, { ...how, spec: useSearch.getState().ranSpec });
}

/** A file row: its first match. */
export function openFileResult(file: SearchFile, how: OpenHow): void {
  const line = file.lines[0];
  if (line) openResult(file, line, 0, how);
}

/** The results as text: the query and options they were searched with, dismissed rows left out, 200 lines at most. */
function resultsBlock(): string {
  const s = useSearch.getState();
  return resultsText(s.ranSpec, s.files, s.dismissed);
}

/** Copy All Results. */
export function copyAllResults(): void {
  void copyText(resultsBlock());
}

/** A new session's name: the query it was searched for, its start when long. */
const SESSION_QUERY_CHARS = 40;

/**
 * ✦ Send to session (and the menus' Send to Session…): the palette's send step with the results as context for Claude —
 * this project's Claude sessions (one busy or asking greyed, with why), or a new session, named after the search, that
 * gets them in its prompt once Claude is ready. Typed, never sent, unless ⌘↵ asks for it.
 */
export function sendResults(): void {
  const text = resultsBlock();
  // Cut between characters, never inside one.
  const q = [...useSearch.getState().ranSpec.query];
  const name = `search ${q.length > SESSION_QUERY_CHARS ? `${q.slice(0, SESSION_QUERY_CHARS - 1).join('')}…` : q.join('')}`;
  useApp.getState().openSendPalette({
    text, cwd: null,
    newSession: (send) => void newSessionIn(name).then((info) => { if (info) typeWhenReadyAs(info.id, text, send, ts.typedInNew); })
  });
}
