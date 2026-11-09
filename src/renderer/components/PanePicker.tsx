import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { TerminalInfo } from '@shared/protocol';
import { waitKind } from '@shared/session-view';
import { shownState, shownStateLabel } from '../selectors';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { paneOf, pickable, pickableKeys } from '../split';
import { newTerminalIn } from '../launch';
import { isStarting } from '../starting';
import { usePointerGate } from '../pointer-hover';
import { Avatar } from './Avatar';
import { Icon, type IconName } from './Icon';
import { kbd } from '../kbd';
import { useTabTitle } from './PaneHeader';
import type { TabKey } from '../tabs-model';

/**
 * The state chip's words; paused at a usage limit, "Usage limit" on a muted chip.
 */
function stateText(x: TerminalInfo): string {
  const wait = waitKind(x.session);
  return wait === 'permission' ? t.wait.permission : wait === 'question' ? t.wait.question : wait === 'waiting' ? t.waitingForYou : shownStateLabel(x)!;
}

/** An empty pane: Sessions' picker, or another space's. */
export function PanePicker(p: { index: number; focused: boolean; place: CSSProperties }) {
  const sessions = useApp((s) => s.space === 'sessions');
  return sessions ? <SessionsPicker {...p} /> : <SpacePicker {...p} />;
}

const GLYPH: Record<string, IconName> = { 'dk:': 'whale', 'rd:': 'redis', 'au:': 'automation', 'db:': 'databases' };

function PickRow({ k, active, onPick, onHover, id }: { k: TabKey; active: boolean; onPick: () => void; onHover: (e: React.MouseEvent) => void; id: string }) {
  const title = useTabTitle(k);
  return (
    <button id={id} type="button" role="option" tabIndex={-1} aria-selected={active} className={`pp-item ${active ? 'is-active' : ''}`} onMouseMove={onHover} onClick={onPick}>
      <span className="ph-icon"><Icon name={GLYPH[k.slice(0, 3)] ?? 'split'} size={13} stroke={1.8} /></span>
      <span className="pp-title">{title}</span>
    </button>
  );
}

/**
 * An empty pane outside Sessions: "Show here" with the space's tabs not in front of any pane
 * (arrows + Enter or click; picked, a tab leaves its pane for this one), a word on the sidebar (a sidebar pick fills the
 * focused empty pane too) and Unsplit. Never a session or a terminal: they are Sessions'.
 */
function SpacePicker({ index, focused, place }: { index: number; focused: boolean; place: CSSProperties }) {
  const order = useApp((s) => s.tabOrder);
  const split = useApp((s) => s.split);
  const list = useMemo(() => pickableKeys(order, split), [order, split]);
  const [active, setActive] = useState(0);
  const moved = usePointerGate();
  const listRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cur = Math.min(active, Math.max(0, list.length - 1));
  useEffect(() => { if (focused) (listRef.current ?? cardRef.current)?.focus({ preventScroll: true }); }, [focused, list.length > 0]);
  const pick = (k: TabKey) => { const st = useApp.getState(); if (st.split.focus !== index) st.focusPane(index); st.activate(k); };
  const onKey = (e: KeyboardEvent) => {
    if (!list.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActive((cur + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); setActive(e.key === 'Home' ? 0 : list.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(list[cur]!); }
  };
  return (
    <div className={`pane-picker ${focused ? 'is-focused' : ''}`} style={place}>
      <div className="pp-card pop" ref={cardRef} tabIndex={-1} aria-label={t.split.showHere}
        onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); useApp.getState().closePane(index); } }}>
        <div className="pp-head">
          <span className="section-label">{t.split.showHere}</span>
          {list.length > 0 && <span className="pp-keys mono" aria-hidden="true">↑↓ ↵</span>}
        </div>
        {list.length > 0 && (
          <div className="pp-list" role="listbox" tabIndex={0} ref={listRef} aria-label={t.split.showHere}
            aria-activedescendant={`pp-${index}-${cur}`} onKeyDown={onKey}>
            {list.map((k, i) => <PickRow key={k} id={`pp-${index}-${i}`} k={k} active={i === cur} onPick={() => pick(k)} onHover={(e) => { if (moved(e)) setActive(i); }} />)}
          </div>
        )}
        <p className="pp-none">{list.length ? t.spaces.pickerHint : t.spaces.pickerEmpty}</p>
        <div className="pp-actions">
          <button type="button" className="pp-close" data-pane-keep onClick={() => useApp.getState().closePane(index)}>{t.split.close}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * An empty pane of the split view (Split Right's): "Show here" with the sessions and
 * terminals not in front of any pane (pinned first, then the newest; arrows + Enter or click) — one sitting in another
 * pane's strip says "moves here" — New Session / New Terminal (they open here: this pane is focused) and Unsplit.
 * Selecting anything in the sidebar while it is focused fills it too.
 */
function SessionsPicker({ index, focused, place }: { index: number; focused: boolean; place: CSSProperties }) {
  const terminals = useApp((s) => s.terminals);
  const pins = useApp((s) => s.pins);
  const starting = useApp((s) => s.starting);
  const split = useApp((s) => s.split);
  const list = useMemo(() => pickable(terminals, pins, split), [terminals, pins, split]);
  const [active, setActive] = useState(0);
  const moved = usePointerGate();
  const listRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cur = Math.min(active, Math.max(0, list.length - 1));
  // The focused empty pane takes the keyboard (arrows and Enter pick).
  useEffect(() => { if (focused) (listRef.current ?? cardRef.current)?.focus({ preventScroll: true }); }, [focused, list.length > 0]);

  const here = () => { const st = useApp.getState(); if (st.split.focus !== index) st.focusPane(index); };
  const pick = (id: string) => { here(); useApp.getState().select(id); };
  const onKey = (e: KeyboardEvent) => {
    if (!list.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActive((cur + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); setActive(e.key === 'Home' ? 0 : list.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(list[cur]!.id); }
  };

  return (
    <div className={`pane-picker ${focused ? 'is-focused' : ''}`} style={place}>
      {/* Esc: the empty pane closes (nothing in it to lose) and the focus goes back to its left neighbor — the pane Split Right came from. */}
      <div className="pp-card pop" ref={cardRef} tabIndex={-1} aria-label={t.split.showHere}
        onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); useApp.getState().closePane(index); } }}>
        <div className="pp-head">
          <span className="section-label">{t.split.showHere}</span>
          {list.length > 0 && <span className="pp-keys mono" aria-hidden="true">↑↓ ↵</span>}
        </div>
        {list.length > 0 ? (
          <div className="pp-list" role="listbox" tabIndex={0} ref={listRef} aria-label={t.split.showHere}
            aria-activedescendant={`pp-${index}-${list[cur]!.id}`} onKeyDown={onKey}>
            {list.map((x, i) => (
              <button key={x.id} id={`pp-${index}-${x.id}`} type="button" role="option" tabIndex={-1} aria-selected={i === cur}
                className={`pp-item ${i === cur ? 'is-active' : ''}`} onMouseMove={(e) => { if (moved(e)) setActive(i); }} onClick={() => pick(x.id)}>
                {x.session || isStarting(x, starting)
                  ? <Avatar title={x.title} color={x.color} state={shownState(x)} size={18} />
                  : <span className="ph-icon"><Icon name="terminal" size={11} stroke={1.9} /></span>}
                <span className="pp-title">{x.title}</span>
                {pins.includes(x.id) && <span className="pp-pin" aria-label={t.cmd.pinTerminal}><Icon name="pin" size={11} stroke={1.8} /></span>}
                <span className="grow" />
                {/* In another pane's strip: picked, it leaves that pane for this one. It
                    takes a plain terminal's process hint's place (the name keeps the room). */}
                {paneOf(split, `t:${x.id}`) >= 0 && <span className="pp-moves">{t.split.movesHere}</span>}
                {x.session
                  ? <span className={`state-chip st-${shownState(x)}`}><i />{stateText(x)}</span>
                  : isStarting(x, starting)
                    ? <span className="state-chip st-starting"><i />{t.starting}</span>
                    : paneOf(split, `t:${x.id}`) < 0 && <span className="pp-hint mono">{x.foreground.split('/').at(-1)}</span>}
              </button>
            ))}
          </div>
        ) : <p className="pp-none">{t.split.nothing}</p>}
        <div className="pp-actions">
          <button type="button" className="btn-primary sm" aria-label={t.split.newSession} onClick={() => { here(); useApp.getState().setNewSessionOpen(true); }}>
            <Icon name="sparkle" size={12} /><span className="pp-act-label">{t.split.newSession}</span><span className="kbd-in">{kbd('⌘N')}</span>
          </button>
          <button type="button" className="btn-ghost sm" aria-label={t.split.newTerminal} onClick={() => { here(); void newTerminalIn(); }}>
            <Icon name="terminal" size={12} /><span className="pp-act-label">{t.split.newTerminal}</span><span className="kbd-in">{kbd('⌘T')}</span>
          </button>
          <button type="button" className="pp-close" data-pane-keep onClick={() => useApp.getState().closePane(index)}>{t.split.close}</button>
        </div>
      </div>
    </div>
  );
}
