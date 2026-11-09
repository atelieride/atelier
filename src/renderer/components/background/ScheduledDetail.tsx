// The session's scheduled wake-ups in the Background tab: one card per cron,
// the selected one open with a countdown ring, its schedule in words and raw, the drift Claude Code allows, the prompt
// (the label atelierd keeps) and the next fire times. A self-paced /loop gets its own card:
// its task, the next check to the second, Claude's reason for the pace and the last checks, from the transcript.
import type { CSSProperties } from 'react';
import type { TerminalInfo } from '@shared/protocol';
import { cronRowId, selfPacedLoop, type SelfPacedLoop } from '@shared/loop';
import { countdown, cronRing, fireTime } from '../../background-output';
import { formatElapsed } from '../../background-view';
import { clockSeconds, cronDrift, cronEvery, cronHint, cronUpcoming, loopBusy, loopDelay, loopShown, loopStarted, loopTitle } from '../../cron-view';
import { clockTime } from '../../work-view';
import { t } from '../../i18n/en';
import { Icon } from '../Icon';
import { useLoopDetail } from './loop-detail-hook';
import { reducedMotion, selectAndFocus } from './parts';

type Cron = NonNullable<TerminalInfo['work']>['crons'][number];

export function ScheduledDetail({ term, id, now }: { term: TerminalInfo; id: string; now: number }) {
  const crons = term.work?.crons ?? [];
  // Reduce motion: the ring moves once a minute, not every second.
  const reduced = reducedMotion();
  const at = reduced ? Math.floor(now / 60_000) * 60_000 : now;
  const working = loopBusy(term.session);
  return (
    <div className="bgv-detail-in bgv-crons">
      {crons.map((c) => {
        const row = cronRowId(c);
        const loop = selfPacedLoop(c.label, c.recurring);
        // A loop's card is keyed by its row: the open detail survives the new cron id each turn.
        if (loop) return row === id
          ? <LoopOpen key={row} c={c} loop={loop} terminalId={term.id} working={working} now={at} clock={now} reduced={reduced} />
          : <LoopClosed key={row} c={c} loop={loop} row={row} working={working} now={now} />;
        return row === id ? <Open key={c.id} c={c} now={at} clock={now} reduced={reduced} /> : <Closed key={c.id} c={c} now={now} />;
      })}
    </div>
  );
}

/** "in 3 min" before the wake-up; once it fired (main nulls its next), whether Claude is on it. */
const loopWhen = (next: number | null, working: boolean, now: number) =>
  next !== null ? t.bg.inTime(formatElapsed(Math.max(0, next - now))) : working ? t.bg.loop.checkingNow : t.bg.loop.passed;

function LoopClosed({ c, loop, row, working, now }: { c: Cron; loop: SelfPacedLoop; row: string; working: boolean; now: number }) {
  return (
    <button type="button" className="bgv-cron" onClick={(e) => selectAndFocus(e.currentTarget, row)}>
      <span className="bgv-glyph k-loop"><Icon name="sync" size={14} stroke={1.8} /></span>
      <span className="bgv-cron-main">
        <span className="bgv-cron-label">{loopTitle(loop)}</span>
        <span className="bgv-cron-sub">{`${t.bg.loop.selfPaced} · ${loopWhen(c.next, working, now)}`}</span>
      </span>
      {c.next !== null && <span className="bgv-cron-in mono">{clockTime(c.next)}</span>}
    </button>
  );
}

function LoopOpen({ c, loop, terminalId, working, now, clock, reduced }: { c: Cron; loop: SelfPacedLoop; terminalId: string; working: boolean; now: number; clock: number; reduced: boolean }) {
  // The last answer is kept across turns; only what is still this cron's counts (a new turn shows the cron's minute).
  const { detail: d, fresh, next, period, why } = loopShown(c, useLoopDetail(terminalId, c.id), terminalId);
  // The ring's full turn is the wait Claude Code scheduled; unknown, it stays empty (a one-hour guess would read as due).
  const ring = next === null ? 1 : period !== null ? cronRing(next, next + period, now) : 0;
  const left = next !== null ? countdown(next - clock, reduced) : t.bg.dueNow;
  const title = loopTitle(loop);
  const state = next !== null ? t.bg.loop.nextCheck(clockTime(next)) : working ? t.bg.loop.checking : t.bg.loop.passedTitle;
  return (
    <section className={`bgv-cron is-open bgv-loop${d && !fresh ? ' is-stale' : ''}`} aria-label={title}>
      <div className="bgv-cron-top">
        <div className="bgv-ring" style={{ '--p': ring } as CSSProperties} role="img" aria-label={state}>
          <div className="bgv-ring-in">
            <span className={`bgv-ring-t mono ${left.length > 5 ? 'is-long' : ''}`}>{left}</span>
            {next !== null && <span className="bgv-ring-l">{t.bg.toGo}</span>}
          </div>
        </div>
        <div className="bgv-cron-info">
          <div className="bgv-cron-pills">
            <span className="bgv-soft">{t.bg.loop.selfPacedPill}</span>
            {d?.delaySeconds ? <span className="bgv-soft" data-tip={t.bg.loop.lastDelayTip}>{t.bg.loop.lastDelay(loopDelay(d.delaySeconds))}</span> : null}
            <span className="bgv-soft mono" data-tip={c.schedule}>{c.schedule}</span>
          </div>
          <div className="bgv-cron-next">{state}</div>
          {why && <div className="bgv-cron-drift bgv-loop-na">{t.bg.loop.notAvailable(why)}</div>}
        </div>
      </div>
      {d?.reason && (
        <div className="bgv-cron-block">
          <span className="section-label">{t.bg.loop.why}</span>
          <blockquote className="bgv-loop-why">{d.reason}</blockquote>
        </div>
      )}
      {d && d.checks > 0 && (
        <div className="bgv-cron-block">
          <div className="bgv-loop-head">
            <span className="section-label">{t.bg.loop.checks}</span>
            {d.startedAt !== null && <span className="bgv-loop-started">{loopStarted(fireTime(d.startedAt, now), d.checks, d.complete)}</span>}
          </div>
          <ol className="bgv-loop-checks">
            {d.last.map((x, i) => (
              <li key={`${x.at ?? 'x'}-${i}`} className={i === 0 ? 'is-last' : ''}>
                <span className="mono bgv-loop-at">{x.at !== null ? clockSeconds(x.at) : '—'}</span>
                <span className="mono bgv-loop-delay">{x.delaySeconds ? loopDelay(x.delaySeconds) : ''}</span>
                <span className="bgv-loop-reason" data-tip={x.reason ?? undefined}>{x.reason ?? ''}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="bgv-cron-block">
        <span className="section-label">{t.bg.prompt}</span>
        <p className="bgv-cron-prompt">{d?.prompt ?? c.label}</p>
      </div>
      <div className="bgv-hint"><Icon name="info" size={13} stroke={1.8} /><span>{t.bg.loop.hint}</span></div>
    </section>
  );
}

function Closed({ c, now }: { c: Cron; now: number }) {
  const every = cronEvery(c.schedule, c.recurring) ?? c.schedule;
  return (
    <button type="button" className="bgv-cron" onClick={(e) => selectAndFocus(e.currentTarget, `cron:${c.id}`)}>
      <span className="bgv-glyph k-cron"><Icon name="clock" size={14} stroke={1.8} /></span>
      <span className="bgv-cron-main">
        <span className="bgv-cron-label">{c.label}</span>
        <span className="bgv-cron-sub">{every}</span>
      </span>
      {c.next !== null && <span className="bgv-cron-in mono">{t.bg.inTime(formatElapsed(Math.max(0, c.next - now)))}</span>}
    </button>
  );
}

/** `now`: minute-rounded with reduced motion (the ring moves once a minute); `clock`: the real time, for the countdown. */
function Open({ c, now, clock, reduced }: { c: Cron; now: number; clock: number; reduced: boolean }) {
  // A one-shot fires once: its schedule's later matches (next year's same date) are not upcoming.
  const upcoming = cronUpcoming(c.schedule, new Date(now), c.recurring ? 4 : 1);
  const next = c.next !== null && c.next > now ? c.next : upcoming[0] ?? null;
  const after = next !== null ? cronUpcoming(c.schedule, new Date(next), 1)[0] ?? null : null;
  const every = cronEvery(c.schedule, c.recurring);
  const drift = cronDrift(c.schedule, c.recurring, new Date(now));
  const ring = next !== null ? cronRing(next, c.recurring ? after : null, now) : 0;
  // Whole minutes rounded up with reduced motion: the label still changes at most once a minute.
  const left = next !== null ? countdown(next - clock, reduced) : '—';
  return (
    <section className="bgv-cron is-open" aria-label={c.label}>
      <div className="bgv-cron-top">
        <div className="bgv-ring" style={{ '--p': ring } as CSSProperties} role="img" aria-label={next !== null ? t.bg.nextAt(fireTime(next, now)) : c.schedule}>
          <div className="bgv-ring-in">
            <span className={`bgv-ring-t mono ${left.length > 5 ? 'is-long' : ''}`}>{left}</span>
            <span className="bgv-ring-l">{t.bg.toGo}</span>
          </div>
        </div>
        <div className="bgv-cron-info">
          <div className="bgv-cron-pills">
            {every && <span className="bgv-soft">{every}</span>}
            <span className="bgv-soft mono" data-tip={c.schedule}>{c.schedule}</span>
            <span className="bgv-soft">{c.recurring ? t.bg.recurring : t.bg.once}</span>
          </div>
          {next !== null && <div className="bgv-cron-next">{t.bg.nextAt(fireTime(next, now))}</div>}
          {drift && <div className="bgv-cron-drift">{'late' in drift ? t.bg.late(formatElapsed(drift.late)) : t.bg.early(formatElapsed(drift.early))}</div>}
        </div>
      </div>
      <div className="bgv-cron-block">
        <span className="section-label">{t.bg.prompt}</span>
        <p className="bgv-cron-prompt">{c.label}</p>
      </div>
      {upcoming.length > 1 && (
        <div className="bgv-cron-block">
          <span className="section-label">{t.bg.upcoming}</span>
          <ol className="bgv-upcoming">
            {upcoming.map((ms, i) => <li key={ms} className={i === 0 ? 'is-next' : ''}><i /><span className="mono">{fireTime(ms, now)}</span></li>)}
          </ol>
        </div>
      )}
      <div className="bgv-hint"><Icon name="info" size={13} stroke={1.8} /><span>{cronHint(c.recurring)}</span></div>
    </section>
  );
}
