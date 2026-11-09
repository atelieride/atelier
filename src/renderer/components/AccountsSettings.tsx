import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ACCOUNT_COLORS, DEFAULT_ACCOUNT_ID, hasAccounts, launchDir, nameFromDir, type ClaudeAccount, type ClaudeAccounts } from '@shared/claude-accounts';
import type { Settings as S } from '@shared/settings';
import { Icon } from './Icon';
import { Row } from './Settings';
import { Segmented } from './Segmented';
import { accountFormError, accountUsage, canAddAccount, detectedDirs, dismissDir, expandDir, removeAccount, saveAccount, tildeDir, useAccounts } from '../accounts';
import { useApp } from '../store';
import { effectiveFlags } from '@shared/claude-flags';
import { flagSummary, openLaunchFlags } from '../launch-flags';
import { usageTone } from '../usage';
import { t } from '../i18n/en';

// Settings › Claude › Accounts: the default account and the others, a folder seen in a session
// offered in one click, the account new sessions start with. Removing an account never touches its folder or sessions.

const set = (claudeAccounts: ClaudeAccounts) => void window.atelier.settings.set({ claudeAccounts });
const accent = (color: number | null) => (color ? ({ '--acct': `var(--person-${color})` } as CSSProperties) : undefined);
const tilde = tildeDir;

interface Form { editing?: string; name: string; dir: string; color: number; focus: 'name' | 'color' }

export function AccountsSettings({ s }: { s: S }) {
  const accounts = useAccounts();
  const defaultDir = useApp((x) => x.claudeDefaultDir);
  const home = useApp((x) => x.home);
  const terminals = useApp((x) => x.terminals);
  const detected = detectedDirs(terminals, accounts, defaultDir);
  const [form, setForm] = useState<Form | null>(null);
  // When the form closes, focus goes back to "Add account" (it would drop to the page otherwise).
  const addRef = useRef<HTMLButtonElement>(null);
  const formWas = useRef(false);
  useEffect(() => {
    if (formWas.current && !form) addRef.current?.focus();
    formWas.current = !!form;
  }, [form]);
  const room = canAddAccount(s.claudeAccounts);
  // A new account takes the first color no account has yet.
  const freeColor = () => Array.from({ length: ACCOUNT_COLORS }, (_, i) => i + 1).find((c) => !accounts.list.some((a) => a.color === c)) ?? 1;
  const add = (dir = '', name = '') => setForm({ name, dir: dir ? tilde(dir, home) : '', color: freeColor(), focus: 'name' });
  const edit = (a: ClaudeAccount, focus: Form['focus']) => setForm({ editing: a.id, name: a.name, dir: a.dir ? tilde(a.dir, home) : '', color: a.color, focus });
  const rowMenu = (a: ClaudeAccount, at: { x: number; y: number; anchor: { left: number; right: number; bottom: number } }) => useApp.getState().openMenu(at, [
    { id: 'rename', label: t.accounts.rename, icon: 'edit', run: () => edit(a, 'name') },
    { id: 'color', label: t.accounts.changeColor, icon: 'appearance', run: () => edit(a, 'color') },
    { id: 'flags', label: t.accounts.launchFlags, icon: 'flag', run: () => openLaunchFlags(a.id) },
    ...(hasAccounts(accounts) && s.claudeAccounts.newSession !== a.id ? [{ id: 'default', label: t.accounts.makeDefault, icon: 'sparkle' as const, run: () => set({ ...s.claudeAccounts, newSession: a.id }) }] : []),
    ...(a.id === DEFAULT_ACCOUNT_ID ? [] : ['sep' as const, { id: 'remove', label: t.accounts.remove, icon: 'trash' as const, danger: true, run: () => set(removeAccount(s.claudeAccounts, a.id)) }])
  ]);
  return (
    <>
      <div className="acct-head">
        <span className="section-label">{t.accounts.title}</span>
        <span className="set-hint">{t.accounts.hint}</span>
      </div>
      <div className="acct-list">
        {accounts.list.map((a) => <AccountRow key={a.id} account={a} home={home} onMenu={(at) => rowMenu(a, at)} />)}
      </div>
      {!form && detected.map((d) => (
        <div key={d.dir} className="acct-detected">
          <i className="acct-dot" />
          <p><span className="mono">{tilde(d.dir, home)}</span> {t.accounts.seenIn(d.session)}</p>
          <button type="button" className="btn-ghost sm" onClick={() => set(dismissDir(s.claudeAccounts, d.dir))}>{t.accounts.dismiss}</button>
          {room && <button type="button" className="btn-primary sm" onClick={() => add(d.dir, nameFromDir(d.dir))}>{t.accounts.add}</button>}
        </div>
      ))}
      {form
        ? <AccountForm form={form} accounts={s.claudeAccounts} defaultDir={defaultDir} home={home}
            onCancel={() => setForm(null)} onSave={(next) => { set(next); setForm(null); }} />
        : room
          ? <button ref={addRef} type="button" className="btn-ghost sm acct-add" onClick={() => add()}><Icon name="plus" size={12} stroke={2} />{t.accounts.add}</button>
          : <p className="set-note">{t.accounts.full}</p>}
      {hasAccounts(accounts) && (
        <Row label={t.accounts.newSessions} hint={t.accounts.newSessionsHint}>
          <Segmented label={t.accounts.newSessions} value={accounts.newSession} options={accounts.list.map((a) => ({ value: a.id, label: a.name }))}
            onChange={(v) => set({ ...s.claudeAccounts, newSession: v })} />
        </Row>
      )}
    </>
  );
}

/** One account: color, name (Default for the default one), folder, last known limits, and its menu. */
function AccountRow({ account, home, onMenu }: { account: ClaudeAccount; home: string | null; onMenu: (at: { x: number; y: number; anchor: { left: number; right: number; bottom: number } }) => void }) {
  const usage = useApp((x) => x.usage);
  const defaultDir = useApp((x) => x.claudeDefaultDir);
  const dir = launchDir(account) ?? defaultDir;
  const parts = accountUsage(usage, account, defaultDir);
  const open = (el: HTMLElement) => { const r = el.getBoundingClientRect(); onMenu({ x: r.right, y: r.bottom + 4, anchor: { left: r.left, right: r.right, bottom: r.bottom } }); };
  return (
    <div className="acct-row" style={accent(account.color)}
      onContextMenu={(e) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY, anchor: { left: e.clientX, right: e.clientX, bottom: e.clientY } }); }}>
      <i className="acct-dot" />
      <span className="acct-who">
        <span className="acct-who-name">{account.name}{account.id === DEFAULT_ACCOUNT_ID && <span className="acct-default">{t.accounts.default}</span>}</span>
        {dir && <span className="acct-who-dir mono" data-tip={dir}>{tilde(dir, home)}</span>}
      </span>
      <span className="acct-usage mono">
        {parts.map((p) => (
          <span key={p.key} className="acct-limit">
            {p.key}
            <span className="usage-bar"><span className={`tone-${usageTone(p.pct)}`} style={{ transform: `scaleX(${Math.min(100, Math.max(0, p.pct)) / 100})` }} /></span>
            {p.pct}%
          </span>
        ))}
      </span>
      <AccountFlagsBadge account={account} />
      <button type="button" className="icon-btn acct-more" aria-label={t.accounts.more} data-tip={t.accounts.more}
        onClick={(e) => open(e.currentTarget)} onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); open(e.currentTarget); } }}>
        <Icon name="more" size={16} stroke={2.6} />
      </button>
    </div>
  );
}

/** Its launch flags at a glance: how many, or rose when they skip permissions; opens them. */
function AccountFlagsBadge({ account }: { account: ClaudeAccount }) {
  const f = useApp((x) => x.settings.claudeFlags);
  const { count, danger } = flagSummary(effectiveFlags(f, account.id));
  if (!count) return <span />;
  return (
    <button type="button" className={`lf-badge mono${danger ? ' is-danger' : ''}`} data-tip={t.flags.badgeTip} onClick={() => openLaunchFlags(account.id)}>
      <Icon name={danger ? 'shieldOff' : 'flag'} size={11} stroke={1.9} />{danger ? t.flags.badgeDanger : t.flags.badge(count)}
    </button>
  );
}

/** Add or change an account: name, folder (typed, ~/… allowed, or from the open panel), color. */
function AccountForm({ form, accounts, defaultDir, home, onCancel, onSave }: { form: Form; accounts: ClaudeAccounts; defaultDir: string | null; home: string | null; onCancel: () => void; onSave: (next: ClaudeAccounts) => void }) {
  const [name, setName] = useState(form.name);
  const [dir, setDir] = useState(form.dir);
  const [color, setColor] = useState(form.color);
  const [tried, setTried] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const colorsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (form.focus === 'color') colorsRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    else nameRef.current?.focus();
  }, [form.focus]);
  const isDefault = form.editing === DEFAULT_ACCOUNT_ID;
  const full = expandDir(dir, home);
  const error = accountFormError({ name, dir: full }, accounts, defaultDir, form.editing);
  const save = () => { setTried(true); if (!error) onSave(saveAccount(accounts, { name, dir: full, color }, form.editing)); };
  const pick = async () => { const d = await window.atelier.claude.pickDir(); if (d) setDir(tilde(d, home)); };
  return (
    <div className="acct-form" style={accent(color)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
      <label className="acct-form-label" htmlFor="acct-name">{t.accounts.name}</label>
      <input id="acct-name" ref={nameRef} className="set-text-input" value={name} maxLength={40} aria-label={t.accounts.name} placeholder={t.accounts.namePlaceholder}
        aria-invalid={tried && error === 'name'} aria-describedby={tried && error === 'name' ? 'acct-error' : undefined}
        onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
      {!isDefault && (
        <>
          <label className="acct-form-label" htmlFor="acct-dir">{t.accounts.folder}</label>
          <span className="acct-form-dir">
            <input id="acct-dir" className="set-text-input mono" value={dir} spellCheck={false} aria-label={t.accounts.folder} placeholder="~/.claude_work"
              aria-invalid={tried && !!error && error !== 'name'} aria-describedby={tried && error && error !== 'name' ? 'acct-error' : undefined}
              onChange={(e) => setDir(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
            <button type="button" className="btn-ghost sm" onClick={() => void pick()}>{t.accounts.choose}</button>
          </span>
        </>
      )}
      <span className="acct-form-label">{t.accounts.color}</span>
      <div ref={colorsRef} className="acct-swatches" role="radiogroup" aria-label={t.accounts.color}
        onKeyDown={(e) => {
          const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
          if (!step) return;
          e.preventDefault();
          const next = ((color - 1 + step + ACCOUNT_COLORS) % ACCOUNT_COLORS) + 1;
          setColor(next);
          (e.currentTarget.querySelector(`[data-color="${next}"]`) as HTMLElement | null)?.focus();
        }}>
        {Array.from({ length: ACCOUNT_COLORS }, (_, i) => i + 1).map((c) => (
          <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={t.accounts.colors[c - 1]} tabIndex={c === color ? 0 : -1} data-color={c}
            className={`acct-swatch${c === color ? ' is-on' : ''}`} style={accent(c)} onClick={() => setColor(c)} />
        ))}
      </div>
      {tried && error && <span id="acct-error" className="set-warn acct-form-error" role="alert"><Icon name="info" size={12} stroke={1.8} />{t.accounts.errors[error]}</span>}
      {!isDefault && <p className="acct-form-note">{t.accounts.folderNote}</p>}
      <div className="acct-form-actions">
        <button type="button" className="btn-ghost sm" onClick={onCancel}>{t.accounts.cancel}</button>
        <button type="button" className="btn-primary sm" onClick={save}>{t.accounts.save}</button>
      </div>
    </div>
  );
}
