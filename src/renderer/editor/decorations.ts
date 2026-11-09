import { RangeSet, RangeSetBuilder, StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet } from '@codemirror/view';
import type { TokenSpans } from './tokens';
import { wordMarks, type DiffDoc, type GutterMark, type WordMark } from './linediff';

export const setTokens = StateEffect.define<TokenSpans | null>();
export const setTargetLine = StateEffect.define<number | null>();

const markCache = new Map<string, Decoration>();
const mark = (color: string) => {
  let d = markCache.get(color);
  if (!d) { d = Decoration.mark({ attributes: { style: `color:${color}` } }); markCache.set(color, d); }
  return d;
};

export const tokenField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (!e.is(setTokens)) continue;
      if (!e.value) return Decoration.none;
      const b = new RangeSetBuilder<Decoration>();
      const { spans, colors } = e.value;
      const max = tr.state.doc.length;
      for (let i = 0; i < spans.length; i += 3) {
        const from = spans[i]!; const to = Math.min(spans[i + 1]!, max);
        if (from < to) b.add(from, to, mark(colors[spans[i + 2]!]!));
      }
      return b.finish();
    }
    // While typing, the colors follow the text; the worker recomputes them shortly after.
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f)
});

const targetDeco = Decoration.line({ class: 'cm-target-line' });
export const targetField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (!e.is(setTargetLine)) continue;
      if (e.value === null || e.value < 1 || e.value > tr.state.doc.lines) return Decoration.none;
      const line = tr.state.doc.line(e.value);
      return Decoration.set([targetDeco.range(line.from)]);
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f)
});

// --- Git: diff gutter and Diff view ---------------------------------------------

class GitMark extends GutterMarker {
  constructor(readonly kind: GutterMark) { super(); }
  eq(o: GitMark) { return o.kind === this.kind; }
  toDOM() { const s = document.createElement('span'); s.className = `cm-git-${this.kind}`; return s; }
}
const GIT_MARKS: Record<GutterMark, GitMark> = { add: new GitMark('add'), mod: new GitMark('mod'), del: new GitMark('del') };

export const setGitMarks = StateEffect.define<Map<number, GutterMark> | null>();
export const gitMarksField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    for (const e of tr.effects) {
      if (!e.is(setGitMarks)) continue;
      if (!e.value) return RangeSet.empty;
      const ranges = [...e.value.entries()]
        .filter(([n]) => n >= 1 && n <= tr.state.doc.lines)
        .sort((a, b) => a[0] - b[0])
        .map(([n, k]) => GIT_MARKS[k].range(tr.state.doc.line(n).from));
      return RangeSet.of(ranges);
    }
    return tr.docChanged ? set.map(tr.changes) : set;
  }
});
export const gitGutter = gutter({ class: 'cm-git-gutter', markers: (v) => v.state.field(gitMarksField) });

/** The margin's marks as changed lines (the overview ruler's changes in Margin). */
export function gitMarkLines(state: EditorState): { line: number; kind: GutterMark }[] {
  const out: { line: number; kind: GutterMark }[] = [];
  const doc = state.doc;
  state.field(gitMarksField, false)?.between(0, doc.length, (from, _to, m) => { out.push({ line: doc.lineAt(from).number, kind: (m as GitMark).kind }); });
  return out;
}

/** The Diff view's added and removed rows as changed lines (the overview ruler's changes in Diff). */
export function diffRulerSource(doc: DiffDoc): { changes: () => { line: number; kind: 'add' | 'del' }[]; fileLine: (line: number) => number | null } {
  const rows = doc.lines.flatMap((l, i) => (l.kind === 'ctx' ? [] : [{ line: i + 1, kind: l.kind }]));
  return { changes: () => rows, fileLine: (line) => doc.lines[line - 1]?.newNo ?? null };
}

class TextMarker extends GutterMarker {
  /** `row`: the gutter cell's class (the Diff view tints an added or removed row's numbers and signs). */
  constructor(readonly text: string, readonly cls: string, row = '') { super(); this.elementClass = row; }
  eq(o: TextMarker) { return o.text === this.text && o.cls === this.cls && o.elementClass === this.elementClass; }
  toDOM() { const s = document.createElement('span'); s.className = this.cls; s.textContent = this.text; return s; }
}

/** An added or removed row's gutter cells: a step fuller than the row. */
const GUTTER_ROW: Record<DiffDoc['lines'][number]['kind'], string> = { ctx: '', add: 'cm-diff-gadd', del: 'cm-diff-gdel' };

/** Diff view: added and removed lines colored, line numbers of the new version and +/− signs. */
export function diffExtensions(doc: DiffDoc) {
  const lineDeco = { add: Decoration.line({ class: 'cm-diff-add' }), del: Decoration.line({ class: 'cm-diff-del' }) };
  const wordDeco = { add: Decoration.mark({ class: 'cm-diff-word-add' }), del: Decoration.mark({ class: 'cm-diff-word-del' }) };
  // Changed words, by row, in order.
  const words = new Map<number, WordMark[]>();
  for (const m of wordMarks(doc)) words.set(m.line, [...(words.get(m.line) ?? []), m]);
  const decos = StateField.define<DecorationSet>({
    create(state) {
      const b = new RangeSetBuilder<Decoration>();
      doc.lines.forEach((l, i) => {
        if (l.kind === 'ctx' || i >= state.doc.lines) return;
        const line = state.doc.line(i + 1);
        b.add(line.from, line.from, lineDeco[l.kind]);
        for (const m of (words.get(i) ?? []).sort((x, y) => x.from - y.from)) {
          if (m.to <= line.length) b.add(line.from + m.from, line.from + m.to, wordDeco[m.kind]);
        }
      });
      return b.finish();
    },
    update: (d) => d,
    provide: (f) => EditorView.decorations.from(f)
  });
  const numbers = gutter({
    class: 'cm-diff-numbers',
    lineMarker(view, line) {
      const meta = doc.lines[view.state.doc.lineAt(line.from).number - 1];
      return new TextMarker(meta?.newNo ? String(meta.newNo) : '', 'cm-diff-no', meta ? GUTTER_ROW[meta.kind] : '');
    }
  });
  const signs = gutter({
    class: 'cm-diff-signs',
    lineMarker(view, line) {
      const meta = doc.lines[view.state.doc.lineAt(line.from).number - 1];
      return meta?.kind === 'add' ? new TextMarker('+', 'cm-diff-plus', GUTTER_ROW.add) : meta?.kind === 'del' ? new TextMarker('−', 'cm-diff-minus', GUTTER_ROW.del) : null;
    }
  });
  return [decos, numbers, signs];
}
