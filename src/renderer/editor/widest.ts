// The code as wide as its widest line, from the start. CodeMirror draws, and measures, only the lines near the view, so
// the content's width (and with it the horizontal scrollbar, which takes its height from the code) used to come and go
// while scrolling: the code jumped by the scrollbar's height whenever a long line came near or went away. The widest
// line's columns go to the editor as `--cm-widest`; cmTheme turns them into the content's min-width (not with wrapping).
import { countColumn, EditorState, StateField, type ChangeSet, type Extension, type Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** A line's width in columns, tabs up to their stops. */
export function lineColumns(text: string, tabSize: number): number {
  return text.includes('\t') ? countColumn(text, tabSize) : text.length;
}

export function widestColumns(doc: Text, tabSize: number): number {
  let widest = 0;
  for (const it = doc.iterLines(); !it.next().done;) widest = Math.max(widest, lineColumns(it.value, tabSize));
  return widest;
}

/**
 * The widest after `changes`, from the lines they touched: a wider line written wins; the widest touched means a new
 * scan (it may have shrunk or gone); anything else leaves it as it was.
 */
function nextWidest(prev: number, before: Text, after: Text, changes: ChangeSet, tabSize: number): number {
  let touched = false;
  let written = 0;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    for (let n = before.lineAt(fromA).number, end = before.lineAt(toA).number; !touched && n <= end; n++) {
      if (lineColumns(before.line(n).text, tabSize) >= prev) touched = true;
    }
    for (let n = after.lineAt(fromB).number, end = after.lineAt(toB).number; n <= end; n++) {
      written = Math.max(written, lineColumns(after.line(n).text, tabSize));
    }
  });
  if (written >= prev) return written;
  return touched ? widestColumns(after, tabSize) : prev;
}

/** The document's widest line, in columns. */
export const widestField = StateField.define<number>({
  create: (s) => widestColumns(s.doc, s.tabSize),
  update(prev, tr) {
    if (tr.state.tabSize !== tr.startState.tabSize) return widestColumns(tr.newDoc, tr.state.tabSize);
    return tr.docChanged ? nextWidest(prev, tr.startState.doc, tr.newDoc, tr.changes, tr.state.tabSize) : prev;
  }
});

export const stableWidth: Extension = [
  widestField,
  EditorView.editorAttributes.compute([widestField], (s: EditorState) => ({ style: `--cm-widest: ${s.field(widestField)}` }))
];
