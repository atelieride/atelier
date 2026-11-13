// Sidebar rows dragged into your own order: the row being dragged and where it would land (the caret), shared by the
// rows (they draw both) and the lists (they take the drop). A row's data is not readable before the drop, so the
// dragged id lives here, as the Shelf keeps its own.
import { useRef, type DragEvent, type RefObject } from 'react';
import { create } from 'zustand';
import { useApp } from './store';
import { bandWith, landingAt, moveInBand, type Band } from './row-order';

/** A row dragged for a reorder carries its id under this type (types are all a drag over shows). */
export const REORDER_MIME = 'application/x-atelier-row-order';

/** The caret: a line above row `id`, or below it when it is its band's last row and the drop goes after it. */
export interface Caret { id: string; edge: 'before' | 'after' }

interface ReorderDrag {
  dragging: string | null;
  caret: Caret | null;
  start(id: string): void;
  show(caret: Caret | null): void;
  end(): void;
}

export const useReorder = create<ReorderDrag>((set, get) => ({
  dragging: null,
  caret: null,
  start: (dragging) => set({ dragging, caret: null }),
  show: (caret) => {
    const now = get().caret;
    if (now === caret || (now && caret && now.id === caret.id && now.edge === caret.edge)) return;
    set({ caret });
  },
  end: () => set({ dragging: null, caret: null })
}));

/**
 * A reorder drag starting from `row`. Its end is caught on the row element itself: `dragend` goes to the element the drag
 * started from even once React has moved it to another place's list or stopped handing it a handler (its band gone
 * mid-drag), so the dragged row never stays dimmed.
 */
export function startReorder(id: string, row: HTMLElement): void {
  useReorder.getState().start(id);
  row.addEventListener('dragend', () => useReorder.getState().end(), { once: true });
}

/** What a drag at this point would do: a move (band, row, where), no move here (null), or nothing of this list's. */
type Landing = { band: Band; id: string; before: string | null } | null | undefined;

/**
 * A list's drop handlers for its bands. Over the dragged row's own band: a caret where it would land (none where it
 * would stay put) and a "move" cursor; anywhere else nothing, so the places around (another workspace's rows, an
 * activity) keep their own drop. The band is looked up again at every event: a row that changed section or closed
 * mid-drag has no band here any more and its drop does nothing.
 */
export function useReorderDrop(bands: Band[]): {
  ref: RefObject<HTMLDivElement | null>;
  handlers: { onDragOver: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void; onDrop: (e: DragEvent) => void };
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const landing = (e: DragEvent): Landing => {
    if (!e.dataTransfer.types.includes(REORDER_MIME)) return undefined;
    const id = useReorder.getState().dragging;
    const band = bandWith(bands, id);
    const box = ref.current;
    if (!band || !id || !box) return undefined;
    const rows = band.ids.flatMap((x) => {
      const el = box.querySelector<HTMLElement>(`[data-term-row="${CSS.escape(x)}"]`);
      if (!el) return [];
      const r = el.getBoundingClientRect();
      return [{ id: x, top: r.top, height: r.height }];
    });
    const at = landingAt(rows, e.clientY);
    if (!at) return undefined;
    return moveInBand(band.ids, id, at.before) ? { band, id, before: at.before } : null;
  };
  const caretOf = (l: { band: Band; before: string | null }): Caret =>
    (l.before !== null ? { id: l.before, edge: 'before' } : { id: l.band.ids.at(-1)!, edge: 'after' });
  return {
    ref,
    handlers: {
      onDragOver: (e) => {
        const l = landing(e);
        if (l === undefined) { if (e.dataTransfer.types.includes(REORDER_MIME)) useReorder.getState().show(null); return; }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        useReorder.getState().show(l ? caretOf(l) : null);
      },
      // Moving from one row onto another (or onto a row's buttons) is no leaving: the caret would flicker.
      onDragLeave: (e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        useReorder.getState().show(null);
      },
      onDrop: (e) => {
        const l = landing(e);
        if (l === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        if (l) useApp.getState().reorderRow(l.band, l.id, l.before);
        useReorder.getState().end();
      }
    }
  };
}
