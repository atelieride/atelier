// Review view: the changed files of a session (or of the whole project) one after the other, each as
// the read-only hunks of its diff. Same diff engine and colors as the editor's diff mode.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import type { RepoCompare, RepoStatus } from '@shared/git';
import type { MenuItem } from '../menu-model';
import { hideWorktreeFolders, isWorktree } from '../worktrees';
import { languageFor } from '@shared/languages';
import { cmTheme } from '../editor/cmTheme';
import { diffExtensions, setTokens, tokenField } from '../editor/decorations';
import { hunkHeaders, setCurrentHunk } from '../editor/review-decorations';
import { cancelHighlight, highlight } from '../editor/highlighter';
import { isWordWrapKey, toggleWordWrap, wordWrapKeys } from '../editor/word-wrap';
import { minimalChange, unifiedDoc } from '../editor/linediff';
import { normalizeEol } from '../editor/conflict';
import { baseRevOf, compactDoc, compareAvailable, hunksOf, navStops, reviewBody, reviewRows, reviewScopeTitle, stepNav, type NavStop, type ReviewDoc } from '../review';
import { clashNames, groupBySession, buildRows, sessionOrderKey, touchedBy, type ChangeRow } from '../changes';
import { OriginMarks } from './OriginMarks';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { openBelow } from '../menus';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';
import { CommentCard } from './CommentThread';
import { bindComments, commentExtensions, openDraftFrom, type CommentSource } from '../editor/comments-ext';
import { docLineOf, isOutdated, isPending } from '../comments';
import { registerCommentTarget } from '../comment-targets';
import { sendReason, sendReview } from '../review-send';
import { idStyle } from '../avatar';

/** Past this many rows a file's hunks are not shown here ("Open file" only), like the editor's diff cap. */
const MAX_REVIEW_LINES = 4000;

/** The review reads, never edits: no blinking caret where it was clicked, an arrow instead of the text pointer. */
const noCaret = EditorView.theme({
  '.cm-cursorLayer': { display: 'none' },
  '.cm-content': { caretColor: 'transparent', cursor: 'default' }
});

type Loaded = { kind: 'diff'; doc: ReviewDoc; text: string } | { kind: 'too-big' | 'binary' | 'unreadable' | 'empty' };

interface FileHandle {
  hunks(): number | null;
  scrollToHunk(i: number): void;
  firstChange(i: number): number | null;
  /** The new-file line under the cursor when the keyboard is in this file's diff. */
  cursorLine(): number | null;
  /** ⌘⌥C: a comment box for this file's selection (false: nothing selected here). */
  comment(focusedOnly: boolean): boolean;
  /** Another file's diff took the selection: this one lets its go. */
  clearSelection(): void;
}

const KIND_CLASS: Record<string, string> = { M: 'k-mod', A: 'k-add', '?': 'k-add', D: 'k-del', R: 'k-ren', U: 'k-conf' };

async function loadFile(row: ChangeRow, rev: string): Promise<Loaded> {
  const cur = row.kind === 'D' ? null : await window.atelier.files.read(row.path).catch(() => null);
  if (cur && (cur.kind === 'binary' || cur.kind === 'too-large')) return { kind: cur.kind === 'binary' ? 'binary' : 'too-big' };
  if (row.kind !== 'D' && cur && cur.kind !== 'text' && cur.kind !== 'missing') return { kind: 'unreadable' };
  const text = cur?.kind === 'text' ? normalizeEol(cur.text) : '';
  const basePath = row.kind === 'R' && row.origRel ? `${row.repo}/${row.origRel}` : row.path;
  const base = row.kind === '?' ? '' : normalizeEol((await window.atelier.git.base(basePath, rev).catch(() => ({ original: null }))).original ?? '');
  const diff = unifiedDoc(base, text);
  if (!diff) return { kind: 'too-big' };
  const hunks = hunksOf(diff);
  if (!hunks.length) return { kind: 'empty' };
  const doc = compactDoc(diff, hunks);
  return doc.lines.length > MAX_REVIEW_LINES ? { kind: 'too-big' } : { kind: 'diff', doc, text };
}

/** Same text, same rows and hunks: nothing to redraw. */
function sameDoc(a: ReviewDoc, b: ReviewDoc): boolean {
  return a.text === b.text && a.lines.length === b.lines.length && a.hunks.length === b.hunks.length
    && a.lines.every((l, i) => l.kind === b.lines[i]!.kind && l.newNo === b.lines[i]!.newNo)
    && a.hunks.every((h, i) => h.header === b.hunks[i]!.header && h.line === b.hunks[i]!.line);
}

interface FileProps {
  row: ChangeRow; index: number; rev: string; reload: number; collapsed: boolean; current: number | null; scroller: HTMLElement | null;
  onToggle: (path: string, all: boolean) => void; onPick: (stop: NavStop) => void; register: (i: number, h: FileHandle | null) => void;
  onFocusDiff: (i: number) => void;
}

/** A comment on lines the review doesn't show (outside the hunks): its card, outdated against the file's text. */
function OutsideComment({ id, text }: { id: string; text: string | null }) {
  const outdated = useApp((s) => { const c = s.comments.find((x) => x.id === id); return !!c && isOutdated(c, text); });
  return <CommentCard id={id} outdated={outdated} />;
}

const ReviewFile = memo(function ReviewFile({ row, index, rev, reload, collapsed, current, scroller, onToggle, onPick, register, onFocusDiff }: FileProps) {
  const section = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [seen, setSeen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const wordWrap = useApp((s) => s.settings.wordWrap);
  const sessionOrder = useApp((s) => sessionOrderKey(s.terminals));

  // Files load as they scroll in (and stay loaded).
  useEffect(() => {
    const el = section.current;
    if (!el || seen || !scroller) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { root: scroller, rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen, scroller]);

  const key = `${row.kind}:${row.added}:${row.removed}:${rev}:${reload}`;
  useEffect(() => {
    if (!seen) return;
    let alive = true;
    void loadFile(row, rev).then((l) => { if (alive) setLoaded(l); });
    return () => { alive = false; };
  }, [seen, key]);

  const doc = loaded?.kind === 'diff' ? loaded.doc : null;
  const docRef = useRef<ReviewDoc | null>(null);
  docRef.current = doc;
  // Line comments: anchored to the new file's lines, the diff's rows map them.
  const textRef = useRef<string | null>(null);
  textRef.current = loaded?.kind === 'diff' ? loaded.text : null;
  const commentSrc = useRef<CommentSource>({ path: row.path, rows: () => docRef.current?.lines ?? null, text: () => textRef.current });
  commentSrc.current.path = row.path;
  const bound = useRef<{ refresh: () => void; dispose: () => void } | null>(null);
  const currentRef = useRef(current);
  currentRef.current = current;
  // What changes with the diff (rows, hunk headers) and with word wrap: reconfigured in place, never a new editor.
  const diffConf = useRef(new Compartment());
  const wrapConf = useRef(new Compartment());
  const shown = useRef<ReviewDoc | null>(null);
  const hlKey = `review:${row.path}`;
  const paint = (v: EditorView, text: string) => {
    const lang = languageFor(row.path);
    if (lang) void highlight(text, lang, hlKey).then((spans) => { if (view.current === v && spans && spans !== 'dropped' && v.state.doc.toString() === text) v.dispatch({ effects: setTokens.of(spans) }); });
  };
  const hasDoc = !!doc;
  // The editor is made when the diff first shows (or the file is expanded) and kept while the diff changes, so a
  // comment being written under it, the cards and the scroll position stay as they are.
  useEffect(() => {
    if (!doc || collapsed || !host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: doc.text,
        extensions: [
          // Read-only content has no native selection highlight: drawn by the editor, so a selection to comment on shows.
          EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ tabindex: '-1' }), drawSelection(),
          // Focusable for the keyboard (⌘⌥C, the selection) but nothing to type into: no caret, an arrow pointer.
          noCaret,
          diffConf.current.of([...diffExtensions(doc), hunkHeaders(doc)]), tokenField, cmTheme,
          wrapConf.current.of(useApp.getState().settings.wordWrap ? EditorView.lineWrapping : []), keymap.of(wordWrapKeys()),
          ...commentExtensions((cv) => { if (!openDraftFrom(cv, commentSrc.current)) useApp.getState().showToast(t.comments.selectLines, undefined, 'info'); })
        ]
      })
    });
    view.current = v;
    shown.current = doc;
    const b = bindComments(v, commentSrc.current);
    bound.current = b;
    if (currentRef.current !== null) v.dispatch({ effects: setCurrentHunk.of(currentRef.current) });
    paint(v, doc.text);
    return () => { cancelHighlight(hlKey); b.dispose(); if (bound.current === b) bound.current = null; v.destroy(); if (view.current === v) view.current = null; shown.current = null; };
  }, [hasDoc, collapsed]);
  // A new diff of the same file (written on disk, new counts, another base): only what changed is redrawn.
  useEffect(() => {
    const v = view.current;
    const prev = shown.current;
    if (!v || !doc || !prev || prev === doc) return;
    shown.current = doc;
    if (sameDoc(prev, doc)) return;
    const change = minimalChange(v.state.doc.toString(), doc.text);
    v.dispatch({ ...(change ? { changes: change } : {}), effects: diffConf.current.reconfigure([...diffExtensions(doc), hunkHeaders(doc)]) });
    v.dispatch({ effects: setCurrentHunk.of(currentRef.current) });
    bound.current?.refresh();
    paint(v, doc.text);
  }, [doc]);
  useEffect(() => {
    view.current?.dispatch({ effects: wrapConf.current.reconfigure(wordWrap ? EditorView.lineWrapping : []) });
  }, [wordWrap]);
  // Comments whose lines are not among the hunks shown: listed under the file's diff.
  const outside = useApp((s) => s.comments.filter((c) => c.path === row.path && (!doc || docLineOf(doc.lines, c.end, doc.lines.length) === null)).map((c) => c.id).join(','));
  const outsideIds = outside ? outside.split(',') : [];
  const loadedText = loaded?.kind === 'diff' ? loaded.text : null;

  useEffect(() => { view.current?.dispatch({ effects: setCurrentHunk.of(current) }); }, [current]);

  useEffect(() => {
    register(index, {
      hunks: () => (collapsed || !docRef.current ? null : docRef.current.hunks.length),
      firstChange: (i) => docRef.current?.hunks[i]?.firstChange ?? null,
      scrollToHunk: (i) => {
        const v = view.current; const d = docRef.current; const sc = scroller;
        const h = d?.hunks[i];
        if (!v || !h || !sc) { section.current?.scrollIntoView({ block: 'start' }); return; }
        const block = v.lineBlockAt(v.state.doc.line(h.line).from);
        const head = section.current?.querySelector('.rv-file-head')?.getBoundingClientRect().height ?? 0;
        sc.scrollTop += v.documentTop + block.top - sc.getBoundingClientRect().top - head - 4;
      },
      cursorLine: () => {
        const v = view.current; const d = docRef.current;
        if (!v || !d || !v.hasFocus) return null;
        const n = v.state.doc.lineAt(v.state.selection.main.head).number;
        return d.lines.slice(n - 1).find((l) => l.newNo !== null)?.newNo ?? null;
      },
      comment: (focusedOnly) => {
        const v = view.current;
        if (!v || v.state.selection.main.empty || (focusedOnly && !v.hasFocus)) return false;
        return openDraftFrom(v, commentSrc.current);
      },
      clearSelection: () => {
        const v = view.current;
        if (v && !v.state.selection.main.empty) v.dispatch({ selection: { anchor: v.state.selection.main.head } });
      }
    });
    return () => register(index, null);
  }, [index, collapsed, scroller, register]);

  const parts = row.rel.split('/');
  const name = parts.pop() ?? row.rel;
  const dir = parts.join('/');
  const clash = clashNames(row, sessionOrder.split('\n'));
  const open = (line: number | null) => useApp.getState().openFile(row.path, row.rel, line, 'margin');
  const deleted = row.kind === 'D';
  const onBodyClick = (e: ReactMouseEvent) => {
    const head = (e.target as HTMLElement).closest('.rv-hunk-head') as HTMLElement | null;
    if (head?.dataset.hunk) onPick({ file: index, hunk: Number(head.dataset.hunk) });
  };
  return (
    <section ref={section} className={`rv-file ${current !== null ? 'is-current' : ''}`} data-path={row.path} aria-label={row.rel}>
      <div className="rv-file-head">
        <button type="button" className="rv-file-toggle" aria-expanded={!collapsed} data-tip={t.review.collapseTip} onClick={(e) => onToggle(row.path, e.altKey)}>
          <span className={`change-group-chev ${collapsed ? '' : 'is-open'}`} aria-hidden="true"><Icon name="chevron" size={12} stroke={2} /></span>
          <FileIcon name={name} size={15} />
          <span className="rv-file-path mono">{dir && <span className="rv-file-dir">{dir}/</span>}<b>{name}</b></span>
        </button>
        <span className={`change-kind mono ${KIND_CLASS[row.kind] ?? ''}`}>{row.kind === '?' ? 'A' : row.kind}</span>
        {clash.length >= 2 && <span className="rv-clash" data-tip={touchedBy(clash)}><i />{clash.length > 2 ? t.manySessions(1) : t.twoSessions}</span>}
        <span className="grow" />
        <span className="change-by"><OriginMarks row={row} button /></span>
        <span className="rv-delta mono">{row.added !== null && <span className="rv-plus">+{row.added}</span>}{!!row.removed && <span className="rv-minus">−{row.removed}</span>}</span>
        <button type="button" className="btn-ghost sm rv-open" disabled={deleted} data-tip={t.review.openFileTip}
          onClick={() => open(doc?.hunks[0]?.firstChange ?? null)}>{t.review.openFile}</button>
      </div>
      {!collapsed && (
        <div className="rv-body" onClick={onBodyClick} onDoubleClick={(e) => {
          const head = (e.target as HTMLElement).closest('.rv-hunk-head') as HTMLElement | null;
          if (head?.dataset.hunk && !deleted) open(doc?.hunks[Number(head.dataset.hunk)]?.firstChange ?? null);
        }}>
          {!loaded && <div className="rv-note">{t.review.loading}</div>}
          {loaded && loaded.kind !== 'diff' && (
            <div className="rv-note">
              {loaded.kind === 'too-big' ? t.review.tooBig : loaded.kind === 'binary' ? t.review.binary : loaded.kind === 'empty' ? t.review.noDiff : t.review.unreadable}
              {!deleted && loaded.kind !== 'empty' && <button type="button" className="btn-ghost sm" onClick={() => open(null)}>{t.review.openFile}</button>}
            </div>
          )}
          {doc && <div ref={host} className="rv-code" onFocus={() => onFocusDiff(index)} />}
          {outsideIds.length > 0 && (
            <div className="rv-outside">
              <span className="section-label">{t.comments.outside}</span>
              {outsideIds.map((id) => <OutsideComment key={id} id={id} text={loadedText} />)}
            </div>
          )}
        </div>
      )}
    </section>
  );
});

/** focused / place: as TerminalView's (split view). */
/** The scope picker's linked worktrees, after the sessions. */
function worktreeScopes(repos: RepoStatus[]): MenuItem[] {
  const wts = repos.filter(isWorktree);
  if (!wts.length) return [];
  const rows = buildRows(repos, []);
  return ['sep', ...wts.map((w): MenuItem => {
    const name = w.root.split('/').at(-1) ?? w.root;
    return { id: `scope-repo-${w.root}`, label: name, icon: 'branchOff', hint: t.review.files(rows.filter((r) => r.repo === w.root).length), run: () => useApp.getState().openReview(`repo:${w.root}`) };
  })];
}

export function ReviewView({ visible, focused = visible, place }: { visible: boolean; focused?: boolean; place?: CSSProperties }) {
  const review = useApp((s) => s.review);
  const rawRepos = useApp((s) => s.repos);
  // A worktree's folder is never an untracked file of its repo (worktrees in Changes).
  const repos = useMemo(() => hideWorktreeFolders(rawRepos), [rawRepos]);
  const attributions = useApp((s) => s.attributions);
  const terminals = useApp((s) => s.terminals);
  // Compare with main chooses for this opening only; the saved toggle applies otherwise.
  const savedAgainstMain = useApp((s) => s.reviewAgainstMain);
  const againstMain = review?.againstMain ?? savedAgainstMain;
  const scope = review?.scope ?? 'all';
  const [compares, setCompares] = useState<RepoCompare[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [cur, setCur] = useState<NavStop | null>(null);
  const [reloads, setReloads] = useState<Record<string, number>>({});
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const handles = useRef(new Map<number, FileHandle>());
  const register = useCallback((i: number, h: FileHandle | null) => { if (h) handles.current.set(i, h); else handles.current.delete(i); }, []);

  // The comparison with the default branch: read when shown and after every git status (it decides the toggle).
  const first = useRef(true);
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => { void window.atelier.git.compare().then(setCompares).catch(() => setCompares([])); }, first.current ? 0 : 400);
    first.current = false;
    return () => clearTimeout(timer);
  }, [visible, repos]);

  const avail = compareAvailable(compares);
  const useMain = againstMain && !!avail;
  const rows = useMemo(() => reviewRows(repos, attributions, scope, useMain ? compares : null), [repos, attributions, scope, useMain, compares]);
  const body = reviewBody(againstMain, compares, rows.length);
  const title = reviewScopeTitle(scope, terminals, attributions);
  const added = rows.reduce((n, r) => n + (r.added ?? 0), 0);
  const removed = rows.reduce((n, r) => n + (r.removed ?? 0), 0);

  const handlesPaths = useRef(new Set<string>());
  handlesPaths.current = new Set(rows.map((r) => r.path));
  // A file written on disk reloads its hunks (the counts alone can stay the same).
  useEffect(() => window.atelier.on.fsChanged((paths) => {
    setReloads((r) => {
      let next: Record<string, number> | null = null;
      for (const p of new Set(paths)) if (handlesPaths.current.has(p)) { next ??= { ...r }; next[p] = (next[p] ?? 0) + 1; }
      return next ?? r;
    });
  }), []);

  useEffect(() => { setCur(null); }, [scope, useMain]);
  useEffect(() => {
    if (!visible || !focused) return;
    root.current?.focus({ preventScroll: true });
  }, [visible, focused, review?.nonce]);

  const toggle = useCallback((path: string, all: boolean) => {
    setCollapsed((c) => {
      const closing = !c.has(path);
      if (!all) { const n = new Set(c); if (closing) n.add(path); else n.delete(path); return n; }
      return closing ? new Set(handlesPaths.current) : new Set();
    });
  }, []);

  const go = (stop: NavStop | null) => {
    if (!stop) return;
    setCur(stop);
    const h = handles.current.get(stop.file);
    if (stop.hunk >= 0 && h) h.scrollToHunk(stop.hunk);
    else scroller?.querySelectorAll<HTMLElement>('.rv-file')[stop.file]?.scrollIntoView({ block: 'start' });
  };
  const onPick = useCallback((stop: NavStop) => setCur(stop), []);
  // One selection at a time across the files' diffs (each has its own editor), so one "Comment" button.
  const onFocusDiff = useCallback((i: number) => { for (const [j, h] of handles.current) if (j !== i) h.clearSelection(); }, []);
  // ⌘⌥C: the diff with the keyboard, else any diff with a selection.
  useEffect(() => registerCommentTarget('review', () => {
    const all = [...handles.current.values()];
    return all.some((h) => h.comment(true)) || all.some((h) => h.comment(false));
  }), []);
  const pending = useApp((s) => {
    const by = new Map<string, number>();
    for (const c of s.comments) if (c.target && isPending(c, c.target)) by.set(c.target, (by.get(c.target) ?? 0) + 1);
    return [...by.entries()].filter(([id]) => scope === 'all' || id === scope).map(([id, n]) => `${id}:${n}`).join(',');
  });
  const pendingList = pending ? pending.split(',').map((x) => { const i = x.lastIndexOf(':'); return { id: x.slice(0, i), n: Number(x.slice(i + 1)) }; }) : [];
  // Re-render when a session's prompt becomes free or busy (the Send button says why it waits).
  useApp((s) => pendingList.map((p) => `${p.id}:${s.terminals.find((x) => x.id === p.id)?.session?.state ?? ''}:${s.terminals.find((x) => x.id === p.id)?.foreground ?? ''}`).join(','));

  const onKey = (e: ReactKeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
    // ⌥Z from the Review's keyboard area; in a diff's text the editor has taken it already,
    // in a comment being written it types.
    if (!e.defaultPrevented && isWordWrapKey(e.nativeEvent)) { e.preventDefault(); if (!e.repeat) toggleWordWrap(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (el instanceof HTMLButtonElement && (e.key === 'Enter' || e.key === ' ')) return;
    const stops = () => navStops(rows.map((r, i) => (collapsed.has(r.path) ? null : handles.current.get(i)?.hunks() ?? null)));
    const k = e.key;
    if (k === 'ArrowDown' || k === 'j') go(stepNav(stops(), cur, 'hunk', 1));
    else if (k === 'ArrowUp' || k === 'k') go(stepNav(stops(), cur, 'hunk', -1));
    else if (k === 'n') go(stepNav(stops(), cur, 'file', 1));
    else if (k === 'p') go(stepNav(stops(), cur, 'file', -1));
    else if (k === 'Enter') {
      // The line under the cursor when the keyboard is in a diff, else the current hunk's first change.
      const focused = [...handles.current.entries()].map(([i, h]) => ({ i, line: h.cursorLine() })).find((x) => x.line !== null);
      const target = focused ? { i: focused.i, line: focused.line } : cur ? { i: cur.file, line: cur.hunk >= 0 ? handles.current.get(cur.file)?.firstChange(cur.hunk) ?? null : null } : null;
      const row = target ? rows[target.i] : undefined;
      if (!row || row.kind === 'D') return;
      useApp.getState().openFile(row.path, row.rel, target!.line, 'margin');
    } else return;
    e.preventDefault();
  };

  const pickScope = (el: HTMLElement) => {
    const groups = groupBySession(buildRows(repos, attributions)).filter((g) => g.key !== 'unknown');
    openBelow(el, [
      { id: 'scope-all', label: t.review.allChanges, icon: 'review', run: () => useApp.getState().openReview('all') },
      'sep',
      ...groups.map((g) => ({ id: `scope-${g.key}`, label: g.title, hint: t.review.files(g.rows.length + g.maybe.length), run: () => useApp.getState().openReview(g.key) })),
      ...worktreeScopes(repos)
    ]);
  };

  const scopeColor = scope === 'all' ? null : terminals.find((x) => x.id === scope)?.color ?? attributions.find((a) => a.terminalId === scope)?.color ?? null;
  return (
    <section className="review-view" style={{ display: visible ? 'flex' : 'none', ...place }} aria-label={t.review.tab(title)}>
      <div className="rv-bar">
        <span className="rv-bar-icon"><Icon name="review" size={15} /></span>
        <span className="rv-bar-title">{t.review.title}</span>
        <button type="button" className="rv-scope" data-tip={t.review.scopeTip} onClick={(e) => pickScope(e.currentTarget)}>
          {scopeColor ? <i className="dot" style={{ background: scopeColor }} /> : null}
          <span>{title}</span>
          <Icon name="chevronDown" size={12} stroke={2} />
        </button>
        <span className="rv-count">{t.review.files(rows.length)}</span>
        <span className="rv-delta mono"><span className="rv-plus">+{added}</span><span className="rv-minus">−{removed}</span></span>
        <span className="grow" />
        {pendingList.map((p) => {
          const term = terminals.find((x) => x.id === p.id);
          const name = term?.title ?? t.review.closedSession;
          const why = sendReason(p.id);
          return (
            <span key={p.id} className="rv-pending">
              <span className="rv-pending-chip" data-tip={t.comments.pendingTip(p.n, name)}>
                {term && <i className="dot id-dot" style={idStyle(term.color)} />}
                <Icon name="comment" size={12} stroke={1.9} />{scope === 'all' ? `${name} · ${p.n}` : t.comments.pending(p.n)}
              </span>
              <button type="button" className="btn-primary sm rv-send" aria-disabled={why !== null || undefined}
                data-tip={why ?? t.comments.sendTo(name)} onClick={() => sendReview(p.id)}>
                <Icon name="send" size={12} stroke={1.9} />{t.comments.send}
              </button>
            </span>
          );
        })}
        {avail && (
          <button type="button" className={`rv-toggle ${againstMain ? 'is-on' : ''}`} aria-pressed={againstMain}
            data-tip={t.review.againstMainTip(avail.base, avail.commits)} onClick={() => { const st = useApp.getState(); st.setReviewAgainstMain(!againstMain); if (st.review?.againstMain !== undefined) useApp.setState({ review: { scope: st.review.scope, nonce: st.review.nonce } }); }}>
            <Icon name="git" size={12} stroke={1.9} />{t.review.againstMain(avail.base)}
          </button>
        )}
        <span className="rv-keys mono">{t.review.keysHint}</span>
      </div>
      <div ref={(el) => { root.current = el; setScroller(el); }} className="rv-scroll" tabIndex={0} onKeyDown={onKey}>
        {body === 'comparing' && (
          <div className="rv-empty rv-comparing" role="status">
            <span className="dp-spinner" aria-hidden="true" />
            <span>{t.review.comparing}</span>
          </div>
        )}
        {body === 'empty' && (
          <div className="rv-empty">
            <span className="clean-badge"><Icon name="check" size={13} stroke={2.6} /></span>
            <span>{scope === 'all' ? t.review.emptyAll : t.review.emptySession(title)}</span>
          </div>
        )}
        {body === 'files' && rows.map((r, i) => (
          <ReviewFile key={`${r.repo}:${r.path}`} row={r} index={i} rev={baseRevOf(r, useMain ? compares : null)} reload={reloads[r.path] ?? 0}
            collapsed={collapsed.has(r.path)} current={cur?.file === i ? cur.hunk : null} scroller={scroller}
            onToggle={toggle} onPick={onPick} register={register} onFocusDiff={onFocusDiff} />
        ))}
      </div>
    </section>
  );
}
