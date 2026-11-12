// Line comments in CodeMirror: the comment box and the saved comments under their lines, a marker in
// the gutter, and a "Comment" button at the selection. Shared by the editor, its diff mode and the review view.
import { createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RangeSet, RangeSetBuilder, StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, showTooltip, type DecorationSet, type Tooltip, type ViewUpdate } from '@codemirror/view';
import { selectionSettle, type SelectionSettle } from './selection-settle';
import { useApp, type CommentDraft } from '../store';
import { t } from '../i18n/en';
import { defaultTarget, docLineOf, isOutdated, newLineRange, snippetOf } from '../comments';
import { selectionLines } from '../mention';
import { CommentBox, CommentCard } from '../components/CommentThread';
import { kbd as keyLabel } from '../kbd';

type Row = { newNo: number | null };

/** Where each comment shows in this view: under document line `after`, its marker on line `from`. */
export interface CommentPlacement { id: string; from: number; after: number; outdated: boolean }
export interface CommentDecoState { comments: CommentPlacement[]; draft: { after: number; nonce: number } | null }
export const setCommentDecos = StateEffect.define<CommentDecoState>();

/**
 * Asks the editor to read its line and widget heights again. `requestMeasure()` alone reads them only after a redraw or
 * when the content element changed height, and in a file shorter than the editor (`.cm-content` has `min-height: 100%`)
 * a widget that grows changes neither: the height map goes stale and a click below the widget lands lines further down.
 * CodeMirror has no public way to ask for it, hence its own flag (left alone if a later version drops it).
 */
function measureContent(view: EditorView) {
  const state = (view as unknown as { viewState?: { mustMeasureContent?: boolean | 'refresh' } }).viewState;
  if (state && state.mustMeasureContent === false) state.mustMeasureContent = true;
  view.requestMeasure();
}

/** A widget whose content is a React element (its own root), re-measured by the editor when its size changes. */
class ReactWidget extends WidgetType {
  constructor(readonly key: string, readonly element: () => ReactElement) { super(); }
  eq(o: ReactWidget) { return o.key === this.key; }
  toDOM(view: EditorView) {
    const el = document.createElement('div');
    el.className = 'lc-widget';
    const root = createRoot(el);
    root.render(this.element());
    const ro = new ResizeObserver(() => measureContent(view));
    ro.observe(el);
    mounted.set(el, { root, ro });
    return el;
  }
  destroy(dom: HTMLElement) {
    const m = mounted.get(dom);
    mounted.delete(dom);
    if (!m) return;
    m.ro.disconnect();
    // Never unmount while React may be rendering (the editor can update from inside an effect).
    queueMicrotask(() => m.root.unmount());
  }
  get estimatedHeight() { return 72; }
  // Typing, clicks and selection inside the box belong to it, not to the editor.
  ignoreEvent() { return true; }
}
const mounted = new WeakMap<HTMLElement, { root: Root; ro: ResizeObserver }>();

class CommentMark extends GutterMarker {
  constructor(readonly outdated: boolean) { super(); }
  eq(o: CommentMark) { return o.outdated === this.outdated; }
  toDOM() {
    const s = document.createElement('span');
    s.className = `lc-mark${this.outdated ? ' is-outdated' : ''}`;
    s.title = this.outdated ? t.comments.outdated : t.comments.comment;
    return s;
  }
}

function build(state: EditorState, spec: CommentDecoState): { decos: DecorationSet; marks: RangeSet<GutterMarker> } {
  const lines = state.doc.lines;
  const blocks: { pos: number; order: number; deco: Decoration }[] = [];
  spec.comments.forEach((c, i) => {
    if (c.after < 1 || c.after > lines) return;
    blocks.push({ pos: state.doc.line(c.after).to, order: i, deco: Decoration.widget({ widget: new ReactWidget(`c:${c.id}:${c.outdated}`, () => createElement(CommentCard, { id: c.id, outdated: c.outdated })), block: true, side: 1 }) });
  });
  if (spec.draft && spec.draft.after >= 1 && spec.draft.after <= lines) {
    blocks.push({ pos: state.doc.line(spec.draft.after).to, order: spec.comments.length, deco: Decoration.widget({ widget: new ReactWidget(`d:${spec.draft.nonce}`, () => createElement(CommentBox)), block: true, side: 2 }) });
  }
  blocks.sort((a, b) => a.pos - b.pos || a.order - b.order);
  const b = new RangeSetBuilder<Decoration>();
  for (const x of blocks) b.add(x.pos, x.pos, x.deco);
  const marks = spec.comments.filter((c) => c.from >= 1 && c.from <= lines).sort((a, b) => a.from - b.from)
    .map((c) => new CommentMark(c.outdated).range(state.doc.line(c.from).from));
  return { decos: b.finish(), marks: RangeSet.of(marks, true) };
}

const commentsField = StateField.define<{ decos: DecorationSet; marks: RangeSet<GutterMarker>; spec: CommentDecoState }>({
  create: () => ({ decos: Decoration.none, marks: RangeSet.empty, spec: { comments: [], draft: null } }),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setCommentDecos)) return { ...build(tr.state, e.value), spec: e.value };
    // While typing in the editor the lines move: rebuilt from the same placements, clipped to the document.
    return tr.docChanged ? { ...build(tr.state, v.spec), spec: v.spec } : v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos)
});

const commentGutter = gutter({ class: 'cm-comment-gutter', markers: (v) => v.state.field(commentsField).marks });

/** The "Comment" button at the end of a selection. */
function tooltipFor(state: EditorState, onComment: (v: EditorView) => void): Tooltip | null {
  const s = state.selection.main;
  if (s.empty) return null;
  return {
    pos: s.head, above: s.head < s.anchor, arrow: false,
    create: (view) => {
      const dom = document.createElement('button');
      dom.type = 'button';
      dom.className = 'lc-tip';
      dom.title = t.comments.commentTip;
      dom.innerHTML = '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4.5h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9l-3.5 3v-3H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"/></svg>';
      dom.append(t.comments.comment);
      const kbd = document.createElement('span');
      kbd.className = 'lc-tip-kbd';
      kbd.textContent = keyLabel('⌘⌥C');
      dom.append(kbd);
      // Keeps the selection: the click must not move it before the box opens.
      dom.addEventListener('mousedown', (e) => e.preventDefault());
      dom.addEventListener('click', () => onComment(view));
      return { dom };
    }
  };
}

/** The selection is finished (see selection-settle.ts): its "Comment" button may show. */
const selectionSettled = StateEffect.define<null>();

/**
 * The user event of a selection made for the user rather than by them (a Find in Files result's match): it counts as
 * settled, with no "Comment" button until the user changes it.
 */
export const RESULT_SELECT = 'select.result';

/** Tells the view when its selection is finished: on mouse up after a drag, on Shift up, or after a quiet moment. */
const settleSelection = ViewPlugin.fromClass(class {
  readonly settle: SelectionSettle;
  readonly down = (e: MouseEvent) => {
    // A press in the button itself or in a comment box is not a selection.
    if (e.button === 0 && !(e.target instanceof Element && e.target.closest('.cm-tooltip, .lc-widget'))) this.settle.pointerDown();
  };
  readonly up = () => this.settle.pointerUp();
  readonly keyUp = (e: KeyboardEvent) => this.settle.keyUp(e.key);
  constructor(readonly view: EditorView) {
    // Nothing selected: no button to show, no transaction (an idle one after a reload or a click is just noise).
    this.settle = selectionSettle(() => { if (!view.state.selection.main.empty) view.dispatch({ effects: selectionSettled.of(null) }); });
    // Before the editor's own handler (which selects on mouse down); the release after the editor's (which may
    // select one last time), wherever the pointer is by then.
    view.dom.addEventListener('mousedown', this.down, true);
    this.win.addEventListener('mouseup', this.up);
    view.dom.addEventListener('keyup', this.keyUp);
  }
  get win() { return this.view.dom.ownerDocument.defaultView ?? window; }
  update(u: ViewUpdate) {
    if (u.transactions.some((tr) => tr.isUserEvent(RESULT_SELECT))) this.settle.reset();
    else if (u.docChanged || !u.state.selection.main.eq(u.startState.selection.main)) this.settle.selectionChanged();
  }
  destroy() {
    this.settle.dispose();
    this.view.dom.removeEventListener('mousedown', this.down, true);
    this.win.removeEventListener('mouseup', this.up);
    this.view.dom.removeEventListener('keyup', this.keyUp);
  }
});

/** Everything a view needs for comments; `onComment` opens the box for the selection (also from ⌘⌥C). */
export function commentExtensions(onComment: (v: EditorView) => void) {
  // The button shows once the selection is finished, never while it is being made (it used to follow every step).
  const tip = StateField.define<{ settled: boolean; tip: Tooltip | null }>({
    create: (state) => ({ settled: true, tip: tooltipFor(state, onComment) }),
    update: (v, tr) => {
      if (tr.effects.some((e) => e.is(selectionSettled))) return { settled: true, tip: tooltipFor(tr.state, onComment) };
      if (tr.isUserEvent(RESULT_SELECT)) return { settled: true, tip: null };
      // A transaction that sets the same selection again (the editor reading back the DOM's) changes nothing.
      const moved = tr.docChanged || (!!tr.selection && !tr.state.selection.main.eq(tr.startState.selection.main));
      if (moved) return v.settled || v.tip ? { settled: false, tip: null } : v;
      return v;
    },
    provide: (f) => showTooltip.from(f, (v) => v.tip)
  });
  return [commentsField, commentGutter, tip, settleSelection];
}

export interface CommentSource {
  path: string;
  /** The diff rows shown (null: the document is the file itself). */
  rows: () => Row[] | null;
  /** The file's current text, to tell outdated comments (null: unknown). */
  text: () => string | null;
}

/** Keeps a view's comments in step with the store; refresh() after the file's text changed. */
export function bindComments(view: EditorView, src: CommentSource): { refresh: () => void; dispose: () => void } {
  let alive = true;
  const apply = () => {
    if (!alive) return;
    const st = useApp.getState();
    const rows = src.rows();
    const text = src.text();
    const lines = view.state.doc.lines;
    const comments = st.comments.filter((c) => c.path === src.path).flatMap((c) => {
      const after = docLineOf(rows, c.end, lines);
      if (after === null) return [];
      return [{ id: c.id, after, from: docLineOf(rows, c.start, lines) ?? after, outdated: isOutdated(c, text) }];
    });
    const d = st.commentDraft;
    const after = d && d.path === src.path ? docLineOf(rows, d.end, lines) : null;
    view.dispatch({ effects: setCommentDecos.of({ comments, draft: d && after !== null ? { after, nonce: d.nonce } : null }) });
  };
  apply();
  // Typing in the box changes the draft's text only: no new placement for that.
  const where = (d: CommentDraft | null) => (d ? `${d.nonce}|${d.path}|${d.end}` : '');
  const off = useApp.subscribe((s, p) => { if (s.comments !== p.comments || where(s.commentDraft) !== where(p.commentDraft)) apply(); });
  return { refresh: apply, dispose: () => { alive = false; off(); } };
}

/** Opens the comment box under the view's selection (false: nothing selected that maps to the file's lines). */
export function openDraftFrom(view: EditorView, src: CommentSource): boolean {
  const s = view.state.selection.main;
  const sel = selectionLines(view.state.doc, s.from, s.to);
  const range = sel ? newLineRange(src.rows(), sel.start, sel.end) : null;
  if (!range) return false;
  openDraftForLines(src.path, range, src.text());
  // The box takes the keyboard; the selection goes away so its button doesn't stay on top of the box.
  view.dispatch({ selection: { anchor: s.head } });
  return true;
}

/** Opens the comment box for file lines (also from the Markdown preview, whose selection maps to source lines). */
export function openDraftForLines(path: string, range: { start: number; end: number }, text: string | null): void {
  const st = useApp.getState();
  const { target, ambiguous } = defaultTarget(path, st.attributions, st.terminals, st.lastSession);
  st.openCommentDraft({ path, start: range.start, end: range.end, snippet: (text !== null ? snippetOf(text, range.start, range.end) : null) ?? '', target, ambiguous });
}
