import { t } from '../../i18n/en';

/**
 * Suggestion chips: up to three questions; clicking one asks it. Under the thread right after
 * a Catch me up, and the empty state's starters.
 */
export function Suggestions({ items, onAsk, center = false }: { items: readonly string[]; onAsk: (q: string) => void; center?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div className={`ask-sugg${center ? ' is-center' : ''}`} role="group" aria-label={t.companion.suggested}>
      {items.map((q) => <button key={q} type="button" className="ask-sg" onClick={() => onAsk(q)}>{q}</button>)}
    </div>
  );
}
