import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import type { ClaudeConfig, ConfiguredItem } from '@shared/claude-config';
import { sessionTotals } from '../selectors';
import { showContext } from '../ring';
import type { ClaudeModel } from '@shared/settings';
import { permissionModeLabel } from '@shared/session-view';
import { Icon, type IconName } from './Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { radioNext } from '../radio';
import { copyText } from '../clipboard';
import { continueOnPhone, remoteAvailability } from '../remote';
import { PANEL_MODELS, clearSession, compactSession, modeAvailability, modelOf, nextMode, panelAvailability, panelReason, switchModel, type PanelAvailability } from '../session-panel';
import type { Restart } from '../session-restart';
import { workSummary } from '@shared/background';
import { kbd } from '../kbd';
import { GROUP_ORDER } from '@shared/context-usage';
import { contextReportOf, openContextSheet } from '../context-actions';

const WIDTH = 368;
const GAP = 6;
const MARGIN = 8;
/** Chips shown per Configured group before "+N more". */
const FOLD = 10;

const FOCUSABLE = 'button, [href], input, [tabindex]:not([tabindex="-1"])';
const NO_NAMES: readonly string[] = [];

/** Where the panel sits: under the session bar, its right edge on the model chip's (or the bar's, when the chip is hidden). */
function place(bar: HTMLElement): CSSProperties {
  const b = bar.getBoundingClientRect();
  const chip = bar.querySelector<HTMLElement>('.sb-model');
  const c = chip?.getBoundingClientRect();
  const right = c && c.width > 0 ? c.right + 12 : b.right - 10;
  const left = Math.max(MARGIN, Math.min(right - WIDTH, window.innerWidth - WIDTH - MARGIN));
  const top = b.bottom + GAP;
  return { left, top, width: Math.min(WIDTH, window.innerWidth - 2 * MARGIN), maxHeight: Math.max(160, window.innerHeight - top - 16) };
}

/** A typing action's button: disabled (with the reason as its tooltip) while Claude isn't at its prompt. */
function ActionButton({ icon, label, tip, why, onClick, className = '' }: { icon: IconName; label: string; tip: string; why: string | null; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={`spanel-action ${className}`} aria-disabled={why !== null || undefined} data-tip={why ?? tip} onClick={() => { if (why === null) onClick(); }}>
      <Icon name={icon} size={13} stroke={1.8} /><span>{label}</span>
    </button>
  );
}

/**
 * The session's numbers under the panel's head: lines added and removed, cost, context —
 * the bar keeps only the context. A number not known is a dash; with none, nothing.
 */
export function SessionStats({ s, split = null, onContext }: { s: SessionInfo; split?: { id: string; tokens: number }[] | null; onContext?: () => void }) {
  const totals = sessionTotals(s.cost);
  const ctx = showContext(s.contextPct) ? `${s.contextPct}%` : null;
  if (!totals?.lines && !totals?.usd && !ctx) return null;
  // Context usage: the tile opens the Context sheet; with a report from this app
  // run, a thin split bar under the number.
  const context = (
    <>
      <span className="spanel-stat-k">{t.panel.context}{onContext && <Icon name="chevron" size={9} stroke={2.4} />}</span>
      <span className={`spanel-stat-v mono${s.contextPct !== null && s.contextPct >= 80 ? ' is-high' : ''}`}>{ctx ?? '—'}</span>
      {split && split.length > 0 && (
        <span className="spanel-split" aria-hidden="true">
          {split.map((x) => <i key={x.id} style={{ flexGrow: x.tokens, background: `var(--ctx-${x.id})` }} />)}
        </span>
      )}
    </>
  );
  return (
    <div className="spanel-stats" role="group" aria-label={t.panel.stats}>
      <div className="spanel-stat" data-tip={t.sessionLines}>
        <span className="spanel-stat-k">{t.panel.lines}</span>
        <span className="spanel-stat-v mono">{totals?.lines ? <><b className="k-add">{totals.lines.added}</b><b className="k-del">{totals.lines.removed}</b></> : '—'}</span>
      </div>
      <div className="spanel-stat" data-tip={t.sessionCost}>
        <span className="spanel-stat-k">{t.panel.cost}</span>
        <span className="spanel-stat-v mono">{totals?.usd ?? '—'}</span>
      </div>
      {onContext
        ? <button type="button" className="spanel-stat is-button" data-tip={t.context.tileTip} onClick={onContext}>{context}</button>
        : <div className="spanel-stat">{context}</div>}
    </div>
  );
}

/** `added`: MCP servers added since the session started, tagged "not loaded" and listed first. */
/** The Restart button's face: running (disabled), armed (Don't Restart), or what a press does now. */
function restartView(r: Restart | undefined, avail: PanelAvailability): { label: string; tip: string; armed: boolean; running: boolean; run: () => void } {
  const armed = r?.armed === true;
  const running = r?.armed === false;
  const label = running ? t.restart.restarting : armed ? t.restart.dontRestart : avail === 'ok' ? t.restart.panelAction : t.restart.whenDone;
  return { label, tip: armed ? t.restart.armedTip.split('\n')[0]! : t.restart.tip, armed, running, run: () => {} };
}

function ConfigGroup({ label, items, added = NO_NAMES }: { label: string; items: ConfiguredItem[]; added?: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const isNew = (x: ConfiguredItem) => x.state !== 'disabled' && added.includes(x.name);
  const ordered = added.length > 0 ? [...items.filter(isNew), ...items.filter((x) => !isNew(x))] : items;
  const shown = open ? ordered : ordered.slice(0, FOLD);
  return (
    <div className="spanel-group" role="group" aria-label={label}>
      <div className="spanel-group-head"><span>{label}</span><span className="spanel-count mono">{items.length}</span></div>
      {items.length === 0
        ? <p className="spanel-none">{t.panel.none}</p>
        : (
          <ul className="spanel-chips">
            {shown.map((x) => isNew(x)
              ? (
                <li key={`${x.scope}:${x.name}`} className="spanel-chip is-new" data-tip={`${t.panel.scope[x.scope]} · ${t.restart.notLoadedTip}`}>
                  <i aria-hidden="true" /><span className="mono">{x.name}</span><em>{t.restart.notLoaded}</em>
                </li>
              )
              : (
                <li key={`${x.scope}:${x.name}`} className={`spanel-chip is-${x.state}`} data-tip={t.panel.itemTip(t.panel.scope[x.scope], t.panel.state[x.state])}>
                  <i aria-hidden="true" /><span className="mono">{x.name}</span>{x.state !== 'enabled' && <em>{t.panel.state[x.state]}</em>}
                </li>
              ))}
            {items.length > FOLD && (
              <li><button type="button" className="spanel-more" onClick={() => setOpen(!open)}>{open ? t.panel.less : t.panel.more(items.length - FOLD)}</button></li>
            )}
          </ul>
        )}
    </div>
  );
}

/**
 * The model chip's popover: model, mode, quick actions and what Claude Code's config files set up. Every
 * action that types into the session waits for Claude's prompt; the rest (rename, copy, phone) follow their own rules.
 */
export function SessionPanel({ term, bar, onRename }: { term: TerminalInfo; bar: HTMLElement; onRename: () => void }) {
  const s = term.session!;
  const box = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>(() => place(bar));
  const [confirmClear, setConfirmClear] = useState(false);
  const [config, setConfig] = useState<ClaudeConfig | 'loading' | 'error'>('loading');
  const avail = panelAvailability(term);
  const why = panelReason(avail);
  // Phone and Next mode type no Enter (a draft is no hazard there): their own availability, in the panel's words.
  const phoneWhy = panelReason(remoteAvailability(term));
  const modeWhy = panelReason(modeAvailability(term));
  const current = modelOf(s.model);
  const cwd = s.cwd ?? term.cwd;
  const close = (focusChip: boolean) => {
    useApp.getState().setSessionPanel(null);
    if (focusChip) bar.querySelector<HTMLElement>('.sb-model')?.focus();
  };

  // It follows the bar and the chip: the window, Changes, the sidebar or a split divider resizing the bar, chips coming
  // and going before the model chip.
  useLayoutEffect(() => {
    const again = () => setStyle((prev) => { const next = place(bar); return JSON.stringify(next) === JSON.stringify(prev) ? prev : next; });
    window.addEventListener('resize', again);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(again) : null;
    ro?.observe(bar);
    const chip = bar.querySelector('.sb-model');
    if (chip) ro?.observe(chip);
    // Chips added or removed before the model chip move it without resizing it or the bar.
    const mo = new MutationObserver(again);
    mo.observe(bar, { childList: true });
    return () => { window.removeEventListener('resize', again); ro?.disconnect(); mo.disconnect(); };
  }, [bar]);

  // The panel itself takes the keyboard — never a model button, which an Enter still held from the menu or palette that
  // opened it would press; it goes back where it was when the panel closes, unless something took it meanwhile (an
  // action hands it to the terminal).
  useLayoutEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus();
    return () => {
      const now = document.activeElement;
      if (before && before.isConnected && (!now || now === document.body)) before.focus();
    };
  }, []);

  useEffect(() => {
    let live = true;
    setConfig('loading');
    window.atelier.claude.config(cwd, term.id).then((c) => { if (live) setConfig(c); }, () => { if (live) setConfig('error'); });
    return () => { live = false; };
  }, [cwd, term.id]);

  useEffect(() => {
    // The chip toggles by itself: a press on it is not "outside".
    const down = (ev: MouseEvent) => {
      const el = ev.target as Element | null;
      if (!box.current?.contains(el) && !(el && bar.querySelector('.sb-model')?.contains(el))) close(false);
    };
    window.addEventListener('mousedown', down, true);
    return () => window.removeEventListener('mousedown', down, true);
  }, [bar]);

  // The question takes the keyboard (on Cancel); stepping back gives it to Clear… again, never to the page behind.
  const asked = useRef(false);
  useEffect(() => {
    if (confirmClear) box.current?.querySelector<HTMLElement>('.spanel-cancel')?.focus();
    else if (asked.current) box.current?.querySelector<HTMLElement>('.spanel-action.is-clear')?.focus();
    asked.current = confirmClear;
  }, [confirmClear]);

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault(); ev.stopPropagation();
      if (confirmClear) { setConfirmClear(false); return; }
      close(true);
      return;
    }
    // Tab cycles inside the panel: focus never wanders behind it while it is open.
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const items = [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((x) => x.tabIndex >= 0);
      if (items.length === 0) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = ev.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === -1 || i === items.length - 1 ? 0 : i + 1);
      items[next]!.focus();
    }
  };

  // Model: arrows move between the options (a single Tab stop), Enter or Space chooses — choosing types into the session.
  const [focusModel, setFocusModel] = useState<ClaudeModel>(current ?? PANEL_MODELS[0]!);
  const onModelKeys = (ev: KeyboardEvent<HTMLDivElement>) => {
    const next = radioNext(PANEL_MODELS, focusModel, ev.key);
    if (next === null) return;
    ev.preventDefault();
    setFocusModel(next);
    ev.currentTarget.querySelector<HTMLElement>(`[data-model="${next}"]`)?.focus();
  };

  const groups = config !== 'loading' && config !== 'error' ? config : null;
  const unreadable = config === 'error' || (groups?.unreadable ?? false);
  // Restart Session: now, asked here, or armed; armed, the same button cancels it.
  const added = useApp((st) => st.mcpAdded[term.id] ?? NO_NAMES);
  const restartState = useApp((st) => st.restarts[term.id]);
  const asking = useApp((st) => st.restartAsk?.id === term.id && st.restartAsk.at === 'panel');
  const restart = restartView(restartState, avail);
  const report = useApp((st) => contextReportOf(st, term));
  const split = report ? GROUP_ORDER.filter((id) => report.groups[id] > 0).map((id) => ({ id, tokens: report.groups[id] })) : null;
  restart.run = () => {
    if (restart.running) return;
    if (restart.armed) { useApp.getState().cancelRestart(term.id); return; }
    useApp.getState().restartSession(term.id, 'panel');
  };
  return createPortal(
    <div ref={box} className="spanel" style={style} role="dialog" aria-label={`${t.panel.title}: ${term.title}`} tabIndex={-1} onKeyDown={onKeyDown}
      // A portal still bubbles through React's tree: a right-click here is not the pane header's (split view).
      onContextMenu={(e) => e.stopPropagation()}>
      <div className="spanel-head">
        <Icon name="sliders" size={14} stroke={1.8} />
        <span className="spanel-title">{t.panel.title}</span>
        <span className="spanel-sub" title={term.title}>{term.title}</span>
        <button type="button" className="spanel-x" aria-label={t.panel.close} data-tip={t.panel.close} data-kbd="Esc" onClick={() => close(true)}><Icon name="x" size={12} stroke={2} /></button>
      </div>
      <SessionStats s={s} split={split} onContext={() => openContextSheet(term.id)} />
      {why && <p className={`spanel-notice ${avail === 'waiting' || avail === 'draft' ? 'is-waiting' : ''}`} role="status"><i aria-hidden="true" />{why}</p>}

      {added.length > 0 && (
        <div className="spanel-mcp" role="status">
          <span className="spanel-mcp-text">
            <Icon name="plug" size={13} stroke={1.9} />
            <span>
              {t.restart.notice} {added.map((n, i) => <span key={n}>{i > 0 && ', '}<b>{n}</b></span>)}
              <span className="spanel-mcp-note">{t.restart.noticeNote}</span>
            </span>
          </span>
          {!asking && (
            <button type="button" className="spanel-mcp-go" aria-disabled={restart.running || undefined} data-tip={restart.tip} onClick={restart.run}>
              <Icon name="restart" size={12} stroke={2} />{restart.armed || restart.running ? restart.label : t.restart.noticeGo}
            </button>
          )}
        </div>
      )}

      <div className="spanel-body">
        <section className="spanel-sec">
          <div className="spanel-label"><span>{t.panel.model}</span><span className="spanel-value mono">{s.model ?? t.panel.notReported}</span></div>
          <div className="spanel-seg" role="group" aria-label={t.panel.model} onKeyDown={onModelKeys}>
            {PANEL_MODELS.map((m) => (
              <button key={m} type="button" data-model={m} className={`spanel-model ${m === current ? 'is-on' : ''}`} aria-pressed={m === current}
                tabIndex={m === focusModel ? 0 : -1} aria-disabled={why !== null || undefined} data-tip={why ?? t.panel.modelTip(m)}
                onFocus={() => setFocusModel(m)} onClick={() => { if (why === null) switchModel(term.id, m); }}>
                {t.panel.models[m]}
              </button>
            ))}
          </div>
        </section>

        <section className="spanel-sec">
          <div className="spanel-label"><span>{t.panel.mode}</span></div>
          <div className="spanel-mode">
            <span className={`spanel-mode-value ${s.permissionMode ? '' : 'is-unknown'}`}>{s.permissionMode ? permissionModeLabel(s.permissionMode) : t.panel.notReported}</span>
            <button type="button" className="spanel-action is-next" aria-disabled={modeWhy !== null || undefined} data-tip={modeWhy ?? t.panel.nextModeTip}
              onClick={() => { if (modeWhy === null) nextMode(term.id); }}>
              {t.panel.nextMode}<kbd className="kbd">{kbd('⇧Tab')}</kbd>
            </button>
          </div>
          <p className="spanel-hint">{t.panel.modeHint}</p>
        </section>

        <section className="spanel-sec">
          <div className="spanel-label"><span>{t.panel.actions}</span></div>
          {asking
            ? (
              // Background work would stop. The safe answer (when done) takes the focus.
              <div className="spanel-confirm is-restart" role="alertdialog" aria-label={t.restart.askTitle}>
                <strong>{t.restart.askTitle}</strong>
                <p>{t.restart.askStops((term.work && workSummary(term.work)) || t.restart.backgroundWork)}</p>
                <div className="spanel-confirm-row">
                  <button type="button" className="spanel-btn spanel-cancel" onClick={() => useApp.getState().answerRestart('cancel')}>{t.panel.cancel}</button>
                  <button type="button" className="spanel-btn is-later" autoFocus onClick={() => useApp.getState().answerRestart('later')}>{t.restart.whenDone}</button>
                  <button type="button" className="spanel-btn is-danger" onClick={() => useApp.getState().answerRestart('now')}>{t.restart.askNow}</button>
                </div>
              </div>
            )
            : confirmClear
            ? (
              <div className="spanel-confirm" role="alertdialog" aria-label={t.panel.clearConfirm}>
                <strong>{t.panel.clearConfirm}</strong>
                <p>{t.panel.clearBody}</p>
                <div className="spanel-confirm-row">
                  <button type="button" className="spanel-btn spanel-cancel" onClick={() => setConfirmClear(false)}>{t.panel.cancel}</button>
                  <button type="button" className="spanel-btn is-danger" aria-disabled={why !== null || undefined} data-tip={why ?? undefined}
                    onClick={() => { if (why === null) clearSession(term.id); }}>{t.panel.clearGo}</button>
                </div>
              </div>
            )
            : (
              <div className="spanel-actions">
                <ActionButton icon="compact" label={t.panel.compact} tip={t.panel.compactTip} why={why} onClick={() => compactSession(term.id)} />
                <ActionButton icon="eraser" label={t.panel.clear} tip={t.panel.clearTip} why={why} className="is-clear" onClick={() => setConfirmClear(true)} />
                <ActionButton icon="restart" label={restart.label} tip={restart.tip} why={restart.running ? t.restart.restarting : null} className={restart.armed ? 'is-armed' : ''} onClick={restart.run} />
                <ActionButton icon="phone" label={t.panel.phone} tip={t.continueOnPhoneTip} why={phoneWhy} onClick={() => { close(false); continueOnPhone(term.id); }} />
                <ActionButton icon="sparkle" label={t.panel.rename} tip={t.rename} why={null} onClick={() => { close(false); onRename(); }} />
                <ActionButton icon="copy" label={t.panel.copyId} tip={t.panel.copyIdTip} why={null}
                  onClick={() => { void copyText(s.sessionId).then((ok) => { if (ok) useApp.getState().showToast(t.panel.copied, undefined, 'info'); }); close(true); }} />
              </div>
            )}
        </section>

        <section className="spanel-sec spanel-config" aria-busy={config === 'loading'}>
          <div className="spanel-label"><span>{t.panel.configured}</span></div>
          {config === 'loading' && <p className="spanel-none">{t.panel.loading}</p>}
          {groups && (
            <>
              <ConfigGroup label={t.panel.groups.mcpServers} items={groups.mcpServers} added={added} />
              <ConfigGroup label={t.panel.groups.skills} items={groups.skills} />
              <ConfigGroup label={t.panel.groups.plugins} items={groups.plugins} />
            </>
          )}
          {groups && !groups.project && <p className="spanel-note"><Icon name="info" size={12} stroke={2} />{t.panel.projectUnavailable}</p>}
          {unreadable && <p className="spanel-error" data-tip={t.panel.unreadableTip}><Icon name="info" size={12} stroke={2} />{t.panel.unreadable}</p>}
          <p className="spanel-hint">{t.panel.configuredNote}</p>
        </section>
      </div>
    </div>,
    document.body
  );
}
