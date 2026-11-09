// Line comments: the box that writes one and the card of a saved one. Rendered under the commented
// lines inside editors and the review view (each in its own React root, reading the store).
import { useEffect, useRef, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';
import { EditorView } from '@codemirror/view';
import { useApp } from '../store';
import { t } from '../i18n/en';
import { MAX_COMMENT } from '../comments';
import { openBelow } from '../menus';
import { Icon } from './Icon';
import { idStyle } from '../avatar';

/**
 * "To <session> ▾": the session the comment goes to; any Claude session can be picked. `ask`: the file is attributed
 * to none or several sessions, so the default (the session selected last) deserves a look.
 */
function TargetPicker({ value, onPick, ask = false }: { value: string | null; onPick: (id: string) => void; ask?: boolean }) {
  const term = useApp((s) => s.terminals.find((x) => x.id === value && x.session));
  return (
    <button type="button" className={`lc-target ${ask ? 'is-ask' : ''}`} data-tip={t.comments.toTip} onClick={(e) => {
      const sessions = useApp.getState().terminals.filter((x) => x.session);
      openBelow(e.currentTarget, sessions.map((x) => ({ id: `to-${x.id}`, label: x.title, icon: x.id === value ? 'check' as const : undefined, run: () => onPick(x.id) })));
    }}>
      {term ? <i className="dot id-dot" style={idStyle(term.color)} /> : <i className="dot unknown" />}
      <span>{term ? t.comments.to(term.title) : t.comments.noTarget}</span>
      <Icon name="chevronDown" size={11} stroke={2} />
    </button>
  );
}

/**
 * After the box or the edit closes, the keyboard goes back to where the comment was written: the review (its keys
 * j/k/n/p) or the editor. Called before the box goes away, while it is still in the page.
 */
function giveKeyboardBack(from: HTMLElement | null) {
  keyboardIn = null;
  if (!from) return;
  const review = from.closest<HTMLElement>('.rv-scroll');
  if (review) { review.focus({ preventScroll: true }); return; }
  const cm = from.closest<HTMLElement>('.cm-editor');
  if (cm) EditorView.findFromDOM(cm)?.focus();
}

/** ⌘Enter saves, Esc cancels; the keys never reach the editor or the review around the box. */
function boxKeys(e: KeyboardEvent<HTMLTextAreaElement>, save: () => void, cancel: () => void) {
  e.stopPropagation();
  const el = e.currentTarget;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
  else if (e.key === 'Escape') { e.preventDefault(); giveKeyboardBack(el); cancel(); }
}

/**
 * The comment field that has the keyboard ('draft:<nonce>' or 'edit:<id>'). A field only drawn again (the diff under
 * it rebuilt, the card redrawn) leaves the page without a real blur, so this stays and the new field takes it back.
 */
let keyboardIn: string | null = null;
/** Draft boxes that already had the keyboard once (a later mount of the same box is a redraw). */
let focusedDraft: number | null = null;
/** The card whose Edit was just pressed. */
let editStarted: string | null = null;

/** Focus for a comment field: taken when it is new (`fresh`) or when it is the one the keyboard was in. */
function useCommentField(area: RefObject<HTMLTextAreaElement | null>, key: string | null, fresh: () => boolean, onFocused: () => void) {
  useEffect(() => {
    const el = area.current;
    // Not in a hidden tab (the same file's box can be drawn in the review and in an editor at once).
    if (!key || !el || !el.getClientRects().length) return;
    if (!fresh() && keyboardIn !== key) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollIntoView({ block: 'nearest' });
  }, [key]);
  return {
    onFocus: () => { keyboardIn = key; onFocused(); },
    onBlur: (e: FocusEvent<HTMLTextAreaElement>) => {
      const el = e.currentTarget;
      // Still in the page: a real blur (a click elsewhere). Gone: only redrawn.
      queueMicrotask(() => { if (el.isConnected && keyboardIn === key) keyboardIn = null; });
    }
  };
}

/** The comment being written under the selected lines. */
export function CommentBox() {
  const draft = useApp((s) => s.commentDraft);
  const area = useRef<HTMLTextAreaElement>(null);
  const field = useCommentField(area, draft ? `draft:${draft.nonce}` : null, () => !!draft && focusedDraft !== draft.nonce,
    () => { if (draft) focusedDraft = draft.nonce; });
  if (!draft) return null;
  const { text, target } = draft;
  const save = () => {
    const body = text.trim();
    if (!body) return;
    const st = useApp.getState();
    giveKeyboardBack(area.current);
    st.addComment({ path: draft.path, start: draft.start, end: draft.end, snippet: draft.snippet, target, text: body });
    st.closeCommentDraft();
  };
  const cancel = () => useApp.getState().closeCommentDraft();
  const setTarget = (to: string) => useApp.getState().updateCommentDraft({ target: to });
  const setText = (v: string) => useApp.getState().updateCommentDraft({ text: v });
  return (
    <div className="lc-box" role="group" aria-label={t.comments.lines(draft.start, draft.end)}>
      <div className="lc-head">
        <span className="lc-icon"><Icon name="comment" size={13} stroke={1.8} /></span>
        <span className="lc-lines mono">{t.comments.lines(draft.start, draft.end)}</span>
        <TargetPicker value={target} onPick={setTarget} ask={draft.ambiguous || target === null} />
      </div>
      <textarea ref={area} className="lc-input" rows={3} maxLength={MAX_COMMENT} placeholder={t.comments.placeholder} value={text}
        aria-label={t.comments.placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => boxKeys(e, save, cancel)} {...field} />
      <div className="lc-actions">
        <span className="grow" />
        <button type="button" className="btn-ghost sm" onClick={() => { giveKeyboardBack(area.current); cancel(); }}>{t.comments.cancel}</button>
        <button type="button" className="btn-primary sm" disabled={!text.trim()} onClick={save}>{t.comments.save}<span className="kbd-in">{t.comments.saveHint}</span></button>
      </div>
    </div>
  );
}

/** A saved comment: its lines, its session, "outdated" when the file changed under it; editable and deletable. */
export function CommentCard({ id, outdated }: { id: string; outdated: boolean }) {
  const c = useApp((s) => s.comments.find((x) => x.id === id));
  const edit = useApp((s) => s.commentEdits[id]);
  const editing = edit !== undefined;
  const text = edit ?? '';
  const area = useRef<HTMLTextAreaElement>(null);
  const field = useCommentField(area, editing ? `edit:${id}` : null, () => editStarted === id, () => { if (editStarted === id) editStarted = null; });
  if (!c) return null;
  const st = useApp.getState;
  const setText = (v: string) => st().setCommentEdit(id, v);
  const setEditing = (on: boolean) => { if (on) editStarted = id; st().setCommentEdit(id, on ? c.text : null); };
  const stopEditing = () => { giveKeyboardBack(area.current); setEditing(false); };
  const save = () => { const body = text.trim(); if (!body) return; giveKeyboardBack(area.current); st().updateComment(id, { text: body }); setEditing(false); };
  return (
    <div className={`lc-card ${outdated ? 'is-outdated' : ''}`} role="group" aria-label={t.comments.lines(c.start, c.end)} data-comment={id}>
      <div className="lc-head">
        <span className="lc-icon"><Icon name="comment" size={13} stroke={1.8} /></span>
        <span className="lc-lines mono">{t.comments.lines(c.start, c.end)}</span>
        <TargetPicker value={c.target} onPick={(to) => st().updateComment(id, { target: to })} />
        {c.gone
          ? <span className="lc-outdated" data-tip={t.comments.fileDeletedTip}>{t.comments.fileDeleted}</span>
          : outdated && <span className="lc-outdated" data-tip={t.comments.outdatedTip}>{t.comments.outdated}</span>}
        <span className="grow" />
        {c.gone && <button type="button" className="lc-act" data-tip={t.comments.keepTip} onClick={() => st().keepComments([id])}>{t.comments.keep}</button>}
        {!editing && <button type="button" className="lc-act" onClick={() => setEditing(true)}>{t.comments.edit}</button>}
        <button type="button" className="lc-act is-danger" onClick={() => st().deleteComment(id)}>{t.comments.delete}</button>
      </div>
      {editing ? (
        <>
          <textarea ref={area} className="lc-input" rows={3} maxLength={MAX_COMMENT} value={text} aria-label={t.comments.placeholder}
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => boxKeys(e, save, () => setEditing(false))} {...field} />
          <div className="lc-actions">
            <span className="grow" />
            <button type="button" className="btn-ghost sm" onClick={stopEditing}>{t.comments.cancel}</button>
            <button type="button" className="btn-primary sm" disabled={!text.trim()} onClick={save}>{t.comments.save}<span className="kbd-in">{t.comments.saveHint}</span></button>
          </div>
        </>
      ) : <p className="lc-text">{c.text}</p>}
    </div>
  );
}
