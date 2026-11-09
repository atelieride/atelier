// A file as it was at a commit: a read-only tab with the editor's surface (line numbers,
// colors, find) and nothing that edits, saves, mentions or comments. Closing it never asks anything.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { highlightSelectionMatches } from '@codemirror/search';
import { findExtensions, registerFindTarget } from '../editor/find/find-ext';
import { overviewRuler } from '../editor/ruler';
import { altGrTyping, defaultKeys, searchKeys } from '../editor/editor-keys';
import { wordWrapKeys } from '../editor/word-wrap';
import type { ScmBlob } from '@shared/scm';
import { languageFor } from '@shared/languages';
import { cmTheme } from '../editor/cmTheme';
import { setTokens, tokenField } from '../editor/decorations';
import { cancelHighlight, highlight } from '../editor/highlighter';
import { normalizeEol } from '../editor/conflict';
import { FileIcon } from '../components/FileIcon';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp, type RevFile } from '../store';

export function RevFileView({ file, visible, focused = visible, place }: { file: RevFile; visible: boolean; focused?: boolean; place?: CSSProperties }) {
  const [blob, setBlob] = useState<ScmBlob | null>(null);
  const [current, setCurrent] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const wordWrap = useApp((s) => s.settings.wordWrap);
  // Word wrap reconfigured in place (⌥Z here): never a new editor, so the place, selection, Find and focus stay.
  const wrap = useRef(new Compartment());
  const abs = `${file.root}/${file.rel}`;
  useEffect(() => {
    let alive = true;
    void window.atelier.scm.file(file.root, file.oid, file.rel).then((b) => { if (alive) setBlob(b); }).catch(() => { if (alive) setBlob({ kind: 'missing' }); });
    void window.atelier.files.read(abs).then((c) => { if (alive) setCurrent(c.kind !== 'missing' && c.kind !== 'outside'); }).catch(() => {});
    return () => { alive = false; };
  }, [file.key]);
  const text = blob?.kind === 'text' ? normalizeEol(blob.text) : null;
  useEffect(() => {
    if (text === null || !host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorState.allowMultipleSelections.of(true), lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(),
          ...findExtensions({ readOnly: true }), overviewRuler(), highlightSelectionMatches(), keymap.of([...searchKeys(), ...defaultKeys()]), keymap.of(wordWrapKeys()), altGrTyping, tokenField, cmTheme,
          // Not editable, so not focusable without a tabindex: the focus below, Find's keys and ⌥Z need it (as FileView).
          EditorView.contentAttributes.of({ tabindex: '0' }),
          wrap.current.of(useApp.getState().settings.wordWrap ? EditorView.lineWrapping : [])]
      })
    });
    view.current = v;
    const lang = languageFor(file.rel);
    const key = `rev:${file.key}`;
    if (lang) void highlight(text, lang, key).then((spans) => { if (view.current === v && spans && spans !== 'dropped') v.dispatch({ effects: setTokens.of(spans) }); });
    return () => { cancelHighlight(key); v.destroy(); if (view.current === v) view.current = null; };
  }, [text]);
  useEffect(() => { view.current?.dispatch({ effects: wrap.current.reconfigure(wordWrap ? EditorView.lineWrapping : []) }); }, [wordWrap]);
  useEffect(() => { if (visible && focused) view.current?.focus(); }, [visible, focused, text]);
  useEffect(() => registerFindTarget(file.key, { view: () => view.current, readOnly: () => true }), [file.key]);
  const name = file.rel.split('/').at(-1) ?? file.rel;
  const dir = file.rel.split('/').slice(0, -1).join('/');
  return (
    <section className="rev-view" style={{ display: visible ? 'flex' : 'none', ...place }} aria-label={t.scm.rev.title(name, file.oid.slice(0, 7))}>
      <div className="rev-head">
        <FileIcon name={name} size={15} />
        <span className="rev-path mono">{dir && <span className="cd-dir">{dir}/</span>}<b>{name}</b></span>
        <span className="rev-sha mono"><Icon name="git" size={11} stroke={1.9} />{file.oid.slice(0, 7)}</span>
        <span className="rev-ro"><Icon name="lock" size={10} stroke={2} />{t.scm.readOnly}</span>
        <span className="grow" />
        <button type="button" className="btn-ghost sm" disabled={!current} onClick={() => useApp.getState().openFile(abs, abs.startsWith((useApp.getState().project?.realRoot ?? '') + '/') ? abs.slice((useApp.getState().project?.realRoot ?? '').length + 1) : file.rel)}>{t.scm.rev.openCurrent}</button>
      </div>
      {blob === null && <div className="cd-note">{t.scm.detail.loading}</div>}
      {blob?.kind === 'missing' && <div className="cd-note">{t.scm.rev.missing}</div>}
      {blob?.kind === 'binary' && <div className="cd-note">{t.scm.rev.binary}</div>}
      {blob?.kind === 'tooLarge' && <div className="cd-note">{t.scm.rev.tooLarge}</div>}
      {blob?.kind === 'text' && blob.notUtf8 && <div className="cd-note is-warn">{t.scm.detail.notUtf8}</div>}
      {text !== null && <div ref={host} className="rev-code" />}
    </section>
  );
}
