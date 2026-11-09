import { Icon } from '../Icon';
import type { RunView } from '../../companion/model';
import { traceRows } from '../../companion/view';

/**
 * What an answer on its way reads: steps done with a check, the current one in the
 * present tense with a violet dot. Its label sweeps once as the step starts (the idle-motion budget: no loop; none with
 * Reduce motion). For the eyes only: the answer's header tells screen readers it is reading.
 */
export function Trace({ run }: { run: Pick<RunView, 'trace' | 'traceAt' | 'text'> }) {
  const rows = traceRows(run);
  if (rows.length === 0) return null;
  return (
    <div className="ask-trace" aria-hidden="true">
      {rows.map((r, i) => (
        <div key={i} className={`ask-trace-row${r.now ? ' is-now' : ''}`}>
          {r.now ? <span className="ask-trace-dot" /> : <span className="ask-trace-ok"><Icon name="check" size={12} stroke={2.4} /></span>}
          <span key={r.now ? 'now' : 'done'} className="ask-trace-t">{r.text}</span>
        </div>
      ))}
    </div>
  );
}
