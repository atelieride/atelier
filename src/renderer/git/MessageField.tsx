import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { t } from '../i18n/en';
import { SUBJECT_MAX, subjectCount } from './drawer';
import { isMod } from '@shared/keys';

/** The field grows with its text up to this many lines, then scrolls; a drawer dragged taller gives it more. */
const MAX_LINES = 8;

/**
 * Puts `text` in the field as one native undo step (⌘Z brings back what the field had before ✦): select all, then
 * insertText, which fires the input event the field listens to. Focus comes to the field for it, and goes back to
 * where it was when that was outside the drawer (a terminal). Where insertText isn't available, `fallback` sets it.
 */
export function replaceText(el: HTMLTextAreaElement, text: string, fallback: (text: string) => void): void {
  const prev = document.activeElement;
  const outside = prev instanceof HTMLElement && prev !== document.body && !el.closest('.git-drawer')?.contains(prev);
  el.focus({ preventScroll: true });
  el.select();
  let done = false;
  try { done = document.execCommand('insertText', false, text); } catch { done = false; }
  if (!done || el.value !== text) fallback(text);
  if (outside) prev.focus({ preventScroll: true });
}

/**
 * The commit message: the first line is the subject, with its counter (`44 / 72`, amber past
 * 72, never blocking). `⌘↵` commits; `⌘↑` opens the repository picker (`onPicker`). `accessory`: the slot at the
 * top-right (✦). `stream`: while ✦ writes, its text shows over the field, which keeps its own text untouched (a
 * failure leaves it as it was). `apply`: a text to put in as one undo step (✦ done or stopped), then `onApplied`.
 */
export function MessageField({ value, onChange, onCommit, onPicker, accessory, autoFocus, stream = null, apply = null, onApplied }: {
  value: string; onChange: (text: string) => void; onCommit: () => void; onPicker?: () => void; accessory?: ReactNode; autoFocus?: boolean;
  stream?: string | null; apply?: string | null; onApplied?: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const writing = stream !== null;
  // Its own height from the text, up to MAX_LINES: the minimum it keeps when the drawer is taller and fills it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 18;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    el.style.height = '0px';
    const content = el.scrollHeight;
    el.style.height = '';
    el.style.minHeight = `${Math.min(Math.max(content, line + pad), line * MAX_LINES + pad)}px`;
  }, [value]);
  useLayoutEffect(() => { if (autoFocus) ref.current?.focus({ preventScroll: true }); }, [autoFocus]);
  // The streamed text keeps its last line in view.
  useLayoutEffect(() => { const el = streamRef.current; if (el) el.scrollTop = el.scrollHeight; }, [stream]);
  // Right after React's commit (a microtask, still before paint): an input event fired inside the commit would have its
  // update deferred and React would put the old value back, breaking the undo step.
  useLayoutEffect(() => {
    if (apply === null) return;
    queueMicrotask(() => {
      const el = ref.current;
      if (el) replaceText(el, apply, onChange);
      onApplied?.();
    });
  }, [apply]);
  const count = subjectCount(stream ?? value);
  return (
    <div className={`git-msg ${accessory ? 'has-accessory' : ''} ${writing ? 'is-writing' : ''}`}>
      <textarea ref={ref} className="git-msg-input" rows={1} spellCheck value={value} aria-label={t.git.drawer.message} placeholder={t.git.drawer.placeholder}
        readOnly={writing} aria-busy={writing || undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          // A held ⌘↵ repeats: after this commit the drawer may move on to another repository, never committed by it.
          if (e.key === 'Enter' && isMod(e)) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) onCommit(); }
          else if (e.key === 'ArrowUp' && isMod(e) && onPicker) { e.preventDefault(); onPicker(); }
        }} />
      {writing && (
        <div ref={streamRef} className="git-msg-stream is-writing" aria-live="polite" onClick={() => ref.current?.focus({ preventScroll: true })}>
          <span className={stream ? undefined : 'is-empty'}>{stream || t.git.write.writingPlaceholder}</span>
        </div>
      )}
      {accessory && <div className="git-msg-slot">{accessory}</div>}
      {count.n > 0 && <span className={`git-msg-count mono ${count.over ? 'is-over' : ''}`} data-tip={t.git.drawer.subjectTip}>{count.n} / {SUBJECT_MAX}</span>}
    </div>
  );
}
