import { useEffect, useState, type CSSProperties } from 'react';
import { ARM_MS } from '@shared/scheduled-prompts';
import { useApp } from '../store';
import { t } from '../i18n/en';
import { clockOf } from '../schedule-view';
import { fireSchedule, snoozeSchedule } from '../schedules';

const R = 8;
const C = 2 * Math.PI * R;

/**
 * The countdown before a scheduled prompt is typed into the session you're looking at:
 * a ring, "Sending your 14:30 prompt in 8 s", Send Now and Not Now (10 min later). Over that session's pane.
 */
export function ScheduleCountdown({ terminalId, place }: { terminalId: string; place?: CSSProperties }) {
  const list = useApp((s) => s.schedules);
  const armed = list.find((x) => x.terminalId === terminalId && x.status === 'armed' && !x.fired);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!armed) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [armed?.id, armed?.armedUntil]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!armed || (armed.armedUntil ?? 0) <= now) return null;
  const left = (armed.armedUntil ?? now) - now;
  const secs = Math.ceil(left / 1000);
  const frac = Math.max(0, Math.min(1, left / ARM_MS));
  return (
    <div className="sp-countdown" role="status" aria-live="polite" style={place}>
      <svg className="sp-ring" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r={R} className="sp-ring-track" />
        <circle cx="10" cy="10" r={R} className="sp-ring-fill" strokeDasharray={C} strokeDashoffset={C * (1 - frac)} transform="rotate(-90 10 10)" />
      </svg>
      <span className="sp-countdown-text">{t.sched.countdown(clockOf(armed.at))} <b className="mono">{secs} s</b></span>
      <button type="button" className="sp-countdown-send" onClick={() => void fireSchedule(armed.id)}>{t.sched.sendNow}</button>
      <button type="button" className="sp-countdown-later" onClick={() => void snoozeSchedule(armed.id, 10)}>{t.sched.notNow}</button>
    </div>
  );
}
