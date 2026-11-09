// JSON navigation: the editor side of a JSON tab — folding from the tolerant scan (a
// chevron column, a "3 keys" pill for folded blocks, ⌥⌘[ ⌥⌘] ⌃⌥[ ⌃⌥]), the path and type under the cursor, and the
// parse error: a wave under it, a rose dot in the column and a card with the quick fix while the cursor is on its line.
import { ChangeSet, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter, keymap, showTooltip, type DecorationSet, type Tooltip, type ViewUpdate } from '@codemirror/view';
import { codeFolding, foldCode, foldEffect, foldService, foldable, foldedRanges, unfoldAll, unfoldCode, unfoldEffect } from '@codemirror/language';
import { containerAt, foldAt, levelContainers, mapScan, pathAt, scanJson, valueAt, type Scan, type Segment } from '../json/scan';
import { entriesLabel, type TypeInfo } from '../json/paths';
import type { JsonError } from '../json/parse';
import { t } from '../i18n/en';
import { kbd } from '../kbd';

/** Up to this size the scan runs on every edit; above, once typing pauses. */
const SYNC_LIMIT = 512 * 1024;
const IDLE_MS = 300;

export const setScan = StateEffect.define<Scan>();

/** fresh: scanned from the text as it is; otherwise the last scan moved through the edits since (large documents). */
export const scanField = StateField.define<{ scan: Scan | null; fresh: boolean }>({
  create: (s) => (s.doc.length <= SYNC_LIMIT ? { scan: scanJson(s.doc.toString()), fresh: true } : { scan: null, fresh: false }),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setScan)) return { scan: e.value, fresh: true };
    if (!tr.docChanged) return v;
    if (tr.state.doc.length <= SYNC_LIMIT) return { scan: scanJson(tr.state.doc.toString()), fresh: true };
    if (!v.scan) return v;
    // Offsets before the first change stay; the rest follow the edit until the idle scan replaces it all.
    let first = Infinity;
    tr.changes.iterChangedRanges((fromA) => { first = Math.min(first, fromA); });
    // Offsets name characters: one at the insertion point moves with what follows (assoc 1).
    return { scan: mapScan(v.scan, (p) => (p < first ? p : tr.changes.mapPos(p, 1))), fresh: false };
  }
});

/** Large documents: the scan once typing pauses. */
const idleScan = ViewPlugin.fromClass(class {
  timer: ReturnType<typeof setTimeout> | null = null;
  constructor(readonly view: EditorView) { this.schedule(); }
  update(u: ViewUpdate) { if (u.docChanged) this.schedule(); }
  schedule() {
    if (this.timer) clearTimeout(this.timer);
    if (this.view.state.field(scanField).fresh) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const doc = this.view.state.doc;
      const scan = scanJson(doc.toString());
      if (this.view.state.doc === doc) this.view.dispatch({ effects: setScan.of(scan) });
    }, IDLE_MS);
  }
  destroy() { if (this.timer) clearTimeout(this.timer); }
});

const scanOf = (s: EditorState): Scan | null => s.field(scanField, false)?.scan ?? null;

/** The fold of a line, with what it hides (for the pill). */
function foldInfo(s: EditorState, lineFrom: number, lineTo: number) {
  const scan = scanOf(s);
  return scan ? foldAt(scan, lineFrom, lineTo) : null;
}

/** Folds of the blocks at a depth (1: the root's children) that span lines. */
export function foldLevelEffects(s: EditorState, level: number): StateEffect<{ from: number; to: number }>[] {
  const scan = scanOf(s);
  if (!scan) return [];
  return levelContainers(scan, level)
    .filter((c) => c.close > c.open && s.doc.lineAt(c.open).number < s.doc.lineAt(c.close).number)
    .map((c) => foldEffect.of({ from: c.open + 1, to: c.close }));
}

/** Fold to a level: everything open first, then the blocks at that depth. */
export function foldLevel(view: EditorView, level: number): boolean {
  const effects: StateEffect<unknown>[] = [];
  foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => { effects.push(unfoldEffect.of({ from, to })); });
  effects.push(...foldLevelEffects(view.state, level));
  view.dispatch({ effects });
  return true;
}

export interface CursorInfo { path: Segment[]; start: number | null; info: TypeInfo | null }

/** The path under `pos`, where its entry starts and its type (null while the scan of a large document waits). */
export function cursorInfo(s: EditorState, pos: number): CursorInfo | null {
  const scan = scanOf(s);
  if (!scan) return null;
  const { path, start } = pathAt(scan, pos);
  const box = containerAt(scan, path);
  if (box) return { path, start, info: { type: box.kind, count: box.count } };
  if (start === null) return { path, start, info: null };
  const member = typeof path.at(-1) === 'string';
  // A small window first; a string longer than it gets a larger one (the cursor moves often, long strings are rare).
  for (let size = 4096; ; size *= 8) {
    const end = Math.min(s.doc.length, start + size);
    const v = valueAt(s.doc.sliceString(start, end), 0, member);
    if (v?.type !== 'string' || v.length !== undefined || end === s.doc.length) return { path, start, info: v };
  }
}

// The parse error (from the worker), kept in place while the user types until the next parse replaces it.
export const setJsonError = StateEffect.define<JsonError | null>();
export const errorField = StateField.define<JsonError | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setJsonError)) return e.value;
    if (!v || !tr.docChanged) return v;
    const from = tr.changes.mapPos(v.from, 1);
    const fix = v.fix && { ...v.fix, from: tr.changes.mapPos(v.fix.from, 1), to: Math.max(tr.changes.mapPos(v.fix.from, 1), tr.changes.mapPos(v.fix.to, -1)) };
    return { ...v, from, to: Math.max(from, tr.changes.mapPos(v.to, -1)), ...(fix ? { fix } : {}) };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (e): DecorationSet => (e && e.to > e.from ? Decoration.set([Decoration.mark({ class: 'cm-json-error' }).range(e.from, e.to)]) : Decoration.none)),
    showTooltip.compute([f, 'selection'], (s): Tooltip | null => {
      const e = s.field(f);
      if (!e) return null;
      const at = Math.min(e.from, s.doc.length);
      if (s.doc.lineAt(s.selection.main.head).number !== s.doc.lineAt(at).number) return null;
      return { pos: at, above: false, create: (view) => ({ dom: errorCard(view, e) }) };
    })
  ]
});

// The edits since the text the tree was last parsed from: while the JSON is invalid the tree shows that older text, and
// its offsets reach the editor through this (Show in Source, Split's pick, ⌘L).
export const markParsed = StateEffect.define<null>();
const sinceParseField = StateField.define<ChangeSet>({
  create: (s) => ChangeSet.empty(s.doc.length),
  update(v, tr) {
    if (tr.effects.some((e) => e.is(markParsed))) return ChangeSet.empty(tr.state.doc.length);
    return tr.docChanged ? v.compose(tr.changes) : v;
  }
});

/** An offset of the last valid parse, on the text as it is now. */
export const fromParse = (s: EditorState, pos: number): number => {
  const c = s.field(sinceParseField, false);
  return c ? c.mapPos(Math.min(pos, c.length)) : Math.min(pos, s.doc.length);
};

const lowerFirst = (m: string) => m.charAt(0).toLowerCase() + m.slice(1);

function errorCard(view: EditorView, e: JsonError): HTMLElement {
  const card = document.createElement('div');
  card.className = 'cm-json-card';
  card.setAttribute('role', 'note');
  const text = document.createElement('span');
  const b = document.createElement('b');
  b.textContent = t.json.notValid;
  text.append(b, ` ${lowerFirst(e.message)} (${t.json.at(e.line, e.col)}).`);
  card.append(text);
  const fix = e.fix;
  if (fix) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-json-fix';
    btn.textContent = fix.label;
    btn.addEventListener('mousedown', (ev) => ev.preventDefault());
    btn.addEventListener('click', () => {
      view.dispatch({ changes: { from: fix.from, to: fix.to, insert: fix.insert }, effects: setJsonError.of(null) });
      view.focus();
    });
    card.append(btn);
  }
  return card;
}

const CHEVRON = 'M8 5l5 5-5 5';

class FoldMarker extends GutterMarker {
  constructor(readonly folded: boolean) { super(); }
  eq(o: FoldMarker) { return o.folded === this.folded; }
  toDOM() {
    const el = document.createElement('span');
    el.className = `cm-json-chev ${this.folded ? 'is-folded' : 'is-open'}`;
    el.title = this.folded ? `${t.json.unfold} · ${kbd('⌥⌘]')}` : `${t.json.fold} · ${kbd('⌥⌘[')}`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('width', '11');
    svg.setAttribute('height', '11');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', CHEVRON);
    svg.append(p);
    el.append(svg);
    return el;
  }
}

class ErrorMarker extends GutterMarker {
  eq() { return true; }
  toDOM() { const el = document.createElement('span'); el.className = 'cm-json-errdot'; return el; }
}

const OPEN = new FoldMarker(false);
const FOLDED = new FoldMarker(true);
const ERROR = new ErrorMarker();

/** The folded range starting on a line, if any. */
function foldedOn(s: EditorState, from: number, to: number): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  foldedRanges(s).between(from, to, (a, b) => { if (a >= from && a <= to) { found = { from: a, to: b }; return false; } return undefined; });
  return found;
}

/** One column right of the line numbers: the error's dot, or the line's fold chevron. */
const jsonGutter = gutter({
  class: 'cm-json-gutter',
  lineMarker(view, line) {
    const e = view.state.field(errorField);
    if (e && view.state.doc.lineAt(Math.min(e.from, view.state.doc.length)).from === line.from) return ERROR;
    const first = view.state.doc.lineAt(line.from);
    if (foldedOn(view.state, first.from, first.to)) return FOLDED;
    return foldable(view.state, first.from, first.to) ? OPEN : null;
  },
  lineMarkerChange: (u) => u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect) || e.is(setScan) || e.is(setJsonError))),
  initialSpacer: () => OPEN,
  domEventHandlers: {
    click(view, line) {
      const first = view.state.doc.lineAt(line.from);
      const f = foldedOn(view.state, first.from, first.to);
      if (f) { view.dispatch({ effects: unfoldEffect.of(f) }); return true; }
      const r = foldable(view.state, first.from, first.to);
      if (r) { view.dispatch({ effects: foldEffect.of(r) }); return true; }
      return false;
    }
  }
});

const jsonTheme = EditorView.theme({
  '.cm-json-gutter': { width: '18px' },
  '.cm-json-gutter .cm-gutterElement': { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0', cursor: 'pointer' },
  '.cm-json-chev': { width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px', color: 'var(--text-4)', opacity: '0', transition: 'opacity var(--t-fast) var(--ease), color var(--t-fast) var(--ease), background-color var(--t-fast) var(--ease)' },
  '.cm-json-chev svg': { fill: 'none', stroke: 'currentColor', strokeWidth: '2.2', strokeLinecap: 'round', strokeLinejoin: 'round', transition: 'transform var(--t-med) var(--ease)' },
  '.cm-json-chev.is-open svg': { transform: 'rotate(90deg)' },
  '&:hover .cm-json-chev': { opacity: '0.7' },
  '.cm-json-chev:hover': { opacity: '1 !important', color: 'var(--text)', backgroundColor: 'var(--bg-3)' },
  '.cm-json-chev.is-folded': { opacity: '1', color: 'var(--fold)' },
  '.cm-json-errdot': { width: '7px', height: '7px', borderRadius: '50%', backgroundColor: 'var(--error)' },
  '.cm-json-error': { textDecoration: 'underline wavy var(--error)', textUnderlineOffset: '4px', textDecorationThickness: '1.5px' },
  '.cm-json-fold-ph': { display: 'inline-flex', alignItems: 'center', height: '16px', margin: '0 4px', padding: '0 8px', borderRadius: '999px', verticalAlign: '1px', background: 'var(--tint-violet)', border: '1px solid var(--edge-violet-soft)', color: 'var(--fold)', font: '10.5px var(--mono)', lineHeight: '1', cursor: 'pointer', transition: 'box-shadow var(--t-fast) var(--ease), background-color var(--t-fast) var(--ease)' },
  '.cm-json-fold-ph:hover': { background: 'var(--tint-violet-hover)', boxShadow: 'inset 0 0 0 1px var(--edge-violet)' },
  '.cm-json-card': { display: 'flex', flexDirection: 'column', gap: '6px', width: '330px', marginTop: '4px', padding: '10px 12px', borderRadius: 'var(--radius)', background: 'var(--bg-float-strong)', backdropFilter: 'blur(14px)', boxShadow: 'var(--shadow-float), 0 0 0 1px var(--edge-error)', font: '12px/1.4 var(--font)', color: 'var(--text-2)', whiteSpace: 'normal', animation: 'atl-pop var(--t-med) var(--ease) both' },
  '.cm-json-card b': { color: 'var(--text-error)', fontWeight: '600' },
  '.cm-json-fix': { alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', height: '22px', padding: '0 9px', border: 'none', borderRadius: 'var(--r-sm)', background: 'var(--tint-error-strong)', color: 'var(--text-error)', font: '11.5px var(--font)', cursor: 'pointer' },
  '.cm-json-fix:hover': { background: 'var(--tint-error-hover)' },
  '.cm-json-fix:focus-visible': { outline: 'none', boxShadow: '0 0 0 1.5px var(--violet)' }
});

/** Everything a JSON tab's editor adds (none of it for other languages). */
export function jsonEditorExtensions(): Extension {
  return [
    scanField,
    idleScan,
    errorField,
    sinceParseField,
    foldService.of((s, from, to) => {
      const f = foldInfo(s, from, to);
      return f ? { from: f.from, to: f.to } : null;
    }),
    codeFolding({
      preparePlaceholder: (s, range) => {
        const line = s.doc.lineAt(range.from - 1);
        const f = foldInfo(s, line.from, line.to);
        return f && f.from === range.from ? entriesLabel(f.count, f.kind) : '…';
      },
      placeholderDOM: (_view, onclick, prepared: string) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'cm-json-fold-ph';
        el.textContent = prepared;
        el.title = `${t.json.unfold} · ${kbd('⌥⌘]')}`;
        el.addEventListener('click', onclick);
        return el;
      }
    }),
    jsonGutter,
    keymap.of([
      { key: 'Mod-Alt-[', run: foldCode },
      { key: 'Mod-Alt-]', run: unfoldCode },
      { key: 'Ctrl-Alt-[', run: (v) => foldLevel(v, 1) },
      { key: 'Ctrl-Alt-]', run: unfoldAll }
    ]),
    jsonTheme
  ];
}
