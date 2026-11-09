// Jira's details page beyond the generic status block (5, 9):
// its options under the projects (the saved filter, Include done issues, "no desktop app"), and the API-token sign-in on
// the disconnected page (a quiet link that expands the form; Reconnect after an expired token opens it prefilled).
// The token crosses to main once, typed by the user, and leaves the form's state as soon as it is sent.
import { useEffect, useRef, useState } from 'react';
import type { ConnectorInfo, FilterPick } from '@shared/tasks';
import { t } from '../i18n/en';
import { openBelow } from '../menus';
import { useApp } from '../store';
import { API_TOKENS_PAGE, filterChoices, filterValue, tokenCreds, tokenDraftFor, tokenFormError, tokenFormMessage, type TokenDraft } from '../jira-view';
import { Icon } from './Icon';
import { Row, Toggle } from './Settings';

const j = t.conn.jira;

/** The options under the projects: the saved filter, done issues, and where issues open. */
export function JiraOptions({ c }: { c: ConnectorInfo }) {
  return (
    <>
      <FilterRow c={c} />
      <Row label={j.includeDone} hint={j.includeDoneHint}>
        <Toggle label={j.includeDone} value={c.options.includeClosed}
          onChange={(v) => void window.atelier.connectors.setOptions(c.id, { includeClosed: v }).catch(() => {})} />
      </Row>
      <p className="conn-note"><Icon name="externalLink" size={12} stroke={1.9} />{j.noApp}</p>
    </>
  );
}

/**
 * "Only issues in a saved filter": the Aurora menu below a select-like button, with None and the user's filters read
 * when it opens (the last listing is what main accepts back). A failed listing says so under the row; a filter that
 * disappeared says so once (main forgets it).
 */
function FilterRow({ c }: { c: ConnectorInfo }) {
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const current = filterValue(c);
  // Main ignores choosing the filter already chosen; None after a gone filter clears its line.
  const choose = (id: string | null) => void window.atelier.connectors.setFilter(c.id, id).catch(() => {});
  const open = async () => {
    if (loading) return;
    setLoading(true);
    setFailed(false);
    let filters: FilterPick[];
    try { filters = await window.atelier.connectors.listFilters(c.id); } catch { setLoading(false); setFailed(true); return; }
    setLoading(false);
    if (!button.current?.isConnected) return;
    openBelow(button.current, filterChoices(filters, c).map((x) => x === 'none-left'
      ? { id: 'no-filters', label: j.noFilters, disabled: true, run: () => {} }
      : { id: x.id ?? 'none', label: x.label, ...(x.on ? { icon: 'check' as const } : {}), run: () => choose(x.id) }));
  };
  const warn = failed ? j.filtersFailed : c.filterGone ? j.filterGone : null;
  return (
    <Row label={j.filter} hint={j.filterHint} warn={warn}>
      <button ref={button} type="button" className="nsf-select jira-filter" aria-haspopup="menu" aria-label={`${j.filter}: ${current}`} aria-busy={loading || undefined}
        onClick={() => void open()}>
        <span className={`nsf-select-name${c.filter ? '' : ' is-none'}`}>{loading ? j.filterLoading : current}</span>
        <Icon name="chevronDown" size={12} stroke={2} />
      </button>
    </Row>
  );
}

/**
 * Under Connect on the disconnected page: "Use an API token instead…", or the form itself — open from that
 * link, or from Reconnect after an expired token (e-mail and site prefilled). `sent`: a token went to main from this
 * page (the status block then says "Checking the API token…", and the form shows why an attempt failed).
 */
export function JiraTokenSignIn({ c, sent, onSent }: { c: ConnectorInfo; sent: boolean; onSent(): void }) {
  const open = useApp((s) => s.connectorTokenForm === c.id);
  const setOpen = (on: boolean) => useApp.getState().setConnectorTokenForm(on ? c.id : null);
  if (!open) {
    return (
      <button type="button" className="link-btn conn-token-link" onClick={() => setOpen(true)}>
        <Icon name="lock" size={12} stroke={1.9} />{j.useToken}
      </button>
    );
  }
  return <TokenForm c={c} sent={sent} onSent={onSent} onCancel={() => setOpen(false)} />;
}

function TokenForm({ c, sent, onSent, onCancel }: { c: ConnectorInfo; sent: boolean; onSent(): void; onCancel(): void }) {
  const [draft, setDraft] = useState<TokenDraft>(() => tokenDraftFor(c));
  const [tried, setTried] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  // Prefilled (Reconnect): the token is what's missing.
  useEffect(() => {
    const id = requestAnimationFrame(() => (draft.site && draft.user ? secretRef.current : first.current)?.focus());
    return () => cancelAnimationFrame(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const error = tokenFormError(draft);
  const busy = c.status === 'connecting';
  const failure = tried && error ? j.errors[error] : tokenFormMessage(c, sent);
  const set = (k: keyof TokenDraft) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const submit = () => {
    setTried(true);    if (error || busy) return;
    const creds = tokenCreds(draft);
    // Gone from the form's state at once: main has the only copy.
    setDraft((d) => ({ ...d, secret: '' }));
    setTried(false);
    onSent();
    void window.atelier.connectors.connectToken(c.id, creds).catch(() => {});
  };
  const field = (k: keyof TokenDraft) => tried && error === k;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
  };
  return (
    <div className="conn-token" role="group" aria-label={j.tokenTitle} data-own-esc="" onKeyDown={onKey}>
      <span className="conn-token-title">{j.tokenTitle}</span>
      <label className="conn-token-label" htmlFor="jira-token-site">{j.site}</label>
      <input id="jira-token-site" ref={first} className="set-text-input mono" value={draft.site} placeholder={j.sitePlaceholder} spellCheck={false}
        autoComplete="off" aria-invalid={field('site') || undefined} onChange={set('site')} disabled={busy} />
      <label className="conn-token-label" htmlFor="jira-token-user">{j.email}</label>
      <input id="jira-token-user" className="set-text-input" type="email" value={draft.user} placeholder={j.emailPlaceholder} spellCheck={false}
        autoComplete="off" aria-invalid={field('user') || undefined} onChange={set('user')} disabled={busy} />
      <label className="conn-token-label" htmlFor="jira-token-secret">{j.token}</label>
      <input id="jira-token-secret" ref={secretRef} className="set-text-input mono" type="password" value={draft.secret} spellCheck={false}
        autoComplete="off" aria-invalid={field('secret') || undefined} onChange={set('secret')} disabled={busy} />
      <p className="conn-token-hint">{j.tokenHint}</p>
      {failure && <span className="set-warn conn-token-error" role="alert"><Icon name="info" size={12} stroke={1.8} />{failure}</span>}
      <div className="conn-token-actions">
        <button type="button" className="btn-ghost sm" onClick={() => void window.atelier.openUrl(API_TOKENS_PAGE)}>
          <Icon name="externalLink" size={12} stroke={1.9} />{j.openTokens}
        </button>
        <span className="grow" />
        <button type="button" className="btn-ghost sm" onClick={onCancel}>{j.cancel}</button>
        <button type="button" className="btn-primary sm" disabled={busy} onClick={submit}>{j.connectToken}</button>
      </div>
    </div>
  );
}
