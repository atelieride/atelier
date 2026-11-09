import type { ReactNode, RefObject } from 'react';
import type { TerminalInfo } from '@shared/protocol';
import { workSummary } from '@shared/background';
import { useApp } from '../store';
import { t } from '../i18n/en';
import { useDismiss } from '../confirms/InlineConfirm';

/**
 * Restart asked in a sidebar row: background work would
 * stop. Restart When Done takes the focus (the safe answer); Esc and a click outside cancel.
 */
export function RowRestartConfirm({ box, term, lead }: { box: RefObject<HTMLElement | null>; term: TerminalInfo; lead: ReactNode }) {
  const answer = (a: 'now' | 'later' | 'cancel') => useApp.getState().answerRestart(a);
  useDismiss(box, () => answer('cancel'), '.row-main');
  const what = (term.work && workSummary(term.work)) || t.restart.backgroundWork;
  return (
    <>
      <div className="row-confirm-head">
        {lead}
        <span className="session-main">
          <span className="session-title is-strong">{t.restart.askTitle}</span>
          <span className="confirm-stops">{t.restart.askStops(what)}</span>
        </span>
      </div>
      <div className="row-confirm-body">
        <div className="confirm-actions is-restart">
          <button type="button" className="btn-ghost sm is-later" data-autofocus onClick={() => answer('later')}>{t.restart.whenDone}</button>
          <button type="button" className="btn-danger sm" onClick={() => answer('now')}>{t.restart.askNow}</button>
          <button type="button" className="btn-ghost sm is-cancel" onClick={() => answer('cancel')}>{t.confirm.cancel}<span className="confirm-key mono">{t.confirm.esc}</span></button>
        </div>
      </div>
    </>
  );
}
