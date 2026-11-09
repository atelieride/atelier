import { useId } from 'react';
import { changedAfter } from '@shared/companion/stale';
import type { CatchPoint, ThreadItem } from '@shared/companion/types';
import { Icon } from '../Icon';
import { useApp } from '../../store';
import { t } from '../../i18n/en';
import { useAgo } from '../../minute';
import type { RunView } from '../../companion/model';
import { MODEL_LABEL, catchUpSource, catchUpWhen, pointTimes, whyQuestion } from '../../companion/view';
import { POINT_GLYPH } from '../../companion/copy';
import { InlineText } from './InlineText';

type CatchUpItem = Extract<ThreadItem, { kind: 'catchup' }>;

/** The files a source line's tooltip lists before "+N more". */
const READ_TIP_MAX = 8;

/**
 * A Catch me up: the requests with their status and
 * time, where the session is, the choices it made (each with Why?), what it read and with which model. The latest
 * live one has a refresh in its header, violet once the session changed files after it.
 */
export function CatchUpCard({ item, sessionId, latest, busy, catching, onAsk, onCatchUp }: {
  item: CatchUpItem; sessionId: string; latest: boolean; busy: boolean; catching: boolean; onAsk: (q: string) => void; onCatchUp: () => void;
}) {
  const id = useId();
  const c = item.data;
  // "2 min ago" moves by the minute (then the hour, the day): one timer per card, none for a final one.
  const now = useAgo(item.final ? null : item.at);
  const stale = useApp((s) => (latest && !item.final ? changedAfter(s.attributions, sessionId, item.at).length : 0));
  const times = pointTimes(c.points, item.final);
  const summary = item.final && c.leftOpen ? { label: t.companion.leftOpen, text: c.leftOpen } : c.where ? { label: t.companion.where, text: c.where } : null;
  const more = item.read.length - READ_TIP_MAX;
  const readTip = item.read.length ? [...item.read.slice(0, READ_TIP_MAX), ...(more > 0 ? [t.companion.moreFiles(more)] : [])].join('\n') : undefined;
  const refreshLabel = stale ? t.companion.refreshStale(stale) : t.companion.refresh;

  return (
    <section className={`ask-item ask-card${item.final ? ' is-final' : ''}`} data-kind="catchup" aria-labelledby={`${id}-t`}>
      <header className="ask-card-hd" data-copy="skip">
        <span className="ask-spark" aria-hidden="true"><Icon name="sparkle" size={15} stroke={1.2} /></span>
        <h3 id={`${id}-t`} className="ask-card-t">{t.companion.catchUp}</h3>
        <span className="ask-card-when">{catchUpWhen(item.at, now, item.final)}</span>
        {latest && !item.final && (
          <button type="button" className={`ask-ib ask-refresh${stale ? ' is-stale' : ''}`} aria-label={refreshLabel}
            data-tip={catching ? t.companion.catchingUp : busy ? t.companion.oneAtATime : refreshLabel}
            aria-disabled={busy || catching} onClick={() => { if (!busy && !catching) onCatchUp(); }}>
            <Icon name="resume" size={14} stroke={1.7} />
          </button>
        )}
      </header>
      {c.points.length === 0 ? (
        // Nothing asked yet: the summary alone says so.
        <p className="ask-card-none"><InlineText text={c.where} /></p>
      ) : (
        <>
          <div className="ask-sec">
            <h4 className="ask-sec-label">{t.companion.requests}</h4>
            <ol className="ask-pts">
              {c.points.map((p, i) => <Point key={i} p={p} time={times[i] ?? null} />)}
            </ol>
          </div>
          {summary && (
            <div className="ask-sec">
              <h4 className="ask-sec-label">{summary.label}</h4>
              <p className="ask-sum"><InlineText text={summary.text} /></p>
            </div>
          )}
          {c.choices.length > 0 && (
            <div className="ask-sec">
              <h4 className="ask-sec-label">{t.companion.choices}</h4>
              <ul className="ask-decs">
                {c.choices.map((x, i) => {
                  const q = whyQuestion(x);
                  return (
                    <li key={i} className="ask-dec">
                      <span id={`${id}-c${i}`} className="ask-dec-tx"><InlineText text={x} /></span>
                      <button type="button" className="ask-why" aria-describedby={`${id}-c${i}`} aria-disabled={busy}
                        data-tip={busy ? t.companion.oneAtATime : t.companion.whyTip(q)} onClick={() => { if (!busy) onAsk(q); }}>
                        {t.companion.why}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
      <div className="ask-src" data-tip={readTip} data-copy="skip">
        <Icon name="eye" size={12} stroke={1.7} />
        <span>{catchUpSource(item.read)}</span>
        <span className="ask-src-model mono">{MODEL_LABEL[item.model]}</span>
      </div>
    </section>
  );
}

function Point({ p, time }: { p: CatchPoint; time: ReturnType<typeof pointTimes>[number] }) {
  return (
    <li className={`ask-pt is-${p.status}`} value={p.n}>
      <span className={`ask-gl is-${p.status}`} role="img" aria-label={t.companion.status[p.status]} data-copy-text={`${POINT_GLYPH[p.status]} `}>
        {p.status === 'done' && <Icon name="check" size={11} stroke={2.6} />}
        {p.status === 'unclear' && <span aria-hidden="true">?</span>}
      </span>
      <span className="ask-pt-tx"><span className="ask-pt-n mono" data-copy="skip">{p.n}</span><InlineText text={p.text} /></span>
      <span className={`ask-pt-tm${time ? ` is-${time.tone}` : ''}`} data-copy-before=" · ">{time?.text}</span>
      {p.note && <span className="ask-pt-note" data-copy-before=" — "><InlineText text={p.note} /></span>}
    </li>
  );
}

/**
 * A Catch me up on its way: one compact row with what it reads now. The label sweeps once as it starts and
 * again at each step it reads (the idle-motion budget: no label loops; none with Reduce motion).
 */
export function CatchingUp({ run }: { run: RunView }) {
  const last = run.trace.at(-1);
  return (
    <div className="ask-catching" role="status" data-copy="skip">
      <span className="ask-spark" aria-hidden="true"><Icon name="sparkle" size={14} stroke={1.2} /></span>
      {/* What screen readers hear: one stable label, never remounted by a step. */}
      <span className="sr-only">{run.queued ? t.companion.waitingTurn : t.companion.catchingUp}</span>
      {run.queued
        ? <span className="ask-catching-t" aria-hidden="true">{t.companion.waitingTurn}</span>
        : <span className="ask-catching-t" aria-hidden="true">{t.companion.catchingUp}</span>}
      {/* For the eyes: the status stays "Catching up…", not re-announced at each step. */}
      {last && !run.queued && <span key={last} className="ask-catching-trace" aria-hidden="true">{last}</span>}
    </div>
  );
}
