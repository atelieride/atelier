// Find in Files' right-click menus (Shift+F10 too): a file row's, a match row's and the list's empty area's. They come
// with the view's chunk; none writes anything.
import { toNative } from '@shared/paths';
import { copyText } from '../clipboard';
import { t } from '../i18n/en';
import { kbd } from '../kbd';
import type { MenuItem } from '../menu-model';
import { useApp } from '../store';
import { firstLine, openResult, openResultToSide } from './actions';
import { ts } from './copy';
import { fileKey, resultsText, type Row } from './model';
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
    { id: 'open', label: m.open, run: () => openResult(file, firstLine(file)) },
    sideItem(() => openResultToSide(file)),
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
    { id: 'open', label: m.open, run: () => openResult(row.file, row.line.line) },
    sideItem(() => openResultToSide(row.file)),
    { id: 'copy-line', label: ts.copyLine, icon: 'copy', run: () => copy(row.line.text.trimStart()) },
    dismissItem(row.key)
  ];
}

/** The list's empty area and the summary. */
export function searchAreaMenu(): MenuItem[] {
  const s = useSearch.getState();
  const shown = s.files.some((f) => !s.dismissed.has(fileKey(f.path)));
  const anyOpen = s.files.some((f) => !s.collapsed.has(fileKey(f.path)));
  return [
    { id: 'copy-all', label: ts.copyAll, icon: 'copy', disabled: !shown, run: () => copy(resultsText(s.spec, s.files, s.dismissed)) },
    'sep',
    anyOpen
      ? { id: 'collapse-all', label: ts.collapseAll, icon: 'collapseAll', disabled: !shown, run: () => useSearch.getState().setAllCollapsed(true) }
      : { id: 'expand-all', label: ts.expandAll, icon: 'unfoldAll', disabled: !shown, run: () => useSearch.getState().setAllCollapsed(false) },
    { id: 'clear', label: ts.clear, icon: 'x', disabled: s.spec.query === '' && s.files.length === 0, run: () => useSearch.getState().setQuery('') }
  ];
}
