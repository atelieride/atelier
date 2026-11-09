import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { cancelDictation, closeDictation, micLevel, retryDictation, toggleDictation } from './controller';

const BARS = 22;

/** Dictation pill, bottom center of the session: live waveform, time, status, Stop/Cancel, errors. place: the cell of the pane showing the session the text goes to, else the focused pane's (split view). */
export function DictationPill({ place }: { place?: CSSProperties }) {
  const d = useApp((s) => s.dictation);
  const bars = useRef<HTMLSpanElement>(null);
  const [now, setNow] = useState(Date.now());

  // The waveform follows the microphone every frame without going through React: only the bar heights move.
  useEffect(() => {
    if (d.phase !== 'listening') return;
    const hist = new Array<number>(BARS).fill(0);
    let raf = 0;
    const tick = () => {
      hist.push(micLevel());
      hist.shift();
      const el = bars.current;
      if (el) hist.forEach((v, i) => { (el.children[i] as HTMLElement).style.transform = `scaleY(${0.12 + v * 0.88})`; });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const clock = setInterval(() => setNow(Date.now()), 250);
    return () => { cancelAnimationFrame(raf); clearInterval(clock); };
  }, [d.phase]);

  if (d.phase === 'idle') return null;
  const secs = Math.max(0, Math.floor((now - d.startedAt) / 1000));
  const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  return (
    <div className={`dictation-pill is-${d.phase}`} role="status" aria-live="polite" style={place}>
      <span className="dp-mic"><Icon name="mic" size={14} stroke={1.9} /></span>
      {d.phase === 'listening' && (
        <>
          <span className="dp-bars" ref={bars} aria-hidden="true">{Array.from({ length: BARS }, (_, i) => <i key={i} />)}</span>
          <span className="dp-label">{t.dictationPhase.listening}</span>
          <span className="dp-time mono">{time}</span>
          <button type="button" className="dp-btn is-stop" aria-label={t.dictationStop} data-tip={t.dictationStop} onClick={toggleDictation}><Icon name="stop" size={12} /></button>
          <button type="button" className="dp-btn" aria-label={t.dictationCancel} data-tip={t.dictationCancel} onClick={cancelDictation}><Icon name="x" size={12} stroke={2} /></button>
        </>
      )}
      {d.phase === 'transcribing' && <><span className="dp-spinner" aria-hidden="true" /><span className="dp-label">{t.dictationPhase.transcribing}</span></>}
      {d.phase === 'inserted' && <span className="dp-label">✓ {t.dictationPhase.inserted}</span>}
      {d.phase === 'error' && (
        <>
          <span className="dp-label">{d.message}</span>
          {d.canRetry && <button type="button" className="dp-btn is-text" onClick={retryDictation}>{t.dictationRetry}</button>}
          <button type="button" className="dp-btn" aria-label={t.dictationClose} onClick={closeDictation}><Icon name="x" size={12} stroke={2} /></button>
        </>
      )}
    </div>
  );
}
