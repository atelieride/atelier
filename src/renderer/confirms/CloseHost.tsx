// A close being asked: a bubble beside the sidebar row it was asked from, a popover under the tab or the
// pop-out's bar, else centered at the top.
import { useId } from 'react';
import { useApp } from '../store';
import { t } from '../i18n/en';
import type { CloseAsk } from './slice';
import { ConfirmPopover } from './ConfirmPopover';
import { ConfirmActions, ResumeNote, stopsLine } from './InlineConfirm';

/** A terminal's sidebar row. */
const rowOf = (id: string) => `[data-term-row="${CSS.escape(id)}"]`;

/** What a close question hangs from, by where it was asked (a row: a bubble beside it). */
export function closeAnchor(ask: Pick<CloseAsk, 'id' | 'at'>): { selector: string; align: 'start' | 'end' } {
  const id = CSS.escape(ask.id);
  if (ask.at === 'tab') return { selector: `.tab[data-key="t:${id}"]`, align: 'start' };
  if (ask.at === 'popout') return { selector: '.popout-bar', align: 'end' };
  return { selector: rowOf(ask.id), align: 'start' };
}

export function CloseHost() {
  const ask = useApp((s) => s.closeAsk);
  const term = useApp((s) => (ask ? s.terminals.find((x) => x.id === ask.id) : undefined));
  const ids = useId();
  if (!ask || !term) return null;
  // Asked from a row: a bubble beside it, which stands centered while the row isn't in sight (the sidebar hidden or on
  // another view, the row filtered out or scrolled away) and comes back beside it once it is.
  const beside = ask.at === 'row';
  const { selector, align } = closeAnchor(ask);
  const cancel = () => useApp.getState().cancelClose();
  const title = t.confirm.closeTitle(term.title);
  const stops = stopsLine(ask.stops);
  const stopsId = `${ids}-stops`;
  const noteId = `${ids}-note`;
  const described = [stops ? stopsId : '', term.session ? noteId : ''].filter(Boolean).join(' ');
  // Answered, the keyboard goes back to the × that asked; once closing (its × gone), to the row itself.
  const restore = beside ? [`${selector} .row-close`, `${selector} .row-main`] : undefined;
  return (
    <ConfirmPopover key={`${ask.id}:${ask.at}`} anchor={selector} align={align} side={beside} restore={restore}
      keep={beside ? `${selector} .row-close` : undefined} label={title} describedBy={described} onCancel={cancel}>
      <div className="confirm-pop-text">
        <b>{title}</b>
        {stops && <span id={stopsId} className="confirm-stops">{stops}</span>}
        {term.session && <ResumeNote id={noteId} note={ask.note} promptAt={ask.promptAt} />}
      </div>
      {/* Beside a row the danger answer comes first: it lands next to the × that asked. */}
      <ConfirmActions end={!beside} small={false} confirm={t.confirm.close} icon="trash" keep={t.confirm.keep}
        onConfirm={() => useApp.getState().confirmClose()} onCancel={cancel} />
    </ConfirmPopover>
  );
}
