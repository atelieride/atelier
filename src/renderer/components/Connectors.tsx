// Settings › Connectors: a list with one row per connector (its state chip and at
// most the one action that can't wait), and a details page per connector with today's card content (status block,
// actions, the Disconnect confirm, the connector's own options; Notion's databases, NotionSources.tsx). The words and
// states come from connectors-view.ts; the header's "‹ Connectors" from ConnectorsBack.tsx (the first paint's).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ConnectorId, ConnectorInfo } from '@shared/tasks';
import { OPEN_IN_APP_SETTING } from '@shared/settings';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { CONNECTOR_ICONS, connectorRow, connectorView, revokeHint, workspaceValue } from '../connectors-view';
import { confirmDisconnect, runConnectorAction } from '../connector-actions';
import { jiraRow, jiraView } from '../jira-view';
import { Icon } from './Icon';
import { JiraOptions, JiraTokenSignIn } from './JiraOptions';
import { JiraProjects } from './JiraProjects';
import { NotionSources } from './NotionSources';
import { Row, Toggle } from './Settings';
import { useConnectorDetail } from './ConnectorsBack';

/** A clock for relative times: every second while counting down, every 30 s otherwise. */
function useNow(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), fast ? 1000 : 30_000);
    return () => clearInterval(id);
  }, [fast]);
  return now;
}

/** Settings › Connectors: the list, or one connector's details. Loaded with the section (Settings.tsx). */
export function Connectors() {
  const detail = useConnectorDetail();
  const id = detail?.id ?? null;
  // Back from a details page: focus lands on that connector's row (a keyboard user keeps their place).
  const from = useRef<ConnectorId | null>(null);
  useEffect(() => {
    if (id) { from.current = id; return; }
    const was = from.current;
    from.current = null;
    if (!was) return;
    const raf = requestAnimationFrame(() => document.querySelector<HTMLElement>(`.conn-row[data-connector="${was}"] .conn-row-open`)?.focus());
    return () => cancelAnimationFrame(raf);
  }, [id]);
  return detail ? <ConnectorDetails key={detail.id} c={detail} /> : <ConnectorList />;
}

function ConnectorList() {
  const list = useApp((s) => s.connectors);
  // Like Settings' sections: ↑ ↓ move between the rows (wrapping), Enter or Space opens one.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('.conn-row-open')];
    const i = rows.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
  };
  return (
    <div className="conn-page">
      <p className="conn-intro">{t.conn.intro}</p>
      <div className="conn-list" role="list" onKeyDown={onKey}>
        {list.map((c) => <ConnectorRow key={c.id} c={c} />)}
      </div>
      <p className="conn-foot"><Icon name="eye" size={13} stroke={1.9} />{t.conn.footnote}</p>
    </div>
  );
}

/**
 * One row. The whole row opens the details: a button laid over it, so the row's own action stays a separate
 * button next to it (a button can't hold another) and never opens the details.
 */
function ConnectorRow({ c }: { c: ConnectorInfo }) {
  const now = useNow(c.status === 'connecting');
  const r = c.id === 'jira' ? jiraRow(c, now) : connectorRow(c, now);
  const line = `conn-line-${c.id}`;
  const chip = `conn-chip-${c.id}`;
  const open = () => useApp.getState().openConnector(c.id);
  return (
    <div className={`conn-row${r.chip ? ` tone-${r.chip.tone}` : ''}`} role="listitem" data-connector={c.id} data-status={c.status}>
      {/* The tooltip carries the whole line, should two lines not hold it. */}
      <button type="button" className="conn-row-open" aria-label={t.conn.rowLabel(c.name)} aria-describedby={r.chip ? `${chip} ${line}` : line}
        data-tip={r.line} onClick={open} />
      <span className="conn-icon" aria-hidden="true"><Icon name={CONNECTOR_ICONS[c.id]} size={22} stroke={1.9} /></span>
      <span className="conn-row-text">
        <span className="conn-name">{c.name}</span>
        <span className="conn-row-line" id={line}>{r.line}</span>
      </span>
      {r.chip && (
        <span key={`${r.chip.tone}:${r.chip.label}`} className={`conn-chip tone-${r.chip.tone}`} id={chip}>
          <i aria-hidden="true" />{r.chip.label}
          {/* Takes the pointer for its tooltip; a click on it still opens the details. */}
          {r.chip.countdown && <span className="conn-chip-count mono" data-tip={t.conn.countdownTip} aria-hidden="true" onClick={open}>{r.chip.countdown}</span>}
        </span>
      )}
      {r.action && (
        <button type="button" className={`conn-row-action ${r.action.primary ? 'btn-primary' : 'btn-ghost'}`} aria-label={r.action.aria}
          onClick={(e) => { e.stopPropagation(); runConnectorAction(c.id, r.action!.id); }}>
          {r.action.label}
        </button>
      )}
      <span className="conn-chev" aria-hidden="true"><Icon name="chevron" size={16} stroke={2} /></span>
    </div>
  );
}

/** A connector's details page: today's card without its frame. */
function ConnectorDetails({ c }: { c: ConnectorInfo }) {
  const now = useNow(c.status === 'connecting');
  const confirming = useApp((s) => s.connectorConfirm === c.id);
  const tokenForm = useApp((s) => s.connectorTokenForm === c.id);
  // An API token sent from this page (Jira): its attempt has no browser to wait for.
  const [tokenSent, setTokenSent] = useState(false);
  const v = c.id === 'jira' ? jiraView(c, now, { tokenFlow: tokenSent, tokenForm }) : connectorView(c, now);
  const page = useRef<HTMLElement>(null);
  const live = c.status === 'connected' || c.status === 'offline';
  const signedOut = c.status === 'disconnected' || c.status === 'reconnect';

  // Signed in (or the form closed): the token form's job is done.
  useEffect(() => {
    if (live && tokenForm) useApp.getState().setConnectorTokenForm(null);
    if (live || !tokenForm) setTokenSent(false);
  }, [live, tokenForm]);

  useEffect(() => {
    page.current?.closest('.set-content')?.scrollTo({ top: 0 });
    // (⌘[ goes back from the sheet's own key handler, wherever the focus is: Settings.tsx.)
    // Focus starts on the back button — unless the page opened with its Disconnect confirm (the palette's
    // "Disconnect ClickUp…"), which focuses its safe choice. After the sheet's own first focus (it runs after this).
    const raf = useApp.getState().connectorConfirm === c.id ? 0
      : requestAnimationFrame(() => document.querySelector<HTMLElement>('.settings .conn-back')?.focus());
    return () => cancelAnimationFrame(raf);
  }, [c.id]);

  // After the confirm closes (either way), focus goes back to the page's first action instead of getting lost.
  const wasConfirming = useRef(confirming);
  useEffect(() => {
    if (wasConfirming.current && !confirming) requestAnimationFrame(() => page.current?.querySelector<HTMLElement>('.conn-actions button')?.focus());
    wasConfirming.current = confirming;
  }, [confirming]);

  return (
    <section ref={page} className={`conn-details tone-${v.tone}`} aria-label={c.name} data-connector={c.id} data-status={c.status}>
      <div className="conn-head">
        <span className="conn-icon" aria-hidden="true"><Icon name={CONNECTOR_ICONS[c.id]} size={24} stroke={1.9} /></span>
        <div className="conn-title">
          <div className="conn-name-row">
            <h2 className="conn-name">{c.name}</h2>
            <span className="conn-badge" data-tip={t.conn.readOnlyTip(c.name)}><Icon name="eye" size={11} stroke={1.9} />{t.conn.readOnly}</span>
          </div>
          <span className="conn-desc">{t.conn.detailDescriptions[c.id]}</span>
        </div>
      </div>

      <div className="conn-status" role="status" aria-label={`${c.name}: ${v.line}`}>
        <span className="conn-dot" aria-hidden="true" />
        <div className="conn-status-text">
          <span className="conn-line">
            {v.line}
            {v.countdown && <span className="conn-countdown mono" data-tip={t.conn.countdownTip} aria-hidden="true">{v.countdown}</span>}
          </span>
          {v.sub && <span className={`conn-sub is-${v.subTone ?? 'muted'}`}>{v.sub}</span>}
        </div>
      </div>

      {confirming
        ? <DisconnectConfirm c={c} />
        : (
          <div className="conn-actions">
            {v.actions.map((a) => (
              <button key={a.id} type="button" onClick={() => runConnectorAction(c.id, a.id)}
                className={a.primary && !a.danger ? 'btn-primary' : `btn-ghost${a.danger ? ' is-danger' : ''}${a.primary ? ' is-strong' : ''}`}>
                {a.label}
              </button>
            ))}
          </div>
        )}

      {/* Jira's API-token sign-in, under Connect, and who can unblock an organization's. */}
      {/* The form stays while its token is checked: a refusal keeps the site and e-mail typed. */}
      {c.id === 'jira' && !confirming && (signedOut || (c.status === 'connecting' && tokenForm)) &&
        <JiraTokenSignIn c={c} sent={tokenSent} onSent={() => setTokenSent(true)} />}
      {c.id === 'jira' && !tokenForm && (signedOut || (c.status === 'connecting' && !tokenSent)) && <p className="conn-help">{t.conn.jira.adminHint}</p>}

      {/* Notion's databases and Jira's projects come before their options (6). */}
      {live && c.id === 'notion' && <NotionSources c={c} />}
      {live && c.id === 'jira' && <JiraProjects c={c} />}
      {live && (
        <div className="conn-options">
          {c.id === 'clickup' ? <ClickUpOptions c={c} /> : c.id === 'jira' ? <JiraOptions c={c} /> : <NotionOptions c={c} />}
        </div>
      )}
    </section>
  );
}

const setOptions = (c: ConnectorInfo, includeClosed: boolean) => void window.atelier.connectors.setOptions(c.id, { includeClosed }).catch(() => {});

function IncludeClosedRow({ c }: { c: ConnectorInfo }) {
  return (
    <Row label={t.conn.includeClosed} hint={t.conn.includeClosedHint}>
      <Toggle label={t.conn.includeClosed} value={c.options.includeClosed} onChange={(v) => setOptions(c, v)} />
    </Row>
  );
}

/** "Open tasks in the <App> app": each connector has its own setting. */
function OpenInAppRow({ c }: { c: ConnectorInfo }) {
  const key = OPEN_IN_APP_SETTING[c.id];
  const value = useApp((s) => (key === null ? false : s.settings[key]));
  if (key === null) return null;
  return (
    <Row label={t.conn.openInApp(c.name)} hint={t.conn.openInAppHint}>
      <Toggle label={t.conn.openInApp(c.name)} value={value} onChange={(v) => void window.atelier.settings.set({ [key]: v })} />
    </Row>
  );
}

/** ClickUp's options: today's rows. */
function ClickUpOptions({ c }: { c: ConnectorInfo }) {
  return (
    <>
      <Row label={t.conn.workspace} hint={t.conn.workspaceHint}><span className="conn-value">{workspaceValue(c)}</span></Row>
      <Row label={t.conn.show}><span className="conn-value">{t.conn.assignedToMe}</span></Row>
      <IncludeClosedRow c={c} />
      <OpenInAppRow c={c} />
    </>
  );
}

/** Notion's options, under its Task databases section (NotionSources). */
function NotionOptions({ c }: { c: ConnectorInfo }) {
  return (
    <>
      <IncludeClosedRow c={c} />
      <OpenInAppRow c={c} />
    </>
  );
}

/** Asked once, on the details page. Esc or "Keep connected" closes it; focus starts on the safe choice. */
function DisconnectConfirm({ c }: { c: ConnectorInfo }) {
  const keep = useRef<HTMLButtonElement>(null);
  // After the Settings sheet's own first focus (it runs after this, when the confirm opens with the sheet).
  useEffect(() => { const id = requestAnimationFrame(() => keep.current?.focus()); return () => cancelAnimationFrame(id); }, []);
  const close = () => useApp.getState().setConnectorConfirm(null);
  return (
    <div className="conn-confirm" role="group" aria-label={t.conn.confirmTitle(c.name)} data-own-esc=""
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }}>
      <p className="conn-confirm-text"><b>{t.conn.confirmTitle(c.name)}</b> {t.conn.confirmBody}</p>
      <div className="conn-actions">
        <button type="button" className="btn-danger" onClick={() => confirmDisconnect(c.id)}>{t.conn.actions.disconnect}</button>
        <button type="button" className="btn-ghost" ref={keep} onClick={close}>{t.conn.confirmKeep}</button>
      </div>
      <p className="conn-revoke">{revokeHint(c)}</p>
    </div>
  );
}
