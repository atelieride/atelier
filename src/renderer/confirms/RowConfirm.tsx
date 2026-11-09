// Closing from a sidebar row: the row itself grows into the question.
import type { ReactNode, RefObject } from 'react';
import type { CloseStops } from '@shared/close-plan';
import { useApp } from '../store';
import { t } from '../i18n/en';
import { ConfirmActions, ResumeNote, stopsLine, useDismiss } from './InlineConfirm';
import type { CloseNote } from './slice';

/** A row's ×: asks, or closes at once; then its × is gone ("Closing…"), so the focus goes to the row's own button. */
export function closeFromRow(id: string, row: HTMLElement | null): void {
  useApp.getState().askClose(id, 'row');
  if (useApp.getState().closing[id]) row?.querySelector<HTMLElement>('.row-main')?.focus({ preventScroll: true });
}

export function RowCloseConfirm({ box, title, stops, note, promptAt, session, lead }: { box: RefObject<HTMLElement | null>; title: string; stops: CloseStops; note: CloseNote; promptAt?: number; session: boolean; lead: ReactNode }) {
  const cancel = () => useApp.getState().cancelClose();
  useDismiss(box, cancel, '.row-main');
  return (
    <>
      <div className="row-confirm-head">
        {lead}
        <span className="session-main">
          <span className="session-title is-strong">{t.confirm.closeTitle(title)}</span>
          <span className="confirm-stops">{stopsLine(stops)}</span>
        </span>
      </div>
      <div className="row-confirm-body">
        {session && <ResumeNote note={note} promptAt={promptAt} />}
        <ConfirmActions confirm={t.confirm.close} onConfirm={() => useApp.getState().confirmClose()} onCancel={cancel} />
      </div>
    </>
  );
}
