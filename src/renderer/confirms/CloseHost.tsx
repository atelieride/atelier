// A close asked anywhere but a row on screen: the popover under the tab or the pop-out's bar,
// else centered at the top.
import { useLayoutEffect, useState } from 'react';
import { useApp } from '../store';
import { t } from '../i18n/en';
import type { CloseAsk } from './slice';
import { ConfirmPopover } from './ConfirmPopover';
import { ConfirmActions, ResumeNote, stopsLine } from './InlineConfirm';

/** What a close question hangs from, by where it was asked (a row: its own row shows it, see SessionRow). */
export function closeAnchor(ask: Pick<CloseAsk, 'id' | 'at'>): { selector: string | null; align: 'start' | 'end' } {
  const id = CSS.escape(ask.id);
  if (ask.at === 'tab') return { selector: `.tab[data-key="t:${id}"]`, align: 'start' };
  if (ask.at === 'popout') return { selector: '.popout-bar', align: 'end' };
  return { selector: null, align: 'start' };
}

export function CloseHost() {
  const ask = useApp((s) => s.closeAsk);
  const term = useApp((s) => (ask ? s.terminals.find((x) => x.id === ask.id) : undefined));
  // Asked from a row: the row answers, unless it isn't on screen (the sidebar on another view, filtered, collapsed).
  // Measured again when the sidebar changes view or shows again: back on Sessions, the row takes the
  // question over from the popover.
  const view = useApp((s) => (s.sidebarHidden ? null : s.activity));
  const [rowShown, setRowShown] = useState(true);
  useLayoutEffect(() => {
    if (ask?.at !== 'row') return;
    const row = document.querySelector(`[data-term-row="${CSS.escape(ask.id)}"]`);
    setRowShown(row instanceof HTMLElement && row.offsetParent !== null);
  }, [ask, view]);
  if (!ask || !term || (ask.at === 'row' && rowShown)) return null;
  const { selector, align } = closeAnchor(ask);
  const cancel = () => useApp.getState().cancelClose();
  const title = t.confirm.closeTitle(term.title);
  return (
    <ConfirmPopover key={`${ask.id}:${ask.at}`} anchor={selector} align={align} label={title} onCancel={cancel}>
      <div className="confirm-pop-text">
        <b>{title}</b>
        <span className="confirm-stops">{stopsLine(ask.stops)}</span>
        {term.session && <ResumeNote note={ask.note} promptAt={ask.promptAt} />}
      </div>
      <ConfirmActions end small={false} confirm={term.session ? t.confirm.closeSession : t.confirm.closeTerminal}
        onConfirm={() => useApp.getState().confirmClose()} onCancel={cancel} />
    </ConfirmPopover>
  );
}
