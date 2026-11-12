// Find in Files: what opening a result does, shared by the list (click, ⏎, ⌘⏎) and the rows' menus.
import type { SearchFile } from '@shared/search';
import { useApp } from '../store';

/** A result's file in the preview tab, at the match's line (walking the results replaces that tab). */
export function openResult(file: SearchFile, line: number | null): void {
  useApp.getState().openFile(file.path, file.rel, line, undefined, { preview: true });
}

/** A result's file in the other pane of a split, a new split made when there is none. */
export function openResultToSide(file: SearchFile): void {
  useApp.getState().openFileToSide(file.path, file.rel);
}

/** The first line with a match of a file: where its file row opens it. */
export const firstLine = (file: SearchFile): number | null => file.lines[0]?.line ?? null;
