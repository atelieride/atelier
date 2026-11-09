// Review view: a hunk header above each hunk of a read-only diff, the current one highlighted.
import { RangeSetBuilder, StateEffect, StateField, type Text } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { ReviewDoc } from '../review';

export const setCurrentHunk = StateEffect.define<number | null>();

class HunkHeader extends WidgetType {
  constructor(readonly text: string, readonly index: number, readonly current: boolean) { super(); }
  eq(o: HunkHeader) { return o.text === this.text && o.index === this.index && o.current === this.current; }
  toDOM() {
    // The spacing is the wrapper's padding, never a margin: CodeMirror measures a block widget without its margins,
    // and the gutters would drift from the lines.
    const wrap = document.createElement('div');
    wrap.className = 'rv-hunk-row';
    const el = document.createElement('div');
    el.className = `rv-hunk-head${this.current ? ' is-current' : ''}`;
    el.dataset.hunk = String(this.index);
    el.textContent = this.text;
    wrap.appendChild(el);
    return wrap;
  }
  // Clicks reach the review's own handler (select the hunk), not the editor's selection.
  ignoreEvent() { return true; }
}

function headers(doc: ReviewDoc, text: Text, current: number | null): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  doc.hunks.forEach((h, i) => {
    if (h.line < 1 || h.line > text.lines) return;
    const at = text.line(h.line).from;
    b.add(at, at, Decoration.widget({ widget: new HunkHeader(h.header, i, i === current), block: true, side: -1 }));
  });
  return b.finish();
}

/** The header widgets (block widgets must come from a state field); setCurrentHunk moves the highlight. */
export function hunkHeaders(doc: ReviewDoc) {
  return StateField.define<DecorationSet>({
    create: (state) => headers(doc, state.doc, null),
    update(deco, tr) {
      for (const e of tr.effects) if (e.is(setCurrentHunk)) return headers(doc, tr.state.doc, e.value);
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f)
  });
}
