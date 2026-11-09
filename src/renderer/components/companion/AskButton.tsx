import type { TerminalInfo } from '@shared/protocol';
import { Icon } from '../Icon';
import { useApp } from '../../store';
import { kbd } from '../../kbd';
import { t } from '../../i18n/en';
import { toggleAskFor } from '../../companion/actions';

/**
 * Ask's chip at the session bar's right end: a faint
 * fill, no border, ⌘I only in the tooltip; hover (violet tint), open (tint and edge), and a pink dot while a finished
 * answer hasn't been seen.
 */
export function AskButton({ term }: { term: TerminalInfo }) {
  const open = useApp((s) => !!s.askOpen[term.id]);
  const sessionId = term.session?.sessionId ?? null;
  const unseen = useApp((s) => sessionId !== null && !!s.askThreads[sessionId]?.unseen);
  const key = kbd('⌘I');
  return (
    <button type="button" className={`sb-ask${open ? ' is-open' : ''}`} aria-label={open ? t.companion.close : t.companion.pill} aria-expanded={open}
      data-tip={open ? t.companion.close : t.companion.pillTip(term.title)} data-kbd={key || undefined} onClick={() => toggleAskFor(term.id)}>
      <Icon name="ask" size={14} stroke={1.7} />
      <span className="sb-ask-label">{t.companion.ask}</span>
      {unseen && !open && <i className="sb-ask-dot" aria-hidden="true" />}
    </button>
  );
}
