import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { DEFAULT_ACCOUNT_ID, hasAccounts } from '@shared/claude-accounts';
import { DANGER_FLAG, effectiveFlags, flagLabel, isDangerFlag, skipsPermissions, type ClaudeFlags, type LaunchFlag } from '@shared/claude-flags';
import type { Settings as S } from '@shared/settings';
import { Icon } from './Icon';
import { Toggle } from './Settings';
import { useAccounts } from '../accounts';
import { addTyped, permissionOverride, removeAt, scopeFlags, scopeOf, suggestionsFor, withShared, type AddError } from '../launch-flags';
import { radioNext } from '../radio';
import { useApp } from '../store';
import { t } from '../i18n/en';

// Settings › Claude › Launch flags: the scope (all accounts or one), the shared
// switch, the chip field with Claude Code's known flags, the warning when permissions are skipped, and the exact command.

const save = (claudeFlags: ClaudeFlags) => void window.atelier.settings.set({ claudeFlags });
const accent = (color: number) => ({ '--acct': `var(--person-${color})` } as CSSProperties);

/** One flag as a chip: rose with a struck shield when it skips permissions (or lets Claude skip them); × removes it. */
export function FlagChip({ flag, onRemove, dim }: { flag: LaunchFlag; onRemove?: () => void; dim?: boolean }) {
  const danger = isDangerFlag(flag);
  const label = flagLabel(flag);
  return (
    <span className={`lf-chip mono${danger ? ' is-danger' : ''}${dim ? ' is-dim' : ''}`}>
      {danger && <Icon name="shieldOff" size={11} stroke={1.9} />}
      <span className="lf-chip-text">{flag[0]}{flag.length > 1 && <span className="lf-chip-val"> {label.slice(flag[0]!.length + 1)}</span>}</span>
      {onRemove && <button type="button" className="lf-chip-x" aria-label={t.flags.remove(label)} onClick={onRemove}><Icon name="x" size={9} stroke={2.4} /></button>}
    </span>
  );
}

/** The command main would run for a new session of the account, asked again whenever what goes into it changes. */
function useLaunchPreview(account: string, s: S): string {
  const [cmd, setCmd] = useState('');
  const key = JSON.stringify([account, s.claudeFlags, s.claudeModel, s.claudePermissionMode, s.claudeAccounts.list]);
  useEffect(() => {
    let live = true;
    window.atelier.claude.launchPreview({ account, name: t.flags.sampleName }).then((c) => { if (live) setCmd(c); }, () => { if (live) setCmd(''); });
    return () => { live = false; };
  }, [key]);
  return cmd;
}

export function LaunchFlags({ s }: { s: S }) {
  const accounts = useAccounts();
  const scope = scopeOf(useApp((x) => x.launchFlagsScope), accounts);
  const setScope = (v: string) => useApp.getState().setLaunchFlagsScope(v);
  const f = s.claudeFlags;
  const account = scope === 'all' ? null : accounts.list.find((a) => a.id === scope) ?? null;
  const own = scopeFlags(f, scope);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<{ code: AddError; token: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [hot, setHot] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  // Another scope: a fresh field.
  useEffect(() => { setDraft(''); setError(null); setOpen(false); }, [scope]);
  const sugs = suggestionsFor(own, draft);
  const showing = open && sugs.length > 0;
  const preview = useLaunchPreview(account?.id ?? DEFAULT_ACCOUNT_ID, s);
  const add = (text: string) => {
    const r = addTyped(f, scope, text);
    if ('error' in r) { setError({ code: r.error, token: r.token }); return; }
    save(r.next); setDraft(''); setError(null); setOpen(false); setHot(-1);
  };
  const pick = (i: number) => {
    const sug = sugs[i];
    if (!sug) return;
    if (sug.value) { setDraft(`${sug.flag} `); setOpen(false); setHot(-1); input.current?.focus(); } else add(sug.flag);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = sugs.length;
      if (!open || hot < 0) { setOpen(true); setHot(e.key === 'ArrowDown' ? 0 : n - 1); return; }
      if (n) setHot((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && hot >= 0 && sugs[hot]) pick(hot); else add(draft);
    } else if (e.key === 'Escape' && showing) {
      // The sheet leaves this Esc to the list (data-own-esc), then the next one to the draft, then closes.
      e.preventDefault(); setOpen(false); setHot(-1);
    } else if (e.key === 'Escape' && draft) {
      e.preventDefault(); setDraft(''); setError(null);
    } else if (e.key === 'Backspace' && draft === '' && own.length && !e.repeat) {
      save(removeAt(f, scope, own.length - 1));
    }
  };
  const effective = account ? effectiveFlags(f, account.id) : f.all;
  const danger = skipsPermissions(effective);
  // All accounts: "every session" only when no account leaves those flags out.
  const override = account ? null : permissionOverride(f, accounts);
  const shared = account ? f.accounts[account.id]?.shared !== false : true;
  const scopes = [{ id: 'all', name: t.flags.all, color: 0 }, ...accounts.list.map((a) => ({ id: a.id, name: a.name, color: a.color }))];
  return (
    <div className="lf-section">
      <div className="acct-head">
        <span className="section-label">{t.flags.title}</span>
        <span className="set-hint">{t.flags.hint}</span>
      </div>
      {hasAccounts(accounts) && (
        <div className="set-seg lf-scope" role="radiogroup" aria-label={t.flags.scope} onKeyDown={(e) => {
          const next = radioNext(scopes.map((x) => x.id), scope, e.key);
          if (next === null) return;
          e.preventDefault(); setScope(next);
          (e.currentTarget.querySelector(`[data-value="${CSS.escape(next)}"]`) as HTMLElement | null)?.focus();
        }}>
          {scopes.map((x) => {
            const skips = x.id !== 'all' && skipsPermissions(effectiveFlags(f, x.id));
            return (
              <button key={x.id} type="button" role="radio" aria-checked={x.id === scope} tabIndex={x.id === scope ? 0 : -1} data-value={x.id}
                className={`set-seg-opt${x.id === scope ? ' is-on' : ''}`} onClick={() => setScope(x.id)}>
                {x.color > 0 && <i className={`lf-dot${skips ? ' is-danger' : ''}`} style={accent(x.color)} />}{x.name}
              </button>
            );
          })}
        </div>
      )}
      <div className="lf-card" key={scope}>
        {account && (
          <div className="lf-shared">
            <Toggle label={t.flags.shared} value={shared} onChange={(v) => save(withShared(f, account.id, v))} />
            <span className="lf-shared-label">{t.flags.shared}</span>
            <span className="lf-shared-chips">{f.all.length ? f.all.map((x, i) => <FlagChip key={i} flag={x} dim />) : <span className="set-hint">{t.flags.sharedNone}</span>}</span>
          </div>
        )}
        <div className={`lf-field${error ? ' is-error' : ''}`} data-own-esc={showing || undefined} onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus(); } }}>
          {own.map((x, i) => <FlagChip key={`${i}:${x.join('\u0000')}`} flag={x} onRemove={() => { save(removeAt(f, scope, i)); input.current?.focus(); }} />)}
          <input ref={input} className="lf-input mono" value={draft} spellCheck={false} autoComplete="off" aria-label={t.flags.field}
            placeholder={own.length ? t.flags.placeholderMore : t.flags.placeholder}
            role="combobox" aria-expanded={showing} aria-controls={showing ? 'lf-suggest' : undefined} aria-autocomplete="list"
            aria-activedescendant={open && hot >= 0 && sugs[hot] ? `lf-sug-${hot}` : undefined}
            aria-invalid={!!error} aria-describedby="lf-note"
            onChange={(e) => { setDraft(e.target.value); setError(null); setOpen(true); setHot(-1); }}
            // A click or ↓ opens the list; focus alone doesn't (arriving from a badge or the palette leaves the card in view).
            onClick={() => setOpen(true)} onBlur={() => { setOpen(false); setHot(-1); }} onKeyDown={onKey} />
          {showing && (
            <div id="lf-suggest" className="lf-suggest" role="listbox" aria-label={t.flags.known}>
              <span className="section-label lf-suggest-head" role="presentation">{t.flags.known}</span>
              {sugs.map((x, i) => (
                <div key={x.flag} id={`lf-sug-${i}`} role="option" aria-selected={i === hot} className={`lf-sug${i === hot ? ' is-hot' : ''}${x.flag === DANGER_FLAG ? ' is-danger' : ''}`}
                  onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setHot(i)} onClick={() => pick(i)}>
                  <span className="lf-sug-flag mono">{x.flag}{x.value && <i> {x.value}</i>}</span>
                  <span className="lf-sug-hint">{x.hint}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {error
          ? <span id="lf-note" className="lf-error" role="alert"><Icon name="info" size={12} stroke={1.8} />{t.flags.errors[error.code]!(error.token)}</span>
          : <span id="lf-note" className="lf-keys"><span className="nsa-key">↵</span> {t.flags.keys.add} · <span className="nsa-key">⌫</span> {t.flags.keys.remove} · <span className="nsa-key">↓</span> {t.flags.keys.known} · {t.flags.keys.any}</span>}
        {danger && (
          <div className="lf-danger" role="note">
            <Icon name="shieldOff" size={16} stroke={1.7} />
            <span><b>{account ? t.flags.dangerOne(account.name) : override && 'all' in override ? t.flags.dangerAll : t.flags.dangerShared}</b> {t.flags.dangerBody}</span>
          </div>
        )}
        <div className="lf-preview">
          <span className="section-label">{account ? t.flags.startsAsOne(account.name) : hasAccounts(accounts) ? t.flags.startsAsDefault(accounts.list[0]!.name) : t.flags.startsAs}</span>
          <pre className="lf-cmd mono" data-testid="lf-preview">{preview}</pre>
        </div>
        <div className="lf-applies">
          <span className="is-yes"><Icon name="check" size={12} stroke={2} />{t.flags.applies.sessions}</span>
          <span className="is-yes"><Icon name="check" size={12} stroke={2} />{t.flags.applies.resumed}</span>
          <span className="is-no"><Icon name="x" size={11} stroke={2} />{t.flags.applies.automations}</span>
        </div>
      </div>
    </div>
  );
}
