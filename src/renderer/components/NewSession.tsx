import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { accountById, hasAccounts, type ClaudeAccount } from '@shared/claude-accounts';
import { effectiveFlags, skipsPermissions } from '@shared/claude-flags';
import { FlagChip } from './LaunchFlags';
import { flagSummary, openLaunchFlags } from '../launch-flags';
import { kbd } from '../kbd';
import { Icon } from './Icon';
import { accountArrow, accountFolder, accountStep, accountUsage, cycleAccount, useAccounts } from '../accounts';
import { useApp } from '../store';
import { usageTone } from '../usage';
import { t } from '../i18n/en';

/**
 * Optional name for the new Claude session, top center like the palette: from ⌘N, the palette or "+ New"
 * the eye is already there, not under the top-right button. Enter starts, Esc or a click outside closes.
 * With two or more Claude accounts a row of accounts follows, each with its last known limits:
 * it opens on the one set for new sessions (or the one "New Session as …" asked for), Tab / Shift+Tab switch, and so do
 * the arrow keys across the cards (←/→ only while the name is empty: then they are the caret's); focus stays in the
 * name. With one account the sheet is as it always was. The launch flags of the account it starts with follow; ⌥↵
 * starts this one without them, and while ⌥ is held they show struck out.
 */
export function NewSession({ onStart, onClose }: { onStart: (name: string, account?: string, noFlags?: boolean) => void; onClose: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(true);
  const accounts = useAccounts();
  const asked = useApp((s) => s.newSessionAccount);
  const multi = hasAccounts(accounts);
  const [account, setAccount] = useState(() => accountById(accounts, asked ?? accounts.newSession)?.id ?? accounts.list[0]!.id);
  useEffect(() => { ref.current?.focus(); }, []);
  const [alt, setAlt] = useState(false);
  const flagsAll = useApp((s) => s.settings.claudeFlags);
  const picked = accountById(accounts, account);
  const flags = effectiveFlags(flagsAll, picked?.id ?? accounts.list[0]!.id);
  const start = (name: string, noFlags = false) => onStart(name, multi ? account : undefined, noFlags && flags.length > 0);
  // The grid's columns as laid out (layout.css), so ↑/↓ land on the card above or below.
  const columns = () => (cardsRef.current ? getComputedStyle(cardsRef.current).gridTemplateColumns.split(' ').length : 1);
  const arrow = (e: KeyboardEvent<HTMLInputElement>) => {
    // An input method's own arrows (picking a candidate) and modified ones (selection, word moves) stay the field's.
    if (e.nativeEvent.isComposing || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return null;
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.currentTarget.value !== '') return null;
    const i = accountArrow(e.key, accounts.list.findIndex((a) => a.id === account), accounts.list.length, columns());
    return i === null ? null : accounts.list[i]!.id;
  };
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette new-session" role="dialog" aria-label={t.newSession} onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-search">
          <span className="new-session-icon"><Icon name="sparkle" size={15} /></span>
          <input ref={ref} className="palette-input" placeholder={t.sessionNamePlaceholder} maxLength={200}
            aria-describedby={multi ? 'new-session-account' : undefined} onChange={(e) => setEmpty(e.target.value === '')}
            onKeyDown={(e) => {
              if (e.key === 'Alt') setAlt(true);
              if (e.key === 'Enter') start(e.currentTarget.value, e.altKey);
              if (e.key === 'Escape') onClose();
              const step = multi ? accountStep(e) : null;
              if (step) { e.preventDefault(); setAccount((a) => cycleAccount(accounts, a, step)); }
              const to = multi && !step ? arrow(e) : null;
              if (to) { e.preventDefault(); setAccount(to); }
            }} onKeyUp={(e) => { if (e.key === 'Alt') setAlt(false); }} onBlur={() => setAlt(false)} />
          <span className="popover-hint mono">↵ {t.start}{flags.length > 0 && <> · {kbd('⌥↵')} {t.flags.withoutFlags}</>} · esc</span>
        </div>
        {multi && (
          <div className="new-session-accounts">
            {/* What Tab chose, for screen readers: the name field stays focused, the cards aren't Tab stops. */}
            <span id="new-session-account" className="sr-only" aria-live="polite">{picked ? t.accounts.picked(picked.name) : ''}</span>
            <div className="nsa-head">
              <span className="section-label">{t.accounts.row}</span>
              <span className="popover-hint mono"><span className="nsa-key">⇥</span>{empty && <span className="nsa-key">←→</span>} {t.accounts.switch}</span>
            </div>
            <div ref={cardsRef} className="nsa-cards" role="radiogroup" aria-label={t.accounts.pick}>
              {accounts.list.map((a) => (
                <AccountCard key={a.id} account={a} on={a.id === account}
                  pick={() => { setAccount(a.id); ref.current?.focus(); }} />
              ))}
            </div>
          </div>
        )}
        {flags.length > 0 && (
          <div className={`nsf-flags${skipsPermissions(flags) && !alt ? ' is-danger' : ''}${alt ? ' is-skipped' : ''}`}>
            <span className="section-label">{t.flags.row}</span>
            <span className="nsf-chips">{flags.map((x, i) => <FlagChip key={i} flag={x} dim={alt} />)}</span>
            <button type="button" className="btn-ghost sm nsf-edit" onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onClose(); openLaunchFlags(picked?.id ?? 'all'); }}>{t.flags.edit}</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** One account: its color, name and folder, and its last known 5h/7d limits when its sessions reported them. */
function AccountCard({ account, on, pick }: { account: ClaudeAccount; on: boolean; pick: () => void }) {
  const usage = useApp((s) => s.usage);
  const defaultDir = useApp((s) => s.claudeDefaultDir);
  const home = useApp((s) => s.home);
  const parts = accountUsage(usage, account, defaultDir);
  const folder = accountFolder(account, defaultDir, home);
  const flags = flagSummary(effectiveFlags(useApp((s) => s.settings.claudeFlags), account.id));
  return (
    <button type="button" role="radio" aria-checked={on} tabIndex={-1} className={`acct-card${on ? ' is-on' : ''}`}
      style={{ '--acct': `var(--person-${account.color})` } as CSSProperties}
      // The name field keeps the focus: typing goes on, Enter starts with this account.
      onMouseDown={(e) => e.preventDefault()} onClick={pick}>
      <span className="acct-name">
        <span className="acct-dot" />
        <span className="acct-label">{account.name}</span>
        {folder && <span className="acct-dir mono" data-tip={folder.short === folder.full ? undefined : folder.full}>{folder.short}</span>}
      </span>
      {parts.length > 0 && (
        <span className="acct-usage mono">
          {parts.map((p) => (
            <span key={p.key} className="acct-limit">
              {p.key}
              <span className="usage-bar"><span className={`tone-${usageTone(p.pct)}`} style={{ transform: `scaleX(${Math.min(100, Math.max(0, p.pct)) / 100})` }} /></span>
              {p.pct}%
            </span>
          ))}
        </span>
      )}
      {flags.count > 0 && (
        <span className={`acct-flags mono${flags.danger ? ' is-danger' : ''}`}>
          <Icon name={flags.danger ? 'shieldOff' : 'flag'} size={10} stroke={1.9} />{flags.danger ? t.flags.badgeDanger : t.flags.badge(flags.count)}
        </span>
      )}
    </button>
  );
}
