import { Icon } from '../Icon';
import { t } from '../../i18n/en';
import { Suggestions } from './Suggestions';

/**
 * An empty thread (Catch me up when opened is off, or after New Thread):
 * the mark, what Ask is about, a Catch me up button and three starter questions.
 */
export function EmptyAsk({ title, onAsk, onCatchUp }: { title: string; onAsk: (q: string) => void; onCatchUp: () => void }) {
  return (
    <div className="ask-empty">
      <span className="ask-orb" aria-hidden="true"><Icon name="ask" size={30} stroke={1.5} /></span>
      <h3 className="ask-empty-t">{t.companion.askAboutTitle(title)}</h3>
      <p className="ask-empty-p">{t.companion.emptyBody}</p>
      <button type="button" className="btn-primary ask-empty-go" onClick={onCatchUp}>
        <span className="ask-spark" aria-hidden="true"><Icon name="sparkle" size={14} stroke={1.2} /></span>{t.companion.catchUp}
      </button>
      <Suggestions items={t.companion.starters} onAsk={onAsk} center />
    </div>
  );
}
