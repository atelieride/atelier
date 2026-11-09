// Preview commands: View menu, ⇧⌘V and the palette act
// on the tab in front — a Markdown file's preview, a JSON file's tree or a CSV file's table.
import { useApp } from './store';
import { t } from './i18n/en';
import { isPreviewTab, toggledView, type MdView } from './markdown-views';

/** The Markdown, JSON or CSV file tab in front, or null (with a toast when `say`). */
export function activePreviewPath(say = true): string | null {
  const st = useApp.getState();
  const key = st.activeKey();
  const path = key?.startsWith('f:') ? key.slice(2) : null;
  if (path && isPreviewTab(path, st.langOverrides)) return path;
  if (say) st.showToast(t.md.notMarkdown, undefined, 'info');
  return null;
}

/** ⇧⌘V: Preview (Tree, Table) → Source, Source or Split → Preview (Tree, Table). */
export function togglePreview(): void {
  const path = activePreviewPath();
  if (path) useApp.getState().setMdView(path, toggledView(useApp.getState().mdViewOf(path)));
}

export function setActivePreviewView(view: MdView): void {
  const path = activePreviewPath();
  if (path) useApp.getState().setMdView(path, view);
}

/** View › Markdown Outline: the Settings › Editor switch. */
export function toggleMarkdownOutline(): void {
  void window.atelier.settings.set({ markdownOutline: !useApp.getState().settings.markdownOutline });
}
