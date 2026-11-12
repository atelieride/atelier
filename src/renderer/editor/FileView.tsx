import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { gotoLine, highlightSelectionMatches, selectNextOccurrence } from '@codemirror/search';
import { findExtensions, openFind, registerFindTarget } from './find/find-ext';
import { altGrTyping, defaultKeys, searchKeys } from './editor-keys';
import { wordWrapKeys } from './word-wrap';
import { isLargeText, MAX_LARGE_FILE_BYTES, type FileContent, type Stamp } from '@shared/files';
import { hasGrammar, languageLabel } from '@shared/languages';
import { effectiveLanguage } from '../lang-overrides';
import { cmTheme } from './cmTheme';
import { diffExtensions, diffRulerSource, gitGutter, gitMarkLines, gitMarksField, setGitMarks, setTargetLine, setTokens, targetField, tokenField } from './decorations';
import { overviewRuler } from './ruler';
import { cancelHighlight, highlight } from './highlighter';
import { gutterMarks, minimalChange, unifiedDoc } from './linediff';
import { commentTokens, detectEol, detectIndent, hasMixedEol } from './indent';
import { normalizeEol, onDiskChange, reloadSpec, saveGate, unsaved } from './conflict';
import { registerSaver } from './savers';
import { hasHandoff, moveGuard, snapshotEditor, stateFromHandoff, takeHandoff } from './handoff';
import { ConflictCompare } from './ConflictCompare';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { baselineFor } from '../baseline';
import { FileIcon } from '../components/FileIcon';
import { t } from '../i18n/en';
import { forgetFound, useApp, type OpenFile } from '../store';
import { editorMenu, mentionInSession } from '../menus';
import { selectionLines } from '../mention';
import { isUntitled } from '../untitled';
import { crumbDirs, isExternal } from '../external';
import { bindComments, commentExtensions, openDraftForLines, openDraftFrom, type CommentSource } from './comments-ext';
import { registerCommentTarget } from '../comment-targets';
import { registerChangeTarget } from '../change-targets';
import { changePosition, diffChangedLines, runStarts, stepChange } from './change-nav';
import { Icon } from '../components/Icon';
import { copyText } from '../clipboard';
import type { DiffDoc } from './linediff';
import { MarkdownPreview, type PreviewHandle } from '../markdown/Preview';
import { toggledView, type MdView } from '../markdown-views';
import { radioNext } from '../radio';
import type { IconName } from '../components/Icon';
import type { LineRange } from '../mention';
import { unfoldAll } from '@codemirror/language';
import { cursorInfo, errorField, foldLevel, fromParse, jsonEditorExtensions, markParsed, scanField, setJsonError, type CursorInfo } from './json-ext';
import { JsonPane, type JsonDoc, type JsonPaneHandle, type PaneStatus } from '../json/JsonPane';
import { JsonPath } from '../json/JsonPath';
import { cancelParse, parseInWorker } from '../json/json-client';
import { formatPath, groupNumber, nodeInfo, utf8Length, type TypeInfo } from '../json/paths';
import { startOfPath, type Segment } from '../json/scan';
import { registerJsonTarget } from '../json-targets';
import { sizeLabel } from '../scm/detail';
import type { JsonNode } from '../json/parse';
import { kbd } from '../kbd';
import { csvEditorExtensions, cursorCell, fieldStart, setCsvConf, unquoteField, type CsvConf, type CursorCell } from './csv-ext';
import { CsvPane, type CsvDoc, type CsvPaneHandle, type CsvStatus } from '../csv/CsvPane';
import { CsvAddress, type CsvCrumb } from '../csv/CsvAddress';
import { cancelCsvParse, parseCsvInWorker, type CsvResult } from '../csv/csv-client';
import { address as csvAddress } from '../csv/format';
import { typeLabel as csvTypeLabel } from '../csv/labels';
import { registerCsvTarget } from '../csv-targets';
import { AUTO_OPTIONS } from '../csv/types';

type Conflict = { disk: string; stamp: Stamp };

/** The Markdown switch's options. */
const MD_VIEWS: readonly { view: MdView; icon: IconName; label: () => string; tip: () => string; kbd?: string }[] = [
  { view: 'source', icon: 'code', label: () => t.md.source, tip: () => t.md.sourceTip, kbd: kbd('⇧⌘V') },
  { view: 'split', icon: 'split', label: () => t.md.split, tip: () => t.md.splitTip },
  { view: 'preview', icon: 'eye', label: () => t.md.preview, tip: () => t.md.previewTip, kbd: kbd('⇧⌘V') }
];

/** A JSON tab's switch: the same three views, Tree in place of Preview. */
const JSON_VIEWS: typeof MD_VIEWS = [
  { view: 'source', icon: 'code', label: () => t.md.source, tip: () => t.md.sourceTip, kbd: kbd('⇧⌘V') },
  { view: 'split', icon: 'split', label: () => t.md.split, tip: () => t.json.splitTip },
  { view: 'preview', icon: 'tree', label: () => t.json.tree, tip: () => t.json.treeTip, kbd: kbd('⇧⌘V') }
];

/** A CSV tab's switch: the same three views, Table in place of Preview. */
const CSV_VIEWS: typeof MD_VIEWS = [
  { view: 'source', icon: 'code', label: () => t.md.source, tip: () => t.md.sourceTip, kbd: kbd('⇧⌘V') },
  { view: 'split', icon: 'split', label: () => t.md.split, tip: () => t.csv.splitTip },
  { view: 'preview', icon: 'table', label: () => t.csv.table, tip: () => t.csv.tableTip, kbd: kbd('⇧⌘V') }
];

const EMPTY_CSV: CsvDoc = { result: null, ms: 0, bytes: 0 };
const EMPTY_CSV_STATUS: CsvStatus = { crumb: null, position: null, totals: [], problems: 0 };

/** The editor's view of the last parse: options, widths for Align, the problem rows' lines. */
const csvConf = (r: CsvResult, s: { csvRainbow: boolean; csvAlign: boolean }): CsvConf => ({
  delimiter: r.resolved.delimiter, skip: r.resolved.skip, header: r.resolved.header, rainbow: s.csvRainbow, align: s.csvAlign,
  widths: r.profiles.map((p) => p.rawWidth), problemLines: r.data.problems.filter((p) => p.kind === 'fields').map((p) => p.line)
});

const EMPTY_JSON: JsonDoc = { root: null, nodes: 0, ms: 0, bytes: 0, error: null, empty: false };
const FLASH_MS = 1400;

/** ⌘/ comments with the language's syntax (none for plain text). */
const commentData = (lang: string | null): Extension => {
  const c = commentTokens(lang);
  return c ? EditorState.languageData.of(() => [{ commentTokens: c }]) : [];
};

/** Lines selected in the editor (null without a selection). */
const selLines = (v: EditorView) => selectionLines(v.state.doc, v.state.selection.main.from, v.state.selection.main.to);

/** focused / place: as TerminalView's (split view: only the focused pane's editor takes the keyboard; its grid cell). */
export function FileView({ file, visible, focused = visible, place }: { file: OpenFile; visible: boolean; focused?: boolean; place?: CSSProperties }) {
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const wrap = useRef(new Compartment());
  // Wrapping and text size from the settings: they apply immediately to already open files too.
  const wordWrap = useApp((s) => s.settings.wordWrap);
  const editorFont = useApp((s) => s.settings.editorFontSize);
  useEffect(() => { view.current?.dispatch({ effects: wrap.current.reconfigure(wordWrap ? EditorView.lineWrapping : []) }); }, [wordWrap]);
  useEffect(() => { view.current?.requestMeasure(); }, [editorFont]);
  const scroll = useRef(0);
  const targeted = useRef<number | null>(null);
  // A search result opened with the keyboard staying in the list: this open never moves the keyboard (the editor made,
  // the tab shown, the code view back) until the tab is hidden or its pane loses the focus (`released`).
  const released = useRef(0);
  const held = () => !!file.found?.keepFocus && released.current !== file.nonce;
  const [content, setContent] = useState<FileContent | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const [plain, setPlain] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [compare, setCompare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const dirty = useApp((s) => !!s.dirty[file.path]);
  const diskNonce = useApp((s) => s.diskNonce[file.path] ?? 0);
  const realRoot = useApp((s) => s.project?.realRoot ?? null);
  const setFileMode = useApp((s) => s.setFileMode);
  // The comparison base comes from the file's git state: clean or ignored → no marker.
  const baselineKey = useApp((s) => JSON.stringify(baselineFor(file.path, s.repos)));
  const baseline = useMemo(() => JSON.parse(baselineKey) as ReturnType<typeof baselineFor>, [baselineKey]);

  // Last known disk version (text normalized to LF, stamp, line ending): saving compares against it.
  const saved = useRef<string | null>(null);
  const stamp = useRef<Stamp | null>(null);
  const eol = useRef<'lf' | 'crlf'>('lf');

  // Content: on every open and when the file changes on disk.
  useEffect(() => {
    // An untitled tab has no file on disk: an empty text until "Save as".
    if (isUntitled(file.path)) { setContent({ kind: 'text', path: file.path, rel: file.rel, text: '', size: 0, mtimeMs: 0, hash: '' }); return; }
    let alive = true;
    // Open Anyway: up to 50 MB, from then on (a change on disk reads it the same way).
    void (file.large ? window.atelier.files.readLarge(file.path) : window.atelier.files.read(file.path))
      .then((c) => {
        if (!alive) return;
        // Gone from disk (even outside Atelier): it does not stay among the palette's recents.
        if (c.kind === 'missing') useApp.getState().forgetRecent(file.path);
        // Its tab's tooltip says "Claude temp" too.
        useApp.getState().setClaudeTemp(file.path, !!c.claudeTemp);
        // Same text: the same content, unless it became editable (picked again with Open File…) or read-only.
        setContent((prev) => (prev?.kind === 'text' && c.kind === 'text' && prev.hash === c.hash && prev.readOnly === c.readOnly && prev.readGrant === c.readGrant ? prev : c));
      })
      .catch(() => { if (alive) setContent({ kind: 'unreadable', path: file.path, rel: file.rel }); });
    return () => { alive = false; };
  }, [file.path, file.rel, file.nonce, file.large, diskNonce]);

  // Text past 5 MB opened anyway: plain and read-only — no colors, no marks against HEAD, no Preview/Tree/Table.
  // The size decides, not why it is read-only: a Latin-1 or UTF-16 log past 5 MB is large too.
  const large = isLargeText(content);
  // Version in HEAD: only if git says the file is modified; re-read when the commit changes.
  const headPath = baseline.kind === 'head' && !large ? baseline.headPath : null;
  const oid = baseline.kind === 'head' ? baseline.oid : null;
  useEffect(() => {
    let alive = true;
    if (!headPath) { setOriginal(null); return; }
    void window.atelier.git.head(headPath).then((h) => { if (alive) setOriginal(h.original === null ? null : normalizeEol(h.original)); }).catch(() => { if (alive) setOriginal(null); });
    return () => { alive = false; };
  }, [headPath, oid]);

  const text = content?.kind === 'text' ? normalizeEol(content.text) : null;
  // A tab moved here from another window: its buffer waits for this editor, which shows it in the
  // margin layout (the Diff view is read-only) even when the file is no longer on disk.
  // Only this FileView's first view takes one: a later rebuild (margin ↔ diff) never replaces the live buffer.
  const madeView = useRef(false);
  const incoming = !madeView.current && hasHandoff(file.path);
  // Once opened, the view stays alive even if the file disappears from disk or stops being text:
  // the user's changes are not lost (git stash/checkout delete and recreate files).
  const everText = useRef(false);
  if (text !== null || (incoming && content !== null)) everText.current = true;
  const gone = everText.current && content !== null && content.kind !== 'text' ? content.kind : null;
  const notUtf8 = content?.kind === 'text' && content.readOnly === 'not-utf8';
  const gitInternal = content?.kind === 'text' && content.readOnly === 'git-internal';
  // Opened from a terminal link into Claude's temp folder: Atelier may read it, never write or recreate it, whatever it
  // reads as now.
  const readGrant = !!content?.readGrant;
  const claudeTemp = !!content?.claudeTemp;
  const mixedEol = content?.kind === 'text' && !large && hasMixedEol(content.text);
  const base = large ? null : baseline.kind === 'new' ? '' : baseline.kind === 'head' ? original : null;
  const changed = (text !== null && base !== null && base !== text) || dirty;
  const mode = changed && !dirty && !incoming ? file.mode : 'margin';
  const diff = useMemo(() => (mode === 'diff' && text !== null && base !== null ? unifiedDoc(base, text) : null), [mode, text, base]);
  const tooBig = mode === 'diff' && changed && diff === null;
  // The language chosen for this tab (Change Language Mode) wins over the one its name says.
  const tabLang = useApp((s) => effectiveLanguage(file.path, s.langOverrides));
  const lang = large ? null : tabLang;
  const langRef = useRef(lang);
  langRef.current = lang;
  /** The language the view's colors were last asked for (a change asks again). */
  const hlLang = useRef<string | null>(null);
  const langConf = useRef(new Compartment());
  // JSON tabs: folding, the path under the cursor and the error marks; not in the Diff view.
  const jsonConf = useRef(new Compartment());
  // CSV tabs: rainbow columns, alignment, problem rows and the cell under the cursor.
  const csvConfC = useRef(new Compartment());
  const editable = !diff && !notUtf8 && !gitInternal && !large && !readGrant;

  // Markdown preview and JSON tree: the view chosen for this file; the
  // Diff view always shows source.
  const isMd = lang === 'markdown';
  const isJson = lang === 'json' || lang === 'jsonc';
  const isJsonRef = useRef(isJson);
  isJsonRef.current = isJson;
  const isCsv = lang === 'csv' || lang === 'tsv';
  const isCsvRef = useRef(isCsv);
  isCsvRef.current = isCsv;
  const hasViews = isMd || isJson || isCsv;
  const mdView = useApp((s) => (hasViews ? s.mdViewOf(file.path) : 'source'));
  const shownView: MdView = diff ? 'source' : mdView;
  const showPreview = hasViews && shownView !== 'source' && everText.current;
  const showMd = showPreview && isMd;
  const showJson = showPreview && isJson;
  const showCsv = showPreview && isCsv;
  const showCsvRef = useRef(showCsv);
  showCsvRef.current = showCsv;
  const previewOnly = showPreview && shownView === 'preview';
  const split = showPreview && shownView === 'split';
  const previewOnlyRef = useRef(previewOnly);
  previewOnlyRef.current = previewOnly;
  const splitRef = useRef(split);
  splitRef.current = split;
  const showPreviewRef = useRef(showMd);
  showPreviewRef.current = showMd;
  const preview = useRef<PreviewHandle | null>(null);
  // The buffer the preview shows: pushed after edits (150 ms), reloads and when the preview appears.
  // Null until the buffer is first pushed: no "Nothing to preview" flash on the way in.
  const [mdText, setMdText] = useState<string | null>(null);
  // A JSON tab: parsed in the worker after the same pause, in every view (the error marks).
  const [jsonDoc, setJsonDoc] = useState<JsonDoc>(EMPTY_JSON);
  const [jsonLines, setJsonLines] = useState(0);
  const jsonKey = `json:${file.path}`;
  const pushJson = () => {
    const v = view.current;
    if (!v || !isJsonRef.current || viewDiff.current) return;
    const doc = v.state.doc;
    const text = doc.toString();
    void parseInWorker(text, langRef.current === 'jsonc', jsonKey).then((r) => {
      if (r === 'dropped' || view.current !== v || v.state.doc !== doc) return;
      const res = r.result;
      // A tree from this text: its offsets need no mapping until the next edit.
      v.dispatch({ effects: [setJsonError.of('error' in res ? res.error : null), ...('error' in res ? [] : [markParsed.of(null)])] });
      setJsonLines(doc.lines);
      setJsonDoc((prev) => (res.ok
        ? { root: res.root, nodes: res.nodes, ms: r.ms, bytes: utf8Length(text), error: null, empty: false }
        : 'error' in res ? { ...prev, bytes: utf8Length(text), error: res.error, empty: false }
          : { ...EMPTY_JSON, empty: true }));
    });
  };
  // A CSV tab: detected, parsed and profiled in the worker after the same pause, in every view
  // (the source's colors and problem rows come from it too).
  const [csvDoc, setCsvDoc] = useState<CsvDoc>(EMPTY_CSV);
  const [csvLines, setCsvLines] = useState(0);
  const csvKey = `csv:${file.path}`;
  const csvOptions = useApp((s) => s.csvOptions[file.path] ?? AUTO_OPTIONS);
  const csvOptionsRef = useRef(csvOptions);
  csvOptionsRef.current = csvOptions;
  const pushCsv = () => {
    const v = view.current;
    if (!v || !isCsvRef.current || viewDiff.current) return;
    const doc = v.state.doc;
    const text = doc.toString();
    void parseCsvInWorker({ text, options: csvOptionsRef.current, hint: langRef.current === 'tsv' ? 'tsv' : 'csv', rows: showCsvRef.current }, csvKey).then((r) => {
      if (r === 'dropped' || view.current !== v || v.state.doc !== doc) return;
      setCsvLines(doc.lines);
      setCsvDoc({ result: r.result, ms: r.ms, bytes: utf8Length(text) });
      v.dispatch({ effects: setCsvConf.of(csvConf(r.result, useApp.getState().settings)) });
    });
  };
  const csvPane = useRef<CsvPaneHandle | null>(null);
  const [csvCursor, setCsvCursor] = useState<CursorCell | null>(null);
  const [csvStatus, setCsvStatus] = useState<CsvStatus>(EMPTY_CSV_STATUS);
  const pushText = () => {
    const v = view.current;
    if (showPreviewRef.current && v && !viewDiff.current) setMdText(v.state.doc.toString());
    pushJson();
    pushCsv();
  };
  const jsonPane = useRef<JsonPaneHandle | null>(null);
  const [jsonCursor, setJsonCursor] = useState<CursorInfo | null>(null);
  const [paneSel, setPaneSel] = useState<{ path: Segment[]; info: TypeInfo | null } | null>(null);
  const [paneStatus, setPaneStatus] = useState<PaneStatus>({ mode: 'tree' });
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = (text: string) => { setFlash(text); clearTimeout(flashTimer.current); flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS); };
  useEffect(() => () => { clearTimeout(flashTimer.current); cancelParse(jsonKey); cancelCsvParse(csvKey); }, [jsonKey]);
  const pendingLine = useRef<number | null>(null);
  const pendingPos = useRef<number | null>(null);
  const quietEditor = useRef(0);
  // The code's scrollTop set by the preview (Split): its scroll event is the echo, whenever it arrives.
  const ownEditorTop = useRef<number | null>(null);
  const [stats, setStats] = useState<{ words: number; minutes: number } | null>(null);
  const setView = (v: MdView) => useApp.getState().setMdView(file.path, v);
  /** The keyboard goes to what shows: the preview (or tree) alone, or the code. */
  const focusShown = () => {
    if (!previewOnlyRef.current) view.current?.focus();
    else if (isJsonRef.current) jsonPane.current?.focus();
    else if (isCsvRef.current) csvPane.current?.focus();
    else preview.current?.focus();
  };
  /** Cursor on a line, centered (Show in Source, the preview's ⌥ double-click). */
  const revealLine = (line: number) => {
    const v = view.current;
    if (!v) return;
    const n = Math.min(Math.max(1, line), v.state.doc.lines);
    const pos = v.state.doc.line(n).from;
    v.focus();
    v.dispatch({ effects: [setTargetLine.of(n), EditorView.scrollIntoView(pos, { y: 'center' })], selection: { anchor: pos } });
  };
  const showSource = (line: number) => {
    if (previewOnlyRef.current) { pendingLine.current = line; setView('source'); } else revealLine(line);
  };
  /** Cursor on an offset, its line centered (JSON's Show in Source and Go to error). */
  const revealPos = (pos: number, focus = true) => {
    const v = view.current;
    if (!v) return;
    const at = Math.min(Math.max(0, pos), v.state.doc.length);
    if (focus) v.focus();
    v.dispatch({ effects: [setTargetLine.of(v.state.doc.lineAt(at).number), EditorView.scrollIntoView(at, { y: 'center' })], selection: { anchor: at } });
  };
  const showPos = (pos: number) => {
    if (previewOnlyRef.current) { pendingPos.current = pos; setView('source'); } else revealPos(pos);
  };
  /** A tree value's offset on the text as it is now (the tree may be from an earlier, valid text). */
  const nodePos = (node: JsonNode): number => (view.current ? fromParse(view.current.state, node.start) : node.start);
  /** A tree value's lines on the text as it is now (⌘L, ⌘⌥C). */
  const nodeLines = (node: JsonNode): LineRange => {
    const v = view.current;
    if (!v) return { start: node.line, end: node.endLine };
    const doc = v.state.doc;
    return { start: doc.lineAt(fromParse(v.state, node.start)).number, end: doc.lineAt(Math.max(0, fromParse(v.state, node.to) - 1)).number };
  };
  /** The value under the cursor: the file bar's path follows it (Source and Split). */
  const cursorKey = useRef('');
  const csvCursorKey = useRef('');
  const readCursor = (s: EditorState) => {
    if (isCsvRef.current) {
      const c = cursorCell(s);
      const key = JSON.stringify(c);
      if (key !== csvCursorKey.current) { csvCursorKey.current = key; setCsvCursor(c); }
      return;
    }
    if (!isJsonRef.current) return;
    const c = cursorInfo(s, s.selection.main.head);
    const key = JSON.stringify(c);
    if (key === cursorKey.current) return;
    cursorKey.current = key;
    setJsonCursor(c);
  };
  const copyJsonPath = (path: Segment[] | null) => {
    if (!path) return;
    const text = formatPath(path, useApp.getState().settings.jsonPathFormat);
    void copyText(text).then((ok) => { if (ok) say(t.json.copied(text || t.json.menu.formats.pointer)); });
  };
  /** Source: the path under the cursor; Tree alone: the selected value's. */
  const shownJsonPath = (): Segment[] | null => (previewOnlyRef.current ? paneSelRef.current?.path ?? null : jsonCursorRef.current?.path ?? null);
  const paneSelRef = useRef(paneSel);
  paneSelRef.current = paneSel;
  const jsonCursorRef = useRef(jsonCursor);
  jsonCursorRef.current = jsonCursor;
  const commentFromPreview = (range: LineRange) => {
    openDraftForLines(file.path, range, view.current?.state.doc.toString() ?? null);
    // The comment box lives in the editor: Preview opens Split to show it.
    if (previewOnlyRef.current) setView('split');
  };

  const currentText = useRef<string | null>(null);
  currentText.current = text;
  const baseRef = useRef<string | null>(null);
  baseRef.current = base;
  // Line comments: new-file lines are the document's in the editor, the diff's rows in diff mode.
  const viewDiff = useRef<DiffDoc | null>(null);
  const commentSrc = useRef<CommentSource>({
    path: file.path,
    rows: () => viewDiff.current?.lines ?? null,
    text: () => (viewDiff.current ? currentText.current : view.current?.state.doc.toString() ?? null)
  });
  commentSrc.current.path = file.path;
  const commentBind = useRef<{ refresh: () => void; dispose: () => void } | null>(null);
  // Highlight requests of this editor: a newer one replaces the older (slow highlights of stale text stop).
  const hlKey = `file:${file.path}`;
  const commentHere = (v: EditorView): boolean => !isUntitled(file.path) && openDraftFrom(v, commentSrc.current);
  useEffect(() => registerCommentTarget(`f:${file.path}`, () => {
    if (previewOnlyRef.current) {
      const picked = isJsonRef.current ? jsonPane.current?.selected() : null;
      const r = isJsonRef.current ? (picked ? nodeLines(picked) : null) : isCsvRef.current ? csvPane.current?.selectedLines() ?? null : preview.current?.selection();
      if (!r || isUntitled(file.path)) return false;
      commentFromPreview(r);
      return true;
    }
    return !!view.current && commentHere(view.current);
  }), [file.path]);
  useEffect(() => { commentBind.current?.refresh(); }, [text]);

  // Next / previous change (Go › Next Change, the arrows in the bar): the Diff view's added and removed rows, or the
  // margin's marks (which follow unsaved edits). A selection, edit or new marks re-render the "2 / 5" counter.
  const [, setNavTick] = useState(0);
  // The Diff view never changes while open: its stops are computed once, not at every cursor move.
  const diffStarts = useRef<{ doc: DiffDoc; starts: number[] } | null>(null);
  const changeStarts = (v: EditorView): number[] => {
    const d = viewDiff.current;
    if (d) {
      if (diffStarts.current?.doc !== d) diffStarts.current = { doc: d, starts: runStarts(diffChangedLines(d.lines)) };
      return diffStarts.current.starts;
    }
    const lines: number[] = [];
    v.state.field(gitMarksField).between(0, v.state.doc.length, (from) => { lines.push(v.state.doc.lineAt(from).number); });
    return runStarts(lines);
  };
  const goChange = (dir: 1 | -1): boolean => {
    if (previewOnlyRef.current) return isJsonRef.current ? false : preview.current?.goChange(dir) ?? false;
    const v = view.current;
    if (!v) return false;
    const n = stepChange(changeStarts(v), v.state.doc.lineAt(v.state.selection.main.head).number, dir);
    if (n === null) return false;
    const pos = v.state.doc.line(n).from;
    // Focus first: an editor gaining focus later reads the page's selection back and would undo the move.
    v.focus();
    v.dispatch({ effects: [setTargetLine.of(n), EditorView.scrollIntoView(pos, { y: 'center' })], selection: { anchor: pos } });
    return true;
  };
  useEffect(() => registerChangeTarget(`f:${file.path}`, goChange), [file.path]);
  useEffect(() => registerFindTarget(`f:${file.path}`, {
    view: () => (previewOnlyRef.current ? null : view.current),
    readOnly: () => !editableRef.current,
    // The tree's ⌘F is its filter.
    own: () => (previewOnlyRef.current ? () => { if (isJsonRef.current) jsonPane.current?.focusFilter(); else if (isCsvRef.current) csvPane.current?.focusFilter(); else preview.current?.openFind(); } : null)
  }), [file.path]);
  // The palette's CSV commands: from Source they open the Table first.
  const withCsvPane = (run: (pane: CsvPaneHandle) => void) => {
    if (csvPane.current) { run(csvPane.current); return; }
    setView('preview');
    const tryRun = (n: number) => requestAnimationFrame(() => { if (csvPane.current) run(csvPane.current); else if (n > 0) tryRun(n - 1); });
    tryRun(20);
  };
  useEffect(() => registerCsvTarget(`f:${file.path}`, {
    goToRow: () => withCsvPane((pane) => pane.goToRow()),
    parseOptions: () => withCsvPane((pane) => pane.parseOptions())
  }), [file.path]);
  // The palette's JSON commands.
  useEffect(() => registerJsonTarget(`f:${file.path}`, {
    foldAll: () => { const v = view.current; if (v && !previewOnlyRef.current) foldLevel(v, 1); },
    unfoldAll: () => { const v = view.current; if (v && !previewOnlyRef.current) unfoldAll(v); },
    foldLevel: (n) => { const v = view.current; if (v && !previewOnlyRef.current) foldLevel(v, n); },
    copyPath: () => copyJsonPath(shownJsonPath())
  }), [file.path]);

  // After an edit: "unsaved" (150 ms), git colors and gutter (250 ms), without blocking typing.
  const timers = useRef<{ dirty?: ReturnType<typeof setTimeout>; hl?: ReturnType<typeof setTimeout> }>({});
  const afterEdit = (v: EditorView) => {
    clearTimeout(timers.current.dirty);
    timers.current.dirty = setTimeout(() => {
      if (view.current !== v) return;
      useApp.getState().setDirty(file.path, v.state.doc.toString() !== saved.current);
      pushText();
    }, 150);
    clearTimeout(timers.current.hl);
    timers.current.hl = setTimeout(() => {
      if (view.current !== v) return;
      const doc = v.state.doc.toString();
      const lang = langRef.current;
      if (hasGrammar(lang)) void highlight(doc, lang, hlKey).then((spans) => { if (view.current === v && spans && spans !== 'dropped' && v.state.doc.toString() === doc && langRef.current === lang) v.dispatch({ effects: setTokens.of(spans) }); });
      const b = baseRef.current;
      v.dispatch({ effects: setGitMarks.of(b !== null && b !== doc ? gutterMarks(b, doc) : null) });
      commentBind.current?.refresh();
    }, 250);
  };

  /** `keep`: Keep Mine, against the version the band showed (a newer one is a conflict again); `create`: recreate a
   *  file deleted on disk, only while its name is free. */
  const save = async (how: { keep?: Stamp; create?: boolean } = {}): Promise<boolean> => {
    const v = view.current;
    if (!v) return false;
    // Edits over a disk copy that turned not UTF-8 stay unsaved (writing would damage it): the user is told so.
    const gate = saveGate({ diff: !!viewDiff.current || !!diff, notUtf8, gitInternal, unsaved: unsaved(bufferOf(v)) });
    if (gate === 'not-utf8') setError(t.saveFailed('not-utf8'));
    if (gate !== 'save') return false;
    // Untitled: the "Save as" sheet asks where; the tab then becomes that file.
    if (isUntitled(file.path)) return useApp.getState().requestSaveAs(file.path, () => view.current?.state.doc.toString() ?? '');
    // Saving keeps a preview tab open.
    useApp.getState().keepOpen(file.path);
    const doc = v.state.doc.toString();
    // Nothing to save: the file is not rewritten (mtime, line ending) for nothing.
    if (!how.keep && !how.create && doc === saved.current && !gone) return true;
    const r = await window.atelier.files.save(file.path, doc, how.keep ?? stamp.current, eol.current, !!(how.create || how.keep));
    if (r.kind === 'saved') {
      saved.current = doc;
      stamp.current = r.stamp;
      setConflict(null);
      setError(null);
      useApp.getState().setDirty(file.path, v.state.doc.toString() !== doc);
      return true;
    }
    if (r.kind === 'conflict') { setConflict({ disk: normalizeEol(r.disk), stamp: r.stamp }); return false; }
    setError(t.saveFailed(r.reason));
    return false;
  };
  const editableRef = useRef(editable);
  editableRef.current = editable;
  /** The buffer as the unsaved check reads it. */
  const bufferOf = (v: EditorView) => ({ doc: v.state.doc.toString(), saved: saved.current, diff: !!viewDiff.current });
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => registerSaver(file.path, () => saveRef.current(), () => unsaved(view.current ? bufferOf(view.current) : null),
    // Moving to another window: the buffer as it is now. The Diff view's text is the diff, not the file: nothing
    // to carry (it holds no edits), the other window reads the file.
    () => (view.current && !viewDiff.current ? snapshotEditor(view.current, { path: file.path, saved: saved.current, stamp: stamp.current, eol: eol.current }) : null)), [file.path]);
  useEffect(() => () => { clearTimeout(timers.current.dirty); clearTimeout(timers.current.hl); useApp.getState().setDirty(file.path, false); }, [file.path]);

  // A view made read-only by its grant is made again, editable, once a gesture granted the file for editing (Open File…
  // on it). Only that way: a view that may hold edits is never rebuilt, so never made read-only under them.
  const grantLock = useRef({ locked: false, unlocks: 0 });
  if (readGrant) grantLock.current.locked = true;
  else if (grantLock.current.locked && content?.kind === 'text') grantLock.current = { locked: false, unlocks: grantLock.current.unlocks + 1 };
  const unlocks = grantLock.current.unlocks;

  // View creation: at the first text, on file change or mode change (gutter ↔ diff), once unlocked (above).
  const hasText = everText.current;
  const shape = diff ?? 'margin';
  useEffect(() => {
    if (!hasText || !host.current || !content) return;
    if (view.current) return;
    // A buffer moved here from another window makes the editor instead of the file, with the disk version it was
    // compared against: a file changed meanwhile shows the usual conflict, and Save meets the stamp check.
    const taken = madeView.current ? null : takeHandoff(file.path);
    const h = diff ? null : taken;
    if (!h && content.kind !== 'text') return;
    const doc = h ? h.state.doc : diff ? diff.text : currentText.current ?? '';
    if (h) {
      saved.current = h.saved;
      stamp.current = h.stamp;
      eol.current = h.eol;
      scroll.current = h.scrollTop;
    } else if (!diff && content.kind === 'text') {
      saved.current = currentText.current;
      stamp.current = { mtimeMs: content.mtimeMs, size: content.size, hash: content.hash };
      eol.current = detectEol(content.text);
    }
    const ind = detectIndent(doc);
    const extensions: Extension[] = [
      langConf.current.of(commentData(lang)),
      // Several cursors (⌘D, ⌘⇧L, ⌥↵ in Find), drawn by the editor: the native selection shows only one.
      EditorState.allowMultipleSelections.of(true),
      // Its tab moving to another window: no edits until the window answers.
      moveGuard(file.path),
      ...(editable
        ? [drawSelection(), history(), closeBrackets(), indentUnit.of(ind.unit), EditorState.tabSize.of(ind.tabSize), highlightActiveLine(),
            keymap.of([
              { key: 'Mod-s', run: () => { void saveRef.current(); return true; } },
              { key: 'Mod-/', run: toggleComment }, { key: 'Mod-d', run: selectNextOccurrence },
              indentWithTab, ...closeBracketsKeymap, ...historyKeymap
            ]),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) afterEdit(u.view);
              if (u.selectionSet || u.docChanged) {
                const head = u.state.selection.main.head;
                const line = u.state.doc.lineAt(head);
                setCursor({ line: line.number, col: head - line.from + 1 });
              }
            })]
        : [EditorState.readOnly.of(true), EditorView.editable.of(false), drawSelection()]),
      ...(diff ? diffExtensions(diff) : [gitGutter, lineNumbers()]),
      // The overview ruler: the Diff view's rows or the margin's marks.
      overviewRuler(diff ? diffRulerSource(diff) : { changes: gitMarkLines }),
      jsonConf.current.of(isJson && !diff ? jsonEditorExtensions() : []),
      csvConfC.current.of(isCsv && !diff ? csvEditorExtensions() : []),
      EditorView.updateListener.of((u) => {
        if (u.selectionSet || u.docChanged || u.transactions.some((tr) => tr.effects.length)) readCursor(u.state);
      }),
      keymap.of([{ key: 'Mod-Alt-Shift-c', run: () => { if (!isJsonRef.current) return false; copyJsonPath(jsonCursorRef.current?.path ?? null); return true; } }]),
      highlightActiveLineGutter(), ...findExtensions({ readOnly: !editable }), highlightSelectionMatches(),
      // ⌘L before the base keymap (which uses it to select the line): the selected lines go to Claude.
      keymap.of([{ key: 'Mod-l', run: (v) => {
        if (isUntitled(file.path)) useApp.getState().showToast(t.untitledMention, undefined, 'info');
        else mentionInSession(file.path, editable && !diff ? selLines(v) : null);
        return true;
      } }]),
      keymap.of([...searchKeys(), ...defaultKeys()]),
      // ⌥Z: word wrap on or off, in every editor.
      keymap.of(wordWrapKeys()),
      // Off macOS a character typed with AltGr (Ctrl+Alt there) never reaches the keymaps above.
      altGrTyping,
      EditorView.updateListener.of((u) => {
        if (u.selectionSet || u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(setGitMarks)))) setNavTick((n) => n + 1);
      }),
      tokenField, targetField, gitMarksField, cmTheme, EditorView.contentAttributes.of({ tabindex: '0' }),
      wrap.current.of(useApp.getState().settings.wordWrap ? EditorView.lineWrapping : []),
      ...(isUntitled(file.path) ? [] : commentExtensions((cv) => { if (!commentHere(cv)) useApp.getState().showToast(t.comments.selectLines, undefined, 'info'); }))
    ];
    const v = new EditorView({ state: h ? stateFromHandoff(h, extensions) : EditorState.create({ doc, extensions }), parent: host.current });
    view.current = v;
    madeView.current = true;
    viewDiff.current = diff;
    if (h) {
      useApp.getState().setDirty(file.path, v.state.doc.toString() !== saved.current);
      useApp.getState().keepOpen(file.path);
      // The caret came along: the footer says where it is (no selection change will tell it).
      const head = v.state.selection.main.head;
      const at = v.state.doc.lineAt(head);
      setCursor({ line: at.number, col: head - at.from + 1 });
    }
    setNavTick((n) => n + 1);
    const bound = isUntitled(file.path) ? null : bindComments(v, commentSrc.current);
    commentBind.current = bound;
    v.scrollDOM.scrollTop = scroll.current;
    const onScroll = () => {
      const s = v.scrollDOM;
      const moved = s.scrollTop - scroll.current;
      scroll.current = s.scrollTop;
      // Split: the preview follows the code (not while the preview is the one moving it, nor for events that didn't
      // move it, such as a resize).
      const ours = ownEditorTop.current !== null && Math.abs(s.scrollTop - ownEditorTop.current) < 2;
      if (ours) ownEditorTop.current = null;
      if (!splitRef.current || ours || Date.now() < quietEditor.current || Math.abs(moved) < 1) return;
      const h = s.getBoundingClientRect().top - v.documentTop;
      // Scrolling down to the last line (the content's bottom padding aside): the end of the page too, as the two can't
      // be the same height.
      if (moved > 0 && v.lineBlockAt(v.state.doc.length).bottom <= h + s.clientHeight) { preview.current?.scrollToLine(Infinity); return; }
      const block = v.lineBlockAtHeight(Math.max(0, h));
      preview.current?.scrollToLine(v.state.doc.lineAt(block.from).number + Math.max(0, h - block.top) / Math.max(1, block.height));
    };
    v.scrollDOM.addEventListener('scroll', onScroll);
    hlLang.current = lang;
    // CSV colors itself (rainbow columns): no grammar, and no "Plain text" note.
    if (hasGrammar(lang)) void highlight(doc, lang, hlKey).then((spans) => { if (view.current === v && spans !== 'dropped' && langRef.current === lang) { if (spans) v.dispatch({ effects: setTokens.of(spans) }); else setPlain(true); } });
    if (visible && focusedRef.current && !held()) focusShown();
    targeted.current = null;
    pushText();
    readCursor(v.state);
    return () => {
      // A highlight still running for this view is no longer wanted (a big file closed or switched to diff).
      cancelHighlight(hlKey);
      bound?.dispose(); if (commentBind.current === bound) commentBind.current = null;
      v.scrollDOM.removeEventListener('scroll', onScroll); v.destroy(); view.current = null; viewDiff.current = null;
    };
  }, [file.path, hasText, shape, unlocks]);

  // The file changed on disk: without local edits only the changed part is updated (the position stays);
  // with local edits it is adopted (if identical) or the conflict is flagged. What the user wrote is never lost.
  useEffect(() => {
    const v = view.current;
    if (!v || diff || text === null || !content || content.kind !== 'text') return;
    const buffer = v.state.doc.toString();
    const action = onDiskChange({ dirty: buffer !== saved.current, disk: text, buffer, saved: saved.current ?? '' });
    const diskStamp = { mtimeMs: content.mtimeMs, size: content.size, hash: content.hash };
    if (action !== 'conflict') setConflict(null);
    if (action === 'reload-minimal') {
      const change = minimalChange(buffer, text);
      saved.current = text;
      stamp.current = diskStamp;
      eol.current = detectEol(content.text);
      if (change) {
        v.dispatch(reloadSpec(change));
        pushText();
        const lang = langRef.current;
        if (hasGrammar(lang)) void highlight(text, lang, hlKey).then((spans) => { if (view.current === v && spans && spans !== 'dropped' && langRef.current === lang) v.dispatch({ effects: setTokens.of(spans) }); });
      }
      useApp.getState().setDirty(file.path, false);
    } else if (action === 'adopt') {
      saved.current = text;
      stamp.current = diskStamp;
      useApp.getState().setDirty(file.path, false);
    } else if (action === 'conflict') {
      setConflict({ disk: text, stamp: diskStamp });
    } else if (!dirty) {
      saved.current = text;
      stamp.current = diskStamp;
    }
    v.dispatch({ effects: setGitMarks.of(base !== null && base !== v.state.doc.toString() ? gutterMarks(base, v.state.doc.toString()) : null) });
    // The lines under a comment may have changed: outdated or not again.
    commentBind.current?.refresh();
  }, [text, base, diff]);

  // Another language picked (Change Language Mode): the colors and the comment syntax follow, without rebuilding the view.
  useEffect(() => {
    const v = view.current;
    if (!v || hlLang.current === lang) return;
    hlLang.current = lang;
    setPlain(false);
    const json = (lang === 'json' || lang === 'jsonc') && !viewDiff.current;
    const csv = (lang === 'csv' || lang === 'tsv') && !viewDiff.current;
    v.dispatch({ effects: [langConf.current.reconfigure(commentData(lang)), jsonConf.current.reconfigure(json ? jsonEditorExtensions() : []),
      csvConfC.current.reconfigure(csv ? csvEditorExtensions() : []), ...(hasGrammar(lang) ? [] : [setTokens.of(null)])] });
    if (json) { pushJson(); readCursor(v.state); } else { setJsonCursor(null); setJsonDoc(EMPTY_JSON); }
    if (csv) pushCsv(); else { setCsvCursor(null); csvCursorKey.current = ''; setCsvDoc(EMPTY_CSV); setCsvStatus(EMPTY_CSV_STATUS); }
    if (!hasGrammar(lang)) { cancelHighlight(hlKey); return; }
    const doc = v.state.doc.toString();
    void highlight(doc, lang, hlKey).then((spans) => {
      if (view.current !== v || spans === 'dropped' || langRef.current !== lang || v.state.doc.toString() !== doc) return;
      v.dispatch({ effects: setTokens.of(spans) });
      if (!spans) setPlain(true);
    });
  }, [lang]);

  // The language sheet of this tab closed: typing goes on in the editor.
  const pickingLang = useApp((s) => s.languageSheet === file.path);
  const wasPicking = useRef(false);
  useEffect(() => {
    if (wasPicking.current && !pickingLang && visible && focused) view.current?.focus();
    wasPicking.current = pickingLang;
  }, [pickingLang]);

  // Cited line: only when requested (open or link), never on a reload from disk.
  useEffect(() => {
    const v = view.current;
    if (!v || file.line === null || targeted.current === file.nonce) return;
    targeted.current = file.nonce;
    let n = file.line;
    if (diff) { const i = diff.lines.findIndex((l) => l.newNo === file.line); if (i >= 0) n = i + 1; }
    n = Math.max(1, n);
    const toLine = () => {
      const k = Math.min(n, v.state.doc.lines);
      const pos = v.state.doc.line(k).from;
      v.dispatch({ effects: [setTargetLine.of(k), EditorView.scrollIntoView(pos, { y: 'center' })], selection: { anchor: pos } });
    };
    // A search result: its match selected and the query's occurrences marked, by a module loaded with the first one
    // (should it fail, the line alone, and the result is let go).
    const found = file.found;
    const current = () => view.current === v && targeted.current === file.nonce;
    if (found) void import('./find-in-files-ext').then((m) => { if (current()) m.showFound(v, n, found); }).catch(() => { forgetFound(found); if (current()) toLine(); });
    else toLine();
  }, [file.line, file.nonce, content, diff, hasText]);

  // A hidden tab cannot scroll: the position is restored when it becomes visible again.
  useEffect(() => {
    const v = view.current;
    if (!visible || !focused) released.current = file.nonce;
    if (!visible || !v) return;
    if (Math.abs(v.scrollDOM.scrollTop - scroll.current) > 1) v.scrollDOM.scrollTop = scroll.current;
    if (focused && !held()) focusShown();
  }, [visible, focused]);

  // CSV: new parse options parse again; the source's toggles reach the editor at once;
  // in Split the table follows the cursor's cell.
  useEffect(() => { pushCsv(); }, [JSON.stringify(csvOptions)]);
  const csvRainbow = useApp((s) => s.settings.csvRainbow);
  const csvAlign = useApp((s) => s.settings.csvAlign);
  const csvFollow = useApp((s) => s.settings.csvTableFollowsCursor);
  useEffect(() => {
    const v = view.current;
    if (v && csvDoc.result && isCsv && !viewDiff.current) v.dispatch({ effects: setCsvConf.of(csvConf(csvDoc.result, { csvRainbow, csvAlign })) });
  }, [csvRainbow, csvAlign]);
  // A cell picked in the table moves the cursor: that move's echo is not followed back (a missing field would land on
  // the record's last one).
  const pickEcho = useRef<{ row: number; until: number } | null>(null);
  useEffect(() => {
    if (!split || !isCsv || !csvFollow || !csvCursor || csvCursor.row < 0) return;
    const echo = pickEcho.current;
    pickEcho.current = null;
    if (echo && echo.row === csvCursor.row && Date.now() < echo.until) return;
    csvPane.current?.selectCell(csvCursor.row, csvCursor.col);
  }, [split, csvFollow, csvCursor?.row, csvCursor?.col, csvDoc]);
  /** A table cell's place in the text as it is now (Show in Source, Split's sync). */
  const cellPos = (row: number, col: number): number | null => (view.current ? fieldStart(view.current.state, row, col) : null);
  /** The field under the cursor, unquoted (Copy cell in Source and Split). */
  const copyCursorCell = () => {
    const v = view.current;
    const c = csvCursorRef.current;
    if (!v || !c) return;
    const value = unquoteField(v.state.sliceDoc(c.from, c.to), csvDoc.result?.resolved.delimiter ?? ',');
    void copyText(value).then((ok) => { if (ok) say(t.csv.copied(value.length > 24 ? `${value.slice(0, 23)}…` : value || '(empty)')); });
  };
  const csvCursorRef = useRef(csvCursor);
  csvCursorRef.current = csvCursor;

  // Switching views: the preview gets the buffer as it is now; back to the code, the editor measures again (it was
  // hidden) and Show in Source puts the cursor on its line.
  useEffect(() => { if (showPreview) pushText(); }, [showPreview]);
  const wasPreviewOnly = useRef(previewOnly);
  useEffect(() => {
    if (wasPreviewOnly.current === previewOnly) return;
    wasPreviewOnly.current = previewOnly;
    const v = view.current;
    if (previewOnly) {
      if (visible && focused) { if (isJson) requestAnimationFrame(() => jsonPane.current?.focus()); else preview.current?.focus(); }
      return;
    }
    if (!v) return;
    v.requestMeasure();
    const line = pendingLine.current;
    const pos = pendingPos.current;
    pendingLine.current = null;
    pendingPos.current = null;
    if (line !== null) requestAnimationFrame(() => revealLine(line));
    else if (pos !== null) requestAnimationFrame(() => revealPos(pos));
    else if (visible && focused && !held()) v.focus();
  }, [previewOnly]);

  const reload = () => {
    const v = view.current;
    if (!v || !conflict) return;
    const change = minimalChange(v.state.doc.toString(), conflict.disk);
    if (change) v.dispatch(reloadSpec(change));
    pushText();
    saved.current = conflict.disk;
    stamp.current = conflict.stamp;
    useApp.getState().setDirty(file.path, false);
    setConflict(null);
    setCompare(false);
  };

  const name = file.rel.split('/').at(-1) ?? file.rel;
  const external = isExternal(file.path, realRoot);
  const nav = view.current && !tooBig && !previewOnly ? view.current : null;
  const starts = nav ? changeStarts(nav) : [];
  const pv = previewOnly ? preview.current?.changes() ?? { count: 0, at: 0 } : null;
  const navCount = pv ? pv.count : starts.length;
  const at = pv ? pv.at : nav ? changePosition(starts, nav.state.doc.lineAt(nav.state.selection.main.head).number) : 0;
  const views = isJson ? JSON_VIEWS : isCsv ? CSV_VIEWS : MD_VIEWS;
  // The CSV address in the file bar: the cursor's cell in Source and Split, the table's selection in Table.
  const csvCrumb: CsvCrumb | null = (() => {
    if (!isCsv || !hasText || diff) return null;
    // The table's range wins in Split too (its cursor sits on the range's focus).
    if (previewOnly || (split && csvStatus.crumb && csvStatus.crumb.column === null)) return csvStatus.crumb;
    const r = csvDoc.result;
    if (!csvCursor || !r) return null;
    const prof = r.profiles[csvCursor.col];
    const name = prof ? (prof.extra ? t.csv.noHeader : prof.name || null) : null;
    if (csvCursor.row < 0) return { address: prof?.letter ?? '', column: name, info: t.csv.header };
    return { address: csvAddress(csvCursor.row, csvCursor.col), column: name, info: `${prof ? `${csvTypeLabel(prof)} · ` : ''}${t.csv.fieldOf(csvCursor.line, csvCursor.col + 1, csvCursor.of)}`, bad: csvCursor.of !== r.data.expected };
  })();
  const csvProblems = isCsv && !diff ? csvDoc.result?.data.problems.length ?? 0 : 0;
  // The JSON path in the file bar: the cursor's in Source and Split, the selected value's in Tree.
  const jsonCrumb = isJson && hasText && !diff
    ? previewOnly ? (paneSel ? { path: paneSel.path, info: paneSel.info } : null) : jsonCursor ? { path: jsonCursor.path, info: jsonCursor.info } : null
    : null;
  const jsonError = isJson && !diff ? jsonDoc.error : null;
  const follow = useApp((s) => s.settings.jsonTreeFollowsCursor);
  const pathFormat = useApp((s) => s.settings.jsonPathFormat);
  return (
    <section className="file-view" style={{ display: visible ? 'flex' : 'none', ...place }} aria-label={file.rel}>
      <div className="file-bar">
        <FileIcon name={name} size={14} />
        <span className="mono crumb" title={external ? file.rel : undefined}>{crumbDirs(file.rel).map((p) => `${p} › `).join('')}<b>{name}</b></span>
        {/* The panes and crumbs below have their own boundaries: a throw there must not unmount this editor (its unsaved
            buffer, and the saver that makes close and quit ask). */}
        {jsonCrumb && (
          <ErrorBoundary id="json-path" panel={t.crashPanels.jsonPath} quiet>
            <JsonPath path={jsonCrumb.path} info={jsonCrumb.info} flash={flash} onCopy={() => copyJsonPath(jsonCrumb.path)}
              onGo={(path) => {
                if (previewOnly) { jsonPane.current?.selectPath(path); return; }
                const v = view.current;
                const scan = v?.state.field(scanField, false)?.scan;
                const at = scan ? startOfPath(scan, path) : null;
                if (at !== null) revealPos(at);
              }} />
          </ErrorBoundary>
        )}
        {csvCrumb && (
          <ErrorBoundary id="csv-address" panel={t.crashPanels.csvAddress} quiet>
            <CsvAddress crumb={csvCrumb} flash={flash} onCopy={csvCrumb === csvStatus.crumb ? () => csvPane.current?.copySelection() : copyCursorCell} />
          </ErrorBoundary>
        )}
        {external && (claudeTemp
          ? <span className="file-note is-outside" data-tip={readGrant ? t.claudeTemp.tip(file.path) : t.claudeTemp.editableTip(file.path)}>{t.claudeTemp.chip}</span>
          : <span className="file-note is-outside" data-tip={readGrant ? t.openAny.readTip : t.openAny.outsideTip}>{t.openAny.outside}</span>)}
        <span className="grow" />
        {plain && <span className="file-note">{t.plainText}</span>}
        {!dirty && changed && baseline.kind === 'new' && <span className="file-note">{t.newFile}</span>}
        {tooBig && <span className="file-note">{t.tooManyChanges}</span>}
        {navCount > 0 && (
          <span className="change-nav" role="group" aria-label={t.changeNav}>
            <button type="button" className="icon-btn" aria-label={t.prevChange} data-tip={`${t.prevChange} · ${kbd('⌥⇧F5')}`} onClick={() => goChange(-1)}><Icon name="chevronUp" size={13} /></button>
            <span className="mono change-nav-count">{at > 0 ? `${at} / ${navCount}` : t.changesCount(navCount)}</span>
            <button type="button" className="icon-btn" aria-label={t.nextChange} data-tip={`${t.nextChange} · ${kbd('⌥F5')}`} onClick={() => goChange(1)}><Icon name="chevronDown" size={13} /></button>
          </span>
        )}
        {changed && !dirty && (
          <span className="seg">
            <button type="button" className={mode === 'margin' ? 'is-on' : ''} onClick={() => setFileMode(file.path, 'margin')}>{t.margin}</button>
            <button type="button" className={mode === 'diff' ? 'is-on' : ''} onClick={() => { setFileMode(file.path, 'diff'); if (hasViews && mdView !== 'source') setView('source'); }}>{t.diff}</button>
          </span>
        )}
        {isJson && hasText && !diff && !previewOnly && (
          <span className="json-fold-group">
            <button type="button" className="icon-btn" aria-label={t.json.foldAll} data-tip={`${t.json.foldAll} · ${kbd('⌃⌥[')}`} onClick={() => { const v = view.current; if (v) { foldLevel(v, 1); v.focus(); } }}><Icon name="collapseAll" size={13} stroke={1.7} /></button>
            <button type="button" className="icon-btn" aria-label={t.json.unfoldAll} data-tip={`${t.json.unfoldAll} · ${kbd('⌃⌥]')}`} onClick={() => { const v = view.current; if (v) { unfoldAll(v); v.focus(); } }}><Icon name="unfoldAll" size={13} stroke={1.7} /></button>
          </span>
        )}
        {isCsv && hasText && !diff && !previewOnly && (
          <span className="csv-src-group">
            <button type="button" className="csv-src-tog" aria-pressed={csvRainbow} data-tip={t.csv.rainbowTip} onClick={() => void window.atelier.settings.set({ csvRainbow: !csvRainbow })}>
              <Icon name="appearance" size={12} stroke={1.8} /><span className="csv-src-label">{t.csv.rainbow}</span>
            </button>
            <button type="button" className="csv-src-tog" aria-pressed={csvAlign} data-tip={t.csv.alignTip} onClick={() => void window.atelier.settings.set({ csvAlign: !csvAlign })}>
              <Icon name="wrap" size={12} stroke={1.8} /><span className="csv-src-label">{t.csv.align}</span>
            </button>
          </span>
        )}
        {hasViews && hasText && (
          // A radio group: one Tab stop (the chosen view), arrows move and choose.
          <span className={`seg md-switch ${isJson || isCsv ? 'json-switch' : ''}`} role="radiogroup" aria-label={isJson ? t.json.views : isCsv ? t.csv.views : t.md.views} onKeyDown={(e) => {
            const next = radioNext(views.map((o) => o.view), shownView, e.key);
            if (next === null) return;
            e.preventDefault();
            setView(next);
            (e.currentTarget.children[views.findIndex((o) => o.view === next)] as HTMLElement | undefined)?.focus();
          }}>
            {views.map((o) => (
              <button key={o.view} type="button" role="radio" aria-checked={shownView === o.view} tabIndex={shownView === o.view ? 0 : -1}
                className={shownView === o.view ? 'is-on' : ''} aria-label={o.label()} data-tip={o.tip()} data-kbd={o.kbd} onClick={() => setView(o.view)}>
                <Icon name={o.icon} size={13} stroke={1.7} /><span className="md-switch-label">{o.label()}</span>
              </button>
            ))}
          </span>
        )}
      </div>
      {conflict && (
        <div className="conflict-band" role="alert">
          <span className="conflict-dot" />
          <span className="conflict-text">{t.conflictTitle}</span>
          <span className="grow" />
          <button type="button" className="btn-ghost sm" onClick={() => setCompare(true)}>{t.compare}</button>
          <button type="button" className="btn-ghost sm" onClick={() => void save({ keep: conflict.stamp })}>{t.keepMine}</button>
          <button type="button" className="btn-primary sm" onClick={reload}>{t.reload}</button>
        </div>
      )}
      {gone && (
        <div className="conflict-band is-gone" role="alert">
          <span className="conflict-dot" />
          <span className="conflict-text">{gone === 'missing' ? t.deletedOnDisk : t.notTextAnymore}</span>
          <span className="grow" />
          {gone === 'missing' && !readGrant && <button type="button" className="btn-primary sm" onClick={() => void save({ create: true })}>{t.saveRecreate}</button>}
        </div>
      )}
      {notUtf8 && <div className="file-info-band">{t.notUtf8}</div>}
      {gitInternal && <div className="file-info-band">{t.gitInternal}</div>}
      {mixedEol && !notUtf8 && <div className="file-info-band">{t.mixedEol(eol.current.toUpperCase())}</div>}
      {error && <div className="save-error" role="alert">{error}<button type="button" className="sb-btn" onClick={() => setError(null)}>{t.dismiss}</button></div>}
      {hasText && <div className={`file-main${split ? ' is-split' : ''}`}>
      <div ref={host} className="file-body" style={previewOnly ? { display: 'none' } : undefined} onContextMenu={(e) => {
        const v = view.current;
        if (!v) return;
        const sel = v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
        useApp.getState().openMenu(e, editorMenu(file.path, {
          copy: sel ? () => void copyText(sel) : null,
          selectAll: () => { v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } }); v.focus(); },
          find: () => { v.focus(); openFind(v, false); },
          findReplace: editable ? () => { v.focus(); openFind(v, true); } : null,
          gotoLine: () => { gotoLine(v); },
          changeLanguage: () => useApp.getState().setLanguageSheet(file.path),
          mentionLines: editable && !diff && !isUntitled(file.path) && selLines(v) ? () => mentionInSession(file.path, selLines(v)) : null,
          commentLines: !isUntitled(file.path) && selLines(v) ? () => { commentHere(v); } : null,
          togglePreview: isMd ? () => setView(toggledView(mdView)) : null,
          jsonTree: isJson && !diff ? () => setView(toggledView(mdView)) : null,
          copyJsonPath: isJson && !diff ? () => copyJsonPath(jsonCursorRef.current?.path ?? null) : null,
          csvTable: isCsv && !diff ? () => setView(toggledView(mdView)) : null,
          copyCsvCell: isCsv && !diff && csvCursorRef.current ? copyCursorCell : null
        }));
      }} />
      {showJson && (
        <ErrorBoundary id="json-tree" panel={t.crashPanels.jsonTree} body={t.crash.paneBody} onCatch={() => { jsonPane.current = null; }}>
        <JsonPane path={file.path} doc={jsonDoc} split={split} visible={visible} format={pathFormat} handle={jsonPane}
          follow={split && follow ? jsonCursor?.path ?? null : null}
          onSelection={(path, node) => setPaneSel(path ? { path, info: nodeInfo(node) } : null)}
          onPick={(node: JsonNode) => { if (splitRef.current) revealPos(nodePos(node), false); }}
          onShowSource={(node: JsonNode) => showPos(nodePos(node))}
          onGoToError={() => { const e = view.current?.state.field(errorField, false); if (e) showPos(e.from); }}
          onCopied={(what) => say(t.json.copied(what))}
          onMention={(node) => { if (isUntitled(file.path)) useApp.getState().showToast(t.untitledMention, undefined, 'info'); else mentionInSession(file.path, nodeLines(node)); }}
          onStatus={setPaneStatus} />
        </ErrorBoundary>
      )}
      {showCsv && (
        <ErrorBoundary id="csv-table" panel={t.crashPanels.csvTable} body={t.crash.paneBody} onCatch={() => { csvPane.current = null; }}>
        <CsvPane path={file.path} doc={csvDoc} options={csvOptions} split={split} visible={visible} handle={csvPane}
          onOptions={(o) => useApp.getState().setCsvOptions(file.path, o)}
          onPick={(row, col) => { const at = cellPos(row, col); if (at !== null && splitRef.current) { pickEcho.current = { row, until: Date.now() + 500 }; revealPos(at, false); } }}
          onShowSource={(row, col) => { const at = cellPos(row, col); if (at !== null) showPos(at); }}
          onCopied={(what) => say(t.csv.copied(what))}
          onMention={(lines) => { if (isUntitled(file.path)) useApp.getState().showToast(t.untitledMention, undefined, 'info'); else mentionInSession(file.path, lines); }}
          onComment={(lines) => { if (!isUntitled(file.path)) commentFromPreview(lines); }}
          onStatus={setCsvStatus} />
        </ErrorBoundary>
      )}
      {showMd && mdText !== null && (
        <ErrorBoundary id="md-preview" panel={t.crashPanels.preview} body={t.crash.paneBody} onCatch={() => { preview.current = null; }}>
        <MarkdownPreview path={file.path} text={mdText} split={split} visible={visible} nonce={file.nonce + diskNonce} base={base}
          cursorLine={split ? cursor.line : null} handle={preview}
          onShowSource={showSource} onComment={commentFromPreview}
          onScrollLine={(line) => {
            const v = view.current;
            if (!v) return;
            quietEditor.current = Date.now() + 120;
            const s = v.scrollDOM;
            if (!Number.isFinite(line)) s.scrollTop = s.scrollHeight;
            else {
              const n = Math.min(Math.max(1, Math.floor(line)), v.state.doc.lines);
              const b = v.lineBlockAt(v.state.doc.line(n).from);
              s.scrollTop = b.top + (line - n) * b.height;
            }
            ownEditorTop.current = s.scrollTop;
          }}
          onNav={() => setNavTick((x) => x + 1)} onStats={setStats}
          onTogglePreview={() => setView(toggledView(mdView))} onSourceView={() => setView('source')} />
        </ErrorBoundary>
      )}
      </div>}
      {content && content.kind !== 'text' && !hasText && (content.kind === 'too-large'
        // Past 5 MB: Open Anyway up to 50 MB, past that only Reveal in Finder.
        ? <div className="file-empty file-large">
            <span>{content.size <= MAX_LARGE_FILE_BYTES ? t.fileState['too-large'] : t.largeOver}</span>
            {content.size <= MAX_LARGE_FILE_BYTES
              ? <button type="button" className="btn-ghost sm is-strong" onClick={() => useApp.getState().setFileLarge(file.path)}>{t.openAnyway}</button>
              : <button type="button" className="btn-ghost sm" onClick={() => void window.atelier.reveal(file.path)}>{t.menu.revealInFinder}</button>}
          </div>
        : <div className="file-empty">{t.fileState[content.kind]}</div>)}
      {compare && conflict && view.current && <ConflictCompare disk={conflict.disk} buffer={view.current.state.doc.toString()} onClose={() => setCompare(false)} />}
      <div className="file-foot">
        {editable
          ? <span className={dirty ? 'foot-modified' : 'foot-saved'}>{dirty ? t.modified : t.saved}</span>
          : <span>{diff ? `${t.readOnly} · ${t.vsHead}` : large ? `${t.readOnly} · ${t.largeFile}` : t.readOnly}</span>}
        {previewOnly && isMd && <span className="foot-preview"><Icon name="eye" size={12} stroke={1.7} />{t.md.preview}</span>}
        {previewOnly && isJson && jsonDoc.root && (paneStatus.mode === 'table'
          ? paneStatus.row !== null && paneStatus.line !== null && <span className="foot-json">{t.json.rowLine(paneStatus.row, paneStatus.line)}</span>
          : <span className="foot-json">{t.json.stats(groupNumber(jsonLines), groupNumber(jsonDoc.nodes), sizeLabel(jsonDoc.bytes))}</span>)}
        {previewOnly && isCsv && csvDoc.result && <>
          {csvStatus.position && <span className="foot-json">{csvStatus.position}</span>}
          {csvStatus.totals.length > 0
            ? <span className="foot-csv-totals">{csvStatus.totals.map((x) => <span key={x.name}>{x.name} {x.parts.map(([k, n], i) => <span key={k}>{i > 0 ? ' · ' : ' '}{k} <b>{n}</b></span>)}</span>)}</span>
            : <span className="foot-json">{t.csv.footStats(groupNumber(csvLines), groupNumber(csvDoc.result.data.rows.length), sizeLabel(csvDoc.bytes))}</span>}
        </>}
        {jsonError && <span className="foot-problems" role="status">{t.json.problems(1)}</span>}
        {csvProblems > 0 && <span className="foot-problems" role="status">{t.csv.problems(csvProblems)}</span>}
        <span className="grow" />
        {previewOnly && isJson && jsonDoc.root && (paneStatus.mode === 'table'
          ? <span className="foot-hints">{t.json.hints.cell} <span className="json-kbd">{'{…}'}</span> {t.json.hints.toTree} · <span className="json-kbd">{kbd('⌥⏎')}</span> {t.json.hints.source}</span>
          : <span className="foot-hints"><span className="json-kbd">↑↓</span> {t.json.hints.move} · <span className="json-kbd">←→</span> {t.json.hints.toggle} · <span className="json-kbd">{kbd('⌥-click')}</span> {t.json.hints.subtree} · <span className="json-kbd">{kbd('⌥⏎')}</span> {t.json.hints.source}</span>)}
        {previewOnly && isCsv && csvDoc.result && csvStatus.totals.length === 0 && (
          <span className="foot-hints"><span className="json-kbd">⇧</span> {t.csv.hints.extend} · <span className="json-kbd">Space</span> {t.csv.hints.peek} · <span className="json-kbd">{kbd('⌃G')}</span> {t.csv.hints.goTo} · <span className="json-kbd">{kbd('⌥⏎')}</span> {t.csv.hints.source}</span>
        )}
        {split && isCsv && (
          <button type="button" role="switch" aria-checked={csvFollow} className="foot-follow" onClick={() => void window.atelier.settings.set({ csvTableFollowsCursor: !csvFollow })}>
            <span className="foot-follow-sw" />{t.csv.follow}
          </button>
        )}
        {split && isJson && (
          <button type="button" role="switch" aria-checked={follow} className="foot-follow" onClick={() => void window.atelier.settings.set({ jsonTreeFollowsCursor: !follow })}>
            <span className="foot-follow-sw" />{t.json.follow}
          </button>
        )}
        {previewOnly && isMd && stats && stats.words > 0 && <span className="mono foot-words">{t.md.words(stats.words, stats.minutes)}</span>}
        {editable && !previewOnly && <span className="mono foot-pos">{t.lineCol(cursor.line, cursor.col)}</span>}
        <button type="button" className="foot-lang" data-tip={t.lang.tip} aria-haspopup="dialog"
          onClick={() => useApp.getState().setLanguageSheet(file.path)}>{languageLabel(lang) ?? t.plain}</button>
        {editable && !previewOnly && <span className="mono foot-eol">{eol.current.toUpperCase()}</span>}
      </div>
    </section>
  );
}
