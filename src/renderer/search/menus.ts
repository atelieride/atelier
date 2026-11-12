// Find in Files' right-click menus (Shift+F10 too): a file row's, a match row's and the list's empty area's. They come
// with the view's chunk; none writes anything.
import { toNative } from '@shared/paths';
import { copyText } from '../clipboard';
import { t } from '../i18n/en';
import { kbd } from '../kbd';
import type { MenuItem } from '../menu-model';
import { useApp } from '../store';
import { openFileResult, openResult } from './actions';
import { ts } from './copy';
import { anyExpanded, buildRows, lineCopy, resultsText, type Row } from './model';
import { useSearch } from './store';

type FileRow = Extract<Row, { kind: 'file' }>;
type MatchRow = Extract<Row, { kind: 'match' }>;

const m = t.menu;
const copy = (text: string) => void copyText(text);
const dismissItem = (key: string): MenuItem => ({ id: 'dismiss', label: ts.dismiss, icon: 'x', hint: kbd('⌘⌫'), run: () => useSearch.getState().dismiss(key) });
const sideItem = (run: () => void): MenuItem => ({ id: 'open-to-side', label: m.openToSide, icon: 'split', hint: kbd('⌘⏎'), run });

export function searchFileMenu(row: FileRow): MenuItem[] {
  const { file } = row;
  return [
    { id: 'open', label: m.open, run: () => openFileResult(file, { side: false, keepFocus: false }) },
    sideItem(() => openFileResult(file, { side: true, keepFocus: false })),
    { id: 'reveal-tree', label: m.revealInFiles, icon: 'files', run: () => useApp.getState().revealInTree(file.path) },
    'sep',
    { id: 'copy-path', label: m.copyPath, run: () => copy(toNative(file.path)) },
    { id: 'copy-rel', label: m.copyRelPath, run: () => copy(toNative(file.rel)) },
    'sep',
    dismissItem(row.key)
  ];
}

export function searchMatchMenu(row: MatchRow): MenuItem[] {
  return [
    { id: 'open', label: m.open, run: () => openResult(row.file, row.line, row.index, { side: false, keepFocus: false }) },
    sideItem(() => openResult(row.file, row.line, row.index, { side: true, keepFocus: false })),
    { id: 'copy-line', label: ts.copyLine, icon: 'copy', run: () => copy(lineCopy(row.line)) },
    dismissItem(row.key)
  ];
}

/** The list's empty area and the summary. */
export function searchAreaMenu(): MenuItem[] {
  const s = useSearch.getState();
  const rows = buildRows(s.files, s.collapsed, s.dismissed);
  const shown = rows.length > 0;
  const anyOpen = anyExpanded(rows);
  return [
    { id: 'copy-all', label: ts.copyAll, icon: 'copy', disabled: !shown, run: () => copy(resultsText(s.ranSpec, s.files, s.dismissed)) },
    'sep',
    anyOpen
      ? { id: 'collapse-all', label: ts.collapseAll, icon: 'collapseAll', disabled: !shown, run: () => useSearch.getState().setAllCollapsed(true) }
      : { id: 'expand-all', label: ts.expandAll, icon: 'unfoldAll', disabled: !shown, run: () => useSearch.getState().setAllCollapsed(false) },
    { id: 'clear', label: ts.clear, icon: 'x', disabled: s.spec.query === '' && s.files.length === 0, run: () => useSearch.getState().setQuery('') }
  ];
}
