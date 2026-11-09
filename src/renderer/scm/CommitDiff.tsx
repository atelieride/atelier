// One file's diff in the commit detail: unified, built like the Review's — both sides read,
// unifiedDoc → compact hunks → a read-only CodeMirror with the review decorations and syntax colors.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import type { ScmBlob } from '@shared/scm';
import { languageFor } from '@shared/languages';
import { cmTheme } from '../editor/cmTheme';
import { diffExtensions, setTokens, tokenField } from '../editor/decorations';
import { hunkHeaders, setCurrentHunk } from '../editor/review-decorations';
import { cancelHighlight, highlight } from '../editor/highlighter';
import { isWordWrapKey, toggleWordWrap, wordWrapKeys } from '../editor/word-wrap';
import { FileIcon } from '../components/FileIcon';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { buildDiff, diffPlan, sizeLabel, type DiffView } from './detail';
import type { DetailFile } from './CommitDetail';

const noCaret = EditorView.theme({ '.cm-cursorLayer': { display: 'none' }, '.cm-content': { caretColor: 'transparent', cursor: 'default' } });

type Shown = DiffView | { kind: 'loading' } | { kind: 'submodule'; to: string } | { kind: 'mode'; from: string; to: string };

/** The working tree's side of a file, as the editor reads it (the Changes panel's diff). */
async function diskBlob(path: string): Promise<ScmBlob | null> {
  const c = await window.atelier.files.read(path).catch(() => null);
  if (!c || c.kind === 'missing') return null;
  if (c.kind === 'binary') return { kind: 'binary', size: 0 };
  if (c.kind === 'too-large') return { kind: 'tooLarge', size: c.size };
  if (c.kind !== 'text') return { kind: 'missing' };
  return { kind: 'text', text: c.text, notUtf8: c.readOnly === 'not-utf8' };
}

async function load(repo: string, f: DetailFile, base: string, oid: string): Promise<Shown> {
  if (f.worktree) {
    const head = f.kind === 'D' ? null : await diskBlob(f.worktree);
    // The working tree's own HEAD (a linked worktree's, not the main repo's), read by commit id.
    const baseRel = f.kind === 'R' && f.origRel ? f.origRel : f.rel;
    const orig = f.kind === 'A' || !f.worktreeHead ? null : await window.atelier.scm.file(repo, f.worktreeHead, baseRel).catch((): ScmBlob => ({ kind: 'missing' }));
    return buildDiff(orig?.kind === 'missing' ? null : orig, head);
  }
  const plan = diffPlan(f, base, oid);
  if (plan.kind !== 'load') return plan;
  const read = (s: { oid: string; rel: string } | null) => (s ? window.atelier.scm.file(repo, s.oid, s.rel).catch((): ScmBlob => ({ kind: 'missing' })) : Promise.resolve(null));
  const [a, b] = await Promise.all([read(plan.base), read(plan.head)]);
  return buildDiff(a?.kind === 'missing' ? null : a, b?.kind === 'missing' ? null : b);
}

export function CommitDiff({ repo, file, base, oid, onOpen, onKeyNav }: { repo: string; file: DetailFile; base: string; oid: string; onOpen: () => void; onKeyNav: (e: ReactKeyboardEvent) => boolean }) {
  const [shown, setShown] = useState<Shown>({ kind: 'loading' });
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [hunk, setHunk] = useState<number | null>(null);
  const wordWrap = useApp((s) => s.settings.wordWrap);
  // Word wrap reconfigured in place (⌥Z here): never a new editor, so the place and the current hunk stay.
  const wrap = useRef(new Compartment());
  const key = `${repo}:${oid}:${base}:${file.rel}:${file.worktree ? file.added + ':' + file.removed : ''}`;
  useEffect(() => {
    let alive = true;
    setShown({ kind: 'loading' });
    setHunk(null);
    void load(repo, file, base, oid).then((s) => { if (alive) setShown(s); });
    return () => { alive = false; };
  }, [key]);
  const doc = shown.kind === 'diff' || shown.kind === 'notUtf8' ? shown.doc : null;
  useEffect(() => {
    if (!doc || !host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: doc.text,
        extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ tabindex: '-1' }), drawSelection(), noCaret,
          diffExtensions(doc), hunkHeaders(doc), tokenField, cmTheme, wrap.current.of(useApp.getState().settings.wordWrap ? EditorView.lineWrapping : []), keymap.of(wordWrapKeys())]
      })
    });
    view.current = v;
    const lang = languageFor(file.rel);
    const hl = `scm:${key}`;
    if (lang) void highlight(doc.text, lang, hl).then((spans) => { if (view.current === v && spans && spans !== 'dropped') v.dispatch({ effects: setTokens.of(spans) }); });
    return () => { cancelHighlight(hl); v.destroy(); if (view.current === v) view.current = null; };
  }, [doc]);
  useEffect(() => { view.current?.dispatch({ effects: wrap.current.reconfigure(wordWrap ? EditorView.lineWrapping : []) }); }, [wordWrap]);
  useEffect(() => { view.current?.dispatch({ effects: setCurrentHunk.of(hunk) }); }, [hunk, doc]);
  const goHunk = (dir: 1 | -1) => {
    const v = view.current;
    if (!v || !doc || !doc.hunks.length) return;
    const next = hunk === null ? (dir === 1 ? 0 : doc.hunks.length - 1) : Math.max(0, Math.min(doc.hunks.length - 1, hunk + dir));
    setHunk(next);
    const line = v.state.doc.line(doc.hunks[next]!.line);
    v.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 8 }) });
  };
  const onKey = (e: ReactKeyboardEvent) => {
    // ⌥Z from the diff's keyboard area; in its text the editor has taken it already.
    if (!e.defaultPrevented && isWordWrapKey(e.nativeEvent)) { e.preventDefault(); if (!e.repeat) toggleWordWrap(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); goHunk(1); return; }
    if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); goHunk(-1); return; }
    if (e.key === 'Enter' && file.kind !== 'D') { e.preventDefault(); onOpen(); return; }
    if (onKeyNav(e)) e.preventDefault();
  };
  const name = file.rel.split('/').at(-1) ?? file.rel;
  const dir = file.rel.split('/').slice(0, -1).join('/');
  return (
    <div className="cd-diff" tabIndex={0} onKeyDown={onKey} aria-label={file.rel}>
      <div className="cd-diff-head">
        <FileIcon name={name} size={15} />
        <span className="cd-diff-path mono">{dir && <span className="cd-dir">{dir}/</span>}<b>{name}</b>{file.origRel && <span className="cd-dir"> ← {file.origRel}</span>}</span>
        <span className="cd-delta mono">{file.added !== null && <span className="hv-plus">+{file.added}</span>}{!!file.removed && <span className="hv-minus">−{file.removed}</span>}</span>
        <span className="grow" />
        {!file.worktree && file.kind !== 'D' && <button type="button" className="btn-ghost sm" onClick={onOpen}>{t.scm.detail.openAtCommit}</button>}
      </div>
      {shown.kind === 'loading' && <div className="cd-note">{t.scm.detail.loading}</div>}
      {shown.kind === 'tooLarge' && <div className="cd-note"><Icon name="info" size={13} />{shown.size ? t.scm.detail.tooLargeSize(sizeLabel(shown.size)) : t.scm.detail.tooLarge}{!file.worktree && file.kind !== 'D' && <button type="button" className="btn-ghost sm" onClick={onOpen}>{t.scm.detail.openAtCommit}</button>}</div>}
      {shown.kind === 'binary' && <div className="cd-note"><Icon name="info" size={13} />{t.scm.detail.binary}</div>}
      {shown.kind === 'submodule' && <div className="cd-note"><Icon name="git" size={13} />{t.scm.detail.submodule(shown.to)}</div>}
      {shown.kind === 'mode' && <div className="cd-note"><Icon name="info" size={13} />{t.scm.detail.mode(shown.from, shown.to)}</div>}
      {shown.kind === 'empty' && <div className="cd-note">{t.scm.detail.noDiff}</div>}
      {shown.kind === 'notUtf8' && <div className="cd-note is-warn">{t.scm.detail.notUtf8}</div>}
      {doc && <div ref={host} className="cd-code" />}
    </div>
  );
}
