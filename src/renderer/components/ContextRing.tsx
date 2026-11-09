import { memo } from 'react';
import { ringDash } from '../ring';
import { t } from '../i18n/en';

/** How much context the session has used: a 14 px ring, yellow above 80%. */
export const ContextRing = memo(function ContextRing({ pct, bare = false }: { pct: number; bare?: boolean }) {
  const r = 5.5;
  const d = ringDash(pct, r);
  // `bare`: inside a control whose own tooltip says it (the session chip): no native tooltip on top of the app's.
  return (
    <span className="ctx-ring" title={bare ? undefined : t.contextUsed(pct)}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r={r} className="ctx-track" />
        <circle cx="7" cy="7" r={r} className={`ctx-fill ${pct >= 80 ? 'is-high' : ''}`} strokeDasharray={d.dasharray} strokeDashoffset={d.dashoffset} transform="rotate(-90 7 7)" />
      </svg>
      <span className="ctx-pct mono">{pct}%</span>
    </span>
  );
});
