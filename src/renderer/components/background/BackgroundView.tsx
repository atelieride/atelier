// The Background tab: what one Claude session runs in the background, with a session
// picker in its header, the item list (list, pills or menu by the tab's width) and the selected item's detail, live.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { shownState } from '../../selectors';
import { orderSessions } from '../../background-output';
import { backgroundSections, backgroundSummary, exitedIds, exitsKey, parseExits } from '../../background-view';
import { t } from '../../i18n/en';
import { openBelow } from '../../menus';
import { useApp } from '../../store';
import { Avatar } from '../Avatar';
import { Icon } from '../Icon';
import { AgentDetail } from './AgentDetail';
import { ItemPicker } from './ItemPicker';
import { OutputDetail } from './OutputDetail';
import { ScheduledDetail } from './ScheduledDetail';
import { isMod } from '@shared/keys';

export function BackgroundView({ visible, focused = visible, place }: { visible: boolean; focused?: boolean; place?: CSSProperties }) {
  const tab = useApp((s) => s.backgroundTab);
  if (!tab) return null;
  return <Background visible={visible} focused={focused} place={place} />;
}

function Background({ visible, focused, place }: { visible: boolean; focused: boolean; place?: CSSProperties }) {
  const tab = useApp((s) => s.backgroundTab)!;
  const terminals = useApp((s) => s.terminals);
  // Items whose followed output carries an exit code: no longer counted as running in the header (a stable string: a
  // feed that changes nothing here does not re-render the tab).
  const exitedKey = useApp((s) => exitsKey(exitedIds(s.bgFeeds, tab.terminalId)));
  const term = terminals.find((x) => x.id === tab.terminalId);
  const root = useRef<HTMLElement>(null);
  const [now, setNow] = useState(() => Date.now());
  // Elapsed times and countdowns tick every second while the tab is shown, from the right time before the first paint.
  useLayoutEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible]);
  // The focused pane takes the keyboard: the selected row (the list is shown) or the tab itself; never away from
  // something inside it the user just clicked.
  useEffect(() => {
    const el = root.current;
    if (!visible || !focused || !el || el.contains(document.activeElement)) return;
    const row = el.querySelector<HTMLElement>('.bgv-list [tabindex="0"]');
    (row && row.offsetParent !== null ? row : el).focus({ preventScroll: true });
  }, [visible, focused, tab.nonce]);

  if (!term) return null;
  const exited = parseExits(exitedKey);
  const sections = backgroundSections(term, now, exited);
  const rows = sections.flatMap((s) => s.rows);
  const selected = tab.itemId && rows.some((r) => r.id === tab.itemId) ? tab.itemId : rows[0]?.id ?? null;
  const sessions = orderSessions(terminals);
  const ended = !term.session;
  const summary = backgroundSummary(term, exited);

  const pickSession = (el: HTMLElement) => openBelow(el, sessions.map((x) => ({
    id: x.id, label: x.title, icon: x.id === term.id ? 'check' as const : undefined, hint: backgroundSummary(x, exitedIds(useApp.getState().bgFeeds, x.id)) ?? undefined,
    run: () => useApp.getState().setBackgroundScope(x.id)
  })));
  const onKey = (e: KeyboardEvent) => {
    if (isMod(e) && e.key === 'f') {
      const input = root.current?.querySelector<HTMLInputElement>('.bgv-filter input');
      // Below 360 px the field sits behind its icon button: pressing it reveals and focuses the field.
      const button = root.current?.querySelector<HTMLButtonElement>('.bgv-filter-btn');
      if (input && input.offsetParent !== null) { e.preventDefault(); input.focus(); input.select(); }
      else if (button && button.offsetParent !== null) { e.preventDefault(); button.click(); }
    }
  };

  const entry = selected ? term.work?.entries.find((e) => e.id === selected) : undefined;
  const recent = selected && !entry ? term.recent?.find((r) => r.id === selected) : undefined;
  const kind = entry?.kind ?? recent?.kind;
  let detail = null;
  if (selected?.startsWith('cron:')) detail = <ScheduledDetail term={term} id={selected} now={now} />;
  else if (selected && kind === 'agent') detail = <AgentDetail key={selected} term={term} id={selected} entry={entry} recent={recent} now={now} visible={visible} />;
  else if (selected && kind) detail = <OutputDetail key={selected} term={term} id={selected} entry={entry} recent={recent} now={now} visible={visible} />;

  return (
    <section ref={root} tabIndex={-1} className="bgv" style={{ display: visible ? 'flex' : 'none', ...place }} aria-label={t.bg.tab(term.title)} onKeyDown={onKey}>
      <header className="bgv-top">
        <span className="bgv-title"><Icon name="bolt" size={14} stroke={1.8} /><span>{t.bg.title}</span></span>
        {/* No Claude session to pick: shown, but inert (aria-disabled keeps its tooltip, which `disabled` would mute). */}
        <button type="button" className="bgv-session" aria-haspopup="menu" aria-disabled={sessions.length === 0 || undefined}
          aria-label={`${t.bg.chooseSession}: ${term.title}`} data-tip={sessions.length === 0 ? t.bg.noSession : t.bg.chooseSession}
          onClick={(e) => { if (sessions.length > 0) pickSession(e.currentTarget); }}>
          <Avatar title={term.title} color={term.color} state={shownState(term)} size={16} />
          <span className="bgv-session-name">{term.title}</span>
          <Icon name="chevronDown" size={12} stroke={2} />
        </button>
        {summary && <span className="bgv-summary">{summary}</span>}
      </header>
      {ended && <div className="bgv-banner" role="status"><Icon name="info" size={14} stroke={1.8} /><span>{t.bg.sessionEnded}</span></div>}
      {rows.length > 0 ? (
        <div className="bgv-main">
          <ItemPicker term={term} sections={sections} selected={selected} />
          <div className="bgv-detail">{detail}</div>
        </div>
      ) : sessions.length === 0 && ended ? (
        <div className="bgv-empty"><p className="bgv-empty-hint">{t.bg.noSession}</p></div>
      ) : (
        <div className="bgv-empty">
          <span className="bgv-empty-icon"><Icon name="bolt" size={22} stroke={1.6} /></span>
          <p className="bgv-empty-title">{t.bg.empty}</p>
          <p className="bgv-empty-hint">{t.bg.emptyHint}</p>
        </div>
      )}
    </section>
  );
}
