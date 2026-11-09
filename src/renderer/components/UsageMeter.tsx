import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { accountTag, meterAccounts, tildeDir, useAccounts } from '../accounts';
import { useShallow } from 'zustand/react/shallow';
import { meterUsage, usageParts } from '../selectors';
import { useApp } from '../store';
import { ringArc, usageTone } from '../usage';
import { t } from '../i18n/en';

/** The gradient a ring's arc takes while there is headroom (one per document: the meter is drawn once per window). */

/** A usage ring: a 16 px circle that fills clockwise from 12 o'clock, colored by its tone. */
export function UsageRing({ pct }: { pct: number }) {
  const arc = ringArc(pct);
  return (
    <svg className={`usage-ring tone-${usageTone(pct)}`} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="usage-ring-track" cx="8" cy="8" r="6" />
      {arc && <circle className="usage-ring-arc" cx="8" cy="8" r="6" pathLength={100} strokeDasharray={arc} transform="rotate(-90 8 8)" />}
    </svg>
  );
}

/**
 * 5h and 7d limits of the selected session's Claude config dir: ring, percentage and
 * time to reset, which ticks on its own even when sessions are idle. With several config dirs, a label names it.
 */
export function UsageMeter() {
  const list = useApp((s) => s.usage);
  // Only what the pick needs: a terminal list update that changes no dir re-renders nothing.
  const selectedDir = useApp((s) => s.terminals.find((x) => x.id === s.selectedId)?.configDir);
  const windowDirs = useApp(useShallow((s) => s.terminals.map((x) => x.configDir)));
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => clearInterval(id);
  }, []);
  // The dir shown last in this window: a plain terminal keeps it (undefined until something is shown).
  const lastShown = useRef<string | null | undefined>(undefined);
  const pick = meterUsage(list, selectedDir, windowDirs, lastShown.current, now);
  useEffect(() => { if (pick.usage) lastShown.current = pick.configDir; }, [pick.usage, pick.configDir]);
  const parts = usageParts(pick.usage, now);
  // Claude accounts: the account's name and color in place of its folder's name, and every
  // account's limits in a popover (hover or focus) while more than one has them.
  const accounts = useAccounts();
  const defaultDir = useApp((s) => s.claudeDefaultDir);
  const home = useApp((s) => s.home);
  const [open, setOpen] = useState(false);
  if (!parts.length) return null;
  const tag = accountTag(pick.configDir, accounts, defaultDir);
  const name = pick.label ? tag?.name ?? pick.label : null;
  const rows = meterAccounts(list, accounts, defaultDir, pick.configDir ?? undefined, now);
  const many = rows.length > 1;
  const dir = pick.label && pick.configDir ? tildeDir(pick.configDir, home) : null;
  return (
    <div className={`usage${many ? ' has-accounts' : ''}`} tabIndex={many ? 0 : undefined} role={many ? 'group' : undefined}
      aria-label={many ? t.usageLabel : undefined} aria-describedby={open && many ? 'usage-accounts' : undefined}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
      {/* Keyed by dir: switching account fades the new name in. */}
      {name && <><span key={pick.configDir} className="mono usage-dir">{tag?.color && <i className="usage-dot" style={{ '--acct': `var(--person-${tag.color})` } as CSSProperties} />}{name}</span><span className="usage-sep" /></>}
      {/* One group per window (label, ring, %, time to reset); the tooltip says what the bare time is. */}
      {parts.map((p) => {
        const label = p.key === '5h' ? t.usage5h : t.usage7d;
        const tip = p.reset ? t.usageResets(label, p.reset) : undefined;
        return (
          <span key={p.key} className="usage-part" title={dir && tip ? `${tip} · ${dir}` : tip}>
            <span className="usage-label">{label}</span>
            <UsageRing pct={p.pct} />
            <span className={`mono usage-pct tone-${usageTone(p.pct)}`}>{p.pct}%</span>
            {p.reset && <span className="mono usage-reset">{p.reset}</span>}
          </span>
        );
      })}
      {open && many && (
        <div id="usage-accounts" className="usage-pop" role="tooltip">
          <span className="section-label">{t.accounts.allAccounts}</span>
          {rows.map((r) => (
            <div key={r.dir} className={`usage-pop-row${r.current ? ' is-current' : ''}`} data-tip={tildeDir(r.dir, home)}>
              <i className="acct-dot" style={r.color ? ({ '--acct': `var(--person-${r.color})` } as CSSProperties) : undefined} />
              <span className="usage-pop-name">{r.name}{r.current && <span className="usage-pop-this"> · {t.accounts.thisSession}</span>}</span>
              <span className="acct-usage mono">
                {r.parts.map((p) => (
                  <span key={p.key} className="acct-limit">
                    {p.key}
                    <UsageRing pct={p.pct} />
                    {p.pct}%
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
