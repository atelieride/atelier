import { useEffect, type CSSProperties } from 'react';
import { ACTION_TOAST_MS, useApp, type AppState, type ToastAction } from '../store';
import { useDrawnWidth } from '../panel-drawn';

/** A toast's buttons as a list: none, one, or two (Push and Undo after a commit). */
export function toastActions(toast: Pick<NonNullable<AppState['toast']>, 'action' | 'second'>): ToastAction[] {
  return [toast.action, toast.second].filter((a): a is ToastAction => !!a);
}

/** How far left of the window's edge toasts sit: beside the Changes panel when it is open on the right, never over it. */
export function toastInset(o: { project: boolean; showChanges: boolean; swapped: boolean; changesWidth: number }): number {
  return o.project && o.showChanges && !o.swapped ? o.changesWidth : 0;
}

/**
 * Short message at the bottom right (beside the Changes panel): closes by itself after 5 seconds (8 with an action, or
 * its own duration) or on click.
 */
export function Toast() {
  const toast = useApp((s) => s.toast);
  // Beside Changes as drawn: a small window draws it narrower than its saved width.
  const changesShown = useApp((s) => s.showChanges);
  const drawn = useDrawnWidth('changes', !!toast && changesShown);
  const inset = useApp((s) => toastInset({ project: !!s.project, showChanges: s.showChanges, swapped: s.settings.swapSidePanels, changesWidth: drawn ?? s.panels.changes }));
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => useApp.getState().showToast(null), toast.ms ?? (toast.action ? ACTION_TOAST_MS : 5000));
    return () => clearTimeout(timer);
  }, [toast]);
  return <ToastView toast={toast} inset={inset} />;
}

export function ToastView({ toast, inset = 0 }: { toast: AppState['toast']; inset?: number }) {
  if (!toast) return null;
  const close = () => useApp.getState().showToast(null);
  const tone = toast.tone === 'info' ? ' is-info' : '';
  const actions = toastActions(toast);
  const style = inset ? ({ ['--toast-inset' as string]: `${inset}px` } as CSSProperties) : undefined;
  if (!actions.length) return <button type="button" key={toast.nonce} className={`toast${tone}`} role="status" style={style} onClick={close}><i />{toast.text}</button>;
  return (
    <div key={toast.nonce} className={`toast has-action${tone}`} role="status" style={style}>
      <i /><span className="toast-text">{toast.text}</span>
      {actions.map(({ label, run }) => <button key={label} type="button" className="toast-action" onClick={() => { close(); run(); }}>{label}</button>)}
    </div>
  );
}
