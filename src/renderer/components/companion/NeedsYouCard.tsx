import type { Binding } from '@shared/companion/types';
import { Icon } from '../Icon';
import { useApp } from '../../store';
import { t } from '../../i18n/en';
import { focusTerminal } from '../../terminal/focus';
import { helpDecideQuestion, needsYou } from '../../companion/attention';

/**
 * The session needs you: pinned above the thread while the bound session waits for a
 * question's answer or a permission — what it asks (the session bar's line), **Answer in session** (the terminal has the
 * keyboard) and **Help me decide** (Ask is asked how to answer it; the run finds the question in the chat). It goes
 * when the wait ends. The only amber in Ask: it is the session's state, not Ask's.
 */
export function NeedsYouCard({ binding, busy, onAsk }: { binding: Binding; busy: boolean; onAsk: (q: string) => void }) {
  const term = useApp((s) => s.terminals.find((x) => x.id === binding.terminalId));
  const card = needsYou(term, binding.sessionId);
  if (!term || !card) return null;
  return (
    <section className="ask-needs" aria-label={card.title} data-kind={card.kind}>
      <Icon name={card.kind === 'permission' ? 'lock' : 'question'} size={18} stroke={1.8} />
      <div className="ask-needs-bd">
        <p className="ask-needs-t">{card.title}</p>
        {card.line && <p className="ask-needs-d mono">{card.line}</p>}
        <div className="ask-needs-btns">
          <button type="button" className="ask-btn is-amber" data-tip={t.companion.answerInSessionTip(term.title)} onClick={() => focusTerminal(term.id)}>
            {t.companion.answerInSession}
          </button>
          <button type="button" className="ask-btn" aria-disabled={busy} data-tip={busy ? t.companion.oneAtATime : undefined}
            onClick={() => { if (!busy) onAsk(helpDecideQuestion(term.title)); }}>
            <Icon name="sparkle" size={12} stroke={1.8} />{t.companion.helpDecide}
          </button>
        </div>
      </div>
    </section>
  );
}
