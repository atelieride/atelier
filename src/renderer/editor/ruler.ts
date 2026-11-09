// The editor's overview ruler: a strip at the editor's right edge in place of the
// vertical scrollbar — the visible part (a thumb to drag), the changes, Find's matches while its card is open, the
// cursor. A click on a change goes there; a click elsewhere centers that point; a press moved drags the thumb, wherever
// it started (a change included). Geometry and words in ruler-model.ts.
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { getSearchQuery, searchPanelOpen } from '@codemirror/search';
import { matchList, tickPositions } from './find/find-logic';
import { changeBlocks, dragScroll, markTip, placeMarks, pressMoved, releaseMissed, scrollFor, thumbOf, type LineChange } from './ruler-model';
import { setGitMarks, setTargetLine } from './decorations';

export interface RulerSource {
  /** The document's changed lines (none: a file with nothing to compare, a revision). */
  changes(state: EditorState): LineChange[];
  /** A document line's number in the file, for a mark's tooltip; null when it has none (the Diff view's removed rows). */
  fileLine?(line: number): number | null;
}

const NO_CHANGES: RulerSource = { changes: () => [] };

/**
 * A press on the track. `mark`: the change it landed on, while it may still be a click there (null once it drags);
 * `center`: the track point beside the thumb it landed on, brought to the middle when it starts dragging.
 */
interface Press { id: number; y0: number; s0: number; mark: number | null; center: number | null }

export function overviewRuler(source: RulerSource = NO_CHANGES): Extension {
  const plugin = ViewPlugin.fromClass(class {
    private readonly dom = document.createElement('div');
    private readonly thumb = document.createElement('div');
    private readonly marks = document.createElement('div');
    private readonly finds = document.createElement('div');
    private readonly cursor = document.createElement('div');
    private frame = 0;
    /** A full draw is waiting for its frame. */
    private full = false;
    private thumbFrame = 0;
    private drag: Press | null = null;

    constructor(readonly view: EditorView) {
      this.dom.className = 'cm-ruler';
      this.dom.setAttribute('aria-hidden', 'true');
      this.thumb.className = 'cm-ruler-thumb';
      this.cursor.className = 'cm-ruler-cursor';
      this.dom.append(this.thumb, this.marks, this.finds, this.cursor);
      view.dom.appendChild(this.dom);
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
      this.dom.addEventListener('wheel', this.onWheel, { passive: false });
      this.dom.addEventListener('pointerdown', this.onDown);
      this.dom.addEventListener('pointermove', this.onMove);
      this.dom.addEventListener('pointerup', this.onUp);
      this.dom.addEventListener('pointercancel', this.onUp);
      // The capture gone without a release (the editor left the page mid-drag): nothing is held any more.
      this.dom.addEventListener('lostpointercapture', this.onLost);
      this.schedule();
    }

    update(u: ViewUpdate) {
      // The changes move with the text, its heights, the git marks; Find's ticks with its query; the cursor alone (and
      // which match is the selected one) with the selection: an arrow key never rebuilds the marks.
      if (u.docChanged || u.geometryChanged || u.heightChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(setGitMarks)))
        || getSearchQuery(u.state) !== getSearchQuery(u.startState) || searchPanelOpen(u.state) !== searchPanelOpen(u.startState)) this.schedule();
      else if (u.selectionSet) this.scheduleLight();
    }

    destroy() {
      cancelAnimationFrame(this.frame);
      cancelAnimationFrame(this.thumbFrame);
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
      this.dom.remove();
    }

    private schedule() {
      cancelAnimationFrame(this.frame);
      this.full = true;
      this.frame = requestAnimationFrame(() => this.draw());
    }

    /** The cursor and Find's ticks only (a full draw already waiting covers them). */
    private scheduleLight() {
      if (this.full) return;
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => { this.drawFinds(); this.drawCursor(); });
    }

    private readonly onScroll = () => {
      cancelAnimationFrame(this.thumbFrame);
      this.thumbFrame = requestAnimationFrame(() => this.drawThumb());
    };

    /** The strip sits outside the scroller: the wheel over it still moves the code. */
    private readonly onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      const v = this.view;
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? v.defaultLineHeight : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? v.scrollDOM.clientHeight : 1;
      v.scrollDOM.scrollBy({ top: e.deltaY * unit, left: e.deltaX * unit });
      e.preventDefault();
    };

    private readonly onDown = (e: PointerEvent) => {
      // ⌃-click is the context menu on macOS: its release goes to the menu.
      if (e.button !== 0 || e.ctrlKey) return;
      e.preventDefault();
      const s = this.view.scrollDOM;
      const y = e.clientY - this.dom.getBoundingClientRect().top;
      const mark = (e.target as Element | null)?.closest<HTMLElement>('.cm-ruler-mark');
      const th = thumbOf(s.scrollTop, s.clientHeight, s.scrollHeight, s.clientHeight);
      if (!mark && !th) return;
      this.drag = { id: e.pointerId, y0: e.clientY, s0: s.scrollTop, mark: mark ? Number(mark.dataset.line) : null, center: th && (y < th.y || y > th.y + th.h) ? y : null };
      this.dom.setPointerCapture?.(e.pointerId);
      // On a change the press waits: released in place it goes there, moved it drags like a press anywhere else (the
      // thumb often covers changes). Elsewhere it drags at once.
      if (!mark) this.grab(this.drag);
    };

    /** The press drags from here; beside the thumb, that point comes to the middle first. */
    private grab(d: Press) {
      const s = this.view.scrollDOM;
      if (d.center !== null) s.scrollTop = scrollFor(d.center, s.clientHeight, s.clientHeight, s.scrollHeight);
      d.s0 = s.scrollTop;
      d.mark = null;
      d.center = null;
      this.dom.classList.add('is-dragging');
    }

    private readonly onMove = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      const w = this.dom.ownerDocument.defaultView ?? window;
      // The button is already up: its release went elsewhere, the thumb mustn't follow the pointer.
      if (releaseMissed(e.buttons, { x: e.clientX, y: e.clientY }, { width: w.innerWidth, height: w.innerHeight })) { this.end(); return; }
      const s = this.view.scrollDOM;
      if (d.mark !== null) {
        if (!pressMoved(e.clientY - d.y0)) return;
        // Everything fits: nothing to drag, and no click on the change any more.
        if (!thumbOf(s.scrollTop, s.clientHeight, s.scrollHeight, s.clientHeight)) { this.end(); return; }
        this.grab(d);
      }
      s.scrollTop = dragScroll(d.s0, e.clientY - d.y0, s.clientHeight, s.clientHeight, s.scrollHeight);
    };

    private readonly onUp = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      this.end();
      if (e.type === 'pointerup' && d.mark !== null) this.goTo(d.mark);
    };

    private readonly onLost = () => this.end();

    private end() {
      this.drag = null;
      this.dom.classList.remove('is-dragging');
    }

    /** A change's mark: the cursor to its first line, centered and lit, as Next Change does. */
    private goTo(line: number) {
      const v = this.view;
      if (!Number.isInteger(line) || line < 1 || line > v.state.doc.lines) return;
      const pos = v.state.doc.line(line).from;
      // Focus first: an editor gaining focus later reads the page's selection back and would undo the move.
      v.focus();
      v.dispatch({ selection: { anchor: pos }, effects: [setTargetLine.of(line), EditorView.scrollIntoView(pos, { y: 'center' })] });
    }

    private lineBlock(line: number) {
      const doc = this.view.state.doc;
      return this.view.lineBlockAt(doc.line(Math.max(1, Math.min(line, doc.lines))).from);
    }
    private lineTop(line: number): number { return this.lineBlock(line).top; }
    /** Its block's bottom: a wrapped line counts whole. */
    private lineBottom(line: number): number { return this.lineBlock(line).bottom; }

    private drawThumb() {
      const s = this.view.scrollDOM;
      const th = thumbOf(s.scrollTop, s.clientHeight, s.scrollHeight, s.clientHeight);
      this.thumb.hidden = !th;
      if (th) { this.thumb.style.top = `${th.y}px`; this.thumb.style.height = `${th.h}px`; }
    }

    private draw() {
      this.full = false;
      const v = this.view;
      const s = v.scrollDOM;
      const track = s.clientHeight;
      const content = Math.max(v.contentHeight, 1);
      // Down to the scroller's bottom edge, its horizontal scrollbar included (no hole in the corner); the marks map
      // onto the part the code shows.
      this.dom.style.top = `${s.offsetTop}px`;
      this.dom.style.height = `${s.offsetHeight}px`;
      this.drawThumb();

      const placed = placeMarks(changeBlocks(source.changes(v.state)), (l) => this.lineTop(l), (l) => this.lineBottom(l), content, track);
      this.marks.replaceChildren(...placed.map((m) => {
        const el = document.createElement('i');
        el.className = `cm-ruler-mark is-${m.kind}`;
        el.style.top = `${m.y}px`;
        el.style.height = `${m.h}px`;
        el.dataset.line = String(m.first);
        const a = source.fileLine ? source.fileLine(m.first) : m.first;
        const b = source.fileLine ? source.fileLine(m.last) : m.last;
        el.dataset.tip = markTip(m.kind, m.n, a !== null && b !== null ? [a, b] : null);
        return el;
      }));
      this.drawFinds();
      this.drawCursor();
    }

    /** Find's matches, one tick per line, while its card is open (the selected one brighter). */
    private drawFinds() {
      const v = this.view;
      const track = v.scrollDOM.clientHeight;
      const content = Math.max(v.contentHeight, 1);
      const q = getSearchQuery(v.state);
      if (!searchPanelOpen(v.state) || !q.search || !q.valid) this.finds.replaceChildren();
      else {
        const sel = v.state.selection.main;
        const lines: { top: number; selected: boolean }[] = [];
        let lastLine = -1;
        // The find card's cached list: scrolling and moving the cursor only re-place the ticks.
        for (const r of matchList(v.state, q).ranges) {
          const block = v.lineBlockAt(r.from);
          const selected = r.from === sel.from && r.to === sel.to;
          if (block.from === lastLine) { if (selected) lines[lines.length - 1]!.selected = true; continue; }
          lastLine = block.from;
          lines.push({ top: block.top, selected });
        }
        this.finds.replaceChildren(...tickPositions(lines, content, track).map((tk) => {
          const el = document.createElement('i');
          el.className = tk.selected ? 'cm-ruler-find is-selected' : 'cm-ruler-find';
          el.style.top = `${tk.y}px`;
          return el;
        }));
      }
    }

    private drawCursor() {
      const v = this.view;
      const track = v.scrollDOM.clientHeight;
      const head = v.state.doc.lineAt(v.state.selection.main.head).number;
      this.cursor.style.top = `${Math.min(track - 2, (this.lineTop(head) * track) / Math.max(v.contentHeight, 1))}px`;
    }
  });
  return [plugin, EditorView.editorAttributes.of({ class: 'has-ruler' })];
}
