// A close being asked: a bubble beside the sidebar row it was asked from, a popover under the tab or the
// pop-out's bar, else centered at the top.
import { useLayoutEffect, useState } from 'react';
import { useApp } from '../store';
import { t } from '../i18n/en';
import type { CloseAsk } from './slice';
import { ConfirmPopover } from './ConfirmPopover';
import { ConfirmActions, ResumeNote, stopsLine } from './InlineConfirm';

/** A terminal's sidebar row. */
const rowOf = (id: string) => `[data-term-row="${CSS.escape(id)}"]`;

/** What a close question hangs from, by where it was asked (a row: beside it, see the host). */
export function closeAnchor(ask: Pick<CloseAsk, 'id' | 'at'>): { selector: string | null; align: 'start' | 'end' } {
  const id = CSS.escape(ask.id);
  if (ask.at === 'tab') return { selector: `.tab[data-key="t:${id}"]`, align: 'start' };
  if (ask.at === 'popout') return { selector: '.popout-bar', align: 'end' };
  return { selector: null, align: 'start' };
}

export function CloseHost() {
  const ask = useApp((s) => s.closeAsk);
  const term = useApp((s) => (ask ? s.terminals.find((x) => x.id === ask.id) : undefined));
  // Asked from a row: a bubble beside it, unless the row isn't on screen (the sidebar on another view, filtered,
  // collapsed). Measured again when the sidebar changes view or shows again: back on Sessions, the question is
  // beside its row again.
  const view = useApp((s) => (s.sidebarHidden ? null : s.activity));
  const [rowShown, setRowShown] = useState(true);
  useLayoutEffect(() => {
    if (ask?.at !== 'row') return;
    const row = document.querySelector(rowOf(ask.id));
    setRowShown(row instanceof HTMLElement && row.offsetParent !== null);
  }, [ask, view]);
  if (!ask || !term) return null;
  const beside = ask.at === 'row' && rowShown;
  const { selector, align } = closeAnchor(ask);
  const row = rowOf(ask.id);
  const cancel = () => useApp.getState().cancelClose();
  const title = t.confirm.closeTitle(term.title);
  const stops = stopsLine(ask.stops);
  return (
    <ConfirmPopover key={`${ask.id}:${ask.at}:${beside}`} anchor={beside ? row : selector} align={align} side={beside}
      restore={beside ? `${row} .row-main` : undefined} keep={beside ? `${row} .row-close` : undefined} label={title} onCancel={cancel}>
      <div className="confirm-pop-text">
        <b>{title}</b>
        {stops && <span className="confirm-stops">{stops}</span>}
        {term.session && <ResumeNote note={ask.note} promptAt={ask.promptAt} />}
      </div>
      {/* Beside a row the danger answer comes first: it lands next to the × that asked. */}
      <ConfirmActions end={!beside} small={false} confirm={t.confirm.close} icon="trash" keep={t.confirm.keep}
        onConfirm={() => useApp.getState().confirmClose()} onCancel={cancel} />
    </ConfirmPopover>
  );
}
