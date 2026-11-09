// The pieces every in-app confirm shares: the safe answer takes the focus, Esc and a click
// outside cancel, the danger button says what happens.
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import type { CloseStops } from '@shared/close-plan';
import type { CloseNote } from './slice';
import { whenOf } from '../schedule-view';
import { kbd } from '../kbd';
import { t } from '../i18n/en';
import { swallowEnter } from '../git/sheet-keys';

/**
 * Esc (inside) and a pointer press outside `box` cancel; the element marked data-autofocus takes the focus once.
 * data-own-esc on the box keeps the Settings sheet's own Esc away.
 */
export function useDismiss(box: RefObject<HTMLElement | null>, onCancel: () => void, restore?: string): void {
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const el = box.current;
    el?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    // The Enter that asked (a rename's field, a menu item) must not answer: its keypress lands on the button that just
    // took the focus. Held or just after the question appeared, Enter does nothing here.
    const mountedAt = performance.now();
    const enter = (e: KeyboardEvent) => {
      if (swallowEnter({ key: e.key, repeat: e.repeat, metaKey: e.metaKey, ctrlKey: e.ctrlKey }, mountedAt, performance.now())) { e.preventDefault(); e.stopPropagation(); }
    };
    el?.addEventListener('keydown', enter, true);
    el?.addEventListener('keypress', enter, true);
    const down = (e: PointerEvent) => {
      if (!el || !(e.target instanceof Element) || el.contains(e.target)) return;
      cancel.current();
    };
    // Capture: a press on another row's button cancels before that button acts (it may open its own question).
    window.addEventListener('pointerdown', down, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      el?.removeEventListener('keydown', enter, true);
      el?.removeEventListener('keypress', enter, true);
      // Answered from the keyboard: the focus goes back to what the question replaced (the row's own button), unless
      // something else took it meanwhile.
      if (!restore) return;
      requestAnimationFrame(() => {
        const now = document.activeElement;
        if (el?.isConnected && (!now || now === document.body)) el.querySelector<HTMLElement>(restore)?.focus({ preventScroll: true });
      });
    };
  }, [box, restore]);
}

/** Esc on the confirm itself: it answers Cancel and nothing underneath hears it (a terminal, a sheet). */
export function onEscCancel(onCancel: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  };
}

/**
 * The two answers: the danger one, and Cancel (focused, with its key). In a row they share its width, danger first;
 * in a popover or sheet they sit at the end, Cancel first (`end`).
 */
export function ConfirmActions({ confirm, onConfirm, onCancel, small = true, end = false }: { confirm: string; onConfirm: () => void; onCancel: () => void; small?: boolean; end?: boolean }) {
  const go = <button key="go" type="button" className={`btn-danger${small ? ' sm' : ''}`} onClick={onConfirm}>{confirm}</button>;
  const keep = <button key="keep" type="button" className={`btn-ghost${small ? ' sm' : ''}`} data-autofocus onClick={onCancel}>{t.confirm.cancel}<span className="confirm-key mono">{t.confirm.esc}</span></button>;
  return <div className={`confirm-actions${end ? ' is-end' : ''}`}>{end ? [keep, go] : [go, keep]}</div>;
}

/** What closing stops, the rose line under the question. */
export function stopsLine(stops: CloseStops): string {
  return stops.kind === 'claude' ? t.confirm.claudeStops[stops.doing] : t.confirm.processStops(stops.what);
}

/**
 * Where a closed session comes back from: the palette's Resume a session…, or — kept —
 * the sidebar's Resume. A scheduled prompt (`promptAt`, the first one) is sent only if the session is back by its time.
 */
export function ResumeNote({ note, promptAt, now = Date.now() }: { note: CloseNote; promptAt?: number; now?: number }): ReactNode {
  if (note === 'resume') return <span className="confirm-note">{t.confirm.keptNote}</span>;
  if (note === 'resume-scheduled') {
    const due = promptAt === undefined || promptAt <= now;
    return <span className="confirm-note">{due ? t.confirm.keptNoteScheduledDue : t.confirm.keptNoteScheduled(whenOf(promptAt, now))}</span>;
  }
  return <span className="confirm-note">{t.confirm.resumeLater} <span className="confirm-key mono">{kbd('⌘K')}</span> › {t.confirm.resumeWhere}</span>;
}
