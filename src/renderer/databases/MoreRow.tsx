// The grid's last row while rows load as you scroll: a spinner while the next fetch loads,
// the error with Retry when it failed, a cap's message — 10,000 rows, or the values budget; nothing while
// idle or at the end. The grid (the interim body now) puts it after its rows.
import type { DbProblem } from '@shared/databases';
import { Icon } from '../components/Icon';
import { tdt } from '../i18n/db-table';
import { capMessage } from './data';
import type { DbTabState } from './store';

export function MoreRow({ more, problem, loaded, onRetry }: { more: DbTabState['more']; problem: DbProblem | null; loaded: number; onRetry: () => void }) {
  if (more === 'loading') {
    return <div className="dbt-more is-loading" role="status"><span className="dk-spin" aria-hidden="true" /><span className="dbt-more-text">{tdt.more.loading}</span></div>;
  }
  if (more === 'cap') {
    const text = capMessage(loaded);
    return <div className="dbt-more is-cap" role="status"><Icon name="info" size={13} /><span className="dbt-more-text" data-tip={text}>{text}</span></div>;
  }
  if (more !== 'error' || !problem) return null;
  const text = problem.kind === 'canceled' ? `${problem.message}. ${tdt.timeoutHint}` : problem.message;
  return (
    <div className="dbt-more is-error" role="alert">
      <Icon name="warning" size={13} />
      <span className="dbt-more-text" data-tip={text}>{text}</span>
      <button type="button" className="dbt-link" onClick={onRetry}>{tdt.more.retry}</button>
    </div>
  );
}
