// Find in Files: what opening a result does, shared by the list (click, ⏎, ⌘⏎) and the rows' menus.
import type { SearchFile, SearchLine } from '@shared/search';
import { useApp } from '../store';
import { useSearch } from './store';

export interface OpenHow {
  /** In the other pane of a split (a new split when there is none), as a kept tab; else the preview tab. */
  side: boolean;
  /** The keyboard stays where it is (⏎ and ⌘⏎ in the list, to walk on); else it moves to the editor. */
  keepFocus: boolean;
}

/** A match: its file opened at it, selected, every occurrence of the query marked (walking the results replaces the preview tab). */
export function openResult(file: SearchFile, line: SearchLine, index: number, how: OpenHow): void {
  useApp.getState().openSearchResult(file, line, index, { ...how, spec: useSearch.getState().spec });
}

/** A file row: its first match. */
export function openFileResult(file: SearchFile, how: OpenHow): void {
  const line = file.lines[0];
  if (line) openResult(file, line, 0, how);
}
